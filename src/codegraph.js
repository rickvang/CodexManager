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
const TASK_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "onto", "about", "change", "update",
  "add", "make", "build", "implement", "fix", "work", "code", "file", "files", "repo", "project"
]);
const VALIDATION_COMMAND_PATTERN = /\b(test|verify|lint|check|build|eval|typecheck|e2e|playwright)\b/i;

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
  const options = {
    limit: normalizePositiveInteger(query.limit, "limit"),
    depth: normalizeDepth(query.depth)
  };
  if (query.file) {
    return queryFile(graph, normalizeQueryPath(query.file), options);
  }
  if (query.symbol) {
    return querySymbol(graph, query.symbol, options);
  }
  throw new Error("graph-query requires --file <path> or --symbol <name>");
}

export function orientCodeGraph(graph, options = {}) {
  const task = String(options.task ?? "").trim();
  if (!task) {
    throw new Error("orient requires --task <text>");
  }

  const limit = normalizePositiveInteger(options.limit, "limit") ?? 8;
  const terms = tokenize(task);
  const files = graph.files ?? [];
  const ranked = rankOrientationFiles(graph, terms, task);
  const selected = selectOrientationFiles(graph, ranked, limit);
  const entrypoints = (graph.relationships ?? [])
    .filter((item) => item.kind === "entrypoint")
    .map((item) => ({ path: item.file, confidence: item.confidence, reason: item.reason }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const readingList = selected.map((item) => orientationFileSummary(item.file, item.score, item.reasons));
  const relatedTests = readingList.filter((item) => item.role === "test").map((item) => ({
    path: item.path,
    confidence: item.confidence,
    reason: item.reasons.join("; ")
  }));
  const validationCommands = validationCommandSummaries(options.commands ?? []);
  const contextEstimate = buildContextEstimate(files, readingList);
  const lowConfidence = readingList.length === 0 || readingList.every((item) => item.confidence === "low");

  return {
    task,
    source: options.source ?? "graph",
    terms,
    readingList,
    relatedTests,
    entrypoints: entrypoints.slice(0, limit),
    validationCommands,
    contextEstimate,
    fallbackSearches: buildFallbackSearches(terms, task, lowConfidence),
    warnings: lowConfidence ? ["Low-confidence graph match. Use the fallback searches before editing."] : []
  };
}

function queryFile(graph, filePath, options = {}) {
  const file = (graph.files ?? []).find((item) => item.path === filePath);
  if (!file) {
    return { type: "file", query: filePath, found: false, message: `No graph entry found for ${filePath}.` };
  }
  const dependents = (graph.edges ?? []).filter((edge) => edge.to === filePath).map((edge) => edge.from).sort();
  const imports = file.imports ?? [];
  const symbols = file.symbols ?? [];
  const relatedTests = file.relatedTests ?? [];
  const allNeighbors = collectNeighborFiles(graph, filePath, options.depth ?? 1);
  const neighbors = limitList(allNeighbors, options.limit);
  return {
    type: "file",
    query: filePath,
    found: true,
    file,
    imports: limitList(imports, options.limit),
    dependents: limitList(dependents, options.limit),
    symbols: limitList(symbols, options.limit),
    relatedTests: limitList(relatedTests, options.limit),
    neighbors,
    limits: buildLimitSummary(options.limit, {
      imports,
      dependents,
      symbols,
      relatedTests,
      neighbors: allNeighbors
    }, { depth: options.depth ?? 1 })
  };
}

function querySymbol(graph, name, options = {}) {
  const normalized = name.toLowerCase();
  const exact = (graph.symbols ?? []).filter((symbol) => symbol.name.toLowerCase() === normalized);
  const partial = exact.length > 0 ? [] : (graph.symbols ?? []).filter((symbol) => symbol.name.toLowerCase().includes(normalized));
  const matches = [...exact, ...partial].sort(compareSymbol);
  return {
    type: "symbol",
    query: name,
    found: matches.length > 0,
    matches: limitList(matches, options.limit),
    limits: buildLimitSummary(options.limit, { matches })
  };
}

function rankOrientationFiles(graph, terms, task) {
  const phrase = task.toLowerCase();
  const files = graph.files ?? [];
  const dependentsByPath = dependentsByTarget(graph.edges ?? []);

  return files.map((file) => {
    const reasons = [];
    let score = 0;
    const pathText = file.path.toLowerCase();
    const pathTokens = tokenize(file.path);
    const basename = path.posix.basename(file.path).toLowerCase();

    if (phrase.length > 2 && pathText.includes(phrase)) {
      score += 20;
      reasons.push("task phrase appears in file path");
    }

    for (const term of terms) {
      if (pathText.includes(term)) {
        score += basename.includes(term) ? 10 : 6;
        reasons.push(`path matches "${term}"`);
      } else if (pathTokens.includes(term)) {
        score += 4;
        reasons.push(`path token matches "${term}"`);
      }
    }

    for (const symbol of file.symbols ?? []) {
      const symbolTokens = tokenize(symbol.name);
      const symbolName = symbol.name.toLowerCase();
      for (const term of terms) {
        if (symbolName === term || symbolTokens.includes(term)) {
          score += symbol.exported ? 24 : 18;
          reasons.push(`symbol ${symbol.name} matches "${term}"`);
        } else if (symbolName.includes(term)) {
          score += symbol.exported ? 12 : 8;
          reasons.push(`symbol ${symbol.name} partially matches "${term}"`);
        }
      }
    }

    for (const item of file.imports ?? []) {
      const importText = `${item.specifier} ${item.resolved ?? ""}`.toLowerCase();
      for (const term of terms) {
        if (importText.includes(term)) {
          score += item.resolved ? 5 : 2;
          reasons.push(`import matches "${term}"`);
        }
      }
    }

    for (const dependent of dependentsByPath.get(file.path) ?? []) {
      const dependentText = dependent.toLowerCase();
      for (const term of terms) {
        if (dependentText.includes(term)) {
          score += 3;
          reasons.push(`dependent ${dependent} matches "${term}"`);
        }
      }
    }

    if (file.role === "entrypoint" && terms.some((term) => ["entry", "entrypoint", "start", "main", "app", "cli"].includes(term))) {
      score += 12;
      reasons.push("entrypoint role matches task");
    }
    if (file.role === "test" && terms.some((term) => ["test", "tests", "spec", "verify"].includes(term))) {
      score += 10;
      reasons.push("test role matches task");
    }

    return { file, score, reasons: uniqueStrings(reasons) };
  }).sort(compareOrientationCandidate);
}

function selectOrientationFiles(graph, ranked, limit) {
  const byPath = new Map((graph.files ?? []).map((file) => [file.path, file]));
  const positives = ranked.filter((item) => item.score > 0);
  const candidates = positives.length > 0 ? positives : fallbackOrientationCandidates(graph, ranked);
  const selected = new Map();
  const primaryBudget = limit <= 2 ? 1 : Math.max(1, Math.ceil(limit * 0.6));

  for (const candidate of candidates.filter((item) => item.file.role !== "test")) {
    addOrientationCandidate(selected, candidate);
    if (selected.size >= primaryBudget) {
      break;
    }
  }

  if (selected.size === 0) {
    for (const candidate of candidates) {
      addOrientationCandidate(selected, candidate);
      if (selected.size >= primaryBudget) {
        break;
      }
    }
  }

  for (const candidate of selected.values()) {
    if (candidate.file.role === "test") {
      continue;
    }
    for (const testRef of candidate.file.relatedTests ?? []) {
      const testFile = byPath.get(testRef.path);
      if (testFile) {
        addOrientationCandidate(selected, {
          file: testFile,
          score: Math.max(candidate.score - 2, 1),
          reasons: [`related test for ${candidate.file.path}`]
        });
      }
      if (selected.size >= limit) {
        break;
      }
    }
    if (selected.size >= limit) {
      break;
    }
  }

  for (const candidate of candidates) {
    if (selected.size >= limit) {
      break;
    }
    addOrientationCandidate(selected, candidate);
  }

  return [...selected.values()].slice(0, limit);
}

function fallbackOrientationCandidates(graph, ranked) {
  const entrypointPaths = new Set((graph.relationships ?? []).filter((item) => item.kind === "entrypoint").map((item) => item.file));
  const fallback = ranked.filter((item) => entrypointPaths.has(item.file.path));
  if (fallback.length > 0) {
    return fallback.map((item) => ({ ...item, score: 1, reasons: ["fallback entrypoint"] }));
  }
  return ranked.slice(0, 3).map((item) => ({ ...item, score: 1, reasons: ["fallback graph file"] }));
}

function addOrientationCandidate(selected, candidate) {
  const current = selected.get(candidate.file.path);
  if (!current || candidate.score > current.score) {
    selected.set(candidate.file.path, candidate);
  }
}

function orientationFileSummary(file, score, reasons) {
  return {
    path: file.path,
    role: file.role,
    language: file.language,
    confidence: confidenceForScore(score),
    score,
    size: file.size ?? 0,
    reasons: reasons.length > 0 ? reasons : ["selected by graph fallback"],
    symbols: (file.symbols ?? []).slice(0, 5).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      confidence: symbol.confidence
    }))
  };
}

