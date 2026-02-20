// Data models and type definitions for Bugbot Autofix.
// Defines shared interfaces for configuration, parsed Cursor Bugbot
// bug reports, fix results, and PR metadata.
// Limitations: BugbotBug fields depend on the Cursor Bugbot comment
//   format which may change without notice.

// ============================================================
// Configuration
// ============================================================

export interface Config {
  githubOrgs: string[];
  githubRepos: string[];
  pollInterval: number;
  workDir: string;
  dbPath: string;
  claudeModel: string | null;
  logLevel: LogLevel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// ============================================================
// GitHub PR Data
// ============================================================

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  htmlUrl: string;
}

// ============================================================
// Cursor Bugbot Bug Report
// ============================================================

export type BugSeverity = "low" | "medium" | "high" | "critical";

export interface BugbotBug {
  bugId: string;
  title: string;
  severity: BugSeverity;
  description: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  commitId: string;
  reviewCommentId: number;
}

// Represents a set of unprocessed bugs for a single PR
export interface PrBugReport {
  pr: PullRequest;
  bugs: BugbotBug[];
}

// ============================================================
// Fix Generation
// ============================================================

export interface FixResult {
  commitSha: string;
  fixedBugs: Array<{
    bugId: string;
    title: string;
    description: string;
  }>;
}

// ============================================================
// State (DB Records)
// ============================================================

export interface ProcessedBugRecord {
  bugId: string;
  repo: string;
  prNumber: number;
  processedAt: string;
  fixCommitSha: string | null;
}
