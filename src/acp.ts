import {
  type ClientConnection,
  client,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { Subprocess } from "bun";
import packageJson from "../package.json";
import type { Activity, Agent, Session } from "./sessions";

type Approval = { id: string; title: string; options: PermissionOption[] };
export type Conversation = {
  session: Session;
  messages: { id: string; role: "user" | "agent" | "tool"; text: string }[];
  approvals: Approval[];
  problem?: string;
};
type Pending = { approval: Approval; resolve: (response: RequestPermissionResponse) => void };
export type SavedSession = { conversation: Conversation; providerId: string; command: string[] };
type Owned = {
  command: string[];
  conversation: Conversation;
  process: Subprocess<"pipe", "pipe", "ignore">;
  connection: ClientConnection;
  providerId: string;
  pending: Map<string, Pending>;
  busy: boolean;
  closed: boolean;
  cancelled: boolean;
};

/** Only this host owns agent stdin. List and phone clients operate on the same sessions. */
export class AcpSessions {
  private owned = new Map<string, Owned>();
  private unavailable = new Map<string, SavedSession>();
  private starting = new Set<Owned>();
  private stopped = false;
  disconnected(record: SavedSession, problem: string): void {
    const id = record.conversation.session.id;
    if (!id) throw new Error("Saved ACP session has no identity");
    record.conversation.session.activity = undefined;
    record.conversation.approvals = [];
    record.conversation.problem = problem;
    this.unavailable.set(id, record);
  }
  constructor(private changed: (session?: Session, event?: "needs_input" | "completed") => void = () => {}) {}
  saved(): SavedSession[] {
    return [
      ...this.unavailable.values(),
      ...[...this.owned.values()].map((owned) => ({
        conversation: { ...owned.conversation, approvals: [] },
        providerId: owned.providerId,
        command: owned.command,
      })),
    ];
  }

  list(): Session[] {
    return [...this.owned.values()]
      .map(({ conversation }) => conversation.session)
      .concat([...this.unavailable.values()].map(({ conversation }) => conversation.session));
  }
  get(id: string): Conversation {
    const unavailable = this.unavailable.get(id);
    if (unavailable) return unavailable.conversation;
    const owned = this.require(id);
    return { ...owned.conversation, approvals: [...owned.pending.values()].map(({ approval }) => approval) };
  }
  private require(id: string): Owned {
    const owned = this.owned.get(id);
    if (!owned) throw new Error("Session no longer exists");
    return owned;
  }
  private status(owned: Owned, activity: Activity | undefined) {
    owned.conversation.session.activity = activity;
    owned.conversation.session.lastActiveAt = Date.now();
    this.changed();
  }
  private update(owned: Owned, update: SessionUpdate) {
    const messages = owned.conversation.messages;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "user_message_chunk":
      case "agent_thought_chunk":
      case "compaction_summary_chunk": {
        if (update.content.type !== "text" || update.sessionUpdate === "agent_thought_chunk") break;
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "agent";
        const last = messages.at(-1);
        if (last?.role === role) last.text += update.content.text;
        else messages.push({ id: crypto.randomUUID(), role, text: update.content.text });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = `tool:${update.toolCallId}`;
        const previous = messages.find((message) => message.id === id);
        const title = update.title ?? previous?.text.split(" · ")[0] ?? "Tool";
        const text = `${title} · ${update.status ?? "pending"}`;
        if (previous) previous.text = text;
        else messages.push({ id, role: "tool", text });
        break;
      }
      case "session_info_update":
        if (update.title) owned.conversation.session.title = update.title;
        break;
      case "plan": {
        const text = update.entries.map((entry) => `${entry.status}: ${entry.content}`).join("\n");
        const previous = messages.find((message) => message.id === "plan");
        if (previous) previous.text = text;
        else messages.push({ id: "plan", role: "tool", text });
        break;
      }
      case "notice":
        messages.push({
          id: crypto.randomUUID(),
          role: "tool",
          text: `${update.title}${update.description ? `: ${update.description}` : ""}`,
        });
        break;
      case "plan_update":
      case "plan_removed":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "usage_update":
      case "compaction_update":
        break;
      default: {
        const exhaustive: never = update;
        throw new Error(`Unsupported ACP update: ${exhaustive}`);
      }
    }
    if (messages.length > 400) messages.splice(0, messages.length - 400);
    const last = messages.at(-1);
    if (last && last.text.length > 64000) last.text = last.text.slice(-64000);
    owned.conversation.session.lastActiveAt = Date.now();
    this.changed();
  }

  async create(agent: Agent, cwd: string, command: string[], saved?: SavedSession): Promise<Session> {
    if (this.stopped) throw new Error("ACP host is stopped");
    if (!command.length || !Bun.which(command[0] ?? ""))
      throw new Error(`Install the ${agent} ACP adapter or set its command in [agents]`);
    const id = saved?.conversation.session.id ?? crypto.randomUUID();
    const child = Bun.spawn(command, { cwd, env: Bun.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    let owned: Owned;
    const app = client({ name: "kiln" })
      .onNotification("session/update", ({ params }) => {
        if (params.sessionId === owned.providerId) this.update(owned, params.update);
      })
      .onRequest("session/request_permission", ({ params }) => {
        if (params.sessionId !== owned.providerId || owned.closed) return { outcome: { outcome: "cancelled" } };
        const approval: Approval = {
          id: crypto.randomUUID(),
          title: params.toolCall.title ?? "Permission required",
          options: params.options,
        };
        this.status(owned, "waiting");
        return new Promise<RequestPermissionResponse>((resolve) => {
          owned.pending.set(approval.id, { approval, resolve });
          this.changed(owned.conversation.session, "needs_input");
        });
      });
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        child.stdin.write(chunk);
        child.stdin.flush();
      },
      close() {
        child.stdin.end();
      },
    });
    const connection = app.connect(ndJsonStream(output, child.stdout));
    owned = {
      command,
      conversation: saved
        ? { ...saved.conversation, messages: [], approvals: [], problem: undefined }
        : {
            session: {
              id,
              agent,
              cwd,
              title: `${agent} session`,
              startedAt: Date.now(),
              activity: "idle",
              place: { kind: "acp", id },
            },
            messages: [],
            approvals: [],
          },
      process: child,
      connection,
      providerId: saved?.providerId ?? "",
      pending: new Map(),
      busy: false,
      closed: false,
      cancelled: false,
    };
    this.starting.add(owned);
    const timeout = setTimeout(() => {
      owned.connection.close(new Error("ACP startup timed out"));
      child.kill();
    }, 60_000);
    try {
      const initialized = await owned.connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "kiln", version: packageJson.version },
      });
      if (saved) {
        if (!initialized.agentCapabilities?.loadSession)
          throw new Error(`${agent} ACP adapter cannot restore sessions`);
        await owned.connection.agent.request("session/load", { sessionId: saved.providerId, cwd, mcpServers: [] });
        if (!owned.conversation.messages.length) owned.conversation.messages = saved.conversation.messages;
        owned.conversation.session.activity = "idle";
        owned.conversation.problem = "Session restored. Any interrupted turn was stopped.";
      } else {
        const created = await owned.connection.agent.request("session/new", { cwd, mcpServers: [] });
        owned.providerId = created.sessionId;
      }
      if (owned.closed || (saved && !this.unavailable.has(id))) throw new Error("ACP session closed during startup");
      this.unavailable.delete(id);
      this.owned.set(id, owned);
      this.changed();
      void owned.connection.closed.then(() => {
        if (owned.closed) return;
        this.clearApprovals(owned);
        owned.busy = false;
        this.status(owned, undefined);
        owned.conversation.problem = "ACP connection lost. Close this session and start a new one.";
        child.kill();
      });
      return owned.conversation.session;
    } catch (error) {
      owned.connection.close();
      child.kill();
      throw error;
    } finally {
      this.starting.delete(owned);
      clearTimeout(timeout);
    }
  }

  prompt(id: string, text: string): void {
    const owned = this.require(id);
    if (owned.closed || owned.connection.signal.aborted) throw new Error("ACP connection is closed");
    if (owned.busy) throw new Error("The agent is still working or waiting for approval");
    if (!text.trim() || Buffer.byteLength(text) > 3500)
      throw new Error("Prompt must be nonempty and at most 3500 UTF-8 bytes");
    if (owned.conversation.session.title === `${owned.conversation.session.agent} session`)
      owned.conversation.session.title = text.trim().split("\n")[0]?.slice(0, 80);
    owned.busy = true;
    owned.cancelled = false;
    owned.conversation.problem = undefined;
    owned.conversation.messages.push({ id: crypto.randomUUID(), role: "user", text });
    this.status(owned, "working");
    void owned.connection.agent
      .request("session/prompt", { sessionId: owned.providerId, prompt: [{ type: "text", text }] })
      .then((response) => {
        if (!owned.closed && !owned.connection.signal.aborted) {
          this.status(owned, "idle");
          if (response.stopReason !== "cancelled" && !owned.cancelled)
            this.changed(owned.conversation.session, "completed");
        }
      })
      .catch((error: unknown) => {
        if (!owned.closed) {
          owned.conversation.problem = error instanceof Error ? error.message : "ACP prompt failed";
          this.status(owned, owned.connection.signal.aborted ? undefined : "idle");
        }
      })
      .finally(() => {
        owned.busy = false;
        this.clearApprovals(owned);
      });
  }
  approve(id: string, approvalId: string, optionId: string): void {
    const owned = this.require(id);
    const pending = owned.pending.get(approvalId);
    if (!pending?.approval.options.some((option) => option.optionId === optionId))
      throw new Error("Approval is stale or option is invalid");
    owned.pending.delete(approvalId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    this.status(owned, owned.pending.size ? "waiting" : "working");
  }
  private clearApprovals(owned: Owned) {
    for (const pending of owned.pending.values()) pending.resolve({ outcome: { outcome: "cancelled" } });
    owned.pending.clear();
  }
  async cancel(id: string): Promise<void> {
    const owned = this.require(id);
    owned.cancelled = true;
    this.clearApprovals(owned);
    await owned.connection.agent.notify("session/cancel", { sessionId: owned.providerId });
  }
  close(id: string): void {
    if (this.unavailable.delete(id)) {
      this.changed();
      return;
    }
    const owned = this.require(id);
    owned.closed = true;
    this.clearApprovals(owned);
    owned.connection.close();
    owned.process.kill();
    this.owned.delete(id);
    this.changed();
  }
  stop(): void {
    this.stopped = true;
    for (const owned of [...this.owned.values(), ...this.starting]) {
      owned.closed = true;
      this.clearApprovals(owned);
      owned.connection.close();
      owned.process.kill();
    }
  }
}
