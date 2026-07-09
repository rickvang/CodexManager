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
node ./bin/codex-prep.js status
node ./bin/codex-prep.js doctor
node ./bin/codex-prep.js prepare --target all
node ./bin/codex-prep.js refresh
node ./bin/codex-prep.js refresh --auto
node ./bin/codex-prep.js preflight
node ./bin/codex-prep.js adapters
node ./bin/codex-prep.js adapter-plan --target all
node ./bin/codex-prep.js adapter-apply --target all
node ./bin/codex-prep.js handoff
node ./bin/codex-prep.js local-ignore
node ./bin/codex-prep.js validation-record --validation-command "npm run verify" --result pass --summary "verify passed"
node ./bin/codex-prep.js plan-attach --note "Attached current branch to active plan"
node ./bin/codex-prep.js plan-review
node ./bin/codex-prep.js plan-lint
node ./bin/codex-prep.js plan-approve --note "Ready to build"
node ./bin/codex-prep.js plan-start --branch codex/my-plan
node ./bin/codex-prep.js plan-close --status implemented
node ./bin/codex-prep.js apply
node ./bin/codex-prep.js check
node ./bin/codex-prep.js eval
node ./bin/codex-prep.js graph --json
node ./bin/codex-prep.js orient --task "change answer behavior" --profile standard
node ./bin/codex-prep.js graph-export --format obsidian
node ./bin/codex-prep.js graph-export --format obsidian --include-symbols
node ./bin/codex-prep.js graph-query --file src/index.ts --limit 10 --depth 1
node ./bin/codex-prep.js lint
node ./bin/codex-prep.js refresh-graph
node ./bin/codex-prep.js refresh-map
```

Use `--repo <path>` to target another repository and `--json` for machine-readable output on commands that support it.

## Cursor-Style Lifecycle

CodexManager now keeps the Cursor-like loop in the CLI instead of a VS Code extension:

```powershell
codex-prep prepare --repo D:\path\to\repo --target all
codex-prep status --repo D:\path\to\repo
codex-prep orient --repo D:\path\to\repo --task "change login validation" --profile standard
codex-prep preflight --repo D:\path\to\repo
codex-prep refresh --repo D:\path\to\repo
codex-prep refresh --repo D:\path\to\repo --auto
```

`prepare`/`bootstrap` performs first-time setup: local ignore rules, `apply`, Obsidian graph export, multi-agent adapters, and handoff. `refresh` is read-only and previews stale generated state; `refresh --auto` applies those updates after edits are authorized. `preflight` is read-only and connects changed files to likely tests, validation freshness, stale generated state, and next actions.

## Windows Usage

From this repo, run:

```powershell
.\codex-prep.cmd scan --repo D:\path\to\repo
.\codex-prep.cmd plan --repo D:\path\to\repo
.\codex-prep.cmd plan-status --repo D:\path\to\repo
.\codex-prep.cmd status --repo D:\path\to\repo
.\codex-prep.cmd doctor --repo D:\path\to\repo
.\codex-prep.cmd prepare --repo D:\path\to\repo --target all
.\codex-prep.cmd refresh --repo D:\path\to\repo
.\codex-prep.cmd refresh --repo D:\path\to\repo --auto
.\codex-prep.cmd preflight --repo D:\path\to\repo
.\codex-prep.cmd adapters
.\codex-prep.cmd adapter-plan --repo D:\path\to\repo --target all
.\codex-prep.cmd adapter-apply --repo D:\path\to\repo --target all
.\codex-prep.cmd handoff --repo D:\path\to\repo
.\codex-prep.cmd local-ignore --repo D:\path\to\repo
.\codex-prep.cmd validation-record --repo D:\path\to\repo --validation-command "npm run verify" --result pass --summary "verify passed"
.\codex-prep.cmd plan-attach --repo D:\path\to\repo --note "Attached current branch to active plan"
.\codex-prep.cmd plan-review --repo D:\path\to\repo
.\codex-prep.cmd plan-lint --repo D:\path\to\repo
.\codex-prep.cmd plan-approve --repo D:\path\to\repo --note "Ready to build"
.\codex-prep.cmd plan-start --repo D:\path\to\repo --branch codex/my-plan
.\codex-prep.cmd apply --repo D:\path\to\repo
.\codex-prep.cmd check --repo D:\path\to\repo
.\codex-prep.cmd eval --repo D:\path\to\repo
.\codex-prep.cmd graph --repo D:\path\to\repo --json
.\codex-prep.cmd orient --repo D:\path\to\repo --task "change answer behavior" --profile standard
.\codex-prep.cmd graph-export --repo D:\path\to\repo --format obsidian
.\codex-prep.cmd graph-export --repo D:\path\to\repo --format obsidian --include-symbols
.\codex-prep.cmd graph-query --repo D:\path\to\repo --file src/index.ts --limit 10 --depth 1
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


