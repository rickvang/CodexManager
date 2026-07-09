<!-- codex-prep:begin -->
# Agent Handoff

Handoff fingerprint: 6c363159990556e5a921a0e8e2516ced9fccb8efe0f45f58552d5af900189e67

This file is a reconnect packet for a fresh agent. It is status, not authorization to edit, commit, push, merge, deploy, install dependencies, or run destructive commands.

## Current State

- Repo: `CodexManager`
- Branch: `codex/cursor-lifecycle-cli`
- Head commit: `e517100f620d`
- Dirty files: `28`
- Local CodexManager state files: `0`
- Active plan: `implemented / in_progress`
- Plan goal: `Make CodexManager show the current coding workflow state, last known validations, branch/plan alignment, troubleshooting gaps, and next recommended action from one local-first control loop.`
- Plan branch: `main`
- Target agent: `codex`
- Graph: `26 files, 65 edges`
- Adapters: `fresh: claude-code, cursor, jan, ollama, generic`
- Latest validation: `pass npm.cmd run verify`
- Next action: `No active implementation work remains; create a new plan for new work.`

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
<!-- codex-prep:end -->
