import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyCommand, checkCommand, evalCommand, planCommand, scanCommand } from "../src/commands.js";
import { createTempRepo, jsRepoFiles, readTree, withMutedConsole } from "./helpers.js";

test("scan and plan do not write files", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const before = await readTree(root);

  await withMutedConsole(async () => {
    await scanCommand({ root, json: true });
    await planCommand({ root, json: true });
  });

  const after = await readTree(root);
  assert.deepEqual(after, before);
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
  assert.equal(Boolean(first[".codex-prep/config.json"]), true);
  assert.equal(Boolean(first[".codex-prep/manifest.json"]), true);
  assert.equal(Boolean(first[".agents/skills/repo-onboarding/SKILL.md"]), true);
  assert.equal(Boolean(first[".agents/skills/code-review/SKILL.md"]), true);

  const manifest = JSON.parse(first[".codex-prep/manifest.json"]);
  assert.equal(manifest.repo.root, ".");
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
