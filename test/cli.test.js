import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { createGitRepo, createTempRepo, jsRepoFiles, withCapturedConsole } from "./helpers.js";

test("--save is only accepted for plan", async () => {
  await assert.rejects(
    () => runCli(["scan", "--save"]),
    /--save is only supported for the plan command/
  );
});

test("--no-save is only accepted for plan", async () => {
  await assert.rejects(
    () => runCli(["scan", "--no-save"]),
    /--no-save is only supported for the plan command/
  );
});

test("plan-close status must be terminal", async () => {
  await assert.rejects(
    () => runCli(["plan-close", "--status", "approved"]),
    /plan-close status must be implemented, superseded, or rejected/
  );
});
test("plan-start options are only accepted for plan-start", async () => {
  await assert.rejects(
    () => runCli(["plan-review", "--branch", "codex/work"]),
    /--branch is only supported for plan-start/
  );
  await assert.rejects(
    () => runCli(["plan-review", "--base", "main"]),
    /--base is only supported for plan-start/
  );
  await assert.rejects(
    () => runCli(["plan-review", "--sync-base"]),
    /--sync-base is only supported for plan-start/
  );
});
test("graph-query validates query options", async () => {
  await assert.rejects(
    () => runCli(["graph-query"]),
    /graph-query requires --file <path> or --symbol <name>/
  );
  await assert.rejects(
    () => runCli(["scan", "--symbol", "answer"]),
    /--symbol is only supported for graph-query/
  );
  await assert.rejects(
    () => runCli(["graph-query", "--file", "src/index.ts", "--symbol", "answer"]),
    /graph-query accepts either --file or --symbol, not both/
  );
});

test("orient and graph budget options validate command ownership", async () => {
  await assert.rejects(
    () => runCli(["orient"]),
    /orient requires --task <text>/
  );
  await assert.rejects(
    () => runCli(["scan", "--task", "find auth"]),
    /--task is only supported for orient/
  );
  await assert.rejects(
    () => runCli(["scan", "--limit", "3"]),
    /--limit is only supported for orient and graph-query/
  );
  await assert.rejects(
    () => runCli(["orient", "--task", "find auth", "--depth", "2"]),
    /--depth is only supported for graph-query/
  );
});
test("graph-export-only options are rejected elsewhere", async () => {
  await assert.rejects(
    () => runCli(["scan", "--include-symbols"]),
    /--include-symbols is only supported for graph-export/
  );
});

test("validation-record options are only accepted for validation-record", async () => {
  await assert.rejects(
    () => runCli(["scan", "--validation-command", "npm run verify"]),
    /--validation-command is only supported for validation-record/
  );
  await assert.rejects(
    () => runCli(["scan", "--result", "pass"]),
    /--result is only supported for validation-record/
  );
  await assert.rejects(
    () => runCli(["scan", "--summary", "passed"]),
    /--summary is only supported for validation-record/
  );
  await assert.rejects(
    () => runCli(["scan", "--phase", "validation"]),
    /--phase is only supported for validation-record/
  );
});

test("local-ignore runs through the CLI", async () => {
  const root = await createGitRepo(jsRepoFiles());
  const output = await withCapturedConsole(() => runCli(["local-ignore", "--repo", root, "--json"]));
  const parsed = JSON.parse(output.stdout);

  assert.equal(parsed.isGitRepo, true);
  assert.equal(parsed.changed, true);
  assert.deepEqual(parsed.added, [".codex-prep/plans/", ".codex-prep/validation-results.jsonl"]);
});

test("adapter command options validate command ownership", async () => {
  await assert.rejects(
    () => runCli(["scan", "--target", "cursor"]),
    /--target is only supported for adapter-plan and adapter-apply/
  );
  await assert.rejects(
    () => runCli(["scan", "--profile", "short"]),
    /--profile is only supported for adapter-plan and adapter-apply/
  );

  const root = await createTempRepo(jsRepoFiles());
  const output = await withCapturedConsole(() => runCli(["adapter-plan", "--repo", root, "--target", "cursor", "--profile", "short", "--json"]));
  const parsed = JSON.parse(output.stdout);

  assert.deepEqual(parsed.targets, ["cursor"]);
  assert.equal(parsed.contextProfile, "short");
});