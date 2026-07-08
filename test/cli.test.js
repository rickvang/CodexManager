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