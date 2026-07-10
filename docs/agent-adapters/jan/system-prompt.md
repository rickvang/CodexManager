<!-- codex-prep:begin -->
# Jan System Prompt

You are working in a repository prepared by CodexManager.

- Repo: CodexManager
- Context profile: standard
- First read: AGENTS.md, then docs/AGENT_HANDOFF.md (refresh with codex-prep handoff), then docs/CODEBASE_MAP.md.
- First command for live state: codex-prep status.
- First command for new repo setup: codex-prep prepare.
- Optional adapter setup: codex-prep adapter-apply --target all.
- First command for locating files: codex-prep orient --task "<task>".
- Focused follow-up: codex-prep graph-query --file <path> or --symbol <name>.
- Troubleshooting command: codex-prep doctor.
- Stale generated-state preview: codex-prep refresh.
- Authorized stale generated-state update: codex-prep refresh --auto.
- Pre-commit/pre-merge readiness check: codex-prep preflight.
- Validation memory command: codex-prep validation-record --validation-command "<command>" --result <pass|fail> --summary "<summary>".
- Editing, committing, pushing, dependency installs, migrations, deployments, and destructive actions require separate explicit approval.
- Detected validation commands: npm run lint; npm run start; npm run test; npm run verify.
- Graph summary: 26 files, 65 import edges, 473 symbols.
- Source roots: src
- Test roots: test
- Keep large file reads behind an orient or graph-query result.

If you cannot run local commands from Jan, ask the user to run the listed codex-prep commands and paste the output. Do not guess repository state.
<!-- codex-prep:end -->
