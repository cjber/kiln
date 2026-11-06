import { type PullRequest, type Stage, stageOf } from "./dashboard";
import { repositoryName, type Session, sessionDirectory } from "./sessions";
import { tilde } from "./tui";

const pullMark: Record<Stage, string> = { working: "", failing: "✗", checks: "●", green: "✓", done: "✓" };

export type DetailOptions = {
  /** The session's pull requests, most urgent first. */
  prs?: readonly PullRequest[];
  /** Uncommitted files in its checkout, once counted. */
  changes?: number;
  /** A repository name already worked out for the directory. */
  repository?: string;
};

/** The dim line under a session: which repository, worktree, branch, pull request and how much changed. */
export function sessionDetail(session: Session, { prs = [], changes = 0, repository }: DetailOptions = {}): string {
  const directory = sessionDirectory(session);
  const branch = session.branch;
  const defaultBranch = branch === "main" || branch === "master";
  const pr = defaultBranch ? undefined : prs[0];
  const pull = defaultBranch ? undefined : pr ? `#${pr.number} ${pullMark[stageOf(pr)]}`.trim() : "no PR yet";
  return [
    repository ?? repositoryName(directory),
    tilde(directory),
    branch,
    pull,
    changes ? `${changes} changed` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
