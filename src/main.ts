// Main entry point for Fixooly daemon.
// Orchestrates the polling loop: discovers Cursor Bugbot reports
// on open PRs, generates fixes using Claude Code, and commits
// the fixes directly to the PR head branch.
// Uses GitHub App authentication; monitored repositories are auto-discovered
// from App installations.
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
const AUTOFIX_NO_CHANGES_MARKER = "<!-- BUGBOT_AUTOFIX_NO_CHANGES -->";

class FixoolyDaemon {
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
    logger.info("Initializing Fixooly...");
    logger.info("Configuration loaded.", {
      appId: this.config.appId,
      pollInterval: this.config.pollInterval,
      claudeModel: this.config.claudeModel ?? "(default)",
    });

    await this.verifyPrerequisites();

    this.github = await GitHubClient.createFromApp(
      this.config.appId,
      this.config.privateKey
    );
    this.fixGenerator.setBotIdentity(
      this.github.appSlug,
      this.github.botUserId
    );
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

    // Check GitHub App credentials
    if (!this.config.appId || !this.config.privateKey) {
      throw new Error(
        "GitHub App credentials are missing. Set AUTOFIX_APP_ID and " +
          "AUTOFIX_PRIVATE_KEY_PATH (or AUTOFIX_PRIVATE_KEY)."
      );
    }
    logger.debug("GitHub App credentials present.", {
      appId: this.config.appId,
    });

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
      const gitToken = await this.github.getInstallationToken(pr.owner);
      const fixResult = await this.fixGenerator.fixBugsOnPrBranch(
        pr,
        bugs,
        gitToken
      );

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
        await this.postNoChangesComment(pr, bugs);

        this.state.recordProcessedBugs(
          bugs.map((b) => ({
            bugId: b.bugId,
            repo: repoFullName,
            prNumber: pr.number,
          })),
          "SKIPPED_NO_CHANGES"
        );

        logger.info(
          `No changes made for PR #${pr.number}. Bugs recorded as skipped.`,
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
      .map(
        (fb) =>
          `- ✅ Fixed: **${fb.title}**\n  - ${fb.fixDescription ?? fb.description}`
      )
      .join("\n");

    const bugCount = fixResult.fixedBugs.length;
    const body =
      `${AUTOFIX_COMMENT_MARKER}\n` +
      `[Fixooly](https://github.com/Senna46/fixooly) ` +
      `committed fixes for ${bugCount} bug(s). ` +
      `([${commitShort}](${commitUrl}))\n\n` +
      fixedList;

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
  // Post no-changes comment on the PR
  // ============================================================

  private async postNoChangesComment(
    pr: { owner: string; repo: string; number: number },
    bugs: import("./types.js").BugbotBug[]
  ): Promise<void> {
    try {
      const alreadyPosted = await this.github.hasIssueCommentContaining(
        pr.owner,
        pr.repo,
        pr.number,
        AUTOFIX_NO_CHANGES_MARKER
      );
      if (alreadyPosted) {
        logger.debug("No-changes comment already exists on PR, skipping.", {
          prNumber: pr.number,
          repo: `${pr.owner}/${pr.repo}`,
        });
        return;
      }

      const bugList = bugs
        .map((b) => `- ⏭️ Skipped: **${b.title}**`)
        .join("\n");

      const body =
        `${AUTOFIX_COMMENT_MARKER}\n${AUTOFIX_NO_CHANGES_MARKER}\n` +
        `[Fixooly](https://github.com/Senna46/fixooly) ` +
        `analyzed ${bugs.length} bug(s) but determined no code changes were needed.\n\n` +
        bugList;

      await this.github.createIssueComment(
        pr.owner,
        pr.repo,
        pr.number,
        body
      );
      logger.debug("Posted no-changes comment on PR.", {
        prNumber: pr.number,
        repo: `${pr.owner}/${pr.repo}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to post no-changes comment on PR.", {
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
    logger.info("Fixooly stopped.");
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

    const daemon = new FixoolyDaemon(config);
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