## Multi-Agent Adapters

CodexManager can project its repo knowledge into other agent surfaces without making those surfaces the source of truth.

```powershell
D:\codexmanager\codex-prep.cmd adapters
D:\codexmanager\codex-prep.cmd adapter-plan --repo D:\path\to\repo --target all
D:\codexmanager\codex-prep.cmd adapter-apply --repo D:\path\to\repo --target all
D:\codexmanager\codex-prep.cmd handoff --repo D:\path\to\repo
```

`adapter-plan` is read-only. `adapter-apply` writes target-specific adapter files and `.codex-prep/adapters.json`. `handoff` writes `docs/AGENT_HANDOFF.md` so a fresh agent can reconnect, see the active plan/branch/validation state, and know the next safe command.

Supported adapter targets:

- `claude-code`: `CLAUDE.md` plus `.claude/rules/` workflow guidance.
- `cursor`: `.cursor/rules/*.mdc` project rules.
- `jan`: Markdown prompt pack under `docs/agent-adapters/jan/`.
- `ollama`: Markdown prompt pack plus a template `Modelfile` under `docs/agent-adapters/ollama/`.
- `generic`: portable Markdown prompt pack for tools that can consume text but have no native repo-rule format.

Use `--profile short`, `--profile standard`, or `--profile deep` to control how much repo context the generated adapter prompt includes. Cursor output is split into scoped `.cursor/rules/*.mdc` files for workflow safety, graph-first orientation, review/validation, and generated state. Adapter files are projections of `AGENTS.md`, `docs/CODEBASE_MAP.md`, the local code graph, and CodexManager state; when those inputs change, run `codex-prep refresh` to preview updates or `codex-prep refresh --auto` after file changes are authorized.
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

If work already started on a branch after approval, attach the active plan to the current branch deliberately:

```powershell
D:\codexmanager\codex-prep.cmd plan-attach --repo D:\path\to\repo --note "Work started before plan-start"
```

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

## Workflow Status And Doctor

`status` is a read-only snapshot of the active plan, current branch, dirty files, graph freshness, dashboard/Obsidian state, and latest recorded validation:

```powershell
D:\codexmanager\codex-prep.cmd status --repo D:\path\to\repo
```

`doctor` is a read-only troubleshooting pass with stable finding codes such as `CM005` for a missing manifest or `CM009` for a stale code graph:

```powershell
D:\codexmanager\codex-prep.cmd doctor --repo D:\path\to\repo
D:\codexmanager\codex-prep.cmd doctor --repo D:\path\to\repo --json
```

After you run validation, record the outcome explicitly so later status, doctor, dashboard, and Obsidian exports can show the current validation state:

```powershell
D:\codexmanager\codex-prep.cmd validation-record --repo D:\path\to\repo --validation-command "npm run verify" --result pass --summary "verify passed"
```

Validation memory is stored locally in `.codex-prep/validation-results.jsonl`. It is evidence that a validation command was run; it is not a substitute for rerunning validation after new changes.

If `.codex-prep/plans/` or `.codex-prep/validation-results.jsonl` appear in `git status`, install the repo-local ignore rules:

```powershell
D:\codexmanager\codex-prep.cmd local-ignore --repo D:\path\to\repo
```

