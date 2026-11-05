import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DashboardSnapshot,
  parseAuthoredPullRequests,
  parsePullRequest,
  projectName,
  pullRequests,
  stageOf,
  startDashboard,
} from "./dashboard";
import type { Session } from "./sessions";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const run = (name: string, conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});
const pr = (state: string, checks: object[], labels: string[] = []) => ({
  number: 7,
  url: "https://github.com/cjber/kiln/pull/7",
  state,
  isDraft: false,
  additions: 12,
  deletions: 3,
  labels: labels.map((name) => ({ name })),
  statusCheckRollup: checks,
});

test.each([
  ["no pull request", [], "working"],
  ["a merged pull request", [pr("MERGED", [run("ci", "FAILURE")])], "done"],
  ["a closed pull request", [pr("CLOSED", [])], "working"],
  ["an open one with a check running", [pr("OPEN", [run("ci", "SUCCESS"), run("e2e", null, "IN_PROGRESS")])], "checks"],
  ["an open one with a failed check", [pr("OPEN", [run("ci", "TIMED_OUT"), run("e2e", null, "QUEUED")])], "failing"],
  ["an open one with a failed status", [pr("OPEN", [{ __typename: "StatusContext", state: "ERROR" }])], "failing"],
  ["an open one all green", [pr("OPEN", [run("ci", "SUCCESS"), run("lint", "SKIPPED")])], "green"],
  ["the open one over an older merged one", [pr("OPEN", [run("ci", "SUCCESS")]), pr("MERGED", [])], "green"],
] as const)("%s sets the stage", (_, found, stage) => {
  expect(stageOf(parsePullRequest(JSON.stringify(found), "mergepatrol"))).toBe(stage);
});

test("a pull request reports its counts and the repository's queue label", () => {
  const parsed = parsePullRequest(
    JSON.stringify([pr("OPEN", [run("ci", "SUCCESS"), run("e2e", "FAILURE")], ["land"])]),
    "land",
  );
  expect(parsed).toMatchObject({ additions: 12, deletions: 3, queued: true, checks: { passed: 1, failed: 1 } });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "kiln-dashboard-test-"));
  directories.push(root);
  const main = join(root, "kiln");
  mkdirSync(join(main, ".git", "worktrees", "feature"), { recursive: true });
  writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(main, ".git", "worktrees", "feature", "HEAD"), "ref: refs/heads/cb/feature\n");
  writeFileSync(join(main, ".git", "worktrees", "feature", "commondir"), "../..\n");
  const worktree = join(root, "worktrees", "kiln-feature");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
  return { root, main, worktree };
}

/** A GraphQL pull request node, as `pullFields` asks for it. */
const node = (url: string, checks: object[], extra: object = {}) => ({
  number: Number(url.split("/").at(-1)),
  url,
  state: "OPEN",
  isDraft: false,
  additions: 2,
  deletions: 1,
  mergeable: "MERGEABLE",
  headRefOid: "abc123",
  labels: { nodes: [{ name: "mergepatrol" }] },
  reviews: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
  ...extra,
});

const authored = {
  data: {
    search: {
      nodes: [
        node("https://github.com/o/other/pull/7", [{ __typename: "StatusContext", context: "ci", state: "FAILURE" }]),
        {},
      ],
    },
  },
};

test("open pull requests without a session come from one GitHub search", () => {
  expect(parseAuthoredPullRequests(JSON.stringify(authored))).toEqual([
    {
      number: 7,
      url: "https://github.com/o/other/pull/7",
      state: "OPEN",
      draft: false,
      additions: 2,
      deletions: 1,
      queued: true,
      checks: { passed: 0, failed: 1, running: 0 },
      repository: "other",
      head: "abc123",
      mergeable: "MERGEABLE",
      failedChecks: ["ci"],
      reviews: 0,
      review: undefined,
    },
  ]);
});

