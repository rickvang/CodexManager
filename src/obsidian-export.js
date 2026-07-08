import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists, writeFileIfChanged } from "./fs-utils.js";

export const OBSIDIAN_EXPORT_DIR = "docs/obsidian-codegraph";

const GENERATED_MARKER = "<!-- codex-prep:obsidian-export -->";

export async function exportObsidianGraph(root, graph, options = {}) {
  const outputDir = options.outputDir ?? OBSIDIAN_EXPORT_DIR;
  const includeSymbols = options.includeSymbols === true;
  const notes = buildObsidianNotes(graph, {
    outputDir,
    includeSymbols,
    manifest: options.manifest,
    activePlan: options.activePlan,
    validationState: options.validationState
  });
  const writes = [];

  for (const note of notes) {
    const result = await writeFileIfChanged(path.join(root, note.path), note.content);
    writes.push({
      path: note.path,
      changed: result.changed,
      mode: note.kind
    });
  }

  writes.push(...await removeStaleGeneratedNotes(root, outputDir, notes));

  return {
    format: "obsidian",
    outputDir,
    includeSymbols,
    notes: summarizeNotes(notes),
    writes
  };
}

export function buildObsidianNotes(graph, options = {}) {
  const outputDir = options.outputDir ?? OBSIDIAN_EXPORT_DIR;
  const includeSymbols = options.includeSymbols === true;
  const workflow = buildWorkflowMap(graph, options.manifest, options.activePlan, options.validationState);
  const moduleIndex = buildModuleIndex(graph);
  const index = buildNoteIndex(graph, { includeSymbols, moduleIndex });
  const dependentsByFile = buildDependentsByFile(graph);
  const testedSourcesByTest = buildTestSources(graph);
  const notes = [];

  notes.push({
    kind: "obsidian-index",
    path: slashPath(path.posix.join(outputDir, "Index.md")),
    content: renderIndexNote(graph, index, workflow, includeSymbols)
  });
  notes.push({
    kind: "obsidian-workflow-note",
    path: slashPath(path.posix.join(outputDir, "Workflow.md")),
    content: renderWorkflowHub(workflow)
  });
  notes.push({
    kind: "obsidian-workflow-note",
    path: slashPath(path.posix.join(outputDir, "Validations.md")),
    content: renderValidationsNote(workflow)
  });
  notes.push({
    kind: "obsidian-workflow-note",
    path: slashPath(path.posix.join(outputDir, "Troubleshooting.md")),
    content: renderTroubleshootingNote(workflow)
  });
  for (const phase of workflow.phases) {
    notes.push({
      kind: "obsidian-workflow-note",
      path: notePath(phase.note, outputDir),
      content: renderWorkflowPhaseNote(phase, workflow)
    });
  }
  notes.push({
    kind: "obsidian-hub-note",
    path: slashPath(path.posix.join(outputDir, "Modules.md")),
    content: renderModulesHub(graph, index)
  });
  notes.push({
    kind: "obsidian-hub-note",
    path: slashPath(path.posix.join(outputDir, "Entrypoints.md")),
    content: renderEntrypointsHub(graph, index)
  });
  notes.push({
    kind: "obsidian-hub-note",
    path: slashPath(path.posix.join(outputDir, "Source Files.md")),
    content: renderFilesHub(graph, index)
  });
  notes.push({
    kind: "obsidian-hub-note",
    path: slashPath(path.posix.join(outputDir, "Tests.md")),
    content: renderTestsHub(graph, index)
  });
  notes.push({
    kind: "obsidian-hub-note",
    path: slashPath(path.posix.join(outputDir, "Import Graph.md")),
    content: renderImportHub(graph, index)
  });
  if (includeSymbols) {
    notes.push({
      kind: "obsidian-hub-note",
      path: slashPath(path.posix.join(outputDir, "Symbols.md")),
      content: renderSymbolsHub(graph, index)
    });
  }

  for (const moduleNote of index.modules.values()) {
    notes.push({
      kind: "obsidian-module-note",
      path: notePath(moduleNote, outputDir),
      content: renderModuleNote(moduleNote, graph, index)
    });
  }

  for (const file of graph.files ?? []) {
    const note = index.files.get(file.path);
    notes.push({
      kind: file.role === "test" ? "obsidian-test-note" : "obsidian-file-note",
      path: notePath(note, outputDir),
      content: file.role === "test"
        ? renderTestNote(file, index, dependentsByFile, testedSourcesByTest, { includeSymbols })
        : renderFileNote(file, index, dependentsByFile, { includeSymbols })
    });
  }

  if (includeSymbols) {
    for (const symbol of graph.symbols ?? []) {
      notes.push({
        kind: "obsidian-symbol-note",
        path: notePath(index.symbols.get(symbolKey(symbol)), outputDir),
        content: renderSymbolNote(symbol, index)
      });
    }
  }

  return notes.sort((left, right) => left.path.localeCompare(right.path));
}

