import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudLink } from "./cloud-links";
import type { Session } from "./sessions";

export type Handoff = { url: string; label: string; exact: boolean } | { reason: string };

/** Remote Control's bridge ID is metadata, not the local transcript's UUID. */
export function claudeBridgeLink(
  session: Session,
  root = Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): string | undefined {
  if (!session.pid || !session.id) return undefined;
  try {
    const record = JSON.parse(readFileSync(join(root, "sessions", `${session.pid}.json`), "utf8"));
    if (record.pid !== session.pid || record.sessionId !== session.id || typeof record.bridgeSessionId !== "string")
      return undefined;
    return cloudLink("claude", record.bridgeSessionId);
  } catch {
    return undefined;
  }
}

export function phoneHandoff(session: Session, codexHost?: string): Handoff {
  if (session.place.kind === "cloud") {
    return session.place.url
      ? { url: session.place.url, label: "Open task", exact: true }
      : { reason: "This task has no verified link" };
  }
  switch (session.agent) {
    case "claude": {
      const url = claudeBridgeLink(session);
      return url
        ? { url, label: "Open in Claude", exact: true }
        : { reason: "Remote Control is not enabled for this session" };
    }
    case "codex": {
      if (
        session.id &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.id) &&
        codexHost &&
        /^slingshot:env_[A-Za-z0-9_-]+:8765$/.test(codexHost)
      ) {
        const url = new URL(`https://chatgpt.com/codex/remote/thread/${session.id}`);
        url.searchParams.set("hostId", codexHost);
        return { url: url.href, label: "Open in ChatGPT", exact: true };
      }
      return { url: "https://chatgpt.com/codex", label: "Open ChatGPT, then choose this thread", exact: false };
    }
    case "pi":
      return {
        reason: session.piRemote
          ? "Read and control this Pi session in kiln"
          : "Run kiln pi install and restart Pi to enable remote control",
      };
  }
}
