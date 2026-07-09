import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ADAPTERS_MANIFEST_PATH, HANDOFF_PATH, buildAdapterBundle, buildHandoffFile, listAdapters, validateContextProfile } from "./adapters.js";
import { CODEGRAPH_PATH, buildCodeGraph, loadOrBuildCodeGraph, orientCodeGraph, queryCodeGraph, readCodeGraphIfExists, validateOrientProfile } from "./codegraph.js";
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
import {
  VALIDATION_RESULTS_PATH,
  appendValidationResult,
  buildControlState,
  buildDoctorResult,
  ensureLocalStateIgnored,
  readGitState,
  readValidationMemory,
  selectNextAction
} from "./state.js";
import { hasErrors, pushFinding } from "./rules.js";
import { scanRepo } from "./scan.js";

const execFileAsync = promisify(execFile);
const PLAN_HISTORY_DIR = ".codex-prep/plans";
const LATEST_PLAN_PATH = `${PLAN_HISTORY_DIR}/latest-plan.json`;
const ACTIVE_PLAN_PATH = `${PLAN_HISTORY_DIR}/active-plan.json`;
const PLAN_STATUSES = new Set(["draft", "approved", "implemented", "superseded", "rejected"]);
const TERMINAL_PLAN_STATUSES = new Set(["implemented", "superseded", "rejected"]);
const PLAN_RISK_LEVELS = new Set(["low", "medium", "high"]);
const PLAN_TARGET_AGENTS = new Set(["codex", "cursor", "claude-code", "jan", "ollama", "generic"]);
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
const VALIDATION_COMMAND_PATTERN = /\b(test|verify|lint|check|build|eval|typecheck|e2e|playwright)\b/i;

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

export async function statusCommand({ root, json }) {
  const state = await buildControlState(root);
  const result = buildStatusResult(state);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatStatus(result));
  return result;
}

export async function localIgnoreCommand({ root, json }) {
  const result = await ensureLocalStateIgnored(root);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatLocalIgnore(result));
  return result;
}

export async function doctorCommand({ root, json }) {
  const state = await buildControlState(root);
  const result = {
    repo: state.repo,
    ok: state.doctor.ok,
    findings: state.doctor.findings,
    nextAction: state.nextAction
  };

  if (json) {
    printJson(result);
  } else {
    console.log(formatDoctor(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }

  return result;
}

export async function validationRecordCommand({ root, json, validationCommand, validationResult, summary, phase, now }) {
  if (!validationCommand) {
    throw new Error("validation-record requires --validation-command <command>");
  }
  const resultValue = String(validationResult || "").trim().toLowerCase();
  if (!["pass", "fail"].includes(resultValue)) {
    throw new Error("validation-record --result must be pass or fail");
  }

  const git = await readGitState(root);
  const entry = {
    schemaVersion: 1,
    recordedAt: (now ?? new Date()).toISOString(),
    command: validationCommand,
    result: resultValue,
    phase: phase || "validation",
    summary: summary || `${validationCommand} ${resultValue}`,
    git: git.isGitRepo ? {
      branchName: git.branchName,
      headCommit: git.headCommit,
      dirtyFiles: git.dirtyFiles
    } : { isGitRepo: false }
  };
  const write = await appendValidationResult(root, entry);
  const memory = await readValidationMemory(root);
  const result = { entry, latest: memory.latest, writes: [write] };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatValidationRecord(result));
  return result;
}

export async function planAttachCommand({ root, json, note, now }) {
  if (!note) {
    throw new Error("plan-attach requires --note <text>");
  }

  const current = await readActiveOrLatestPlan(root);
  if (!current) {
    throw new Error("no active plan found. Run codex-prep plan first.");
  }

  if (!["approved", "in_progress"].includes(current.plan.build.status)) {
    throw new Error("plan-attach requires an approved or in-progress plan. Run codex-prep plan-approve first.");
  }

  const git = await readGitState(root);
  if (!git.isGitRepo || !git.branchName) {
    throw new Error("plan-attach requires a git repo with a checked-out branch.");
  }

  const attachedAt = (now ?? new Date()).toISOString();
  const attached = updatePlanDocument(current.plan, {
    note,
    now: now ?? new Date(attachedAt),
    event: "attached",
    build: {
      ...current.plan.build,
      status: "in_progress",
      branchName: git.branchName,
      baseBranch: current.plan.build.baseBranch || DEFAULT_BASE_BRANCH,
      baseCommit: current.plan.build.baseCommit || git.headCommit,
      startedAt: current.plan.build.startedAt || attachedAt,
      attachedAt,
      startMode: "attached",
      dirtyAtStart: git.dirtyFiles.length > 0,
      worktreeStatus: git.rawStatus || "clean"
    }
  });
  const writes = await writePlanState(root, attached, { includeHistory: true });
  const result = { plan: attached, branch: { name: git.branchName, headCommit: git.headCommit }, writes };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatPlanAttach(result));
  return result;
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
      startedAt,
      startMode: "plan-start",
      attachedAt: "",
      dirtyAtStart: false,
      worktreeStatus: "clean"
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
  const result = await writeRefreshGraphResult(root);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatGraphRefresh(result));
  return result;
}