function buildModuleIndex(graph) {
  const grouped = new Map();
  for (const file of [...graph.files ?? []].sort((left, right) => left.path.localeCompare(right.path))) {
    const key = moduleKey(file.path);
    const files = grouped.get(key) ?? [];
    files.push(file);
    grouped.set(key, files);
  }

  const modules = new Map();
  const fileToModule = new Map();
  const usedTargets = new Set();

  for (const [key, files] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const title = moduleTitle(key);
    const target = uniqueTarget(safePathSegment(key === "." ? "Root" : key), usedTargets, key);
    const moduleNote = {
      directory: "Modules",
      target,
      title,
      key,
      role: moduleRole(files),
      files
    };
    modules.set(key, moduleNote);
    for (const file of files) {
      fileToModule.set(file.path, moduleNote);
    }
  }

  return { modules, fileToModule };
}

function buildNoteIndex(graph, options = {}) {
  const files = new Map();
  const symbols = new Map();
  const includeSymbols = options.includeSymbols === true;
  const moduleIndex = options.moduleIndex ?? buildModuleIndex(graph);
  const usedFileTargets = new Set();

  for (const file of graph.files ?? []) {
    const directory = file.role === "test" ? "Tests" : "Files";
    const target = uniqueTarget(noteTargetFromPath(file.path), usedFileTargets, file.path);
    files.set(file.path, {
      directory,
      target,
      title: file.path,
      path: file.path,
      module: moduleIndex.fileToModule.get(file.path)
    });
  }

  if (includeSymbols) {
    for (const symbol of graph.symbols ?? []) {
      const key = symbolKey(symbol);
      symbols.set(key, {
        directory: "Symbols",
        target: stableSlug(symbol.name, key),
        title: symbol.name,
        path: symbol.file,
        module: moduleIndex.fileToModule.get(symbol.file)
      });
    }
  }

  return {
    files,
    symbols,
    modules: moduleIndex.modules,
    fileToModule: moduleIndex.fileToModule
  };
}

function renderIndexNote(graph, index, workflow, includeSymbols) {
  const files = graph.files ?? [];
  const lines = [
    GENERATED_MARKER,
    "# Code Graph Index",
    "",
    `Repo: ${graph.repo?.name ?? "unknown"}`,
    `Graph fingerprint: ${graph.fingerprint ?? "unknown"}`,
    "",
    "## Start Here",
    "",
    `- ${hubLink("Workflow")}`,
    `- ${hubLink("Validations")}`,
    `- ${hubLink("Troubleshooting")}`,
    `- ${hubLink("Modules")}`,
    `- ${hubLink("Entrypoints")}`,
    `- ${hubLink("Source Files")}`,
    `- ${hubLink("Tests")}`,
    `- ${hubLink("Import Graph")}`
  ];

  if (includeSymbols) {
    lines.push(`- ${hubLink("Symbols")}`);
  }

  lines.push(
    "",
    "## Summary",
    "",
    `- Files: ${graph.summary?.fileCount ?? files.length}`,
    `- Workflow phases: ${workflow.phases.length}`,
    `- Workflow state: ${workflow.summary.status}`,
    `- Modules: ${index.modules.size}`,
    `- Import edges: ${graph.summary?.edgeCount ?? 0}`,
    `- Symbols: ${graph.summary?.symbolCount ?? 0}${includeSymbols ? "" : " (not exported by default)"}`,
    `- Languages: ${formatInlineList(graph.summary?.languages ?? [])}`,
    "",
    "## View Notes",
    "",
    "Use Obsidian Local Graph from this note for the workflow map. Open Workflow first, then a phase, then modules/files as needed."
  );

  return `${lines.join("\n")}\n`;
}


