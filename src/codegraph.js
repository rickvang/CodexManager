import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists, readJsonIfExists, slashPath } from "./fs-utils.js";
import { collectRepoFiles, scanRepo } from "./scan.js";

export const CODEGRAPH_PATH = ".codex-prep/codegraph.json";

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py"]);
const FILE_LEVEL_EXTENSIONS = new Map([
  [".go", "Go"],
  [".rs", "Rust"],
  [".java", "Java"],
  [".cs", "C#"],
  [".rb", "Ruby"],
  [".php", "PHP"]
]);
const RESOLVABLE_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);

export async function buildCodeGraph(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const manifest = options.manifest ?? await scanRepo(absoluteRoot);
  const allFiles = await collectRepoFiles(absoluteRoot);
  const graphFiles = allFiles.filter(isGraphFile);
  const graphFileSet = new Set(graphFiles);
  const entrypoints = new Set(manifest.discovery?.entrypoints ?? []);
  const records = [];
  const edges = [];
  const symbols = [];

  for (const filePath of graphFiles) {
    const absolutePath = path.join(absoluteRoot, filePath);
    const content = await readText(absolutePath);
    const stats = await fs.stat(absolutePath);
    const language = detectLanguage(filePath);
    const roleInfo = detectRole(filePath, entrypoints);
    const imports = extractImports(filePath, content, language, graphFileSet);
    const fileSymbols = extractSymbols(filePath, content, language);

    for (const item of imports) {
      if (item.resolved) {
        edges.push({
          from: filePath,
          to: item.resolved,
          kind: "imports",
          specifier: item.specifier,
          confidence: item.confidence
        });
      }
    }
    for (const symbol of fileSymbols) {
      symbols.push({ ...symbol, file: filePath });
    }

    records.push({
      path: filePath,
      language,
      size: stats.size,
      role: roleInfo.role,
      confidence: roleInfo.confidence,
      imports,
      symbols: fileSymbols,
      relatedTests: []
    });
  }

  const relationships = buildRelationships(records, edges, entrypoints);
  applyRelatedTests(records, relationships);
  sortGraph(records, edges, symbols, relationships);

  const summary = {
    fileCount: records.length,
    edgeCount: edges.length,
    symbolCount: symbols.length,
    languages: [...new Set(records.map((file) => file.language))].sort(),
    entrypointCount: relationships.filter((item) => item.kind === "entrypoint").length,
    testRelationshipCount: relationships.filter((item) => item.kind === "tested-by").length
  };
  const fingerprint = hashStable({ files: records, edges, symbols, relationships, summary });

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    fingerprint,
    repo: {
      root: absoluteRoot,
      name: path.basename(absoluteRoot)
    },
    summary,
    files: records,
    edges,
    symbols,
    relationships,
    evidence: buildGraphEvidence(summary),
    assumptions: buildGraphAssumptions(records)
  };
}

export async function readCodeGraphIfExists(root) {
  return readJsonIfExists(path.join(root, CODEGRAPH_PATH));
}

export async function loadOrBuildCodeGraph(root, options = {}) {
  const existing = await readCodeGraphIfExists(root);
  if (existing) {
    return { graph: existing, source: CODEGRAPH_PATH };
  }
  return { graph: await buildCodeGraph(root, options), source: "live" };
}

export function queryCodeGraph(graph, query) {
  if (query.file) {
    return queryFile(graph, normalizeQueryPath(query.file));
  }
  if (query.symbol) {
    return querySymbol(graph, query.symbol);
  }
  throw new Error("graph-query requires --file <path> or --symbol <name>");
}

function queryFile(graph, filePath) {
  const file = (graph.files ?? []).find((item) => item.path === filePath);
  if (!file) {
    return { type: "file", query: filePath, found: false, message: `No graph entry found for ${filePath}.` };
  }
  const dependents = (graph.edges ?? []).filter((edge) => edge.to === filePath).map((edge) => edge.from).sort();
  return {
    type: "file",
    query: filePath,
    found: true,
    file,
    imports: file.imports ?? [],
    dependents,
    symbols: file.symbols ?? [],
    relatedTests: file.relatedTests ?? []
  };
}

