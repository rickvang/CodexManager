import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_PATH, loadConfig, writeDefaultConfigIfMissing } from "./config.js";
import { buildBundle, buildManagedSection, MANAGED_FILES } from "./generate.js";
import {
  fileExists,
  readJsonIfExists,
  relativePath,
  writeManagedFile,
  writeJsonIfChanged
} from "./fs-utils.js";
import { lintRepo } from "./lint.js";
import { hasErrors, pushFinding } from "./rules.js";
import { scanRepo } from "./scan.js";

export async function scanCommand({ root, json }) {
  const manifest = await scanRepo(root);
  if (json) {
    printJson(manifest);
    return;
  }
  console.log(formatScan(manifest));
}

export async function planCommand({ root, json }) {
  const manifest = await scanRepo(root);
  const bundle = buildBundle(manifest);
  const proposal = {
    repo: manifest.repo,
    summary: manifest.summary,
    proposedWrites: bundle.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      reason: file.reason
    })).concat([
      {
        path: CONFIG_PATH,
        mode: "user-config",
        reason: "Repo-specific codex-prep rule and lint settings; created only when missing."
      },
      {
        path: ".codex-prep/manifest.json",
        mode: "managed-json",
        reason: "Structured repo intelligence manifest used by check, eval, and refresh-map."
      }
    ]),
    assumptions: manifest.assumptions,
    evidence: manifest.evidence
  };

  if (json) {
    printJson(proposal);
    return;
  }

  console.log(formatPlan(proposal));
}

export async function applyCommand({ root, json }) {
  const previousManifest = await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"));
  const manifest = await scanRepo(root, { previousManifest });
  const bundle = buildBundle(manifest);
  const writes = [];

  for (const file of bundle.files) {
    const result = await writeManagedFile(root, file.path, file.content);
    writes.push({ path: file.path, changed: result.changed, mode: file.mode });
  }

  const configResult = await writeDefaultConfigIfMissing(root);
  const configWrite = { path: CONFIG_PATH, changed: configResult.changed, mode: "user-config" };

  const manifestForWrite = finalizeManifest(manifest, previousManifest, writes);
  const manifestResult = await writeJsonIfChanged(
    path.join(root, ".codex-prep", "manifest.json"),
    manifestForWrite
  );
  writes.push(configWrite);
  writes.push({ path: ".codex-prep/manifest.json", changed: manifestResult.changed, mode: "managed-json" });

  const result = { repo: manifest.repo, writes };
  if (json) {
    printJson(result);
    return;
  }

  console.log(formatApply(result));
}

