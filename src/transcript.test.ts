import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "./transcript";

const record = (value: object) => `${JSON.stringify(value)}\n`;
const tool = (name: string, input: object) =>
  record({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("a generated title shows until the user sets one, and later generated titles do not replace it", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-titles-"));
  const path = join(root, "session.jsonl");
  try {
    writeFileSync(path, record({ type: "user", message: 'mentions "ai-title" in text' }));
    expect(readTranscript(path).title).toBeUndefined();
    appendFileSync(path, record({ type: "ai-title", aiTitle: "Kiln PRs to merge" }));
    expect(readTranscript(path).title).toBe("Kiln PRs to merge");
    appendFileSync(path, record({ type: "custom-title", customTitle: "Release 0.8.1" }));
    appendFileSync(path, record({ type: "ai-title", aiTitle: "Something newer" }));
    expect(readTranscript(path).title).toBe("Release 0.8.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the working checkout follows the latest edit or cd, not reads or directories outside a repository", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-workdir-"));
  const path = join(root, "session.jsonl");
  const [main, worktree] = [join(root, "main"), join(root, "worktree")];
  for (const dir of [main, worktree]) mkdirSync(join(dir, ".git"), { recursive: true });
  try {
    writeFileSync(path, tool("Bash", { command: `cd ${worktree} && git status` }));
    expect(readTranscript(path).workdir).toBe(worktree);
    appendFileSync(path, tool("Read", { file_path: join(main, "README.md") }));
    appendFileSync(path, tool("Bash", { command: `cd ${tmpdir()} && ls` }));
    expect(readTranscript(path).workdir).toBe(worktree);
    appendFileSync(path, tool("Edit", { file_path: join(main, "src", "app.ts") }));
    expect(readTranscript(path).workdir).toBe(main);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
