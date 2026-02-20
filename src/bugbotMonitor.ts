// Monitor for Cursor Bugbot review comments on GitHub PRs.
// Uses repo-level review comment API to efficiently find cursor[bot]
// comments without scanning every open PR individually.
// Only PRs with unprocessed, non-resolved Bugbot comments are returned.
// Limitations: Only detects bugs from cursor[bot] review comments
//   with the BUGBOT_BUG_ID marker. Does not handle issue comments.

import { isBugbotComment, parseBugbotComment } from "./bugParser.js";
import type { GitHubClient } from "./githubClient.js";
import { logger } from "./logger.js";
import type { StateStore } from "./state.js";
import type { Config, PrBugReport } from "./types.js";

const DEFAULT_LOOKBACK_DAYS = 7;

export class BugbotMonitor {
  private github: GitHubClient;
  private state: StateStore;
  private config: Config;
  constructor(github: GitHubClient, state: StateStore, config: Config) {
    this.github = github;
    this.state = state;
    this.config = config;
  }

  // ============================================================
  // Main: Discover unprocessed Bugbot bugs across all monitored repos
  // ============================================================

  async discoverUnprocessedBugs(): Promise<PrBugReport[]> {
    const since = this.computeSince();

    const repos = await this.getAllMonitoredRepos();
    logger.info(`Scanning ${repos.length} repo(s) for cursor[bot] comments${since ? ` since ${since}` : ""}.`);

    const reports: PrBugReport[] = [];

    for (const { owner, repo } of repos) {
      try {
        const repoReports = await this.scanRepoForBugs(owner, repo, since);
        reports.push(...repoReports);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Error scanning repo ${owner}/${repo}.`, {
          error: message,
          repo: `${owner}/${repo}`,
        });
      }
    }

    return reports;
  }

  // ============================================================
  // Scan a single repo for Bugbot bugs (repo-level comment fetch)
  // ============================================================

  private async scanRepoForBugs(
    owner: string,
    repo: string,
    since: string | undefined
  ): Promise<PrBugReport[]> {
    const commentsByPr = await this.github.listRepoBugbotComments(
      owner,
      repo,
      since
    );

    if (commentsByPr.size === 0) {
      return [];
    }

    const reports: PrBugReport[] = [];

    for (const [prNumber, comments] of commentsByPr) {
      try {
        const report = await this.processPrComments(
          owner,
          repo,
          prNumber,
          comments
        );
        if (report && report.bugs.length > 0) {
          reports.push(report);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `Error processing comments for PR #${prNumber} in ${owner}/${repo}.`,
          { error: message, prNumber, repo: `${owner}/${repo}` }
        );
      }
    }

    return reports;
  }

  // ============================================================
  // Process cursor[bot] comments for a single PR
  // ============================================================

  private async processPrComments(
    owner: string,
    repo: string,
    prNumber: number,
    comments: import("./githubClient.js").ReviewComment[]
  ): Promise<PrBugReport | null> {
    const bugbotComments = comments.filter(isBugbotComment);
    if (bugbotComments.length === 0) {
      return null;
    }

    // First pass: filter out already-processed bugs (cheap local check)
    const candidateComments = [];
    for (const comment of bugbotComments) {
      const bug = parseBugbotComment(comment);
      if (!bug) continue;
      if (this.state.isBugProcessed(bug.bugId)) {
        logger.debug("Bug already processed, skipping.", { bugId: bug.bugId });
        continue;
      }
      candidateComments.push({ comment, bug });
    }

    if (candidateComments.length === 0) {
      return null;
    }

    // Cheap REST call: check if PR is still open before expensive GraphQL
    const pr = await this.github.getPullRequest(owner, repo, prNumber);
    if (!pr) {
      // PR is closed/inaccessible — mark bugs as permanently skipped so
      // stale FAILED records don't disable the time filter in computeSince().
      this.state.recordProcessedBugs(
        candidateComments.map(({ bug: b }) => ({
          bugId: b.bugId,
          repo: `${owner}/${repo}`,
          prNumber,
        })),
        "SKIPPED_PR_CLOSED"
      );
      logger.debug(
        `PR #${prNumber} in ${owner}/${repo} is closed/inaccessible, skipping ${candidateComments.length} bug(s).`,
        { prNumber, repo: `${owner}/${repo}`, bugIds: candidateComments.map(({ bug: b }) => b.bugId) }
      );
      return null;
    }

    // Expensive GraphQL call: filter out resolved threads
    const resolvedIds = await this.github.getResolvedCommentIds(
      owner,
      repo,
      prNumber
    );

    const unprocessedBugs = [];
    const resolvedBugs = [];

    for (const { comment, bug } of candidateComments) {
      if (resolvedIds.has(comment.id)) {
        logger.debug("Bug comment resolved, skipping.", {
          commentId: comment.id,
        });
        resolvedBugs.push(bug);
        continue;
      }

      unprocessedBugs.push(bug);
    }

    // Mark resolved bugs with a terminal state so stale FAILED records
    // don't permanently disable the time filter in computeSince().
    if (resolvedBugs.length > 0) {
      this.state.recordProcessedBugs(
        resolvedBugs.map((b) => ({
          bugId: b.bugId,
          repo: `${owner}/${repo}`,
          prNumber,
        })),
        "SKIPPED_RESOLVED"
      );
      logger.debug(
        `Marked ${resolvedBugs.length} resolved bug(s) as SKIPPED_RESOLVED.`,
        { prNumber, repo: `${owner}/${repo}`, bugIds: resolvedBugs.map((b) => b.bugId) }
      );
    }

    if (unprocessedBugs.length === 0) {
      return null;
    }

    logger.info(
      `PR #${prNumber} in ${owner}/${repo}: ${unprocessedBugs.length} unprocessed bug(s) found.`,
      {
        prNumber,
        repo: `${owner}/${repo}`,
        bugCount: unprocessedBugs.length,
        bugIds: unprocessedBugs.map((b) => b.bugId),
      }
    );

    return { pr, bugs: unprocessedBugs };
  }

  // ============================================================
  // List all monitored repos from config
  // ============================================================

  private async getAllMonitoredRepos(): Promise<
    Array<{ owner: string; repo: string }>
  > {
    const allRepos: Array<{ owner: string; repo: string }> = [];
    const processedRepos = new Set<string>();

    for (const repoSpec of this.config.githubRepos) {
      const [owner, repo] = repoSpec.split("/");
      if (!owner || !repo) continue;
      const repoKey = `${owner}/${repo}`;
      if (processedRepos.has(repoKey)) continue;
      processedRepos.add(repoKey);
      allRepos.push({ owner, repo });
    }

    for (const org of this.config.githubOrgs) {
      try {
        const repos = await this.github.listOwnerRepos(org);
        for (const repo of repos) {
          const repoKey = `${repo.owner}/${repo.name}`;
          if (processedRepos.has(repoKey)) continue;
          processedRepos.add(repoKey);
          allRepos.push({ owner: repo.owner, repo: repo.name });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list repos for org "${org}".`, {
          error: message,
          org,
        });
      }
    }

    return allRepos;
  }

  // ============================================================
  // Compute the "since" timestamp for the API query
  // ============================================================

  private computeSince(): string | undefined {
    if (this.state.hasFailedBugs()) {
      logger.debug("Skipping since filter to retry failed bugs.");
      return undefined;
    }
    const lookbackMs = DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - lookbackMs).toISOString();
  }
}
