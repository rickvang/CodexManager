import fs from "node:fs/promises";
import path from "node:path";
import { compilePatterns, CONFIG_PATH, readConfig } from "./config.js";
import { MANAGED_BEGIN, MANAGED_END, fileExists } from "./fs-utils.js";
import { MANAGED_FILES } from "./generate.js";
import { hasErrors, pushFinding } from "./rules.js";

const REQUIRED_MANIFEST_FIELDS = ["schemaVersion", "fingerprint", "repo", "discovery", "generatedFiles"];

export async function lintRepo(root) {
  const findings = [];
  const configState = await readConfig(root);
  const config = configState.config;

  if (configState.missing) {
    pushFinding(findings, config, "missing-config", {
      file: CONFIG_PATH,
      message: "codex-prep config is missing; defaults are being used"
    });
  }
  if (configState.invalid) {
    pushFinding(findings, config, "invalid-config-json", {
      file: CONFIG_PATH,
      message: "config JSON is invalid: " + configState.invalid
    });
  }

  const stalePathPatterns = compilePatternSet(findings, config, "lint.stalePathPatterns", config.lint?.stalePathPatterns ?? []);
  const secretPatterns = compilePatternSet(findings, config, "lint.secretPatterns", config.lint?.secretPatterns ?? []);

  for (const filePath of MANAGED_FILES) {
    await lintManagedFile(root, filePath, findings, config, stalePathPatterns, secretPatterns);
  }

  await lintManifest(root, findings, config, stalePathPatterns, secretPatterns);
  await lintSkill(root, ".agents/skills/repo-onboarding/SKILL.md", findings, config);
  await lintSkill(root, ".agents/skills/code-review/SKILL.md", findings, config);

  return {
    ok: !hasErrors(findings),
    findings
  };
}

function compilePatternSet(findings, config, configField, patterns) {
  const { compiled, invalid } = compilePatterns(patterns);
  for (const item of invalid) {
    pushFinding(findings, config, "invalid-lint-pattern", {
      file: CONFIG_PATH,
      message: configField + " contains invalid regex " + JSON.stringify(item.pattern) + ": " + item.error
    });
  }
  return compiled;
}

async function lintManagedFile(root, filePath, findings, config, stalePathPatterns, secretPatterns) {
  const absolutePath = path.join(root, filePath);
  if (!(await fileExists(absolutePath))) {
    pushFinding(findings, config, "missing-managed-file", { file: filePath, message: "managed file is missing" });
    return;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const beginCount = countOccurrences(content, MANAGED_BEGIN);
  const endCount = countOccurrences(content, MANAGED_END);

  if (beginCount !== 1 || endCount !== 1) {
    pushFinding(findings, config, "invalid-managed-markers", {
      file: filePath,
      message: "expected exactly one managed marker pair, found begin=" + beginCount + ", end=" + endCount
    });
  } else if (content.indexOf(MANAGED_BEGIN) > content.indexOf(MANAGED_END)) {
    pushFinding(findings, config, "invalid-managed-marker-order", {
      file: filePath,
      message: "managed begin marker appears after end marker"
    });
  }

  lintContentSafety(filePath, content, findings, config, stalePathPatterns, secretPatterns);
}

async function lintManifest(root, findings, config, stalePathPatterns, secretPatterns) {
  const filePath = ".codex-prep/manifest.json";
  const absolutePath = path.join(root, filePath);
  const manifest = await readManifest(absolutePath, findings, config, filePath);

  if (!manifest) {
    return;
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in manifest)) {
      pushFinding(findings, config, "manifest-missing-field", {
        file: filePath,
        message: "missing required field: " + field
      });
    }
  }

  if (manifest.repo?.root && !manifestRootMatches(manifest.repo.root, root)) {
    pushFinding(findings, config, "manifest-root-mismatch", {
      file: filePath,
      message: "manifest repo root " + manifest.repo.root + " does not match lint target " + root
    });
  }

  const generatedFiles = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles : [];
  for (const expectedPath of MANAGED_FILES) {
    if (!generatedFiles.some((file) => file.path === expectedPath && file.managed === true)) {
      pushFinding(findings, config, "manifest-generated-file-missing", {
        file: filePath,
        message: "generatedFiles missing managed entry for " + expectedPath
      });
    }
  }

  lintContentSafety(filePath, JSON.stringify(manifest), findings, config, stalePathPatterns, secretPatterns);
}

async function readManifest(absolutePath, findings, config, filePath) {
  if (!(await fileExists(absolutePath))) {
    pushFinding(findings, config, "missing-manifest", { file: filePath, message: "manifest is missing" });
    return undefined;
  }

  try {
    return JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    pushFinding(findings, config, "invalid-manifest-json", {
      file: filePath,
      message: "manifest JSON is invalid: " + error.message
    });
    return undefined;
  }
}

async function lintSkill(root, filePath, findings, config) {
  const absolutePath = path.join(root, filePath);
  if (!(await fileExists(absolutePath))) {
    pushFinding(findings, config, "missing-skill", { file: filePath, message: "skill file is missing" });
    return;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const managed = extractManagedContent(content);
  const frontmatter = extractFrontmatter(managed ?? content);

  if (!frontmatter) {
    pushFinding(findings, config, "skill-missing-frontmatter", {
      file: filePath,
      message: "skill is missing YAML-style frontmatter"
    });
    return;
  }

  for (const key of ["name", "description"]) {
    if (!frontmatter[key]) {
      pushFinding(findings, config, "skill-frontmatter-missing-field", {
        file: filePath,
        message: "frontmatter missing " + key
      });
    }
  }
}

function lintContentSafety(filePath, content, findings, config, stalePathPatterns, secretPatterns) {
  for (const pattern of stalePathPatterns) {
    if (pattern.test(content)) {
      pushFinding(findings, config, "stale-path-reference", {
        file: filePath,
        message: "contains stale path reference"
      });
    }
  }

  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      pushFinding(findings, config, "secret-looking-content", {
        file: filePath,
        message: "contains secret-looking content"
      });
    }
  }
}

function manifestRootMatches(manifestRoot, root) {
  const expectedRoot = path.isAbsolute(manifestRoot) ? manifestRoot : path.resolve(root, manifestRoot);
  return samePath(expectedRoot, root);
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

function extractManagedContent(content) {
  const begin = content.indexOf(MANAGED_BEGIN);
  const end = content.indexOf(MANAGED_END);
  if (begin < 0 || end < 0 || begin > end) {
    return undefined;
  }
  return content.slice(begin + MANAGED_BEGIN.length, end).trim();
}

function extractFrontmatter(content) {
  const normalized = content.trimStart();
  if (!normalized.startsWith("---")) {
    return undefined;
  }

  const end = normalized.indexOf("\n---", 3);
  if (end < 0) {
    return undefined;
  }

  const lines = normalized.slice(3, end).split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      result[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

function countOccurrences(content, search) {
  return content.split(search).length - 1;
}

export const internals = {
  extractFrontmatter,
  extractManagedContent,
  lintContentSafety,
  manifestRootMatches,
  samePath
};