function buildWorkflowMap(graph, manifest, activePlan, validationState) {
  const commands = manifest?.discovery?.commands ?? [];
  const generatedFiles = new Set((manifest?.generatedFiles ?? []).map((item) => item.path));
  const hasCommand = (name) => commands.some((command) => command.name === name || command.command.includes(name));
  const statusFromPlan = activePlan?.build?.status || activePlan?.status || "unknown";
  const latestValidation = validationState?.latest;
  const validationStatus = latestValidation
    ? latestValidation.result === "pass" ? "validated" : "failed"
    : commands.length > 0 ? "configured" : "unknown";
  const phases = [
    workflowPhase("01 Orientation", "orientation", "configured", "Start by reading AGENTS.md, CODEBASE_MAP.md, and the generated code graph before broad searching.", [
      evidenceLine(generatedFiles.has("AGENTS.md"), "AGENTS.md generated guidance is present", "AGENTS.md generated guidance is not listed in manifest"),
      evidenceLine(generatedFiles.has("docs/CODEBASE_MAP.md"), "CODEBASE_MAP.md generated map is present", "CODEBASE_MAP.md generated map is not listed in manifest"),
      evidenceLine(Boolean(graph?.summary), ".codex-prep/codegraph.json is available", "code graph summary is unavailable")
    ], ["codex-prep scan", "codex-prep graph-query --file <path>"]),
    workflowPhase("02 Planning", "planning", activePlan ? activePlan.status : "unknown", "Capture intent, scope, success criteria, stop rules, and likely files before implementation.", [
      activePlan ? `Active plan status: ${activePlan.status}` : "Active plan status: unknown",
      activePlan?.goal ? `Plan goal: ${activePlan.goal}` : "Plan goal: unknown"
    ], ["codex-prep plan", "codex-prep plan-update", "codex-prep plan-lint"]),
    workflowPhase("03 Approval", "approval", activePlan?.build?.approvedAt ? "approved" : "unknown", "Separate planning approval from implementation, commit, and push approval.", [
      activePlan?.build?.approvedAt ? `Approved at: ${activePlan.build.approvedAt}` : "Approval timestamp: unknown",
      activePlan?.build?.approvalNote ? `Approval note: ${activePlan.build.approvalNote}` : "Approval note: unknown"
    ], ["codex-prep plan-review", "codex-prep plan-approve --note <text>"]),
    workflowPhase("04 Build", "build", statusFromPlan, "Implement only the approved scope, then keep generated artifacts synchronized.", [
      activePlan?.build?.branchName ? `Build branch: ${activePlan.build.branchName}` : "Build branch: unknown or not started by plan-start",
      activePlan?.build?.baseCommit ? `Base commit: ${activePlan.build.baseCommit}` : "Base commit: unknown"
    ], ["codex-prep plan-start --branch <name>", "codex-prep apply"]),
    workflowPhase("05 Graph Refresh", "graph-refresh", graph?.generatedAt ? "generated" : "unknown", "Refresh codegraph and Obsidian exports after meaningful source changes.", [
      graph?.generatedAt ? `Code graph generated at: ${graph.generatedAt}` : "Code graph generated timestamp: unknown",
      graph?.fingerprint ? `Code graph fingerprint: ${graph.fingerprint}` : "Code graph fingerprint: unknown"
    ], ["codex-prep refresh-graph", "codex-prep graph-export --format obsidian"]),
    workflowPhase("06 Validation", "validation", validationStatus, "Run the repo validation commands and CodexManager checks before marking work done.", [
      commands.length > 0 ? `Detected commands: ${commands.map((command) => command.command).join(", ")}` : "Detected commands: unknown",
      hasCommand("verify") ? "Verify command is detected" : "Verify command is missing or unknown",
      latestValidation ? `Last validation: ${latestValidation.result} ${latestValidation.command} at ${latestValidation.recordedAt}` : "Last validation: unknown"
    ], commands.map((command) => command.command)),
    workflowPhase("07 Feedback", "feedback", generatedFiles.has("docs/CODEX_FEEDBACK.md") ? "configured" : "unknown", "Capture repeated mistakes, stale guidance, and follow-up improvements instead of expanding the current pass forever.", [
      evidenceLine(generatedFiles.has("docs/CODEX_FEEDBACK.md"), "CODEX_FEEDBACK.md is present", "CODEX_FEEDBACK.md is not listed in manifest"),
      "Later live-state tracking should be captured as follow-up, not invented here."
    ], ["codex-prep check", "codex-prep eval"])
  ];

  return {
    summary: {
      status: summarizeWorkflowStatus(phases),
      commands,
      generatedFiles: [...generatedFiles].sort(),
      validationLatest: latestValidation
    },
    phases,
    troubleshooting: buildTroubleshootingItems(phases, commands, generatedFiles, graph, latestValidation)
  };
}

function workflowPhase(title, key, status, purpose, evidence, validations) {
  return {
    title,
    key,
    status,
    purpose,
    evidence,
    validations: validations.length > 0 ? validations : ["unknown"],
    note: {
      directory: "Workflow",
      target: title,
      title,
      key,
      status
    }
  };
}

