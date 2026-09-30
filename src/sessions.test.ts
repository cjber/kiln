import { describe, expect, test } from "bun:test";

import { isInteractiveCodex, isInteractivePi } from "./sessions";

describe("isInteractiveCodex", () => {
  test("keeps a plain session, a resume, and flags that merely contain a subcommand name", () => {
    expect(isInteractiveCodex("codex")).toBe(true);
    expect(isInteractiveCodex("codex resume 0199c-abc")).toBe(true);
    expect(isInteractiveCodex("codex --search --dangerously-bypass-approvals-and-sandbox")).toBe(true);
  });

  test("drops the non-session subcommands", () => {
    for (const command of [
      "codex exec 'do a thing'",
      "codex review",
      "codex agents",
      "codex app-server",
      "codex mcp list",
    ]) {
      expect(isInteractiveCodex(command)).toBe(false);
    }
  });
});

describe("isInteractivePi", () => {
  test("keeps a plain session and one started with a message", () => {
    expect(isInteractivePi("pi")).toBe(true);
    expect(isInteractivePi("pi --continue")).toBe(true);
    expect(isInteractivePi("pi fix the flaky test")).toBe(true);
  });

  test("drops print mode, rpc mode and the management subcommands", () => {
    for (const command of ["pi -p 'summarise'", "pi --mode rpc", "pi install npm:foo", "pi update", "pi auth status"]) {
      expect(isInteractivePi(command)).toBe(false);
    }
  });
});
