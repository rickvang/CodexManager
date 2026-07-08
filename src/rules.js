export const RULES = {
  "missing-managed-file": {
    id: "CP001",
    defaultLevel: "error",
    description: "A generated managed file is missing.",
    fix: "Run codex-prep apply for this repo, then review the generated file."
  },
  "invalid-managed-markers": {
    id: "CP002",
    defaultLevel: "error",
    description: "A managed file does not contain exactly one codex-prep marker pair.",
    fix: "Restore one codex-prep begin marker and one codex-prep end marker, or regenerate with codex-prep apply."
  },
  "invalid-managed-marker-order": {
    id: "CP003",
    defaultLevel: "error",
    description: "A managed file has codex-prep markers in the wrong order.",
    fix: "Move the begin marker before the end marker, or regenerate with codex-prep apply."
  },
  "missing-manifest": {
    id: "CP004",
    defaultLevel: "error",
    description: "The codex-prep manifest is missing.",
    fix: "Run codex-prep apply to generate .codex-prep/manifest.json."
  },
  "invalid-manifest-json": {
    id: "CP005",
    defaultLevel: "error",
    description: "The manifest is not valid JSON.",
    fix: "Fix the JSON syntax or regenerate the manifest with codex-prep apply."
  },
  "manifest-missing-field": {
    id: "CP006",
    defaultLevel: "error",
    description: "The manifest is missing a required top-level field.",
    fix: "Run codex-prep apply to refresh the manifest schema."
  },
  "manifest-root-mismatch": {
    id: "CP007",
    defaultLevel: "error",
    description: "The manifest was generated for a different repository root.",
    fix: "Run codex-prep apply --repo <current-repo> to refresh the manifest."
  },
  "manifest-generated-file-missing": {
    id: "CP008",
    defaultLevel: "error",
    description: "The manifest does not list an expected managed file.",
    fix: "Run codex-prep apply to refresh generatedFiles metadata."
  },
  "missing-skill": {
    id: "CP009",
    defaultLevel: "error",
    description: "A repo skill file is missing.",
    fix: "Run codex-prep apply to recreate missing repo skills."
  },
  "skill-missing-frontmatter": {
    id: "CP010",
    defaultLevel: "error",
    description: "A skill file is missing YAML-style frontmatter.",
    fix: "Add frontmatter with name and description, or regenerate with codex-prep apply."
  },
  "skill-frontmatter-missing-field": {
    id: "CP011",
    defaultLevel: "error",
    description: "A skill frontmatter block is missing a required field.",
    fix: "Add the missing name or description field."
  },
  "stale-path-reference": {
    id: "CP012",
    defaultLevel: "error",
    description: "Managed content contains a path that looks stale for this repo.",
    fix: "Refresh generated files or update lint.stalePathPatterns in .codex-prep/config.json."
  },
  "secret-looking-content": {
    id: "CP013",
    defaultLevel: "error",
    description: "Managed content contains text that looks like a secret.",
    fix: "Remove the secret-looking value and rotate it if it was real."
  },
  "missing-config": {
    id: "CP014",
    defaultLevel: "warning",
    description: "The repo does not have a codex-prep config file.",
    fix: "Run codex-prep apply to create .codex-prep/config.json."
  },
  "invalid-config-json": {
    id: "CP015",
    defaultLevel: "error",
    description: "The codex-prep config file is not valid JSON.",
    fix: "Fix .codex-prep/config.json syntax or recreate it from defaults."
  },
  "invalid-lint-pattern": {
    id: "CP016",
    defaultLevel: "error",
    description: "A configured lint regex pattern is invalid.",
    fix: "Fix the regex string in .codex-prep/config.json."
  },
  "missing-generated-file": {
    id: "CP101",
    defaultLevel: "error",
    description: "A generated onboarding file is missing.",
    fix: "Run codex-prep apply to regenerate missing files."
  },
  "source-roots-removed": {
    id: "CP102",
    defaultLevel: "error",
    description: "A previously detected source root disappeared.",
    fix: "Confirm the move and run codex-prep apply or refresh-map."
  },
  "source-roots-added": {
    id: "CP103",
    defaultLevel: "warning",
    description: "A new source root appeared since the last apply.",
    fix: "Review the new root and run codex-prep apply if it should be documented."
  },
  "test-roots-removed": {
    id: "CP104",
    defaultLevel: "error",
    description: "A previously detected test root disappeared.",
    fix: "Confirm the move and run codex-prep apply or refresh-map."
  },
  "test-roots-added": {
    id: "CP105",
    defaultLevel: "warning",
    description: "A new test root appeared since the last apply.",
    fix: "Review the new test root and run codex-prep apply if it should be documented."
  },
  "command-removed": {
    id: "CP106",
    defaultLevel: "error",
    description: "A previously detected validation command was removed.",
    fix: "Update repo scripts or run codex-prep apply to refresh guidance."
  },
  "command-changed": {
    id: "CP107",
    defaultLevel: "error",
    description: "A previously detected validation command changed.",
    fix: "Review the new command and run codex-prep apply to update guidance."
  },
  "command-added": {
    id: "CP108",
    defaultLevel: "warning",
    description: "A new command appeared since the last apply.",
    fix: "Run codex-prep apply if Codex should use this command."
  },
  "workspace-package-removed": {
    id: "CP109",
    defaultLevel: "error",
    description: "A previously detected workspace package disappeared.",
    fix: "Confirm the move and run codex-prep apply or refresh-map."
  },
  "workspace-package-added": {
    id: "CP110",
    defaultLevel: "warning",
    description: "A new workspace package appeared since the last apply.",
    fix: "Review the package and run codex-prep apply if it should be documented."
  }
};

export function pushFinding(findings, config, ruleName, fields = {}) {
  const finding = applyRuleConfig(createFinding(ruleName, fields), config);
  if (finding) {
    findings.push(finding);
  }
}

export function createFinding(ruleName, fields = {}) {
  const rule = RULES[ruleName] ?? {
    id: "CP999",
    defaultLevel: "error",
    description: "Unknown codex-prep rule.",
    fix: "Update the rule registry."
  };

  return {
    code: rule.id,
    rule: ruleName,
    level: fields.level ?? rule.defaultLevel,
    file: fields.file,
    message: fields.message ?? rule.description,
    description: rule.description,
    fix: rule.fix
  };
}

export function applyRuleConfig(finding, config = {}) {
  const disabled = new Set(config.rules?.disabled ?? []);
  if (disabled.has(finding.rule) || disabled.has(finding.code)) {
    return undefined;
  }

  const overrides = config.rules?.severityOverrides ?? {};
  const level = overrides[finding.rule] ?? overrides[finding.code] ?? finding.level;
  return { ...finding, level };
}

export function hasErrors(findings) {
  return findings.some((finding) => finding.level === "error");
}
