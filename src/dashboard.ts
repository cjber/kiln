import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import page from "./dashboard.html" with { type: "text" };
import { parsePort } from "./serve";
import { sessionTitle } from "./session-list";
import { openedPullRequests } from "./session-prs";
import {
  type Activity,
  agentName,
  type Discovered,
  discovery,
  gitBranch,
  type Lifecycle,
  type Session,
  sessionDirectory,
  sessionIdentity,
  sessionParents,
} from "./sessions";
import { changedFiles, checkout } from "./workdir";

/** How far a session's work has got, least finished first; the page sorts and colours by it. */
export type Stage = "working" | "failing" | "checks" | "green" | "done";

export type Checks = { passed: number; failed: number; running: number };

export type PullRequest = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  additions: number;
  deletions: number;
  /** Labelled for the MergeLoop queue. */
  queued: boolean;
  checks: Checks;
  /** The repository's name, read from the URL. */
  repository: string;
  /** The head commit, once looked up by URL. */
  head?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Names of the checks that failed on the head commit. */
  failedChecks?: string[];
  /** Reviews submitted so far, and the latest one. */
  reviews?: number;
  review?: { author: string; state: string };
  /** The session it belongs to opened it with `gh pr create`, rather than only working on its branch. */
  opened?: boolean;
};

export type DashboardRow = {
  /** Stable session identity, used to nest a child lane under its parent and to keep its samples. */
  id: string;
  /** The identity of the session whose lane holds this one, or undefined for a top-level card. */
  parent?: string;
  title: string;
  agent: string;
  activity?: Activity;
  lifecycle?: Lifecycle;
  project: string;
  /** The basename of the directory the session works in, shown beside its repository. */
  worktree: string;
  branch?: string;
  /** Last provider or transcript update, for the card's age and for fading idle sessions. */
  lastActiveAt?: number;
  startedAt: number;
  /** Uncommitted files in the session's checkout, once counted. */
  changes?: number;
  /** Every pull request the session's branch has or the session opened, most urgent first. */
  prs: PullRequest[];
  stage: Stage;
  /** One flag per recent sample, oldest first: 1 while the session was working. */
  workingSamples: number[];
};

/** The counts drawn as one point on the dashboard's history chart. */
export type HistorySample = {
  at: number;
  working: number;
  waiting: number;
  idle: number;
  /** Open pull requests by stage, drafts kept apart. */
  prs: Record<"failing" | "checks" | "green" | "draft", number>;
};

export type DashboardSnapshot = {
  updatedAt: number;
  problem: string;
  /** Pull request lookups still running, so a row may yet leave Working. */
  checking: number;
  rows: DashboardRow[];
  /** Every open pull request you authored, sessions or not, once GitHub has answered. */
  openPrs: PullRequest[];
  /** One sample every 30 seconds for the last 6 hours, oldest first. */
  history: HistorySample[];
};

type Run = (argv: string[], cwd: string) => Promise<string>;