async function writeRefreshGraphResult(root) {
  const manifest = await scanRepo(root);
  const previousGraph = await readPreviousCodeGraph(root);
  const graph = await buildCodeGraph(root, { manifest });
  const graphResult = await writeJsonIfChanged(path.join(root, CODEGRAPH_PATH), finalizeCodeGraph(graph, previousGraph));
  return {
    repo: graph.repo,
    graph: graph.summary,
    writes: [{ path: CODEGRAPH_PATH, changed: graphResult.changed, mode: "managed-json" }]
  };
}

export async function orientCommand({ root, json, task, limit, profile }) {
  const manifest = await scanRepo(root);
  const { graph, source } = await loadOrBuildCodeGraph(root, { manifest });
  const result = orientCodeGraph(graph, {
    task,
    limit,
    profile,
    source,
    commands: manifest.discovery.commands
  });

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatOrient(result));
  return result;
}

export async function graphQueryCommand({ root, json, file, symbol, limit, depth }) {
  const { graph, source } = await loadOrBuildCodeGraph(root);
  const result = { source, ...queryCodeGraph(graph, { file, symbol, limit, depth }) };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatGraphQuery(result));
  return result;
}

export async function graphExportCommand({ root, json, format = "obsidian", includeSymbols = false }) {
  const result = await writeGraphExportResult(root, { format, includeSymbols });

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatGraphExport(result));
  return result;
}

async function writeGraphExportResult(root, { format = "obsidian", includeSymbols = false } = {}) {
  if (format !== "obsidian") {
    throw new Error("graph-export currently supports --format obsidian");
  }

  const { graph, source } = await loadOrBuildCodeGraph(root);
  const manifest = (await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"))) ?? await scanRepo(root);
  const activePlan = await readJsonIfExists(path.join(root, ACTIVE_PLAN_PATH));
  const validationState = await readValidationMemory(root);
  const exportResult = await exportObsidianGraph(root, graph, { includeSymbols, manifest, activePlan, validationState });
  return {
    repo: graph.repo,
    source,
    ...exportResult
  };
}


export async function adaptersCommand({ json }) {
  const result = { targets: listAdapters() };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatAdaptersList(result));
  return result;
}

export async function adapterPlanCommand({ root, json, target = "all", profile = "standard" }) {
  const manifest = await scanRepo(root);
  const graph = await buildCodeGraph(root, { manifest });
  const state = await buildControlState(root, { manifest, graph });
  const bundle = buildAdapterBundle({ manifest, graph, state, target, profile });
  const result = buildAdapterResult(manifest, bundle, []);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatAdapterPlan(result));
  return result;
}

export async function adapterApplyCommand({ root, json, target = "all", profile = "standard" }) {
  const result = await writeAdapterApplyResult(root, { target, profile });

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatAdapterApply(result));
  return result;
}

async function writeAdapterApplyResult(root, { target = "all", profile = "standard" } = {}) {
  const manifest = await scanRepo(root);
  const graph = await buildCodeGraph(root, { manifest });
  const state = await buildControlState(root, { manifest, graph });
  const previousManifest = await readPreviousAdaptersManifest(root);
  const bundle = buildAdapterBundle({ manifest, graph, state, target, profile, previousManifest });
  const writes = [];

  for (const file of bundle.files) {
    const result = await writeManagedFile(root, file.path, file.content);
    writes.push({ path: file.path, changed: result.changed, mode: file.mode, target: file.target });
  }

  const manifestResult = await writeJsonIfChanged(path.join(root, ADAPTERS_MANIFEST_PATH), bundle.manifest);
  writes.push({ path: ADAPTERS_MANIFEST_PATH, changed: manifestResult.changed, mode: "managed-json", target: "adapter-manifest" });

  return buildAdapterResult(manifest, bundle, writes);
}

export async function handoffCommand({ root, json }) {
  const result = await writeHandoffResult(root);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatHandoff(result));
  return result;
}