`local-ignore` writes only `.git/info/exclude`, so it keeps local CodexManager memory out of version control without changing tracked repo files.

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

`orient` is the preferred graph-first entrypoint for token discipline. It returns a compact task-aware reading list, related tests, validation commands, confidence labels, fallback searches, and a local context estimate:

```powershell
D:\codexmanager\codex-prep.cmd orient --repo D:\path\to\repo --task "change login validation"
D:\codexmanager\codex-prep.cmd orient --repo D:\path\to\repo --task "change login validation" --limit 5 --json
```

`graph-query` answers focused follow-up questions without broad searching:

```powershell
D:\codexmanager\codex-prep.cmd graph-query --repo D:\path\to\repo --file src/index.ts --limit 10 --depth 1
D:\codexmanager\codex-prep.cmd graph-query --repo D:\path\to\repo --symbol createApp --limit 10
```

The graph records files, languages, roles, local import edges, exported/top-level symbols, entrypoints, likely test relationships, and confidence labels. JavaScript, TypeScript, and Python get import/symbol extraction. Other supported languages are indexed at file level only. The context estimate is a deterministic bytes-to-token proxy, not real model billing.

## Obsidian Graph Export

`graph-export --format obsidian` renders `.codex-prep/codegraph.json` into Obsidian-readable Markdown notes:

```powershell
D:\codexmanager\codex-prep.cmd graph-export --repo D:\path\to\repo --format obsidian
```

The default export writes a workflow-first graph to `docs/obsidian-codegraph/`:

- `Index.md`
- `Workflow.md`
- `Workflow/*.md`
- `Validations.md`
- `Troubleshooting.md`
- `Modules.md`
- `Modules/*.md`
- `Entrypoints.md`
- `Source Files.md`
- `Tests.md`
- `Import Graph.md`
- `Files/**/*.md`
- `Tests/**/*.md`

Open `Index.md`, then follow `Workflow.md` before drilling into modules or files. Workflow notes show traversal phases, expected validations, and evidence-backed state. Unknown state is labeled as unknown instead of guessed. `Troubleshooting.md` collects missing or stale workflow pieces that can be inferred from generated repo evidence.

Symbol notes are omitted by default because they can overwhelm Obsidian's graph view. Use `--include-symbols` when you want the detailed symbol layer:

```powershell
D:\codexmanager\codex-prep.cmd graph-export --repo D:\path\to\repo --format obsidian --include-symbols
```

With `--include-symbols`, the export also writes `Symbols.md` and `Symbols/*.md`.

Open the target repository folder as an Obsidian vault, then use Local Graph from `Index.md` or `Workflow.md`. Use module and file notes as drill-down detail for imports, dependents, symbols, and related tests. Obsidian output is an adapter artifact; `.codex-prep/codegraph.json`, `.codex-prep/manifest.json`, and saved plans remain the evidence sources.

## Generated Bundle

`apply` writes or refreshes:

- `AGENTS.md`
- `docs/CODEBASE_MAP.md`
- `docs/CODEX_FEEDBACK.md`
- `docs/codexmanager-dashboard.md`
- `.codex-prep/manifest.json`
- `.codex-prep/codegraph.json`
- `.agents/skills/repo-onboarding/SKILL.md`
- `.agents/skills/code-review/SKILL.md`

Existing files are preserved outside managed `codex-prep` sections. `apply` also creates `.codex-prep/config.json` when missing and preserves it after that.

## Lint

`lint` checks the generated/managed repo files without editing them. It verifies managed markers, skill frontmatter, manifest shape, stale `D:\Codex` path references, and obvious secret-looking content. Findings use stable rule IDs such as `CP002`, include fix suggestions, and can be tuned in `.codex-prep/config.json`.

## MVP Boundary

This pass is deterministic and inspectable. It includes a local file-backed code graph, but still avoids embeddings, vector databases, cloud indexing, and network calls. A richer AST graph, local query API, MCP server, and editor-specific adapters can be added after the graph loop proves useful.
