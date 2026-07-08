import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CODEGRAPH_PATH, buildCodeGraph, loadOrBuildCodeGraph, queryCodeGraph, readCodeGraphIfExists } from "./codegraph.js";
import { CONFIG_PATH, loadConfig, writeDefaultConfigIfMissing } from "./config.js";
import { buildBundle, buildManagedSection, MANAGED_FILES } from "./generate.js";
import {
  fileExists,
  readJsonIfExists,
  relativePath,
  writeManagedFile,
  writeJsonIfChanged
} from "./fs-utils.js";
import { lintRepo } from "./lint.js";
import { exportObsidianGraph } from "./obsidian-export.js";
import { lintPlan } from "./plan-lint.js";
import { hasErrors, pushFinding } from "./rules.js";
import { scanRepo } from "./scan.js";

const execFileAsync = promisify(execFile);
const PLAN_HISTORY_DIR = ".codex-prep/plans";
const LATEST_PLAN_PATH = `${PLAN_HISTORY_DIR}/latest-plan.json`;
const ACTIVE_PLAN_PATH = `${PLAN_HISTORY_DIR}/active-plan.json`;
const PLAN_STATUSES = new Set(["draft", "approved", "implemented", "superseded", "rejected"]);
const TERMINAL_PLAN_STATUSES = new Set(["implemented", "superseded", "rejected"]);
const PLAN_RISK_LEVELS = new Set(["low", "medium", "high"]);
const PLAN_TARGET_AGENTS = new Set(["codex", "cursor", "claude-code", "generic"]);
const PLAN_BUILD_STATUSES = new Set(["not_started", "approved", "in_progress"]);
const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_STOP_RULES = [
  "Stop when the requested scope is implemented, listed validation passes, and remaining improvements are captured as follow-up work."
];
const DEFAULT_FORBIDDEN_ACTIONS = [
  "Do not edit files until the user explicitly approves implementation.",
  "Do not commit unless the user explicitly says to commit.",
  "Do not push unless the user explicitly says to push.",
  "Do not run destructive commands, migrations, deployments, or dependency installs without explicit approval.",
  "Do not copy secrets into generated plans or docs."
];
const DEFAULT_APPROVAL_BOUNDARIES = [
  "Planning approval does not authorize file edits.",
  "File edit approval does not authorize commit or push.",
  "Dependency installs, migrations, deployments, and destructive commands require separate explicit approval."
];

export async function scanCommand({ root, json }) {
  const manifest = await scanRepo(root);
  if (json) {
    printJson(manifest);
    return;
  }
  console.log(formatScan(manifest));
}

export async function planCommand({
  root,
  json,
  save = true,
  now,
  intent,
  note,
  scope = [],
  files = [],
  validation = [],
  questions = [],
  goal,
  successCriteria = [],
  nonGoals = [],
  stopRules = [],
  forbiddenActions = [],
  approvalBoundaries = [],
  riskLevel,
  targetAgent
}) {
  const manifest = await scanRepo(root);
  const bundle = buildBundle(manifest);
  const proposal = buildPlanProposal(manifest, bundle, {
    intent,
    scope,
    files,
    validation,
    questions,
    goal,
    successCriteria,
    nonGoals,
    stopRules,
    forbiddenActions,
    approvalBoundaries,
    riskLevel,
    targetAgent
  });
  const savedPlan = save ? await saveNewPlan(root, proposal, now ?? new Date(), note) : undefined;

  if (json) {
    printJson(savedPlan ? { ...proposal, savedPlan } : proposal);
    return;
  }

  console.log(formatPlan(proposal, savedPlan));
}

export async function planUpdateCommand({
  root,
  json,
  intent,
  note,
  status,
  scope = [],
  files = [],
  validation = [],
  questions = [],
  goal,
  successCriteria = [],
  nonGoals = [],
  stopRules = [],
  forbiddenActions = [],
  approvalBoundaries = [],
  riskLevel,
  targetAgent,
  now
}) {
  const current = await readActiveOrLatestPlan(root);
  if (!current) {
    throw new Error("no active plan found. Run codex-prep plan first.");
  }

  const updated = updatePlanDocument(current.plan, {
    intent,
    note,
    status,
    scope,
    files,
    validation,
    questions,
    goal,
    successCriteria,
    nonGoals,
    stopRules,
    forbiddenActions,
    approvalBoundaries,
    riskLevel,
    targetAgent,
    now: now ?? new Date(),
    event: "updated"
  });
  const writes = await writePlanState(root, updated, { includeHistory: true });
  const result = { plan: updated, writes };

  if (json) {
    printJson(result);
    return;
  }

  console.log(formatPlanMutation("codex-prep plan-update", result));
}

export async function planStatusCommand({ root, json }) {
  const current = await readActiveOrLatestPlan(root);
  const result = current ? { exists: true, source: current.path, plan: current.plan } : { exists: false };

  if (json) {
    printJson(result);
    return;
  }

  console.log(formatPlanStatus(result));
}

