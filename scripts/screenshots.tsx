/**
 * Render the README screenshots from the real UI with demo sessions.
 *
 *   bun scripts/screenshots.tsx 2>/dev/null   # React warns about act(), which only a test runner needs
 *
 * OpenTUI's test renderer draws the App off-screen; each captured frame becomes
 * an SVG of its cells, and rsvg-convert turns that into assets/<name>.png.
 * The fonts are JetBrains Mono where installed, else any monospace.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedFrame, RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/app";
import { nestSessions, type Session } from "../src/sessions";
import { defaults } from "../src/settings";

const cols = 92;
const rows = 13;
const cell = { width: 9, height: 20 };
const pad = 20;
const background = "#121113";
const out = join(import.meta.dir, "..", "assets");
const scratch = mkdtempSync(join(tmpdir(), "kiln-shots-"));

const minutes = (count: number) => Date.now() - count * 60_000;
const code = (repo: string) => join(homedir(), "code", repo);
const kiln = (name: string) => ({ kind: "kiln", name }) as const;

const demo: Session[] = [
  {
    pid: 101,
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
    agent: "claude",
    cwd: code("blog"),
    lastActiveAt: minutes(2),
    startedAt: minutes(190),
    activity: "idle",
    branch: "draft/terminal-tools",
    place: { kind: "kitty", socket: "@kitty-1", windowId: 3 },
  },
  {
    pid: 105,
    parentSessionPid: 102,
    agent: "claude",
    cwd: code("kiln"),
    lastActiveAt: minutes(2),
    startedAt: minutes(64),
    activity: "waiting",
    branch: "main",
    place: { kind: "elsewhere", source: "pid 105 · spawned by codex (102)" },
  },
  {
    agent: "codex",
    cwd: join(homedir(), ".worktrees", "atlas", "search-index"),
    lastActiveAt: minutes(2),
    startedAt: minutes(1500),
    activity: "idle",
    branch: "feat/search-index",
    place: { kind: "background", id: "01a0f1ac", attach: [] },
  },
  {
    agent: "codex",
    cwd: homedir(),
    lastActiveAt: minutes(2),
    startedAt: minutes(12),
    activity: "waiting",
    place: { kind: "cloud", id: "task_demo", title: "atlas: update search index" },
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
    <App initialSettings={defaults} onQuit={() => {}} loadSessions={async () => nestSessions(demo)} />,
    {
      width: cols,
      height: rows,
    },
  );
  await setup.waitForFrame((frame) => frame.includes("atlas"));
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

await shoot("list", ["j"]);
await shoot("unavailable", ["j", "j"]);
await shoot("archive", ["j", "j", "j", "j", "j", "x"]);
await shoot("new", ["n", "l"]);
process.exit(0);
