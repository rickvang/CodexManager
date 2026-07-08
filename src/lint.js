import fs from "node:fs/promises";
import path from "node:path";
import { MANAGED_BEGIN, MANAGED_END, fileExists } from "./fs-utils.js";
import { MANAGED_FILES } from "./generate.js";

const REQUIRED_MANIFEST_FIELDS = ["schemaVersion", "fingerprint", "repo", "discovery", "generatedFiles"];
const STALE_PATH_PATTERNS = [/D:\\Codex(?!Manager)/i];
const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=/i,
  /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/
];

export async function lintRepo(root) {
  const findings = [];

  for (const filePath of MANAGED_FILES) {
    await lintManagedFile(root, filePath, findings);
  }

  await lintManifest(root, findings);
  await lintSkill(root, ".agents/skills/repo-onboarding/SKILL.md", findings);
  await lintSkill(root, ".agents/skills/code-review/SKILL.md", findings);

  return {
    ok: findings.filter((item) => item.level === "error").length === 0,
    findings
  };
}

async function lintManagedFile(root, filePath, findings) {
  const absolutePath = path.join(root, filePath);
  if (!(await fileExists(absolutePath))) {
    findings.push(finding("missing-managed-file", "error", filePath, "managed file is missing"));
    return;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const beginCount = countOccurrences(content, MANAGED_BEGIN);
  const endCount = countOccurrences(content, MANAGED_END);

  if (beginCount !== 1 || endCount !== 1) {
    findings.push(
      finding(
        "invalid-managed-markers",
        "error",
        filePath,
        "expected exactly one managed marker pair, found begin=" + beginCount + ", end=" + endCount
      )
    );
  } else if (content.indexOf(MANAGED_BEGIN) > content.indexOf(MANAGED_END)) {
    findings.push(finding("invalid-managed-marker-order", "error", filePath, "managed begin marker appears after end marker"));
  }

  lintContentSafety(filePath, content, findings);
}

async function lintManifest(root, findings) {
  const filePath = ".codex-prep/manifest.json";
  const absolutePath = path.join(root, filePath);
  const manifest = await readManifest(absolutePath, findings, filePath);

  if (!manifest) {
    return;
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in manifest)) {
      findings.push(finding("manifest-missing-field", "error", filePath, "missing required field: " + field));
    }
  }

  if (manifest.repo?.root && !samePath(manifest.repo.root, root)) {
    findings.push(
      finding(
        "manifest-root-mismatch",
        "error",
        filePath,
        "manifest repo root " + manifest.repo.root + " does not match lint target " + root
      )
    );
  }

  const generatedFiles = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles : [];
  for (const expectedPath of MANAGED_FILES) {
    if (!generatedFiles.some((file) => file.path === expectedPath && file.managed === true)) {
      findings.push(finding("manifest-generated-file-missing", "error", filePath, "generatedFiles missing managed entry for " + expectedPath));
    }
  }

  lintContentSafety(filePath, JSON.stringify(manifest), findings);
}

async function readManifest(absolutePath, findings, filePath) {
  if (!(await fileExists(absolutePath))) {
    findings.push(finding("missing-manifest", "error", filePath, "manifest is missing"));
    return undefined;
  }

  try {
    return JSON.parse(await fs.readFile(absolutePath, "utf8"));
  } catch (error) {
    findings.push(finding("invalid-manifest-json", "error", filePath, "manifest JSON is invalid: " + error.message));
    return undefined;
  }
}

async function lintSkill(root, filePath, findings) {
  const absolutePath = path.join(root, filePath);
  if (!(await fileExists(absolutePath))) {
    findings.push(finding("missing-skill", "error", filePath, "skill file is missing"));
    return;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const managed = extractManagedContent(content);
  const frontmatter = extractFrontmatter(managed ?? content);

  if (!frontmatter) {
    findings.push(finding("skill-missing-frontmatter", "error", filePath, "skill is missing YAML-style frontmatter"));
    return;
  }

  for (const key of ["name", "description"]) {
    if (!frontmatter[key]) {
      findings.push(finding("skill-frontmatter-missing-field", "error", filePath, "frontmatter missing " + key));
    }
  }
}

function lintContentSafety(filePath, content, findings) {
  for (const pattern of STALE_PATH_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(finding("stale-path-reference", "error", filePath, "contains stale D:\\Codex path reference"));
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(finding("secret-looking-content", "error", filePath, "contains secret-looking content"));
    }
  }
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

function finding(code, level, file, message) {
  return { code, level, file, message };
}

export const internals = {
  extractFrontmatter,
  extractManagedContent,
  lintContentSafety
};
