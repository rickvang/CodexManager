import path from "node:path";
import {
  applyCommand,
  checkCommand,
  evalCommand,
  lintCommand,
  planCloseCommand,
  planCommand,
  planLintCommand,
  planStatusCommand,
  planUpdateCommand,
  refreshMapCommand,
  scanCommand
} from "./commands.js";

const COMMANDS = new Set([
  "scan",
  "plan",
  "plan-update",
  "plan-status",
  "plan-lint",
  "plan-close",
  "apply",
  "check",
  "eval",
  "lint",
  "refresh-map"
]);

export async function runCli(argv) {
  const { command, options } = parseArgs(argv);

  if (!command || command === "help" || options.help) {
    printHelp();
    return;
  }

  if (!COMMANDS.has(command)) {
    throw new Error(`unknown command "${command}". Run codex-prep help for usage.`);
  }

  validateOptions(command, options);

  const root = path.resolve(options.repo ?? process.cwd());
  const common = { root, json: options.json };

  if (command === "scan") {
    await scanCommand(common);
  } else if (command === "plan") {
    await planCommand({
      ...common,
      save: !options.noSave,
      intent: options.intent,
      note: options.note,
      scope: options.scope,
      files: options.files,
      validation: options.validation,
      questions: options.questions,
      goal: options.goal,
      successCriteria: options.successCriteria,
      nonGoals: options.nonGoals,
      stopRules: options.stopRules,
      forbiddenActions: options.forbiddenActions,
      approvalBoundaries: options.approvalBoundaries,
      riskLevel: options.riskLevel,
      targetAgent: options.targetAgent
    });
  } else if (command === "plan-update") {
    await planUpdateCommand({
      ...common,
      intent: options.intent,
      note: options.note,
      status: options.status,
      scope: options.scope,
      files: options.files,
      validation: options.validation,
      questions: options.questions,
      goal: options.goal,
      successCriteria: options.successCriteria,
      nonGoals: options.nonGoals,
      stopRules: options.stopRules,
      forbiddenActions: options.forbiddenActions,
      approvalBoundaries: options.approvalBoundaries,
      riskLevel: options.riskLevel,
      targetAgent: options.targetAgent
    });
  } else if (command === "plan-status") {
    await planStatusCommand(common);
  } else if (command === "plan-lint") {
    await planLintCommand(common);
  } else if (command === "plan-close") {
    await planCloseCommand({ ...common, status: options.status, note: options.note });
  } else if (command === "apply") {
    await applyCommand(common);
  } else if (command === "check") {
    await checkCommand(common);
  } else if (command === "eval") {
    await evalCommand(common);
  } else if (command === "lint") {
    await lintCommand(common);
  } else if (command === "refresh-map") {
    await refreshMapCommand(common);
  }
}

