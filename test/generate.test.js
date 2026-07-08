import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTempRepo, jsRepoFiles } from "./helpers.js";
import { buildBundle } from "../src/generate.js";
import { writeManagedFile } from "../src/fs-utils.js";
import { scanRepo } from "../src/scan.js";

test("generated bundle contains the durable repo learning loop files", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const manifest = await scanRepo(root);
  const bundle = buildBundle(manifest);
  const paths = bundle.files.map((file) => file.path).sort();

  assert.deepEqual(paths, [
    ".agents/skills/code-review/SKILL.md",
    ".agents/skills/repo-onboarding/SKILL.md",
    "AGENTS.md",
    "docs/CODEBASE_MAP.md",
    "docs/CODEX_FEEDBACK.md"
  ]);
  assert.equal(bundle.files.find((file) => file.path === "AGENTS.md").content.includes("Explore / Review"), true);
  assert.equal(bundle.files.find((file) => file.path === "docs/CODEBASE_MAP.md").content.includes("## V2 Ideas"), true);
});

test("managed writes preserve human content outside codex-prep markers", async () => {
  const root = await createTempRepo({
    "AGENTS.md": "# Existing Rules\n\nDo the human thing.\n"
  });

  await writeManagedFile(root, "AGENTS.md", "<!-- codex-prep:begin -->\nGenerated\n<!-- codex-prep:end -->\n");
  const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");

  assert.equal(content.includes("Do the human thing."), true);
  assert.equal(content.includes("Generated"), true);
});
