import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "./app";
import type { Session } from "./sessions";
import { defaults } from "./settings";

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
