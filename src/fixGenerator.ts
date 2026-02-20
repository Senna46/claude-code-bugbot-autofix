// Fix generation module for Bugbot Autofix.
// Clones the target repository locally, checks out the PR head branch,
// runs claude -p with edit tools to fix detected Cursor Bugbot bugs,
// then commits and pushes the fix directly to the PR head branch.
// Limitations: Requires git CLI with push access to the target repo.
//   Claude may not fix all bugs or may introduce new issues.
//   Only one fix generation runs at a time per PR.

import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import { logger } from "./logger.js";
import type { BugbotBug, Config, FixResult, PullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export class FixGenerator {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Main: Fix bugs and commit directly to the PR head branch
  // ============================================================

  async fixBugsOnPrBranch(
    pr: PullRequest,
    bugs: BugbotBug[]
  ): Promise<FixResult | null> {
    if (bugs.length === 0) {
      logger.info("No bugs to fix.");
      return null;
    }

    const repoDir = await this.ensureRepoClone(pr);

    try {
      await this.checkoutPrBranch(repoDir, pr);
      await this.runClaudeFix(repoDir, bugs);

      const hasChanges = await this.hasUncommittedChanges(repoDir);
      if (!hasChanges) {
        logger.info("Claude did not make any changes. No fix to commit.");
        return null;
      }

      const commitSha = await this.commitAndPush(repoDir, pr.headRef, bugs);

      const fixedBugs = bugs.map((bug) => ({
        bugId: bug.bugId,
        title: bug.title,
        description: bug.description,
      }));

      logger.info("Fix generation complete.", {
        branch: pr.headRef,
        commitSha: commitSha.substring(0, 10),
        fixedBugCount: fixedBugs.length,
      });

      return { commitSha, fixedBugs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Fix generation failed.", {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        branch: pr.headRef,
        error: message,
      });
      throw error;
    }
  }

  // ============================================================
  // Repository cloning and management
  // ============================================================

  private async ensureRepoClone(pr: PullRequest): Promise<string> {
    await mkdir(this.config.workDir, { recursive: true });

    const repoDir = join(this.config.workDir, pr.owner, pr.repo);

    if (existsSync(join(repoDir, ".git"))) {
      logger.debug("Fetching latest for existing clone.", { repoDir });
      await this.execGit(repoDir, ["fetch", "--all", "--prune"]);
    } else {
      logger.info("Cloning repository.", {
        owner: pr.owner,
        repo: pr.repo,
        repoDir,
      });
      await mkdir(join(this.config.workDir, pr.owner), { recursive: true });
      const cloneUrl = `https://github.com/${pr.owner}/${pr.repo}.git`;
      await this.execGit(this.config.workDir, [
        "clone",
        cloneUrl,
        join(pr.owner, pr.repo),
      ]);
    }

    return repoDir;
  }

  // ============================================================
  // Branch operations
  // ============================================================

  private async checkoutPrBranch(
    repoDir: string,
    pr: PullRequest
  ): Promise<void> {
    await this.execGit(repoDir, ["fetch", "--all", "--prune"]);
    await this.execGit(repoDir, ["checkout", `origin/${pr.headRef}`]);

    try {
      await this.execGit(repoDir, ["checkout", pr.headRef]);
      await this.execGit(repoDir, [
        "reset",
        "--hard",
        `origin/${pr.headRef}`,
      ]);
    } catch {
      await this.execGit(repoDir, [
        "checkout",
        "-b",
        pr.headRef,
        `origin/${pr.headRef}`,
      ]);
    }
  }

  // ============================================================
  // Run claude -p for fixing bugs
  // ============================================================

  private async runClaudeFix(
    repoDir: string,
    bugs: BugbotBug[]
  ): Promise<void> {
    const bugDescriptions = bugs
      .map(
        (bug, idx) =>
          `${idx + 1}. [${bug.severity.toUpperCase()}] ${bug.title}\n` +
          `   File: ${bug.filePath}${bug.startLine ? `#L${bug.startLine}` : ""}${bug.endLine ? `-L${bug.endLine}` : ""}\n` +
          `   Description: ${bug.description}`
      )
      .join("\n\n");

    const prompt =
      "Fix the following bugs reported by Cursor Bugbot in this codebase. " +
      "Make minimal, targeted changes that address only the identified issues. " +
      "Do not refactor unrelated code or change formatting.\n\n" +
      `Bugs to fix:\n${bugDescriptions}\n\n` +
      "For each bug, make the necessary code changes to fix it. " +
      "Commit messages are not needed - just make the file changes.";

    const args = [
      "-p",
      "--allowedTools",
      "Read,Edit,Bash(git diff *),Bash(git status *)",
    ];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    logger.info("Running claude -p for fix generation...", {
      bugCount: bugs.length,
      repoDir,
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10 * 60 * 1000,
      });

      let stderr = "";

      child.stdout.on("data", () => {
        // Consume stdout
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `claude -p fix generation exited with code ${code}. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        resolve();
      });

      child.on("error", (error) => {
        reject(
          new Error(`claude -p fix generation failed: ${error.message}`)
        );
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Git operations
  // ============================================================

  private async hasUncommittedChanges(repoDir: string): Promise<boolean> {
    const result = await this.execGit(repoDir, ["status", "--porcelain"]);
    return result.trim().length > 0;
  }

  private async commitAndPush(
    repoDir: string,
    branchName: string,
    bugs: BugbotBug[]
  ): Promise<string> {
    await this.execGit(repoDir, ["add", "-A"]);

    const bugTitles = bugs.map((b) => `- ${b.title}`).join("\n");
    const commitMessage = `fix: Bugbot Autofix\n\nFixed Cursor Bugbot issues:\n${bugTitles}`;

    await this.execGit(repoDir, ["commit", "-m", commitMessage]);

    const sha = (
      await this.execGit(repoDir, ["rev-parse", "HEAD"])
    ).trim();

    await this.execGit(repoDir, ["push", "origin", branchName]);

    return sha;
  }

  private async execGit(cwd: string, args: string[]): Promise<string> {
    logger.debug(`git ${args.join(" ")}`, { cwd });
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 2 * 60 * 1000,
    });
    return stdout;
  }
}