test("a linked worktree counts as its repository's project", () => {
  const { main, worktree } = repository();
  expect(projectName(join(worktree, "src"))).toBe("kiln");
  expect(projectName(main)).toBe("kiln");
});

test("the server streams sessions with their pull requests and answers only to its loopback name", async () => {
  const { worktree } = repository();
  // A repository with its own queue label: only the branch lookup reads it.
  mkdirSync(join(worktree, ".mergepatrol"));
  writeFileSync(join(worktree, ".mergepatrol", "mergepatrol.yml"), "label: land\n");
  const session: Session = {
    agent: "claude",
    id: "a1",
    title: "Ship it",
    cwd: worktree,
    startedAt: 1,
    place: { kind: "kiln", name: "k" },
  };
  const calls: string[][] = [];
  const dashboard = startDashboard({
    port: 0,
    interval: 50,
    gh: true,
    discover: async () => ({ sessions: [session], problem: "", stale: false }),
    exec: async (argv) => {
      calls.push(argv);
      if (argv[0] === "git") return " M src/a.ts\n?? b.ts\n";
      if (argv[2] === "graphql" && argv[4]?.includes("search(")) return JSON.stringify(authored);
      if (argv[2] === "graphql")
        return JSON.stringify({
          data: {
            p0: node("https://github.com/cjber/kiln/pull/7", [run("ci", null, "IN_PROGRESS")], {
              labels: { nodes: [{ name: "land" }] },
            }),
          },
        });
      return JSON.stringify([pr("OPEN", [run("ci", null, "IN_PROGRESS")], ["land"])]);
    },
  });
  try {
    const origin = `http://127.0.0.1:${dashboard.port}`;
    const page = await fetch(`${origin}/`);
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("EventSource");
    expect((await fetch(`${origin}/`, { headers: { Host: `attacker.example:${dashboard.port}` } })).status).toBe(403);

    const events = await fetch(`${origin}/v1/events`);
    const reader = events.body?.pipeThrough(new TextDecoderStream()).getReader();
    let row: DashboardSnapshot["rows"][number] | undefined;
    let openPrs: DashboardSnapshot["openPrs"] = [];
    for (let buffer = ""; !row?.prs[0]?.head || !openPrs.length; ) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) throw new Error("stream ended");
      buffer += chunk.value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const snapshot = JSON.parse(frame.replace(/^data: /, "")) as DashboardSnapshot;
        row = snapshot.rows[0];
        openPrs = snapshot.openPrs;
      }
    }
    expect(openPrs.map((pr) => pr.repository)).toEqual(["other"]);
    await reader?.cancel();
    expect(row).toMatchObject({ project: "kiln", branch: "cb/feature", changes: 2, stage: "checks" });
    expect(row.prs).toMatchObject([{ number: 7, queued: true, head: "abc123", repository: "kiln" }]);
    // Refreshes every 50 ms reuse the cached answers instead of asking GitHub again.
    expect(calls.filter((argv) => argv[0] === "gh" && argv[1] === "pr")).toHaveLength(1);
    expect(calls.filter((argv) => argv[2] === "graphql")).toHaveLength(2);
  } finally {
    dashboard.stop();
  }
});

test("cancelled pull request lookups that have not started never run", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-prs-"));
  try {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/cb/a\n");
    let finish = () => {};
    const calls: string[] = [];
    const prs = pullRequests({
      gh: true,
      ghSlots: 1,
      exec: (argv) => {
        calls.push(argv[4] ?? "");
        return new Promise((resolve) => (finish = () => resolve("[]")));
      },
    });
    const session = (cwd: string): Session => ({
      id: cwd,
      agent: "claude",
      cwd,
      startedAt: 1,
      place: { kind: "elsewhere" },
    });
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    writeFileSync(join(other, ".git", "HEAD"), "ref: refs/heads/cb/b\n");
    prs.of(session(root));
    prs.of(session(other));
    prs.cancel();
    finish();
    await Bun.sleep(10);
    expect(calls).toEqual(["cb/a"]);
    expect(prs.pending()).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
