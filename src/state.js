import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ADAPTERS_MANIFEST_PATH, HANDOFF_PATH, buildAdapterSourceFingerprint, buildHandoffSourceFingerprint } from "./adapters.js";
import { CODEGRAPH_PATH, buildCodeGraph, readCodeGraphIfExists } from "./codegraph.js";
import { DASHBOARD_PATH, MANAGED_FILES } from "./generate.js";
import { OBSIDIAN_EXPORT_DIR } from "./obsidian-export.js";
import { fileExists, readJsonIfExists } from "./fs-utils.js";
import { scanRepo } from "./scan.js";

const execFileAsync = promisify(execFile);

export const VALIDATION_RESULTS_PATH = ".codex-prep/validation-results.jsonl";
export const PLAN_HISTORY_DIR = ".codex-prep/plans";
export const LATEST_PLAN_PATH = `${PLAN_HISTORY_DIR}/latest-plan.json`;
export const ACTIVE_PLAN_PATH = `${PLAN_HISTORY_DIR}/active-plan.json`;
export const LOCAL_GIT_EXCLUDE_PATH = ".git/info/exclude";
export const LOCAL_STATE_IGNORE_PATTERNS = Object.freeze([
  `${PLAN_HISTORY_DIR}/`,
  VALIDATION_RESULTS_PATH
]);

const MANIFEST_PATH = ".codex-prep/manifest.json";
const OBSIDIAN_INDEX_PATH = `${OBSIDIAN_EXPORT_DIR}/Index.md`;
const TERMINAL_PLAN_STATUSES = new Set(["implemented", "superseded", "rejected"]);

export async function buildControlState(root, options = {}) {
  const savedManifest = options.savedManifest ?? await readJsonIfExists(path.join(root, MANIFEST_PATH));
  const manifest = options.manifest ?? await scanRepo(root, { previousManifest: savedManifest });
  const liveGraph = options.graph ?? await buildCodeGraph(root, { manifest });
  const savedGraphState = await readSavedGraphState(root, options.graph);
  const planState = await readActivePlanState(root);
  const git = await readGitState(root);
  const validationMemory = await readValidationMemory(root);
  const validation = buildValidationState(validationMemory, git);
  const adapters = await readAdapterState(root, manifest, liveGraph);
  const handoff = await readHandoffState(root, manifest, liveGraph, { plan: planState, git, validation, adapters });
  const generated = await readGeneratedState(root, manifest, liveGraph, savedGraphState);

  const state = {
    repo: manifest.repo,
    manifest: {
      exists: Boolean(savedManifest),
      path: MANIFEST_PATH,
      fingerprint: manifest.fingerprint,
      savedFingerprint: savedManifest?.fingerprint ?? "",
      stale: Boolean(savedManifest && savedManifest.fingerprint !== manifest.fingerprint)
    },
    plan: planState,
    git,
    graph: {
      exists: savedGraphState.exists,
      path: CODEGRAPH_PATH,
      fingerprint: liveGraph.fingerprint,
      savedFingerprint: savedGraphState.graph?.fingerprint ?? "",
      generatedAt: savedGraphState.graph?.generatedAt ?? liveGraph.generatedAt ?? "",
      summary: liveGraph.summary ?? {},
      stale: Boolean(savedGraphState.exists && savedGraphState.graph && savedGraphState.graph.fingerprint !== liveGraph.fingerprint),
      invalid: Boolean(savedGraphState.exists && savedGraphState.error),
      error: savedGraphState.error ?? ""
    },
    generated,
    adapters,
    handoff,
    validation,
    commands: manifest.discovery?.commands ?? []
  };

  state.doctor = buildDoctorResult(state);
  state.nextAction = selectNextAction(state);
  return state;
}

