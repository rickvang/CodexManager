<!-- codex-prep:begin -->
---
name: repo-onboarding
description: Orient inside this repository before coding. Use when the user asks how the repo works, where to make a change, or what validation commands apply.
---

1. Read `AGENTS.md` and `docs/CODEBASE_MAP.md` first.
2. Run `codex-prep status` to check plan, branch, dashboard, graph, and validation state.
3. Run `codex-prep orient --task "<task>" --profile standard` before broad searching.
4. Inspect only the returned reading list unless the graph confidence is low.
5. Use `codex-prep graph-query --file <path>` or `--symbol <name>` for focused follow-up.
6. Separate inspected evidence from assumptions.
7. Name relevant validation commands from `AGENTS.md`; do not invent commands.
8. If the workflow looks inconsistent, run `codex-prep doctor` and follow the highest-severity finding first.
9. If local CodexManager memory appears in git status, run `codex-prep local-ignore`.
10. If generated state is stale, run `codex-prep refresh` to preview updates and recommend `codex-prep refresh --auto` after edits are authorized.
11. For saved implementation plans, run `codex-prep plan-review` before build approval.
12. Treat plan approval, branch creation, file edits, commits, and pushes as separate user decisions.
13. Stay in Explore / Review mode unless the user explicitly authorizes edits.
<!-- codex-prep:end -->