function renderWorkflowHub(workflow) {
  return [
    ...frontmatter({ codex_kind: "workflow", codex_status: workflow.summary.status }, ["codex/codegraph", "codex/workflow"]),
    GENERATED_MARKER,
    "# Workflow",
    "",
    "The default map follows the work path first, then drills into modules and files.",
    "",
    "## Traversal",
    "",
    ...listOrNone(workflow.phases.map((phase) => `${workflowPhaseLink(phase)} (${phase.status})`)),
    "",
    "## Cross Checks",
    "",
    `- ${hubLink("Validations")}`,
    `- ${hubLink("Troubleshooting")}`,
    `- ${hubLink("Workflow")}`,
    `- ${hubLink("Validations")}`,
    `- ${hubLink("Troubleshooting")}`,
    `- ${hubLink("Modules")}`,
    "",
    `Back to ${indexLink()}`
  ].join("\n") + "\n";
}

function renderWorkflowPhaseNote(phase, workflow) {
  const index = workflow.phases.findIndex((item) => item.key === phase.key);
  const previous = workflow.phases[index - 1];
  const next = workflow.phases[index + 1];
  return [
    ...frontmatter({ codex_kind: "workflow-phase", codex_phase: phase.key, codex_status: phase.status }, ["codex/codegraph", "codex/workflow", `codex/phase/${tagSafe(phase.key)}`, `codex/status/${tagSafe(phase.status)}`]),
    GENERATED_MARKER,
    `# ${phase.title}`,
    "",
    `Status: ${phase.status}`,
    "",
    "## Purpose",
    "",
    phase.purpose,
    "",
    "## Evidence",
    "",
    ...listOrNone(phase.evidence),
    "",
    "## Validations",
    "",
    ...listOrNone(phase.validations.map((validation) => inlineCode(validation))),
    "",
    "## Traverse",
    "",
    previous ? `Previous: ${workflowPhaseLink(previous)}` : "Previous: none",
    next ? `Next: ${workflowPhaseLink(next)}` : "Next: none",
    "",
    `Back to ${hubLink("Workflow")}`,
    `Check ${hubLink("Troubleshooting")}`
  ].join("\n") + "\n";
}

function renderValidationsNote(workflow) {
  return [
    ...frontmatter({ codex_kind: "validation-map", codex_status: workflow.summary.status }, ["codex/codegraph", "codex/validation"]),
    GENERATED_MARKER,
    "# Validations",
    "",
    "Validation commands grouped by workflow phase. Commands marked unknown require repo inspection before use.",
    "",
    "## Latest Result",
    "",
    ...latestValidationLines(workflow.summary.validationLatest),
    "",
    ...workflow.phases.flatMap((phase) => [
      `## ${phase.title}`,
      "",
      `Status: ${phase.status}`,
      "",
      ...listOrNone(phase.validations.map((validation) => inlineCode(validation))),
      ""
    ]),
    `Back to ${hubLink("Workflow")}`
  ].join("\n") + "\n";
}

function renderTroubleshootingNote(workflow) {
  return [
    ...frontmatter({ codex_kind: "troubleshooting-map", codex_status: workflow.summary.status }, ["codex/codegraph", "codex/troubleshooting"]),
    GENERATED_MARKER,
    "# Troubleshooting",
    "",
    "Use this note to find missing or stale workflow pieces without jumping straight into raw source files.",
    "",
    "## Checks",
    "",
    ...listOrNone(workflow.troubleshooting.map((item) => `${item.status}: ${item.message} (${item.fix})`)),
    "",
    `Back to ${hubLink("Workflow")}`
  ].join("\n") + "\n";
}

function latestValidationLines(latestValidation) {
  if (!latestValidation) {
    return ["- none recorded"];
  }
  return [
    `- Result: ${latestValidation.result}`,
    `- Command: ${inlineCode(latestValidation.command || "unknown")}`,
    `- Recorded: ${latestValidation.recordedAt || "unknown"}`,
    `- Summary: ${latestValidation.summary || "none"}`
  ];
}

function summarizeWorkflowStatus(phases) {
  if (phases.some((phase) => phase.status === "unknown")) {
    return "partially-known";
  }
  if (phases.some((phase) => phase.status === "needs-review" || phase.status === "stale")) {
    return "needs-review";
  }
  return "configured";
}