export async function readGitState(root) {
  if (!(await resolveGitDir(root))) {
    return {
      isGitRepo: false,
      branchName: "",
      headCommit: "",
      dirtyFiles: [],
      localStateFiles: [],
      rawStatus: ""
    };
  }

  try {
    const branchName = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
    const headCommit = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const rawStatus = (await runGit(root, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    const lines = rawStatus ? rawStatus.split(/\r?\n/).filter(Boolean) : [];
    const localStateFiles = lines.filter(isLocalStateStatusLine).map(statusLinePath);
    const dirtyFiles = lines.filter((line) => !isLocalStateStatusLine(line)).map(statusLinePath);

    return {
      isGitRepo: true,
      branchName,
      headCommit,
      dirtyFiles,
      localStateFiles,
      rawStatus
    };
  } catch (error) {
    return {
      isGitRepo: false,
      branchName: "",
      headCommit: "",
      dirtyFiles: [],
      localStateFiles: [],
      rawStatus: "",
      error: error.message
    };
  }
}

export async function readValidationMemory(root) {
  const absolutePath = path.join(root, VALIDATION_RESULTS_PATH);
  if (!(await fileExists(absolutePath))) {
    return { exists: false, path: VALIDATION_RESULTS_PATH, entries: [], latest: undefined, invalidLines: 0 };
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const entries = [];
  let invalidLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }

  return {
    exists: true,
    path: VALIDATION_RESULTS_PATH,
    entries,
    latest: entries.at(-1),
    invalidLines
  };
}

export function buildValidationState(memory, git = {}) {
  const latest = memory.latest;
  const freshness = validationFreshness(latest, git);
  return {
    ...memory,
    current: freshness.current,
    stale: !freshness.current,
    freshness
  };
}

function validationFreshness(latest, git = {}) {
  if (!latest) {
    return { current: false, reason: "No validation result recorded." };
  }
  if (latest.result !== "pass") {
    return { current: false, reason: "Latest validation did not pass." };
  }
  const dirtyFiles = sortStrings(git.dirtyFiles ?? []);
  const recordedDirtyFiles = sortStrings(latest.git?.dirtyFiles ?? []);
  if (dirtyFiles.length > 0 && !sameStringList(dirtyFiles, recordedDirtyFiles)) {
    return { current: false, reason: "Working tree changed since the latest validation was recorded." };
  }
  if (git.isGitRepo && !latest.git?.headCommit) {
    return { current: false, reason: "Latest validation does not include commit metadata." };
  }
  if (git.headCommit && latest.git?.headCommit && latest.git.headCommit !== git.headCommit) {
    return { current: false, reason: "Latest validation was recorded on a different commit." };
  }
  if (git.branchName && latest.git?.branchName && latest.git.branchName !== git.branchName) {
    return { current: false, reason: "Latest validation was recorded on a different branch." };
  }
  return { current: true, reason: "Latest validation matches the current branch and commit." };
}

export async function appendValidationResult(root, entry) {
  await ensureLocalStateIgnored(root);
  const absolutePath = path.join(root, VALIDATION_RESULTS_PATH);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.appendFile(absolutePath, `${JSON.stringify(entry)}\n`, "utf8");
  return { path: VALIDATION_RESULTS_PATH, changed: true, mode: "local-jsonl" };
}

export async function ensureLocalStateIgnored(root) {
  const gitDir = await resolveGitDir(root);
  const result = {
    isGitRepo: Boolean(gitDir),
    path: LOCAL_GIT_EXCLUDE_PATH,
    changed: false,
    entries: [...LOCAL_STATE_IGNORE_PATTERNS],
    added: []
  };

  if (!gitDir) {
    return result;
  }

  const excludePath = path.join(gitDir, "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });

  let content = "";
  try {
    content = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const existing = new Set(
    content
      .split(/\r?\n/)
      .map(normalizeIgnoreLine)
      .filter(Boolean)
  );
  const missing = LOCAL_STATE_IGNORE_PATTERNS.filter((entry) => !existing.has(entry));

  if (missing.length > 0) {
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    await fs.appendFile(excludePath, `${prefix}${missing.join("\n")}\n`, "utf8");
  }

  return {
    ...result,
    changed: missing.length > 0,
    added: missing
  };
}

export function buildDoctorResult(state) {
  const findings = [];
  const add = (level, code, message, fix, file = "") => findings.push({ level, code, message, fix, file });

  const terminalPlan = state.plan.exists && isTerminalPlan(state.plan.plan);
  const adapters = state.adapters ?? { exists: false, invalid: false, stale: false, generatedFiles: [] };
  const handoff = state.handoff ?? { exists: false, stale: false };

  if (!state.plan.exists) {
    add("warn", "CM001", "No active saved plan was found.", "Run codex-prep plan before implementation work.", ACTIVE_PLAN_PATH);
  }
  if (!terminalPlan && state.plan.exists && state.plan.plan?.status === "approved" && state.plan.plan?.build?.status !== "in_progress") {
    add("warn", "CM002", "Plan is approved but implementation has not been started.", "Run codex-prep plan-start --branch <name> or plan-attach after explicit approval.", ACTIVE_PLAN_PATH);
  }
  if (!terminalPlan && state.plan.exists && state.plan.plan?.build?.branchName && state.git.isGitRepo && state.git.branchName && state.plan.plan.build.branchName !== state.git.branchName) {
    add("error", "CM003", "Current branch does not match the active plan branch.", `Switch to ${state.plan.plan.build.branchName} or attach the plan to the current branch deliberately.`, ACTIVE_PLAN_PATH);
  }
  if (state.git.dirtyFiles.length > 0) {
    add("warn", "CM004", `${state.git.dirtyFiles.length} working-tree file(s) have uncommitted changes.`, "Review changes before validation, commit, or branch operations.");
  }
  if (!state.manifest.exists) {
    add("warn", "CM005", ".codex-prep/manifest.json is missing.", "Run codex-prep apply.", MANIFEST_PATH);
  } else if (state.manifest.stale) {
    add("warn", "CM006", ".codex-prep/manifest.json may be stale.", "Run codex-prep apply or codex-prep refresh-map.", MANIFEST_PATH);
  }
  if (!state.graph.exists) {
    add("warn", "CM007", ".codex-prep/codegraph.json is missing.", "Run codex-prep refresh-graph.", CODEGRAPH_PATH);
  } else if (state.graph.invalid) {
    add("error", "CM008", ".codex-prep/codegraph.json could not be parsed.", "Regenerate it with codex-prep refresh-graph.", CODEGRAPH_PATH);
  } else if (state.graph.stale) {
    add("warn", "CM009", ".codex-prep/codegraph.json is stale.", "Run codex-prep refresh-graph.", CODEGRAPH_PATH);
  }
  for (const file of state.generated.files) {
    if (!file.exists) {
      add("warn", "CM010", `${file.path} is missing.`, "Run codex-prep apply.", file.path);
    }
  }
  if (!state.generated.dashboard.exists) {
    add("warn", "CM011", "The CodexManager dashboard is missing.", "Run codex-prep apply.", DASHBOARD_PATH);
  }
  if (!state.generated.obsidian.exists) {
    add("warn", "CM012", "The Obsidian workflow index is missing.", "Run codex-prep graph-export --format obsidian.", OBSIDIAN_INDEX_PATH);
  } else if (state.generated.obsidian.stale) {
    add("warn", "CM013", "The Obsidian workflow index does not match the current graph fingerprint.", "Run codex-prep graph-export --format obsidian.", OBSIDIAN_INDEX_PATH);
  }
  if (!state.validation.exists || !state.validation.latest) {
    add("warn", "CM014", "No validation result has been recorded.", "After running validation, record it with codex-prep validation-record.", VALIDATION_RESULTS_PATH);
  } else if (state.validation.latest.result === "fail") {
    add("error", "CM015", "The latest recorded validation failed.", "Fix the failure, rerun validation, and record the new result.", VALIDATION_RESULTS_PATH);
  } else if (state.validation.stale) {
    add("warn", "CM023", `The latest recorded validation is not current: ${state.validation.freshness?.reason || "unknown reason"}`, "Rerun validation for the current tree and record the result.", VALIDATION_RESULTS_PATH);
  }
  if (!state.commands.some((command) => command.name === "verify" || command.command.includes("verify"))) {
    add("warn", "CM016", "No verify command was detected.", "Document a repo verification command or use the detected test/lint commands.");
  }
  if (!adapters.exists) {
    // Adapter output is opt-in; missing adapters are not a workflow problem.
  } else if (adapters.invalid) {
    add("error", "CM018", ".codex-prep/adapters.json could not be parsed.", "Regenerate it with codex-prep adapter-apply --target all.", ADAPTERS_MANIFEST_PATH);
  } else if (adapters.stale) {
    add("warn", "CM019", "Multi-agent adapter output is stale.", "Run codex-prep adapter-apply --target all.", ADAPTERS_MANIFEST_PATH);
  } else {
    for (const file of adapters.generatedFiles.filter((item) => !item.exists)) {
      add("warn", "CM020", `${file.path} is missing from adapter output.`, "Run codex-prep adapter-apply --target all.", file.path);
    }
  }
  if (!handoff.exists) {
    add("warn", "CM021", "The agent handoff file is missing.", "Run codex-prep handoff.", HANDOFF_PATH);
  } else if (handoff.stale) {
    add("warn", "CM022", "The agent handoff file is stale.", "Run codex-prep handoff.", HANDOFF_PATH);
  }

  return {
    ok: !findings.some((finding) => finding.level === "error"),
    findings
  };
}

export function selectNextAction(state) {
  if (!state.plan.exists) {
    return "Create a saved plan with codex-prep plan.";
  }

  const plan = state.plan.plan;
  const terminalPlan = isTerminalPlan(plan);
  const adapters = state.adapters ?? { exists: false, invalid: false, stale: false };
  const handoff = state.handoff ?? { exists: false, stale: false };

  if (!terminalPlan && plan?.build?.status === "approved") {
    return "Start the implementation branch with codex-prep plan-start --branch <name>.";
  }
  if (!terminalPlan && plan?.build?.branchName && state.git.branchName && plan.build.branchName !== state.git.branchName) {
    return `Switch to ${plan.build.branchName} or run codex-prep plan-attach intentionally.`;
  }
  if (terminalPlan) {
    return "No active implementation work remains; create a new plan for new work.";
  }
  if (!state.graph.exists || state.graph.stale) {
    return "Refresh the local code graph with codex-prep refresh-graph.";
  }
  if (!state.generated.dashboard.exists) {
    return "Refresh generated guidance and dashboard with codex-prep apply.";
  }
  if (adapters.exists && (adapters.invalid || adapters.stale)) {
    return "Refresh multi-agent adapters with codex-prep adapter-apply --target all.";
  }
  if (!handoff.exists || handoff.stale) {
    return "Refresh the agent handoff with codex-prep handoff.";
  }
  if (!state.validation.latest) {
    return "Run validation, then record the outcome with codex-prep validation-record.";
  }
  if (state.validation.latest.result === "fail") {
    return "Fix the failed validation and record a passing validation result.";
  }
  if (state.validation.stale) {
    return "Rerun validation for the current tree, then record it with codex-prep validation-record.";
  }
  return "Continue the approved scope, then run validation and close the plan when done.";
}

function sortStrings(values = []) {
  return [...values].sort();
}

function sameStringList(left = [], right = []) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function isTerminalPlan(plan) {
  return TERMINAL_PLAN_STATUSES.has(plan?.status);
}

async function readActivePlanState(root) {
  const active = await readJsonIfExists(path.join(root, ACTIVE_PLAN_PATH));
  if (active) {
    return { exists: true, source: ACTIVE_PLAN_PATH, plan: active };
  }

  const latest = await readJsonIfExists(path.join(root, LATEST_PLAN_PATH));
  if (latest) {
    return { exists: true, source: LATEST_PLAN_PATH, plan: latest };
  }

  return { exists: false, source: "", plan: undefined };
}

async function readSavedGraphState(root, overrideGraph) {
  if (overrideGraph) {
    return { exists: true, graph: overrideGraph };
  }

  try {
    const graph = await readCodeGraphIfExists(root);
    return graph ? { exists: true, graph } : { exists: false, graph: undefined };
  } catch (error) {
    return { exists: true, graph: undefined, error: error.message };
  }
}


async function readAdapterState(root, manifest, liveGraph) {
  const absolutePath = path.join(root, ADAPTERS_MANIFEST_PATH);
  if (!(await fileExists(absolutePath))) {
    return {
      exists: false,
      path: ADAPTERS_MANIFEST_PATH,
      targets: [],
      generatedFiles: [],
      sourceFingerprint: "",
      expectedSourceFingerprint: "",
      contextProfile: "",
      stale: false,
      invalid: false,
      error: ""
    };
  }

  let adapterManifest;
  try {
    adapterManifest = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    return {
      exists: true,
      path: ADAPTERS_MANIFEST_PATH,
      targets: [],
      generatedFiles: [],
      sourceFingerprint: "",
      expectedSourceFingerprint: "",
      contextProfile: "",
      stale: false,
      invalid: true,
      error: error.message
    };
  }

  const contextProfile = adapterManifest.contextProfile || "standard";
  let expectedSourceFingerprint = "";
  let invalid = false;
  let error = "";
  try {
    expectedSourceFingerprint = buildAdapterSourceFingerprint({ manifest, graph: liveGraph, contextProfile });
  } catch (fingerprintError) {
    invalid = true;
    error = fingerprintError.message;
  }

  const generatedFiles = [];
  for (const file of adapterManifest.generatedFiles ?? []) {
    generatedFiles.push({
      ...file,
      exists: await fileExists(path.join(root, file.path))
    });
  }

  return {
    exists: true,
    path: ADAPTERS_MANIFEST_PATH,
    targets: (adapterManifest.targets ?? []).map((target) => target.name).filter(Boolean),
    generatedFiles,
    sourceFingerprint: adapterManifest.sourceFingerprint ?? "",
    expectedSourceFingerprint,
    contextProfile,
    stale: Boolean(expectedSourceFingerprint && adapterManifest.sourceFingerprint !== expectedSourceFingerprint),
    invalid,
    error
  };
}

async function readHandoffState(root, manifest, liveGraph, stateParts) {
  const expectedFingerprint = buildHandoffSourceFingerprint({ manifest, graph: liveGraph, state: stateParts });
  const absolutePath = path.join(root, HANDOFF_PATH);
  if (!(await fileExists(absolutePath))) {
    return {
      exists: false,
      path: HANDOFF_PATH,
      fingerprint: "",
      expectedFingerprint,
      stale: false
    };
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const match = content.match(/Handoff fingerprint: ([^\r\n]+)/);
  const fingerprint = match?.[1]?.trim() ?? "";
  return {
    exists: true,
    path: HANDOFF_PATH,
    fingerprint,
    expectedFingerprint,
    stale: fingerprint !== expectedFingerprint
  };
}
async function readGeneratedState(root, manifest, liveGraph, savedGraphState) {
  const files = [];
  for (const filePath of MANAGED_FILES) {
    files.push({ path: filePath, exists: await fileExists(path.join(root, filePath)) });
  }

  const dashboardExists = await fileExists(path.join(root, DASHBOARD_PATH));
  const obsidianPath = path.join(root, OBSIDIAN_INDEX_PATH);
  const obsidianExists = await fileExists(obsidianPath);
  let obsidianFingerprint = "";
  if (obsidianExists) {
    const content = await fs.readFile(obsidianPath, "utf8");
    const match = content.match(/Graph fingerprint: ([^\r\n]+)/);
    obsidianFingerprint = match?.[1]?.trim() ?? "";
  }

  return {
    files,
    dashboard: { path: DASHBOARD_PATH, exists: dashboardExists },
    obsidian: {
      path: OBSIDIAN_INDEX_PATH,
      exists: obsidianExists,
      fingerprint: obsidianFingerprint,
      stale: Boolean(obsidianExists && liveGraph.fingerprint && obsidianFingerprint !== liveGraph.fingerprint)
    },
    manifestGeneratedFiles: (manifest.generatedFiles ?? []).map((item) => item.path),
    graphSavedAt: savedGraphState.graph?.generatedAt ?? ""
  };
}

async function runGit(root, args) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return { stdout, stderr };
}

async function resolveGitDir(root) {
  const dotGit = path.join(root, ".git");
  let stat;
  try {
    stat = await fs.lstat(dotGit);
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (stat.isDirectory()) {
    return dotGit;
  }
  if (!stat.isFile()) {
    return undefined;
  }

  const content = await fs.readFile(dotGit, "utf8");
  const match = content.match(/^gitdir:\s*(.+)\s*$/im);
  if (!match) {
    return undefined;
  }
  return path.resolve(root, match[1].trim());
}

function normalizeIgnoreLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return "";
  }
  return trimmed.replace(/\\/g, "/");
}

function isLocalStateStatusLine(line) {
  const file = statusLinePath(line);
  return file.startsWith(`${PLAN_HISTORY_DIR}/`) || file === VALIDATION_RESULTS_PATH;
}

function statusLinePath(line) {
  const pathPart = line.length > 2 && line[2] === " " ? line.slice(3) : line.slice(2).trimStart();
  const raw = pathPart.replace(/\\/g, "/");
  const renameMarker = " -> ";
  return raw.includes(renameMarker) ? raw.split(renameMarker).at(-1) : raw;
}
