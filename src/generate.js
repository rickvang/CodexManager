import { MANAGED_BEGIN, MANAGED_END } from "./fs-utils.js";

export const DASHBOARD_PATH = "docs/codexmanager-dashboard.md";

export const MANAGED_FILES = [
  "AGENTS.md",
  "docs/CODEBASE_MAP.md",
  "docs/CODEX_FEEDBACK.md",
  DASHBOARD_PATH,
  ".agents/skills/repo-onboarding/SKILL.md",
  ".agents/skills/code-review/SKILL.md"
];

export function buildBundle(manifest, { graph, state } = {}) {
  return {
    files: [
      {
        path: "AGENTS.md",
        mode: "managed-section",
        reason: "Durable Codex working agreements and repo-specific validation guidance.",
        content: buildManagedSection(buildAgents(manifest, graph))
      },
      {
        path: "docs/CODEBASE_MAP.md",
        mode: "managed-section",
        reason: "Reviewable map of repo shape, entrypoints, commands, and boundaries.",
        content: buildManagedSection(buildCodebaseMap(manifest, graph))
      },
      {
        path: "docs/CODEX_FEEDBACK.md",
        mode: "managed-section",
        reason: "Learning-loop ledger for repeated mistakes, corrections, and promoted guidance.",
        content: buildManagedSection(buildFeedback())
      },
      {
        path: DASHBOARD_PATH,
        mode: "managed-section",
        reason: "Single-page CodexManager workflow status, validation memory, and next-action dashboard.",
        content: buildManagedSection(buildDashboard(manifest, graph, state))
      },
      {
        path: ".agents/skills/repo-onboarding/SKILL.md",
        mode: "managed-section",
        reason: "Reusable Codex workflow for orienting in this repo.",
        content: buildManagedSection(buildRepoOnboardingSkill())
      },
      {
        path: ".agents/skills/code-review/SKILL.md",
        mode: "managed-section",
        reason: "Reusable Codex workflow for repo-aware review.",
        content: buildManagedSection(buildCodeReviewSkill())
      }
    ]
  };
}

export function buildManagedSection(body) {
  return `${MANAGED_BEGIN}\n${body.trim()}\n${MANAGED_END}\n`;
}

function buildAgents(manifest, graph) {
  const commands = manifest.discovery.commands;
  return `# AGENTS.md

## Codex Working Agreements

Default to Explore / Review mode unless the user explicitly authorizes file changes.

In Explore / Review mode:
- Do not create, edit, rename, move, delete, or apply patches to files.
- Do not stage, commit, push, open pull requests, or run destructive/state-changing commands.
- You may inspect files, summarize structure, identify issues, propose options, draft changes in chat, and recommend next steps.

File changes are allowed only when the user explicitly says "Apply this change", "Edit the files", "Implement this", "Create/update/delete the file", or "Make the change in the repo".

Committing and pushing require separate explicit authorization.

## Planning Decision Gate

A complete saved plan is not permission to edit files.

After presenting a complete plan, offer the user two paths: keep planning, or approve build and start a dedicated branch.

Treat "implement this plan" as build approval only when the active plan is lint-clean and the user explicitly authorizes implementation.

Start approved implementation work on a dedicated branch, usually \`codex/<short-plan-slug>\`.

Keep commit and push as separate explicit approvals.

## Repo Snapshot

- Repo: ${manifest.repo.name}
- Languages: ${listOrNone(manifest.discovery.languages)}
- Frameworks: ${listOrNone(manifest.discovery.frameworks)}
- Package managers: ${listOrNone(manifest.discovery.packageManagers)}
- Source roots: ${listOrNone(manifest.discovery.sourceRoots)}
- Test roots: ${listOrNone(manifest.discovery.testRoots)}
- Entrypoints: ${listOrNone(manifest.discovery.entrypoints)}

## Local Code Graph

- Graph file: \`.codex-prep/codegraph.json\`
- Indexed files: ${graph?.summary?.fileCount ?? "not generated"}
- Import edges: ${graph?.summary?.edgeCount ?? "not generated"}
- Symbols: ${graph?.summary?.symbolCount ?? "not generated"}

Before broad searching, inspect \`.codex-prep/codegraph.json\` or run \`codex-prep graph-query\` to find imports, dependents, symbols, and likely related tests.

Use \`codex-prep status\` for current plan/branch/validation state and \`codex-prep doctor\` when the workflow looks inconsistent.
If local CodexManager memory appears in git status, run \`codex-prep local-ignore\` to install repo-local exclude rules.

## Validation Commands

${commands.length > 0 ? commands.map((command) => `- \`${command.command}\` (${command.source || "detected"})`).join("\n") : "- No validation commands were discovered. Inspect the repo before claiming tests, lint, or builds passed."}

