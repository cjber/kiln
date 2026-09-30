import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptTitle } from "./session-titles";

test("Claude and Pi names follow complete title records, appended renames and rewritten files", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-titles-"));
  try {
    const path = join(root, "session.jsonl");
    writeFileSync(
      path,
      '{"type":"custom-title","customTitle":"Claude title"}\n{"type":"session_info","name":"Pi title"}\n',
    );
    expect(transcriptTitle(path, "claude")).toBe("Claude title");
    const pi = join(root, "pi.jsonl");
    writeFileSync(pi, '{"type":"session_info","name":"Pi title"}\n');
    expect(transcriptTitle(pi, "pi")).toBe("Pi title");
    appendFileSync(pi, '{"type":"session_info","name":"Renamed π"}');
    expect(transcriptTitle(pi, "pi")).toBe("Pi title");
    appendFileSync(pi, "\n");
    expect(transcriptTitle(pi, "pi")).toBe("Renamed π");
    writeFileSync(pi, '{"type":"session_info","name":""}\n');
    expect(transcriptTitle(pi, "pi")).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
