// Parser for Cursor Bugbot review comment bodies.
// Extracts structured bug information from the HTML-comment-based
// format that Cursor Bugbot uses in its PR review comments.
// Limitations: Tightly coupled to Cursor Bugbot's comment format.
//   Format changes in Bugbot may require updates to the regex patterns.

import type { BugSeverity, BugbotBug } from "./types.js";
import type { ReviewComment } from "./githubClient.js";
import { logger } from "./logger.js";

const BUGBOT_BUG_ID_PATTERN = /<!-- BUGBOT_BUG_ID:\s*([0-9a-zA-Z_-]+)\s*-->/;
const DESCRIPTION_PATTERN = /<!-- DESCRIPTION START -->([\s\S]*?)<!-- DESCRIPTION END -->/;
const LOCATIONS_PATTERN = /<!-- LOCATIONS START\n([\s\S]*?)LOCATIONS END -->/;
const TITLE_PATTERN = /^###\s+(.+)$/m;
const SEVERITY_PATTERN = /\*\*(Low|Medium|High|Critical)\s+Severity\*\*/i;

export function isBugbotComment(comment: ReviewComment): boolean {
  return (
    comment.userLogin === "cursor[bot]" &&
    BUGBOT_BUG_ID_PATTERN.test(comment.body)
  );
}

export function parseBugbotComment(comment: ReviewComment): BugbotBug | null {
  const bugIdMatch = comment.body.match(BUGBOT_BUG_ID_PATTERN);
  if (!bugIdMatch) {
    return null;
  }
  const bugId = bugIdMatch[1];

  const titleMatch = comment.body.match(TITLE_PATTERN);
  const title = titleMatch ? titleMatch[1].trim() : "Unknown bug";

  const severityMatch = comment.body.match(SEVERITY_PATTERN);
  const severity = parseSeverity(severityMatch ? severityMatch[1] : "medium");

  const descriptionMatch = comment.body.match(DESCRIPTION_PATTERN);
  const description = descriptionMatch
    ? descriptionMatch[1].trim()
    : extractFallbackDescription(comment.body);

  const locationInfo = parseLocations(comment.body, comment.path);
  const filePath = locationInfo.filePath;
  const startLine = locationInfo.startLine;
  const endLine = locationInfo.endLine;

  const bug: BugbotBug = {
    bugId,
    title,
    severity,
    description,
    filePath,
    startLine,
    endLine,
    commitId: comment.commitId,
    reviewCommentId: comment.id,
  };

  logger.debug("Parsed Bugbot bug.", {
    bugId,
    title,
    severity,
    filePath,
    startLine,
    endLine,
  });

  return bug;
}

function parseSeverity(raw: string): BugSeverity {
  const lower = raw.toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  return "low";
}

function parseLocations(
  body: string,
  commentPath: string
): { filePath: string; startLine: number | null; endLine: number | null } {
  const locationsMatch = body.match(LOCATIONS_PATTERN);
  if (locationsMatch) {
    const locationsText = locationsMatch[1].trim();
    const lines = locationsText.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const lineRangeMatch = trimmed.match(/^(.+?)#L(\d+)(?:-L(\d+))?$/);
      if (lineRangeMatch) {
        return {
          filePath: lineRangeMatch[1],
          startLine: parseInt(lineRangeMatch[2], 10),
          endLine: lineRangeMatch[3]
            ? parseInt(lineRangeMatch[3], 10)
            : null,
        };
      }

      if (!trimmed.includes("#")) {
        return { filePath: trimmed, startLine: null, endLine: null };
      }
    }
  }

  return { filePath: commentPath, startLine: null, endLine: null };
}

function extractFallbackDescription(body: string): string {
  const titleMatch = body.match(TITLE_PATTERN);
  const severityMatch = body.match(SEVERITY_PATTERN);

  let startIdx = 0;
  if (severityMatch && severityMatch.index !== undefined) {
    startIdx = severityMatch.index + severityMatch[0].length;
  } else if (titleMatch && titleMatch.index !== undefined) {
    startIdx = titleMatch.index + titleMatch[0].length;
  }

  const endIdx = body.indexOf("<!-- BUGBOT_BUG_ID:");
  if (endIdx === -1) {
    return body.substring(startIdx).trim().substring(0, 500);
  }

  return body.substring(startIdx, endIdx).trim().substring(0, 500);
}
