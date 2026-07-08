import fs from "node:fs/promises";
import path from "node:path";
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
import { lintPlan } from "./plan-lint.js";
import { hasErrors, pushFinding } from "./rules.js";
import { scanRepo } from "./scan.js";

const PLAN_HISTORY_DIR = ".codex-prep/plans";
const LATEST_PLAN_PATH = `${PLAN_HISTORY_DIR}/latest-plan.json`;
const ACTIVE_PLAN_PATH = `${PLAN_HISTORY_DIR}/active-plan.json`;
const PLAN_STATUSES = new Set(["draft", "approved", "implemented", "superseded", "rejected"]);
const TERMINAL_PLAN_STATUSES = new Set(["implemented", "superseded", "rejected"]);
const PLAN_RISK_LEVELS = new Set(["low", "medium", "high"]);
const PLAN_TARGET_AGENTS = new Set(["codex", "cursor", "claude-code", "generic"]);
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
    schemaVersion: 2,
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

export async function applyCommand({ root, json }) {
  const previousManifest = await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"));
  const manifest = await scanRepo(root, { previousManifest });
  const bundle = buildBundle(manifest);
  const writes = [];

  for (const file of bundle.files) {
    const result = await writeManagedFile(root, file.path, file.content);
    writes.push({ path: file.path, changed: result.changed, mode: file.mode });
  }

  const configResult = await writeDefaultConfigIfMissing(root);
  const configWrite = { path: CONFIG_PATH, changed: configResult.changed, mode: "user-config" };

  const manifestForWrite = finalizeManifest(manifest, previousManifest, writes);
  const manifestResult = await writeJsonIfChanged(
    path.join(root, ".codex-prep", "manifest.json"),
    manifestForWrite
  );
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
  const findings = [];

  if (!previousManifest) {
    pushFinding(findings, config, "missing-manifest", { file: ".codex-prep/manifest.json", message: ".codex-prep/manifest.json is missing." });
  }

  for (const filePath of MANAGED_FILES) {
    if (!(await fileExists(path.join(root, filePath)))) {
      pushFinding(findings, config, "missing-generated-file", { file: filePath, message: `${filePath} is missing.` });
    }
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
  const scenarios = await runEvalScenarios(root, manifest);
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
  const mapFile = buildBundle(manifest).files.find((file) => file.path === "docs/CODEBASE_MAP.md");
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

async function runEvalScenarios(root, manifest) {
  const agentsPath = path.join(root, "AGENTS.md");
  const reviewSkillPath = path.join(root, ".agents", "skills", "code-review", "SKILL.md");
  const mapPath = path.join(root, "docs", "CODEBASE_MAP.md");
  const agents = (await fileExists(agentsPath)) ? await fs.readFile(agentsPath, "utf8") : "";
  const map = (await fileExists(mapPath)) ? await fs.readFile(mapPath, "utf8") : "";

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
  finalizeManifest,
  normalizePlan,
  runEvalScenarios,
  safeTimestamp,
  updatePlanDocument
};
