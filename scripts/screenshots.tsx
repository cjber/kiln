/**
 * Render the README screenshots from the real UI with demo sessions.
 *
 *   bun scripts/screenshots.tsx 2>/dev/null   # React warns about act(), which only a test runner needs
 *
 * OpenTUI's test renderer draws the App off-screen; each captured frame becomes
 * an SVG of its cells, and rsvg-convert turns that into assets/<name>.png.
 * The fonts are JetBrains Mono where installed, else any monospace.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedFrame, RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/app";
import type { DashboardRow, DashboardSnapshot, PullRequest } from "../src/dashboard";
import { nestSessions, type Session } from "../src/sessions";
import { defaults } from "../src/settings";
import type { Skill } from "../src/skills";
import { SkillsView } from "../src/skills-view";

const cols = 92;
const rows = 14;
const cell = { width: 9, height: 20 };
const pad = 20;
const background = "#121113";
const out = join(import.meta.dir, "..", "assets");
const scratch = mkdtempSync(join(tmpdir(), "kiln-shots-"));
const demoSkills: Skill[] = [
  { name: "deploy", directory: ".agents/skills/deploy", external: false, claude: "shared", pi: "shared" },
  { name: "review", directory: ".agents/skills/review", external: false, claude: "conflict", pi: "missing" },
];

// Freeze the fixture clock so elapsed labels and detail timestamps are reproducible.
Date.now = () => 1_800_000_000_000;
const minutes = (count: number) => Date.now() - count * 60_000;
const code = (repo: string) => join(homedir(), "code", repo);
const kiln = (name: string) => ({ kind: "kiln", name }) as const;

const demo: Session[] = [
  {
    pid: 101,
    title: "Cache map tiles",
    agent: "claude",
    cwd: code("atlas"),
    lastActiveAt: minutes(2),
    startedAt: minutes(42),
    activity: "working",
    branch: "feat/tile-cache",
    place: kiln("a"),
  },
  {
    pid: 102,
    title: "Fix retry backoff",
    agent: "codex",
    cwd: code("atlas"),
    lastActiveAt: minutes(2),
    startedAt: minutes(18),
    activity: "waiting",
    branch: "fix/retry-backoff",
    place: kiln("b"),
  },
  {
    pid: 103,
    title: "Update shell bindings",
    agent: "pi",
    cwd: code("dotfiles"),
    lastActiveAt: minutes(2),
    startedAt: minutes(7),
    activity: "working",
    branch: "main",
    place: kiln("c"),
  },
  {
    pid: 104,
    title: "Draft terminal tools post",
    agent: "opencode",
    cwd: code("blog"),
    lastActiveAt: minutes(2),
    startedAt: minutes(190),
    activity: "idle",
    branch: "draft/terminal-tools",
    place: kiln("d"),
  },
  {
    pid: 105,
    title: "Review the retry fix",
    parentSessionPid: 102,
    agent: "claude",
    cwd: code("kiln"),
    lastActiveAt: minutes(2),
    startedAt: minutes(64),
    activity: "waiting",
    branch: "main",
    place: kiln("e"),
  },
  {
    agent: "codex",
    cwd: join(homedir(), ".worktrees", "atlas", "search-index"),
    lastActiveAt: minutes(2),
    startedAt: minutes(1500),
    activity: "idle",
    branch: "feat/search-index",
    place: kiln("01a0f1ac"),
  },
  {
    agent: "codex",
    cwd: homedir(),
    lastActiveAt: minutes(2),
    startedAt: minutes(12),
    activity: "waiting",
    place: { kind: "cloud", id: "task_demo", title: "atlas: update search index" },
  },
  {
    agent: "claude",
    cwd: homedir(),
    startedAt: minutes(24),
    activity: "idle",
    place: { kind: "cloud", id: "cse_demo", title: "atlas: check release changes" },
  },
  {
    agent: "claude",
    title: "Summarise release notes",
    cwd: code("blog"),
    lastActiveAt: minutes(300),
    startedAt: minutes(320),
    lifecycle: "completed",
    place: { kind: "job", id: "0b276145", attach: ["claude", "attach", "0b276145"] },
  },
];

const hex = (color: RGBA) =>
  `#${color
    .toInts()
    .slice(0, 3)
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svg(frame: CapturedFrame): string {
  const width = cols * cell.width + pad * 2;
  const height = rows * cell.height + pad * 2;
  const shapes: string[] = [];
  frame.lines.forEach((line, row) => {
    let col = 0;
    const y = pad + row * cell.height;
    for (const span of line.spans) {
      const x = pad + col * cell.width;
      const fill = hex(span.bg);
      if (span.bg.a > 0 && fill !== background) {
        shapes.push(
          `<rect x="${x}" y="${y}" width="${span.width * cell.width}" height="${cell.height}" fill="${fill}"/>`,
        );
      }
      if (span.text.trim()) {
        const weight = span.attributes & 1 ? ' font-weight="bold"' : "";
        shapes.push(
          `<text x="${x}" y="${y + 15}" fill="${hex(span.fg)}"${weight} xml:space="preserve">${escapeXml(span.text)}</text>`,
        );
      }
      col += span.width;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="JetBrainsMono Nerd Font Mono, JetBrains Mono, monospace" font-size="15">
<rect width="100%" height="100%" rx="10" fill="${background}"/>
${shapes.join("\n")}
</svg>
`;
}

async function shoot(name: string, keys: string[]): Promise<void> {
  const setup = await testRender(
    name === "skills" ? (
      <SkillsView project={code("atlas")} onBack={() => {}} edit={async () => {}} loadSkills={() => demoSkills} />
    ) : (
      <App
        initialSettings={defaults}
        onQuit={() => {}}
        loadSessions={async () =>
          nestSessions(
            name === "unavailable"
              ? demo.map((session, index) => (index ? session : { ...session, activity: undefined }))
              : demo,
          )
        }
      />
    ),
    {
      width: cols,
      height: rows,
    },
  );
  await setup.waitForFrame((frame) => frame.includes(name === "skills" ? "kiln skills" : "atlas"));
  for (const key of keys) await setup.mockInput.pressKey(key);
  await setup.flush();
  const path = join(scratch, `${name}.svg`);
  await Bun.write(path, svg(setup.captureSpans()));
  setup.renderer.destroy();
  const png = Bun.spawnSync(["rsvg-convert", "--zoom", "2", "-o", join(out, `${name}.png`), path], {
    stderr: "inherit",
  });
  if (png.exitCode !== 0) throw new Error(`rsvg-convert failed for ${name}`);
  console.log(`assets/${name}.png`);
}

async function shootDashboard(): Promise<void> {
  const now = Date.now();
  const minutesAgo = (minutes: number) => now - minutes * 60_000;
  const pull = (
    repository: string,
    number: number,
    mode: "green" | "checks" | "failing" | "draft" | "done",
  ): PullRequest => ({
    number,
    url: `https://github.com/cjber/${repository}/pull/${number}`,
    state: mode === "done" ? "MERGED" : "OPEN",
    draft: mode === "draft",
    additions: 84,
    deletions: 17,
    queued: false,
    checks: {
      passed: mode === "failing" ? 2 : 4,
      failed: mode === "failing" ? 1 : 0,
      running: mode === "checks" ? 2 : 0,
    },
    repository,
  });
  const samples = (activity: Session["activity"]) =>
    Array.from({ length: 120 }, (_, index) => {
      switch (activity) {
        case "working":
          return index % 9 < 7 ? 1 : 0;
        case "waiting":
          return index % 11 < 3 ? 1 : 0;
        case "idle":
          return index % 20 < 2 ? 1 : 0;
        default:
          return 0;
      }
    });
  const row = (
    id: string,
    title: string,
    agent: string,
    activity: Session["activity"],
    project: string,
    worktree: string,
    options: {
      parent?: string;
      stage?: DashboardRow["stage"];
      prs?: PullRequest[];
      changes?: number;
      lastActiveAt?: number;
      startedAt?: number;
      lifecycle?: DashboardRow["lifecycle"];
      branch?: string;
    } = {},
  ): DashboardRow => ({
    id,
    parent: options.parent,
    title,
    agent,
    activity,
    lifecycle: options.lifecycle,
    project,
    worktree,
    branch: options.branch,
    lastActiveAt: options.lastActiveAt ?? minutesAgo(1),
    startedAt: options.startedAt ?? minutesAgo(38),
    changes: options.changes,
    prs: options.prs ?? [],
    stage: options.stage ?? "working",
    workingSamples: samples(activity),
  });

  const releases = row(
    "claude:addon-releases",
    "Addon releases, quest XP, asset rules",
    "Claude",
    "working",
    "tweaks-forever",
    "tweaks-forever",
    { changes: 3, lastActiveAt: minutesAgo(0), startedAt: minutesAgo(46), branch: "cb/addon-releases" },
  );
  const aura = row(
    "claude:hunter-aura",
    "Hunter aspect WeakAura",
    "Claude",
    "waiting",
    "tweaks-forever",
    "tweaks-forever",
    {
      stage: "checks",
      prs: [pull("tweaks-forever", 412, "checks")],
      changes: 6,
      lastActiveAt: minutesAgo(4),
      startedAt: minutesAgo(22),
      branch: "cb/hunter-aspect",
    },
  );
  const rows: DashboardRow[] = [
    releases,
    row("opencode:quest-xp", "Quest XP on the XP bar", "OpenCode", "working", "tweaks-forever", "tweaks-quest-xp", {
      parent: releases.id,
      changes: 19,
    }),
    row("opencode:asset-age", "Pre-Legion asset age check", "OpenCode", "working", "forever-core", "core-asset-age", {
      parent: releases.id,
      changes: 4,
    }),
    row(
      "opencode:minimap-button",
      "Minimap button replaces micro button",
      "OpenCode",
      "working",
      "forever-core",
      "core-minimap-button",
      { parent: releases.id, stage: "checks", prs: [pull("forever-core", 388, "checks")], changes: 7 },
    ),
    row("claude:release-notes", "SPF 1.22.36 · AGF 1.1.0 · FGF 0.3.37", "Claude", "idle", "forever-core", "main", {
      parent: releases.id,
      stage: "done",
      prs: [pull("forever-core", 381, "done")],
      changes: 0,
      lastActiveAt: minutesAgo(9),
    }),
    aura,
    row(
      "opencode:nameplates",
      "Nameplate arrows, micro glyph",
      "OpenCode",
      "working",
      "adventure-guide-forever",
      "agf-410-411",
      { parent: aura.id, changes: 17 },
    ),
    row(
      "opencode:journal",
      "Journal filter, tier frame recolour",
      "OpenCode",
      "waiting",
      "field-guide-forever",
      "fgf-tier-frame",
      { parent: aura.id, changes: 41 },
    ),
  ];

  const nebula = [
    ["Fix the tray icon", "working", 0, undefined],
    ["Land the share sheet", "waiting", 1, pull("nebula", 224, "green")],
    ["Reduce the cold start", "working", 2, pull("nebula", 221, "green")],
    ["Tidy the settings copy", "idle", 3, pull("nebula", 219, "checks")],
    ["Reconnect after sleep", "idle", 4, undefined],
  ] as const;
  for (const [title, activity, index, pr] of nebula)
    rows.push(
      row(`claude:nebula-${index}`, title, "Claude", activity, "nebula", `nebula-${index}`, {
        stage: pr ? "green" : "working",
        prs: pr ? [pr] : [],
        changes: 2 + (index ?? 0) * 3,
        lastActiveAt: minutesAgo(8 + index * 4),
      }),
    );
  rows.push(
    row("codex:desktop", "Window chrome follows the system", "Codex", "waiting", "nebula-desktop", "desktop-chrome", {
      changes: 11,
      lastActiveAt: minutesAgo(12),
    }),
    row("opencode:mobile", "Offline queue for messages", "OpenCode", "working", "nebula-mobile", "mobile-queue", {
      changes: 8,
    }),
    row("pi:skills", "Refresh the shared skill list", "Pi", "idle", "skills", "skills-store", {
      changes: 1,
      lastActiveAt: minutesAgo(74),
      startedAt: minutesAgo(96),
    }),
  );

  const history = Array.from({ length: 73 }, (_, index) => {
    const working = Math.max(1, Math.round(4 + 1.8 * Math.sin(index / 5) + (index > 54 ? 1 : 0)));
    const waiting = Math.max(0, Math.round(1 + Math.sin(index / 7) + (index % 17 === 0 ? 1 : 0)));
    return {
      at: now - (72 - index) * 5 * 60_000,
      working,
      waiting,
      idle: Math.max(0, 9 - working - waiting),
      prs: { failing: index % 19 === 0 ? 1 : 0, checks: 3, green: 2, draft: 1 },
    };
  });
  const snapshot: DashboardSnapshot = {
    updatedAt: now,
    problem: "",
    checking: 0,
    rows,
    openPrs: [pull("tweaks-forever", 412, "checks"), pull("forever-core", 388, "checks")],
    history,
  };

  const page = readFileSync(join(import.meta.dir, "..", "src", "dashboard.html"), "utf8");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(page, {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
        });
      if (path === "/v1/events") {
        const stream = new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify(snapshot)}\n\n`);
          },
        });
        return new Response(stream, { headers: { "Cache-Control": "no-store", "Content-Type": "text/event-stream" } });
      }
      return new Response("Not found\n", { status: 404 });
    },
  });
  try {
    const chrome = ["google-chrome-stable", "google-chrome", "chromium"].map((name) => Bun.which(name)).find(Boolean);
    if (!chrome) {
      console.log("skipped assets/dashboard.png: Chrome is not installed");
      return;
    }
    const output = join(out, "dashboard.png");
    const profile = join(scratch, "chrome");
    const browser = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        "--force-dark-mode",
        "--window-size=1000,1500",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${server.port}/`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      let port = 0;
      for (let tries = 0; tries < 100 && !port; tries++) {
        try {
          port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
        } catch {
          await Bun.sleep(50);
        }
      }
      if (!port) throw new Error("Chrome did not open its debug port");
      let target: { webSocketDebuggerUrl?: string } | undefined;
      for (let tries = 0; tries < 100 && !target; tries++) {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }[];
        target = targets.find((entry) => entry.type === "page" && entry.url.startsWith("http://127.0.0.1"));
        if (!target) await Bun.sleep(50);
      }
      if (!target?.webSocketDebuggerUrl) throw new Error("Chrome opened no dashboard page");
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Chrome debug socket failed"));
      });
      const waiting = new Map<number, (message: { result?: Record<string, unknown> }) => void>();
      let next = 0;
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> };
        if (message.id !== undefined) waiting.get(message.id)?.(message);
        if (message.id !== undefined) waiting.delete(message.id);
      };
      const send = (method: string, params: object = {}) =>
        new Promise<{ result?: Record<string, unknown> }>((resolve) => {
          const id = ++next;
          waiting.set(id, resolve);
          socket.send(JSON.stringify({ id, method, params }));
        });
      // The first event stream frame draws the cards; wait for it before taking the picture.
      for (let tries = 0; tries < 100; tries++) {
        const evaluated = await send("Runtime.evaluate", {
          expression: "document.querySelectorAll('.card').length",
          returnByValue: true,
        });
        const result = evaluated.result as { result?: { value?: number } } | undefined;
        if ((result?.result?.value ?? 0) > 0) break;
        await Bun.sleep(50);
      }
      await Bun.sleep(250);
      const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const data = (shot.result as { data?: string } | undefined)?.data;
      if (!data) throw new Error("Chrome captured no dashboard image");
      await Bun.write(output, Buffer.from(data, "base64"));
      socket.close();
    } finally {
      browser.kill();
      await browser.exited;
    }
    console.log("assets/dashboard.png");
  } finally {
    server.stop(true);
  }
}

await shoot("list", ["j"]);
await shoot("unavailable", []);
await shoot("archive", ["j", "j", "j", "j", "j", "j", "x"]);
await shoot("new", ["n", "l"]);
await shoot("skills", ["p"]);
await shootDashboard();
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
