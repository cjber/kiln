import { type PullRequest, stageOf } from "./dashboard";
import { post } from "./mailbox";
import { autopilotSender } from "./messages";
import { type Session, sessionIdentity } from "./sessions";

/** What kiln tells an agent about one of its pull requests; `key` names the event, so it is sent once. */
export type PullEvent = { key: string; body: string };

/** What the last refresh saw of a pull request, so a review or a merge is told only when it happens. */
type Seen = { state: PullRequest["state"]; reviews: number };

/**
 * The events a pull request's agent should hear about. Failing checks and conflicts are states, told once per head
 * commit; a review and a merge are changes, told only when a refresh sees them happen. A pull request not yet looked
 * up by URL has no head commit and says nothing. Nothing a reviewer wrote is quoted: anyone can review a public pull
 * request, and their words would reach the agent as kiln's.
 */
export function pullEvents(pr: PullRequest, before: Seen | undefined): PullEvent[] {
  if (!pr.head) return [];
  const name = `PR #${pr.number} in ${pr.repository}`;
  if (pr.state === "MERGED")
    return before?.state === "OPEN" ? [{ key: `${pr.url}:merged`, body: `${name} merged: ${pr.url}` }] : [];
  if (pr.state !== "OPEN") return [];
  const events: PullEvent[] = [];
  if (stageOf(pr) === "failing" && pr.failedChecks?.length)
    events.push({
      key: `${pr.url}:${pr.head}:failed`,
      body: `${name} has failing checks on ${pr.head.slice(0, 7)}: ${pr.failedChecks.join(", ")}. Read them with \`gh pr checks ${pr.url}\`, fix the cause and push: ${pr.url}`,
    });
  if (pr.mergeable === "CONFLICTING")
    events.push({
      key: `${pr.url}:${pr.head}:conflict`,
      body: `${name} has merge conflicts with its base branch. Rebase it locally, resolve them and push: ${pr.url}`,
    });
  if (before && pr.review && (pr.reviews ?? 0) > before.reviews) {
    const [, owner, repo] = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\//) ?? [];
    events.push({
      key: `${pr.url}:review:${pr.reviews}`,
      body:
        `${name} has a new review from ${pr.review.author} (${pr.review.state.toLowerCase().replaceAll("_", " ")}). ` +
        `Read it and its inline comments with \`gh api repos/${owner}/${repo}/pulls/${pr.number}/comments\`, ` +
        `then fix or answer each one: ${pr.url}`,
    });
  }
  return events;
}

/**
 * Tells each session's agent about its pull requests through the kiln mailbox. A pull request belongs to the one
 * session that opened it, else to the most recently active session on its branch, so sessions sharing a branch hear
 * it once. Messages are posted under the event's key, so a repeat, from this process or after a restart, is the same
 * message and is never sent twice.
 */
export function autopilot(send: typeof post = post) {
  const seen = new Map<string, Seen>();
  return (found: ReadonlyMap<Session, readonly PullRequest[]>) => {
    const owners = new Map<string, { session: Session; pr: PullRequest }>();
    for (const [session, prs] of found)
      for (const pr of prs) {
        const owner = owners.get(pr.url);
        const better =
          !owner ||
          (pr.opened && !owner.pr.opened) ||
          (!!pr.opened === !!owner.pr.opened && (session.lastActiveAt ?? 0) > (owner.session.lastActiveAt ?? 0));
        if (better) owners.set(pr.url, { session, pr });
      }
    let posted = 0;
    for (const [url, { session, pr }] of owners) {
      for (const event of pullEvents(pr, seen.get(url)))
        try {
          send(autopilotSender, sessionIdentity(session), event.body, undefined, undefined, `autopilot:${event.key}`);
          posted++;
        } catch {
          // A full mailbox or a send limit drops this one; the state is still there on the next commit.
        }
      if (pr.head) seen.set(url, { state: pr.state, reviews: pr.reviews ?? 0 });
    }
    for (const url of seen.keys()) if (!owners.has(url)) seen.delete(url);
    return posted;
  };
}