function querySymbol(graph, name) {
  const normalized = name.toLowerCase();
  const exact = (graph.symbols ?? []).filter((symbol) => symbol.name.toLowerCase() === normalized);
  const partial = exact.length > 0 ? [] : (graph.symbols ?? []).filter((symbol) => symbol.name.toLowerCase().includes(normalized));
  return {
    type: "symbol",
    query: name,
    found: exact.length > 0 || partial.length > 0,
    matches: [...exact, ...partial].sort(compareSymbol)
  };
}

function isGraphFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return JS_EXTENSIONS.has(extension) || PY_EXTENSIONS.has(extension) || FILE_LEVEL_EXTENSIONS.has(extension);
}

function detectLanguage(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") return "TypeScript";
  if (JS_EXTENSIONS.has(extension)) return "JavaScript";
  if (PY_EXTENSIONS.has(extension)) return "Python";
  return FILE_LEVEL_EXTENSIONS.get(extension) ?? "Unknown";
}

function detectRole(filePath, entrypoints) {
  if (entrypoints.has(filePath)) {
    return { role: "entrypoint", confidence: "high" };
  }
  if (isTestFile(filePath)) {
    return { role: "test", confidence: "high" };
  }
  if (/\b(config|settings)\b/i.test(path.basename(filePath))) {
    return { role: "config", confidence: "medium" };
  }
  return { role: "source", confidence: "medium" };
}

function isTestFile(filePath) {
  const parts = filePath.split("/");
  const base = path.posix.basename(filePath).toLowerCase();
  return parts.some((part) => TEST_SEGMENTS.has(part.toLowerCase())) ||
    /(^test_|[._-](test|spec)\.)/.test(base);
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function extractImports(filePath, content, language, fileSet) {
  if (language === "TypeScript" || language === "JavaScript") {
    return extractJavaScriptImports(filePath, content, fileSet);
  }
  if (language === "Python") {
    return extractPythonImports(filePath, content, fileSet);
  }
  return [];
}

function extractJavaScriptImports(filePath, content, fileSet) {
  const imports = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^"'\n]+?\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];
      imports.push({
        specifier,
        resolved: resolveJavaScriptImport(filePath, specifier, fileSet),
        kind: isRelativeSpecifier(specifier) ? "local" : "external",
        confidence: isRelativeSpecifier(specifier) ? "high" : "medium"
      });
    }
  }

  return uniqueImports(imports);
}

