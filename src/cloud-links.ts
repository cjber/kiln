import type { Agent } from "./sessions";

/** Only provider HTTPS task URLs are safe to hand to another device. */
export function cloudLink(agent: Agent, id: string, source?: unknown): string | undefined {
  switch (agent) {
    case "claude":
      return /^(?:session|cse)_[A-Za-z0-9_-]+$/.test(id) ? `https://claude.ai/code/${id}` : undefined;
    case "codex": {
      if (source === undefined || source === null) return undefined;
      if (typeof source !== "string") throw new Error("codex cloud returned an invalid task URL");
      let url: URL;
      try {
        url = new URL(source);
      } catch {
        throw new Error("codex cloud returned an invalid task URL");
      }
      if (
        url.origin !== "https://chatgpt.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== `/codex/tasks/${encodeURIComponent(id)}`
      )
        throw new Error("codex cloud returned an invalid task URL");
      return url.href;
    }
    case "pi":
      return undefined;
  }
}
