// Fix generation module for Claude Code Bugbot Autofix.
// Clones the target repository locally, checks out the PR head branch,
// runs claude -p with edit and exploration tools to fix detected Cursor Bugbot bugs,
// then commits and pushes the fix directly to the PR head branch.
// Includes project structure, documentation, PR diff, changed file contents,
// and related file imports as context for accurate, well-integrated fixes.
// Limitations: Requires git CLI with push access to the target repo.
//   Claude may not fix all bugs or may introduce new issues.
//   Only one fix generation runs at a time per PR.

import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { mkdir } from "fs/promises";
import { dirname, join, resolve as pathResolve } from "path";
import { promisify } from "util";

import { logger } from "./logger.js";
import type { BugbotBug, Config, FixResult, PullRequest } from "./types.js";

const MAX_DIFF_SIZE = 100_000;
const MAX_FILE_CONTEXT_SIZE = 200_000;
const MAX_RELATED_CONTEXT_SIZE = 100_000;
const MAX_PROJECT_STRUCTURE_SIZE = 5_000;
const MAX_DOC_SIZE = 10_000;

const PROJECT_DOC_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"];

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

const COMMIT_MSG_PREFIX = "COMMIT_MSG: ";
const FIX_DETAIL_PREFIX = "FIX_DETAIL: ";

