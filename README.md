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
node ./bin/codex-prep.js apply
node ./bin/codex-prep.js check
node ./bin/codex-prep.js eval
node ./bin/codex-prep.js lint
node ./bin/codex-prep.js refresh-map
```

Use `--repo <path>` to target another repository and `--json` for machine-readable output on commands that support it.

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
