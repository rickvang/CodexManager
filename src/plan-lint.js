import { compilePatterns } from "./config.js";
import { hasErrors, pushFinding } from "./rules.js";

const VALIDATION_COMMAND_PATTERN = /(^|[-:_\s])(test|lint|check|verify|build|typecheck|e2e|playwright)([-:_\s]|$)/i;
const BROWSER_VALIDATION_PATTERN = /\b(playwright|cypress|selenium|browser|e2e|ui|storybook)\b|vitest.*browser/i;
const WEB_FRAMEWORKS = new Set(["React", "Next.js", "Vue", "Svelte", "Vite"]);

const RISKY_TOPICS = [
  { topic: "destructive file or data changes", pattern: /\b(delete|remove|destroy|destructive|drop|truncate|reset)\b/i },
  { topic: "database or schema changes", pattern: /\b(database|schema|migration|migrate|sql|postgres|neon)\b/i },
  { topic: "dependency installation", pattern: /\b(install|dependency|dependencies|package manager|npm install|pnpm add|yarn add|pip install)\b/i },
  { topic: "git publishing", pattern: /\b(commit|push|pull request|merge|release)\b/i },
  { topic: "deployment", pattern: /\b(deploy|deployment|production|cloud)\b/i }
];

const PERMISSION_GATE_PATTERN = /\b(approval|authorize|authorized|permission|confirm|explicit|separate)\b|\bdo not\b|\bwithout\b/i;

export function lintPlan({ plan, source, manifest, config = {} }) {
  const findings = [];
  const file = source ?? ".codex-prep/plans/active-plan.json";

  if (!plan) {
    pushFinding(findings, config, "plan-missing", {
      file,
      message: "No active saved plan found."
    });
    return buildResult({ plan, source: file, manifest, findings });
  }

  if (!hasText(plan.goal) && !hasText(plan.userIntent)) {
    pushFinding(findings, config, "plan-missing-goal", { file });
  }

  if (!hasItems(plan.successCriteria)) {
    pushFinding(findings, config, "plan-missing-success-criteria", { file });
  }

  if (!hasItems(plan.validationPlan)) {
    pushFinding(findings, config, "plan-missing-validation", { file });
  }

  if (!hasItems(plan.stopRules)) {
    pushFinding(findings, config, "plan-missing-stop-rules", { file });
  }

  if (plan.riskLevel === "high" && !hasItems(plan.approvalBoundaries)) {
    pushFinding(findings, config, "plan-high-risk-missing-approval-boundaries", { file });
  }

  const riskyTopics = findRiskyTopics(plan);
  if (riskyTopics.length > 0 && !hasRiskPermissionGate(plan)) {
    pushFinding(findings, config, "plan-risky-action-missing-permission-gate", {
      file,
      message: `Plan mentions ${riskyTopics.join(", ")} without explicit permission gates.`
    });
  }

  if (!hasItems(plan.filesLikelyTouched)) {
    pushFinding(findings, config, "plan-missing-files", { file });
  }

  if (!hasItems(plan.nonGoals)) {
    pushFinding(findings, config, "plan-missing-non-goals", { file });
  }

  if ((plan.openQuestions ?? []).length > 3) {
    pushFinding(findings, config, "plan-too-many-open-questions", {
      file,
      message: `Plan has ${(plan.openQuestions ?? []).length} open questions; keep the next planning turn focused on three or fewer.`
    });
  }

  if (!hasText(plan.targetAgent)) {
    pushFinding(findings, config, "plan-missing-target-agent", { file });
  }

  lintValidationAgainstRepo(plan, manifest, findings, config, file);
  lintBrowserValidation(plan, manifest, findings, config, file);
  lintPlanSecrets(plan, findings, config, file);

  return buildResult({ plan, source: file, manifest, findings });
}

function lintValidationAgainstRepo(plan, manifest, findings, config, file) {
  const validation = plan.validationPlan ?? [];
  if (validation.length === 0) {
    return;
  }

  const commands = repoValidationCommands(manifest);
  if (commands.length === 0) {
    return;
  }

  if (!mentionsDetectedCommand(validation, commands)) {
    pushFinding(findings, config, "plan-validation-ignores-detected-commands", {
      file,
      message: `Validation does not mention detected repo command(s): ${commands.map((command) => command.command).join(", ")}.`
    });
  }
}

