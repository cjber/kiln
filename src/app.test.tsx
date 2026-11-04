import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App, ageColor } from "./app";
import type { Session } from "./sessions";
import { defaults } from "./settings";
import { color } from "./tui";

test("the compact task list advances elapsed update time while discovery is stalled", async () => {
  const now = Date.now();
  const sessions: Session[] = [
    {
      agent: "codex",
      cwd: "/tmp/project",
      title: "Fix task discovery",
      startedAt: now,
      lastActiveAt: now - 8_000,
      activity: "working",
      place: { kind: "kiln", name: "task" },
    },
  ];
  const clock = spyOn(Date, "now").mockReturnValue(now);
  let loads = 0;
  let setup!: Awaited<ReturnType<typeof testRender>>;
  try {
    await act(async () => {
      setup = await testRender(
        <App
          initialSettings={{ ...defaults, cloud: false }}
          onQuit={() => {}}
          loadSessions={async () => (++loads === 1 ? sessions : new Promise<Session[]>(() => {}))}
        />,
        { width: 70, height: 12 },
      );
    });
    await setup.waitForFrame((frame) => frame.includes("8s"));
    expect(setup.captureCharFrame()).toContain("Fix task discovery");
    expect(setup.captureCharFrame()).not.toContain("where");
    clock.mockReturnValue(now + 65_000);
    await act(async () => {
      await setup.mockInput.pressKeys(["r"]);
      await Bun.sleep(1_100);
    });
    await setup.waitForFrame((frame) => frame.includes("1m"));
  } finally {
    clock.mockRestore();
    if (setup)
      await act(async () => {
        setup.renderer.destroy();
      });
  }
});

test("the selected session stays visible when a cloud list is taller than the terminal", async () => {
  const sessions: Session[] = Array.from({ length: 25 }, (_, index) => ({
    agent: "claude",
    cwd: "/tmp",
    startedAt: Date.now(),
    place: { kind: "cloud", id: `cse_${index}`, title: `cloud-row-${String(index).padStart(2, "0")}` },
  }));
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <App initialSettings={{ ...defaults, cloud: false }} onQuit={() => {}} loadSessions={async () => sessions} />,
      { width: 90, height: 10 },
    );
  });
  try {
    await setup.waitForFrame((frame) => frame.includes("cloud-row-00"));
    await act(async () => {
      await setup.mockInput.pressKeys(Array(20).fill("j"));
    });
    await setup.waitForFrame((frame) => frame.includes("cloud-row-20"));
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("cloud-row-00");
    expect(frame).toContain("q quit");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("time since latest activity fades from green to grey", () => {
  const now = 10_000_000;
  expect([30, 300, 1_800, 7_200].map((seconds) => ageColor(now - seconds * 1_000, now))).toEqual([
    color.green,
    color.teal,
    color.fgDim,
    color.comment,
  ]);
  expect(ageColor(undefined, now)).toBe(color.comment);
});

async function frameAfter(sessions: Session[], size: { width: number; height: number }, keys: string[], until: string) {
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <App initialSettings={{ ...defaults, cloud: false }} onQuit={() => {}} loadSessions={async () => sessions} />,
      size,
    );
  });
  try {
    await setup.waitForFrame((frame) => frame.includes("kiln"));
    await Bun.sleep(50);
    await act(async () => {
      for (const key of keys) await setup.mockInput.pressKeys([key]);
    });
    await setup.waitForFrame((frame) => frame.includes(until));
    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

const waitingSession: Session = {
  agent: "codex",
  cwd: "/home/demo/code/atlas",
  title: "Review changes",
  startedAt: Date.now(),
  lastActiveAt: Date.now(),
  activity: "waiting",
  place: { kind: "kiln", name: "atlas" },
};

test("with nothing to select the hints drop row keys, and a kept filter offers esc clear", async () => {
  const empty = await frameAfter([], { width: 100, height: 8 }, [], "no agents running");
  expect(empty).not.toContain("need input");
  expect(empty).toContain("n new · / filter · q quit");
  expect(empty).not.toContain("enter open");
  const unmatched = await frameAfter(
    [waitingSession],
    { width: 100, height: 8 },
    ["/", "z", "z", "RETURN"],
    "no sessions match",
  );
  expect(unmatched).toContain("esc clear · n new · / filter · q quit");
  expect(unmatched).not.toContain("j/k move");
});

test("a narrow terminal keeps the waiting count, the typed query and the way out of each prompt", async () => {
  const size = { width: 40, height: 10 };
  expect(await frameAfter([waitingSession], size, [], "need input")).toContain("1 need input");
  expect(await frameAfter([waitingSession], size, ["/", "a", "t", "l"], "/atl")).toContain("esc clear");
  expect(await frameAfter([waitingSession], size, ["n"], "esc cancel")).toContain("enter dir");
  expect(await frameAfter([waitingSession], size, ["x"], "y confirms")).toContain("else cancels");
});
