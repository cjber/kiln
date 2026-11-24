import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearSpent, recordSpent, spentUntil } from "./spent";

test("clearing a provider reset only forgets the selected account", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-spent-"));
  try {
    const path = join(dir, "spent.json");
    recordSpent("claude", "work", 100, path);
    recordSpent("claude", "personal", 200, path);
    expect(clearSpent("claude", "work", path)).toBe(true);
    expect(clearSpent("claude", "work", path)).toBe(false);
    expect(spentUntil("claude", "work", 0, path)).toBeUndefined();
    expect(spentUntil("claude", "personal", 0, path)).toBe(200);
    recordSpent("claude", "work", 300, path);
    expect(spentUntil("claude", "work", 0, path)).toBe(300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
