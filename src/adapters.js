import crypto from "node:crypto";
import { buildManagedSection } from "./generate.js";

export const ADAPTERS_MANIFEST_PATH = ".codex-prep/adapters.json";
export const HANDOFF_PATH = "docs/AGENT_HANDOFF.md";
export const ADAPTER_TARGETS = Object.freeze(["claude-code", "cursor", "jan", "ollama", "generic"]);
export const CONTEXT_PROFILES = Object.freeze(["short", "standard", "deep"]);

const ADAPTER_CAPABILITIES = Object.freeze({
  "claude-code": {
    label: "Claude Code",
    surface: "repo memory and rules",
    capabilities: {
      repoRules: true,
      pathRules: true,
      promptPack: false,
      mcpReady: false,
      localApi: false,
      modelRuntime: false
    }
  },
  cursor: {
    label: "Cursor",
    surface: "project rules",
    capabilities: {
      repoRules: true,
      pathRules: true,
      promptPack: false,
      mcpReady: false,
      localApi: false,
      modelRuntime: false
    }
  },
  jan: {
    label: "Jan",
    surface: "local assistant prompt pack",
    capabilities: {
      repoRules: false,
      pathRules: false,
      promptPack: true,
      mcpReady: true,
      localApi: true,
      modelRuntime: true
    }
  },
  ollama: {
    label: "Ollama",
    surface: "local model prompt pack",
    capabilities: {
      repoRules: false,
      pathRules: false,
      promptPack: true,
      mcpReady: false,
      localApi: true,
      modelRuntime: true
    }
  },
  generic: {
    label: "Generic agent",
    surface: "portable markdown prompt pack",
    capabilities: {
      repoRules: false,
      pathRules: false,
      promptPack: true,
      mcpReady: false,
      localApi: false,
      modelRuntime: false
    }
  }
});

export function listAdapters() {
  return ADAPTER_TARGETS.map((name) => ({
    name,
    label: ADAPTER_CAPABILITIES[name].label,
    surface: ADAPTER_CAPABILITIES[name].surface,
    capabilities: ADAPTER_CAPABILITIES[name].capabilities
  }));
}

export function normalizeAdapterTargets(target = "all") {
  const raw = Array.isArray(target) ? target.join(",") : String(target || "all");
  const parts = raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const requested = parts.length > 0 ? parts : ["all"];
  if (requested.includes("all")) {
    return [...ADAPTER_TARGETS];
  }

  const unknown = requested.filter((item) => !ADAPTER_TARGETS.includes(item));
  if (unknown.length > 0) {
    throw new Error(`invalid adapter target "${unknown[0]}". Expected one of: all, ${ADAPTER_TARGETS.join(", ")}`);
  }
  return [...new Set(requested)];
}

export function validateContextProfile(profile = "standard") {
  const normalized = String(profile || "standard").trim().toLowerCase();
  if (!CONTEXT_PROFILES.includes(normalized)) {
    throw new Error(`invalid context profile "${profile}". Expected one of: ${CONTEXT_PROFILES.join(", ")}`);
  }
  return normalized;
}

export function buildAdapterBundle({ manifest, graph, state, target = "all", profile = "standard", previousManifest } = {}) {
  const targets = normalizeAdapterTargets(target);
  const contextProfile = validateContextProfile(profile);
  const files = targets.flatMap((name) => buildTargetFiles(name, manifest, graph, state, contextProfile));
  const sourceFingerprint = buildAdapterSourceFingerprint({ manifest, graph, contextProfile });
  const sameSource = previousManifest?.sourceFingerprint === sourceFingerprint &&
    previousManifest?.contextProfile === contextProfile &&
    sameList(previousManifest?.targets?.map((item) => item.name), targets);
  const generatedAt = sameSource && previousManifest?.generatedAt ? previousManifest.generatedAt : new Date().toISOString();

  return {
    targets,
    contextProfile,
    files,
    manifest: buildAdaptersManifest({ generatedAt, sourceFingerprint, contextProfile, targets, files })
  };
}

export function buildHandoffFile(manifest, graph, state) {
  const fingerprintValue = buildHandoffSourceFingerprint({ manifest, graph, state });
  return managedFile({
    path: HANDOFF_PATH,
    target: "handoff",
    reason: "Resume packet for a fresh agent after disconnects or context loss.",
    content: buildHandoffMarkdown(manifest, graph, state, fingerprintValue)
  });
}

