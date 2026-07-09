import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { buildCodeGraph, orientCodeGraph, queryCodeGraph } from "../src/codegraph.js";
import {
  applyCommand,
  checkCommand,
  graphCommand,
  graphQueryCommand,
  refreshGraphCommand
} from "../src/commands.js";
import { createTempRepo, jsRepoFiles, readTree, withCapturedConsole, withMutedConsole } from "./helpers.js";

test("code graph extracts JavaScript and TypeScript imports, symbols, and tests", async () => {
  const root = await createTempRepo(jsGraphFiles());

  const graph = await buildCodeGraph(root, { generatedAt: "2026-07-08T10:11:12.345Z" });

  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.summary.fileCount, 3);
  assert.equal(graph.summary.edgeCount, 2);
  assert.equal(graph.summary.symbolCount >= 2, true);
  assert.equal(graph.edges.some((edge) => edge.from === "src/index.ts" && edge.to === "src/math.ts"), true);
  assert.equal(graph.edges.some((edge) => edge.from === "tests/math.test.ts" && edge.to === "src/math.ts"), true);
  assert.equal(graph.symbols.some((symbol) => symbol.name === "add" && symbol.file === "src/math.ts" && symbol.exported), true);
  assert.equal(graph.relationships.some((item) => item.kind === "tested-by" && item.source === "src/math.ts" && item.test === "tests/math.test.ts"), true);
});

test("code graph extracts Python imports, functions, and classes", async () => {
  const root = await createTempRepo(pythonGraphFiles());

  const graph = await buildCodeGraph(root, { generatedAt: "2026-07-08T10:11:12.345Z" });

  assert.equal(graph.summary.languages.includes("Python"), true);
  assert.equal(graph.edges.some((edge) => edge.from === "pkg/app.py" && edge.to === "pkg/core.py"), true);
  assert.equal(graph.edges.some((edge) => edge.from === "tests/test_core.py" && edge.to === "pkg/core.py"), true);
  assert.equal(graph.symbols.some((symbol) => symbol.name === "run" && symbol.kind === "function"), true);
  assert.equal(graph.symbols.some((symbol) => symbol.name === "Worker" && symbol.kind === "class"), true);
});

test("code graph handles mixed repos and file-level fallback languages", async () => {
  const root = await createTempRepo({
    "package.json": JSON.stringify({ name: "mixed", type: "module" }, null, 2),
    "packages/app/src/index.ts": "export const app = true;\n",
    "packages/app/test/index.test.ts": "import { app } from '../src/index';\n",
    "cmd/main.go": "package main\nfunc main() {}\n"
  });

  const graph = await buildCodeGraph(root);

  assert.equal(graph.files.some((file) => file.path === "cmd/main.go" && file.language === "Go"), true);
  assert.equal(graph.files.some((file) => file.path === "packages/app/src/index.ts"), true);
});

test("code graph handles minimal repos", async () => {
  const root = await createTempRepo({ "README.md": "# Empty\n" });

  const graph = await buildCodeGraph(root);

  assert.equal(graph.summary.fileCount, 0);
  assert.deepEqual(graph.files, []);
});

test("graph queries file imports, dependents, symbols, and related tests", async () => {
  const root = await createTempRepo(jsGraphFiles());
  const graph = await buildCodeGraph(root);

  const fileResult = queryCodeGraph(graph, { file: "src/math.ts" });
  const symbolResult = queryCodeGraph(graph, { symbol: "add" });

  assert.equal(fileResult.found, true);
  assert.deepEqual(fileResult.dependents, ["src/index.ts", "tests/math.test.ts"]);
  assert.equal(fileResult.relatedTests.some((item) => item.path === "tests/math.test.ts"), true);
  assert.equal(symbolResult.found, true);
  assert.equal(symbolResult.matches.some((item) => item.file === "src/math.ts"), true);
});

test("orient builds a compact task-aware reading list with related tests", async () => {
  const root = await createTempRepo(jsGraphFiles());
  const graph = await buildCodeGraph(root);

  const result = orientCodeGraph(graph, {
    task: "change add math behavior",
    commands: [{ name: "test", command: "npm run test", source: "package.json" }],
    limit: 2,
    source: "test"
  });

  assert.equal(result.readingList.some((item) => item.path === "src/math.ts"), true);
  assert.equal(result.readingList.some((item) => item.path === "tests/math.test.ts"), true);
  assert.equal(result.relatedTests.some((item) => item.path === "tests/math.test.ts"), true);
  assert.equal(result.validationCommands.some((item) => item.command === "npm run test"), true);
  assert.equal(result.contextEstimate.selectedBytes < result.contextEstimate.totalGraphBytes, true);
});

