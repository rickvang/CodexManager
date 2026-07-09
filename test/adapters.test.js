import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  adapterApplyCommand,
  adapterPlanCommand,
  applyCommand,
  checkCommand,
  handoffCommand,
  statusCommand
} from "../src/commands.js";
import { createTempRepo, jsRepoFiles, readTree, withCapturedConsole, withMutedConsole } from "./helpers.js";

test("adapter-plan previews generated agent files without writing", async () => {
  const root = await createTempRepo(jsRepoFiles());
  const before = await readTree(root);

  const result = await withMutedConsole(() => adapterPlanCommand({ root, json: true, target: "claude-code,cursor", profile: "deep" }));
  const after = await readTree(root);

  assert.deepEqual(after, before);
  assert.equal(result.contextProfile, "deep");
  assert.deepEqual(result.targets, ["claude-code", "cursor"]);
  assert.equal(result.files.some((file) => file.path === "CLAUDE.md"), true);
  assert.equal(result.files.some((file) => file.path === ".cursor/rules/codexmanager-workflow.mdc"), true);
});

test("adapter-apply writes deterministic multi-agent adapter outputs", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(() => adapterApplyCommand({ root, json: true, target: "all" }));
  const first = await readTree(root);
  await withMutedConsole(() => adapterApplyCommand({ root, json: true, target: "all" }));
  const second = await readTree(root);

  assert.deepEqual(second, first);
  assert.equal(first["CLAUDE.md"].includes("@AGENTS.md"), true);
  assert.equal(first[".cursor/rules/codexmanager-workflow.mdc"].includes("alwaysApply: true"), true);
  assert.equal(first[".cursor/rules/graph-first-orientation.mdc"].includes("globs:"), true);
  assert.equal(first[".cursor/rules/review-validation.mdc"].includes("codex-prep preflight"), true);
  assert.equal(first[".cursor/rules/generated-state.mdc"].includes("codex-prep refresh --auto"), true);
  assert.equal(Boolean(first[".vscode/tasks.json"]), false);
  assert.equal(Boolean(first[".vscode/extensions.json"]), false);
  assert.equal(first["docs/agent-adapters/jan/system-prompt.md"].includes("Jan System Prompt"), true);
  assert.equal(first["docs/agent-adapters/ollama/Modelfile"].includes("FROM llama3.1"), true);
  assert.equal(first["docs/agent-adapters/generic/system-prompt.md"].includes("Generic Agent System Prompt"), true);

  const manifest = JSON.parse(first[".codex-prep/adapters.json"]);
  assert.equal(manifest.kind, "codex-prep-adapters");
  assert.deepEqual(manifest.targets.map((target) => target.name), ["claude-code", "cursor", "jan", "ollama", "generic"]);
  assert.equal(manifest.generatedFiles.some((file) => file.path === "CLAUDE.md"), true);
});

test("handoff writes deterministic resume state", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(() => handoffCommand({ root, json: true }));
  const first = await readTree(root);
  await withMutedConsole(() => handoffCommand({ root, json: true }));
  const second = await readTree(root);

  assert.deepEqual(second, first);
  assert.equal(first["docs/AGENT_HANDOFF.md"].includes("Handoff fingerprint:"), true);
  assert.equal(first["docs/AGENT_HANDOFF.md"].includes("This file is a reconnect packet"), true);
});

test("status reports adapter and handoff state", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await adapterApplyCommand({ root, json: true, target: "cursor" });
    await handoffCommand({ root, json: true });
  });

  const result = await withMutedConsole(() => statusCommand({ root, json: true }));
  assert.equal(result.adapters.exists, true);
  assert.deepEqual(result.adapters.targets, ["cursor"]);
  assert.equal(result.handoff.exists, true);
});

test("check catches stale adapter and handoff output", async () => {
  const root = await createTempRepo(jsRepoFiles());

  await withMutedConsole(async () => {
    await applyCommand({ root, json: true });
    await adapterApplyCommand({ root, json: true, target: "all" });
    await handoffCommand({ root, json: true });
  });

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sample-js", scripts: { test: "node --test --watch" } }, null, 2),
    "utf8"
  );

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const output = await withCapturedConsole(() => checkCommand({ root, json: true }));
  const result = JSON.parse(output.stdout);

  assert.equal(process.exitCode, 1);
  assert.equal(result.findings.some((finding) => finding.rule === "adapter-source-stale"), true);
  assert.equal(result.findings.some((finding) => finding.rule === "handoff-stale"), true);
  process.exitCode = originalExitCode;
});