export async function planLintCommand({ root, json }) {
  const config = await loadConfig(root);
  const current = await readActiveOrLatestPlan(root);
  const manifest = await scanRepo(root);
  const result = lintPlan({ plan: current?.plan, source: current?.path, manifest, config });

  if (json) {
    printJson(result);
  } else {
    console.log(formatPlanLint(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }

  return result;
}

export async function planReviewCommand({ root, json }) {
  const current = await readActiveOrLatestPlan(root);
  const lintResult = await runPlanLint(root, current);
  const result = buildPlanReviewResult(lintResult);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatPlanReview(result));
  return result;
}

export async function planApproveCommand({ root, json, note, now }) {
  if (!note) {
    throw new Error("plan-approve requires --note <text>");
  }

  const current = await readActiveOrLatestPlan(root);
  if (!current) {
    throw new Error("no active plan found. Run codex-prep plan first.");
  }

  const lintResult = await runPlanLint(root, current);
  if (!lintResult.ok) {
    throw new Error("plan-approve requires a plan-lint pass. Run codex-prep plan-review and fix blocking findings first.");
  }

  const approvedAt = (now ?? new Date()).toISOString();
  const approved = updatePlanDocument(current.plan, {
    status: "approved",
    note,
    now: now ?? new Date(approvedAt),
    event: "approved",
    build: {
      ...current.plan.build,
      status: "approved",
      approvedAt,
      approvalNote: note
    }
  });
  const writes = await writePlanState(root, approved, { includeHistory: true });
  const result = { plan: approved, writes };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatPlanMutation("codex-prep plan-approve", result));
  return result;
}

export async function planStartCommand({ root, json, branch, base = DEFAULT_BASE_BRANCH, syncBase = false, now }) {
  if (!branch) {
    throw new Error("plan-start requires --branch <name>");
  }

  const current = await readActiveOrLatestPlan(root);
  if (!current) {
    throw new Error("no active plan found. Run codex-prep plan first.");
  }
  if (current.plan.build.status !== "approved") {
    throw new Error("plan-start requires an approved plan. Run codex-prep plan-approve first.");
  }

  const lintResult = await runPlanLint(root, current);
  if (!lintResult.ok) {
    throw new Error("plan-start requires a plan-lint pass. Run codex-prep plan-review and fix blocking findings first.");
  }

  await assertCleanWorktree(root);

  if (syncBase) {
    await runGit(root, ["fetch", "origin", base]);
    await runGit(root, ["switch", base]);
    await runGit(root, ["pull", "--ff-only", "origin", base]);
  }

  const baseCommit = (await runGit(root, ["rev-parse", base])).stdout.trim();
  await runGit(root, ["switch", "-c", branch, base]);

  const startedAt = (now ?? new Date()).toISOString();
  const started = updatePlanDocument(current.plan, {
    note: `Started implementation branch ${branch} from ${base}@${baseCommit.slice(0, 12)}.`,
    now: now ?? new Date(startedAt),
    event: "started",
    build: {
      ...current.plan.build,
      status: "in_progress",
      branchName: branch,
      baseBranch: base,
      baseCommit,
      startedAt
    }
  });
  const writes = await writePlanState(root, started, { includeHistory: true });
  const result = {
    plan: started,
    branch: {
      name: branch,
      baseBranch: base,
      baseCommit,
      syncBase
    },
    writes
  };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatPlanStart(result));
  return result;
}

export async function planCloseCommand({ root, json, status, note, now }) {
  if (!status) {
    throw new Error("plan-close requires --status implemented, superseded, or rejected");
  }
  if (!TERMINAL_PLAN_STATUSES.has(status)) {
    throw new Error("plan-close status must be implemented, superseded, or rejected");
  }

  const current = await readActiveOrLatestPlan(root);
  if (!current) {
    throw new Error("no active plan found. Run codex-prep plan first.");
  }

  const closed = updatePlanDocument(current.plan, {
    status,
    note,
    now: now ?? new Date(),
    event: "closed"
  });
  const writes = await writePlanState(root, closed, { includeHistory: true });
  const result = { plan: closed, writes };

  if (json) {
    printJson(result);
    return;
  }

  console.log(formatPlanMutation("codex-prep plan-close", result));
}

export async function graphCommand({ root, json }) {
  const manifest = await scanRepo(root);
  const graph = await buildCodeGraph(root, { manifest });

  if (json) {
    printJson(graph);
    return graph;
  }

  console.log(formatGraph(graph, { source: "live" }));
  return graph;
}

export async function refreshGraphCommand({ root, json }) {
  const manifest = await scanRepo(root);
  const previousGraph = await readPreviousCodeGraph(root);
  const graph = await buildCodeGraph(root, { manifest });
  const graphResult = await writeJsonIfChanged(path.join(root, CODEGRAPH_PATH), finalizeCodeGraph(graph, previousGraph));
  const result = {
    repo: graph.repo,
    graph: graph.summary,
    writes: [{ path: CODEGRAPH_PATH, changed: graphResult.changed, mode: "managed-json" }]
  };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatGraphRefresh(result));
  return result;
}

export async function graphQueryCommand({ root, json, file, symbol }) {
  const { graph, source } = await loadOrBuildCodeGraph(root);
  const result = { source, ...queryCodeGraph(graph, { file, symbol }) };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatGraphQuery(result));
  return result;
}

export async function graphExportCommand({ root, json, format = "obsidian", includeSymbols = false }) {
  if (format !== "obsidian") {
    throw new Error("graph-export currently supports --format obsidian");
  }

  const { graph, source } = await loadOrBuildCodeGraph(root);
  const manifest = (await readJsonIfExists(path.join(root, '.codex-prep', 'manifest.json'))) ?? await scanRepo(root);
  const activePlan = await readJsonIfExists(path.join(root, ACTIVE_PLAN_PATH));
  const exportResult = await exportObsidianGraph(root, graph, { includeSymbols, manifest, activePlan });
  const result = {
    repo: graph.repo,
    source,
    ...exportResult
  };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatGraphExport(result));
  return result;
}