function collectNeighborFiles(graph, startPath, depth) {
  if (!depth || depth < 1) {
    return [];
  }

  const byPath = new Map((graph.files ?? []).map((file) => [file.path, file]));
  const seen = new Set([startPath]);
  let frontier = [startPath];
  const neighbors = [];

  for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
    const next = [];
    for (const currentPath of frontier) {
      for (const edge of graph.edges ?? []) {
        const targets = [];
        if (edge.from === currentPath) {
          targets.push({ path: edge.to, direction: "import" });
        }
        if (edge.to === currentPath) {
          targets.push({ path: edge.from, direction: "dependent" });
        }
        for (const target of targets) {
          if (!target.path || seen.has(target.path)) {
            continue;
          }
          seen.add(target.path);
          next.push(target.path);
          const file = byPath.get(target.path);
          neighbors.push({
            path: target.path,
            direction: target.direction,
            depth: currentDepth,
            role: file?.role ?? "unknown",
            confidence: edge.confidence ?? "medium"
          });
        }
      }
    }
    frontier = next.sort();
  }

  return neighbors.sort((left, right) => `${left.depth}:${left.path}:${left.direction}`.localeCompare(`${right.depth}:${right.path}:${right.direction}`));
}

function buildContextEstimate(files, readingList) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const graphBytes = files.reduce((total, file) => total + (file.size ?? 0), 0);
  const selectedBytes = readingList.reduce((total, item) => total + (byPath.get(item.path)?.size ?? item.size ?? 0), 0);
  return {
    selectedFiles: readingList.length,
    totalGraphFiles: files.length,
    selectedBytes,
    totalGraphBytes: graphBytes,
    estimatedSelectedTokens: estimateTokens(selectedBytes),
    estimatedGraphTokens: estimateTokens(graphBytes),
    estimatedReductionPercent: graphBytes > 0 ? Math.max(0, Math.round((1 - selectedBytes / graphBytes) * 100)) : 0
  };
}

