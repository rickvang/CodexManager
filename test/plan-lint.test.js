import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { internals, planCommand, planLintCommand, planUpdateCommand } from "../src/commands.js";
import { createTempRepo, jsRepoFiles, readTree, withCapturedConsole, withMutedConsole } from "./helpers.js";

test("normalizePlan backfills planning quality fields for legacy plans", () => {
  const plan = internals.normalizePlan({
    schemaVersion: 1,
    kind: "codex-prep-plan",
    status: "draft",
    savedAt: "2026-07-08T10:11:12.345Z",
    repo: { root: "D:/old/repo", name: "repo" },
    userIntent: "Legacy plan",
    validationPlan: ["npm run test"]
  });

  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.repo.root, ".");
  assert.equal(plan.goal, "");
  assert.deepEqual(plan.successCriteria, []);
  assert.deepEqual(plan.nonGoals, []);
  assert.deepEqual(plan.stopRules, []);
  assert.deepEqual(plan.forbiddenActions, []);
  assert.deepEqual(plan.approvalBoundaries, []);
  assert.equal(plan.riskLevel, "medium");
  assert.equal(plan.targetAgent, "");
  assert.equal(plan.build.status, "not_started");
});

test("plan-update records planning quality fields", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const created = new Date("2026-07-08T10:11:12.345Z");
  const updated = new Date("2026-07-08T10:12:13.456Z");

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, now: created, intent: "Initial intent" });
    await planUpdateCommand({
      root,
      json: true,
      now: updated,
      goal: "Make saved plans implementation-ready",
      successCriteria: ["plan-lint reports pass or only accepted warnings"],
      nonGoals: ["No external prompt corpus import"],
      stopRules: ["Stop after npm.cmd run verify passes"],
      forbiddenActions: ["Do not push without explicit approval"],
      approvalBoundaries: ["Commit and push require separate approval"],
      riskLevel: "high",
      targetAgent: "codex"
    });
  });

  const tree = await readTree(root);
  const activePlan = JSON.parse(tree[".codex-prep/plans/active-plan.json"]);

  assert.equal(activePlan.goal, "Make saved plans implementation-ready");
  assert.equal(activePlan.successCriteria.includes("plan-lint reports pass or only accepted warnings"), true);
  assert.equal(activePlan.nonGoals.includes("No external prompt corpus import"), true);
  assert.equal(activePlan.stopRules.includes("Stop after npm.cmd run verify passes"), true);
  assert.equal(activePlan.forbiddenActions.includes("Do not push without explicit approval"), true);
  assert.equal(activePlan.approvalBoundaries.includes("Commit and push require separate approval"), true);
  assert.equal(activePlan.riskLevel, "high");
  assert.equal(activePlan.targetAgent, "codex");
});

test("plan-lint passes for a complete saved plan", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await planCommand({
      root,
      json: true,
      intent: "Add plan-lint",
      goal: "Check saved plans before implementation",
      successCriteria: ["plan-lint reports pass"],
      files: ["src/cli.js", "src/plan-lint.js"],
      validation: ["browser smoke check"],
      nonGoals: ["No dependency installation"],
      riskLevel: "low",
      targetAgent: "codex"
    });
  });

  const result = await withoutExitLeak(() => withMutedConsole(() => planLintCommand({ root, json: true })));

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("plan-lint fails when success criteria are missing", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await planCommand({
      root,
      json: true,
      intent: "Add plan-lint",
      goal: "Check saved plans before implementation",
      files: ["src/cli.js"],
      validation: ["browser smoke check"],
      nonGoals: ["No dependency installation"],
      targetAgent: "codex"
    });
  });

  const result = await withoutExitLeak(() => withMutedConsole(() => planLintCommand({ root, json: true })));

  assert.equal(result.ok, false);
  assert.equal(result.findings.some((finding) => finding.code === "CP203"), true);
});

test("plan-lint json output includes stable rule codes", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, intent: "Add plan-lint", goal: "Check saved plans", files: ["src/cli.js"] });
  });

  const output = await withoutExitLeak(() => withCapturedConsole(() => runCli(["plan-lint", "--repo", root, "--json"])));
  const parsed = JSON.parse(output.stdout);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.findings.some((finding) => finding.code === "CP203"), true);
});