function buildPlanProposal(manifest, bundle, metadata = {}) {
  return {
    repo: manifest.repo,
    summary: manifest.summary,
    goal: metadata.goal ?? "",
    userIntent: metadata.intent ?? "",
    proposedScope: uniqueStrings(metadata.scope ?? []),
    filesLikelyTouched: uniqueStrings(metadata.files ?? []),
    validationPlan: uniqueStrings([
      ...manifest.discovery.commands.map((command) => command.command),
      ...(metadata.validation ?? [])
    ]),
    successCriteria: uniqueStrings(metadata.successCriteria ?? []),
    nonGoals: uniqueStrings(metadata.nonGoals ?? []),
    stopRules: uniqueStrings([
      ...DEFAULT_STOP_RULES,
      ...(metadata.stopRules ?? [])
    ]),
    forbiddenActions: uniqueStrings([
      ...DEFAULT_FORBIDDEN_ACTIONS,
      ...(metadata.forbiddenActions ?? [])
    ]),
    approvalBoundaries: uniqueStrings([
      ...DEFAULT_APPROVAL_BOUNDARIES,
      ...(metadata.approvalBoundaries ?? [])
    ]),
    riskLevel: validatePlanRiskLevel(metadata.riskLevel ?? "medium"),
    targetAgent: validatePlanTargetAgent(metadata.targetAgent ?? "codex"),
    build: defaultPlanBuild(),
    openQuestions: uniqueStrings(metadata.questions ?? []),
    proposedWrites: bundle.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      reason: file.reason
    })).concat([
      {
        path: CONFIG_PATH,
        mode: "user-config",
        reason: "Repo-specific codex-prep rule and lint settings; created only when missing."
      },
      {
        path: CODEGRAPH_PATH,
        mode: "managed-json",
        reason: "Structured local code graph used by graph-query, check, eval, and repo orientation."
      },
      {
        path: ".codex-prep/manifest.json",
        mode: "managed-json",
        reason: "Structured repo intelligence manifest used by check, eval, and refresh-map."
      }
    ]),
    assumptions: manifest.assumptions,
    evidence: manifest.evidence
  };
}

async function saveNewPlan(root, proposal, now, note) {
  const savedAt = now.toISOString();
  const plan = normalizePlan({
    schemaVersion: 3,
    kind: "codex-prep-plan",
    status: "draft",
    savedAt,
    updatedAt: savedAt,
    ...proposal,
    repo: {
      ...proposal.repo,
      root: "."
    },
    decisionLog: [
      {
        at: savedAt,
        event: "created",
        note: note || "Plan generated from repo scan."
      }
    ]
  });
  const writes = await writePlanState(root, plan, { includeHistory: true });

  return {
    savedAt,
    files: writes
  };
}

async function readActiveOrLatestPlan(root) {
  const active = await readJsonIfExists(path.join(root, ACTIVE_PLAN_PATH));
  if (active) {
    return { path: ACTIVE_PLAN_PATH, plan: normalizePlan(active) };
  }

  const latest = await readJsonIfExists(path.join(root, LATEST_PLAN_PATH));
  if (latest) {
    return { path: LATEST_PLAN_PATH, plan: normalizePlan(latest) };
  }

  return undefined;
}

function updatePlanDocument(plan, change) {
  const updatedAt = change.now.toISOString();
  const nextStatus = change.status ?? plan.status ?? "draft";
  validatePlanStatus(nextStatus);

  const changes = [];
  const next = normalizePlan({
    ...plan,
    status: nextStatus,
    updatedAt,
    goal: change.goal ?? plan.goal ?? "",
    userIntent: change.intent ?? plan.userIntent ?? "",
    proposedScope: appendUnique(plan.proposedScope, change.scope),
    filesLikelyTouched: appendUnique(plan.filesLikelyTouched, change.files),
    validationPlan: appendUnique(plan.validationPlan, change.validation),
    successCriteria: appendUnique(plan.successCriteria, change.successCriteria),
    nonGoals: appendUnique(plan.nonGoals, change.nonGoals),
    stopRules: appendUnique(plan.stopRules, change.stopRules),
    forbiddenActions: appendUnique(plan.forbiddenActions, change.forbiddenActions),
    approvalBoundaries: appendUnique(plan.approvalBoundaries, change.approvalBoundaries),
    riskLevel: change.riskLevel === undefined ? plan.riskLevel : validatePlanRiskLevel(change.riskLevel),
    targetAgent: change.targetAgent === undefined ? plan.targetAgent : validatePlanTargetAgent(change.targetAgent),
    build: change.build ? normalizePlanBuild({ ...plan.build, ...change.build }) : normalizePlanBuild(plan.build),
    openQuestions: appendUnique(plan.openQuestions, change.questions)
  });

  if (change.goal !== undefined) changes.push("goal");
  if (change.intent !== undefined) changes.push("intent");
  if (change.status !== undefined) changes.push(`status:${change.status}`);
  if ((change.scope ?? []).length > 0) changes.push("scope");
  if ((change.files ?? []).length > 0) changes.push("files");
  if ((change.validation ?? []).length > 0) changes.push("validation");
  if ((change.successCriteria ?? []).length > 0) changes.push("success");
  if ((change.nonGoals ?? []).length > 0) changes.push("non-goals");
  if ((change.stopRules ?? []).length > 0) changes.push("stop-rules");
  if ((change.forbiddenActions ?? []).length > 0) changes.push("forbidden-actions");
  if ((change.approvalBoundaries ?? []).length > 0) changes.push("approval-boundaries");
  if (change.riskLevel !== undefined) changes.push(`risk:${next.riskLevel}`);
  if (change.targetAgent !== undefined) changes.push(`target-agent:${next.targetAgent}`);
  if (change.build?.status !== undefined) changes.push(`build:${next.build.status}`);
  if ((change.questions ?? []).length > 0) changes.push("questions");

  next.decisionLog = [
    ...next.decisionLog,
    {
      at: updatedAt,
      event: change.event,
      note: change.note || defaultDecisionNote(change.event, changes)
    }
  ];

  return next;
}

