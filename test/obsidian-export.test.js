import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { buildCodeGraph } from "../src/codegraph.js";
import { graphExportCommand, refreshGraphCommand } from "../src/commands.js";
import { buildObsidianNotes, OBSIDIAN_EXPORT_DIR } from "../src/obsidian-export.js";
import { createTempRepo, readTree, withCapturedConsole, withMutedConsole } from "./helpers.js";

test("Obsidian export builds a workflow-first graph by default", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  const graph = await buildCodeGraph(root, { generatedAt: "2026-07-08T10:11:12.345Z" });

  const notes = buildObsidianNotes(graph, {
    manifest: obsidianManifest(),
    activePlan: obsidianActivePlan(),
    validationState: obsidianValidationState()
  });
  const index = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Index.md`);
  const workflow = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Workflow.md`);
  const validations = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Validations.md`);
  const troubleshooting = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Troubleshooting.md`);
  const approvalPhase = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Workflow/03 Approval.md`);
  const validationPhase = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Workflow/06 Validation.md`);
  const modulesHub = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Modules.md`);
  const filesHub = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Source Files.md`);
  const testsHub = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Tests.md`);
  const importHub = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Import Graph.md`);
  const srcModule = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Modules/src.md`);
  const sourceNote = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Files/src/math.ts.md`);
  const testNote = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Tests/test/math.test.ts.md`);
  const symbolNote = notes.find((note) => note.path.includes("/Symbols/") && note.content.includes("# add"));

  assert.ok(index);
  assert.ok(workflow);
  assert.ok(validations);
  assert.ok(troubleshooting);
  assert.ok(approvalPhase);
  assert.ok(validationPhase);
  assert.ok(modulesHub);
  assert.ok(filesHub);
  assert.ok(testsHub);
  assert.ok(importHub);
  assert.ok(srcModule);
  assert.ok(sourceNote);
  assert.ok(testNote);
  assert.equal(symbolNote, undefined);
  assert.match(index.content, /\[\[Workflow\|Workflow\]\]/);
  assert.match(index.content, /\[\[Validations\|Validations\]\]/);
  assert.match(index.content, /\[\[Troubleshooting\|Troubleshooting\]\]/);
  assert.match(index.content, /\[\[Modules\|Modules\]\]/);
  assert.match(workflow.content, /\[\[Workflow\/03 Approval\|03 Approval\]\] \(approved\)/);
  assert.match(validations.content, /`npm run verify`/);
  assert.match(validations.content, /Result: pass/);
  assert.match(validationPhase.content, /Status: validated/);
  assert.match(validationPhase.content, /Last validation: pass npm run verify at 2026-07-08T15:00:00.000Z/);
  assert.match(approvalPhase.content, /Approved at: 2026-07-08T10:00:00.000Z/);
  assert.match(filesHub.content, /\[\[Modules\/src\|src\]\]/);
  assert.doesNotMatch(filesHub.content, /\[\[Files\/src\/math\.ts\|src\/math\.ts\]\]/);
  assert.match(srcModule.content, /\[\[Files\/src\/math\.ts\|src\/math\.ts\]\]/);
  assert.match(sourceNote.content, /Area: \[\[Modules\/src\|src\]\]/);
  assert.match(sourceNote.content, /\[\[Tests\/test\/math\.test\.ts\|test\/math\.test\.ts\]\]/);
  assert.match(testNote.content, /\[\[Files\/src\/math\.ts\|src\/math\.ts\]\]/);
  assert.match(sourceNote.content, /add \(function, exported\)/);
  assert.doesNotMatch(sourceNote.content, /\[\[Symbols\//);
});

test("Obsidian export can include symbol notes on request", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  const graph = await buildCodeGraph(root, { generatedAt: "2026-07-08T10:11:12.345Z" });

  const notes = buildObsidianNotes(graph, { includeSymbols: true, manifest: obsidianManifest() });
  const index = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Index.md`);
  const symbolsHub = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Symbols.md`);
  const sourceNote = notes.find((note) => note.path === `${OBSIDIAN_EXPORT_DIR}/Files/src/math.ts.md`);
  const symbolNote = notes.find((note) => note.path.includes("/Symbols/") && note.content.includes("# add"));

  assert.ok(index);
  assert.ok(symbolsHub);
  assert.ok(sourceNote);
  assert.ok(symbolNote);
  assert.match(index.content, /\[\[Symbols\|Symbols\]\]/);
  assert.match(sourceNote.content, /\[\[Symbols\/add_[a-f0-9]{8}\|add \(function\)\]\]/);
  assert.match(symbolNote.content, /\[\[Files\/src\/math\.ts\|src\/math\.ts\]\]/);
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
  assert.equal(first.includeSymbols, false);
  assert.equal(first.notes.index, 1);
  assert.equal(first.notes.workflows, 10);
  assert.equal(first.notes.hubs, 5);
  assert.equal(first.notes.modules, 2);
  assert.equal(first.notes.tests, 1);
  assert.equal(first.notes.files, 2);
  assert.equal(first.notes.symbols, 0);
  assert.equal(first.writes.some((write) => write.changed), true);
  assert.equal(second.writes.every((write) => !write.changed), true);
  assert.deepEqual(secondTree, firstTree);
});

test("graph-export removes stale generated symbol notes when symbols are omitted", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));

  const detailed = await withMutedConsole(() =>
    graphExportCommand({ root, json: true, format: "obsidian", includeSymbols: true })
  );
  const clean = await withMutedConsole(() => graphExportCommand({ root, json: true, format: "obsidian" }));
  const tree = await readTree(root);

  assert.equal(detailed.notes.symbols > 0, true);
  assert.equal(clean.notes.symbols, 0);
  assert.equal(clean.writes.some((write) => write.removed && write.path.includes("/Symbols/")), true);
  assert.equal(Object.keys(tree).some((filePath) => filePath.includes("docs/obsidian-codegraph/Symbols/")), false);
  assert.equal(tree["docs/obsidian-codegraph/Symbols.md"], undefined);
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
  assert.equal(result.includeSymbols, false);
  assert.equal(result.notes.total > 0, true);
  assert.equal(result.notes.workflows, 10);
  assert.equal(result.notes.modules > 0, true);
  assert.equal(result.notes.symbols, 0);
});

test("graph-export CLI supports opt-in symbol notes", async () => {
  const root = await createTempRepo(obsidianGraphFiles());
  await withMutedConsole(() => refreshGraphCommand({ root, json: true }));

  const output = await withCapturedConsole(() =>
    runCli(["graph-export", "--repo", root, "--format", "obsidian", "--include-symbols", "--json"])
  );
  const result = JSON.parse(output.stdout);

  assert.equal(result.includeSymbols, true);
  assert.equal(result.notes.symbols > 0, true);
});

function obsidianGraphFiles() {
  return {
    "package.json": JSON.stringify({ name: "obsidian-graph", type: "module" }, null, 2),
    "src/math.ts": "export function add(left, right) { return left + right; }\n",
    "src/index.ts": "import { add } from './math';\nexport const answer = add(20, 22);\n",
    "test/math.test.ts": "import { add } from '../src/math';\nadd(1, 2);\n"
  };
}

function obsidianManifest() {
  return {
    discovery: {
      commands: [
        { name: "test", command: "npm run test" },
        { name: "verify", command: "npm run verify" }
      ]
    },
    generatedFiles: [
      { path: "AGENTS.md" },
      { path: "docs/CODEBASE_MAP.md" },
      { path: "docs/CODEX_FEEDBACK.md" }
    ]
  };
}

function obsidianValidationState() {
  return {
    latest: {
      schemaVersion: 1,
      recordedAt: "2026-07-08T15:00:00.000Z",
      command: "npm run verify",
      result: "pass",
      phase: "validation",
      summary: "verify passed"
    }
  };
}

function obsidianActivePlan() {
  return {
    status: "approved",
    goal: "Make workflow traversal visible.",
    build: {
      status: "approved",
      approvedAt: "2026-07-08T10:00:00.000Z",
      approvalNote: "Ready to build."
    }
  };
}
