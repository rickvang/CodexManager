import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";

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