function buildTroubleshootingItems(phases, commands, generatedFiles, graph, latestValidation) {
  const items = [];
  for (const phase of phases) {
    if (phase.status === "unknown") {
      items.push({ status: "unknown", message: `${phase.title} has unknown state`, fix: `Open ${workflowPhaseLink(phase)} and inspect evidence` });
    }
  }
  if (!commands.some((command) => command.name === "verify" || command.command.includes("verify"))) {
    items.push({ status: "missing", message: "No verify command detected", fix: "Add or document a verification command" });
  }
  if (!generatedFiles.has("docs/CODEX_FEEDBACK.md")) {
    items.push({ status: "missing", message: "Feedback ledger is not listed as generated", fix: "Run codex-prep apply" });
  }
  if (!graph?.fingerprint) {
    items.push({ status: "unknown", message: "Code graph fingerprint is unavailable", fix: "Run codex-prep refresh-graph" });
  }
  if (latestValidation?.result === "fail") {
    items.push({ status: "failed", message: `Latest validation failed: ${latestValidation.command}`, fix: "Fix the failure, rerun validation, and record the passing result" });
  }
  if (items.length === 0) {
    items.push({ status: "ok", message: "No obvious workflow map gaps detected", fix: "Continue normal validation" });
  }
  return items;
}

function evidenceLine(condition, present, missing) {
  return condition ? present : missing;
}

function workflowPhaseLink(phase) {
  return wikiLink(phase.note, phase.title);
}
function renderModulesHub(graph, index) {
  return renderHub("Modules", [
    "Repository areas grouped by top-level path. Open one module before expanding to files.",
    "",
    ...listOrNone([...index.modules.values()].map((moduleNote) => `${moduleLink(moduleNote)} (${moduleNote.role}, ${moduleNote.files.length} files)`)),
    "",
    `Back to ${indexLink()}`
  ]);
}

function renderEntrypointsHub(graph, index) {
  const entrypoints = (graph.relationships ?? [])
    .filter((item) => item.kind === "entrypoint")
    .map((item) => item.file)
    .filter(Boolean);
  const modules = modulesForPaths(entrypoints, index);

  return renderHub("Entrypoints", [
    "Files detected as likely ways into the application or CLI.",
    "",
    "## Areas",
    "",
    ...listOrNone(modules.map((moduleNote) => moduleLink(moduleNote))),
    "",
    "## Files",
    "",
    ...listOrNone(entrypoints.map((filePath) => fileLink(index, filePath))),
    "",
    `Back to ${indexLink()}`
  ]);
}

function renderFilesHub(graph, index) {
  const sources = (graph.files ?? []).filter((file) => file.role !== "test");
  const modules = modulesForFiles(sources, index);
  return renderHub("Source Files", [
    "Source and support files grouped by repository area.",
    "",
    ...listOrNone(modules.map((moduleNote) => `${moduleLink(moduleNote)} (${moduleNote.files.filter((file) => file.role !== "test").length} files)`)),
    "",
    `Back to ${indexLink()}`
  ]);
}

function renderTestsHub(graph, index) {
  const tests = (graph.files ?? []).filter((file) => file.role === "test");
  const modules = modulesForFiles(tests, index);
  return renderHub("Tests", [
    "Test files grouped by repository area.",
    "",
    ...listOrNone(modules.map((moduleNote) => `${moduleLink(moduleNote)} (${moduleNote.files.filter((file) => file.role === "test").length} tests)`)),
    "",
    "## Source Relationships",
    "",
    ...listOrNone((graph.relationships ?? [])
      .filter((item) => item.kind === "tested-by")
      .map((item) => `${inlineCode(item.source)} -> ${inlineCode(item.test)} [${item.confidence}]`)),
    "",
    `Back to ${indexLink()}`
  ]);
}

function renderImportHub(graph, index) {
  const groupedEdges = groupImportEdgesByModule(graph, index);
  return renderHub("Import Graph", [
    "Local import edges summarized by module. File-level import links live on file notes.",
    "",
    "## Module Edges",
    "",
    ...listOrNone(groupedEdges.map((item) => `${moduleLink(item.from)} -> ${moduleLink(item.to)} (${item.count} edges)`)),
    "",
    "## File Edges",
    "",
    ...listOrNone((graph.edges ?? []).map((edge) => `${inlineCode(edge.from)} -> ${inlineCode(edge.to)} [${edge.confidence}]`)),
    "",
    `Back to ${indexLink()}`
  ]);
}

function renderSymbolsHub(graph, index) {
  return renderHub("Symbols", [
    "Top-level and exported symbols. This hub is only generated with --include-symbols.",
    "",
    ...listOrNone((graph.symbols ?? []).map((symbol) => symbolLink(index, symbol))),
    "",
    `Back to ${indexLink()}`
  ]);
}