const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_STDOUT_SIZE = 100_000;

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
      const projectStructure = await this.getProjectStructure(repoDir);
      const projectDocs = await this.getProjectDocumentation(repoDir);
      const relatedFileContents = await this.getRelatedFileContents(
        repoDir,
        bugs,
        new Set(changedFileContents.keys())
      );

      const prompt = this.buildFixPrompt(
        bugs,
        prDiff,
        changedFileContents,
        projectStructure,
        projectDocs,
        relatedFileContents
      );

      const claudeOutput = await this.runClaudeFix(
        repoDir,
        prompt,
        bugs.length
      );

      const hasChanges = await this.hasUncommittedChanges(repoDir);
      if (!hasChanges) {
        logger.info("Claude did not make any changes. No fix to commit.");
        return null;
      }

      const commitSummary = parseCommitMessage(claudeOutput);
      const commitSha = await this.commitAndPush(
        repoDir,
        pr.headRef,
        bugs,
        commitSummary
      );

      const fixDetails = parseFixDetails(claudeOutput);
      const fixedBugs = bugs.map((bug) => ({
        bugId: bug.bugId,
        title: bug.title,
        description: bug.description,
        fixDescription: fixDetails.get(bug.bugId) ?? null,
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
      await this.execGit(repoDir, ["reset", "--hard", `origin/${pr.headRef}`]);
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
    changedFileContents: Map<string, string>,
    projectStructure: string,
    projectDocs: string,
    relatedFileContents: Map<string, string>
  ): string {
    const sections: string[] = [];

    sections.push(
      "You are fixing bugs reported by Cursor Bugbot in this codebase."
    );

    if (projectStructure) {
      sections.push(
        `## Project structure\n\n\`\`\`\n${projectStructure}\n\`\`\``
      );
    }

    if (projectDocs) {
      sections.push(`## Project documentation\n\n${projectDocs}`);
    }

    const bugDescriptions = bugs
      .map(
        (bug, idx) =>
          `${idx + 1}. [${bug.severity.toUpperCase()}] ${bug.title}\n` +
          `   Bug ID: ${bug.bugId}\n` +
          `   File: ${bug.filePath}${
            bug.startLine ? `#L${bug.startLine}` : ""
          }${bug.endLine ? `-L${bug.endLine}` : ""}\n` +
          `   Description: ${bug.description}`
      )
      .join("\n\n");
    sections.push(`## Bugs to fix\n\n${bugDescriptions}`);

    if (prDiff) {
      const truncatedDiff =
        prDiff.length > MAX_DIFF_SIZE
          ? prDiff.substring(0, MAX_DIFF_SIZE) + "\n... (diff truncated)"
          : prDiff;
      sections.push(`## PR diff\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``);
    }

    if (changedFileContents.size > 0) {
      const entries = [...changedFileContents.entries()]
        .map(([path, content]) => `--- ${path} ---\n${content}`)
        .join("\n\n");
      sections.push(`## Current contents of changed files\n\n${entries}`);
    }

    if (relatedFileContents.size > 0) {
      const entries = [...relatedFileContents.entries()]
        .map(([path, content]) => `--- ${path} ---\n${content}`)
        .join("\n\n");
      sections.push(
        `## Related files (dependencies of bug files)\n\n${entries}`
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
        "- Commit messages are not needed - just make the file changes.\n\n" +
        "After making all changes, output the following lines:\n\n" +
        "1. One summary line:\n" +
        `${COMMIT_MSG_PREFIX}<a concise summary of what was fixed>\n\n` +
        "2. For each bug fixed, one detail line describing the actual change you made (not the bug description):\n" +
        `${FIX_DETAIL_PREFIX}<bug_id> | <brief description of the code change applied>`
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
  ): Promise<string> {
    const args = ["-p", "--allowedTools", ALLOWED_TOOLS];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    logger.info("Running claude -p for fix generation...", {
      bugCount,
      repoDir,
    });

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const child = spawn("claude", args, {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      const killTimer = setTimeout(() => {
        if (settled) return;
        logger.warn("claude -p timed out, sending SIGTERM.", {
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (settled) return;
          logger.warn("claude -p did not exit after SIGTERM, sending SIGKILL.");
          child.kill("SIGKILL");
        }, SIGKILL_GRACE_MS);
      }, CLAUDE_TIMEOUT_MS);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_STDOUT_SIZE) {
          stdout = stdout.substring(stdout.length - MAX_STDOUT_SIZE);
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code, signal) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          logger.error("claude -p timed out.", {
            signal,
            timeoutMs: CLAUDE_TIMEOUT_MS,
            stderr: stderr.substring(0, 1000) || "(empty)",
            stdoutTail: stdout.substring(Math.max(0, stdout.length - 1000)) || "(empty)",
          });
          reject(
            new Error(
              `claude -p fix generation timed out after ${CLAUDE_TIMEOUT_MS / 1000}s.`
            )
          );
          return;
        }
        if (code !== 0) {
          logger.error("claude -p exited with non-zero code.", {
            exitCode: code,
            stderr: stderr.substring(0, 1000) || "(empty)",
            stdoutTail: stdout.substring(Math.max(0, stdout.length - 2000)) || "(empty)",
          });
          reject(
            new Error(`claude -p fix generation exited with code ${code}.`)
          );
          return;
        }
        resolve(stdout);
      });

      child.on("error", (error) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        reject(new Error(`claude -p fix generation failed: ${error.message}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Project structure and documentation context
  // ============================================================

  private async getProjectStructure(repoDir: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "tree",
        [
          "-L",
          "3",
          "-I",
          "node_modules|.git|dist|build|__pycache__|.next|venv|.venv",
        ],
        { cwd: repoDir, timeout: 10_000, maxBuffer: 1024 * 1024 }
      );
      if (stdout.length > MAX_PROJECT_STRUCTURE_SIZE) {
        return (
          stdout.substring(0, MAX_PROJECT_STRUCTURE_SIZE) + "\n... (truncated)"
        );
      }
      return stdout;
    } catch {
      try {
        const { stdout } = await execFileAsync(
          "find",
          [
            ".",
            "-maxdepth",
            "3",
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
            "-not",
            "-path",
            "*/dist/*",
            "-not",
            "-path",
            "*/build/*",
          ],
          { cwd: repoDir, timeout: 10_000, maxBuffer: 1024 * 1024 }
        );
        if (stdout.length > MAX_PROJECT_STRUCTURE_SIZE) {
          return (
            stdout.substring(0, MAX_PROJECT_STRUCTURE_SIZE) +
            "\n... (truncated)"
          );
        }
        return stdout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Failed to get project structure.", {
          error: message,
          repoDir,
        });
        return "";
      }
    }
  }

  private async getProjectDocumentation(repoDir: string): Promise<string> {
    const sections: string[] = [];

    for (const fileName of PROJECT_DOC_FILES) {
      const filePath = join(repoDir, fileName);
      try {
        if (!existsSync(filePath)) continue;
        let content = await readFile(filePath, "utf-8");
        if (content.length > MAX_DOC_SIZE) {
          content = content.substring(0, MAX_DOC_SIZE) + "\n... (truncated)";
        }
        sections.push(`### ${fileName}\n\n${content}`);
        logger.debug(`Loaded project documentation: ${fileName}`, {
          size: content.length,
        });
      } catch {
        logger.debug(`Could not read project documentation: ${fileName}`);
      }
    }

    return sections.join("\n\n");
  }

  // ============================================================
  // Related files: imports from bug-targeted files
  // ============================================================

  private async getRelatedFileContents(
    repoDir: string,
    bugs: BugbotBug[],
    excludePaths: Set<string>
  ): Promise<Map<string, string>> {
    const bugFilePaths = [...new Set(bugs.map((b) => b.filePath))];
    const importedPaths = new Set<string>();

    for (const bugFilePath of bugFilePaths) {
      const absolutePath = safeResolvePath(repoDir, bugFilePath);
      if (!absolutePath) continue;

      try {
        const content = await readFile(absolutePath, "utf-8");
        const imports = extractImportPaths(content);
        const bugFileDir = dirname(bugFilePath);

        for (const importPath of imports) {
          const resolved = this.resolveImportPath(
            repoDir,
            bugFileDir,
            importPath
          );
          if (resolved && !excludePaths.has(resolved)) {
            importedPaths.add(resolved);
          }
        }
      } catch {
        logger.debug("Could not read bug file for import analysis.", {
          filePath: bugFilePath,
        });
      }
    }

    const contents = new Map<string, string>();
    let totalSize = 0;

    for (const filePath of importedPaths) {
      if (totalSize >= MAX_RELATED_CONTEXT_SIZE) break;

      const absolutePath = safeResolvePath(repoDir, filePath);
      if (!absolutePath) continue;

      try {
        const content = await readFile(absolutePath, "utf-8");
        const remainingBudget = MAX_RELATED_CONTEXT_SIZE - totalSize;
        if (content.length > remainingBudget) {
          contents.set(
            filePath,
            content.substring(0, remainingBudget) + "\n... (truncated)"
          );
          totalSize = MAX_RELATED_CONTEXT_SIZE;
        } else {
          contents.set(filePath, content);
          totalSize += content.length;
        }
      } catch {
        logger.debug("Could not read related file, skipping.", { filePath });
      }
    }

    if (contents.size > 0) {
      logger.info(`Loaded ${contents.size} related file(s) as context.`, {
        filePaths: [...contents.keys()],
        totalSize,
      });
    }

    return contents;
  }

  private resolveImportPath(
    repoDir: string,
    fromDir: string,
    importPath: string
  ): string | null {
    if (!importPath.startsWith(".")) return null;

    const resolvedRelative = join(fromDir, importPath);

    if (!safeResolvePath(repoDir, resolvedRelative)) return null;

    const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
    for (const ext of extensions) {
      const candidate = resolvedRelative + ext;
      if (existsSync(join(repoDir, candidate))) {
        return candidate;
      }
    }

    // In TypeScript projects, .js imports often map to .ts source files
    if (importPath.endsWith(".js")) {
      const tsVariants = [
        resolvedRelative.replace(/\.js$/, ".ts"),
        resolvedRelative.replace(/\.js$/, ".tsx"),
      ];
      for (const candidate of tsVariants) {
        if (existsSync(join(repoDir, candidate))) {
          return candidate;
        }
      }
    }

    const indexFiles = ["index.ts", "index.tsx", "index.js", "index.jsx"];
    for (const indexFile of indexFiles) {
      const candidate = join(resolvedRelative, indexFile);
      if (existsSync(join(repoDir, candidate))) {
        return candidate;
      }
    }

    return null;
  }

  // ============================================================
  // PR context: diff and changed file contents
  // ============================================================

  private async getPrDiff(repoDir: string, pr: PullRequest): Promise<string> {
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

      const absolutePath = safeResolvePath(repoDir, filePath);
      if (!absolutePath) continue;

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
    bugs: BugbotBug[],
    commitSummary: string | null
  ): Promise<string> {
    await this.execGit(repoDir, ["add", "-A"]);

    const title = commitSummary
      ? hasConventionalCommitPrefix(commitSummary)
        ? commitSummary
        : `fix: ${commitSummary}`
      : bugs.length === 1
      ? `fix: ${bugs[0].title}`
      : "fix: Fix Cursor Bugbot issues";

    const bugTitles = bugs.map((b) => `- ${b.title}`).join("\n");
    const commitMessage = `${title}\n\n${bugTitles}\n\nApplied via Claude Code Bugbot Autofix`;

    await this.execGit(repoDir, ["commit", "-m", commitMessage]);

    const sha = (await this.execGit(repoDir, ["rev-parse", "HEAD"])).trim();

    await this.execGit(repoDir, ["push", "origin", branchName]);

    return sha;
  }

  private async execGit(cwd: string, args: string[]): Promise<string> {
    logger.debug(`git ${args.join(" ")}`, { cwd });
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 2 * 60 * 1000,
      });
      return stdout;
    } catch (error) {
      const execError = error as { message?: string; stderr?: string; stdout?: string; code?: number | string };
      logger.error(`git ${args.join(" ")} failed.`, {
        cwd,
        exitCode: execError.code,
        stderr: execError.stderr?.trim() || "(empty)",
        stdout: execError.stdout?.trim() || "(empty)",
      });
      throw error;
    }
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

// ============================================================
// Utility: extract relative import/require paths from source code
// ============================================================

function extractImportPaths(source: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const fromRegex = /from\s+["']([^"']+)["']/g;
  const requireRegex = /require\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const regex of [fromRegex, requireRegex]) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith(".") && !seen.has(importPath)) {
        seen.add(importPath);
        paths.push(importPath);
      }
    }
  }

  return paths;
}

