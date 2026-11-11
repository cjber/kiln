import { describe, expect, test } from "bun:test";
import { isPeer, peerName } from "./msg-cli";

describe("peer identities", () => {
  test("a peer is an @name that cannot be read as a session", () => {
    expect(peerName("@nebula")).toBe("@nebula");
    expect(peerName("@nebula-ai:thread_1")).toBe("@nebula-ai:thread_1");
    expect(isPeer("@nebula")).toBe(true);
    expect(isPeer("opencode:ses_1")).toBe(false);
  });

  test("a name without the leading @ is refused, so an override cannot impersonate a session", () => {
    for (const raw of ["nebula", "@", "@a b", "@nebula\n"]) expect(() => peerName(raw)).toThrow();
  });
});