export function buildAdapterSourceFingerprint({ manifest, graph, contextProfile = "standard" } = {}) {
  return fingerprint({
    schemaVersion: 1,
    kind: "adapter-source",
    contextProfile: validateContextProfile(contextProfile),
    repoName: manifest?.repo?.name ?? "",
    graphFingerprint: graph?.fingerprint ?? "",
    commands: (manifest?.discovery?.commands ?? []).map((command) => command.command),
    sourceRoots: manifest?.discovery?.sourceRoots ?? [],
    testRoots: manifest?.discovery?.testRoots ?? []
  });
}

export function buildHandoffSourceFingerprint({ manifest, graph, state } = {}) {
  const plan = state?.plan?.plan;
  const latestValidation = state?.validation?.latest;
  return fingerprint({
    schemaVersion: 1,
    kind: "handoff-source",
    repoName: manifest?.repo?.name ?? "",
    graphFingerprint: graph?.fingerprint ?? "",
    plan: plan ? {
      status: plan.status ?? "",
      goal: plan.goal ?? "",
      userIntent: plan.userIntent ?? "",
      targetAgent: plan.targetAgent ?? "",
      updatedAt: plan.updatedAt ?? "",
      build: {
        status: plan.build?.status ?? "",
        branchName: plan.build?.branchName ?? "",
        baseBranch: plan.build?.baseBranch ?? "",
        baseCommit: plan.build?.baseCommit ?? ""
      }
    } : undefined,
    git: {
      branchName: state?.git?.branchName ?? "",
      headCommit: state?.git?.headCommit ?? "",
      dirtyFiles: handoffDirtyFiles(state?.git?.dirtyFiles ?? []),
      localStateFiles: state?.git?.localStateFiles ?? []
    },
    validation: latestValidation ? {
      command: latestValidation.command ?? "",
      result: latestValidation.result ?? "",
      summary: latestValidation.summary ?? "",
      recordedAt: latestValidation.recordedAt ?? ""
    } : undefined,
    adapters: state?.adapters ? {
      exists: Boolean(state.adapters.exists),
      stale: Boolean(state.adapters.stale),
      sourceFingerprint: state.adapters.sourceFingerprint ?? "",
      targets: state.adapters.targets ?? []
    } : undefined
  });
}

function buildAdaptersManifest({ generatedAt, sourceFingerprint, contextProfile, targets, files }) {
  return {
    schemaVersion: 1,
    kind: "codex-prep-adapters",
    generatedAt,
    sourceFingerprint,
    contextProfile,
    targets: targets.map((name) => ({
      name,
      label: ADAPTER_CAPABILITIES[name].label,
      surface: ADAPTER_CAPABILITIES[name].surface,
      capabilities: ADAPTER_CAPABILITIES[name].capabilities,
      files: files.filter((file) => file.target === name).map((file) => file.path)
    })),
    generatedFiles: files.map((file) => ({
      path: file.path,
      target: file.target,
      managed: true,
      fingerprint: fingerprint(file.content)
    }))
  };
}

function buildTargetFiles(target, manifest, graph, state, profile) {
  if (target === "claude-code") {
    return buildClaudeFiles(manifest, graph, state, profile);
  }
  if (target === "cursor") {
    return buildCursorFiles(manifest, graph, state, profile);
  }
  if (target === "jan") {
    return buildJanFiles(manifest, graph, state, profile);
  }
  if (target === "ollama") {
    return buildOllamaFiles(manifest, graph, state, profile);
  }
  return buildGenericFiles(manifest, graph, state, profile);
}

function buildClaudeFiles(manifest, graph, state, profile) {
  const prompt = sharedPrompt(manifest, graph, state, profile);
  return [
    managedFile({
      path: "CLAUDE.md",
      target: "claude-code",
      reason: "Claude Code entrypoint that imports AGENTS.md and points at CodexManager state.",
      content: `# Claude Code Guidance

@AGENTS.md

## Claude-Specific Notes

${prompt}

Keep this file thin. AGENTS.md, docs/CODEBASE_MAP.md, docs/AGENT_HANDOFF.md, and CodexManager commands are the source of truth.`
    }),
    managedFile({
      path: ".claude/rules/codexmanager-workflow.md",
      target: "claude-code",
      reason: "Claude path-independent workflow reminder for CodexManager repos.",
      content: `---
description: Use CodexManager workflow state before broad repo work.
---

# CodexManager Workflow

- Read docs/AGENT_HANDOFF.md when reconnecting or entering an unfamiliar thread.
- Run codex-prep status before implementation work.
- Run codex-prep orient --task "<task>" before broad searches.
- Treat plan approval, branch creation, edits, commits, pushes, and destructive actions as separate permissions.
- Record useful validation with codex-prep validation-record.`
    })
  ];
}

