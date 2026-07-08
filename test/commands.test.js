import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  applyCommand,
  checkCommand,
  doctorCommand,
  evalCommand,
  planCloseCommand,
  planCommand,
  planStatusCommand,
  planUpdateCommand,
  scanCommand,
  statusCommand,
  validationRecordCommand
} from "../src/commands.js";
import { createTempRepo, jsRepoFiles, readTree, withMutedConsole } from "./helpers.js";

test("scan and plan with save false do not write files", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const before = await readTree(root);

  await withMutedConsole(async () => {
    await scanCommand({ root, json: true });
    await planCommand({ root, json: true, save: false });
  });

  const after = await readTree(root);
  assert.deepEqual(after, before);
});

test("plan autosaves timestamped latest and active plan JSON", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const now = new Date("2026-07-08T10:11:12.345Z");

  await withMutedConsole(async () => {
    await planCommand({
      root,
      json: true,
      now,
      intent: "Add onboarding guidance",
      scope: ["Generate repo guidance"],
      files: ["AGENTS.md"],
      validation: ["codex-prep lint"],
      questions: ["Should this be committed?"]
    });
  });

  const tree = await readTree(root);
  const historyPath = ".codex-prep/plans/2026-07-08T10-11-12-345Z-plan.json";
  const latestPath = ".codex-prep/plans/latest-plan.json";
  const activePath = ".codex-prep/plans/active-plan.json";
  const historyPlan = JSON.parse(tree[historyPath]);
  const latestPlan = JSON.parse(tree[latestPath]);
  const activePlan = JSON.parse(tree[activePath]);

  assert.equal(Boolean(tree[historyPath]), true);
  assert.equal(Boolean(tree[latestPath]), true);
  assert.equal(Boolean(tree[activePath]), true);
  assert.equal(Boolean(tree["AGENTS.md"]), false);
  assert.equal(historyPlan.status, "draft");
  assert.equal(historyPlan.savedAt, now.toISOString());
  assert.equal(historyPlan.updatedAt, now.toISOString());
  assert.equal(historyPlan.repo.root, ".");
  assert.equal(historyPlan.userIntent, "Add onboarding guidance");
  assert.equal(historyPlan.proposedScope.includes("Generate repo guidance"), true);
  assert.equal(historyPlan.filesLikelyTouched.includes("AGENTS.md"), true);
  assert.equal(historyPlan.validationPlan.includes("codex-prep lint"), true);
  assert.equal(historyPlan.openQuestions.includes("Should this be committed?"), true);
  assert.equal(historyPlan.proposedWrites.some((write) => write.path === "AGENTS.md"), true);
  assert.deepEqual(latestPlan, historyPlan);
  assert.deepEqual(activePlan, historyPlan);
});

test("plan preserves history while replacing latest and active plan", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const first = new Date("2026-07-08T10:11:12.345Z");
  const second = new Date("2026-07-08T10:12:13.456Z");

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, now: first, intent: "First plan" });
    await planCommand({ root, json: true, now: second, intent: "Second plan" });
  });

  const tree = await readTree(root);
  const firstPath = ".codex-prep/plans/2026-07-08T10-11-12-345Z-plan.json";
  const secondPath = ".codex-prep/plans/2026-07-08T10-12-13-456Z-plan.json";
  const latestPlan = JSON.parse(tree[".codex-prep/plans/latest-plan.json"]);
  const activePlan = JSON.parse(tree[".codex-prep/plans/active-plan.json"]);

  assert.equal(Boolean(tree[firstPath]), true);
  assert.equal(Boolean(tree[secondPath]), true);
  assert.equal(JSON.parse(tree[firstPath]).userIntent, "First plan");
  assert.equal(JSON.parse(tree[secondPath]).userIntent, "Second plan");
  assert.equal(latestPlan.savedAt, second.toISOString());
  assert.equal(activePlan.savedAt, second.toISOString());
});

test("plan-update edits active plan and saves an update snapshot", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const created = new Date("2026-07-08T10:11:12.345Z");
  const updated = new Date("2026-07-08T10:12:13.456Z");

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, now: created, intent: "Initial intent" });
    await planUpdateCommand({
      root,
      json: true,
      now: updated,
      intent: "Updated intent",
      status: "approved",
      note: "User approved the plan.",
      scope: ["Touch CLI"],
      files: ["src/cli.js"],
      validation: ["npm.cmd run verify"],
      questions: ["Any adapter needed?"]
    });
  });

  const tree = await readTree(root);
  const updatePath = ".codex-prep/plans/2026-07-08T10-12-13-456Z-plan.json";
  const activePlan = JSON.parse(tree[".codex-prep/plans/active-plan.json"]);
  const updatePlan = JSON.parse(tree[updatePath]);

  assert.equal(Boolean(tree[updatePath]), true);
  assert.equal(activePlan.status, "approved");
  assert.equal(activePlan.userIntent, "Updated intent");
  assert.equal(activePlan.proposedScope.includes("Touch CLI"), true);
  assert.equal(activePlan.filesLikelyTouched.includes("src/cli.js"), true);
  assert.equal(activePlan.validationPlan.includes("npm.cmd run verify"), true);
  assert.equal(activePlan.openQuestions.includes("Any adapter needed?"), true);
  assert.equal(activePlan.decisionLog.at(-1).note, "User approved the plan.");
  assert.deepEqual(updatePlan, activePlan);
});

