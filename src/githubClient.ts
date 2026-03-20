// GitHub API client for Fixooly.
// Uses GitHub App authentication with per-installation Octokit instances.
// Manages JWT auth for app-level operations and installation access tokens
// for repo-specific API calls and git operations.
// Limitations: Rate limiting is handled by Octokit built-in throttling.
//   Installation map is loaded at startup; restart daemon to pick up
//   newly added App installations.

import { App, Octokit } from "octokit";

import { logger } from "./logger.js";
import type { PullRequest } from "./types.js";

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
  private app: App;
  private _appSlug: string;
  private _botUserId: number;
  private installationMap: Map<string, number>;
  private octokitCache: Map<number, Octokit>;

  private constructor(app: App, appSlug: string, botUserId: number) {
    this.app = app;
    this._appSlug = appSlug;
    this._botUserId = botUserId;
    this.installationMap = new Map();
    this.octokitCache = new Map();
  }

  get appSlug(): string {
    return this._appSlug;
  }

  get botUserId(): number {
    return this._botUserId;
  }

  // ============================================================
  // Factory: Create client from GitHub App credentials
  // ============================================================

  static async createFromApp(
    appId: number,
    privateKey: string
  ): Promise<GitHubClient> {
    const app = new App({ appId, privateKey });

    const client = new GitHubClient(app, `app-${appId}`, 0);
    await client.loadInstallations();
    await client.resolveBotIdentity();
    return client;
  }

  private async resolveBotIdentity(): Promise<void> {
    const firstInstallationId = this.installationMap.values().next().value;
    if (firstInstallationId === undefined) return;

    const octokit = await this.getInstallationOctokit(firstInstallationId);

    try {
      const { data: appInfo } = await octokit.rest.apps.getAuthenticated();
      this._appSlug = appInfo?.slug ?? this._appSlug;
    } catch (error) {
      logger.warn("Failed to fetch app slug, using fallback.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const { data: botUser } = await octokit.rest.users.getByUsername({
        username: `${this._appSlug}[bot]`,
      });
      this._botUserId = botUser.id;
    } catch (error) {
      logger.warn("Failed to fetch bot user ID, commits may not show app avatar.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("Bot identity resolved.", {
      appSlug: this._appSlug,
      botUserId: this._botUserId,
    });
  }

  private async getInstallationOctokit(installationId: number): Promise<Octokit> {
    const cached = this.octokitCache.get(installationId);
    if (cached) return cached;
    const octokit = await this.app.getInstallationOctokit(installationId);
    this.octokitCache.set(installationId, octokit as Octokit);
    return octokit as Octokit;
  }

  // ============================================================
  // Installation management
  // ============================================================

  private async loadInstallations(): Promise<void> {
    this.installationMap.clear();
    this.octokitCache.clear();

    for await (const { installation } of this.app.eachInstallation.iterator()) {
      const login = installation.account?.login;
      if (login) {
        this.installationMap.set(login.toLowerCase(), installation.id);
        logger.info(
          `Found GitHub App installation for "${login}" (ID: ${installation.id}).`
        );
      }
    }

    if (this.installationMap.size === 0) {
      throw new Error(
        "No GitHub App installations found. Ensure the App is installed on at least one organization or user account."
      );
    }

    logger.info(
      `Loaded ${this.installationMap.size} GitHub App installation(s).`
    );
  }

  private getInstallationId(owner: string): number {
    const id = this.installationMap.get(owner.toLowerCase());
    if (id === undefined) {
      throw new Error(
        `No GitHub App installation found for owner "${owner}". ` +
          "Ensure the GitHub App is installed on this account."
      );
    }
    return id;
  }

  private async getOctokitForOwner(owner: string): Promise<Octokit> {
    const installationId = this.getInstallationId(owner);
    return this.getInstallationOctokit(installationId);
  }

  // ============================================================
  // Repository auto-discovery from App installations
  // ============================================================

  async listAccessibleRepos(): Promise<
    Array<{ owner: string; name: string }>
  > {
    // Refresh installations so newly added ones are picked up without restart
    await this.loadInstallations();

    const repos: Array<{ owner: string; name: string }> = [];

    for await (const { repository } of this.app.eachRepository.iterator()) {
      repos.push({ owner: repository.owner.login, name: repository.name });
    }

    logger.info(
      `Found ${repos.length} accessible repository/repositories across all installations.`
    );
    return repos;
  }

  // ============================================================
  // Installation access token (for git clone/push operations)
  // ============================================================

  async getInstallationToken(owner: string): Promise<string> {
    const installationId = this.getInstallationId(owner);

    const { data } =
      await this.app.octokit.rest.apps.createInstallationAccessToken({
        installation_id: installationId,
      });

    return data.token;
  }

  // ============================================================
  // Review Comments (repo-level, filtered for cursor[bot])
  // ============================================================

  async listRepoBugbotComments(
    owner: string,
    repo: string,
    since?: string
  ): Promise<Map<number, ReviewComment[]>> {
    logger.debug("Fetching repo-level cursor[bot] review comments.", {
      owner,
      repo,
      since: since ?? "(all)",
    });

    const octokit = await this.getOctokitForOwner(owner);
    const commentsByPr = new Map<number, ReviewComment[]>();

    for await (const response of octokit.paginate.iterator(
      octokit.rest.pulls.listReviewCommentsForRepo,
      {
        owner,
        repo,
        sort: "created",
        direction: "desc",
        since,
        per_page: 100,
      }
    )) {
      for (const comment of response.data) {
        if (comment.user?.login !== "cursor[bot]") continue;

        const prNumber = extractPrNumberFromUrl(comment.pull_request_url);
        if (!prNumber) continue;

        const rc: ReviewComment = {
          id: comment.id,
          body: comment.body,
          path: comment.path,
          line: comment.line ?? null,
          originalLine: comment.original_line ?? null,
          commitId: comment.commit_id,
          userLogin: comment.user.login,
          pullRequestReviewId: comment.pull_request_review_id ?? 0,
          createdAt: comment.created_at,
        };

        const existing = commentsByPr.get(prNumber) ?? [];
        existing.push(rc);
        commentsByPr.set(prNumber, existing);
      }
    }

    if (commentsByPr.size > 0) {
      logger.debug(
        `Found cursor[bot] comments on ${commentsByPr.size} PR(s) in ${owner}/${repo}.`
      );
    }

    return commentsByPr;
  }

  // ============================================================
  // Single Pull Request (for fetching details of affected PRs)
  // ============================================================

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PullRequest | null> {
    logger.debug("Fetching PR details.", { owner, repo, prNumber });

    const octokit = await this.getOctokitForOwner(owner);
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (pr.state !== "open") {
      logger.debug(`PR #${prNumber} is ${pr.state}, skipping.`, {
        owner,
        repo,
        prNumber,
      });
      return null;
    }

    return {
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      htmlUrl: pr.html_url,
    };
  }

  // ============================================================
  // Resolved review threads (via GraphQL)
  // ============================================================

  async getResolvedCommentIds(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<Set<number>> {
    logger.debug("Fetching resolved review threads via GraphQL.", {
      owner,
      repo,
      prNumber,
    });

    const octokit = await this.getOctokitForOwner(owner);
    const resolvedIds = new Set<number>();
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const query = `
        query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              reviewThreads(first: 100, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  isResolved
                  comments(first: 100) {
                    nodes {
                      databaseId
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response: GraphQLReviewThreadsResponse =
        await octokit.graphql(query, {
          owner,
          repo,
          prNumber,
          after: cursor,
        });

      const pullRequest = response.repository.pullRequest;
      if (!pullRequest) {
        logger.warn("PR not found via GraphQL, skipping resolved thread check.", {
          owner,
          repo,
          prNumber,
        });
        return resolvedIds;
      }

      const threads = pullRequest.reviewThreads;

      for (const thread of threads.nodes) {
        if (thread.isResolved) {
          for (const comment of thread.comments.nodes) {
            resolvedIds.add(comment.databaseId);
          }
        }
      }

      hasNextPage = threads.pageInfo.hasNextPage;
      cursor = threads.pageInfo.endCursor;
    }

    if (resolvedIds.size > 0) {
      logger.debug(
        `Found ${resolvedIds.size} resolved review thread(s).`,
        { owner, repo, prNumber }
      );
    }

    return resolvedIds;
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

    const octokit = await this.getOctokitForOwner(owner);
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    return data.id;
  }

  async hasIssueCommentContaining(
    owner: string,
    repo: string,
    prNumber: number,
    marker: string
  ): Promise<boolean> {
    logger.debug("Checking for existing issue comment with marker.", {
      owner,
      repo,
      prNumber,
    });

    const octokit = await this.getOctokitForOwner(owner);

    for await (const response of octokit.paginate.iterator(
      octokit.rest.issues.listComments,
      {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      }
    )) {
      for (const comment of response.data) {
        if (comment.body?.includes(marker)) {
          return true;
        }
      }
    }

    return false;
  }
}

// ============================================================
// Utilities
// ============================================================

interface GraphQLReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<{
          isResolved: boolean;
          comments: {
            nodes: Array<{
              databaseId: number;
            }>;
          };
        }>;
      };
    } | null;
  };
}

function extractPrNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pulls\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}
