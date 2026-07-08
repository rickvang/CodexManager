import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileExists, slashPath } from "./fs-utils.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".agents",
  ".codex-prep",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache"
]);

const GENERATED_FILE_PATHS = new Set([
  "AGENTS.md",
  "docs/CODEBASE_MAP.md",
  "docs/CODEX_FEEDBACK.md"
]);

const SECRET_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".npmrc",
  ".pypirc"
]);

const SOURCE_DIR_CANDIDATES = ["src", "app", "apps", "packages", "lib", "server", "client", "cmd", "internal"];
const TEST_DIR_CANDIDATES = ["test", "tests", "__tests__", "spec", "e2e"];
const DOC_DIR_CANDIDATES = ["docs", "documentation", "adr", "architecture"];

export async function scanRepo(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const files = await collectFiles(absoluteRoot);
  const topLevel = [...new Set(files.map((file) => file.split("/")[0]))].sort();
  const packageJson = await readPackageJson(absoluteRoot);
  const pyproject = await readTextIfExists(path.join(absoluteRoot, "pyproject.toml"));
  const discovery = {
    topLevel,
    packageManagers: detectPackageManagers(files),
    languages: detectLanguages(files, packageJson, pyproject),
    frameworks: detectFrameworks(files, packageJson, pyproject),
    commands: detectCommands(packageJson, pyproject),
    sourceRoots: detectRoots(files, SOURCE_DIR_CANDIDATES),
    testRoots: detectRoots(files, TEST_DIR_CANDIDATES),
    entrypoints: detectEntrypoints(files, packageJson, pyproject),
    docs: detectDocs(files),
    ci: detectCi(files),
    workspacePackages: detectWorkspacePackages(files, packageJson),
    architectureDocs: detectArchitectureDocs(files),
    importantFiles: detectImportantFiles(files)
  };
  const repo = {
    root: absoluteRoot,
    name: path.basename(absoluteRoot),
    hasGit: await fileExists(path.join(absoluteRoot, ".git"))
  };
  const evidence = buildEvidence(discovery, packageJson, pyproject);
  const assumptions = buildAssumptions(discovery);
  const fingerprint = fingerprintDiscovery(discovery);

  return {
    schemaVersion: 1,
    generatedAt: options.previousManifest?.generatedAt,
    fingerprint,
    repo,
    summary: summarize(discovery),
    discovery,
    evidence,
    assumptions
  };
}

