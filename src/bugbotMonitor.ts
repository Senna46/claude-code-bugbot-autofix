// Monitor for Cursor Bugbot review comments on GitHub PRs.
// Scans monitored repos/orgs for open PRs, fetches review comments
// from cursor[bot], parses bug reports, and filters out already-processed bugs.
// Limitations: Only detects bugs from cursor[bot] review comments
//   with the BUGBOT_BUG_ID marker. Does not handle issue comments.

import { isBugbotComment, parseBugbotComment } from "./bugParser.js";
import type { GitHubClient } from "./githubClient.js";
import { logger } from "./logger.js";
import type { StateStore } from "./state.js";
import type { Config, PrBugReport, PullRequest } from "./types.js";

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
  // Main: Discover unprocessed Bugbot bugs across all monitored PRs
  // ============================================================

  async discoverUnprocessedBugs(): Promise<PrBugReport[]> {
    const allPrs = await this.getAllMonitoredPrs();
    logger.info(`Found ${allPrs.length} open PR(s) across monitored repos.`);

    const reports: PrBugReport[] = [];

    for (const pr of allPrs) {
      try {
        const report = await this.scanPrForBugs(pr);
        if (report && report.bugs.length > 0) {
          reports.push(report);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `Error scanning PR #${pr.number} in ${pr.owner}/${pr.repo}.`,
          { error: message, prNumber: pr.number, repo: `${pr.owner}/${pr.repo}` }
        );
      }
    }

    return reports;
  }

  // ============================================================
  // Scan a single PR for Bugbot bugs
  // ============================================================

  private async scanPrForBugs(pr: PullRequest): Promise<PrBugReport | null> {
    const comments = await this.github.listReviewComments(
      pr.owner,
      pr.repo,
      pr.number
    );

    const bugbotComments = comments.filter(isBugbotComment);

    if (bugbotComments.length === 0) {
      return null;
    }

    logger.debug(
      `Found ${bugbotComments.length} Bugbot comment(s) on PR #${pr.number}.`,
      { owner: pr.owner, repo: pr.repo, prNumber: pr.number }
    );

    const unprocessedBugs = [];

    for (const comment of bugbotComments) {
      const bug = parseBugbotComment(comment);
      if (!bug) continue;

      if (this.state.isBugProcessed(bug.bugId)) {
        logger.debug(`Bug already processed, skipping.`, { bugId: bug.bugId });
        continue;
      }

      unprocessedBugs.push(bug);
    }

    if (unprocessedBugs.length === 0) {
      return null;
    }

    logger.info(
      `PR #${pr.number} in ${pr.owner}/${pr.repo}: ${unprocessedBugs.length} unprocessed bug(s) found.`,
      {
        prNumber: pr.number,
        repo: `${pr.owner}/${pr.repo}`,
        bugCount: unprocessedBugs.length,
        bugIds: unprocessedBugs.map((b) => b.bugId),
      }
    );

    return { pr, bugs: unprocessedBugs };
  }

  // ============================================================
  // List all open PRs across monitored repos and orgs
  // ============================================================

  private async getAllMonitoredPrs(): Promise<PullRequest[]> {
    const allPrs: PullRequest[] = [];
    const processedRepos = new Set<string>();

    for (const repoSpec of this.config.githubRepos) {
      const [owner, repo] = repoSpec.split("/");
      if (!owner || !repo) continue;
      const repoKey = `${owner}/${repo}`;
      if (processedRepos.has(repoKey)) continue;
      processedRepos.add(repoKey);

      try {
        const prs = await this.github.listOpenPullRequests(owner, repo);
        allPrs.push(...prs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list PRs for ${repoKey}.`, {
          error: message, repo: repoKey,
        });
      }
    }

    for (const org of this.config.githubOrgs) {
      try {
        const repos = await this.github.listOwnerRepos(org);
        for (const repo of repos) {
          const repoKey = `${repo.owner}/${repo.name}`;
          if (processedRepos.has(repoKey)) continue;
          processedRepos.add(repoKey);

          try {
            const prs = await this.github.listOpenPullRequests(
              repo.owner,
              repo.name
            );
            allPrs.push(...prs);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to list PRs for ${repoKey}.`, {
              error: message, repo: repoKey,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list repos for org "${org}".`, {
          error: message, org,
        });
      }
    }

    return allPrs;
  }
}
