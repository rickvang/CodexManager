import fs from "node:fs/promises";
import path from "node:path";

export const MANAGED_BEGIN = "<!-- codex-prep:begin -->";
export const MANAGED_END = "<!-- codex-prep:end -->";

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonIfExists(filePath) {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJsonIfChanged(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return writeFileIfChanged(filePath, content);
}

export async function writeManagedFile(root, relativeFilePath, managedContent) {
  const absolutePath = path.join(root, relativeFilePath);
  const content = await mergeManagedContent(absolutePath, managedContent);
  return writeFileIfChanged(absolutePath, content);
}

export async function writeFileIfChanged(filePath, content) {
  const current = (await fileExists(filePath)) ? await fs.readFile(filePath, "utf8") : undefined;
  if (current === content) {
    return { changed: false };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return { changed: true };
}

async function mergeManagedContent(filePath, managedContent) {
  const normalized = ensureTrailingNewline(managedContent);
  if (!(await fileExists(filePath))) {
    return normalized;
  }

  const current = await fs.readFile(filePath, "utf8");
  const begin = current.indexOf(MANAGED_BEGIN);
  const end = current.indexOf(MANAGED_END);

  if (begin >= 0 && end > begin) {
    const before = current.slice(0, begin).trimEnd();
    const after = current.slice(end + MANAGED_END.length).trimStart();
    return joinSections([before, normalized.trimEnd(), after]);
  }

  return joinSections([
    current.trimEnd(),
    "## Codex Prep Managed Section",
    normalized.trimEnd()
  ]);
}

function joinSections(sections) {
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function slashPath(value) {
  return value.split(path.sep).join("/");
}

export function relativePath(value) {
  return slashPath(value);
}