// ============================================================
// Utility: check for conventional commit prefix
// ============================================================

const CONVENTIONAL_COMMIT_REGEX =
  /^(fix|feat|chore|refactor|perf|test|docs|style|build|ci|revert)(\(.+?\))?!?:\s/i;

function hasConventionalCommitPrefix(message: string): boolean {
  return CONVENTIONAL_COMMIT_REGEX.test(message);
}

// ============================================================
// Utility: safe path resolution with traversal prevention
// ============================================================

function safeResolvePath(baseDir: string, relativePath: string): string | null {
  const normalizedBase = pathResolve(baseDir);
  const resolved = pathResolve(normalizedBase, relativePath);
  if (
    !resolved.startsWith(normalizedBase + "/") &&
    resolved !== normalizedBase
  ) {
    logger.warn("Path traversal attempt blocked.", {
      baseDir,
      relativePath,
      resolved,
    });
    return null;
  }
  return resolved;
}

// ============================================================
// Utility: extract searchable text from claude -p output
// ============================================================

function extractSearchableText(claudeOutput: string): string {
  const trimmed = claudeOutput.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      // fall through to JSONL line scanning
    }
  }

  // Try JSONL: find the last line with a result field.
  // This also handles truncated output where the leading { or [ was stripped,
  // since individual JSONL lines near the end remain intact.
  const jsonLines = trimmed.split("\n");
  for (let i = jsonLines.length - 1; i >= 0; i--) {
    const line = jsonLines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      continue;
    }
  }

  return claudeOutput;
}

// ============================================================
// Utility: parse COMMIT_MSG from claude -p output
// ============================================================

function parseCommitMessage(claudeOutput: string): string | null {
  const textToSearch = extractSearchableText(claudeOutput);

  const lines = textToSearch.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith(COMMIT_MSG_PREFIX)) {
      const message = line.substring(COMMIT_MSG_PREFIX.length).trim();
      if (message.length > 0) {
        return message;
      }
    }
  }

  return null;
}

// ============================================================
// Utility: parse per-bug FIX_DETAIL lines from claude -p output
// ============================================================

function parseFixDetails(claudeOutput: string): Map<string, string> {
  const details = new Map<string, string>();
  const textToSearch = extractSearchableText(claudeOutput);

  for (const line of textToSearch.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(FIX_DETAIL_PREFIX)) {
      const content = trimmed.substring(FIX_DETAIL_PREFIX.length).trim();
      const separatorIndex = content.indexOf("|");
      if (separatorIndex > 0) {
        const bugId = content.substring(0, separatorIndex).trim();
        const fixDescription = content.substring(separatorIndex + 1).trim();
        if (bugId && fixDescription) {
          details.set(bugId, fixDescription);
        }
      }
    }
  }

  return details;
}