function renderModuleNote(moduleNote, graph, index) {
  const filePaths = new Set(moduleNote.files.map((file) => file.path));
  const internalEdges = (graph.edges ?? []).filter((edge) => filePaths.has(edge.from) && filePaths.has(edge.to));
  const crossEdges = (graph.edges ?? []).filter((edge) => filePaths.has(edge.from) !== filePaths.has(edge.to));
  const parentHub = moduleNote.role === "test" ? hubLink("Tests") : hubLink("Source Files");

  return [
    ...frontmatter({
      codex_kind: "module",
      codex_module: moduleNote.key,
      codex_role: moduleNote.role,
      codex_files: moduleNote.files.length
    }, ["codex/codegraph", "codex/module", `codex/module/${tagSafe(moduleNote.key)}`]),
    GENERATED_MARKER,
    `# ${moduleNote.title}`,
    "",
    `Role: ${moduleNote.role}`,
    `Files: ${moduleNote.files.length}`,
    "",
    "## Files",
    "",
    ...listOrNone(moduleNote.files.map((file) => `${fileLink(index, file.path)} (${file.role}, ${file.language})`)),
    "",
    "## Internal Imports",
    "",
    ...listOrNone(internalEdges.map((edge) => `${inlineCode(edge.from)} -> ${inlineCode(edge.to)} [${edge.confidence}]`)),
    "",
    "## Cross-Module Imports",
    "",
    ...listOrNone(crossEdges.map((edge) => `${inlineCode(edge.from)} -> ${inlineCode(edge.to)} [${edge.confidence}]`)),
    "",
    "## Graph",
    "",
    `Back to ${hubLink("Modules")}`,
    `Also in ${parentHub}`
  ].join("\n") + "\n";
}

function renderHub(title, lines) {
  return [GENERATED_MARKER, `# ${title}`, "", ...lines].join("\n") + "\n";
}

function renderFileNote(file, index, dependentsByFile, options = {}) {
  const moduleNote = index.fileToModule.get(file.path);
  return [
    ...frontmatter({
      codex_kind: "file",
      codex_role: file.role,
      codex_language: file.language,
      codex_module: moduleNote?.key ?? ".",
      codex_path: file.path
    }, fileTags(file, moduleNote)),
    GENERATED_MARKER,
    `# ${file.path}`,
    "",
    `Area: ${moduleNote ? moduleLink(moduleNote) : "unknown"}`,
    `Role: ${file.role}`,
    `Language: ${file.language}`,
    `Confidence: ${file.confidence}`,
    `Size: ${file.size} bytes`,
    "",
    "## Imports",
    "",
    ...listOrNone((file.imports ?? []).map((item) => importLine(index, item))),
    "",
    "## Imported By",
    "",
    ...listOrNone((dependentsByFile.get(file.path) ?? []).map((dependent) => fileLink(index, dependent))),
    "",
    "## Symbols",
    "",
    ...listOrNone(formatSymbols(file, index, options)),
    "",
    "## Likely Tests",
    "",
    ...listOrNone((file.relatedTests ?? []).map((item) => `${fileLink(index, item.path)} [${item.confidence}] - ${item.reason}`)),
    "",
    "## Raw Path",
    "",
    inlineCode(file.path),
    "",
    "## Graph",
    "",
    `Back to ${moduleNote ? moduleLink(moduleNote) : hubLink("Source Files")}`
  ].join("\n") + "\n";
}

function renderTestNote(file, index, dependentsByFile, testedSourcesByTest, options = {}) {
  const moduleNote = index.fileToModule.get(file.path);
  return [
    ...frontmatter({
      codex_kind: "file",
      codex_role: "test",
      codex_language: file.language,
      codex_module: moduleNote?.key ?? ".",
      codex_path: file.path
    }, fileTags(file, moduleNote)),
    GENERATED_MARKER,
    `# ${file.path}`,
    "",
    `Area: ${moduleNote ? moduleLink(moduleNote) : "unknown"}`,
    "Role: test",
    `Language: ${file.language}`,
    `Confidence: ${file.confidence}`,
    "",
    "## Tested Sources",
    "",
    ...listOrNone((testedSourcesByTest.get(file.path) ?? []).map((item) => `${fileLink(index, item.source)} [${item.confidence}] - ${item.reason}`)),
    "",
    "## Imports",
    "",
    ...listOrNone((file.imports ?? []).map((item) => importLine(index, item))),
    "",
    "## Imported By",
    "",
    ...listOrNone((dependentsByFile.get(file.path) ?? []).map((dependent) => fileLink(index, dependent))),
    "",
    "## Symbols",
    "",
    ...listOrNone(formatSymbols(file, index, options)),
    "",
    "## Raw Path",
    "",
    inlineCode(file.path),
    "",
    "## Graph",
    "",
    `Back to ${moduleNote ? moduleLink(moduleNote) : hubLink("Tests")}`
  ].join("\n") + "\n";
}