test("plan-lint fails high-risk plans without approval boundaries", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await writeActivePlan(root, completePlan({
    goal: "Run database migration",
    userIntent: "Run database migration",
    riskLevel: "high",
    approvalBoundaries: [],
    forbiddenActions: ["Do not push without explicit approval"],
    validationPlan: ["npm run test"]
  }));

  const result = await withoutExitLeak(() => withMutedConsole(() => planLintCommand({ root, json: true })));

  assert.equal(result.ok, false);
  assert.equal(result.findings.some((finding) => finding.code === "CP206"), true);
});

test("plan-lint suggests existing Playwright validation without installing dependencies", async () => {
  const root = await createTempRepo(playwrightRepoFiles());
  await writeActivePlan(root, completePlan({ validationPlan: ["npm run test"] }));
  const before = await readTree(root);

  const result = await withoutExitLeak(() => withMutedConsole(() => planLintCommand({ root, json: true })));
  const after = await readTree(root);

  assert.equal(result.ok, true);
  assert.equal(result.findings.some((finding) => finding.code === "CP214" && finding.message.includes("npm run e2e")), true);
  assert.equal(result.detected.playwrightCommand, "npm run e2e");
  assert.deepEqual(after, before);
});

test("plan-lint warns for web repos without browser validation and remains read-only", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await writeActivePlan(root, completePlan({ validationPlan: ["npm run test"] }));
  const before = await readTree(root);

  const result = await withoutExitLeak(() => withMutedConsole(() => planLintCommand({ root, json: true })));
  const after = await readTree(root);

  assert.equal(result.ok, true);
  assert.equal(result.findings.some((finding) => finding.code === "CP213"), true);
  assert.deepEqual(after, before);
});

test("plan-lint reports missing active plans", async () => {
  const root = await createTempRepo(jsRepoFiles());

  const result = await withoutExitLeak(() => withMutedConsole(() => planLintCommand({ root, json: true })));

  assert.equal(result.ok, false);
  assert.equal(result.findings.some((finding) => finding.code === "CP201"), true);
});

function completePlan(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: "codex-prep-plan",
    status: "draft",
    savedAt: "2026-07-08T10:11:12.345Z",
    updatedAt: "2026-07-08T10:11:12.345Z",
    repo: { root: ".", name: "sample" },
    summary: "Test plan",
    goal: "Improve planning quality",
    userIntent: "Improve planning quality",
    proposedScope: ["Add plan linting"],
    filesLikelyTouched: ["src/cli.js"],
    validationPlan: ["npm run test"],
    successCriteria: ["plan-lint reports pass or accepted warnings"],
    nonGoals: ["No dependency installation"],
    stopRules: ["Stop after listed validation passes"],
    forbiddenActions: ["Do not commit or push without explicit approval"],
    approvalBoundaries: ["Edits, commits, and pushes require separate approval"],
    riskLevel: "medium",
    targetAgent: "codex",
    openQuestions: [],
    decisionLog: [],
    proposedWrites: [],
    assumptions: [],
    evidence: [],
    ...overrides
  };
}

async function writeActivePlan(root, plan) {
  const plansDir = path.join(root, ".codex-prep", "plans");
  await fs.mkdir(plansDir, { recursive: true });
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  await fs.writeFile(path.join(plansDir, "active-plan.json"), content, "utf8");
  await fs.writeFile(path.join(plansDir, "latest-plan.json"), content, "utf8");
}

function playwrightRepoFiles() {
  return {
    "package.json": JSON.stringify(
      {
        name: "sample-playwright",
        type: "module",
        scripts: {
          test: "node --test",
          e2e: "playwright test"
        },
        dependencies: {
          react: "^19.0.0"
        },
        devDependencies: {
          "@playwright/test": "^1.0.0"
        }
      },
      null,
      2
    ),
    "playwright.config.ts": "export default {};\n",
    "src/index.tsx": "export const App = () => null;\n",
    "test/index.test.js": "import test from 'node:test';\n"
  };
}

async function withoutExitLeak(callback) {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    return await callback();
  } finally {
    process.exitCode = originalExitCode;
  }
}
