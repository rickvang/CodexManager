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

## Repo Snapshot

- Repo: codexmanager
- Languages: `JavaScript`
- Frameworks: none detected
- Package managers: `npm`
- Source roots: `src`
- Test roots: `test`
- Entrypoints: `bin/codex-prep.js`

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
