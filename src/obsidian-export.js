import crypto from "node:crypto";
import path from "node:path";
import { writeFileIfChanged } from "./fs-utils.js";

export const OBSIDIAN_EXPORT_DIR = ".codex-prep/obsidian";

const GENERATED_MARKER = "<!-- codex-prep:obsidian-export -->";

export async function exportObsidianGraph(root, graph, options = {}) {
  const outputDir = options.outputDir ?? OBSIDIAN_EXPORT_DIR;
  const notes = buildObsidianNotes(graph, { outputDir });
  const writes = [];

  for (const note of notes) {
    const result = await writeFileIfChanged(path.join(root, note.path), note.content);
    writes.push({
      path: note.path,
      changed: result.changed,
      mode: note.kind
    });
  }

  return {
    format: "obsidian",
    outputDir,
    notes: summarizeNotes(notes),
    writes
  };
}

export function buildObsidianNotes(graph, options = {}) {
  const outputDir = options.outputDir ?? OBSIDIAN_EXPORT_DIR;
  const index = buildNoteIndex(graph);
  const dependentsByFile = buildDependentsByFile(graph);
  const testedSourcesByTest = buildTestSources(graph);
  const notes = [];

  notes.push({
    kind: "obsidian-index",
    path: slashPath(path.posix.join(outputDir, "Index.md")),
    content: renderIndexNote(graph, index)
  });

  for (const file of graph.files ?? []) {
    notes.push({
      kind: file.role === "test" ? "obsidian-test-note" : "obsidian-file-note",
      path: notePath(index.files.get(file.path), outputDir),
      content: file.role === "test"
        ? renderTestNote(file, graph, index, dependentsByFile, testedSourcesByTest)
        : renderFileNote(file, graph, index, dependentsByFile)
    });
  }

  for (const symbol of graph.symbols ?? []) {
    notes.push({
      kind: "obsidian-symbol-note",
      path: notePath(index.symbols.get(symbolKey(symbol)), outputDir),
      content: renderSymbolNote(symbol, index)
    });
  }

  return notes.sort((left, right) => left.path.localeCompare(right.path));
}

function buildNoteIndex(graph) {
  const files = new Map();
  const symbols = new Map();

  for (const file of graph.files ?? []) {
    const directory = file.role === "test" ? "Tests" : "Files";
    files.set(file.path, {
      directory,
      title: file.path,
      slug: stableSlug(file.path, file.path),
      path: file.path
    });
  }

  for (const symbol of graph.symbols ?? []) {
    const key = symbolKey(symbol);
    symbols.set(key, {
      directory: "Symbols",
      title: symbol.name,
      slug: stableSlug(symbol.name, key),
      path: symbol.file
    });
  }

  return { files, symbols };
}

function renderIndexNote(graph, index) {
  const files = graph.files ?? [];
  const tests = files.filter((file) => file.role === "test");
  const sources = files.filter((file) => file.role !== "test");
  const entrypoints = (graph.relationships ?? [])
    .filter((item) => item.kind === "entrypoint")
    .map((item) => item.file)
    .filter(Boolean);

  return [
    GENERATED_MARKER,
    "# Code Graph Index",
    "",
    `Repo: ${graph.repo?.name ?? "unknown"}`,
    `Graph fingerprint: ${graph.fingerprint ?? "unknown"}`,
    "",
    "## Summary",
    "",
    `- Files: ${graph.summary?.fileCount ?? files.length}`,
    `- Import edges: ${graph.summary?.edgeCount ?? 0}`,
    `- Symbols: ${graph.summary?.symbolCount ?? 0}`,
    `- Languages: ${formatInlineList(graph.summary?.languages ?? [])}`,
    "",
    "## Entrypoints",
    "",
    ...listOrNone(entrypoints.map((filePath) => fileLink(index, filePath))),
    "",
    "## Source Files",
    "",
    ...listOrNone(sources.map((file) => fileLink(index, file.path))),
    "",
    "## Tests",
    "",
    ...listOrNone(tests.map((file) => fileLink(index, file.path))),
    "",
    "## Symbols",
    "",
    ...listOrNone((graph.symbols ?? []).map((symbol) => symbolLink(index, symbol)))
  ].join("\n") + "\n";
}

function renderFileNote(file, graph, index, dependentsByFile) {
  return [
    GENERATED_MARKER,
    `# ${file.path}`,
    "",
    `Role: ${file.role}`,
    `Language: ${file.language}`,
    `Confidence: ${file.confidence}`,
    `Size: ${file.size} bytes`,
    "",
    "## Imports",
    "",
    ...listOrNone((file.imports ?? []).map((item) => importLine(index, item))),
    "",
    "## Imported By",
    "",
    ...listOrNone((dependentsByFile.get(file.path) ?? []).map((dependent) => fileLink(index, dependent))),
    "",
    "## Symbols",
    "",
    ...listOrNone((file.symbols ?? []).map((symbol) => symbolLink(index, { ...symbol, file: file.path }))),
    "",
    "## Likely Tests",
    "",
    ...listOrNone((file.relatedTests ?? []).map((item) => `${fileLink(index, item.path)} [${item.confidence}] - ${item.reason}`)),
    "",
    "## Raw Path",
    "",
    `\`${file.path}\``,
    "",
    "## Graph",
    "",
    `Back to ${indexLink()}`
  ].join("\n") + "\n";
}

