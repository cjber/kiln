import { expect, test } from "bun:test";
import { AcpSessions } from "./acp";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("ACP state did not arrive");
}
test("ACP prompt lifecycle exposes pending permissions and resumes after an exact answer", async () => {
  const events: string[] = [];
  const host = new AcpSessions((_session, event) => {
    if (event) events.push(event);
  });
  try {
    const session = await host.create("codex", process.cwd(), [process.execPath, "scripts/acp-fixture.ts"]);
    const id = session.id;
    if (!id) throw new Error("Missing session identity");
    expect(session.activity).toBe("idle");
    host.prompt(id, "approve this");
    expect(host.get(id).session.activity).toBe("working");
    expect(host.get(id).session.title).toBe("approve this");
    await until(() => host.get(id).approvals.length === 1);
    expect(host.get(id).session.activity).toBe("waiting");
    const approval = host.get(id).approvals[0];
    if (!approval) throw new Error("Missing approval");
    expect(() => host.approve(id, "stale", "allow")).toThrow("stale");
    expect(() => host.approve(id, approval.id, "invalid")).toThrow("invalid");
    expect(() => host.prompt(id, "second prompt")).toThrow("still working");
    host.approve(id, approval.id, "allow");
    expect(host.get(id).session.activity).toBe("working");
    await until(() => host.get(id).session.activity === "idle");
    expect(host.get(id).approvals).toEqual([]);
    expect(host.get(id).messages.at(-1)?.text).toContain("Permission answered");
    expect(events).toEqual(["needs_input", "completed"]);
    host.close(id);
    expect(host.list()).toEqual([]);
  } finally {
    host.stop();
  }
});

test("restoration retains owned identity and failed restoration stays visible", async () => {
  const original = new AcpSessions();
  const restored = new AcpSessions();
  try {
    await original.create("codex", process.cwd(), [process.execPath, "scripts/acp-fixture.ts"]);
    const saved = original.saved()[0];
    if (!saved?.conversation.session.id) throw new Error("Missing saved identity");
    original.stop();
    restored.disconnected(saved, "Restoring");
    const session = await restored.create("codex", process.cwd(), saved.command, saved);
    if (!session.id) throw new Error("Missing restored identity");
    expect(session.id).toBe(saved.conversation.session.id);
    expect(session.activity).toBe("idle");
    restored.close(session.id);
    restored.disconnected(saved, "Adapter unavailable");
    expect(restored.list()[0]?.activity).toBeUndefined();
    expect(restored.get(session.id).problem).toBe("Adapter unavailable");
    restored.close(session.id);
    expect(restored.list()).toEqual([]);
  } finally {
    original.stop();
    restored.stop();
  }
});

test("cancelled turns become ready without a completion notification", async () => {
  const events: string[] = [];
  const host = new AcpSessions((_session, event) => {
    if (event) events.push(event);
  });
  try {
    const session = await host.create("codex", process.cwd(), [process.execPath, "scripts/acp-fixture.ts"]);
    if (!session.id) throw new Error("Missing session identity");
    const id = session.id;
    host.prompt(id, "approve this");
    await until(() => host.get(id).approvals.length === 1);
    await host.cancel(id);
    await until(() => host.get(id).session.activity === "idle");
    expect(host.get(id).approvals).toEqual([]);
    expect(events).toEqual(["needs_input"]);
  } finally {
    host.stop();
  }
});

test("closing a restoring session prevents it from returning", async () => {
  const original = new AcpSessions();
  const restored = new AcpSessions();
  try {
    await original.create("codex", process.cwd(), [process.execPath, "scripts/acp-fixture.ts"]);
    const saved = original.saved()[0];
    if (!saved?.conversation.session.id) throw new Error("Missing saved identity");
    original.stop();
    restored.disconnected(saved, "Restoring");
    const loading = restored.create("codex", process.cwd(), saved.command, saved);
    restored.close(saved.conversation.session.id);
    await expect(loading).rejects.toThrow("closed during startup");
    expect(restored.list()).toEqual([]);
    expect(restored.saved()).toEqual([]);
  } finally {
    original.stop();
    restored.stop();
  }
});