async function writePlanState(root, plan, { includeHistory }) {
  const writes = [];
  if (includeHistory) {
    const historyPath = `${PLAN_HISTORY_DIR}/${safeTimestamp(plan.updatedAt)}-plan.json`;
    const historyResult = await writeJsonIfChanged(path.join(root, historyPath), plan);
    writes.push({ path: historyPath, changed: historyResult.changed });
  }

  const latestResult = await writeJsonIfChanged(path.join(root, LATEST_PLAN_PATH), plan);
  const activeResult = await writeJsonIfChanged(path.join(root, ACTIVE_PLAN_PATH), plan);
  writes.push({ path: LATEST_PLAN_PATH, changed: latestResult.changed });
  writes.push({ path: ACTIVE_PLAN_PATH, changed: activeResult.changed });

  return writes;
}

function normalizePlan(plan) {
  const status = plan.status ?? "draft";
  validatePlanStatus(status);

  return {
    schemaVersion: plan.schemaVersion ?? 1,
    kind: plan.kind ?? "codex-prep-plan",
    status,
    savedAt: plan.savedAt,
    updatedAt: plan.updatedAt ?? plan.savedAt,
    repo: {
      ...(plan.repo ?? {}),
      root: "."
    },
    summary: plan.summary ?? "",
    goal: plan.goal ?? "",
    userIntent: plan.userIntent ?? "",
    proposedScope: uniqueStrings(plan.proposedScope ?? []),
    filesLikelyTouched: uniqueStrings(plan.filesLikelyTouched ?? []),
    validationPlan: uniqueStrings(plan.validationPlan ?? []),
    successCriteria: uniqueStrings(plan.successCriteria ?? []),
    nonGoals: uniqueStrings(plan.nonGoals ?? []),
    stopRules: uniqueStrings(plan.stopRules ?? []),
    forbiddenActions: uniqueStrings(plan.forbiddenActions ?? []),
    approvalBoundaries: uniqueStrings(plan.approvalBoundaries ?? []),
    riskLevel: normalizePlanRiskLevel(plan.riskLevel),
    targetAgent: normalizePlanTargetAgent(plan.targetAgent),
    build: normalizePlanBuild(plan.build),
    openQuestions: uniqueStrings(plan.openQuestions ?? []),
    decisionLog: Array.isArray(plan.decisionLog) ? plan.decisionLog : [],
    proposedWrites: Array.isArray(plan.proposedWrites) ? plan.proposedWrites : [],
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions : [],
    evidence: Array.isArray(plan.evidence) ? plan.evidence : []
  };
}

function validatePlanStatus(status) {
  if (!PLAN_STATUSES.has(status)) {
    throw new Error(`invalid plan status "${status}". Expected one of: ${[...PLAN_STATUSES].join(", ")}`);
  }
}

function validatePlanRiskLevel(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PLAN_RISK_LEVELS.has(normalized)) {
    throw new Error(`invalid plan risk "${value}". Expected one of: ${[...PLAN_RISK_LEVELS].join(", ")}`);
  }
  return normalized;
}

function validatePlanTargetAgent(value) {
  const normalized = normalizePlanTargetAgent(value);
  if (normalized && !PLAN_TARGET_AGENTS.has(normalized)) {
    throw new Error(`invalid target agent "${value}". Expected one of: ${[...PLAN_TARGET_AGENTS].join(", ")}`);
  }
  return normalized;
}

function normalizePlanRiskLevel(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "medium";
  }
  const normalized = value.trim().toLowerCase();
  return PLAN_RISK_LEVELS.has(normalized) ? normalized : "medium";
}

