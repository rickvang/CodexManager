import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_STATE_IGNORE_PATTERNS,
  buildDoctorResult,
  ensureLocalStateIgnored,
  selectNextAction
} from "../src/state.js";
import { createGitRepo, jsRepoFiles } from "./helpers.js";


test("ensureLocalStateIgnored installs repo-local git excludes idempotently", async () => {
  const root = await createGitRepo(jsRepoFiles());

  const first = await ensureLocalStateIgnored(root);
  const second = await ensureLocalStateIgnored(root);
  const exclude = await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf8");

  assert.equal(first.isGitRepo, true);
  assert.equal(first.changed, true);
  assert.deepEqual(first.added, [...LOCAL_STATE_IGNORE_PATTERNS]);
  assert.equal(second.changed, false);
  for (const pattern of LOCAL_STATE_IGNORE_PATTERNS) {
    assert.equal(exclude.split(pattern).length - 1, 1);
  }
});
test("terminal plans do not require switching back to old implementation branches", () => {
  const state = completeState({
    plan: {
      exists: true,
      plan: {
        status: "implemented",
        build: {
          status: "in_progress",
          branchName: "codex/finished-work"
        }
      }
    },
    git: {
      isGitRepo: true,
      branchName: "main",
      dirtyFiles: []
    }
  });

  const result = buildDoctorResult(state);

  assert.equal(result.ok, true);
  assert.equal(result.findings.some((finding) => finding.code === "CM003"), false);
  assert.equal(selectNextAction(state), "No active implementation work remains; create a new plan for new work.");
});

function completeState(overrides = {}) {
  return {
    plan: overrides.plan ?? { exists: false },
    git: {
      isGitRepo: true,
      branchName: "main",
      dirtyFiles: [],
      ...overrides.git
    },
    manifest: {
      exists: true,
      stale: false
    },
    graph: {
      exists: true,
      invalid: false,
      stale: false
    },
    generated: {
      files: [
        { path: "AGENTS.md", exists: true },
        { path: "docs/CODEBASE_MAP.md", exists: true },
        { path: "docs/CODEX_FEEDBACK.md", exists: true },
        { path: "docs/codexmanager-dashboard.md", exists: true }
      ],
      dashboard: { exists: true },
      obsidian: { exists: true, stale: false }
    },
    validation: {
      exists: true,
      latest: {
        result: "pass",
        command: "npm run verify"
      }
    },
    commands: [
      { name: "verify", command: "npm run verify" }
    ]
  };
}
