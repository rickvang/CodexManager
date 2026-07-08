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
node ./bin/codex-prep.js plan-review
node ./bin/codex-prep.js plan-lint
node ./bin/codex-prep.js plan-approve --note "Ready to build"
node ./bin/codex-prep.js plan-start --branch codex/my-plan
node ./bin/codex-prep.js plan-close --status implemented
node ./bin/codex-prep.js apply
node ./bin/codex-prep.js check
node ./bin/codex-prep.js eval
node ./bin/codex-prep.js graph --json
node ./bin/codex-prep.js graph-export --format obsidian
node ./bin/codex-prep.js graph-query --file src/index.ts
node ./bin/codex-prep.js lint
node ./bin/codex-prep.js refresh-graph
node ./bin/codex-prep.js refresh-map
```

Use `--repo <path>` to target another repository and `--json` for machine-readable output on commands that support it.

## Windows Usage

From this repo, run:

```powershell
.\codex-prep.cmd scan --repo D:\path\to\repo
.\codex-prep.cmd plan --repo D:\path\to\repo
.\codex-prep.cmd plan-status --repo D:\path\to\repo
.\codex-prep.cmd plan-review --repo D:\path\to\repo
.\codex-prep.cmd plan-lint --repo D:\path\to\repo
.\codex-prep.cmd plan-approve --repo D:\path\to\repo --note "Ready to build"
.\codex-prep.cmd plan-start --repo D:\path\to\repo --branch codex/my-plan
.\codex-prep.cmd apply --repo D:\path\to\repo
.\codex-prep.cmd check --repo D:\path\to\repo
.\codex-prep.cmd eval --repo D:\path\to\repo
.\codex-prep.cmd graph --repo D:\path\to\repo --json
.\codex-prep.cmd graph-export --repo D:\path\to\repo --format obsidian
.\codex-prep.cmd graph-query --repo D:\path\to\repo --file src/index.ts
.\codex-prep.cmd refresh-graph --repo D:\path\to\repo
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
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --success "plan-review shows build options"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --non-goal "No new dependencies"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --scope "Add CLI command" --file src/cli.js
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --validation "npm.cmd run verify"
D:\codexmanager\codex-prep.cmd plan-update --repo D:\path\to\repo --stop-rule "Stop after verify passes and capture follow-ups"
```

Review the active plan before build approval:

```powershell
D:\codexmanager\codex-prep.cmd plan-review --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-review --repo D:\path\to\repo --json
```

If `plan-review` reports errors, keep planning with `plan-update`. If it is lint-clean, choose either to keep planning or approve build:

```powershell
D:\codexmanager\codex-prep.cmd plan-approve --repo D:\path\to\repo --note "Ready to build"
D:\codexmanager\codex-prep.cmd plan-start --repo D:\path\to\repo --branch codex/my-plan
```

`plan-approve` records approval metadata only. It does not edit code, create branches, commit, or push.

`plan-start` creates the implementation branch and records branch metadata. It requires an approved active plan and a clean non-plan worktree; `.codex-prep/plans/` is allowed because it is the plan state this workflow owns. It does not commit, push, merge, or implement code.

Use `--sync-base` only when you explicitly want network-backed base refresh before branch creation:

```powershell
D:\codexmanager\codex-prep.cmd plan-start --repo D:\path\to\repo --branch codex/my-plan --base main --sync-base
```

Inspect, lint, or close the active plan:

```powershell
D:\codexmanager\codex-prep.cmd plan-status --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-lint --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-close --repo D:\path\to\repo --status implemented --note "Built and verified"
```

A saved plan is memory, not approval to edit. Plan approval, branch creation, file edits, commits, and pushes are separate decisions.

## Plan Lint

`plan-lint` checks the active saved plan without editing files:

```powershell
D:\codexmanager\codex-prep.cmd plan-lint --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd plan-lint --repo D:\path\to\repo --json
```

It fails plans that are missing a goal or intent, success criteria, validation, stop rules, or required approval boundaries for high-risk work. It warns when the plan lacks likely touched files, non-goals, target agent, repo-detected validation commands, or a browser-facing check for a web UI repo.

If Playwright is already present, `plan-lint` suggests the detected Playwright command. It does not install Playwright or add dependencies.

## Code Graph

`graph` builds a read-only live preview of the local code graph:

```powershell
D:\codexmanager\codex-prep.cmd graph --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd graph --repo D:\path\to\repo --json
```

`refresh-graph` writes `.codex-prep/codegraph.json`:

```powershell
D:\codexmanager\codex-prep.cmd refresh-graph --repo D:\path\to\repo
```

`graph-query` answers focused orientation questions without broad searching:

```powershell
D:\codexmanager\codex-prep.cmd graph-query --repo D:\path\to\repo --file src/index.ts
D:\codexmanager\codex-prep.cmd graph-query --repo D:\path\to\repo --symbol createApp
```

The graph records files, languages, roles, local import edges, exported/top-level symbols, entrypoints, likely test relationships, and confidence labels. JavaScript, TypeScript, and Python get import/symbol extraction. Other supported languages are indexed at file level only.

## Obsidian Graph Export

`graph-export --format obsidian` renders `.codex-prep/codegraph.json` into Obsidian-readable Markdown notes:

```powershell
D:\codexmanager\codex-prep.cmd graph-export --repo D:\path\to\repo --format obsidian
```

The export writes to `.codex-prep/obsidian/`:

- `Index.md`
- `Files/*.md`
- `Tests/*.md`
- `Symbols/*.md`

Open the target repository folder as an Obsidian vault, then use Graph View to inspect the generated `[[wikilinks]]` between files, tests, imports, dependents, and symbols. Obsidian output is an adapter artifact; `.codex-prep/codegraph.json` remains the source of truth.

## Generated Bundle

`apply` writes or refreshes:

- `AGENTS.md`
- `docs/CODEBASE_MAP.md`
- `docs/CODEX_FEEDBACK.md`
- `.codex-prep/manifest.json`
- `.codex-prep/codegraph.json`
- `.agents/skills/repo-onboarding/SKILL.md`
- `.agents/skills/code-review/SKILL.md`

Existing files are preserved outside managed `codex-prep` sections. `apply` also creates `.codex-prep/config.json` when missing and preserves it after that.

## Lint

`lint` checks the generated/managed repo files without editing them. It verifies managed markers, skill frontmatter, manifest shape, stale `D:\Codex` path references, and obvious secret-looking content. Findings use stable rule IDs such as `CP002`, include fix suggestions, and can be tuned in `.codex-prep/config.json`.

## MVP Boundary

This pass is deterministic and inspectable. It includes a local file-backed code graph, but still avoids embeddings, vector databases, cloud indexing, and network calls. A richer AST graph, local query API, MCP server, and editor-specific adapters can be added after the graph loop proves useful.
