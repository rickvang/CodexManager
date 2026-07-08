import path from "node:path";
import {
  applyCommand,
  checkCommand,
  evalCommand,
  planCommand,
  refreshMapCommand,
  scanCommand
} from "./commands.js";

const COMMANDS = new Set(["scan", "plan", "apply", "check", "eval", "refresh-map"]);

export async function runCli(argv) {
  const { command, options } = parseArgs(argv);

  if (!command || command === "help" || options.help) {
    printHelp();
    return;
  }

  if (!COMMANDS.has(command)) {
    throw new Error(`unknown command "${command}". Run codex-prep help for usage.`);
  }

  const root = path.resolve(options.repo ?? process.cwd());
  const common = { root, json: options.json };

  if (command === "scan") {
    await scanCommand(common);
  } else if (command === "plan") {
    await planCommand(common);
  } else if (command === "apply") {
    await applyCommand(common);
  } else if (command === "check") {
    await checkCommand(common);
  } else if (command === "eval") {
    await evalCommand(common);
  } else if (command === "refresh-map") {
    await refreshMapCommand(common);
  }
}

function parseArgs(argv) {
  const options = { json: false, help: false, repo: undefined };
  let command;

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];

    if (!command && !value.startsWith("-")) {
      command = value;
      continue;
    }

    if (value === "--json") {
      options.json = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else if (value === "--repo") {
      const repo = argv[i + 1];
      if (!repo) {
        throw new Error("--repo requires a path");
      }
      options.repo = repo;
      i += 1;
    } else {
      throw new Error(`unknown option "${value}"`);
    }
  }

  return { command, options };
}

function printHelp() {
  console.log(`codex-prep

Usage:
  codex-prep <command> [--repo <path>] [--json]

Commands:
  scan         Inspect a repo and print an evidence-backed summary.
  plan         Preview the onboarding files that apply would write.
  apply        Write or refresh the Codex onboarding bundle.
  check        Detect stale generated guidance and obvious repo drift.
  eval         Run fixed scenarios against the generated guidance.
  refresh-map  Refresh docs/CODEBASE_MAP.md and the manifest.

Defaults:
  The current working directory is used when --repo is omitted.
  No command uses network access.
  scan, plan, check, and eval do not edit repo-tracked files.
`);
}
