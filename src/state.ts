// SQLite-based state management for Claude Code Bugbot Autofix.
// Tracks which Cursor Bugbot bug IDs have been processed
// to prevent duplicate fix attempts.
// Limitations: Single-process only; no concurrent access support.

import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";

import { logger } from "./logger.js";
import type { ProcessedBugRecord } from "./types.js";

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();

    logger.debug("State store initialized.", { dbPath });
  }

  // ============================================================
  // Schema initialization
  // ============================================================

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_bugs (
        bug_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        processed_at TEXT NOT NULL,
        fix_commit_sha TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_processed_bugs_repo_pr
        ON processed_bugs (repo, pr_number);
    `);
  }

  // ============================================================
  // Bug tracking
  // ============================================================

  isBugProcessed(bugId: string): boolean {
    const row = this.db
      .prepare("SELECT fix_commit_sha FROM processed_bugs WHERE bug_id = ?")
      .get(bugId) as { fix_commit_sha: string | null } | undefined;
    // Bugs marked as FAILED should be retried
    return row !== undefined && row.fix_commit_sha !== "FAILED";
  }

  hasFailedBugsForRepo(repo: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM processed_bugs WHERE fix_commit_sha = 'FAILED' AND repo = ? LIMIT 1"
      )
      .get(repo);
    return row !== undefined;
  }

  recordProcessedBug(
    bugId: string,
    repo: string,
    prNumber: number,
    fixCommitSha: string | null
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO processed_bugs
         (bug_id, repo, pr_number, processed_at, fix_commit_sha)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(bugId, repo, prNumber, new Date().toISOString(), fixCommitSha);

    logger.debug("Recorded processed bug.", {
      bugId,
      repo,
      prNumber,
      fixCommitSha,
    });
  }

  recordProcessedBugs(
    bugs: Array<{ bugId: string; repo: string; prNumber: number }>,
    fixCommitSha: string | null
  ): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO processed_bugs
       (bug_id, repo, pr_number, processed_at, fix_commit_sha)
       VALUES (?, ?, ?, ?, ?)`
    );

    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      for (const bug of bugs) {
        insert.run(bug.bugId, bug.repo, bug.prNumber, now, fixCommitSha);
      }
    });

    transaction();

    logger.debug(`Recorded ${bugs.length} processed bug(s).`, {
      fixCommitSha,
      bugIds: bugs.map((b) => b.bugId),
    });
  }

  getProcessedBugsForPr(
    repo: string,
    prNumber: number
  ): ProcessedBugRecord[] {
    const rows = this.db
      .prepare(
        "SELECT bug_id, repo, pr_number, processed_at, fix_commit_sha FROM processed_bugs WHERE repo = ? AND pr_number = ?"
      )
      .all(repo, prNumber) as Array<{
        bug_id: string;
        repo: string;
        pr_number: number;
        processed_at: string;
        fix_commit_sha: string | null;
      }>;

    return rows.map((row) => ({
      bugId: row.bug_id,
      repo: row.repo,
      prNumber: row.pr_number,
      processedAt: row.processed_at,
      fixCommitSha: row.fix_commit_sha,
    }));
  }

  // ============================================================
  // Cleanup
  // ============================================================

  close(): void {
    this.db.close();
    logger.debug("State store closed.");
  }
}
