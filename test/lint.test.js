import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyCommand, lintCommand } from "../src/commands.js";
import { lintRepo } from "../src/lint.js";
import { createTempRepo, jsRepoFiles, readTree, withMutedConsole } from "./helpers.js";

test("lint passes after apply for a conventional repo", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  const result = await lintRepo(root);

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("lint command is read-only", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });
  const before = await readTree(root);

  await withMutedConsole(async () => {
    await lintCommand({ root, json: true });
  });

  const after = await readTree(root);
  assert.deepEqual(after, before);
});

test("lint reports invalid managed marker pairs", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  await fs.writeFile(path.join(root, "AGENTS.md"), "# Broken\n", "utf8");
  const result = await lintRepo(root);

  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.rule === "invalid-managed-markers" && item.code === "CP002"), true);
});

test("lint reports missing skill frontmatter fields", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  await fs.writeFile(
    path.join(root, ".agents", "skills", "code-review", "SKILL.md"),
    "<!-- codex-prep:begin -->\n---\nname: code-review\n---\n\nBody\n<!-- codex-prep:end -->\n",
    "utf8"
  );
  const result = await lintRepo(root);

  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.rule === "skill-frontmatter-missing-field" && item.code === "CP011"), true);
});

test("lint treats Windows manifest path casing as equivalent", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-only path casing behavior");
    return;
  }

  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  const manifestPath = path.join(root, ".codex-prep", "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.repo.root = root.toUpperCase();
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const result = await lintRepo(root);

  assert.equal(result.findings.some((item) => item.rule === "manifest-root-mismatch"), false);
});

test("lint reports stale paths and secret-looking content", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  await fs.appendFile(path.join(root, "docs", "CODEBASE_MAP.md"), "\nOld path: D:\\Codex\nAPI_TOKEN=abc123\n", "utf8");
  const result = await lintRepo(root);

  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.rule === "stale-path-reference" && item.code === "CP012"), true);
  assert.equal(result.findings.some((item) => item.rule === "secret-looking-content" && item.code === "CP013"), true);
});

test("lint respects disabled rules from config", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  const configPath = path.join(root, ".codex-prep", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.rules.disabled = ["stale-path-reference"];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await fs.appendFile(path.join(root, "docs", "CODEBASE_MAP.md"), "\nOld path: D:\\Codex\n", "utf8");

  const result = await lintRepo(root);

  assert.equal(result.findings.some((item) => item.rule === "stale-path-reference"), false);
});

test("lint respects severity overrides from config", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
  });

  const configPath = path.join(root, ".codex-prep", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.rules.severityOverrides["secret-looking-content"] = "warning";
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await fs.appendFile(path.join(root, "docs", "CODEBASE_MAP.md"), "\nAPI_TOKEN=abc123\n", "utf8");

  const result = await lintRepo(root);

  assert.equal(result.ok, true);
  assert.equal(result.findings.some((item) => item.rule === "secret-looking-content" && item.level === "warning"), true);
});
