<!-- codex-prep:begin -->
# Agent Handoff

Handoff fingerprint: d9ca1451f88bce43a288ae198f9ba3a56c7b852dcf1723d977ce49e5991b4c68

This file is a reconnect packet for a fresh agent. It is status, not authorization to edit, commit, push, merge, deploy, install dependencies, or run destructive commands.

## Current State

- Repo: `CodexManager`
- Branch: `codex/multi-agent-adapters`
- Head commit: `069ae4caba20`
- Dirty files: `27`
- Local CodexManager state files: `0`
- Active plan: `implemented / in_progress`
- Plan goal: `Make CodexManager show the current coding workflow state, last known validations, branch/plan alignment, troubleshooting gaps, and next recommended action from one local-first control loop.`
- Plan branch: `main`
- Target agent: `codex`
- Graph: `26 files, 65 edges`
- Adapters: `fresh: claude-code, cursor, jan, ollama, generic`
- Latest validation: `pass npm.cmd --prefix D:\CodexManager run verify`
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