function extractPythonImports(filePath, content, fileSet) {
  const imports = [];
  const importPattern = /^\s*import\s+([^#\n]+)/gm;
  const fromPattern = /^\s*from\s+([.A-Za-z0-9_]+)\s+import\s+([^#\n]+)/gm;
  let match;

  while ((match = importPattern.exec(content)) !== null) {
    for (const item of splitPythonImportList(match[1])) {
      imports.push({
        specifier: item,
        resolved: resolvePythonImport(filePath, item, fileSet),
        kind: "module",
        confidence: "medium"
      });
    }
  }

  while ((match = fromPattern.exec(content)) !== null) {
    const moduleName = match[1];
    imports.push({
      specifier: moduleName,
      resolved: resolvePythonImport(filePath, moduleName, fileSet, match[2]),
      kind: moduleName.startsWith(".") ? "local" : "module",
      confidence: moduleName.startsWith(".") ? "high" : "medium"
    });
  }

  return uniqueImports(imports);
}

function splitPythonImportList(value) {
  return value.split(",").map((item) => item.trim().replace(/\s+as\s+.+$/i, "")).filter(Boolean);
}

function resolveJavaScriptImport(filePath, specifier, fileSet) {
  if (!isRelativeSpecifier(specifier)) {
    return null;
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
  return resolveCandidates([
    base,
    ...RESOLVABLE_JS_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_JS_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  ], fileSet);
}

function resolvePythonImport(filePath, specifier, fileSet, importedNames = "") {
  const dirname = path.posix.dirname(filePath);
  const candidates = [];
  if (specifier.startsWith(".")) {
    const dotCount = specifier.match(/^\.+/)?.[0].length ?? 0;
    const rest = specifier.slice(dotCount).replace(/\./g, "/");
    let base = dirname;
    for (let i = 1; i < dotCount; i += 1) {
      base = path.posix.dirname(base);
    }
    const moduleBase = rest ? path.posix.normalize(path.posix.join(base, rest)) : base;
    candidates.push(`${moduleBase}.py`, `${moduleBase}/__init__.py`);
    for (const name of splitPythonImportList(importedNames)) {
      candidates.push(`${moduleBase}/${name}.py`, `${moduleBase}/${name}/__init__.py`);
    }
  } else {
    const modulePath = specifier.replace(/\./g, "/");
    candidates.push(`${modulePath}.py`, `${modulePath}/__init__.py`);
    for (const name of splitPythonImportList(importedNames)) {
      candidates.push(`${modulePath}/${name}.py`, `${modulePath}/${name}/__init__.py`);
    }
  }
  return resolveCandidates(candidates, fileSet);
}

function resolveCandidates(candidates, fileSet) {
  for (const candidate of candidates.map((item) => slashPath(path.posix.normalize(item)))) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isRelativeSpecifier(value) {
  return value.startsWith("./") || value.startsWith("../");
}

function uniqueImports(imports) {
  const seen = new Set();
  return imports.filter((item) => {
    const key = `${item.specifier}\u0000${item.resolved ?? ""}\u0000${item.kind}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((left, right) => `${left.specifier}:${left.resolved}`.localeCompare(`${right.specifier}:${right.resolved}`));
}

function extractSymbols(filePath, content, language) {
  if (language === "TypeScript" || language === "JavaScript") {
    return extractJavaScriptSymbols(content);
  }
  if (language === "Python") {
    return extractPythonSymbols(content);
  }
  return [];
}

function extractJavaScriptSymbols(content) {
  const symbols = [];
  const patterns = [
    { pattern: /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: "function", exported: true, confidence: "high" },
    { pattern: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: "function", exported: true, confidence: "high" },
    { pattern: /^export\s+class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", exported: true, confidence: "high" },
    { pattern: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, kind: "variable", exported: true, confidence: "high" },
    { pattern: /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, kind: "type", exported: true, confidence: "high" },
    { pattern: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: "function", exported: false, confidence: "medium" },
    { pattern: /^class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", exported: false, confidence: "medium" },
    { pattern: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, kind: "variable", exported: false, confidence: "medium" },
    { pattern: /^(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, kind: "type", exported: false, confidence: "medium" }
  ];

  for (const { pattern, kind, exported, confidence } of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      symbols.push({ name: match[1], kind, exported, confidence });
    }
  }

  const exportListPattern = /^export\s*{([^}]+)}/gm;
  let match;
  while ((match = exportListPattern.exec(content)) !== null) {
    for (const item of match[1].split(",")) {
      const [name, alias] = item.trim().split(/\s+as\s+/i).map((value) => value?.trim()).filter(Boolean);
      if (name) {
        symbols.push({ name: alias ?? name, kind: "export", exported: true, confidence: "medium" });
      }
    }
  }

  return uniqueSymbols(symbols);
}

function extractPythonSymbols(content) {
  const symbols = [];
  const patterns = [
    { pattern: /^def\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "function" },
    { pattern: /^class\s+([A-Za-z_][\w]*)\s*[(:]/gm, kind: "class" },
    { pattern: /^([A-Z][A-Z0-9_]+)\s*=/gm, kind: "constant" }
  ];

  for (const { pattern, kind } of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      symbols.push({
        name: match[1],
        kind,
        exported: !match[1].startsWith("_"),
        confidence: "medium"
      });
    }
  }

  return uniqueSymbols(symbols);
}

function uniqueSymbols(symbols) {
  const byName = new Map();
  for (const symbol of symbols) {
    const key = `${symbol.name}\u0000${symbol.kind}`;
    const current = byName.get(key);
    if (!current || confidenceRank(symbol.confidence) > confidenceRank(current.confidence) || symbol.exported) {
      byName.set(key, symbol);
    }
  }
  return [...byName.values()].sort(compareSymbol);
}

function compareSymbol(left, right) {
  return `${left.file ?? ""}:${left.name}:${left.kind}`.localeCompare(`${right.file ?? ""}:${right.name}:${right.kind}`);
}

function confidenceRank(value) {
  return { low: 1, medium: 2, high: 3 }[value] ?? 0;
}

function buildRelationships(files, edges, entrypoints) {
  const relationships = [];
  const records = new Map(files.map((file) => [file.path, file]));
  const tests = files.filter((file) => file.role === "test");
  const sources = files.filter((file) => file.role !== "test");

  for (const entrypoint of entrypoints) {
    if (records.has(entrypoint)) {
      relationships.push({ kind: "entrypoint", file: entrypoint, confidence: "high", reason: "Detected by repo scan." });
    }
  }

  for (const edge of edges) {
    const from = records.get(edge.from);
    const to = records.get(edge.to);
    if (from?.role === "test" && to && to.role !== "test") {
      relationships.push({
        kind: "tested-by",
        source: edge.to,
        test: edge.from,
        confidence: "high",
        reason: "Test file imports source file."
      });
    }
  }

  for (const source of sources) {
    for (const test of tests) {
      if (likelyTestForSource(source.path, test.path)) {
        relationships.push({
          kind: "tested-by",
          source: source.path,
          test: test.path,
          confidence: "medium",
          reason: "Source and test file names match."
        });
      }
    }
  }

  return uniqueRelationships(relationships);
}

function likelyTestForSource(sourcePath, testPath) {
  const sourceStem = normalizedStem(sourcePath);
  const testStem = normalizedStem(testPath);
  return sourceStem.length > 0 && testStem.length > 0 && (sourceStem === testStem || testStem.endsWith(sourceStem));
}

function normalizedStem(filePath) {
  return path.posix.basename(filePath).replace(/\.[^.]+$/, "").replace(/\.(test|spec)$/i, "").replace(/^test_/, "").toLowerCase();
}

function uniqueRelationships(relationships) {
  const seen = new Set();
  return relationships.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
}

function relationshipKey(item) {
  return `${item.kind}:${item.file ?? item.source}:${item.test ?? ""}`;
}

function applyRelatedTests(files, relationships) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const relationship of relationships) {
    if (relationship.kind !== "tested-by") {
      continue;
    }
    const source = byPath.get(relationship.source);
    if (source && !source.relatedTests.some((item) => item.path === relationship.test)) {
      source.relatedTests.push({
        path: relationship.test,
        confidence: relationship.confidence,
        reason: relationship.reason
      });
    }
  }
  for (const file of files) {
    file.relatedTests.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function sortGraph(files, edges, symbols, relationships) {
  files.sort((left, right) => left.path.localeCompare(right.path));
  edges.sort((left, right) => `${left.from}:${left.to}:${left.specifier}`.localeCompare(`${right.from}:${right.to}:${right.specifier}`));
  symbols.sort(compareSymbol);
  relationships.sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
}

function buildGraphEvidence(summary) {
  return [
    { confidence: "high", fact: `Indexed ${summary.fileCount} code files`, source: CODEGRAPH_PATH },
    { confidence: "medium", fact: `Detected ${summary.edgeCount} local import edges`, source: CODEGRAPH_PATH },
    { confidence: "medium", fact: `Detected ${summary.symbolCount} symbols`, source: CODEGRAPH_PATH }
  ];
}

function buildGraphAssumptions(files) {
  const unsupported = files.filter((file) => !["TypeScript", "JavaScript", "Python"].includes(file.language)).length;
  const assumptions = ["Regex extraction is deterministic but not a full compiler or interpreter."];
  if (unsupported > 0) {
    assumptions.push("Unsupported languages are indexed at file level only.");
  }
  return assumptions;
}

function normalizeQueryPath(filePath) {
  return slashPath(filePath).replace(/^\.\//, "");
}

function hashStable(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const internals = {
  detectLanguage,
  extractJavaScriptImports,
  extractJavaScriptSymbols,
  extractPythonImports,
  extractPythonSymbols,
  likelyTestForSource,
  resolveJavaScriptImport,
  resolvePythonImport
};