function buildCursorFiles(manifest, graph, state, profile) {
  const prompt = sharedPrompt(manifest, graph, state, profile);
  return [
    managedFile({
      path: ".cursor/rules/codexmanager-workflow.mdc",
      target: "cursor",
      reason: "Always-on Cursor rule for CodexManager safety boundaries and lifecycle state.",
      content: `---
alwaysApply: true
description: Follow CodexManager approval boundaries and repo lifecycle state.
---

# CodexManager Workflow

- Run codex-prep status before implementation work.
- Treat plans, branch creation, file edits, commits, pushes, installs, migrations, deployments, and destructive actions as separate permissions.
- Use codex-prep doctor when plan, branch, graph, validation, adapter, or handoff state looks inconsistent.
- Prefer codex-prep preflight before commit or merge discussions.

${prompt}`
    }),
    managedFile({
      path: ".cursor/rules/graph-first-orientation.mdc",
      target: "cursor",
      reason: "Scoped Cursor rule that prefers graph-backed orientation for source work.",
      content: `---
alwaysApply: false
description: Use graph-first orientation when locating source files, symbols, imports, dependents, entrypoints, or related tests.
globs: "{src,lib,app,packages,bin}/**/*"
---

# Graph-First Orientation

- Start with codex-prep orient --task "<task>".
- Use --profile short for small fixes, standard for normal work, and deep for architecture or cross-cutting changes.
- Follow the returned reading list before opening unrelated files.
- Use codex-prep graph-query --file <path> for imports, dependents, symbols, and nearby tests.
- Use codex-prep graph-query --symbol <name> when the task starts from an identifier.`
    }),
    managedFile({
      path: ".cursor/rules/review-validation.mdc",
      target: "cursor",
      reason: "Scoped Cursor rule for tests, review, and validation memory.",
      content: `---
alwaysApply: false
description: Use CodexManager validation memory and repo rules when reviewing, testing, or finishing changes.
globs: "{test,tests,spec,e2e,src,lib,app,packages}/**/*"
---

# Review And Validation

- Lead reviews with bugs, regressions, missing tests, unsafe assumptions, and stale guidance.
- Run or name detected validation commands before claiming work is done.
- Record meaningful validation with codex-prep validation-record.
- Use codex-prep preflight to connect changed files, likely tests, stale generated state, and validation freshness.`
    }),
    managedFile({
      path: ".cursor/rules/generated-state.mdc",
      target: "cursor",
      reason: "Scoped Cursor rule for CodexManager generated docs and state artifacts.",
      content: `---
alwaysApply: false
description: Keep CodexManager generated state reviewable and refreshed when docs or generated artifacts change.
globs: "{docs,.codex-prep,.agents,.cursor,.claude}/**/*"
---

# Generated State

- Generated docs, adapter files, graph export, and handoff are projections of repo evidence.
- Preview stale updates with codex-prep refresh.
- Apply stale updates with codex-prep refresh --auto only when file changes are authorized.
- Do not hand-edit managed sections unless the user explicitly asks for that local change.`
    })
  ];
}

function buildJanFiles(manifest, graph, state, profile) {
  const prompt = sharedPrompt(manifest, graph, state, profile);
  return [
    managedFile({
      path: "docs/agent-adapters/jan/README.md",
      target: "jan",
      reason: "Jan setup notes for using CodexManager as a local assistant context pack.",
      content: `# Jan Adapter Pack

Use this folder as a local assistant context pack for Jan or a Jan-backed coding shell.

- Start with docs/agent-adapters/jan/system-prompt.md as assistant instructions.
- Attach AGENTS.md, docs/AGENT_HANDOFF.md, and docs/CODEBASE_MAP.md when the app supports files.
- Prefer a shell or agent wrapper that can run codex-prep status, orient, graph-query, doctor, and validation-record.
- Do not treat Jan runtime access as permission to edit, commit, push, install dependencies, deploy, or run destructive actions.`
    }),
    managedFile({
      path: "docs/agent-adapters/jan/system-prompt.md",
      target: "jan",
      reason: "Portable system prompt for Jan local assistants.",
      content: `# Jan System Prompt

You are working in a repository prepared by CodexManager.

${prompt}

If you cannot run local commands from Jan, ask the user to run the listed codex-prep commands and paste the output. Do not guess repository state.`
    })
  ];
}

