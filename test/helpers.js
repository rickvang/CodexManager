import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-prep-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return root;
}

export async function readTree(root) {
  const result = {};

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        result[relativePath] = await fs.readFile(absolutePath, "utf8");
      }
    }
  }

  await walk(root);
  return result;
}

export async function withMutedConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

export async function withCapturedConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
  try {
    const result = await callback();
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

export function jsRepoFiles() {
  return {
    "package.json": JSON.stringify(
      {
        name: "sample-js",
        type: "module",
        scripts: {
          start: "node src/index.ts",
          test: "node --test",
          lint: "eslint ."
        },
        dependencies: {
          react: "^19.0.0"
        },
        devDependencies: {
          vitest: "^3.0.0"
        }
      },
      null,
      2
    ),
    "src/index.ts": "export const answer = 42;\n",
    "tests/index.test.ts": "import test from 'node:test';\n",
    "README.md": "# Sample\n",
    ".github/workflows/ci.yml": "name: ci\n"
  };
}