function renderSymbolNote(symbol, index) {
  const moduleNote = index.fileToModule.get(symbol.file);
  return [
    ...frontmatter({
      codex_kind: "symbol",
      codex_role: symbol.kind,
      codex_module: moduleNote?.key ?? ".",
      codex_path: symbol.file
    }, ["codex/codegraph", "codex/symbol", `codex/module/${tagSafe(moduleNote?.key ?? ".")}`]),
    GENERATED_MARKER,
    `# ${symbol.name}`,
    "",
    `Kind: ${symbol.kind}`,
    `Exported: ${symbol.exported ? "yes" : "no"}`,
    `Confidence: ${symbol.confidence}`,
    "",
    "## Defined In",
    "",
    `- ${fileLink(index, symbol.file)}`,
    "",
    "## Raw Name",
    "",
    inlineCode(symbol.name),
    "",
    "## Graph",
    "",
    `Back to ${hubLink("Symbols")}`,
    moduleNote ? `Area: ${moduleLink(moduleNote)}` : "Area: unknown"
  ].join("\n") + "\n";
}

function buildDependentsByFile(graph) {
  const dependents = new Map();
  for (const edge of graph.edges ?? []) {
    if (!edge.to) {
      continue;
    }
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }
  for (const [filePath, list] of dependents) {
    dependents.set(filePath, uniqueSorted(list));
  }
  return dependents;
}

function buildTestSources(graph) {
  const tests = new Map();
  for (const relationship of graph.relationships ?? []) {
    if (relationship.kind !== "tested-by") {
      continue;
    }
    const list = tests.get(relationship.test) ?? [];
    list.push({
      source: relationship.source,
      confidence: relationship.confidence,
      reason: relationship.reason
    });
    tests.set(relationship.test, list);
  }
  for (const [testPath, list] of tests) {
    tests.set(testPath, list.sort((left, right) => left.source.localeCompare(right.source)));
  }
  return tests;
}

function groupImportEdgesByModule(graph, index) {
  const groups = new Map();
  for (const edge of graph.edges ?? []) {
    const from = index.fileToModule.get(edge.from);
    const to = index.fileToModule.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const key = `${from.key}\u0000${to.key}`;
    const current = groups.get(key) ?? { from, to, count: 0 };
    current.count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => {
    const byFrom = left.from.title.localeCompare(right.from.title);
    return byFrom || left.to.title.localeCompare(right.to.title);
  });
}

async function removeStaleGeneratedNotes(root, outputDir, notes) {
  const outputPath = path.join(root, outputDir);
  if (!(await fileExists(outputPath))) {
    return [];
  }

  const keep = new Set(notes.map((note) => note.path));
  const existing = await collectMarkdownFiles(outputPath);
  const removed = [];

  for (const absolutePath of existing) {
    const relative = slashPath(path.relative(root, absolutePath));
    if (keep.has(relative)) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    if (!content.includes(GENERATED_MARKER)) {
      continue;
    }
    await fs.rm(absolutePath, { force: true });
    removed.push({ path: relative, changed: true, removed: true, mode: "obsidian-stale-note" });
  }

  await pruneEmptyDirectories(outputPath, outputPath);
  return removed;
}

async function collectMarkdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

async function pruneEmptyDirectories(directory, rootDirectory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await pruneEmptyDirectories(path.join(directory, entry.name), rootDirectory);
    }
  }
  const remaining = await fs.readdir(directory);
  if (remaining.length === 0 && directory !== rootDirectory) {
    await fs.rmdir(directory);
  }
}

function importLine(index, item) {
  if (item.resolved) {
    return `${inlineCode(item.specifier)} -> ${fileLink(index, item.resolved)} [${item.confidence}]`;
  }
  return `${inlineCode(item.specifier)} (${item.kind}, ${item.confidence})`;
}

function formatSymbols(file, index, options = {}) {
  const symbols = file.symbols ?? [];
  if (options.includeSymbols) {
    return symbols.map((symbol) => symbolLink(index, { ...symbol, file: file.path }));
  }
  return symbols.map((symbol) => `${symbol.name} (${symbol.kind}${symbol.exported ? ", exported" : ""})`);
}

