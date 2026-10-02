import { sessionRows } from "../src/session-list";
import { listSessions, nestSessions, type Session, sessionIdentity } from "../src/sessions";

const live = process.argv.includes("--live");
const count = 500;
const samples = 10;
const percentile = (times: number[], fraction: number) =>
  [...times].sort((a, b) => a - b)[Math.ceil(times.length * fraction) - 1]?.toFixed(1);

async function measure(name: string, run: () => unknown | Promise<unknown>) {
  const durations: number[] = [];
  let previous = performance.now();
  let gap = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - previous);
    previous = now;
  }, 10);
  try {
    for (let sample = 0; sample < samples; sample++) {
      previous = performance.now();
      const start = previous;
      await run();
      durations.push(performance.now() - start);
      await Bun.sleep(20);
    }
  } finally {
    clearInterval(heartbeat);
  }
  console.log(
    `${name}: p50=${percentile(durations, 0.5)}ms p95=${percentile(durations, 0.95)}ms max heartbeat gap=${gap.toFixed(1)}ms`,
  );
}

if (live) {
  await measure("live discovery", () => listSessions());
} else {
  for (const shape of ["shallow", "chain"] as const) {
    const sessions: Session[] = Array.from({ length: count }, (_, index) => ({
      agent: "codex",
      id: String(index),
      parentSessionId:
        shape === "chain"
          ? index
            ? String(index - 1)
            : undefined
          : index % 10
            ? String(index - (index % 10))
            : undefined,
      cwd: "/tmp/perf",
      startedAt: index,
      place: { kind: "kiln", name: `perf-${index}` },
    }));
    const expanded = new Set(sessions.map(sessionIdentity));
    await measure(`${count} ${shape} sessions: discovery nesting + expanded list`, () => {
      const nested = nestSessions(sessions);
      const rows = sessionRows(nested, "project", "", expanded);
      if (rows.filter((row) => row.kind === "session").length !== count) throw new Error("lost a session");
    });
  }
}