function parseArgs(argv) {
  const options = {
    json: false,
    help: false,
    repo: undefined,
    noSave: false,
    save: false,
    intent: undefined,
    note: undefined,
    status: undefined,
    scope: [],
    files: [],
    validation: [],
    questions: [],
    goal: undefined,
    successCriteria: [],
    nonGoals: [],
    stopRules: [],
    forbiddenActions: [],
    approvalBoundaries: [],
    riskLevel: undefined,
    targetAgent: undefined
  };
  let command;

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];

    if (!command && !value.startsWith("-")) {
      command = value;
      continue;
    }

    if (value === "--json") {
      options.json = true;
    } else if (value === "--save") {
      options.save = true;
    } else if (value === "--no-save") {
      options.noSave = true;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else if (value === "--repo") {
      options.repo = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--intent") {
      options.intent = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--note") {
      options.note = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--status") {
      options.status = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--scope") {
      options.scope.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--file") {
      options.files.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--validation") {
      options.validation.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--question") {
      options.questions.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--goal") {
      options.goal = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--success") {
      options.successCriteria.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--non-goal") {
      options.nonGoals.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--stop-rule") {
      options.stopRules.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--forbidden-action") {
      options.forbiddenActions.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--approval-boundary") {
      options.approvalBoundaries.push(readOptionValue(argv, i, value));
      i += 1;
    } else if (value === "--risk") {
      options.riskLevel = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--target-agent") {
      options.targetAgent = readOptionValue(argv, i, value);
      i += 1;
    } else {
      throw new Error(`unknown option "${value}"`);
    }
  }

  return { command, options };
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function validateOptions(command, options) {
  const planningCommands = ["plan", "plan-update"];
  if (options.save && command !== "plan") {
    throw new Error("--save is only supported for the plan command");
  }
  if (options.noSave && command !== "plan") {
    throw new Error("--no-save is only supported for the plan command");
  }
  if (options.intent && !planningCommands.includes(command)) {
    throw new Error("--intent is only supported for plan and plan-update");
  }
  if (options.note && !["plan", "plan-update", "plan-close"].includes(command)) {
    throw new Error("--note is only supported for plan, plan-update, and plan-close");
  }
  if (options.status && !["plan-update", "plan-close"].includes(command)) {
    throw new Error("--status is only supported for plan-update and plan-close");
  }
  if (hasAny(options.scope) && !planningCommands.includes(command)) {
    throw new Error("--scope is only supported for plan and plan-update");
  }
  if (hasAny(options.files) && !planningCommands.includes(command)) {
    throw new Error("--file is only supported for plan and plan-update");
  }
  if (hasAny(options.validation) && !planningCommands.includes(command)) {
    throw new Error("--validation is only supported for plan and plan-update");
  }
  if (hasAny(options.questions) && !planningCommands.includes(command)) {
    throw new Error("--question is only supported for plan and plan-update");
  }
  if (options.goal && !planningCommands.includes(command)) {
    throw new Error("--goal is only supported for plan and plan-update");
  }
  if (hasAny(options.successCriteria) && !planningCommands.includes(command)) {
    throw new Error("--success is only supported for plan and plan-update");
  }
  if (hasAny(options.nonGoals) && !planningCommands.includes(command)) {
    throw new Error("--non-goal is only supported for plan and plan-update");
  }
  if (hasAny(options.stopRules) && !planningCommands.includes(command)) {
    throw new Error("--stop-rule is only supported for plan and plan-update");
  }
  if (hasAny(options.forbiddenActions) && !planningCommands.includes(command)) {
    throw new Error("--forbidden-action is only supported for plan and plan-update");
  }
  if (hasAny(options.approvalBoundaries) && !planningCommands.includes(command)) {
    throw new Error("--approval-boundary is only supported for plan and plan-update");
  }
  if (options.riskLevel && !planningCommands.includes(command)) {
    throw new Error("--risk is only supported for plan and plan-update");
  }
  if (options.targetAgent && !planningCommands.includes(command)) {
    throw new Error("--target-agent is only supported for plan and plan-update");
  }
}

function hasAny(values) {
  return values.length > 0;
}

function printHelp() {
  console.log(`codex-prep

Usage:
  codex-prep <command> [--repo <path>] [--json]
  codex-prep plan [--repo <path>] [--json] [--no-save]
  codex-prep plan-update [--repo <path>] [--note <text>] [--status <status>]
  codex-prep plan-status [--repo <path>] [--json]
  codex-prep plan-lint [--repo <path>] [--json]
  codex-prep plan-close [--repo <path>] --status <implemented|superseded|rejected>

Commands:
  scan         Inspect a repo and print an evidence-backed summary.
  plan         Preview and autosave the onboarding plan draft.
  plan-update  Update the active saved plan before implementation approval.
  plan-status  Show the active saved plan.
  plan-lint    Check whether the active saved plan is ready to implement.
  plan-close   Mark the active saved plan as implemented, superseded, or rejected.
  apply        Write or refresh the Codex onboarding bundle.
  check        Detect stale generated guidance and obvious repo drift.
  eval         Run fixed scenarios against the generated guidance.
  lint         Lint codex-prep managed files without editing them.
  refresh-map  Refresh docs/CODEBASE_MAP.md and the manifest.

Planning options:
  --no-save       With plan only, preview without writing plan history.
  --intent TEXT   Set or replace the active plan intent.
  --note TEXT     Append a decision-log note.
  --scope TEXT    Append a proposed scope item.
  --file PATH     Append a likely touched file or path.
  --validation TEXT
                  Append a validation step.
  --question TEXT Append an open question.
  --goal TEXT     Set the plan goal.
  --success TEXT  Append a success criterion.
  --non-goal TEXT Append a non-goal.
  --stop-rule TEXT
                  Append a stop rule.
  --forbidden-action TEXT
                  Append a forbidden action.
  --approval-boundary TEXT
                  Append an approval boundary.
  --risk TEXT     Set plan risk: low, medium, or high.
  --target-agent TEXT
                  Set target agent: codex, cursor, claude-code, or generic.
  --status TEXT   Set plan status with plan-update or plan-close.

Defaults:
  The current working directory is used when --repo is omitted.
  No command uses network access.
  scan, check, eval, lint, and plan-lint do not edit repo-tracked files.
  plan autosaves reviewable planning files, but it never approves implementation.
`);
}
