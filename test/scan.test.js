import assert from "node:assert/strict";
import test from "node:test";
import { createTempRepo, jsRepoFiles } from "./helpers.js";
import { scanRepo } from "../src/scan.js";

test("scan detects a JavaScript and TypeScript repo", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const manifest = await scanRepo(root);

  assert.equal(manifest.repo.name.startsWith("codex-prep-"), true);
  assert.equal(manifest.discovery.packageManagers.includes("npm"), true);
  assert.equal(manifest.discovery.languages.includes("JavaScript"), true);
  assert.equal(manifest.discovery.languages.includes("TypeScript"), true);
  assert.equal(manifest.discovery.frameworks.includes("React"), true);
  assert.equal(manifest.discovery.frameworks.includes("Vitest"), true);
  assert.deepEqual(manifest.discovery.sourceRoots, ["src"]);
  assert.deepEqual(manifest.discovery.testRoots, ["tests"]);
  assert.equal(manifest.discovery.commands.some((command) => command.name === "test"), true);
  assert.equal(manifest.discovery.ci.includes(".github/workflows/ci.yml"), true);
});

test("scan detects a Python repo with pytest", async () => {
  const root = await createTempRepo({
    "pyproject.toml": "[project]\nname = \"sample-py\"\n[tool.pytest.ini_options]\n",
    "src/sample/__init__.py": "",
    "tests/test_app.py": "def test_app():\n    assert True\n"
  });
  const manifest = await scanRepo(root);

  assert.deepEqual(manifest.discovery.packageManagers, ["pip"]);
  assert.equal(manifest.discovery.languages.includes("Python"), true);
  assert.equal(manifest.discovery.frameworks.includes("pytest"), true);
  assert.deepEqual(manifest.discovery.sourceRoots, ["src"]);
  assert.deepEqual(manifest.discovery.testRoots, ["tests"]);
  assert.equal(manifest.discovery.commands[0].command, "python -m pytest");
});

test("scan handles a minimal repo without inventing commands", async () => {
  const root = await createTempRepo({
    "README.md": "# Minimal\n"
  });
  const manifest = await scanRepo(root);

  assert.deepEqual(manifest.discovery.commands, []);
  assert.deepEqual(manifest.discovery.packageManagers, []);
  assert.equal(manifest.assumptions.some((item) => item.includes("No validation commands")), true);
});

test("scan ignores codex-prep generated artifacts and secret files", async () => {
  const root = await createTempRepo({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "src/index.js": "console.log('ok');\n",
    "tests/index.test.js": "import test from 'node:test';\n",
    "AGENTS.md": "generated\n",
    "docs/CODEBASE_MAP.md": "generated\n",
    ".codex-prep/manifest.json": "{}\n",
    ".agents/skills/code-review/SKILL.md": "generated\n",
    ".env": "SECRET_TOKEN=do-not-copy\n"
  });
  const manifest = await scanRepo(root);

  assert.equal(manifest.discovery.importantFiles.includes("AGENTS.md"), false);
  assert.equal(manifest.discovery.docs.includes("docs/CODEBASE_MAP.md"), false);
  assert.equal(JSON.stringify(manifest).includes("SECRET_TOKEN"), false);
});