function validationCommandSummaries(commands) {
  return commands
    .filter((command) => VALIDATION_COMMAND_PATTERN.test(command.name ?? "") || VALIDATION_COMMAND_PATTERN.test(command.command ?? ""))
    .map((command) => ({ name: command.name, command: command.command, source: command.source ?? "detected" }));
}

function buildFallbackSearches(terms, task, lowConfidence) {
  if (!lowConfidence) {
    return [];
  }
  const usefulTerms = terms.length > 0 ? terms.slice(0, 3) : tokenize(task).slice(0, 3);
  return usefulTerms.length > 0
    ? usefulTerms.map((term) => `rg -n "${term}" .`)
    : [`rg -n "${task.replace(/"/g, "\\\"")}" .`];
}

function dependentsByTarget(edges) {
  const result = new Map();
  for (const edge of edges) {
    if (!edge.to || !edge.from) {
      continue;
    }
    const current = result.get(edge.to) ?? [];
    current.push(edge.from);
    result.set(edge.to, current.sort());
  }
  return result;
}

function limitList(values = [], limit) {
  return limit ? values.slice(0, limit) : values;
}

function buildLimitSummary(limit, collections, extra = {}) {
  const totals = Object.fromEntries(Object.entries(collections).map(([key, value]) => [key, value.length]));
  const truncated = Object.fromEntries(Object.entries(collections).map(([key, value]) => [key, Boolean(limit && value.length > limit)]));
  return { limit: limit ?? null, ...extra, totals, truncated };
}

function normalizePositiveInteger(value, name) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function normalizeDepth(value) {
  if (value === undefined || value === null || value === "") {
    return 1;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error("depth must be a non-negative integer");
  }
  return number;
}

function tokenize(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1 && !TASK_STOP_WORDS.has(item));
}

function confidenceForScore(score) {
  if (score >= 24) {
    return "high";
  }
  if (score >= 8) {
    return "medium";
  }
  return "low";
}

function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function compareOrientationCandidate(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return left.file.path.localeCompare(right.file.path);
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
  orientCodeGraph,
  resolveJavaScriptImport,
  resolvePythonImport
};