async function writeHandoffResult(root) {
  const manifest = await scanRepo(root);
  const graph = await buildCodeGraph(root, { manifest });
  const state = assumePostHandoffState(await buildControlState(root, { manifest, graph }));
  const file = buildHandoffFile(manifest, graph, state);
  const write = await writeManagedFile(root, file.path, file.content);
  return {
    repo: manifest.repo,
    handoff: {
      path: file.path,
      fingerprint: state.handoff.fingerprint,
      stale: false
    },
    writes: [{ path: file.path, changed: write.changed, mode: file.mode }]
  };
}
export async function prepareCommand({ root, json, target = "all", profile = "standard" }) {
  const contextProfile = validateContextProfile(profile);
  const operations = [];

  const localIgnore = await ensureLocalStateIgnored(root);
  operations.push({
    id: "local-ignore",
    command: "codex-prep local-ignore",
    reason: "Keep local CodexManager plan and validation memory out of git status.",
    writes: [{ path: localIgnore.path, changed: localIgnore.changed, mode: "local-git-exclude" }]
  });
  operations.push(await runLifecycleOperation("apply", "codex-prep apply", "Write the base CodexManager onboarding bundle, manifest, dashboard, and code graph.", () => writeApplyResult(root)));
  operations.push(await runLifecycleOperation("graph-export", "codex-prep graph-export --format obsidian", "Write the Obsidian workflow/code graph adapter from the current graph.", () => writeGraphExportResult(root, { format: "obsidian", includeSymbols: false })));
  operations.push(await runLifecycleOperation("adapter-apply", `codex-prep adapter-apply --target ${target} --profile ${contextProfile}`, "Write selected multi-agent adapter files.", () => writeAdapterApplyResult(root, { target, profile: contextProfile })));
  operations.push(await runLifecycleOperation("handoff", "codex-prep handoff", "Write a reconnect/resume packet after generated state is current.", () => writeHandoffResult(root)));

  const state = await buildControlState(root);
  const result = {
    repo: state.repo,
    target,
    profile: contextProfile,
    operations,
    status: buildStatusResult(state),
    nextAction: state.nextAction
  };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatPrepare(result));
  return result;
}

export async function refreshCommand({ root, json, auto = false, target = "all", profile = "standard" }) {
  const contextProfile = validateContextProfile(profile);
  const state = await buildControlState(root);
  const proposed = buildRefreshPlan(state, { target, profile: contextProfile });
  const operations = [];

  if (auto) {
    for (const item of proposed.operations) {
      operations.push(await runRefreshOperation(root, item, { target, profile: contextProfile }));
    }
  }

  const finalState = auto ? await buildControlState(root) : state;
  const result = {
    repo: state.repo,
    auto,
    proposed: proposed.operations,
    operations,
    status: buildStatusResult(finalState),
    nextAction: finalState.nextAction
  };

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatRefresh(result));
  return result;
}

export async function preflightCommand({ root, json }) {
  const manifest = await scanRepo(root);
  const { graph, source } = await loadOrBuildCodeGraph(root, { manifest });
  const state = await buildControlState(root, { manifest, graph });
  const result = buildPreflightResult(state, graph, source, manifest);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatPreflight(result));
  return result;
}

async function runLifecycleOperation(id, command, reason, callback) {
  const result = await callback();
  return {
    id,
    command,
    reason,
    writes: result.writes ?? [],
    result: summarizeOperationResult(result)
  };
}

async function runRefreshOperation(root, item, options) {
  if (item.id === "local-ignore") {
    const result = await ensureLocalStateIgnored(root);
    return {
      ...item,
      writes: [{ path: result.path, changed: result.changed, mode: "local-git-exclude" }],
      result: { changed: result.changed }
    };
  }
  if (item.id === "apply") {
    return runLifecycleOperation(item.id, item.command, item.reason, () => writeApplyResult(root));
  }
  if (item.id === "refresh-graph") {
    return runLifecycleOperation(item.id, item.command, item.reason, () => writeRefreshGraphResult(root));
  }
  if (item.id === "graph-export") {
    return runLifecycleOperation(item.id, item.command, item.reason, () => writeGraphExportResult(root, { format: "obsidian", includeSymbols: false }));
  }
  if (item.id === "adapter-apply") {
    return runLifecycleOperation(item.id, item.command, item.reason, () => writeAdapterApplyResult(root, { target: options.target, profile: options.profile }));
  }
  if (item.id === "handoff") {
    return runLifecycleOperation(item.id, item.command, item.reason, () => writeHandoffResult(root));
  }
  throw new Error(`unknown refresh operation ${item.id}`);
}