/** A command's stdout; a non-zero exit or a hang past the timeout is an error. */
async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [output, problem, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(problem.trim() || `${argv[0]} exited with ${code}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** The git directory every worktree of `root`'s repository shares. */
function commonGitDir(root: string): string {
  const dotGit = join(root, ".git");
  if (!statSync(dotGit).isFile()) return dotGit;
  const gitDir = resolve(
    root,
    readFileSync(dotGit, "utf8")
      .replace(/^gitdir:\s*/, "")
      .trim(),
  );
  const common = join(gitDir, "commondir");
  return existsSync(common) ? resolve(gitDir, readFileSync(common, "utf8").trim()) : gitDir;
}

/** The repository a directory belongs to, named after its main checkout, so every worktree of it counts as one project. */
export function projectName(directory: string): string {
  try {
    const root = checkout(directory);
    if (root) {
      const common = commonGitDir(root);
      return basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
    }
  } catch {
    // An unreadable repository is named after its directory.
  }
  return directory === homedir() ? "~" : basename(directory);
}

type CheckEntry = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
};

function checkResult(entry: CheckEntry): keyof Checks {
  if (entry.__typename === "StatusContext") {
    switch (entry.state) {
      case "SUCCESS":
        return "passed";
      case "FAILURE":
      case "ERROR":
        return "failed";
      default:
        // PENDING and EXPECTED, and any state GitHub adds later, are not a result yet.
        return "running";
    }
  }
  if (entry.status !== "COMPLETED") return "running";
  switch (entry.conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
    case "SKIPPED":
      return "passed";
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "STALE":
      return "failed";
    default:
      return "running";
  }
}

/** The repository name in a pull request URL. */
const repositoryOf = (url: string) => url.match(/github\.com\/[^/]+\/([^/]+)\/pull\//)?.[1] ?? "";

export function countChecks(entries: readonly CheckEntry[]): Checks {
  const checks = { passed: 0, failed: 0, running: 0 };
  for (const entry of entries) checks[checkResult(entry)]++;
  return checks;
}

/** The branch's open pull request, else its latest one, from `gh pr list --json` output (newest first). */
export function parsePullRequest(output: string, queueLabel: string): PullRequest | undefined {
  const found = JSON.parse(output) as {
    number: number;
    url: string;
    state: PullRequest["state"];
    isDraft: boolean;
    additions: number;
    deletions: number;
    labels: { name: string }[];
    statusCheckRollup: CheckEntry[] | null;
  }[];
  const pr = found.find((candidate) => candidate.state === "OPEN") ?? found[0];
  if (!pr) return undefined;
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    queued: pr.labels.some((label) => label.name === queueLabel),
    checks: countChecks(pr.statusCheckRollup ?? []),
    repository: repositoryOf(pr.url),
  };
}

/** The fields every GraphQL pull request lookup asks for. */
const pullFields = `number url state isDraft additions deletions mergeable headRefOid
  labels(first: 20) { nodes { name } }
  reviews(last: 1) { totalCount nodes { author { login } state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
  } } } } } }`;

type PullNode = {
  number?: number;
  url: string;
  state: PullRequest["state"];
  isDraft: boolean;
  additions: number;
  deletions: number;
  mergeable: PullRequest["mergeable"];
  headRefOid: string;
  labels: { nodes: { name: string }[] };
  reviews: { totalCount: number; nodes: { author: { login: string } | null; state: string }[] };
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckEntry[] } } | null } }[] };
};

/** A pull request from a GraphQL node holding `pullFields`, or undefined for a node that is not one. */
function parsePullNode(node: PullNode | null | undefined, queueLabel = "mergepatrol"): PullRequest | undefined {
  if (node?.number === undefined) return undefined;
  const checks = node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const review = node.reviews.nodes.at(-1);
  return {
    number: node.number,
    url: node.url,
    state: node.state,
    draft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    queued: node.labels.nodes.some((label) => label.name === queueLabel),
    checks: countChecks(checks),
    repository: repositoryOf(node.url),
    head: node.headRefOid,
    mergeable: node.mergeable,
    failedChecks: checks
      .filter((entry) => checkResult(entry) === "failed")
      .map((entry) => entry.name ?? entry.context ?? "check"),
    reviews: node.reviews.totalCount,
    review: review && { author: review.author?.login ?? "someone", state: review.state },
  };
}

/** Pull requests by URL from one batched `resource(url:)` query's output; unknown URLs are left out. */
export function parsePullRequestsByUrl(output: string): PullRequest[] {
  const data = (JSON.parse(output) as { data: Record<string, PullNode | null> }).data ?? {};
  return Object.values(data).flatMap((node) => parsePullNode(node) ?? []);
}

const urgency: Record<Stage, number> = { failing: 0, checks: 1, green: 2, done: 3, working: 4 };

/** Most urgent first: failing, then checks running, green, merged and closed; ties keep the given order. */
export const byUrgency = (prs: readonly PullRequest[]) =>
  [...prs].sort((a, b) => urgency[stageOf(a)] - urgency[stageOf(b)]);

export function stageOf(pr: PullRequest | undefined): Stage {
  if (!pr) return "working";
  switch (pr.state) {
    case "MERGED":
      return "done";
    case "CLOSED":
      return "working";
    case "OPEN":
      if (pr.checks.failed) return "failing";
      if (pr.checks.running) return "checks";
      return "green";
  }
}

/** The MergeLoop label a repository configures, or its default. */
function queueLabel(root: string): string {
  try {
    const config = readFileSync(join(root, ".mergepatrol", "mergepatrol.yml"), "utf8");
    return config.match(/^label:\s*["']?([^"'\s#]+)/m)?.[1] ?? "mergepatrol";
  } catch {
    return "mergepatrol";
  }
}

type Cached<T> = { value?: T; checkedAt: number; pending: boolean };

const fresh = <T>(cache: Map<string, Cached<T>>, key: string, age: number) => {
  const entry = cache.get(key);
  return entry && (entry.pending || Date.now() - entry.checkedAt < age);
};
const store = <T>(cache: Map<string, Cached<T>>, key: string, value: T | undefined, ok: boolean) => {
  const last = cache.get(key);
  // A failed lookup keeps the last answer and waits a full period before trying again.
  cache.set(key, { value: ok ? value : last?.value, checkedAt: Date.now(), pending: false });
};
/** Drops entries not used since the last sweep; a lookup in flight finishes first. */
const sweep = (cache: Map<string, Cached<unknown>>, used: Set<string>) => {
  for (const [key, entry] of cache) if (!used.has(key) && !entry.pending) cache.delete(key);
  used.clear();
};

export type PullRequestOptions = {
  exec?: Run;
  prAge?: number;
  /** How many `gh` calls may run at once. */
  ghSlots?: number;
  /** The GitHub CLI is installed. */
  gh?: boolean;
};

/** One query for many pull requests by URL; GitHub answers null for one it cannot see. */
const byUrlQuery = (urls: readonly string[]) =>
  `query {\n${urls.map((url, index) => `p${index}: resource(url: ${JSON.stringify(url)}) { ... on PullRequest { ${pullFields} } }`).join("\n")}\n}`;

/** How many pull requests one `resource(url:)` query asks for. */
const batchSize = 40;

/**
 * Each session's pull requests: the one for the branch it works on and every one it opened with
 * `gh pr create`, from caches `gh` fills in the background, so a slow `gh` never holds up a refresh.
 * A branch or a pull request is looked up at most once per `prAge`.
 */
export function pullRequests({
  exec = run,
  prAge = 60_000,
  ghSlots = 3,
  gh = Bun.which("gh") !== null,
}: PullRequestOptions = {}) {
  const prs = new Map<string, Cached<PullRequest | undefined>>();
  const byUrl = new Map<string, Cached<PullRequest>>();
  const queue: { key: string; root: string; branch: string }[] = [];
  let waiting: string[] = [];
  const used = new Set<string>();
  const usedUrls = new Set<string>();
  const opened = openedPullRequests();
  let running = 0;
  const finish = () => {
    running--;
    drain();
  };
  const drain = () => {
    while (running < ghSlots) {
      const job = queue.shift();
      if (job) {
        running++;
        exec(
          [
            "gh",
            "pr",
            "list",
            "--head",
            job.branch,
            "--state",
            "all",
            "--limit",
            "5",
            "--json",
            "number,url,state,isDraft,labels,statusCheckRollup,additions,deletions",
          ],
          job.root,
        )
          .then((output) => parsePullRequest(output, queueLabel(job.root)))
          .then(
            (pr) => store(prs, job.key, pr, true),
            () => store(prs, job.key, undefined, false),
          )
          .finally(finish);
        continue;
      }
      const batch = waiting.slice(0, batchSize);
      if (!batch.length) return;
      waiting = waiting.slice(batchSize);
      running++;
      exec(["gh", "api", "graphql", "-f", `query=${byUrlQuery(batch)}`], homedir())
        .then(parsePullRequestsByUrl)
        .then(
          (found) => {
            // GitHub answers with the canonical URL, which may differ in case from the one asked for.
            for (const url of batch)
              store(
                byUrl,
                url,
                found.find((pr) => pr.url.toLowerCase() === url.toLowerCase()),
                true,
              );
          },
          () => {
            for (const url of batch) store(byUrl, url, undefined, false);
          },
        )
        .finally(finish);
    }
  };
  /** The pull request for the branch a session works on, as last looked up. */
  const ofBranch = (session: Session, lookUp: boolean): PullRequest | undefined => {
    const directory = sessionDirectory(session);
    const root = checkout(directory);
    // Read from the checkout each time, so a session that switches branch is looked up on its new one.
    const branch = root && gitBranch(directory);
    // A default branch is shared by many sessions, so a pull request found for it says nothing about one of them.
    if (!root || !branch || ["main", "master"].includes(branch)) return undefined;
    const key = `${commonGitDir(root)}\0${branch}`;
    used.add(key);
    if (lookUp && !fresh(prs, key, prAge)) {
      prs.set(key, { ...(prs.get(key) ?? { checkedAt: 0 }), pending: true });
      queue.push({ key, root, branch });
      drain();
    }
    return prs.get(key)?.value;
  };
  return {
    gh,
    /**
     * A session's pull requests as last looked up, most urgent first; cloud tasks have none. Each one it
     * opened itself is marked `opened`. With `lookUp` false it only reads the caches.
     */
    of(session: Session, lookUp = true): PullRequest[] {
      if (!gh || session.place.kind === "cloud") return [];
      const branchPr = ofBranch(session, lookUp);
      const mine = opened.of(session);
      const urls = [...new Set([...(branchPr ? [branchPr.url] : []), ...mine])];
      for (const url of urls) {
        usedUrls.add(url);
        if (lookUp && !fresh(byUrl, url, prAge)) {
          byUrl.set(url, { ...(byUrl.get(url) ?? { checkedAt: 0 }), pending: true });
          waiting.push(url);
        }
      }
      if (lookUp) drain();
      return byUrgency(
        urls.flatMap((url) => {
          // The branch lookup answers first; the lookup by URL adds what the autopilot needs. Only the branch
          // lookup knows the repository's queue label, so its `queued` stands.
          const branch = url === branchPr?.url ? branchPr : undefined;
          const found = byUrl.get(url)?.value;
          const pr = found && branch ? { ...found, queued: branch.queued } : (found ?? branch);
          return pr ? [mine.includes(url) ? { ...pr, opened: true } : pr] : [];
        }),
      );
    },
    /** Lookups still running, so a row may yet leave Working. */
    pending: () => [...prs.values(), ...byUrl.values()].filter((entry) => entry.pending).length,
    /** Forgets branches, pull requests and transcripts no session asked about since the last sweep. */
    sweep() {
      sweep(prs, used);
      sweep(byUrl, usedUrls);
      opened.sweep();
    },
    /** Drops lookups not started yet, so `gh` stops once nobody is watching; they queue again when asked for. */
    cancel() {
      for (const job of queue.splice(0)) {
        const entry = prs.get(job.key);
        if (entry) prs.set(job.key, { ...entry, pending: false });
      }
      for (const url of waiting.splice(0)) {
        const entry = byUrl.get(url);
        if (entry) byUrl.set(url, { ...entry, pending: false });
      }
    },
  };
}

const authoredQuery = `query {
  search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { ${pullFields} } }
  }
}`;

/** Open pull requests from the GitHub search behind `authoredQuery`. */
export function parseAuthoredPullRequests(output: string): PullRequest[] {
  const nodes = (JSON.parse(output) as { data: { search: { nodes: PullNode[] } } }).data.search.nodes;
  return nodes.flatMap((node) => parsePullNode(node) ?? []);
}

/**
 * Sessions with their git and GitHub state. Session rows are read on every refresh; uncommitted counts
 * and pull requests come from caches filled in the background, so a slow `gh` never holds up the page.
 */
export function dashboardData({
  discover = (() => {
    const discover = discovery();
    return () => discover({ kitty: false });
  })(),
  exec = run,
  statusAge = 10_000,
  historyAge = 30_000,
  historySpan = 6 * 60 * 60_000,
  ...options
}: {
  discover?: () => Promise<Discovered>;
  statusAge?: number;
  /** At least this long between history samples; one refresh adds at most one. */
  historyAge?: number;
  /** How much history to keep. */
  historySpan?: number;
} & PullRequestOptions = {}) {
  const changes = new Map<string, Cached<number>>();
  const used = new Set<string>();
  const activity = new Map<string, { at: number; samples: number[] }>();
  const history: HistorySample[] = [];
  const mostSamples = Math.min(1440, Math.max(2, Math.ceil(historySpan / Math.max(historyAge, 1)) + 1));
  let sampledAt = 0;
  const prs = pullRequests({ exec, ...options });

  // Every open pull request you authored, looked up in the background at most once per `prAge`.
  const authored: Cached<PullRequest[]> = { checkedAt: 0, pending: false };
  const searchAuthored = () => {
    if (!prs.gh || authored.pending || Date.now() - authored.checkedAt < (options.prAge ?? 60_000)) return;
    authored.pending = true;
    exec(["gh", "api", "graphql", "-f", `query=${authoredQuery}`], homedir())
      .then(
        (output) => (authored.value = parseAuthoredPullRequests(output)),
        () => {},
      )
      .finally(() => {
        authored.checkedAt = Date.now();
        authored.pending = false;
      });
  };
  const countChanges = (root: string) => {
    used.add(root);
    if (fresh(changes, root, statusAge)) return;
    changes.set(root, { ...(changes.get(root) ?? { checkedAt: 0 }), pending: true });
    exec([...changedFiles], root).then(
      (output) => store(changes, root, output.split("\n").filter(Boolean).length, true),
      () => store(changes, root, undefined, false),
    );
  };

  const row = (session: Session, parent: Session | undefined): DashboardRow => {
    const directory = sessionDirectory(session);
    const root = checkout(directory);
    if (root) countChanges(root);
    const found = prs.of(session);
    return {
      id: sessionIdentity(session),
      parent: parent ? sessionIdentity(parent) : undefined,
      title: sessionTitle(session),
      agent: agentName(session.agent),
      activity: session.activity,
      lifecycle: session.lifecycle,
      project: projectName(directory),
      worktree: directory === homedir() ? "~" : basename(directory),
      branch: root ? gitBranch(directory) : undefined,
      lastActiveAt: session.lastActiveAt,
      startedAt: session.startedAt,
      changes: root ? changes.get(root)?.value : undefined,
      prs: found,
      stage: stageOf(found[0]),
      workingSamples: [],
    };
  };

  /** Open pull requests by stage, drafts kept apart, from sessions and the authored search alike. */
  const prCounts = (rows: readonly DashboardRow[], authoredPrs: readonly PullRequest[]) => {
    const counts: HistorySample["prs"] = { failing: 0, checks: 0, green: 0, draft: 0 };
    const open = new Map<string, PullRequest>();
    for (const pr of [...authoredPrs, ...rows.flatMap((row) => row.prs)])
      if (pr.state === "OPEN") open.set(pr.url.toLowerCase(), pr);
    for (const pr of open.values()) {
      if (pr.draft) {
        counts.draft++;
        continue;
      }
      switch (stageOf(pr)) {
        case "failing":
          counts.failing++;
          break;
        case "checks":
          counts.checks++;
          break;
        case "green":
          counts.green++;
          break;
        case "working":
        case "done":
          break;
      }
    }
    return counts;
  };

  return async (): Promise<DashboardSnapshot> => {
    const { sessions, problem } = await discover();
    const live = sessions.filter((session) => session.place.kind !== "cloud");
    const parents = sessionParents(live);
    const rows = live.map((session) => row(session, parents.get(session)));
    const now = Date.now();
    // Keep each lane's recent activity, so it can draw when the session was working.
    const seen = new Set<string>();
    for (const current of rows) {
      seen.add(current.id);
      const entry = activity.get(current.id) ?? { at: 0, samples: [] };
      if (now - entry.at >= historyAge) {
        entry.samples.push(current.activity === "working" && !current.lifecycle ? 1 : 0);
        if (entry.samples.length > mostSamples) entry.samples.splice(0, entry.samples.length - mostSamples);
        entry.at = now;
      }
      activity.set(current.id, entry);
      current.workingSamples = [...entry.samples];
    }
    for (const id of activity.keys()) if (!seen.has(id)) activity.delete(id);
    const authoredPrs = authored.value ?? [];
    if (now - sampledAt >= historyAge) {
      const count = (state: Activity) => rows.filter((row) => !row.lifecycle && row.activity === state).length;
      history.push({
        at: now,
        working: count("working"),
        waiting: count("waiting"),
        idle: rows.filter((row) => row.lifecycle || !row.activity || row.activity === "idle").length,
        prs: prCounts(rows, authoredPrs),
      });
      if (history.length > mostSamples) history.splice(0, history.length - mostSamples);
      const oldest = now - historySpan;
      while (history[0] && history[0].at < oldest) history.shift();
      sampledAt = now;
    }
    searchAuthored();
    // Forget checkouts and branches no session works in any more.
    sweep(changes, used);
    prs.sweep();
    return {
      updatedAt: now,
      problem: [problem, prs.gh ? "" : "Install the GitHub CLI (gh) to see pull requests"].filter(Boolean).join(" · "),
      checking: prs.pending() + (authored.pending ? 1 : 0),
      rows,
      openPrs: authoredPrs,
      history: [...history],
    };
  };
}

export function dashboardOptions(args: readonly string[]) {
  let port = 7438;
  let open = false;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case "--port":
        port = parsePort(args[++index]);
        break;
      case "--open":
        open = true;
        break;
      default:
        throw new Error("usage: kiln dashboard [--port 7438] [--open]");
    }
  }
  return { port, open };
}

/** Requests must name this server by its loopback address, so a page on another site cannot reach it by DNS rebinding. */
function localHost(request: Request, port: number): boolean {
  const host = request.headers.get("Host");
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * `kiln dashboard`: a page on 127.0.0.1 showing every session's progress, streamed over server-sent events.
 * It has no pairing and is never put behind the phone tunnel.
 */
export function startDashboard({
  port,
  interval = 2_000,
  ...options
}: { port: number; interval?: number } & Parameters<typeof dashboardData>[0]) {
  const snapshot = dashboardData(options);
  const clients = new Set<ReadableStreamDefaultController<string>>();
  let current = "";
  let refreshing = false;
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      current = JSON.stringify(await snapshot());
    } catch {
      current = JSON.stringify({
        updatedAt: Date.now(),
        problem: "Session discovery unavailable",
        checking: 0,
        rows: [],
        openPrs: [],
        history: [],
      });
    } finally {
      refreshing = false;
    }
    for (const client of clients) send(client);
  };
  const send = (client: ReadableStreamDefaultController<string>) => {
    try {
      client.enqueue(`data: ${current}\n\n`);
    } catch {
      clients.delete(client);
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch(request) {
      if (!localHost(request, server.port ?? port)) return new Response("Forbidden\n", { status: 403, headers });
      if (request.method !== "GET") return new Response("Method not allowed\n", { status: 405, headers });
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(page, {
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
          },
        });
      if (path === "/v1/events") {
        let self: ReadableStreamDefaultController<string> | undefined;
        const stream = new ReadableStream<string>({
          start(controller) {
            self = controller;
            clients.add(controller);
            if (current) send(controller);
            void refresh();
          },
          cancel() {
            if (self) clients.delete(self);
          },
        });
        return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream" } });
      }
      return new Response("Not found\n", { status: 404, headers });
    },
  });
  // Discovery starts provider CLIs, so it runs only while a page is open; each refresh also picks up finished background lookups.
  const timer = setInterval(() => {
    if (clients.size) void refresh();
  }, interval);
  void refresh();
  return {
    port: server.port,
    stop() {
      clearInterval(timer);
      for (const client of clients) client.close();
      server.stop(true);
    },
  };
}
