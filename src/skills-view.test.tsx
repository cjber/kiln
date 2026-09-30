import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SkillsView } from "./skills-view";

test("fast keyboard input creates a project skill, shares it and returns without deleting its files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-skills-ui-"));
  let edited = "";
  let returned = false;
  const setup = await testRender(
    <SkillsView
      project={directory}
      onBack={() => {
        returned = true;
      }}
      edit={async (path) => {
        edited = path;
      }}
    />,
    { width: 100, height: 14 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("kiln skills"));
    await act(async () => {
      await setup.mockInput.pressKey("p");
    });
    await setup.flush();
    await act(async () => {
      await setup.mockInput.pressKey("n");
      await setup.mockInput.typeText("deploy");
      await setup.mockInput.pressKey("\r");
    });
    await setup.waitForFrame((frame) => frame.includes("deploy") && frame.includes("saved"));
    expect(edited).toBe(join(directory, ".agents", "skills", "deploy", "SKILL.md"));
    await act(async () => {
      await setup.mockInput.pressKey("l");
    });
    await setup.waitForFrame((frame) => frame.includes("shared with Claude"));
    expect(existsSync(join(directory, ".pi", "skills", "deploy", "SKILL.md"))).toBe(true);
    await act(async () => {
      await setup.mockInput.pressKey("x");
      await setup.mockInput.pressKey("y");
    });
    await setup.waitForFrame((frame) => frame.includes("links removed"));
    expect(existsSync(edited)).toBe(true);
    await act(async () => {
      await setup.mockInput.pressKey("q");
    });
    expect(returned).toBe(true);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