function buildRefreshPlan(state, { target = "all", profile = "standard" } = {}) {
  const missingManaged = state.generated.files.filter((file) => !file.exists).map((file) => file.path);
  const adapterFilesMissing = (state.adapters.generatedFiles ?? []).filter((file) => !file.exists).map((file) => file.path);
  const applyNeeded = !state.manifest.exists || state.manifest.stale || missingManaged.length > 0 || !state.generated.dashboard.exists;
  const graphNeeded = !applyNeeded && (!state.graph.exists || state.graph.invalid || state.graph.stale);
  const graphWillChange = applyNeeded || graphNeeded;
  const obsidianNeeded = !state.generated.obsidian.exists || state.generated.obsidian.stale || graphWillChange;
  const adapterNeeded = !state.adapters.exists || state.adapters.invalid || state.adapters.stale || adapterFilesMissing.length > 0 || graphWillChange;
  const handoffNeeded = !state.handoff.exists || state.handoff.stale || graphWillChange || adapterNeeded;
  const operations = [];

  if (state.git.localStateFiles.length > 0) {
    operations.push(refreshOperation("local-ignore", "codex-prep local-ignore", "Local CodexManager state is visible in git status."));
  }
  if (applyNeeded) {
    operations.push(refreshOperation("apply", "codex-prep apply", refreshReason([
      !state.manifest.exists && "manifest missing",
      state.manifest.stale && "manifest stale",
      missingManaged.length > 0 && `managed files missing: ${missingManaged.join(", ")}`,
      !state.generated.dashboard.exists && "dashboard missing"
    ])));
  }
  if (graphNeeded) {
    operations.push(refreshOperation("refresh-graph", "codex-prep refresh-graph", refreshReason([
      !state.graph.exists && "code graph missing",
      state.graph.invalid && "code graph invalid",
      state.graph.stale && "code graph stale"
    ])));
  }
  if (obsidianNeeded) {
    operations.push(refreshOperation("graph-export", "codex-prep graph-export --format obsidian", refreshReason([
      !state.generated.obsidian.exists && "Obsidian index missing",
      state.generated.obsidian.stale && "Obsidian index stale",
      graphWillChange && "graph-backed adapter should follow refreshed graph"
    ])));
  }
  if (adapterNeeded) {
    operations.push(refreshOperation("adapter-apply", `codex-prep adapter-apply --target ${target} --profile ${profile}`, refreshReason([
      !state.adapters.exists && "adapter manifest missing",
      state.adapters.invalid && "adapter manifest invalid",
      state.adapters.stale && "adapter output stale",
      adapterFilesMissing.length > 0 && `adapter files missing: ${adapterFilesMissing.join(", ")}`,
      graphWillChange && "adapter context should follow refreshed graph"
    ])));
  }
  if (handoffNeeded) {
    operations.push(refreshOperation("handoff", "codex-prep handoff", refreshReason([
      !state.handoff.exists && "handoff missing",
      state.handoff.stale && "handoff stale",
      graphWillChange && "handoff should follow refreshed graph",
      adapterNeeded && "handoff should follow refreshed adapters"
    ])));
  }

  return { operations };
}

function refreshOperation(id, command, reason) {
  return { id, command, reason };
}

function refreshReason(reasons) {
  return reasons.filter(Boolean).join("; ") || "Generated state is stale.";
}

function buildPreflightResult(state, graph, source, manifest) {
  const dirtyFiles = state.git.dirtyFiles ?? [];
  const graphFilesByPath = new Map((graph.files ?? []).map((file) => [file.path, file]));
  const likelyTests = collectLikelyTests(dirtyFiles, graphFilesByPath);
  const validationCommands = detectedValidationCommands(manifest.discovery.commands);
  const staleState = {
    manifest: state.manifest.stale,
    graph: state.graph.stale || state.graph.invalid || !state.graph.exists,
    dashboard: !state.generated.dashboard.exists,
    obsidian: !state.generated.obsidian.exists || state.generated.obsidian.stale,
    adapters: !state.adapters.exists || state.adapters.invalid || state.adapters.stale,
    handoff: !state.handoff.exists || state.handoff.stale,
    validation: Boolean(state.validation.stale)
  };
  const riskAreas = buildPreflightRiskAreas(state, dirtyFiles, staleState);
  const nextActions = buildPreflightNextActions({ state, dirtyFiles, likelyTests, validationCommands, staleState });

  return {
    repo: state.repo,
    branch: state.git.branchName || "",
    graphSource: source,
    dirtyFiles,
    localStateFiles: state.git.localStateFiles ?? [],
    likelyTests,
    validationCommands,
    latestValidation: state.validation.latest ?? null,
    validationFreshness: state.validation.freshness,
    staleState,
    riskAreas,
    nextActions
  };
}

function collectLikelyTests(dirtyFiles, graphFilesByPath) {
  const tests = new Set();
  for (const filePath of dirtyFiles) {
    const file = graphFilesByPath.get(filePath);
    if (!file) {
      continue;
    }
    if (file.role === "test") {
      tests.add(file.path);
    }
    for (const testRef of file.relatedTests ?? []) {
      tests.add(testRef.path);
    }
  }
  return [...tests].sort();
}

function detectedValidationCommands(commands = []) {
  return commands
    .filter((command) => VALIDATION_COMMAND_PATTERN.test(command.name ?? "") || VALIDATION_COMMAND_PATTERN.test(command.command ?? ""))
    .map((command) => ({ name: command.name, command: command.command, source: command.source ?? "detected" }));
}