async function collectFiles(root) {
  const results = [];

  async function walk(directory) {
    const entries = await safeReadDir(directory);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || SECRET_FILE_NAMES.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relative = slashPath(path.relative(root, absolutePath));
      if (GENERATED_FILE_PATHS.has(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else {
        results.push(relative);
      }
    }
  }

  await walk(root);
  return results.sort();
}

async function safeReadDir(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readPackageJson(root) {
  const filePath = path.join(root, "package.json");
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readTextIfExists(filePath) {
  if (!(await fileExists(filePath))) {
    return "";
  }
  return fs.readFile(filePath, "utf8");
}

function detectPackageManagers(files) {
  const managers = [];
  if (files.includes("package-lock.json")) managers.push("npm");
  if (files.includes("pnpm-lock.yaml")) managers.push("pnpm");
  if (files.includes("yarn.lock")) managers.push("yarn");
  if (files.includes("bun.lockb") || files.includes("bun.lock")) managers.push("bun");
  if (files.includes("poetry.lock")) managers.push("poetry");
  if (files.includes("uv.lock")) managers.push("uv");
  if (files.includes("Pipfile.lock")) managers.push("pipenv");
  if (files.includes("package.json") && managers.length === 0) managers.push("npm");
  if ((files.includes("pyproject.toml") || files.includes("requirements.txt")) && managers.length === 0) managers.push("pip");
  return managers;
}

function detectLanguages(files, packageJson, pyproject) {
  const languages = new Set();
  for (const file of files) {
    if (file.endsWith(".ts") || file.endsWith(".tsx")) languages.add("TypeScript");
    if (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs") || file.endsWith(".cjs")) languages.add("JavaScript");
    if (file.endsWith(".py")) languages.add("Python");
    if (file.endsWith(".go")) languages.add("Go");
    if (file.endsWith(".rs")) languages.add("Rust");
    if (file.endsWith(".java")) languages.add("Java");
  }
  if (packageJson) languages.add("JavaScript");
  if (pyproject) languages.add("Python");
  return [...languages].sort();
}

function detectFrameworks(files, packageJson, pyproject) {
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies
  };
  const frameworks = new Set();
  if (deps.react) frameworks.add("React");
  if (deps.next) frameworks.add("Next.js");
  if (deps.vue) frameworks.add("Vue");
  if (deps.svelte) frameworks.add("Svelte");
  if (deps.express) frameworks.add("Express");
  if (deps.vite) frameworks.add("Vite");
  if (deps.vitest) frameworks.add("Vitest");
  if (deps.jest) frameworks.add("Jest");
  if (files.some((file) => file.endsWith("pytest.ini")) || pyproject.includes("pytest")) frameworks.add("pytest");
  if (files.some((file) => file.endsWith("manage.py"))) frameworks.add("Django");
  return [...frameworks].sort();
}

function detectCommands(packageJson, pyproject) {
  const commands = [];
  const manager = packageJson ? "npm" : "python";
  for (const [name, script] of Object.entries(packageJson?.scripts ?? {})) {
    commands.push({ name, command: `${manager} run ${name}`, source: "package.json", script });
  }
  if (pyproject.includes("[tool.pytest") || pyproject.includes("pytest")) {
    commands.push({ name: "test", command: "python -m pytest", source: "pyproject.toml" });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function detectRoots(files, candidates) {
  const roots = new Set();
  for (const file of files) {
    const first = file.split("/")[0];
    if (candidates.includes(first)) {
      roots.add(first);
    }
    const parts = file.split("/");
    if (parts.length >= 3 && candidates.includes(parts[1]) && ["apps", "packages"].includes(parts[0])) {
      roots.add(`${parts[0]}/${parts[1]}`);
    }
  }
  return [...roots].sort();
}

function detectEntrypoints(files, packageJson, pyproject) {
  const entrypoints = new Set();
  for (const key of ["main", "module", "types"]) {
    if (typeof packageJson?.[key] === "string") {
      entrypoints.add(packageJson[key]);
    }
  }
  for (const candidate of [
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
    "src/app.ts",
    "src/app.js",
    "app/page.tsx",
    "pages/index.tsx",
    "bin/codex-prep.js",
    "main.py",
    "app.py"
  ]) {
    if (files.includes(candidate)) {
      entrypoints.add(candidate);
    }
  }
  if (pyproject && files.includes("src/__main__.py")) {
    entrypoints.add("src/__main__.py");
  }
  return [...entrypoints].sort();
}

function detectDocs(files) {
  return files
    .filter((file) => file.endsWith(".md") && (file === "README.md" || DOC_DIR_CANDIDATES.includes(file.split("/")[0])))
    .sort();
}

function detectCi(files) {
  return files
    .filter((file) => file.startsWith(".github/workflows/") || file.startsWith(".gitlab-ci") || file === "azure-pipelines.yml")
    .sort();
}

function detectWorkspacePackages(files, packageJson) {
  const packages = new Set();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length >= 3 && (parts[0] === "apps" || parts[0] === "packages") && parts[2] === "package.json") {
      packages.add(`${parts[0]}/${parts[1]}`);
    }
  }
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    for (const workspace of workspaces) {
      packages.add(workspace);
    }
  } else if (Array.isArray(workspaces?.packages)) {
    for (const workspace of workspaces.packages) {
      packages.add(workspace);
    }
  }
  return [...packages].sort();
}

function detectArchitectureDocs(files) {
  return files
    .filter((file) => /architecture|adr|design|system/i.test(file) && file.endsWith(".md"))
    .sort();
}

function detectImportantFiles(files) {
  return files
    .filter((file) =>
      [
        "package.json",
        "pyproject.toml",
        "requirements.txt",
        "README.md",
        "AGENTS.md",
        "tsconfig.json",
        "vite.config.ts",
        "next.config.js"
      ].includes(file)
    )
    .sort();
}

function buildEvidence(discovery, packageJson, pyproject) {
  const evidence = [];
  if (packageJson) {
    evidence.push({
      fact: "package.json found",
      source: "package.json",
      confidence: "High"
    });
  }
  if (pyproject) {
    evidence.push({
      fact: "pyproject.toml found",
      source: "pyproject.toml",
      confidence: "High"
    });
  }
  if (discovery.commands.length > 0) {
    evidence.push({
      fact: `${discovery.commands.length} runnable script(s) detected`,
      source: discovery.commands.map((command) => command.source).filter(Boolean).join(", "),
      confidence: "High"
    });
  }
  if (discovery.sourceRoots.length > 0) {
    evidence.push({
      fact: `source root(s): ${discovery.sourceRoots.join(", ")}`,
      source: "filesystem",
      confidence: "High"
    });
  }
  if (discovery.testRoots.length > 0) {
    evidence.push({
      fact: `test root(s): ${discovery.testRoots.join(", ")}`,
      source: "filesystem",
      confidence: "High"
    });
  }
  if (discovery.entrypoints.length > 0) {
    evidence.push({
      fact: `entrypoint(s): ${discovery.entrypoints.join(", ")}`,
      source: "package metadata and filesystem",
      confidence: "Medium"
    });
  }
  return evidence;
}

function buildAssumptions(discovery) {
  const assumptions = [];
  if (discovery.commands.length === 0) {
    assumptions.push("No validation commands were discovered; generated guidance should ask Codex to inspect before claiming checks passed.");
  }
  if (discovery.sourceRoots.length === 0) {
    assumptions.push("No conventional source root was found; CODEBASE_MAP should be treated as a starting map, not complete architecture.");
  }
  if (discovery.testRoots.length === 0) {
    assumptions.push("No conventional test root was found; test guidance should stay conditional.");
  }
  return assumptions;
}

function summarize(discovery) {
  const stack = discovery.languages.join(", ") || "unknown language";
  const commands = discovery.commands.length > 0 ? `${discovery.commands.length} command(s)` : "no commands";
  const roots = discovery.sourceRoots.length > 0 ? discovery.sourceRoots.join(", ") : "no conventional source roots";
  return `Detected ${stack} repo with ${commands}; source roots: ${roots}.`;
}

function fingerprintDiscovery(discovery) {
  const stable = JSON.stringify({
    packageManagers: discovery.packageManagers,
    languages: discovery.languages,
    frameworks: discovery.frameworks,
    commands: discovery.commands,
    sourceRoots: discovery.sourceRoots,
    testRoots: discovery.testRoots,
    entrypoints: discovery.entrypoints,
    docs: discovery.docs,
    ci: discovery.ci,
    workspacePackages: discovery.workspacePackages,
    architectureDocs: discovery.architectureDocs,
    importantFiles: discovery.importantFiles
  });
  return crypto.createHash("sha256").update(stable).digest("hex");
}

export const internals = {
  collectFiles,
  detectCommands,
  detectEntrypoints,
  detectPackageManagers,
  detectRoots
};
