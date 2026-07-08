# codex-prep

`codex-prep` is a local-first CLI that prepares a repository for better Codex collaboration.

The goal is a repo learning loop:

1. Codex understands the repo faster.
2. Useful repo knowledge is stored in durable, reviewable files.
3. Repeated mistakes become guidance, checks, or feedback items.
4. The repo gets easier for Codex and humans to work in over time.

## Commands

```powershell
node ./bin/codex-prep.js scan
node ./bin/codex-prep.js plan
node ./bin/codex-prep.js plan --no-save
node ./bin/codex-prep.js plan-update --note "User clarified the scope"
node ./bin/codex-prep.js plan-status
node ./bin/codex-prep.js plan-lint
node ./bin/codex-prep.js plan-close --status implemented
node ./bin/codex-prep.js apply
node ./bin/codex-prep.js check
node ./bin/codex-prep.js eval
node ./bin/codex-prep.js lint
node ./bin/codex-prep.js refresh-map
```

Use `--repo <path>` to target another repository and `--json` for machine-readable output on commands that support it.

## Windows Usage

From this repo, run:

```powershell
.\codex-prep.cmd scan --repo D:\path\to\repo
.\codex-prep.cmd plan --repo D:\path\to\repo
.\codex-prep.cmd plan-status --repo D:\path\to\repo
.\codex-prep.cmd plan-lint --repo D:\path\to\repo
.\codex-prep.cmd apply --repo D:\path\to\repo
.\codex-prep.cmd check --repo D:\path\to\repo
.\codex-prep.cmd eval --repo D:\path\to\repo
.\codex-prep.cmd lint --repo D:\path\to\repo
```

From anywhere, use the full shim path:

```powershell
D:\codexmanager\codex-prep.cmd scan --repo D:\path\to\repo
```

If you want the shorter `codex-prep` command globally, install the local package link:

```powershell
cd D:\codexmanager
npm.cmd link
codex-prep scan --repo D:\path\to\repo
```

## Development Loop

Before committing local changes, run the finite verification gate:

```powershell
npm.cmd run verify
```

It runs unit tests, managed-file lint, drift detection, and the eval harness. GitHub Actions runs the same gate on pushes to `main` and pull requests.

## Planning Loop

`plan` autosaves by default. This lets Codex keep a durable draft while you are still in Explore / Review mode, before you approve implementation:

```powershell
D:\codexmanager\codex-prep.cmd plan --repo D:\path\to\repo --intent "Add the linter MVP"
```

Saved plans are written to `.codex-prep/plans/`:

- timestamped plan snapshots
- `latest-plan.json`
- `active-plan.json`

Use `--no-save` for preview-only behavior:

```powershell
D:\codexmanager\codex-prep.cmd plan --repo D:\path\to\repo --no-save
```

Update the active plan as the conversation clarifies:

```powershell
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --note "User prefers a small first pass"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --goal "Add the planning quality gate"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --success "plan-lint passes"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --non-goal "No new dependencies"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --scope "Add CLI command" --file src/cli.js
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --validation "npm.cmd run verify"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --stop-rule "Stop after verify passes and capture follow-ups"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --status approved
```

Inspect or close the active plan:

```powershell
D:\codexmanager\codex-prep.cmd plan-status --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-lint --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-close --repo D:\path\to\repo --status implemented --note "Built and verified"
```

A saved plan is memory, not approval to edit. Editing still requires explicit user authorization.

## Plan Lint

`plan-lint` checks the active saved plan without editing files:

```powershell
D:\codexmanager\codex-prep.cmd plan-lint --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-lint --repo D:\path\to\repo --json
```

It fails plans that are missing a goal or intent, success criteria, validation, stop rules, or required approval boundaries for high-risk work. It warns when the plan lacks likely touched files, non-goals, target agent, repo-detected validation commands, or a browser-facing check for a web UI repo.

If Playwright is already present, `plan-lint` suggests the detected Playwright command. It does not install Playwright or add dependencies.

## Generated Bundle

`apply` writes or refreshes:

- `AGENTS.md`
- `docs/CODEBASE_MAP.md`
- `docs/CODEX_FEEDBACK.md`
- `.codex-prep/manifest.json`
- `.agents/skills/repo-onboarding/SKILL.md`
- `.agents/skills/code-review/SKILL.md`

Existing files are preserved outside managed `codex-prep` sections. `apply` also creates `.codex-prep/config.json` when missing and preserves it after that.

## Lint

`lint` checks the generated/managed repo files without editing them. It verifies managed markers, skill frontmatter, manifest shape, stale `D:\Codex` path references, and obvious secret-looking content. Findings use stable rule IDs such as `CP002`, include fix suggestions, and can be tuned in `.codex-prep/config.json`.

## MVP Boundary

This first pass is deterministic and inspectable. It avoids embeddings, vector databases, cloud indexing, and network calls. A richer code graph, local query API, MCP server, and editor-specific adapters can be added after the basic onboarding loop proves useful.