## Done Criteria

- The requested behavior or analysis is complete.
- Relevant validation commands were run, or the final response states why they were not run.
- Any changed files are summarized plainly.
- Tests are not claimed as passing unless they were actually run.
- Repeated Codex mistakes or useful user corrections are captured in \`docs/CODEX_FEEDBACK.md\`.

## Review Expectations

- Prioritize bugs, regressions, missing tests, unsafe assumptions, and unclear ownership.
- Separate inspected evidence from assumptions.
- Prefer small, reviewable diffs over broad rewrites.
- Keep mandatory repo rules in this file or checked-in docs, not only in memory.`;
}

function buildCodebaseMap(manifest, graph) {
  return `# Codebase Map

Generated by \`codex-prep\`. Treat this as a reviewable orientation map, not an architectural source of truth.

## Repo Shape

- Root: \`.\`
- Top-level entries: ${listOrNone(manifest.discovery.topLevel)}
- Languages: ${listOrNone(manifest.discovery.languages)}
- Frameworks: ${listOrNone(manifest.discovery.frameworks)}
- Package managers: ${listOrNone(manifest.discovery.packageManagers)}

## Important Paths

- Source roots: ${listOrNone(manifest.discovery.sourceRoots)}
- Test roots: ${listOrNone(manifest.discovery.testRoots)}
- Entrypoints: ${listOrNone(manifest.discovery.entrypoints)}
- Docs: ${listOrNone(manifest.discovery.docs)}
- CI: ${listOrNone(manifest.discovery.ci)}
- Workspace packages: ${listOrNone(manifest.discovery.workspacePackages)}
- Architecture docs: ${listOrNone(manifest.discovery.architectureDocs)}
- Important files: ${listOrNone(manifest.discovery.importantFiles)}

## Commands

${manifest.discovery.commands.length > 0 ? manifest.discovery.commands.map((command) => `- \`${command.command}\` from \`${command.source}\``).join("\n") : "- No commands were detected."}

## Code Graph Summary

- Graph file: \`.codex-prep/codegraph.json\`
- Indexed files: ${graph?.summary?.fileCount ?? "not generated"}
- Import edges: ${graph?.summary?.edgeCount ?? "not generated"}
- Symbols: ${graph?.summary?.symbolCount ?? "not generated"}
- Languages: ${graph?.summary?.languages?.length ? graph.summary.languages.map((value) => `\`${value}\``).join(", ") : "not generated"}

Use \`codex-prep graph-query --file <path>\` to inspect imports, dependents, symbols, and likely related tests before editing unfamiliar code.

## Evidence

${manifest.evidence.length > 0 ? manifest.evidence.map((item) => `- ${item.confidence}: ${item.fact} (${item.source})`).join("\n") : "- No high-confidence evidence was detected."}

## Assumptions

${manifest.assumptions.length > 0 ? manifest.assumptions.map((item) => `- ${item}`).join("\n") : "- No assumptions recorded."}

## Later Ideas

- Add AST-level symbol precision after deterministic graph extraction proves useful.
- Add a local query API and MCP server only after command, path, and drift checks are stable.
- Avoid embeddings, vector databases, cloud indexing, Postgres, and Neon in the graph MVP.`;
}

