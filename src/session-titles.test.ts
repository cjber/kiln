import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptTitle } from "./session-titles";

test("a generated title shows until the user sets one, and later generated titles do not replace it", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-titles-"));
  const path = join(root, "session.jsonl");
  const record = (value: object) => `${JSON.stringify(value)}\n`;
  try {
    writeFileSync(path, record({ type: "user", message: 'mentions "ai-title" in text' }));
    expect(transcriptTitle(path)).toBeUndefined();
    appendFileSync(path, record({ type: "ai-title", aiTitle: "Kiln PRs to merge" }));
    expect(transcriptTitle(path)).toBe("Kiln PRs to merge");
    appendFileSync(path, record({ type: "custom-title", customTitle: "Release 0.8.1" }));
    appendFileSync(path, record({ type: "ai-title", aiTitle: "Something newer" }));
    expect(transcriptTitle(path)).toBe("Release 0.8.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