test("plan-status reads the active plan without editing", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const created = new Date("2026-07-08T10:11:12.345Z");

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, now: created });
  });
  const before = await readTree(root);

  await withMutedConsole(async () => {
    await planStatusCommand({ root, json: true });
  });

  const after = await readTree(root);
  assert.deepEqual(after, before);
});

test("status reads latest validation memory without editing", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const recordedAt = new Date("2026-07-08T14:15:16.789Z");

  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
    await validationRecordCommand({
      root,
      json: true,
      now: recordedAt,
      validationCommand: "npm run verify",
      validationResult: "pass",
      summary: "verify passed"
    });
  });
  const before = await readTree(root);

  const result = await withMutedConsole(() => statusCommand({ root, json: true }));
  const after = await readTree(root);

  assert.deepEqual(after, before);
  assert.equal(result.validation.latest.result, "pass");
  assert.equal(result.validation.latest.command, "npm run verify");
  assert.equal(result.validation.count, 1);
});

test("doctor is read-only and reports stable workflow finding codes", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const before = await readTree(root);

  const result = await withMutedConsole(() => doctorCommand({ root, json: true }));
  const after = await readTree(root);

  assert.deepEqual(after, before);
  assert.equal(result.ok, true);
  assert.equal(result.findings.some((finding) => finding.code === "CM005"), true);
  assert.equal(result.findings.some((finding) => finding.code === "CM007"), true);
  assert.equal(result.findings.some((finding) => finding.code === "CM011"), true);
});

test("validation-record rejects unknown validation outcomes", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await assert.rejects(
    () => validationRecordCommand({ root, json: true, validationCommand: "npm run verify", validationResult: "maybe" }),
    /must be pass or fail/
  );
});

test("plan-close marks active plan terminal", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const created = new Date("2026-07-08T10:11:12.345Z");
  const closed = new Date("2026-07-08T10:13:14.567Z");

  await withMutedConsole(async () => {
    await planCommand({ root, json: true, now: created });
    await planCloseCommand({ root, json: true, now: closed, status: "implemented", note: "Built and verified." });
  });

  const tree = await readTree(root);
  const closePath = ".codex-prep/plans/2026-07-08T10-13-14-567Z-plan.json";
  const activePlan = JSON.parse(tree[".codex-prep/plans/active-plan.json"]);

  assert.equal(Boolean(tree[closePath]), true);
  assert.equal(activePlan.status, "implemented");
  assert.equal(activePlan.updatedAt, closed.toISOString());
  assert.equal(activePlan.decisionLog.at(-1).event, "closed");
  assert.equal(activePlan.decisionLog.at(-1).note, "Built and verified.");
});

test("apply writes the onboarding bundle idempotently", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });
  const first = await readTree(root);

  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });
  const second = await readTree(root);

  assert.deepEqual(second, first);
  assert.equal(Boolean(first["AGENTS.md"]), true);
  assert.equal(Boolean(first["docs/CODEBASE_MAP.md"]), true);
  assert.equal(Boolean(first["docs/CODEX_FEEDBACK.md"]), true);
  assert.equal(Boolean(first["docs/codexmanager-dashboard.md"]), true);
  assert.equal(Boolean(first[".codex-prep/config.json"]), true);
  assert.equal(Boolean(first[".codex-prep/manifest.json"]), true);
  assert.equal(Boolean(first[".codex-prep/codegraph.json"]), true);
  assert.equal(Boolean(first[".agents/skills/repo-onboarding/SKILL.md"]), true);
  assert.equal(Boolean(first[".agents/skills/code-review/SKILL.md"]), true);

  const manifest = JSON.parse(first[".codex-prep/manifest.json"]);
  assert.equal(manifest.repo.root, ".");
  assert.equal(manifest.generatedFiles.some((file) => file.path === ".codex-prep/codegraph.json"), true);
  assert.equal(manifest.generatedFiles.some((file) => file.path === "docs/codexmanager-dashboard.md"), true);
  assert.equal(first["docs/CODEBASE_MAP.md"].includes(root), false);
  assert.equal(first["docs/CODEBASE_MAP.md"].includes("- Root: `.`"), true);
});

test("check catches command drift after apply", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sample-js", scripts: { test: "node --test --watch" } }, null, 2),
    "utf8"
  );

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  await withMutedConsole(async () => {
    await checkCommand({ root, json: true });
  });

  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
});

test("eval passes after apply for a conventional repo", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  await withMutedConsole(async () => {
    await evalCommand({ root, json: true });
  });

  assert.equal(process.exitCode, undefined);
  process.exitCode = originalExitCode;
});