function normalizePlanTargetAgent(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function defaultPlanBuild() {
  return {
    status: "not_started",
    branchName: "",
    baseBranch: "",
    baseCommit: "",
    startedAt: "",
    approvedAt: "",
    approvalNote: ""
  };
}

function normalizePlanBuild(build = {}) {
  const fallback = defaultPlanBuild();
  const status = typeof build?.status === "string" && PLAN_BUILD_STATUSES.has(build.status) ? build.status : fallback.status;
  return {
    status,
    branchName: stringOrEmpty(build?.branchName),
    baseBranch: stringOrEmpty(build?.baseBranch),
    baseCommit: stringOrEmpty(build?.baseCommit),
    startedAt: stringOrEmpty(build?.startedAt),
    approvedAt: stringOrEmpty(build?.approvedAt),
    approvalNote: stringOrEmpty(build?.approvalNote)
  };
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function defaultDecisionNote(event, changes) {
  if (changes.length === 0) {
    return event === "closed" ? "Plan closed." : "Plan updated.";
  }
  return `Plan ${event}: ${changes.join(", ")}.`;
}

function appendUnique(existing = [], additions = []) {
  return uniqueStrings([...(existing ?? []), ...(additions ?? [])]);
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function safeTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

async function runPlanLint(root, current) {
  const config = await loadConfig(root);
  const manifest = await scanRepo(root);
  return lintPlan({ plan: current?.plan, source: current?.path, manifest, config });
}

function buildPlanReviewResult(lintResult) {
  const readyToBuild = Boolean(lintResult.plan) && lintResult.ok;
  const suggestedBranch = lintResult.plan ? suggestPlanBranch(lintResult.plan) : undefined;
  return {
    readyToBuild,
    source: lintResult.source,
    suggestedBranch,
    plan: lintResult.plan,
    findings: lintResult.findings,
    nextActions: buildPlanNextActions({ readyToBuild, suggestedBranch, hasPlan: Boolean(lintResult.plan) })
  };
}

function buildPlanNextActions({ readyToBuild, suggestedBranch, hasPlan }) {
  if (!hasPlan) {
    return [
      action("Create plan", "codex-prep plan", "Create an active saved plan before build approval."),
      action("Keep exploring", "codex-prep scan", "Inspect the repo and decide what the plan should include.")
    ];
  }

  if (!readyToBuild) {
    return [
      action("Continue planning", "codex-prep plan-update --success \"...\" --stop-rule \"...\"", "Add the missing plan details shown in the findings."),
      action("Review again", "codex-prep plan-review", "Run this again after updating the active plan.")
    ];
  }

  return [
    action("Continue planning", "codex-prep plan-update --note \"...\"", "Add more detail before approving build."),
    action("Approve build", "codex-prep plan-approve --note \"Ready to build\"", "Record explicit build approval without editing code."),
    action("Start branch", `codex-prep plan-start --branch ${suggestedBranch}`, "After approval, create the dedicated implementation branch.")
  ];
}

function action(label, command, description) {
  return { label, command, description };
}

function suggestPlanBranch(plan) {
  const source = plan.goal || plan.userIntent || plan.repo?.name || "work";
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `codex/${slug || "work"}`;
}

async function assertCleanWorktree(root) {
  const status = (await runGit(root, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
  const blocking = status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !isPlanStateStatusLine(line));

  if (blocking.length > 0) {
    throw new Error("plan-start requires a clean worktree outside .codex-prep/plans. Commit, stash, or discard current changes first.");
  }
}

function isPlanStateStatusLine(line) {
  const file = line.slice(3).replace(/\\/g, "/");
  return file.startsWith(".codex-prep/plans/");
}

async function runGit(root, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return { stdout, stderr };
  } catch (error) {
    const detail = (error.stderr || error.message || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

export async function applyCommand({ root, json }) {
  const previousManifest = await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"));
  const previousGraph = await readPreviousCodeGraph(root);
  const manifest = await scanRepo(root, { previousManifest });
  const graph = await buildCodeGraph(root, { manifest });
  const bundle = buildBundle(manifest, { graph });
  const writes = [];

  for (const file of bundle.files) {
    const result = await writeManagedFile(root, file.path, file.content);
    writes.push({ path: file.path, changed: result.changed, mode: file.mode });
  }

  const graphResult = await writeJsonIfChanged(path.join(root, CODEGRAPH_PATH), finalizeCodeGraph(graph, previousGraph));
  const graphWrite = { path: CODEGRAPH_PATH, changed: graphResult.changed, mode: "managed-json" };
  const configResult = await writeDefaultConfigIfMissing(root);
  const configWrite = { path: CONFIG_PATH, changed: configResult.changed, mode: "user-config" };

  const manifestForWrite = finalizeManifest(manifest, previousManifest, [...writes, graphWrite]);
  const manifestResult = await writeJsonIfChanged(
    path.join(root, ".codex-prep", "manifest.json"),
    manifestForWrite
  );
  writes.push(graphWrite);
  writes.push(configWrite);
  writes.push({ path: ".codex-prep/manifest.json", changed: manifestResult.changed, mode: "managed-json" });

  const result = { repo: manifest.repo, writes };
  if (json) {
    printJson(result);
    return;
  }

  console.log(formatApply(result));
}

export async function checkCommand({ root, json }) {
  const config = await loadConfig(root);
  const manifestPath = path.join(root, ".codex-prep", "manifest.json");
  const previousManifest = await readJsonIfExists(manifestPath);
  const current = await scanRepo(root, { previousManifest });
  const previousGraph = await readCodeGraphForCheck(root, config);
  const currentGraph = await buildCodeGraph(root, { manifest: current });
  const findings = [];

  if (!previousManifest) {
    pushFinding(findings, config, "missing-manifest", { file: ".codex-prep/manifest.json", message: ".codex-prep/manifest.json is missing." });
  }

  for (const filePath of MANAGED_FILES) {
    if (!(await fileExists(path.join(root, filePath)))) {
      pushFinding(findings, config, "missing-generated-file", { file: filePath, message: `${filePath} is missing.` });
    }
  }

  if (!previousGraph.exists) {
    pushFinding(findings, config, "missing-codegraph", { file: CODEGRAPH_PATH, message: `${CODEGRAPH_PATH} is missing.` });
  } else if (!previousGraph.graph) {
    pushFinding(findings, config, "invalid-codegraph-json", { file: CODEGRAPH_PATH, message: previousGraph.error });
  } else if (previousGraph.graph.fingerprint !== currentGraph.fingerprint) {
    pushFinding(findings, config, "codegraph-stale", { file: CODEGRAPH_PATH, message: `${CODEGRAPH_PATH} is stale.` });
  }

  if (previousManifest) {
    compareStringArrays(findings, "source-roots", previousManifest.discovery?.sourceRoots, current.discovery.sourceRoots, config);
    compareStringArrays(findings, "test-roots", previousManifest.discovery?.testRoots, current.discovery.testRoots, config);
    compareCommands(findings, previousManifest.discovery?.commands, current.discovery.commands, config);
    comparePackageWorkspaces(findings, previousManifest.discovery?.workspacePackages, current.discovery.workspacePackages, config);
  }

  const result = {
    ok: !hasErrors(findings),
    findings
  };

  if (json) {
    printJson(result);
  } else {
    console.log(formatCheck(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function evalCommand({ root, json }) {
  const manifest = (await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"))) ?? await scanRepo(root);
  const codeGraph = (await readCodeGraphIfExists(root)) ?? await buildCodeGraph(root, { manifest });
  const scenarios = await runEvalScenarios(root, manifest, codeGraph);
  const result = {
    ok: scenarios.every((scenario) => scenario.pass),
    scenarios
  };

  if (json) {
    printJson(result);
  } else {
    console.log(formatEval(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function lintCommand({ root, json }) {
  const result = await lintRepo(root);

  if (json) {
    printJson(result);
  } else {
    console.log(formatLint(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function refreshMapCommand({ root, json }) {
  const previousManifest = await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"));
  const manifest = await scanRepo(root, { previousManifest });
  const graph = await buildCodeGraph(root, { manifest });
  const mapFile = buildBundle(manifest, { graph }).files.find((file) => file.path === "docs/CODEBASE_MAP.md");
  const mapResult = await writeManagedFile(root, mapFile.path, mapFile.content);
  const manifestForWrite = finalizeManifest(manifest, previousManifest, [{ path: mapFile.path, changed: mapResult.changed }]);
  const manifestResult = await writeJsonIfChanged(
    path.join(root, ".codex-prep", "manifest.json"),
    manifestForWrite
  );

  const result = {
    repo: manifest.repo,
    writes: [
      { path: mapFile.path, changed: mapResult.changed },
      { path: ".codex-prep/manifest.json", changed: manifestResult.changed }
    ]
  };

  if (json) {
    printJson(result);
    return;
  }

  console.log(formatApply(result));
}

function finalizeManifest(manifest, previousManifest, writes) {
  const unchanged = previousManifest?.fingerprint === manifest.fingerprint;
  const now = unchanged && previousManifest?.generatedAt ? previousManifest.generatedAt : new Date().toISOString();
  return {
    ...manifest,
    generatedAt: now,
    repo: {
      ...manifest.repo,
      root: "."
    },
    generatedFiles: writes.map((write) => ({
      path: write.path,
      managed: true
    }))
  };
}

async function runEvalScenarios(root, manifest, codeGraph) {
  const agentsPath = path.join(root, "AGENTS.md");
  const reviewSkillPath = path.join(root, ".agents", "skills", "code-review", "SKILL.md");
  const mapPath = path.join(root, "docs", "CODEBASE_MAP.md");
  const agents = (await fileExists(agentsPath)) ? await fs.readFile(agentsPath, "utf8") : "";
  const map = (await fileExists(mapPath)) ? await fs.readFile(mapPath, "utf8") : "";
  const testedBy = codeGraph.relationships?.find((item) => item.kind === "tested-by");
  const dependentEdge = codeGraph.edges?.[0];

  return [
    scenario(
      "find app entrypoint",
      manifest.discovery.entrypoints.length > 0,
      manifest.discovery.entrypoints.join(", ") || "No entrypoints detected."
    ),
    scenario(
      "find test command",
      manifest.discovery.commands.some((command) => /test/i.test(command.name)),
      commandEvidence(manifest, /test/i) || "No test-like command detected."
    ),
    scenario(
      "explain repo structure",
      map.includes("## Repo Shape") && manifest.discovery.topLevel.length > 0,
      manifest.discovery.topLevel.join(", ") || "No top-level structure found."
    ),
    scenario(
      "identify source and test roots",
      manifest.discovery.sourceRoots.length > 0 && manifest.discovery.testRoots.length > 0,
      `source=${manifest.discovery.sourceRoots.join(", ") || "none"}; tests=${manifest.discovery.testRoots.join(", ") || "none"}`
    ),
    scenario(
      "produce a no-edit change plan",
      agents.includes("Explore / Review") && agents.includes("File changes are allowed only"),
      "AGENTS.md contains the explicit Explore / Review boundary."
    ),
    scenario(
      "review a sample diff using repo rules",
      await fileExists(reviewSkillPath),
      ".agents/skills/code-review/SKILL.md exists."
    ),
    scenario(
      "find file dependents from code graph",
      codeGraph.files?.length > 0 && Array.isArray(codeGraph.edges),
      dependentEdge ? `${dependentEdge.to} is imported by ${dependentEdge.from}` : "Graph has no local import edges yet."
    ),
    scenario(
      "find likely tests from code graph",
      Boolean(testedBy),
      testedBy ? `${testedBy.source} tested by ${testedBy.test}` : "No likely source/test relationships detected."
    )
  ];
}

function scenario(name, pass, evidence) {
  return { name, pass, evidence };
}

function commandEvidence(manifest, pattern) {
  const command = manifest.discovery.commands.find((item) => pattern.test(item.name));
  if (!command) {
    return "";
  }
  return `${command.name}: ${command.command}`;
}

function finalizeCodeGraph(graph, previousGraph) {
  const unchanged = previousGraph?.fingerprint === graph.fingerprint;
  const generatedAt = unchanged && previousGraph?.generatedAt ? previousGraph.generatedAt : graph.generatedAt;
  return {
    ...graph,
    generatedAt,
    repo: {
      ...graph.repo,
      root: "."
    }
  };
}

async function readPreviousCodeGraph(root) {
  try {
    return await readCodeGraphIfExists(root);
  } catch {
    return undefined;
  }
}
async function readCodeGraphForCheck(root, config) {
  try {
    const graph = await readCodeGraphIfExists(root);
    return graph ? { exists: true, graph } : { exists: false };
  } catch (error) {
    return { exists: true, graph: undefined, error: `codegraph JSON is invalid: ${error.message}` };
  }
}
function compareStringArrays(findings, name, previous = [], current = [], config = {}) {
  const oldSet = new Set(previous);
  const newSet = new Set(current);
  for (const value of oldSet) {
    if (!newSet.has(value)) {
      pushFinding(findings, config, `${name}-removed`, { message: `${name} entry removed or moved: ${value}` });
    }
  }
  for (const value of newSet) {
    if (!oldSet.has(value)) {
      pushFinding(findings, config, `${name}-added`, { message: `${name} entry added since last apply: ${value}` });
    }
  }
}

function compareCommands(findings, previous = [], current = [], config = {}) {
  const oldMap = new Map(previous.map((command) => [command.name, command.command]));
  const newMap = new Map(current.map((command) => [command.name, command.command]));
  for (const [name, command] of oldMap) {
    if (!newMap.has(name)) {
      pushFinding(findings, config, "command-removed", { message: `command removed since last apply: ${name}` });
    } else if (newMap.get(name) !== command) {
      pushFinding(findings, config, "command-changed", { message: `command changed since last apply: ${name}` });
    }
  }
  for (const [name] of newMap) {
    if (!oldMap.has(name)) {
      pushFinding(findings, config, "command-added", { message: `new command discovered since last apply: ${name}` });
    }
  }
}

function comparePackageWorkspaces(findings, previous = [], current = [], config = {}) {
  compareStringArrays(findings, "workspace-package", previous, current, config);
}

function formatGraph(graph, { source }) {
  return [
    `codex-prep graph: ${graph.repo.name}`,
    "",
    `Source: ${source}`,
    `Files: ${graph.summary.fileCount}`,
    `Edges: ${graph.summary.edgeCount}`,
    `Symbols: ${graph.summary.symbolCount}`,
    `Languages: ${graph.summary.languages.join(", ") || "unknown"}`
  ].join("\n");
}

function formatGraphRefresh(result) {
  return [
    `codex-prep refresh-graph: ${result.repo.name}`,
    "",
    `Files: ${result.graph.fileCount}`,
    `Edges: ${result.graph.edgeCount}`,
    `Symbols: ${result.graph.symbolCount}`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatGraphQuery(result) {
  if (!result.found) {
    return `codex-prep graph-query: no match\n\n${result.message || "No graph result found."}`;
  }
  if (result.type === "file") {
    return [
      `codex-prep graph-query: ${result.query}`,
      "",
      `Source: ${result.source}`,
      `Role: ${result.file.role}`,
      `Language: ${result.file.language}`,
      "Imports:",
      ...formatList(result.imports.map((item) => item.resolved ? `${item.specifier} -> ${item.resolved}` : `${item.specifier} (${item.kind})`)),
      "Dependents:",
      ...formatList(result.dependents),
      "Symbols:",
      ...formatList(result.symbols.map((item) => `${item.name} (${item.kind}${item.exported ? ", exported" : ""})`)),
      "Related tests:",
      ...formatList(result.relatedTests.map((item) => `${item.path} [${item.confidence}]`))
    ].join("\n");
  }
  return [
    `codex-prep graph-query: ${result.query}`,
    "",
    `Source: ${result.source}`,
    "Matches:",
    ...formatList(result.matches.map((item) => `${item.name} (${item.kind}) in ${item.file} [${item.confidence}]`))
  ].join("\n");
}

function formatGraphExport(result) {
  return [
    `codex-prep graph-export: ${result.repo.name}`,
    "",
    `Format: ${result.format}`,
    `Source: ${result.source}`,
    `Output: ${result.outputDir}`,
    `Symbols: ${result.includeSymbols ? "included" : "omitted by default"}`,
    `Notes: ${result.notes.total} (${result.notes.workflows ?? 0} workflow, ${result.notes.hubs} hubs, ${result.notes.modules ?? 0} modules, ${result.notes.files} files, ${result.notes.tests} tests, ${result.notes.symbols} symbols)`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.removed ? "removed" : write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatScan(manifest) {
  const lines = [
    `codex-prep scan: ${manifest.repo.name}`,
    "",
    `Root: ${manifest.repo.root}`,
    `Languages: ${manifest.discovery.languages.join(", ") || "unknown"}`,
    `Package managers: ${manifest.discovery.packageManagers.join(", ") || "none detected"}`,
    `Source roots: ${manifest.discovery.sourceRoots.join(", ") || "none detected"}`,
    `Test roots: ${manifest.discovery.testRoots.join(", ") || "none detected"}`,
    `Entrypoints: ${manifest.discovery.entrypoints.join(", ") || "none detected"}`,
    "",
    "Commands:",
    ...manifest.discovery.commands.map((command) => `- ${command.name}: ${command.command}`),
    "",
    "Evidence:",
    ...manifest.evidence.map((item) => `- [${item.confidence}] ${item.fact} (${item.source})`)
  ];
  return lines.join("\n");
}

function formatPlan(proposal, savedPlan) {
  const lines = [
    `codex-prep plan: ${proposal.repo.name}`,
    "",
    proposal.summary,
    "",
    "Proposed writes:",
    ...proposal.proposedWrites.map((write) => `- ${write.path} (${write.mode}): ${write.reason}`),
    "",
    "Validation plan:",
    ...formatList(proposal.validationPlan),
    "",
    "Assumptions:",
    ...formatList(proposal.assumptions)
  ];

  if (savedPlan) {
    lines.push(
      "",
      "Saved plan:",
      ...savedPlan.files.map((file) => `- ${file.changed ? "updated" : "unchanged"} ${relativePath(file.path)}`)
    );
  }

  return lines.join("\n");
}

function formatPlanMutation(title, result) {
  return [
    `${title}: ${result.plan.status}`,
    "",
    `Intent: ${result.plan.userIntent || "none recorded"}`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatPlanStatus(result) {
  if (!result.exists) {
    return "codex-prep plan-status: none\n\nNo active plan found. Run codex-prep plan to create one.";
  }

  const plan = result.plan;
  const recentDecisions = plan.decisionLog.slice(-3).map((item) => `${item.at} ${item.event}: ${item.note}`);
  return [
    `codex-prep plan-status: ${plan.status}`,
    "",
    `Source: ${result.source}`,
    `Repo: ${plan.repo?.name || "unknown"}`,
    `Saved: ${plan.savedAt || "unknown"}`,
    `Updated: ${plan.updatedAt || "unknown"}`,
    `Goal: ${plan.goal || "none recorded"}`,
    `Intent: ${plan.userIntent || "none recorded"}`,
    `Risk: ${plan.riskLevel || "medium"}`,
    `Target agent: ${plan.targetAgent || "none recorded"}`,
    `Build: ${plan.build.status}`,
    `Branch: ${plan.build.branchName || "none"}`,
    "",
    "Success criteria:",
    ...formatList(plan.successCriteria),
    "",
    "Scope:",
    ...formatList(plan.proposedScope),
    "",
    "Non-goals:",
    ...formatList(plan.nonGoals),
    "",
    "Likely touched files:",
    ...formatList(plan.filesLikelyTouched),
    "",
    "Validation:",
    ...formatList(plan.validationPlan),
    "",
    "Stop rules:",
    ...formatList(plan.stopRules),
    "",
    "Approval boundaries:",
    ...formatList(plan.approvalBoundaries),
    "",
    "Forbidden actions:",
    ...formatList(plan.forbiddenActions),
    "",
    "Open questions:",
    ...formatList(plan.openQuestions),
    "",
    "Recent decisions:",
    ...formatList(recentDecisions)
  ].join("\n");
}

function formatList(values = []) {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function formatApply(result) {
  return [
    `codex-prep apply: ${result.repo.name}`,
    "",
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatCheck(result) {
  if (result.findings.length === 0) {
    return "codex-prep check: ok\n\nNo obvious generated guidance drift found.";
  }
  return [
    `codex-prep check: ${result.ok ? "ok with warnings" : "drift found"}`,
    "",
    ...result.findings.map((item) => `- [${item.level}] ${item.code} ${item.message} Fix: ${item.fix}`)
  ].join("\n");
}

function formatEval(result) {
  return [
    `codex-prep eval: ${result.ok ? "pass" : "fail"}`,
    "",
    ...result.scenarios.map((item) => `- ${item.pass ? "PASS" : "FAIL"} ${item.name}: ${item.evidence}`)
  ].join("\n");
}

function formatPlanReview(result) {
  const lines = [
    `codex-prep plan-review: ${result.readyToBuild ? "ready to build" : "keep planning"}`,
    "",
    `Source: ${result.source || "none"}`,
    `Suggested branch: ${result.suggestedBranch || "none"}`,
    "",
    "Findings:",
    ...formatFindings(result.findings),
    "",
    "Next actions:",
    ...result.nextActions.map((item) => `- ${item.label}: ${item.command} (${item.description})`)
  ];
  return lines.join("\n");
}

function formatPlanStart(result) {
  return [
    "codex-prep plan-start: in_progress",
    "",
    `Branch: ${result.branch.name}`,
    `Base: ${result.branch.baseBranch}@${result.branch.baseCommit.slice(0, 12)}`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatFindings(findings = []) {
  return findings.length > 0
    ? findings.map((item) => `- [${item.level}] ${item.code} ${item.file || "plan"}: ${item.message} Fix: ${item.fix}`)
    : ["- none"];
}

function formatPlanLint(result) {
  if (result.findings.length === 0) {
    return "codex-prep plan-lint: pass\n\nPlan is ready for implementation review.";
  }
  return [
    "codex-prep plan-lint: " + (result.ok ? "pass with warnings" : "failed"),
    "",
    `Source: ${result.source || "none"}`,
    ...result.findings.map((item) => "- [" + item.level + "] " + item.code + " " + (item.file || "plan") + ": " + item.message + " Fix: " + item.fix)
  ].join("\n");
}

function formatLint(result) {
  if (result.findings.length === 0) {
    return "codex-prep lint: ok\n\nNo managed-file lint findings.";
  }
  return [
    "codex-prep lint: " + (result.ok ? "ok with warnings" : "failed"),
    "",
    ...result.findings.map((item) => "- [" + item.level + "] " + item.code + " " + item.file + ": " + item.message + " Fix: " + item.fix)
  ].join("\n");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export const internals = {
  buildPlanProposal,
  buildPlanReviewResult,
  finalizeManifest,
  normalizePlan,
  runEvalScenarios,
  finalizeCodeGraph,
  safeTimestamp,
  suggestPlanBranch,
  updatePlanDocument
};
