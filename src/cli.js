import path from "node:path";
import {
  applyCommand,
  checkCommand,
  doctorCommand,
  evalCommand,
  graphCommand,
  graphExportCommand,
  graphQueryCommand,
  lintCommand,
  localIgnoreCommand,
  orientCommand,
  planApproveCommand,
  planAttachCommand,
  planCloseCommand,
  planCommand,
  planLintCommand,
  planReviewCommand,
  planStartCommand,
  planStatusCommand,
  planUpdateCommand,
  refreshGraphCommand,
  refreshMapCommand,
  scanCommand,
  statusCommand,
  validationRecordCommand
} from "./commands.js";

const COMMANDS = new Set([
  "scan",
  "plan",
  "plan-update",
  "plan-status",
  "status",
  "doctor",
  "local-ignore",
  "validation-record",
  "plan-attach",
  "plan-review",
  "plan-lint",
  "plan-approve",
  "plan-start",
  "plan-close",
  "apply",
  "check",
  "eval",
  "graph",
  "orient",
  "graph-export",
  "graph-query",
  "lint",
  "refresh-graph",
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
  } else if (command === "status") {
    await statusCommand(common);
  } else if (command === "doctor") {
    await doctorCommand(common);
  } else if (command === "local-ignore") {
    await localIgnoreCommand(common);
  } else if (command === "validation-record") {
    await validationRecordCommand({
      ...common,
      validationCommand: options.validationCommand,
      validationResult: options.validationResult,
      summary: options.summary,
      phase: options.phase
    });
  } else if (command === "plan-attach") {
    await planAttachCommand({ ...common, note: options.note });
  } else if (command === "plan-review") {
    await planReviewCommand(common);
  } else if (command === "plan-lint") {
    await planLintCommand(common);
  } else if (command === "plan-approve") {
    await planApproveCommand({ ...common, note: options.note });
  } else if (command === "plan-start") {
    await planStartCommand({ ...common, branch: options.branch, base: options.base, syncBase: options.syncBase });
  } else if (command === "plan-close") {
    await planCloseCommand({ ...common, status: options.status, note: options.note });
  } else if (command === "apply") {
    await applyCommand(common);
  } else if (command === "check") {
    await checkCommand(common);
  } else if (command === "eval") {
    await evalCommand(common);
  } else if (command === "graph") {
    await graphCommand(common);
  } else if (command === "orient") {
    await orientCommand({ ...common, task: options.task, limit: options.limit });
  } else if (command === "graph-export") {
    await graphExportCommand({ ...common, format: options.format, includeSymbols: options.includeSymbols });
  } else if (command === "graph-query") {
    await graphQueryCommand({ ...common, file: options.files[0], symbol: options.symbol, limit: options.limit, depth: options.depth });
  } else if (command === "lint") {
    await lintCommand(common);
  } else if (command === "refresh-graph") {
    await refreshGraphCommand(common);
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
    validationCommand: undefined,
    validationResult: undefined,
    summary: undefined,
    phase: undefined,
    questions: [],
    goal: undefined,
    successCriteria: [],
    nonGoals: [],
    stopRules: [],
    forbiddenActions: [],
    approvalBoundaries: [],
    riskLevel: undefined,
    targetAgent: undefined,
    symbol: undefined,
    task: undefined,
    limit: undefined,
    depth: undefined,
    branch: undefined,
    base: undefined,
    syncBase: false,
    format: undefined,
    includeSymbols: false
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
    } else if (value === "--sync-base") {
      options.syncBase = true;
    } else if (value === "--include-symbols") {
      options.includeSymbols = true;
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
    } else if (value === "--validation-command") {
      options.validationCommand = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--result") {
      options.validationResult = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--summary") {
      options.summary = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--phase") {
      options.phase = readOptionValue(argv, i, value);
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
    } else if (value === "--symbol") {
      options.symbol = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--task") {
      options.task = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--limit") {
      options.limit = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--depth") {
      options.depth = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--format") {
      options.format = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--branch") {
      options.branch = readOptionValue(argv, i, value);
      i += 1;
    } else if (value === "--base") {
      options.base = readOptionValue(argv, i, value);
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
  if (options.note && !["plan", "plan-update", "plan-approve", "plan-close", "plan-attach"].includes(command)) {
    throw new Error("--note is only supported for plan, plan-update, plan-approve, plan-close, and plan-attach");
  }
  if (options.status && !["plan-update", "plan-close"].includes(command)) {
    throw new Error("--status is only supported for plan-update and plan-close");
  }
  if (hasAny(options.scope) && !planningCommands.includes(command)) {
    throw new Error("--scope is only supported for plan and plan-update");
  }
  if (hasAny(options.files) && ![...planningCommands, "graph-query"].includes(command)) {
    throw new Error("--file is only supported for plan, plan-update, and graph-query");
  }
  if (hasAny(options.validation) && !planningCommands.includes(command)) {
    throw new Error("--validation is only supported for plan and plan-update");
  }
  if (options.validationCommand && command !== "validation-record") {
    throw new Error("--validation-command is only supported for validation-record");
  }
  if (options.validationResult && command !== "validation-record") {
    throw new Error("--result is only supported for validation-record");
  }
  if (options.summary && command !== "validation-record") {
    throw new Error("--summary is only supported for validation-record");
  }
  if (options.phase && command !== "validation-record") {
    throw new Error("--phase is only supported for validation-record");
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
  if (options.symbol && command !== "graph-query") {
    throw new Error("--symbol is only supported for graph-query");
  }
  if (options.task && command !== "orient") {
    throw new Error("--task is only supported for orient");
  }
  if (options.limit && !["orient", "graph-query"].includes(command)) {
    throw new Error("--limit is only supported for orient and graph-query");
  }
  if (options.depth && command !== "graph-query") {
    throw new Error("--depth is only supported for graph-query");
  }
  if (options.format && command !== "graph-export") {
    throw new Error("--format is only supported for graph-export");
  }
  if (options.includeSymbols && command !== "graph-export") {
    throw new Error("--include-symbols is only supported for graph-export");
  }
  if (command === "graph-export" && options.format && options.format !== "obsidian") {
    throw new Error("graph-export currently supports --format obsidian");
  }
  if (command === "orient" && !options.task) {
    throw new Error("orient requires --task <text>");
  }
  if (command === "graph-query" && options.files.length === 0 && !options.symbol) {
    throw new Error("graph-query requires --file <path> or --symbol <name>");
  }
  if (command === "graph-query" && options.files.length > 0 && options.symbol) {
    throw new Error("graph-query accepts either --file or --symbol, not both");
  }
  if (command === "graph-query" && options.files.length > 1) {
    throw new Error("graph-query accepts one --file value");
  }
  if (options.branch && command !== "plan-start") {
    throw new Error("--branch is only supported for plan-start");
  }
  if (options.base && command !== "plan-start") {
    throw new Error("--base is only supported for plan-start");
  }
  if (options.syncBase && command !== "plan-start") {
    throw new Error("--sync-base is only supported for plan-start");
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
  codex-prep status [--repo <path>] [--json]
  codex-prep doctor [--repo <path>] [--json]
  codex-prep local-ignore [--repo <path>] [--json]
  codex-prep validation-record [--repo <path>] --validation-command <command> --result <pass|fail> [--summary <text>] [--phase <name>] [--json]
  codex-prep plan-attach [--repo <path>] --note <text> [--json]
  codex-prep plan-review [--repo <path>] [--json]
  codex-prep plan-lint [--repo <path>] [--json]
  codex-prep plan-approve [--repo <path>] --note <text>
  codex-prep plan-start [--repo <path>] --branch <name> [--base main] [--sync-base]
  codex-prep plan-close [--repo <path>] --status <implemented|superseded|rejected>
  codex-prep graph [--repo <path>] [--json]
  codex-prep orient [--repo <path>] --task <text> [--limit <n>] [--json]
  codex-prep graph-export [--repo <path>] --format obsidian [--include-symbols] [--json]
  codex-prep graph-query [--repo <path>] (--file <path>|--symbol <name>) [--limit <n>] [--depth <n>] [--json]
  codex-prep refresh-graph [--repo <path>] [--json]

Commands:
  scan         Inspect a repo and print an evidence-backed summary.
  plan         Preview and autosave the onboarding plan draft.
  plan-update  Update the active saved plan before implementation approval.
  plan-status  Show the active saved plan.
  status       Show plan, branch, graph, dashboard, and validation state.
  doctor       Diagnose missing or stale workflow artifacts.
  local-ignore Install repo-local git exclude rules for codex-prep local state.
  validation-record
               Record an explicit validation result in local JSONL memory.
  plan-attach  Attach the active plan to the current branch when work started outside plan-start.
  plan-review  Show keep-planning vs approve-build next actions.
  plan-lint    Check whether the active saved plan is ready to implement.
  plan-approve Mark a lint-clean active plan approved for implementation.
  plan-start   Create the approved plan implementation branch.
  plan-close   Mark the active saved plan as implemented, superseded, or rejected.
  apply        Write or refresh the Codex onboarding bundle.
  check        Detect stale generated guidance and obvious repo drift.
  eval         Run fixed scenarios against the generated guidance.
  graph        Preview the local code graph without writing files.
  orient       Produce a task-aware graph-first reading list to reduce broad file reads.
  graph-export Export the local code graph to adapter formats such as Obsidian Markdown.
  graph-query  Query graph imports, dependents, symbols, and likely tests.
  lint         Lint codex-prep managed files without editing them.
  refresh-graph Write or refresh .codex-prep/codegraph.json.
  refresh-map  Refresh docs/CODEBASE_MAP.md and the manifest.

Planning options:
  --no-save       With plan only, preview without writing plan history.
  --intent TEXT   Set or replace the active plan intent.
  --note TEXT     Append a decision-log note or approve a plan.
  --scope TEXT    Append a proposed scope item.
  --file PATH     Append a likely touched file, or query one graph file.
  --validation TEXT
                  Append a validation step.
  --validation-command TEXT
                  Validation command whose result should be recorded.
  --result TEXT  Validation outcome for validation-record: pass or fail.
  --summary TEXT Short validation result summary.
  --phase TEXT   Workflow phase for validation-record.
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
  --symbol TEXT   Symbol name for graph-query.
  --task TEXT     Task description for orient.
  --limit N       Limit orient or graph-query output. orient defaults to 8.
  --depth N       Neighbor traversal depth for graph-query --file. Defaults to 1.
  --format TEXT   Export format for graph-export. Currently: obsidian.
  --include-symbols
                  With graph-export, include symbol notes. Omitted by default for a cleaner graph.
  --branch TEXT   Branch name for plan-start.
  --base TEXT     Base branch for plan-start. Defaults to main.
  --sync-base     With plan-start, fetch and fast-forward pull the base first.
  --status TEXT   Set plan status with plan-update or plan-close.

Defaults:
  The current working directory is used when --repo is omitted.
  No command uses network access unless plan-start --sync-base is used.
  local-ignore writes only .git/info/exclude and does not edit repo-tracked files.
  scan, check, eval, lint, orient, graph-query, plan-review, and plan-lint do not edit repo-tracked files.
  plan autosaves reviewable planning files, but it never approves implementation.
`);
}