function renderTestNote(file, graph, index, dependentsByFile, testedSourcesByTest) {
  return [
    GENERATED_MARKER,
    `# ${file.path}`,
    "",
    "Role: test",
    `Language: ${file.language}`,
    `Confidence: ${file.confidence}`,
    "",
    "## Tested Sources",
    "",
    ...listOrNone((testedSourcesByTest.get(file.path) ?? []).map((item) => `${fileLink(index, item.source)} [${item.confidence}] - ${item.reason}`)),
    "",
    "## Imports",
    "",
    ...listOrNone((file.imports ?? []).map((item) => importLine(index, item))),
    "",
    "## Imported By",
    "",
    ...listOrNone((dependentsByFile.get(file.path) ?? []).map((dependent) => fileLink(index, dependent))),
    "",
    "## Symbols",
    "",
    ...listOrNone((file.symbols ?? []).map((symbol) => symbolLink(index, { ...symbol, file: file.path }))),
    "",
    "## Raw Path",
    "",
    `\`${file.path}\``,
    "",
    "## Graph",
    "",
    `Back to ${indexLink()}`
  ].join("\n") + "\n";
}

function renderSymbolNote(symbol, index) {
  return [
    GENERATED_MARKER,
    `# ${symbol.name}`,
    "",
    `Kind: ${symbol.kind}`,
    `Exported: ${symbol.exported ? "yes" : "no"}`,
    `Confidence: ${symbol.confidence}`,
    "",
    "## Defined In",
    "",
    `- ${fileLink(index, symbol.file)}`,
    "",
    "## Raw Name",
    "",
    `\`${symbol.name}\``,
    "",
    "## Graph",
    "",
    `Back to ${indexLink()}`
  ].join("\n") + "\n";
}

function buildDependentsByFile(graph) {
  const dependents = new Map();
  for (const edge of graph.edges ?? []) {
    if (!edge.to) {
      continue;
    }
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }
  for (const [filePath, list] of dependents) {
    dependents.set(filePath, uniqueSorted(list));
  }
  return dependents;
}

function buildTestSources(graph) {
  const tests = new Map();
  for (const relationship of graph.relationships ?? []) {
    if (relationship.kind !== "tested-by") {
      continue;
    }
    const list = tests.get(relationship.test) ?? [];
    list.push({
      source: relationship.source,
      confidence: relationship.confidence,
      reason: relationship.reason
    });
    tests.set(relationship.test, list);
  }
  for (const [testPath, list] of tests) {
    tests.set(testPath, list.sort((left, right) => left.source.localeCompare(right.source)));
  }
  return tests;
}

function importLine(index, item) {
  if (item.resolved) {
    return `${inlineCode(item.specifier)} -> ${fileLink(index, item.resolved)} [${item.confidence}]`;
  }
  return `${inlineCode(item.specifier)} (${item.kind}, ${item.confidence})`;
}

function fileLink(index, filePath) {
  const note = index.files.get(filePath);
  if (!note) {
    return inlineCode(filePath);
  }
  return wikiLink(note, filePath);
}

function symbolLink(index, symbol) {
  const note = index.symbols.get(symbolKey(symbol));
  if (!note) {
    return inlineCode(symbol.name);
  }
  return wikiLink(note, `${symbol.name} (${symbol.kind})`);
}

function indexLink() {
  return "[[Index|Code Graph Index]]";
}

function wikiLink(note, label) {
  return `[[${note.directory}/${note.slug}|${escapeWikiLabel(label)}]]`;
}

function notePath(note, outputDir) {
  return slashPath(path.posix.join(outputDir, note.directory, `${note.slug}.md`));
}

function symbolKey(symbol) {
  return `${symbol.file}\u0000${symbol.name}\u0000${symbol.kind}`;
}

function stableSlug(label, uniqueValue) {
  const base = label
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "note";
  const hash = crypto.createHash("sha256").update(uniqueValue).digest("hex").slice(0, 8);
  return `${base}_${hash}`;
}

function summarizeNotes(notes) {
  return {
    total: notes.length,
    index: notes.filter((note) => note.kind === "obsidian-index").length,
    files: notes.filter((note) => note.kind === "obsidian-file-note").length,
    tests: notes.filter((note) => note.kind === "obsidian-test-note").length,
    symbols: notes.filter((note) => note.kind === "obsidian-symbol-note").length
  };
}

function listOrNone(values) {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function formatInlineList(values) {
  return values.length > 0 ? values.join(", ") : "none";
}

function inlineCode(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function escapeWikiLabel(value) {
  return String(value).replace(/\|/g, "-").replace(/\]/g, ")").replace(/\[/g, "(");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}
