import { strict as assert } from "node:assert";

/** Runs tuistory commands against one named session; each e2e script uses its own port so they can overlap. */
export function driver(session: string, port: number) {
  return async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(["bunx", "tuistory@0.11.0", "-s", session, ...args], {
      env: { ...Bun.env, TUISTORY_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [text, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${args.join(" ")}: ${error || text}`);
    return text;
  };
}