function buildDashboard(manifest, graph, state) {
  const plan = state?.plan?.plan;
  const validation = state?.validation?.latest;
  const doctorFindings = state?.doctor?.findings ?? [];
  const dirtyFiles = state?.git?.dirtyFiles ?? [];
  const localStateFiles = state?.git?.localStateFiles ?? [];
  const commands = manifest.discovery.commands ?? [];

  return `# CodexManager Dashboard

Generated by ` + "`codex-prep`" + `. This is a reviewable workflow snapshot, not authorization to edit, commit, or push.

## Current State

- Repo: ` + inlineValue(manifest.repo.name) + `
- Branch: ` + inlineValue(state?.git?.branchName || "unknown") + `
- Plan: ` + inlineValue(plan ? `${plan.status} / ${plan.build?.status ?? "not_started"}` : "none") + `
- Plan branch: ` + inlineValue(plan?.build?.branchName || "none") + `
- Graph: ` + inlineValue(graph?.fingerprint ? `${graph.summary?.fileCount ?? 0} files, ${graph.summary?.edgeCount ?? 0} edges` : "not generated") + `
- Dashboard next action: ` + inlineValue(state?.nextAction || "Run codex-prep status for live state") + `

## Validation Memory

` + validationSummary(validation) + `

## Doctor Findings

` + findingSummary(doctorFindings) + `

## Working Tree

- Code changes: ` + inlineValue(dirtyFiles.length > 0 ? dirtyFiles.join(", ") : "none") + `
- Local CodexManager state: ` + inlineValue(localStateFiles.length > 0 ? localStateFiles.join(", ") : "none") + `

## Detected Validation Commands

` + (commands.length > 0 ? commands.map((command) => `- ` + inlineValue(command.command) + ` from ` + inlineValue(command.source || "detected")).join("\n") : "- none detected") + `

## Useful Commands

- ` + inlineValue("codex-prep status") + `
- ` + inlineValue("codex-prep doctor") + `
- ` + inlineValue("codex-prep local-ignore") + `
- ` + inlineValue("codex-prep refresh-graph") + `
- ` + inlineValue("codex-prep graph-export --format obsidian") + `
- ` + inlineValue("codex-prep validation-record --validation-command \"npm run verify\" --result pass --summary \"verify passed\"") + `
`;
}

function validationSummary(validation) {
  if (!validation) {
    return "- No validation result recorded yet.";
  }
  return [
    `- Result: ${inlineValue(validation.result || "unknown")}`,
    `- Command: ${inlineValue(validation.command || "unknown")}`,
    `- Recorded: ${inlineValue(validation.recordedAt || "unknown")}`,
    `- Summary: ${inlineValue(validation.summary || "none")}`
  ].join("\n");
}

function findingSummary(findings) {
  if (findings.length === 0) {
    return "- No doctor findings.";
  }
  return findings.map((finding) => `- [${finding.level}] ${finding.code}: ${finding.message} Fix: ${finding.fix}`).join("\n");
}

function inlineValue(value) {
  return "`" + String(value).replace(/`/g, "'") + "`";
}

function buildFeedback() {
  return `# Codex Feedback

Use this file as the repo learning loop ledger. Do not store secrets here.

## Repeated Mistakes

- None recorded yet.

## User Corrections

- None recorded yet.

## Guidance Promoted To AGENTS.md

- None recorded yet.

## Rejected Or Too-Specific Rules

- None recorded yet.

## Follow-Up Improvements

- Add more checks only when drift, repeated mistakes, or new adapters make them useful.`;
}

function buildRepoOnboardingSkill() {
  return `---
name: repo-onboarding
description: Orient inside this repository before coding. Use when the user asks how the repo works, where to make a change, or what validation commands apply.
---

1. Read \`AGENTS.md\` and \`docs/CODEBASE_MAP.md\` first.
2. Inspect only the smallest file set needed to answer the task.
3. Separate inspected evidence from assumptions.
4. Name relevant validation commands from \`AGENTS.md\`; do not invent commands.
5. Inspect \`.codex-prep/codegraph.json\` or run \`codex-prep graph-query\` before broad searching.
6. Run \`codex-prep status\` to check plan, branch, dashboard, graph, and validation state.
7. If the workflow looks inconsistent, run \`codex-prep doctor\` and follow the highest-severity finding first.
8. If local CodexManager memory appears in git status, run \`codex-prep local-ignore\`.
9. If the map or graph is stale, recommend \`codex-prep check\`, \`codex-prep refresh-map\`, or \`codex-prep refresh-graph\`.
10. For saved implementation plans, run \`codex-prep plan-review\` before build approval.
11. Treat plan approval, branch creation, file edits, commits, and pushes as separate user decisions.
12. Stay in Explore / Review mode unless the user explicitly authorizes edits.`;
}

function buildCodeReviewSkill() {
  return `---
name: code-review
description: Review changes in this repository using repo-specific Codex guidance. Use when the user asks for a review, risk assessment, or pre-commit check.
---

1. Read \`AGENTS.md\` and \`docs/CODEBASE_MAP.md\`.
2. Inspect the diff or files under review.
3. Lead with findings ordered by severity.
4. Prioritize bugs, regressions, missing tests, unsafe assumptions, and stale guidance.
5. Mention validation commands that should be run, and say whether they were actually run.
6. If feedback is likely to recur, add it to \`docs/CODEX_FEEDBACK.md\` only after the user authorizes edits.`;
}

function listOrNone(values) {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(", ") : "none detected";
}
