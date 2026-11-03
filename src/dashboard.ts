import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import page from "./dashboard.html" with { type: "text" };
import { parsePort } from "./serve";
import { sessionTitle } from "./session-list";
import {
  type Activity,
  agentName,
  type Discovered,
  discovery,
  gitBranch,
  type Lifecycle,
  type Session,
  sessionDirectory,
} from "./sessions";
import { checkout } from "./workdir";

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
};

export type DashboardRow = {
  title: string;
  agent: string;
  activity?: Activity;
  lifecycle?: Lifecycle;
  project: string;
  branch?: string;
  /** Uncommitted files in the session's checkout, once counted. */
  changes?: number;
  pr?: PullRequest;
  stage: Stage;
};

export type DashboardSnapshot = {
  updatedAt: number;
  problem: string;
  /** Pull request lookups still running, so a row may yet leave Working. */
  checking: number;
  rows: DashboardRow[];
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

type CheckEntry = { __typename?: string; status?: string; conclusion?: string; state?: string };

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
  };
}

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
  prAge = 60_000,
  ghSlots = 3,
  gh = Bun.which("gh") !== null,
}: {
  discover?: () => Promise<Discovered>;
  exec?: Run;
  statusAge?: number;
  prAge?: number;
  /** How many `gh` calls may run at once. */
  ghSlots?: number;
  /** The GitHub CLI is installed. */
  gh?: boolean;
} = {}) {
  const changes = new Map<string, Cached<number>>();
  const prs = new Map<string, Cached<PullRequest | undefined>>();
  const queue: { key: string; root: string; branch: string }[] = [];
  let running = 0;

  const fresh = <T>(cache: Map<string, Cached<T>>, key: string, age: number) => {
    const entry = cache.get(key);
    return entry && (entry.pending || Date.now() - entry.checkedAt < age);
  };
  const store = <T>(cache: Map<string, Cached<T>>, key: string, value: T | undefined, ok: boolean) => {
    const last = cache.get(key);
    // A failed lookup keeps the last answer and waits a full period before trying again.
    cache.set(key, { value: ok ? value : last?.value, checkedAt: Date.now(), pending: false });
  };
  const countChanges = (root: string) => {
    if (fresh(changes, root, statusAge)) return;
    changes.set(root, { ...(changes.get(root) ?? { checkedAt: 0 }), pending: true });
    exec(["git", "status", "--porcelain"], root).then(
      (output) => store(changes, root, output.split("\n").filter(Boolean).length, true),
      () => store(changes, root, undefined, false),
    );
  };
  const drain = () => {
    while (running < ghSlots) {
      const job = queue.shift();
      if (!job) return;
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
        .finally(() => {
          running--;
          drain();
        });
    }
  };
  const used = new Set<string>();
  const lookUpPr = (root: string, branch: string) => {
    const key = `${commonGitDir(root)}\0${branch}`;
    used.add(key);
    if (!fresh(prs, key, prAge)) {
      prs.set(key, { ...(prs.get(key) ?? { checkedAt: 0 }), pending: true });
      queue.push({ key, root, branch });
      drain();
    }
    return prs.get(key)?.value;
  };

  const row = (session: Session): DashboardRow => {
    const directory = sessionDirectory(session);
    const root = checkout(directory);
    const branch = root ? gitBranch(directory) : undefined;
    // A default branch is shared by many sessions, so a pull request found for it says nothing about this one.
    const ownBranch = branch && !["main", "master"].includes(branch);
    let pr: PullRequest | undefined;
    if (root) {
      used.add(root);
      countChanges(root);
      if (ownBranch && gh) pr = lookUpPr(root, branch);
    }
    return {
      title: sessionTitle(session),
      agent: agentName(session.agent),
      activity: session.activity,
      lifecycle: session.lifecycle,
      project: projectName(directory),
      branch,
      changes: root ? changes.get(root)?.value : undefined,
      pr,
      stage: stageOf(pr),
    };
  };

  return async (): Promise<DashboardSnapshot> => {
    const { sessions, problem } = await discover();
    used.clear();
    const rows = sessions.filter((session) => session.place.kind !== "cloud").map(row);
    // Forget checkouts and branches no session works in any more; a lookup in flight finishes first.
    for (const cache of [changes, prs] as Map<string, Cached<unknown>>[])
      for (const [key, entry] of cache) if (!used.has(key) && !entry.pending) cache.delete(key);
    return {
      updatedAt: Date.now(),
      problem: [problem, gh ? "" : "Install the GitHub CLI (gh) to see pull requests"].filter(Boolean).join(" · "),
      checking: [...prs.values()].filter((entry) => entry.pending).length,
      rows,
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
