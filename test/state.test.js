import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorResult, selectNextAction } from "../src/state.js";

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
