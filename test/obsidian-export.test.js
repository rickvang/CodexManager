import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { buildCodeGraph } from "../src/codegraph.js";
import { graphExportCommand, refreshGraphCommand } from "../src/commands.js";
import { buildObsidianNotes, OBSIDIAN_EXPORT_DIR } from "../src/obsidian-export.js";
import { createTempRepo, readTree, withCapturedConsole, withMutedConsole } from "./helpers.js";

test("Obsidian export builds linked Markdown notes from the code graph", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  const graph = await buildCodeGraph(root, { generatedAt: "2026-07-08T10:11:12.345Z" });

  const notes = buildObsidianNotes(graph);
  const index = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Index.md`);
  const sourceNote = notes.find((note) => note.path.includes("/Files/") && note.content.includes("# src/math.ts"));
  const testNote = notes.find((note) => note.path.includes("/Tests/") && note.content.includes("# test/math.test.ts"));
  const symbolNote = notes.find((note) => note.path.includes("/Symbols/") && note.content.includes("# add"));

  assert.ok(index);
  assert.ok(sourceNote);
  assert.ok(testNote);
  assert.ok(symbolNote);
  assert.match(index.content, /\[\[Files\/src_math_ts_[a-f0-9]{8}\|src\/math\.ts\]\]/);
  assert.match(sourceNote.content, /\[\[Tests\/test_math_test_ts_[a-f0-9]{8}\|test\/math\.test\.ts\]\]/);
  assert.match(testNote.content, /\[\[Files\/src_math_ts_[a-f0-9]{8}\|src\/math\.ts\]\]/);
  assert.match(symbolNote.content, /\[\[Files\/src_math_ts_[a-f0-9]{8}\|src\/math\.ts\]\]/);
});

test("graph-export writes deterministic Obsidian notes without churn", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));

  const first = await withMutedConsole(() => graphExportCommand({ root, json: true, format: "obsidian" }));
  const firstTree = await readTree(root);
  const second = await withMutedConsole(() => graphExportCommand({ root, json: true, format: "obsidian" }));
  const secondTree = await readTree(root);

  assert.equal(first.format, "obsidian");
  assert.equal(first.outputDir, OBSIDIAN_EXPORT_DIR);
  assert.equal(first.notes.index, 1);
  assert.equal(first.notes.tests, 1);
  assert.equal(first.notes.files, 2);
  assert.equal(first.notes.symbols >= 1, true);
  assert.equal(first.writes.some((write) => write.changed), true);
  assert.equal(second.writes.every((write) => !write.changed), true);
  assert.deepEqual(secondTree, firstTree);
});

test("graph-export CLI supports Obsidian JSON output", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));

  const output = await withCapturedConsole(() =>
    runCli(["graph-export", "--repo", root, "--format", "obsidian", "--json"])
  );
  const result = JSON.parse(output.stdout);

  assert.equal(result.format, "obsidian");
  assert.equal(result.outputDir, OBSIDIAN_EXPORT_DIR);
  assert.equal(result.notes.total > 0, true);
});

function obsidianGraphFiles() {
  return {
    "package.json": JSON.stringify({ name: "obsidian-graph", type: "module" }, null, 2),
    "src/math.ts": "export function add(left, right) { return left + right; }\n",
    "src/index.ts": "import { add } from './math';\nexport const answer = add(20, 22);\n",
    "test/math.test.ts": "import { add } from '../src/math';\nadd(1, 2);\n"
  };
}
