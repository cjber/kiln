import { expect, test } from "bun:test";
import { isOpencodeService, newOpencodeSessionId, opencodeActivity, opencodeInvocation } from "./opencode";

test("a terminal session is told from a subcommand on argv, and only a valid id is read back", () => {
  const id = "ses_e67fb939cffebq6gr36R6Z5T16";
  expect(opencodeInvocation(["opencode"])).toEqual({ id: undefined, shared: true });
  expect(opencodeInvocation(["opencode", "/repo", "--session", id])).toEqual({ id, shared: true });
  expect(opencodeInvocation(["/usr/bin/opencode", `--session=${id}`])).toEqual({ id, shared: true });
  expect(opencodeInvocation(["opencode", "-s", id, "--standalone"])).toEqual({ id, shared: false });
  expect(opencodeInvocation(["opencode", "--server", "http://host:1"])?.shared).toBe(false);
  expect(opencodeInvocation(["opencode", "-s", "--flag"])?.id).toBeUndefined();
  expect(opencodeInvocation(["opencode", "mini"])).toBeDefined();
  // The value of a flag is not a subcommand, even when it reads like one.
  expect(opencodeInvocation(["opencode", "--prompt", "run"])).toBeDefined();
  for (const command of ["run", "serve", "api", "session", "acp"])
    expect(opencodeInvocation(["opencode", command])).toBeUndefined();
});

test("only the background service counts as the service", () => {
  expect(isOpencodeService(["/usr/bin/opencode", "serve", "--service"])).toBe(true);
  expect(isOpencodeService(["opencode", "serve"])).toBe(false);
  expect(isOpencodeService(["opencode"])).toBe(false);
});

test("a generated id is one discovery can read back", () => {
  const id = newOpencodeSessionId();
  expect(opencodeInvocation(["opencode", "--session", id])?.id).toBe(id);
  expect(newOpencodeSessionId()).not.toBe(id);
});

test("a prompt outranks a running turn, and states kiln does not know stay unknown", () => {
  expect(opencodeActivity({ type: "running" }, true)).toBe("waiting");
  expect(opencodeActivity({ type: "running" }, false)).toBe("working");
  expect(opencodeActivity({ type: "paused" }, false)).toBeUndefined();
  expect(opencodeActivity(undefined, false)).toBe("idle");
  expect(opencodeActivity(undefined, false, "succeeded")).toBe("idle");
  expect(opencodeActivity(undefined, false, "interrupted")).toBe("idle");
  expect(opencodeActivity(undefined, false, "failed")).toBe("waiting");
  expect(opencodeActivity(undefined, false, "cancelled")).toBeUndefined();
});
