/** Seeded sessions for exploratory QA of the list (`qa-drive.ts`) and the phone app (`qa-phone.ts`). */
import type { Session } from "../src/sessions";

const now = Date.now();
const minute = 60_000;

export const short: Session[] = [
  {
    agent: "codex",
    id: "019a-parent",
    title: "Review changes",
    cwd: "/home/demo/code/atlas",
    branch: "fix/retry-backoff",
    activity: "waiting",
    startedAt: now - 40 * minute,
    lastActiveAt: now - 2 * minute,
    place: { kind: "kiln", name: "parent" },
  },
  {
    agent: "codex",
    id: "019a-child",
    parentSessionId: "019a-parent",
    parentSessionAgent: "codex",
    title: "Check tests",
    cwd: "/home/demo/code/atlas",
    activity: "working",
    startedAt: now - 10 * minute,
    lastActiveAt: now - minute,
    place: { kind: "kiln", name: "child" },
  },
  {
    agent: "claude",
    id: "c1d2",
    title: "Finished task",
    cwd: "/home/demo/code/blog",
    branch: "main",
    activity: "idle",
    startedAt: now - 120 * minute,
    lastActiveAt: now - 30 * minute,
    place: { kind: "kiln", name: "finished" },
  },
  {
    agent: "opencode",
    id: "ses_4f2a",
    title: "Draft terminal tools post",
    cwd: "/home/demo/code/blog",
    activity: "idle",
    opencodeService: true,
    startedAt: now - 300 * minute,
    lastActiveAt: now - 200 * minute,
    place: { kind: "thread", id: "ses_4f2a", attach: ["opencode"] },
  },
  {
    agent: "pi",
    title: "Unknown status",
    pid: 4242,
    cwd: "/home/demo/dotfiles",
    startedAt: now - 5 * minute,
    place: { kind: "kiln", name: "pi" },
  },
  {
    agent: "claude",
    id: "0b276145",
    title: "Background job",
    cwd: "/home/demo/dotfiles",
    lifecycle: "completed",
    startedAt: now - 600 * minute,
    lastActiveAt: now - 500 * minute,
    place: { kind: "job", id: "0b276145", attach: ["claude", "attach", "0b276145"] },
  },
  {
    agent: "claude",
    id: "saved-1",
    title: "Stopped by a restart",
    cwd: "/home/demo/code/kiln",
    lifecycle: "stopped",
    startedAt: now - 2000 * minute,
    place: { kind: "saved" },
  },
];

const agents = ["claude", "codex", "opencode", "pi"] as const;
const titles = [
  "Refactor the session discovery so that every provider reports activity through one shared seam",
  "修复登录页面的布局问题",
  "Ship 🚀 the release notes ✅",
  "",
  "Tab\tand newline\nin a title",
];
export const many: Session[] = Array.from({ length: 60 }, (_, index) => ({
  agent: agents[index % agents.length] ?? "claude",
  id: `many-${index}`,
  title: titles[index % titles.length] || undefined,
  cwd: `/home/demo/code/${index % 3 ? "a-project-with-a-very-long-directory-name/packages/inner" : "kiln"}`,
  workdir: index % 7 === 0 ? `/home/demo/.worktrees/kiln-feature-${index}` : undefined,
  branch: index % 5 === 0 ? `cb/a-branch-name-that-keeps-going-${index}` : "main",
  activity: (["working", "waiting", "idle", undefined] as const)[index % 4],
  startedAt: now - index * 37 * minute,
  lastActiveAt: now - index * 11 * minute,
  place: { kind: "kiln", name: `many-${index}` },
}));

export const seeds: Record<string, Session[]> = { empty: [], short, many };