function buildOllamaFiles(manifest, graph, state, profile) {
  const prompt = sharedPrompt(manifest, graph, state, profile);
  const systemPrompt = `You are working in a repository prepared by CodexManager.\n\n${prompt}\n\nUse local evidence. Do not claim tests passed unless validation was actually run.`;
  return [
    managedFile({
      path: "docs/agent-adapters/ollama/system-prompt.md",
      target: "ollama",
      reason: "Portable system prompt for Ollama-backed coding shells.",
      content: `# Ollama System Prompt

${systemPrompt}`
    }),
    managedFile({
      path: "docs/agent-adapters/ollama/Modelfile",
      target: "ollama",
      reason: "Template Modelfile for local Ollama experiments.",
      content: `# Template only. Replace llama3.1 with the local model you want to use.
FROM llama3.1

SYSTEM """${systemPrompt.replace(/"""/g, "'''")}"""`
    })
  ];
}

function buildGenericFiles(manifest, graph, state, profile) {
  const prompt = sharedPrompt(manifest, graph, state, profile);
  return [
    managedFile({
      path: "docs/agent-adapters/generic/README.md",
      target: "generic",
      reason: "Portable instructions for agent tools without native repo-rule support.",
      content: `# Generic Agent Adapter

Use this folder for any agent, local model app, chat UI, or coding wrapper that can consume Markdown context.

- Paste or attach docs/agent-adapters/generic/system-prompt.md as the system or developer prompt.
- Attach AGENTS.md, docs/AGENT_HANDOFF.md, and docs/CODEBASE_MAP.md when file context is available.
- Prefer codex-prep orient over broad file dumps to reduce context usage.`
    }),
    managedFile({
      path: "docs/agent-adapters/generic/system-prompt.md",
      target: "generic",
      reason: "Portable system prompt for non-native agent surfaces.",
      content: `# Generic Agent System Prompt

${prompt}`
    })
  ];
}

function sharedPrompt(manifest, graph, state, profile) {
  const repoName = manifest?.repo?.name ?? "this repo";
  const commands = manifest?.discovery?.commands ?? [];
  const graphSummary = graph?.summary ?? {};
  const handoffPath = `${HANDOFF_PATH} (refresh with codex-prep handoff)`;
  const profileNotes = contextProfileNotes(profile, manifest, graph);

  return [
    `- Repo: ${repoName}`,
    `- Context profile: ${profile}`,
    `- First read: AGENTS.md, then ${handoffPath}, then docs/CODEBASE_MAP.md.`,
    "- First command for live state: codex-prep status.",
    "- First command for new repo setup: codex-prep prepare --target all.",
    "- First command for locating files: codex-prep orient --task \"<task>\".",
    "- Focused follow-up: codex-prep graph-query --file <path> or --symbol <name>.",
    "- Troubleshooting command: codex-prep doctor.",
    "- Stale generated-state preview: codex-prep refresh.",
    "- Authorized stale generated-state update: codex-prep refresh --auto.",
    "- Pre-commit/pre-merge readiness check: codex-prep preflight.",
    "- Validation memory command: codex-prep validation-record --validation-command \"<command>\" --result <pass|fail> --summary \"<summary>\".",
    "- Editing, committing, pushing, dependency installs, migrations, deployments, and destructive actions require separate explicit approval.",
    `- Detected validation commands: ${commands.length > 0 ? commands.map((command) => command.command).join("; ") : "none detected"}.`,
    `- Graph summary: ${graphSummary.fileCount ?? "unknown"} files, ${graphSummary.edgeCount ?? "unknown"} import edges, ${graphSummary.symbolCount ?? "unknown"} symbols.`,
    ...profileNotes
  ].join("\n");
}

