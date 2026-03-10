// Configuration loader for Fixooly.
// Reads AUTOFIX_* environment variables (with dotenv support) and validates
// required settings. Uses GitHub App authentication (App ID + Private Key).
// Monitored repositories are auto-discovered from App installations.
// Limitations: Only supports environment variable configuration,
//   no config file support.

import { readFileSync } from "fs";

import { config as dotenvConfig } from "dotenv";
import { homedir } from "os";
import { join } from "path";

import type { Config, LogLevel } from "./types.js";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function loadConfig(): Config {
  dotenvConfig();

  const appIdStr = process.env.AUTOFIX_APP_ID?.trim();
  if (!appIdStr) {
    throw new Error(
      "Configuration error: AUTOFIX_APP_ID is required."
    );
  }
  const appId = parseInt(appIdStr, 10);
  if (isNaN(appId) || appId <= 0) {
    throw new Error(
      `Configuration error: AUTOFIX_APP_ID must be a positive integer, got "${appIdStr}".`
    );
  }

  const privateKey = loadPrivateKey();

  const pollInterval = parsePositiveInt(
    process.env.AUTOFIX_POLL_INTERVAL,
    120
  );

  const defaultWorkDir = join(homedir(), ".fixooly", "repos");
  const workDir = process.env.AUTOFIX_WORK_DIR?.trim() || defaultWorkDir;

  const defaultDbPath = join(homedir(), ".fixooly", "state.db");
  const dbPath = process.env.AUTOFIX_DB_PATH?.trim() || defaultDbPath;

  const claudeModel = process.env.AUTOFIX_CLAUDE_MODEL?.trim() || null;
  const logLevel = parseLogLevel(process.env.AUTOFIX_LOG_LEVEL);

  return {
    appId,
    privateKey,
    pollInterval,
    workDir,
    dbPath,
    claudeModel,
    logLevel,
  };
}

function loadPrivateKey(): string {
  const privateKeyPath = process.env.AUTOFIX_PRIVATE_KEY_PATH?.trim();
  const privateKeyEnv = process.env.AUTOFIX_PRIVATE_KEY?.trim();

  if (privateKeyPath) {
    try {
      return readFileSync(privateKeyPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Configuration error: Failed to read private key from AUTOFIX_PRIVATE_KEY_PATH="${privateKeyPath}": ${message}`
      );
    }
  }

  if (privateKeyEnv) {
    return privateKeyEnv;
  }

  throw new Error(
    "Configuration error: Either AUTOFIX_PRIVATE_KEY_PATH or AUTOFIX_PRIVATE_KEY must be set."
  );
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number
): number {
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Configuration error: Expected a positive integer but got "${value}".`
    );
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value?.trim().toLowerCase() || "info") as LogLevel;
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new Error(
      `Configuration error: Invalid log level "${value}". Valid levels: ${VALID_LOG_LEVELS.join(", ")}`
    );
  }
  return level;
}
