import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App } from "./app";
import type { Session } from "./sessions";
import { defaults } from "./settings";

test("cycling sort keeps the selected session, updates the label and shows activity", async () => {
  const sessions: Session[] = [
    {
      pid: 1,
      title: "project-z",
      agent: "pi",
      cwd: "/z/project-z",
      startedAt: 10,
      lastActiveAt: Date.now(),
      place: { kind: "kiln", name: "z" },
    },
    {
      pid: 2,
      title: "project-a",
      agent: "claude",
      cwd: "/a/project-a",
      startedAt: 20,
      place: { kind: "kiln", name: "a" },
    },
  ];
  let calls = 0;
  let complete!: (rows: Session[]) => void;
  const load = async () =>
    ++calls === 1
      ? sessions
      : new Promise<Session[]>((resolve) => {
          complete = resolve;
        });
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <App
        initialSettings={{ ...defaults, sort: "last_active", cloud: false }}
        onQuit={() => {}}
        loadSessions={load}
      />,
      { width: 120, height: 12 },
    );
  });
  try {
    await setup.waitForFrame((frame) => frame.includes("project-z"));
    expect(setup.captureCharFrame()).toContain("last active");
    expect(setup.captureCharFrame()).toContain("unknown");
    await act(async () => {
      await setup.mockInput.pressKeys(["o", "o"]);
    });
    await setup.waitForFrame((frame) => frame.includes("harness"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("harness");
    expect(frame.split("\n").find((line) => line.includes("›"))).toContain("project-z");
    await act(async () => {
      await setup.mockInput.pressKeys(["r", "k"]);
    });
    await act(async () => {
      complete(sessions.map((session) => ({ ...session })));
    });
    await setup.waitForFrame(
      (frame) =>
        frame
          .split("\n")
          .find((line) => line.includes("›"))
          ?.includes("project-a") ?? false,
    );
    expect(
      setup
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("›")),
    ).toContain("project-a");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
