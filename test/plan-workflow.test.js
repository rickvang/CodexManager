import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import {
  internals,
  planApproveCommand,
  planCommand,
  planReviewCommand,
  planStartCommand
} from "../src/commands.js";
import {
  createGitRepo,
  createTempRepo,
  git,
  jsRepoFiles,
  readTree,
  withCapturedConsole,
  withMutedConsole
} from "./helpers.js";

test("normalizePlan backfills build metadata for legacy plans", () => {
  const plan = internals.normalizePlan({
    schemaVersion: 2,
    kind: "codex-prep-plan",
    status: "draft",
    savedAt: "2026-07-08T10:11:12.345Z",
    repo: { root: "D:/old/repo", name: "repo" },
    goal: "Legacy plan",
    validationPlan: ["npm run test"]
  });

  assert.deepEqual(plan.build, {
    status: "not_started",
    branchName: "",
    baseBranch: "",
    baseCommit: "",
    startedAt: "",
    approvedAt: "",
    approvalNote: ""
  });
});

test("plan-review is read-only and points incomplete plans back to planning", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, intent: "Add branch workflow" });
  });
  const before = await readTree(root);

  const result = await withMutedConsole(() => planReviewCommand({ root, json: true }));
  const after = await readTree(root);

  assert.equal(result.readyToBuild, false);
  assert.equal(result.nextActions.some((item) => item.label === "Continue planning"), true);
  assert.deepEqual(after, before);
});

test("plan-review shows build options for lint-clean plans", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await createCompletePlan(root);
  const result = await withMutedConsole(() => planReviewCommand({ root, json: true }));

  assert.equal(result.readyToBuild, true);
  assert.equal(result.suggestedBranch.startsWith("codex/"), true);
  assert.equal(result.nextActions.some((item) => item.label === "Approve build"), true);
  assert.equal(result.nextActions.some((item) => item.label === "Start branch"), true);
});

test("plan-review JSON output includes readyToBuild and nextActions", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await createCompletePlan(root);
  const output = await withCapturedConsole(() => runCli(["plan-review", "--repo", root, "--json"]));
  const parsed = JSON.parse(output.stdout);

  assert.equal(parsed.readyToBuild, true);
  assert.equal(Array.isArray(parsed.nextActions), true);
});

test("plan-approve refuses plans with lint errors", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, intent: "Add branch workflow" });
  });

  await assert.rejects(
    () => withMutedConsole(() => planApproveCommand({ root, json: true, note: "Ready" })),
    /requires a plan-lint pass/
  );
});

test("plan-approve writes approval metadata and decision log", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const approvedAt = new Date("2026-07-08T11:12:13.456Z");

  await createCompletePlan(root);
  await withMutedConsole(async () => {
    await planApproveCommand({ root, json: true, note: "Ready to build", now: approvedAt });
  });

  const tree = await readTree(root);
  const activePlan = JSON.parse(tree[".codex-prep/plans/active-plan.json"]);

  assert.equal(activePlan.status, "approved");
  assert.equal(activePlan.build.status, "approved");
  assert.equal(activePlan.build.approvedAt, approvedAt.toISOString());
  assert.equal(activePlan.build.approvalNote, "Ready to build");
  assert.equal(activePlan.decisionLog.at(-1).event, "approved");
});

test("plan-start refuses without approved plan", async () => {
  const root = await createGitRepo(jsRepoFiles());

  await createCompletePlan(root);

  await assert.rejects(
    () => withMutedConsole(() => planStartCommand({ root, json: true, branch: "codex/workflow-gate" })),
    /requires an approved plan/
  );
});

test("plan-start refuses dirty non-plan worktrees", async () => {
  const root = await createGitRepo(jsRepoFiles());

  await createCompletePlan(root);
  await withMutedConsole(async () => {
    await planApproveCommand({ root, json: true, note: "Ready to build" });
  });
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const answer = 43;\n", "utf8");

  await assert.rejects(
    () => withMutedConsole(() => planStartCommand({ root, json: true, branch: "codex/workflow-gate" })),
    /clean worktree outside \.codex-prep\/plans/
  );
});

test("plan-start creates the requested branch and records base metadata without committing", async () => {
  const root = await createGitRepo(jsRepoFiles());
  const startedAt = new Date("2026-07-08T12:13:14.567Z");

  await createCompletePlan(root);
  await withMutedConsole(async () => {
    await planApproveCommand({ root, json: true, note: "Ready to build" });
  });
  const baseCommit = (await git(root, ["rev-parse", "main"])).stdout.trim();
  const beforeCommits = (await git(root, ["rev-list", "--count", "HEAD"])).stdout.trim();

  const result = await withMutedConsole(() => planStartCommand({
    root,
    json: true,
    branch: "codex/workflow-gate",
    base: "main",
    now: startedAt
  }));

  const currentBranch = (await git(root, ["branch", "--show-current"])).stdout.trim();
  const afterCommits = (await git(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
  const tree = await readTree(root);
  const activePlan = JSON.parse(tree[".codex-prep/plans/active-plan.json"]);

  assert.equal(currentBranch, "codex/workflow-gate");
  assert.equal(result.branch.baseBranch, "main");
  assert.equal(result.branch.baseCommit, baseCommit);
  assert.equal(activePlan.build.status, "in_progress");
  assert.equal(activePlan.build.branchName, "codex/workflow-gate");
  assert.equal(activePlan.build.baseBranch, "main");
  assert.equal(activePlan.build.baseCommit, baseCommit);
  assert.equal(activePlan.build.startedAt, startedAt.toISOString());
  assert.equal(afterCommits, beforeCommits);
});

async function createCompletePlan(root) {
  await withMutedConsole(async () => {
    await planCommand({
      root,
      json: true,
      intent: "Add plan decision gate",
      goal: "Add a decision gate before implementation starts",
      successCriteria: ["plan-review shows approve-build and branch-start options"],
      files: ["src/cli.js", "src/commands.js"],
      validation: ["npm run test", "browser smoke check"],
      nonGoals: ["No dependency installation"],
      riskLevel: "low",
      targetAgent: "codex"
    });
  });
}
