<!-- codex-prep:begin -->
---
name: code-review
description: Review changes in this repository using repo-specific Codex guidance. Use when the user asks for a review, risk assessment, or pre-commit check.
---

1. Read `AGENTS.md` and `docs/CODEBASE_MAP.md`.
2. Inspect the diff or files under review.
3. Lead with findings ordered by severity.
4. Prioritize bugs, regressions, missing tests, unsafe assumptions, and stale guidance.
5. Mention validation commands that should be run, and say whether they were actually run.
6. If feedback is likely to recur, add it to `docs/CODEX_FEEDBACK.md` only after the user authorizes edits.
<!-- codex-prep:end -->
