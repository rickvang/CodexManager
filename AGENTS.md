<!-- codex-prep:begin -->
# AGENTS.md

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

Start approved implementation work on a dedicated branch, usually `codex/<short-plan-slug>`.

Keep commit and push as separate explicit approvals.

## Repo Snapshot

- Repo: CodexManager
- Languages: `JavaScript`
- Frameworks: none detected
- Package managers: `npm`
- Source roots: `src`
- Test roots: `test`
- Entrypoints: `bin/codex-prep.js`

## Local Code Graph

- Graph file: `.codex-prep/codegraph.json`
- Indexed files: 24
- Import edges: 59
- Symbols: 390

Before broad searching, run `codex-prep orient --task "<task>"` and inspect only the returned reading list. Use `codex-prep graph-query` for focused file or symbol follow-up. Read `.codex-prep/codegraph.json` directly only when the commands are unavailable.

Use `codex-prep status` for current plan/branch/validation state and `codex-prep doctor` when the workflow looks inconsistent.
If local CodexManager memory appears in git status, run `codex-prep local-ignore` to install repo-local exclude rules.

## Validation Commands

- `npm run lint` (package.json)
- `npm run start` (package.json)
- `npm run test` (package.json)
- `npm run verify` (package.json)

## Done Criteria

- The requested behavior or analysis is complete.
- Relevant validation commands were run, or the final response states why they were not run.
- Any changed files are summarized plainly.
- Tests are not claimed as passing unless they were actually run.
- Repeated Codex mistakes or useful user corrections are captured in `docs/CODEX_FEEDBACK.md`.

## Review Expectations

- Prioritize bugs, regressions, missing tests, unsafe assumptions, and unclear ownership.
- Separate inspected evidence from assumptions.
- Prefer small, reviewable diffs over broad rewrites.
- Keep mandatory repo rules in this file or checked-in docs, not only in memory.
<!-- codex-prep:end -->
