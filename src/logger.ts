// Simple structured logger for Claude Code Bugbot Autofix.
// Supports log levels (debug, info, warn, error) with
// timestamped messages to stdout/stderr.
// Limitations: No file-based logging or log rotation.

import type { LogLevel } from "./types.js";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function fmt(
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>
): string {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  let line = `[${ts}] ${tag} ${msg}`;
  if (ctx && Object.keys(ctx).length > 0) {
    line += ` ${JSON.stringify(ctx)}`;
  }
  return line;
}

export const logger = {
  debug(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog("debug")) console.log(fmt("debug", msg, ctx));
  },
  info(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog("info")) console.log(fmt("info", msg, ctx));
  },
  warn(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog("warn")) console.warn(fmt("warn", msg, ctx));
  },
  error(msg: string, ctx?: Record<string, unknown>): void {
    if (shouldLog("error")) console.error(fmt("error", msg, ctx));
  },
};