function lintBrowserValidation(plan, manifest, findings, config, file) {
  const validation = plan.validationPlan ?? [];
  if (validation.length === 0) {
    return;
  }

  const playwright = detectPlaywright(manifest);
  const hasBrowserValidation = validation.some((step) => BROWSER_VALIDATION_PATTERN.test(step));

  if (playwright.available && !hasBrowserValidation) {
    pushFinding(findings, config, "plan-playwright-validation-available", {
      file,
      message: `Playwright appears available; consider ${playwright.command} when browser behavior is in scope.`
    });
    return;
  }

  if (isWebRepo(manifest) && !hasBrowserValidation) {
    pushFinding(findings, config, "plan-web-missing-browser-validation", { file });
  }
}

function lintPlanSecrets(plan, findings, config, file) {
  const text = planText(plan);
  const { compiled } = compilePatterns(config.lint?.secretPatterns ?? []);
  if (compiled.some((pattern) => pattern.test(text))) {
    pushFinding(findings, config, "plan-secret-looking-content", { file });
  }
}

function buildResult({ plan, source, manifest, findings }) {
  return {
    ok: !hasErrors(findings),
    source,
    plan: plan
      ? {
          status: plan.status,
          goal: plan.goal,
          userIntent: plan.userIntent,
          riskLevel: plan.riskLevel,
          targetAgent: plan.targetAgent,
          updatedAt: plan.updatedAt
        }
      : undefined,
    detected: {
      commands: repoValidationCommands(manifest).map((command) => command.command),
      playwrightCommand: detectPlaywright(manifest).command
    },
    findings
  };
}

function repoValidationCommands(manifest) {
  const commands = manifest?.discovery?.commands ?? [];
  const validationCommands = commands.filter((command) =>
    VALIDATION_COMMAND_PATTERN.test(command.name) || VALIDATION_COMMAND_PATTERN.test(command.script ?? "")
  );
  return validationCommands.length > 0 ? validationCommands : commands;
}

function mentionsDetectedCommand(validation, commands) {
  const text = validation.join("\n").toLowerCase();
  return commands.some((command) => {
    const name = String(command.name ?? "").toLowerCase();
    const fullCommand = String(command.command ?? "").toLowerCase();
    return text.includes(fullCommand) || (name && text.includes(`run ${name}`)) || (name && text.includes(name));
  });
}

function detectPlaywright(manifest) {
  const frameworks = manifest?.discovery?.frameworks ?? [];
  const commands = manifest?.discovery?.commands ?? [];
  const command = commands.find((item) => /playwright/i.test(`${item.name} ${item.command} ${item.script ?? ""}`));
  const available = frameworks.includes("Playwright") || Boolean(command);
  return {
    available,
    command: command?.command ?? (available ? "npx playwright test" : undefined)
  };
}

function isWebRepo(manifest) {
  const discovery = manifest?.discovery ?? {};
  const frameworks = discovery.frameworks ?? [];
  return frameworks.some((framework) => WEB_FRAMEWORKS.has(framework)) ||
    (discovery.entrypoints ?? []).some((entrypoint) => /^(app|pages|client)\//.test(entrypoint)) ||
    (discovery.sourceRoots ?? []).some((root) => ["app", "client"].includes(root));
}

function findRiskyTopics(plan) {
  const text = planText(plan);
  return RISKY_TOPICS.filter((topic) => topic.pattern.test(text)).map((topic) => topic.topic);
}

function hasRiskPermissionGate(plan) {
  return hasItems(plan.approvalBoundaries) || hasItems(plan.forbiddenActions) || PERMISSION_GATE_PATTERN.test(planText(plan));
}

function planText(plan) {
  return JSON.stringify(plan ?? {});
}

function hasItems(value) {
  return Array.isArray(value) && value.some(hasText);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}