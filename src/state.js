import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
  const validation = await readValidationMemory(root);
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
    validation,
    commands: manifest.discovery?.commands ?? []
  };

  state.doctor = buildDoctorResult(state);
  state.nextAction = selectNextAction(state);
  return state;
}

export async function readGitState(root) {
  const gitDir = path.join(root, ".git");
  if (!(await fileExists(gitDir))) {
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

export async function appendValidationResult(root, entry) {
  const absolutePath = path.join(root, VALIDATION_RESULTS_PATH);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.appendFile(absolutePath, `${JSON.stringify(entry)}\n`, "utf8");
  return { path: VALIDATION_RESULTS_PATH, changed: true, mode: "local-jsonl" };
}

export function buildDoctorResult(state) {
  const findings = [];
  const add = (level, code, message, fix, file = "") => findings.push({ level, code, message, fix, file });

  const terminalPlan = state.plan.exists && isTerminalPlan(state.plan.plan);

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
  }
  if (!state.commands.some((command) => command.name === "verify" || command.command.includes("verify"))) {
    add("warn", "CM016", "No verify command was detected.", "Document a repo verification command or use the detected test/lint commands.");
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

  if (!terminalPlan && plan?.build?.status === "approved") {
    return "Start the implementation branch with codex-prep plan-start --branch <name>.";
  }
  if (!terminalPlan && plan?.build?.branchName && state.git.branchName && plan.build.branchName !== state.git.branchName) {
    return `Switch to ${plan.build.branchName} or run codex-prep plan-attach intentionally.`;
  }
  if (!state.graph.exists || state.graph.stale) {
    return "Refresh the local code graph with codex-prep refresh-graph.";
  }
  if (!state.generated.dashboard.exists) {
    return "Refresh generated guidance and dashboard with codex-prep apply.";
  }
  if (!state.validation.latest) {
    return "Run validation, then record the outcome with codex-prep validation-record.";
  }
  if (state.validation.latest.result === "fail") {
    return "Fix the failed validation and record a passing validation result.";
  }
  if (terminalPlan) {
    return "No active implementation work remains; create a new plan for new work.";
  }
  return "Continue the approved scope, then run validation and close the plan when done.";
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
