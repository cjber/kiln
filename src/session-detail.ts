import { type PullRequest, type Stage, stageOf } from "./dashboard";
import { repositoryName, type Session, sessionDirectory } from "./sessions";
import { tilde } from "./tui";

export type DetailOptions = {
  /** The session's pull requests. */
  prs?: readonly PullRequest[];
  /** Uncommitted files in its checkout, once counted. */
  changes?: number;
  /** A repository name already worked out for the directory. */
  repository?: string;
};

/** One `·`-separated part of the detail line; a pull request carries its stage so the caller can colour its dot. */
export type DetailPart = { text: string; stage?: Stage };

/** The newest pull request first. */
export function newestFirst(prs: readonly PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => b.number - a.number);
}

/** The expanded line under a session: which repository, worktree, branch, every pull request and how much changed. */
export function sessionDetail(
  session: Session,
  { prs = [], changes = 0, repository }: DetailOptions = {},
): DetailPart[] {
  const directory = sessionDirectory(session);
  const branch = session.branch;
  const defaultBranch = branch === "main" || branch === "master";
  const pulls: DetailPart[] = defaultBranch
    ? []
    : prs.length
      ? newestFirst(prs).map((pr) => ({ text: `#${pr.number} ●`, stage: stageOf(pr) }))
      : [{ text: "no PR yet" }];
  return [
    { text: repository ?? repositoryName(directory) },
    { text: tilde(directory) },
    ...(branch ? [{ text: branch }] : []),
    ...pulls,
    ...(changes ? [{ text: `${changes} changed` }] : []),
  ].filter((part) => part.text);
}