function buildPreflightRiskAreas(state, dirtyFiles, staleState) {
  const risks = [];
  if (dirtyFiles.length > 0) {
    risks.push({ code: "PF001", level: "info", message: `${dirtyFiles.length} working-tree file(s) changed.` });
  }
  if (dirtyFiles.some((file) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|pyproject\.toml|requirements.*\.txt|poetry\.lock)$/i.test(file))) {
    risks.push({ code: "PF002", level: "warn", message: "Dependency, package, or command metadata changed." });
  }
  if (dirtyFiles.some((file) => file.startsWith(".github/workflows/") || /(^|\/)(deploy|deployment|migration|migrations|db|database)(\/|$)/i.test(file))) {
    risks.push({ code: "PF003", level: "warn", message: "CI, deployment, migration, or database-adjacent files changed." });
  }
  if (Object.values(staleState).some(Boolean)) {
    risks.push({ code: "PF004", level: "warn", message: "One or more generated workflow artifacts or validation records are stale." });
  }
  if ((state.doctor.findings ?? []).some((finding) => finding.level === "error")) {
    risks.push({ code: "PF005", level: "error", message: "Doctor has blocking findings that should be fixed before commit or merge." });
  }
  return risks;
}

function buildPreflightNextActions({ state, dirtyFiles, likelyTests, validationCommands, staleState }) {
  const actions = [];
  if (staleState.graph) {
    actions.push("Run codex-prep refresh --auto or codex-prep refresh-graph before relying on graph results.");
  }
  if (staleState.adapters || staleState.handoff || staleState.obsidian || staleState.dashboard || staleState.manifest) {
    actions.push("Run codex-prep refresh --auto to update generated workflow artifacts.");
  }
  if (dirtyFiles.length > 0 && likelyTests.length > 0) {
    actions.push(`Run likely related tests: ${likelyTests.join(", ")}.`);
  }
  if (validationCommands.length > 0 && (dirtyFiles.length > 0 || state.validation.stale || !state.validation.latest)) {
    actions.push(`Run validation: ${validationCommands.map((item) => item.command).join("; ")}.`);
  }
  if (!state.validation.latest || state.validation.stale) {
    actions.push("Record the validation result with codex-prep validation-record.");
  }
  if (actions.length === 0) {
    actions.push("No obvious preflight action is missing; review the diff and proceed with the normal approval boundary.");
  }
  return [...new Set(actions)];
}

function summarizeOperationResult(result) {
  return {
    writeCount: result.writes?.length ?? 0,
    changedCount: (result.writes ?? []).filter((write) => write.changed).length
  };
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
  const localIgnore = await ensureLocalStateIgnored(root);
  const writes = [];
  if (localIgnore.isGitRepo) {
    writes.push({ path: localIgnore.path, changed: localIgnore.changed, mode: "local-git-exclude" });
  }
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
    approvalNote: "",
    startMode: "",
    attachedAt: "",
    dirtyAtStart: false,
    worktreeStatus: ""
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
    approvalNote: stringOrEmpty(build?.approvalNote),
    startMode: stringOrEmpty(build?.startMode),
    attachedAt: stringOrEmpty(build?.attachedAt),
    dirtyAtStart: Boolean(build?.dirtyAtStart),
    worktreeStatus: stringOrEmpty(build?.worktreeStatus)
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
  return file.startsWith(".codex-prep/plans/") || file === VALIDATION_RESULTS_PATH;
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
  const result = await writeApplyResult(root);

  if (json) {
    printJson(result);
    return result;
  }

  console.log(formatApply(result));
  return result;
}

async function writeApplyResult(root) {
  const previousManifest = await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"));
  const previousGraph = await readPreviousCodeGraph(root);
  const manifest = await scanRepo(root, { previousManifest });
  const graph = await buildCodeGraph(root, { manifest });
  const state = assumePostApplyState(await buildControlState(root, { manifest, graph }));
  const bundle = buildBundle(manifest, { graph, state });
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

  return { repo: manifest.repo, writes };
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

  const state = await buildControlState(root, { manifest: current, graph: currentGraph });
  appendAdapterCheckFindings(findings, config, state);

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

function assumePostApplyState(state) {
  state.manifest.exists = true;
  state.manifest.stale = false;
  state.graph.exists = true;
  state.graph.stale = false;
  state.graph.invalid = false;
  state.generated.files = state.generated.files.map((file) => ({ ...file, exists: true }));
  state.generated.dashboard.exists = true;
  state.doctor = buildDoctorResult(state);
  state.nextAction = selectNextAction(state);
  return state;
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
  const state = await buildControlState(root, { manifest, graph: codeGraph });
  const adapterBundle = buildAdapterBundle({ manifest, graph: codeGraph, state, target: "all" });
  const handoffFile = buildHandoffFile(manifest, codeGraph, assumePostHandoffState({ ...state, doctor: state.doctor, nextAction: state.nextAction }));

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
    ),
    scenario(
      "produce graph-first reading list",
      graphFirstOrientationPasses(codeGraph, manifest),
      graphFirstOrientationEvidence(codeGraph, manifest)
    ),
    scenario(
      "produce multi-agent adapter bundle",
      adapterBundle.files.some((file) => file.path === "CLAUDE.md") && adapterBundle.files.some((file) => file.path === ".cursor/rules/codexmanager-workflow.mdc"),
      `${adapterBundle.targets.join(", ")}; ${adapterBundle.files.length} files`
    ),
    scenario(
      "produce resume handoff",
      handoffFile.path === HANDOFF_PATH && handoffFile.content.includes("Handoff fingerprint:"),
      handoffFile.path
    )
  ];
}