function contextProfileNotes(profile, manifest, graph) {
  if (profile === "short") {
    return [
      "- Keep context tight: use status, handoff, and orient output before opening files."
    ];
  }
  if (profile === "deep") {
    return [
      `- Source roots: ${listOrNone(manifest?.discovery?.sourceRoots)}`,
      `- Test roots: ${listOrNone(manifest?.discovery?.testRoots)}`,
      `- Entrypoints: ${listOrNone(manifest?.discovery?.entrypoints)}`,
      `- Graph languages: ${listOrNone(graph?.summary?.languages)}`,
      "- For architecture work, inspect docs/CODEBASE_MAP.md and then query the graph before reading full source trees."
    ];
  }
  return [
    `- Source roots: ${listOrNone(manifest?.discovery?.sourceRoots)}`,
    `- Test roots: ${listOrNone(manifest?.discovery?.testRoots)}`,
    "- Keep large file reads behind an orient or graph-query result."
  ];
}

function buildHandoffMarkdown(manifest, graph, state, fingerprintValue) {
  const plan = state?.plan?.plan;
  const validation = state?.validation?.latest;
  const adapters = state?.adapters;
  const dirtyFiles = handoffDirtyFiles(state?.git?.dirtyFiles ?? []);
  return `# Agent Handoff

Handoff fingerprint: ${fingerprintValue}

This file is a reconnect packet for a fresh agent. It is status, not authorization to edit, commit, push, merge, deploy, install dependencies, or run destructive commands.

## Current State

- Repo: ${inline(manifest?.repo?.name ?? "unknown")}
- Branch: ${inline(state?.git?.branchName || "unknown")}
- Head commit: ${inline(shortSha(state?.git?.headCommit) || "unknown")}
- Dirty files: ${inline(dirtyFiles.length)}
- Local CodexManager state files: ${inline((state?.git?.localStateFiles ?? []).length)}
- Active plan: ${inline(plan ? `${plan.status} / ${plan.build?.status ?? "not_started"}` : "none")}
- Plan goal: ${inline(plan?.goal || plan?.userIntent || "none")}
- Plan branch: ${inline(plan?.build?.branchName || "none")}
- Target agent: ${inline(plan?.targetAgent || "none")}
- Graph: ${inline(graph?.fingerprint ? `${graph.summary?.fileCount ?? 0} files, ${graph.summary?.edgeCount ?? 0} edges` : "not generated")}
- Adapters: ${inline(adapterSummary(adapters))}
- Latest validation: ${inline(validation ? `${validation.result} ${validation.command}` : "none recorded")}
- Next action: ${inline(state?.nextAction || "Run codex-prep status")}

## Resume Steps

1. Read AGENTS.md for permissions and repo rules.
2. Run codex-prep status to refresh live branch, plan, graph, adapter, handoff, and validation state.
3. Run codex-prep orient --task "<task>" before broad file searching.
4. Use codex-prep graph-query for focused file, symbol, dependent, or related-test lookups.
5. Run codex-prep doctor if any state looks inconsistent.
6. Run validation before claiming completion, then record meaningful results with codex-prep validation-record.

## Known Boundaries

- Plans are memory, not permission.
- Build approval, branch creation, file edits, commits, pushes, dependency installs, migrations, deployments, and destructive actions are separate permissions.
- Do not copy secrets into generated docs, plans, adapter files, or handoff notes.
`;
}

function managedFile({ path, target, reason, content }) {
  return {
    path,
    target,
    mode: "managed-section",
    reason,
    content: buildManagedSection(content)
  };
}

function adapterSummary(adapters) {
  if (!adapters?.exists) {
    return "missing";
  }
  if (adapters.invalid) {
    return "invalid";
  }
  const status = adapters.stale ? "stale" : "fresh";
  const targets = adapters.targets?.length ? adapters.targets.join(", ") : "none";
  return `${status}: ${targets}`;
}


function handoffDirtyFiles(dirtyFiles = []) {
  return dirtyFiles.filter((file) => file !== HANDOFF_PATH);
}
function listOrNone(values = []) {
  return values.length > 0 ? values.join(", ") : "none detected";
}

function inline(value) {
  return "`" + String(value).replace(/`/g, "'") + "`";
}

function shortSha(value) {
  return value ? String(value).slice(0, 12) : "";
}

function sameList(left = [], right = []) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function fingerprint(value) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export const internals = {
  ADAPTER_CAPABILITIES,
  contextProfileNotes,
  fingerprint,
  sharedPrompt
};
