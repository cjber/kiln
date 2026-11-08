import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Ledger } from "./edits";
import { EditsView } from "./edits-view";
import type { Session } from "./sessions";

const file = "/nowhere/repo/a.ts";
const claude: Session = {
  agent: "claude",
  id: "c1",
  cwd: "/nowhere/repo",
  startedAt: 0,
  place: { kind: "kiln", name: "c" },
  title: "Tidy",
};
const codex: Session = {
  agent: "codex",
  id: "x1",
  cwd: "/nowhere/repo",
  startedAt: 0,
  place: { kind: "kiln", name: "x" },
};

async function render(ledgers: Map<Session, Ledger>, text: () => string, follow = false) {
  const asked: { to: string; body: string }[] = [];
  const setup = await testRender(
    <EditsView
      session={claude}
      sessions={[claude, codex]}
      read={(session) => ledgers.get(session) as Ledger}
      readText={text}
      follow={follow}
      ask={async (to, body) => {
        asked.push({ to: to.id ?? "", body });
        return "asked";
      }}
      onBack={() => {}}
    />,
    { width: 80, height: 12 },
  );
  return { setup, asked };
}

test("opens a turn's file at its first change, names the writer and asks it about selected lines", async () => {
  const ledgers = new Map<Session, Ledger>([
    [
      claude,
      {
        turns: [{ prompt: "rename b", at: Date.now() - 60_000 }],
        edits: [
          {
            id: "e1",
            at: Date.now() - 60_000,
            file,
            change: "update",
            turn: 0,
            hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] }],
          },
        ],
      },
    ],
    [
      codex,
      {
        turns: [{ prompt: "add d" }],
        edits: [
          {
            id: "x",
            at: Date.now() - 30_000,
            file,
            change: "update",
            turn: 0,
            hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [" c", "+d"] }],
          },
        ],
      },
    ],
  ]);
  const { setup, asked } = await render(ledgers, () => "a\nB\nc\nd\n");
  try {
    await setup.waitForFrame((frame) => frame.includes("rename b") && frame.includes("1 file +1 -1"));
    await act(async () => {
      await setup.mockInput.pressKey("\r");
    });
    await setup.waitForFrame((frame) => frame.includes("claude:c1 · 1m · rename b") && frame.includes("also codex:x1"));
    // The next change is Codex's line; asking about it goes to Codex.
    await act(async () => {
      await setup.mockInput.pressKey("]");
    });
    await setup.waitForFrame((frame) => frame.includes("codex:x1 · 30s · add d"));
    await act(async () => {
      await setup.mockInput.pressKey("a");
      await setup.mockInput.typeText("why?");
      await setup.mockInput.pressKey("\r");
    });
    await setup.waitForFrame((frame) => frame.includes("asked"));
    expect(asked).toEqual([{ to: "x1", body: `About ${file} line 4, which you wrote:\n\n\`\`\`\nd\n\`\`\`\n\nwhy?` }]);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("follow opens the newest edit as it is made", async () => {
  const ledger: Ledger = { turns: [{ prompt: "go" }], edits: [] };
  let text = "one\n";
  const { setup } = await render(
    new Map([
      [claude, ledger],
      [codex, { turns: [], edits: [] }],
    ]),
    () => text,
    true,
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("no edits yet"));
    ledger.edits.push({
      id: "n",
      at: Date.now(),
      file,
      change: "update",
      turn: 0,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" one", "+two"] }],
    });
    text = "one\ntwo\n";
    // The view reads again on its two-second beat.
    await act(async () => {
      await Bun.sleep(2_100);
    });
    await setup.waitForFrame((frame) => frame.includes("following") && frame.includes("two"));
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