export async function checkCommand({ root, json }) {
  const config = await loadConfig(root);
  const manifestPath = path.join(root, ".codex-prep", "manifest.json");
  const previousManifest = await readJsonIfExists(manifestPath);
  const current = await scanRepo(root, { previousManifest });
  const findings = [];

  if (!previousManifest) {
    pushFinding(findings, config, "missing-manifest", { file: ".codex-prep/manifest.json", message: ".codex-prep/manifest.json is missing." });
  }

  for (const filePath of MANAGED_FILES) {
    if (!(await fileExists(path.join(root, filePath)))) {
      pushFinding(findings, config, "missing-generated-file", { file: filePath, message: `${filePath} is missing.` });
    }
  }

  if (previousManifest) {
    compareStringArrays(findings, "source-roots", previousManifest.discovery?.sourceRoots, current.discovery.sourceRoots, config);
    compareStringArrays(findings, "test-roots", previousManifest.discovery?.testRoots, current.discovery.testRoots, config);
    compareCommands(findings, previousManifest.discovery?.commands, current.discovery.commands, config);
    comparePackageWorkspaces(findings, previousManifest.discovery?.workspacePackages, current.discovery.workspacePackages, config);
  }

  const result = {
    ok: !hasErrors(findings),
    findings
  };

  if (json) {
    printJson(result);
  } else {
    console.log(formatCheck(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function evalCommand({ root, json }) {
  const manifest = (await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"))) ?? await scanRepo(root);
  const scenarios = await runEvalScenarios(root, manifest);
  const result = {
    ok: scenarios.every((scenario) => scenario.pass),
    scenarios
  };

  if (json) {
    printJson(result);
  } else {
    console.log(formatEval(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function lintCommand({ root, json }) {
  const result = await lintRepo(root);

  if (json) {
    printJson(result);
  } else {
    console.log(formatLint(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function refreshMapCommand({ root, json }) {
  const previousManifest = await readJsonIfExists(path.join(root, ".codex-prep", "manifest.json"));
  const manifest = await scanRepo(root, { previousManifest });
  const mapFile = buildBundle(manifest).files.find((file) => file.path === "docs/CODEBASE_MAP.md");
  const mapResult = await writeManagedFile(root, mapFile.path, mapFile.content);
  const manifestForWrite = finalizeManifest(manifest, previousManifest, [{ path: mapFile.path, changed: mapResult.changed }]);
  const manifestResult = await writeJsonIfChanged(
    path.join(root, ".codex-prep", "manifest.json"),
    manifestForWrite
  );

  const result = {
    repo: manifest.repo,
    writes: [
      { path: mapFile.path, changed: mapResult.changed },
      { path: ".codex-prep/manifest.json", changed: manifestResult.changed }
    ]
  };

  if (json) {
    printJson(result);
    return;
  }

  console.log(formatApply(result));
}

function finalizeManifest(manifest, previousManifest, writes) {
  const unchanged = previousManifest?.fingerprint === manifest.fingerprint;
  const now = unchanged && previousManifest?.generatedAt ? previousManifest.generatedAt : new Date().toISOString();
  return {
    ...manifest,
    generatedAt: now,
    repo: {
      ...manifest.repo,
      root: "."
    },
    generatedFiles: writes.map((write) => ({
      path: write.path,
      managed: true
    }))
  };
}

async function runEvalScenarios(root, manifest) {
  const agentsPath = path.join(root, "AGENTS.md");
  const reviewSkillPath = path.join(root, ".agents", "skills", "code-review", "SKILL.md");
  const mapPath = path.join(root, "docs", "CODEBASE_MAP.md");
  const agents = (await fileExists(agentsPath)) ? await fs.readFile(agentsPath, "utf8") : "";
  const map = (await fileExists(mapPath)) ? await fs.readFile(mapPath, "utf8") : "";

  return [
    scenario(
      "find app entrypoint",
      manifest.discovery.entrypoints.length > 0,
      manifest.discovery.entrypoints.join(", ") || "No entrypoints detected."
    ),
    scenario(
      "find test command",
      manifest.discovery.commands.some((command) => /test/i.test(command.name)),
      commandEvidence(manifest, /test/i) || "No test-like command detected."
    ),
    scenario(
      "explain repo structure",
      map.includes("## Repo Shape") && manifest.discovery.topLevel.length > 0,
      manifest.discovery.topLevel.join(", ") || "No top-level structure found."
    ),
    scenario(
      "identify source and test roots",
      manifest.discovery.sourceRoots.length > 0 && manifest.discovery.testRoots.length > 0,
      `source=${manifest.discovery.sourceRoots.join(", ") || "none"}; tests=${manifest.discovery.testRoots.join(", ") || "none"}`
    ),
    scenario(
      "produce a no-edit change plan",
      agents.includes("Explore / Review") && agents.includes("File changes are allowed only"),
      "AGENTS.md contains the explicit Explore / Review boundary."
    ),
    scenario(
      "review a sample diff using repo rules",
      await fileExists(reviewSkillPath),
      ".agents/skills/code-review/SKILL.md exists."
    )
  ];
}

function scenario(name, pass, evidence) {
  return { name, pass, evidence };
}

function commandEvidence(manifest, pattern) {
  const command = manifest.discovery.commands.find((item) => pattern.test(item.name));
  if (!command) {
    return "";
  }
  return `${command.name}: ${command.command}`;
}

function compareStringArrays(findings, name, previous = [], current = [], config = {}) {
  const oldSet = new Set(previous);
  const newSet = new Set(current);
  for (const value of oldSet) {
    if (!newSet.has(value)) {
      pushFinding(findings, config, `${name}-removed`, { message: `${name} entry removed or moved: ${value}` });
    }
  }
  for (const value of newSet) {
    if (!oldSet.has(value)) {
      pushFinding(findings, config, `${name}-added`, { message: `${name} entry added since last apply: ${value}` });
    }
  }
}

function compareCommands(findings, previous = [], current = [], config = {}) {
  const oldMap = new Map(previous.map((command) => [command.name, command.command]));
  const newMap = new Map(current.map((command) => [command.name, command.command]));
  for (const [name, command] of oldMap) {
    if (!newMap.has(name)) {
      pushFinding(findings, config, "command-removed", { message: `command removed since last apply: ${name}` });
    } else if (newMap.get(name) !== command) {
      pushFinding(findings, config, "command-changed", { message: `command changed since last apply: ${name}` });
    }
  }
  for (const [name] of newMap) {
    if (!oldMap.has(name)) {
      pushFinding(findings, config, "command-added", { message: `new command discovered since last apply: ${name}` });
    }
  }
}

function comparePackageWorkspaces(findings, previous = [], current = [], config = {}) {
  compareStringArrays(findings, "workspace-package", previous, current, config);
}

function formatScan(manifest) {
  const lines = [
    `codex-prep scan: ${manifest.repo.name}`,
    "",
    `Root: ${manifest.repo.root}`,
    `Languages: ${manifest.discovery.languages.join(", ") || "unknown"}`,
    `Package managers: ${manifest.discovery.packageManagers.join(", ") || "none detected"}`,
    `Source roots: ${manifest.discovery.sourceRoots.join(", ") || "none detected"}`,
    `Test roots: ${manifest.discovery.testRoots.join(", ") || "none detected"}`,
    `Entrypoints: ${manifest.discovery.entrypoints.join(", ") || "none detected"}`,
    "",
    "Commands:",
    ...manifest.discovery.commands.map((command) => `- ${command.name}: ${command.command}`),
    "",
    "Evidence:",
    ...manifest.evidence.map((item) => `- [${item.confidence}] ${item.fact} (${item.source})`)
  ];
  return lines.join("\n");
}

function formatPlan(proposal) {
  return [
    `codex-prep plan: ${proposal.repo.name}`,
    "",
    proposal.summary,
    "",
    "Proposed writes:",
    ...proposal.proposedWrites.map((write) => `- ${write.path} (${write.mode}): ${write.reason}`),
    "",
    "Assumptions:",
    ...proposal.assumptions.map((assumption) => `- ${assumption}`)
  ].join("\n");
}

function formatApply(result) {
  return [
    `codex-prep apply: ${result.repo.name}`,
    "",
    "Writes:",
    ...result.writes.map((write) => `- ${write.changed ? "updated" : "unchanged"} ${relativePath(write.path)}`)
  ].join("\n");
}

function formatCheck(result) {
  if (result.findings.length === 0) {
    return "codex-prep check: ok\n\nNo obvious generated guidance drift found.";
  }
  return [
    `codex-prep check: ${result.ok ? "ok with warnings" : "drift found"}`,
    "",
    ...result.findings.map((item) => `- [${item.level}] ${item.code} ${item.message} Fix: ${item.fix}`)
  ].join("\n");
}

function formatEval(result) {
  return [
    `codex-prep eval: ${result.ok ? "pass" : "fail"}`,
    "",
    ...result.scenarios.map((item) => `- ${item.pass ? "PASS" : "FAIL"} ${item.name}: ${item.evidence}`)
  ].join("\n");
}

function formatLint(result) {
  if (result.findings.length === 0) {
    return "codex-prep lint: ok\n\nNo managed-file lint findings.";
  }
  return [
    "codex-prep lint: " + (result.ok ? "ok with warnings" : "failed"),
    "",
    ...result.findings.map((item) => "- [" + item.level + "] " + item.code + " " + item.file + ": " + item.message + " Fix: " + item.fix)
  ].join("\n");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export const internals = {
  finalizeManifest,
  runEvalScenarios
};