test("orient respects limits and returns fallback searches for weak matches", async () => {
  const root = await createTempRepo(jsGraphFiles());
  const graph = await buildCodeGraph(root);

  const result = orientCodeGraph(graph, { task: "totally unknown workflow", limit: 1 });

  assert.equal(result.readingList.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.fallbackSearches.length > 0, true);
});

test("graph queries support limit and neighbor depth", async () => {
  const root = await createTempRepo(jsGraphFiles());
  const graph = await buildCodeGraph(root);

  const limitedFile = queryCodeGraph(graph, { file: "src/math.ts", limit: 1, depth: 1 });
  const limitedSymbol = queryCodeGraph(graph, { symbol: "add", limit: 1 });

  assert.equal(limitedFile.dependents.length, 1);
  assert.equal(limitedFile.limits.truncated.dependents, true);
  assert.equal(limitedFile.neighbors.length, 1);
  assert.equal(limitedSymbol.matches.length, 1);
  assert.equal(limitedSymbol.limits.limit, 1);
});
test("graph command is read-only", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const before = await readTree(root);

  await withMutedConsole(() => graphCommand({ root, json: true }));
  const after = await readTree(root);

  assert.deepEqual(after, before);
});

test("refresh-graph writes codegraph json", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));
  const tree = await readTree(root);
  const graph = JSON.parse(tree[".codex-prep/codegraph.json"]);

  assert.equal(graph.repo.root, ".");
  assert.equal(graph.files.some((file) => file.path === "src/index.ts"), true);
});

test("graph-query CLI supports file and symbol JSON output", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));

  const byFile = await withCapturedConsole(() => runCli(["graph-query", "--repo", root, "--file", "src/index.ts", "--json"]));
  const bySymbol = await withCapturedConsole(() => runCli(["graph-query", "--repo", root, "--symbol", "answer", "--json"]));
  const limited = await withCapturedConsole(() => runCli(["graph-query", "--repo", root, "--file", "src/index.ts", "--limit", "1", "--depth", "1", "--json"]));

  assert.equal(JSON.parse(byFile.stdout).found, true);
  assert.equal(JSON.parse(bySymbol.stdout).found, true);
  assert.equal(JSON.parse(limited.stdout).limits.limit, 1);
});

test("orient CLI returns a stable JSON reading list", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));

  const output = await withCapturedConsole(() => runCli(["orient", "--repo", root, "--task", "change answer behavior", "--limit", "2", "--json"]));
  const parsed = JSON.parse(output.stdout);

  assert.equal(parsed.task, "change answer behavior");
  assert.equal(Array.isArray(parsed.readingList), true);
  assert.equal(parsed.readingList.length > 0, true);
  assert.equal(parsed.readingList.length <= 2, true);
  assert.equal(Boolean(parsed.contextEstimate.estimatedSelectedTokens), true);
});
test("check detects stale code graph output", async () => {
  const root = await createTempRepo(jsRepoFiles());
  await withMutedConsole(() => applyCommand({ root, json: true }));
  await fs.writeFile(path.join(root, "src", "extra.ts"), "export const extra = true;\n", "utf8");

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  await withMutedConsole(() => checkCommand({ root, json: true }));

  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
});

test("graph-query command returns no-match for missing files", async () => {
  const root = await createTempRepo(jsRepoFiles());

  const result = await withMutedConsole(() => graphQueryCommand({ root, json: true, file: "src/missing.ts" }));

  assert.equal(result.found, false);
});

function jsGraphFiles() {
  return {
    "package.json": JSON.stringify({ name: "graph-js", type: "module" }, null, 2),
    "src/math.ts": "export function add(left, right) { return left + right; }\nexport class Calculator {}\n",
    "src/index.ts": "import { add } from './math';\nexport const answer = add(20, 22);\n",
    "tests/math.test.ts": "import { add } from '../src/math';\nadd(1, 2);\n"
  };
}

function pythonGraphFiles() {
  return {
    "pyproject.toml": "[tool.pytest.ini_options]\npythonpath = ['.']\n",
    "pkg/__init__.py": "",
    "pkg/core.py": "def run():\n    return 42\n\nclass Worker:\n    pass\n",
    "pkg/app.py": "from .core import run\nprint(run())\n",
    "tests/test_core.py": "from pkg.core import run\nrun()\n"
  };
}
