import fs from "node:fs/promises";
import path from "node:path";
import { fileExists, writeJsonIfChanged } from "./fs-utils.js";

export const CONFIG_PATH = ".codex-prep/config.json";

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  rules: {
    disabled: [],
    severityOverrides: {}
  },
  lint: {
    stalePathPatterns: ["D:\\\\Codex(?!Manager)"],
    secretPatterns: [
      "\\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\\s*=",
      "-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----",
      "\\bghp_[A-Za-z0-9_]{20,}\\b",
      "\\bsk-[A-Za-z0-9_-]{20,}\\b"
    ]
  }
};

export async function loadConfig(root) {
  return (await readConfig(root)).config;
}

export async function readConfig(root) {
  const configPath = path.join(root, CONFIG_PATH);
  if (!(await fileExists(configPath))) {
    return { config: clone(DEFAULT_CONFIG), missing: true, invalid: undefined };
  }

  try {
    const userConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    return { config: mergeConfig(DEFAULT_CONFIG, userConfig), missing: false, invalid: undefined };
  } catch (error) {
    return { config: clone(DEFAULT_CONFIG), missing: false, invalid: error.message };
  }
}

export async function writeDefaultConfigIfMissing(root) {
  const configPath = path.join(root, CONFIG_PATH);
  if (await fileExists(configPath)) {
    return { changed: false };
  }
  return writeJsonIfChanged(configPath, DEFAULT_CONFIG);
}

export function compilePatterns(patterns) {
  const compiled = [];
  const invalid = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch (error) {
      invalid.push({ pattern, error: error.message });
    }
  }
  return { compiled, invalid };
}

function mergeConfig(defaultConfig, userConfig) {
  const merged = clone(defaultConfig);
  if (!userConfig || typeof userConfig !== "object") {
    return merged;
  }

  if (userConfig.schemaVersion !== undefined) {
    merged.schemaVersion = userConfig.schemaVersion;
  }

  if (userConfig.rules && typeof userConfig.rules === "object") {
    if (Array.isArray(userConfig.rules.disabled)) {
      merged.rules.disabled = [...userConfig.rules.disabled];
    }
    if (userConfig.rules.severityOverrides && typeof userConfig.rules.severityOverrides === "object") {
      merged.rules.severityOverrides = { ...userConfig.rules.severityOverrides };
    }
  }

  if (userConfig.lint && typeof userConfig.lint === "object") {
    if (Array.isArray(userConfig.lint.stalePathPatterns)) {
      merged.lint.stalePathPatterns = [...userConfig.lint.stalePathPatterns];
    }
    if (Array.isArray(userConfig.lint.secretPatterns)) {
      merged.lint.secretPatterns = [...userConfig.lint.secretPatterns];
    }
  }

  return merged;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
