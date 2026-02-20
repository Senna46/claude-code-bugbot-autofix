// GitHub API client for Bugbot Autofix.
// Wraps Octokit to provide typed operations for monitoring
// Cursor Bugbot review comments and managing PRs.
// Uses gh CLI auth token or GH_TOKEN for authentication.
// Limitations: Rate limiting is handled by Octokit built-in throttling.

import { execFile } from "child_process";
import { Octokit } from "octokit";
import { promisify } from "util";

import { logger } from "./logger.js";
import type { PullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  commitId: string;
  userLogin: string;
  pullRequestReviewId: number;
  createdAt: string;
}

export class GitHubClient {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token,
    });
  }

  // ============================================================
  // Factory: Create client using gh CLI auth token or GH_TOKEN
  // ============================================================

  static async createFromGhCli(): Promise<GitHubClient> {
    const envToken = process.env.GH_TOKEN;
    if (envToken && envToken.trim()) {
      const trimmedToken = envToken.trim();
      validateGitHubToken(trimmedToken);
      logger.info("GitHub client authenticated via GH_TOKEN environment variable.");
      return new GitHubClient(trimmedToken);
    }

    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"]);
      const token = stdout.trim();
      if (!token) {
        throw new Error("gh auth token returned empty string.");
      }
      logger.info("GitHub client authenticated via gh CLI.");
      return new GitHubClient(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to get GitHub token. Set GH_TOKEN environment variable or run 'gh auth login'. Error: ${message}`
      );
    }
  }

  // ============================================================
  // Pull Requests
  // ============================================================

  async listOpenPullRequests(
    owner: string,
    repo: string
  ): Promise<PullRequest[]> {
    logger.debug("Listing open PRs.", { owner, repo });

    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    return data.map((pr) => ({
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      htmlUrl: pr.html_url,
    }));
  }

  async listOwnerRepos(
    owner: string
  ): Promise<Array<{ owner: string; name: string }>> {
    logger.debug("Listing repos for owner.", { owner });

    const repos: Array<{ owner: string; name: string }> = [];

    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForUser,
        { username: owner, per_page: 100, type: "owner" }
      )) {
        for (const repo of response.data) {
          repos.push({ owner, name: repo.name });
        }
      }
      logger.debug(`Found ${repos.length} repo(s) for user "${owner}".`);
      return repos;
    } catch (userError) {
      logger.debug(`Failed to list repos as user "${owner}", trying as org...`, {
        error: userError instanceof Error ? userError.message : String(userError),
      });
    }

    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForOrg,
        { org: owner, per_page: 100, type: "all" }
      )) {
        for (const repo of response.data) {
          repos.push({ owner, name: repo.name });
        }
      }
      logger.debug(`Found ${repos.length} repo(s) for org "${owner}".`);
    } catch (orgError) {
      logger.error(`Failed to list repos for "${owner}" as both user and org.`, {
        error: orgError instanceof Error ? orgError.message : String(orgError),
      });
    }

    return repos;
  }

  // ============================================================
  // Review Comments (for reading Cursor Bugbot reports)
  // ============================================================

  async listReviewComments(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewComment[]> {
    logger.debug("Fetching PR review comments.", { owner, repo, prNumber });

    const comments: ReviewComment[] = [];

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.pulls.listReviewComments,
      { owner, repo, pull_number: prNumber, per_page: 100 }
    )) {
      for (const comment of response.data) {
        comments.push({
          id: comment.id,
          body: comment.body,
          path: comment.path,
          line: comment.line ?? null,
          originalLine: comment.original_line ?? null,
          commitId: comment.commit_id,
          userLogin: comment.user.login,
          pullRequestReviewId: comment.pull_request_review_id ?? 0,
          createdAt: comment.created_at,
        });
      }
    }

    return comments;
  }

  // ============================================================
  // Issue Comments (for posting fix summaries)
  // ============================================================

  async createIssueComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<number> {
    logger.debug("Creating issue comment.", { owner, repo, prNumber });

    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    return data.id;
  }
}

// ============================================================
// Token validation utility
// ============================================================

function validateGitHubToken(token: string): void {
  const validPrefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
  const hasValidPrefix = validPrefixes.some((prefix) => token.startsWith(prefix));
  if (!hasValidPrefix) {
    throw new Error(
      `Invalid GH_TOKEN format. GitHub tokens should start with one of: ${validPrefixes.join(", ")}`
    );
  }
}