function scenario(name, pass, evidence) {
  return { name, pass, evidence };
}

function graphFirstOrientationPasses(codeGraph, manifest) {
  const result = orientCodeGraph(codeGraph, {
    task: "change answer behavior",
    commands: manifest.discovery.commands,
    limit: 1,
    source: "eval"
  });
  return result.readingList.length > 0 &&
    result.contextEstimate.selectedBytes > 0 &&
    result.contextEstimate.selectedBytes < result.contextEstimate.totalGraphBytes;
}

function graphFirstOrientationEvidence(codeGraph, manifest) {
  const result = orientCodeGraph(codeGraph, {
    task: "change answer behavior",
    commands: manifest.discovery.commands,
    limit: 1,
    source: "eval"
  });
  const files = result.readingList.map((item) => item.path).join(", ") || "none";
  return `${files}; ${result.contextEstimate.estimatedSelectedTokens}/${result.contextEstimate.estimatedGraphTokens} estimated tokens`;
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


async function readPreviousAdaptersManifest(root) {
  try {
    return await readJsonIfExists(path.join(root, ADAPTERS_MANIFEST_PATH));
  } catch {
    return undefined;
  }
}

function buildAdapterResult(manifest, bundle, writes) {
  return {
    repo: manifest.repo,
    targets: bundle.targets,
    contextProfile: bundle.contextProfile,
    sourceFingerprint: bundle.manifest.sourceFingerprint,
    files: bundle.files.map((file) => ({
      path: file.path,
      target: file.target,
      mode: file.mode,
      reason: file.reason
    })),
    manifest: {
      path: ADAPTERS_MANIFEST_PATH,
      sourceFingerprint: bundle.manifest.sourceFingerprint,
      contextProfile: bundle.manifest.contextProfile,
      targets: bundle.manifest.targets.map((target) => ({
        name: target.name,
        surface: target.surface,
        capabilities: target.capabilities,
        files: target.files
      }))
    },
    writes
  };
}

function assumePostHandoffState(state) {
  const next = {
    ...state,
    handoff: {
      ...(state.handoff ?? {}),
      exists: true,
      stale: false,
      fingerprint: state.handoff?.expectedFingerprint ?? ""
    }
  };
  next.doctor = buildDoctorResult(next);
  next.nextAction = selectNextAction(next);
  return next;
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

function appendAdapterCheckFindings(findings, config, state) {
  if (state.adapters.invalid) {
    pushFinding(findings, config, "invalid-adapters-json", { file: ADAPTERS_MANIFEST_PATH, message: state.adapters.error || "adapter manifest is invalid" });
  } else if (state.adapters.exists) {
    if (state.adapters.stale) {
      pushFinding(findings, config, "adapter-source-stale", { file: ADAPTERS_MANIFEST_PATH, message: `${ADAPTERS_MANIFEST_PATH} is stale.` });
    }
    for (const file of state.adapters.generatedFiles.filter((item) => !item.exists)) {
      pushFinding(findings, config, "missing-adapter-file", { file: file.path, message: `${file.path} is missing.` });
    }
  }

  if (!state.handoff.exists) {
    pushFinding(findings, config, "handoff-missing", { file: HANDOFF_PATH, message: `${HANDOFF_PATH} is missing.` });
  } else if (state.handoff.stale) {
    pushFinding(findings, config, "handoff-stale", { file: HANDOFF_PATH, message: `${HANDOFF_PATH} is stale.` });
  }
}


function formatAdaptersList(result) {
  return [
    "codex-prep adapters",
    "",
    ...result.targets.map((target) => `- ${target.name}: ${target.surface}; repoRules=${target.capabilities.repoRules}; pathRules=${target.capabilities.pathRules}; promptPack=${target.capabilities.promptPack}; localApi=${target.capabilities.localApi}; modelRuntime=${target.capabilities.modelRuntime}`)
  ].join("\n");
}

function formatAdapterPlan(result) {
  return [
    `codex-prep adapter-plan: ${result.repo.name}`,
    "",
    `Targets: ${result.targets.join(", ")}`,
    `Context profile: ${result.contextProfile}`,
    `Source fingerprint: ${result.sourceFingerprint}`,
    "Proposed writes:",
    ...result.files.map((file) => `- ${file.path} (${file.target}): ${file.reason}`),
    `- ${ADAPTERS_MANIFEST_PATH} (adapter-manifest): Tracks generated adapter files and source fingerprints.`
  ].join("\n");
}

function formatAdapterApply(result) {
  return [
    `codex-prep adapter-apply: ${result.repo.name}`,
    "",
    `Targets: ${result.targets.join(", ")}`,
    `Context profile: ${result.contextProfile}`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)} (${write.target || "adapter"})`)
  ].join("\n");
}

function formatPrepare(result) {
  return [
    `codex-prep prepare: ${result.repo.name}`,
    "",
    `Target: ${result.target}`,
    `Profile: ${result.profile}`,
    "Operations:",
    ...result.operations.map(formatOperationLine),
    "",
    `Next action: ${result.nextAction}`
  ].join("\n");
}

function formatRefresh(result) {
  const title = result.auto ? "codex-prep refresh --auto" : "codex-prep refresh";
  const lines = [
    `${title}: ${result.repo.name}`,
    "",
    result.auto ? "Applied operations:" : "Proposed operations:",
    ...(result.auto ? result.operations : result.proposed).map(formatOperationLine),
    "",
    `Next action: ${result.nextAction}`
  ];
  if (!result.auto && result.proposed.length > 0) {
    lines.push("", "Run codex-prep refresh --auto to apply these updates.");
  }
  return lines.join("\n");
}

function formatPreflight(result) {
  return [
    `codex-prep preflight: ${result.repo.name}`,
    "",
    `Branch: ${result.branch || "none"}`,
    `Graph source: ${result.graphSource}`,
    "Changed files:",
    ...formatList(result.dirtyFiles),
    "Likely related tests:",
    ...formatList(result.likelyTests),
    "Validation commands:",
    ...formatList(result.validationCommands.map((item) => `${item.command} (${item.source})`)),
    `Validation freshness: ${result.validationFreshness?.current ? "current" : "stale"} - ${result.validationFreshness?.reason || "unknown"}`,
    "Risk areas:",
    ...formatList(result.riskAreas.map((item) => `[${item.level}] ${item.code}: ${item.message}`)),
    "Next actions:",
    ...formatList(result.nextActions)
  ].join("\n");
}

function formatOperationLine(operation) {
  const writes = operation.writes ?? [];
  const changed = writes.filter((write) => write.changed).length;
  const suffix = writes.length > 0 ? ` (${changed}/${writes.length} changed)` : "";
  return `- ${operation.command}: ${operation.reason}${suffix}`;
}
function formatHandoff(result) {
  return [
    `codex-prep handoff: ${result.repo.name}`,
    "",
    `File: ${result.handoff.path}`,
    `Fingerprint: ${result.handoff.fingerprint || "unknown"}`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
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

function formatOrient(result) {
  return [
    `codex-prep orient: ${result.task}`,
    "",
    `Source: ${result.source}`,
    `Profile: ${result.profile || "standard"}`,
    `Context estimate: ${result.contextEstimate.selectedFiles}/${result.contextEstimate.totalGraphFiles} files, ${result.contextEstimate.estimatedSelectedTokens}/${result.contextEstimate.estimatedGraphTokens} est. tokens, ${result.contextEstimate.estimatedReductionPercent}% smaller than all indexed code`,
    "Reading list:",
    ...formatList(result.readingList.map((item) => `${item.path} [${item.confidence}] ${item.reasons.join("; ")}`)),
    "Related tests:",
    ...formatList(result.relatedTests.map((item) => `${item.path} [${item.confidence}] ${item.reason}`)),
    "Validation commands:",
    ...formatList(result.validationCommands.map((item) => `${item.command} (${item.source})`)),
    "Fallback searches:",
    ...formatList(result.fallbackSearches),
    "Warnings:",
    ...formatList(result.warnings)
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
      `Depth: ${result.limits?.depth ?? 1}`,
      `Limit: ${result.limits?.limit ?? "none"}`,
      "Imports:",
      ...formatList(result.imports.map((item) => item.resolved ? `${item.specifier} -> ${item.resolved}` : `${item.specifier} (${item.kind})`)),
      "Dependents:",
      ...formatList(result.dependents),
      "Neighbor files:",
      ...formatList((result.neighbors ?? []).map((item) => `${item.path} (${item.direction}, depth ${item.depth})`)),
      "Symbols:",
      ...formatList(result.symbols.map((item) => `${item.name} (${item.kind}${item.exported ? ", exported" : ""})`)),
      "Related tests:",
      ...formatList(result.relatedTests.map((item) => `${item.path} [${item.confidence}]`)),
      "Truncated:",
      ...formatTruncation(result.limits?.truncated)
    ].join("\n");
  }
  return [
    `codex-prep graph-query: ${result.query}`,
    "",
    `Source: ${result.source}`,
    `Limit: ${result.limits?.limit ?? "none"}`,
    "Matches:",
    ...formatList(result.matches.map((item) => `${item.name} (${item.kind}) in ${item.file} [${item.confidence}]`)),
    "Truncated:",
    ...formatTruncation(result.limits?.truncated)
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

function buildStatusResult(state) {
  const plan = state.plan.plan;
  return {
    repo: state.repo,
    plan: state.plan.exists ? {
      exists: true,
      source: state.plan.source,
      status: plan.status,
      goal: plan.goal || "",
      buildStatus: plan.build?.status || "not_started",
      branchName: plan.build?.branchName || ""
    } : { exists: false },
    git: {
      isGitRepo: state.git.isGitRepo,
      branchName: state.git.branchName,
      headCommit: state.git.headCommit,
      dirtyFiles: state.git.dirtyFiles,
      localStateFiles: state.git.localStateFiles
    },
    graph: {
      exists: state.graph.exists,
      stale: state.graph.stale,
      fingerprint: state.graph.fingerprint,
      savedFingerprint: state.graph.savedFingerprint,
      summary: state.graph.summary
    },
    generated: {
      dashboard: state.generated.dashboard,
      obsidian: state.generated.obsidian
    },
    adapters: state.adapters,
    handoff: state.handoff,
    validation: {
      exists: state.validation.exists,
      path: state.validation.path,
      count: state.validation.entries.length,
      latest: state.validation.latest,
      current: state.validation.current,
      stale: state.validation.stale,
      freshness: state.validation.freshness
    },
    doctor: state.doctor,
    nextAction: state.nextAction
  };
}

function formatStatus(result) {
  return [
    `codex-prep status: ${result.repo.name}`,
    "",
    `Branch: ${result.git.branchName || "none"}`,
    `Plan: ${result.plan.exists ? `${result.plan.status} / ${result.plan.buildStatus}` : "none"}`,
    `Plan branch: ${result.plan.branchName || "none"}`,
    `Dirty files: ${result.git.dirtyFiles.length}`,
    `Local state files: ${result.git.localStateFiles.length}`,
    `Graph: ${result.graph.exists ? (result.graph.stale ? "stale" : "fresh") : "missing"}`,
    `Dashboard: ${result.generated.dashboard.exists ? "present" : "missing"}`,
    `Obsidian index: ${result.generated.obsidian.exists ? (result.generated.obsidian.stale ? "stale" : "present") : "missing"}`,
    `Adapters: ${result.adapters.exists ? (result.adapters.stale ? "stale" : result.adapters.invalid ? "invalid" : `present (${result.adapters.targets.join(", ") || "none"})`) : "missing"}`,
    `Handoff: ${result.handoff.exists ? (result.handoff.stale ? "stale" : "present") : "missing"}`,
    `Latest validation: ${formatValidationStatusLine(result.validation)}`,
    `Doctor: ${result.doctor.ok ? "ok" : "needs attention"} (${result.doctor.findings.length} findings)`,
    "",
    `Next action: ${result.nextAction}`
  ].join("\n");
}

function formatValidationStatusLine(validation) {
  if (!validation.latest) {
    return "none recorded";
  }
  const freshness = validation.stale ? `stale: ${validation.freshness?.reason || "unknown"}` : "current";
  return `${validation.latest.result} ${validation.latest.command} (${freshness})`;
}
function formatDoctor(result) {
  return [
    `codex-prep doctor: ${result.ok ? "ok" : "needs attention"}`,
    "",
    "Findings:",
    ...formatFindings(result.findings),
    "",
    `Next action: ${result.nextAction}`
  ].join("\n");
}

function formatLocalIgnore(result) {
  if (!result.isGitRepo) {
    return [
      "codex-prep local-ignore: skipped",
      "",
      "No git repo was found, so no local ignore rules were installed.",
      "Entries:",
      ...formatList(result.entries)
    ].join("\n");
  }

  return [
    `codex-prep local-ignore: ${result.changed ? "updated" : "unchanged"}`,
    "",
    `File: ${result.path}`,
    "Entries:",
    ...formatList(result.entries),
    "Added:",
    ...formatList(result.added)
  ].join("\n");
}

function formatValidationRecord(result) {
  return [
    `codex-prep validation-record: ${result.entry.result}`,
    "",
    `Command: ${result.entry.command}`,
    `Phase: ${result.entry.phase}`,
    `Recorded: ${result.entry.recordedAt}`,
    `Summary: ${result.entry.summary}`,
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatPlanAttach(result) {
  return [
    "codex-prep plan-attach: in_progress",
    "",
    `Branch: ${result.branch.name}`,
    `Head: ${result.branch.headCommit.slice(0, 12)}`,
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

function formatTruncation(truncated = {}) {
  const active = Object.entries(truncated).filter(([, value]) => value).map(([key]) => key);
  return active.length > 0 ? active.map((key) => `- ${key}`) : ["- none"];
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
  buildStatusResult,
  buildPlanReviewResult,
  finalizeManifest,
  normalizePlan,
  runEvalScenarios,
  finalizeCodeGraph,
  safeTimestamp,
  suggestPlanBranch,
  updatePlanDocument
};
