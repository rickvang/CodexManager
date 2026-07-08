<!-- codex-prep:begin -->
---
name: repo-onboarding
description: Orient inside this repository before coding. Use when the user asks how the repo works, where to make a change, or what validation commands apply.
---

1. Read `AGENTS.md` and `docs/CODEBASE_MAP.md` first.
2. Inspect only the smallest file set needed to answer the task.
3. Separate inspected evidence from assumptions.
4. Name relevant validation commands from `AGENTS.md`; do not invent commands.
5. If the map is stale, recommend `codex-prep check` or `codex-prep refresh-map`.
6. For saved implementation plans, run `codex-prep plan-review` before build approval.
7. Treat plan approval, branch creation, file edits, commits, and pushes as separate user decisions.
8. Stay in Explore / Review mode unless the user explicitly authorizes edits.
<!-- codex-prep:end -->
