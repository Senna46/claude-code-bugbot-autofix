// Fix generation module for Claude Code Bugbot Autofix.
// Clones the target repository locally, checks out the PR head branch,
// runs claude -p with edit and exploration tools to fix detected Cursor Bugbot bugs,
// then commits and pushes the fix directly to the PR head branch.
// Includes PR diff and changed file contents as context for better fixes.
// Limitations: Requires git CLI with push access to the target repo.
//   Claude may not fix all bugs or may introduce new issues.
//   Only one fix generation runs at a time per PR.

import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { mkdir } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

import { logger } from "./logger.js";
import type { BugbotBug, Config, FixResult, PullRequest } from "./types.js";

const MAX_DIFF_SIZE = 100_000;
const MAX_FILE_CONTEXT_SIZE = 200_000;

const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(find *)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(tree *)",
].join(",");

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

      const prDiff = await this.getPrDiff(repoDir, pr);
      const changedFileContents = await this.getChangedFileContents(
        repoDir,
        prDiff
      );

      const prompt = this.buildFixPrompt(
        bugs,
        prDiff,
        changedFileContents
      );

      await this.runClaudeFix(repoDir, prompt, bugs.length);

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
  // Build the fix prompt with all context sections
  // ============================================================

  private buildFixPrompt(
    bugs: BugbotBug[],
    prDiff: string,
    changedFileContents: Map<string, string>
  ): string {
    const sections: string[] = [];

    sections.push(
      "You are fixing bugs reported by Cursor Bugbot in this codebase."
    );

    const bugDescriptions = bugs
      .map(
        (bug, idx) =>
          `${idx + 1}. [${bug.severity.toUpperCase()}] ${bug.title}\n` +
          `   File: ${bug.filePath}${bug.startLine ? `#L${bug.startLine}` : ""}${bug.endLine ? `-L${bug.endLine}` : ""}\n` +
          `   Description: ${bug.description}`
      )
      .join("\n\n");
    sections.push(`## Bugs to fix\n\n${bugDescriptions}`);

    if (prDiff) {
      const truncatedDiff =
        prDiff.length > MAX_DIFF_SIZE
          ? prDiff.substring(0, MAX_DIFF_SIZE) + "\n... (diff truncated)"
          : prDiff;
      sections.push(
        `## PR diff\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``
      );
    }

    if (changedFileContents.size > 0) {
      const entries = [...changedFileContents.entries()]
        .map(([path, content]) => `--- ${path} ---\n${content}`)
        .join("\n\n");
      sections.push(
        `## Current contents of changed files\n\n${entries}`
      );
    }

    sections.push(
      "## Instructions\n\n" +
        "Before making changes, use the available tools (Read, grep, find, ls, tree) to explore the " +
        "codebase and understand how the target files interact with the rest of the project.\n\n" +
        "Fix the identified bugs by making correct, targeted changes. Follow these rules:\n" +
        "- Do NOT create new files. Only modify existing files.\n" +
        "- Focus changes on the files mentioned in the bug reports. Only modify other files if strictly " +
        "necessary for the fix.\n" +
        "- Follow the existing code style, naming conventions, and patterns in the project.\n" +
        "- Ensure your changes are compatible with the rest of the codebase.\n" +
        "- Commit messages are not needed - just make the file changes."
    );

    return sections.join("\n\n");
  }

  // ============================================================
  // Run claude -p for fixing bugs
  // ============================================================

  private async runClaudeFix(
    repoDir: string,
    prompt: string,
    bugCount: number
  ): Promise<void> {
    const args = ["-p", "--allowedTools", ALLOWED_TOOLS];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    logger.info("Running claude -p for fix generation...", {
      bugCount,
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
  // PR context: diff and changed file contents
  // ============================================================

  private async getPrDiff(
    repoDir: string,
    pr: PullRequest
  ): Promise<string> {
    try {
      const diff = await this.execGit(repoDir, [
        "diff",
        `origin/${pr.baseRef}...HEAD`,
      ]);

      logger.info("Retrieved PR diff.", {
        diffLength: diff.length,
        baseRef: pr.baseRef,
      });

      return diff;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to retrieve PR diff, continuing without it.", {
        error: message,
        baseRef: pr.baseRef,
      });
      return "";
    }
  }

  private async getChangedFileContents(
    repoDir: string,
    prDiff: string
  ): Promise<Map<string, string>> {
    const filePaths = extractChangedFilePaths(prDiff);
    const contents = new Map<string, string>();
    let totalSize = 0;

    for (const filePath of filePaths) {
      if (totalSize >= MAX_FILE_CONTEXT_SIZE) {
        logger.debug(
          "File context size limit reached, skipping remaining files.",
          {
            totalSize,
            limit: MAX_FILE_CONTEXT_SIZE,
            skippedFile: filePath,
          }
        );
        break;
      }

      const absolutePath = join(repoDir, filePath);
      try {
        const content = await readFile(absolutePath, "utf-8");
        const remainingBudget = MAX_FILE_CONTEXT_SIZE - totalSize;
        if (content.length > remainingBudget) {
          contents.set(
            filePath,
            content.substring(0, remainingBudget) + "\n... (truncated)"
          );
          totalSize = MAX_FILE_CONTEXT_SIZE;
        } else {
          contents.set(filePath, content);
          totalSize += content.length;
        }
      } catch {
        logger.debug("Could not read changed file, skipping.", { filePath });
      }
    }

    if (contents.size > 0) {
      logger.info(`Loaded ${contents.size} changed file(s) as context.`, {
        filePaths: [...contents.keys()],
        totalSize,
      });
    }

    return contents;
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
    const commitMessage = `fix: Claude Code Bugbot Autofix\n\nFixed Cursor Bugbot issues:\n${bugTitles}`;

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

// ============================================================
// Utility: extract changed file paths from a unified diff
// ============================================================

function extractChangedFilePaths(diff: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const filePath = line.substring(6);
      if (!seen.has(filePath)) {
        seen.add(filePath);
        paths.push(filePath);
      }
    }
  }

  return paths;
}
