// Main entry point for Claude Code Bugbot Autofix daemon.
// Orchestrates the polling loop: discovers Cursor Bugbot reports
// on open PRs, generates fixes using Claude Code, and commits
// the fixes directly to the PR head branch.
// Limitations: Single-threaded; processes PRs sequentially
//   within each polling cycle. Graceful shutdown on SIGINT/SIGTERM.

import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { BugbotMonitor } from "./bugbotMonitor.js";
import { loadConfig } from "./config.js";
import { FixGenerator } from "./fixGenerator.js";
import { GitHubClient } from "./githubClient.js";
import { logger, setLogLevel } from "./logger.js";
import { StateStore } from "./state.js";
import type { Config, FixResult, PrBugReport } from "./types.js";

const AUTOFIX_COMMENT_MARKER = "<!-- BUGBOT_AUTOFIX_COMMENT -->";

class AutofixDaemon {
  private config: Config;
  private state: StateStore;
  private github!: GitHubClient;
  private monitor!: BugbotMonitor;
  private fixGenerator: FixGenerator;
  private isShuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.state = new StateStore(config.dbPath);
    this.fixGenerator = new FixGenerator(config);
  }

  // ============================================================
  // Initialization
  // ============================================================

  async initialize(): Promise<void> {
    logger.info("Initializing Claude Code Bugbot Autofix...");
    logger.info("Configuration loaded.", {
      orgs: this.config.githubOrgs,
      repos: this.config.githubRepos,
      pollInterval: this.config.pollInterval,
      claudeModel: this.config.claudeModel ?? "(default)",
    });

    await this.verifyPrerequisites();

    this.github = await GitHubClient.createFromGhCli();
    this.monitor = new BugbotMonitor(this.github, this.state, this.config);

    logger.info("Initialization complete. Starting daemon loop.");
  }

  // ============================================================
  // Prerequisites check
  // ============================================================

  private async verifyPrerequisites(): Promise<void> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const ghToken = process.env.GH_TOKEN;
    if (ghToken && ghToken.trim()) {
      logger.debug("Using GH_TOKEN environment variable for authentication.");
    } else {
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "status"]);
        logger.debug("gh CLI auth status OK.", {
          output: stdout.substring(0, 200),
        });
      } catch {
        throw new Error(
          "gh CLI is not authenticated. Set GH_TOKEN environment variable or run 'gh auth login'."
        );
      }
    }

    try {
      const { stdout } = await execFileAsync("claude", ["--version"]);
      logger.debug("claude CLI version.", { version: stdout.trim() });
    } catch {
      throw new Error(
        "claude CLI is not available. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
      );
    }

    if (
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      const { existsSync } = await import("fs");
      const homeDir = process.env.HOME ?? "/root";
      const credFile = `${homeDir}/.claude/.credentials.json`;
      if (!existsSync(credFile)) {
        logger.warn(
          "No Claude authentication detected. " +
          "On macOS Docker, set CLAUDE_CODE_OAUTH_TOKEN (run 'claude setup-token' to generate). " +
          "On Linux, ensure ~/.claude is mounted and contains .credentials.json."
        );
      }
    }

    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      throw new Error("git is not available. Install git first.");
    }
  }

  // ============================================================
  // Main polling loop
  // ============================================================

  async run(): Promise<void> {
    this.registerShutdownHandlers();

    while (!this.isShuttingDown) {
      try {
        await this.pollCycle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error in polling cycle.", { error: message });
      }

      if (!this.isShuttingDown) {
        logger.info(
          `Sleeping for ${this.config.pollInterval}s before next cycle...`
        );
        await this.sleep(this.config.pollInterval * 1000);
      }
    }

    this.shutdown();
  }

  // ============================================================
  // Single polling cycle
  // ============================================================

  private async pollCycle(): Promise<void> {
    logger.info("Starting polling cycle...");

    const reports = await this.monitor.discoverUnprocessedBugs();

    if (reports.length === 0) {
      logger.info("No unprocessed Bugbot bugs found.");
      return;
    }

    logger.info(
      `Found ${reports.length} PR(s) with unprocessed bugs.`,
      { prCount: reports.length }
    );

    for (const report of reports) {
      if (this.isShuttingDown) break;
      await this.processReport(report);
    }
  }

  // ============================================================
  // Process a single PR bug report
  // ============================================================

  private async processReport(report: PrBugReport): Promise<void> {
    const { pr, bugs } = report;
    const repoFullName = `${pr.owner}/${pr.repo}`;

    logger.info(
      `Processing PR #${pr.number} in ${repoFullName}: ${bugs.length} bug(s) to fix.`,
      {
        prNumber: pr.number,
        repo: repoFullName,
        bugCount: bugs.length,
        bugIds: bugs.map((b) => b.bugId),
      }
    );

    try {
      const fixResult = await this.fixGenerator.fixBugsOnPrBranch(pr, bugs);

      if (fixResult) {
        await this.postFixComment(pr, fixResult);

        this.state.recordProcessedBugs(
          bugs.map((b) => ({
            bugId: b.bugId,
            repo: repoFullName,
            prNumber: pr.number,
          })),
          fixResult.commitSha
        );

        logger.info(
          `Successfully fixed ${fixResult.fixedBugs.length} bug(s) on PR #${pr.number}.`,
          {
            prNumber: pr.number,
            repo: repoFullName,
            commitSha: fixResult.commitSha.substring(0, 10),
          }
        );
      } else {
        this.state.recordProcessedBugs(
          bugs.map((b) => ({
            bugId: b.bugId,
            repo: repoFullName,
            prNumber: pr.number,
          })),
          null
        );

        logger.info(
          `No changes made for PR #${pr.number}. Bugs recorded as processed.`,
          { prNumber: pr.number, repo: repoFullName }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `Error processing PR #${pr.number} in ${repoFullName}. Bugs will be retried next cycle.`,
        { error: message, prNumber: pr.number, repo: repoFullName }
      );
      this.state.recordProcessedBugs(
        bugs.map((b) => ({
          bugId: b.bugId,
          repo: repoFullName,
          prNumber: pr.number,
        })),
        "FAILED"
      );
    }
  }

  // ============================================================
  // Post fix summary comment on the PR
  // ============================================================

  private async postFixComment(
    pr: { owner: string; repo: string; number: number },
    fixResult: FixResult
  ): Promise<void> {
    const commitShort = fixResult.commitSha.substring(0, 10);
    const commitUrl = `https://github.com/${pr.owner}/${pr.repo}/commit/${fixResult.commitSha}`;

    const fixedList = fixResult.fixedBugs
      .map((fb) => `- **${fb.title}**`)
      .join("\n");

    const body =
      `${AUTOFIX_COMMENT_MARKER}\n` +
      `[Claude Code Bugbot Autofix](https://github.com/Senna46/claude-code-bugbot-autofix) committed fixes to address ` +
      `${fixResult.fixedBugs.length} Cursor Bugbot issue(s) ([${commitShort}](${commitUrl})).\n\n` +
      `**Fixed issues:**\n${fixedList}`;

    try {
      await this.github.createIssueComment(
        pr.owner,
        pr.repo,
        pr.number,
        body
      );
      logger.debug("Posted fix comment on PR.", {
        prNumber: pr.number,
        repo: `${pr.owner}/${pr.repo}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to post fix comment on PR.", {
        error: message,
        prNumber: pr.number,
        repo: `${pr.owner}/${pr.repo}`,
      });
    }
  }

  // ============================================================
  // Shutdown
  // ============================================================

  private registerShutdownHandlers(): void {
    const handleShutdown = (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      this.isShuttingDown = true;
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  private shutdown(): void {
    this.state.close();
    logger.info("Claude Code Bugbot Autofix stopped.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const checkShutdown = setInterval(() => {
        if (this.isShuttingDown) {
          clearTimeout(timer);
          clearInterval(checkShutdown);
          resolve();
        }
      }, 1000);
    });
  }
}

// ============================================================
// Single-instance lock
// ============================================================

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(dbPath: string): string {
  const lockPath = join(dirname(dbPath), "daemon.lock");
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return lockPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existingPid = readFileSync(lockPath, "utf-8").trim();
      const pid = parseInt(existingPid, 10);

      if (!isNaN(pid) && isProcessRunning(pid)) {
        throw new Error(
          `Another daemon instance is already running (PID ${existingPid}, lock: ${lockPath}). ` +
            "Stop the existing instance first."
        );
      }

      // Stale lock file from a crashed process — reclaim it
      try {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
      } catch {
        throw new Error(
          `Another daemon instance is already running (lock: ${lockPath}). ` +
            "Stop the existing instance first."
        );
      }
      return lockPath;
    }
    throw error;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup
  }
}

// ============================================================
// Entry point
// ============================================================

async function main(): Promise<void> {
  let lockPath: string | null = null;
  try {
    const config = loadConfig();
    setLogLevel(config.logLevel);

    mkdirSync(dirname(config.dbPath), { recursive: true });
    lockPath = acquireLock(config.dbPath);

    const daemon = new AutofixDaemon(config);
    await daemon.initialize();
    await daemon.run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FATAL] ${message}`);
    if (lockPath) releaseLock(lockPath);
    process.exit(1);
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
}

main();