function modulesForFiles(files, index) {
  return modulesForPaths(files.map((file) => file.path), index);
}

function modulesForPaths(filePaths, index) {
  const modules = new Map();
  for (const filePath of filePaths) {
    const moduleNote = index.fileToModule.get(filePath);
    if (moduleNote) {
      modules.set(moduleNote.key, moduleNote);
    }
  }
  return [...modules.values()].sort((left, right) => left.title.localeCompare(right.title));
}

function fileLink(index, filePath) {
  const note = index.files.get(filePath);
  if (!note) {
    return inlineCode(filePath);
  }
  return wikiLink(note, filePath);
}

function moduleLink(moduleNote) {
  return wikiLink(moduleNote, moduleNote.title);
}

function symbolLink(index, symbol) {
  const note = index.symbols.get(symbolKey(symbol));
  if (!note) {
    return inlineCode(symbol.name);
  }
  return wikiLink(note, `${symbol.name} (${symbol.kind})`);
}

function indexLink() {
  return "[[Index|Code Graph Index]]";
}

function hubLink(name) {
  return `[[${name}|${name}]]`;
}

function wikiLink(note, label) {
  return `[[${note.directory}/${note.target}|${escapeWikiLabel(label)}]]`;
}

function notePath(note, outputDir) {
  return slashPath(path.posix.join(outputDir, note.directory, `${note.target}.md`));
}

function moduleKey(filePath) {
  const segments = slashPath(filePath).split("/").filter(Boolean);
  return segments.length > 1 ? segments[0] : ".";
}

function moduleTitle(key) {
  return key === "." ? "Root" : key;
}

function moduleRole(files) {
  if (files.length > 0 && files.every((file) => file.role === "test")) {
    return "test";
  }
  if (files.length > 0 && files.every((file) => file.role !== "test")) {
    return "source";
  }
  return "mixed";
}

function fileTags(file, moduleNote) {
  return [
    "codex/codegraph",
    `codex/${tagSafe(file.role)}`,
    `codex/module/${tagSafe(moduleNote?.key ?? ".")}`
  ];
}

function frontmatter(properties, tags = []) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(properties)) {
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  if (tags.length > 0) {
    lines.push("tags:");
    for (const tag of tags) {
      lines.push(`  - ${tag}`);
    }
  }
  lines.push("---", "");
  return lines;
}

function yamlValue(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(String(value));
}

function tagSafe(value) {
  const text = String(value === "." ? "root" : value)
    .replace(/[^A-Za-z0-9/_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || "unknown";
}

function noteTargetFromPath(filePath) {
  return slashPath(filePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => safePathSegment(segment))
    .join("/") || "Root";
}

function safePathSegment(value) {
  const segment = String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!segment || segment === "." || segment === "..") {
    return "_";
  }
  return segment;
}

function uniqueTarget(baseTarget, usedTargets, uniqueValue) {
  const normalized = baseTarget.toLowerCase();
  if (!usedTargets.has(normalized)) {
    usedTargets.add(normalized);
    return baseTarget;
  }

  const segments = baseTarget.split("/");
  const last = segments.pop() || "note";
  segments.push(`${last}_${hash8(uniqueValue)}`);
  const target = segments.join("/");
  usedTargets.add(target.toLowerCase());
  return target;
}

function symbolKey(symbol) {
  return `${symbol.file}\u0000${symbol.name}\u0000${symbol.kind}`;
}

function stableSlug(label, uniqueValue) {
  const base = label
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "note";
  return `${base}_${hash8(uniqueValue)}`;
}

function hash8(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function summarizeNotes(notes) {
  return {
    total: notes.length,
    index: notes.filter((note) => note.kind === "obsidian-index").length,
    hubs: notes.filter((note) => note.kind === "obsidian-hub-note").length,
    workflows: notes.filter((note) => note.kind === "obsidian-workflow-note").length,
    modules: notes.filter((note) => note.kind === "obsidian-module-note").length,
    files: notes.filter((note) => note.kind === "obsidian-file-note").length,
    tests: notes.filter((note) => note.kind === "obsidian-test-note").length,
    symbols: notes.filter((note) => note.kind === "obsidian-symbol-note").length
  };
}

function listOrNone(values) {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function formatInlineList(values) {
  return values.length > 0 ? values.join(", ") : "none";
}

function inlineCode(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function escapeWikiLabel(value) {
  return String(value).replace(/\|/g, "-").replace(/\]/g, ")").replace(/\[/g, "(");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function slashPath(value) {
  return String(value).replace(/\\/g, "/");
}
