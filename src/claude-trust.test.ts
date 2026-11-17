import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeJsonPath, claudeTrustKey, runningClaude, startedClaude, trustClaudeWorkspace } from "./claude-trust";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kiln-trust-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      dir,
      "-c",
      "user.name=kiln",
      "-c",
      "user.email=kiln@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repository(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "start");
  return dir;
}

test("a repository's subdirectory and its worktrees are trusted through the main checkout", () => {
  const repo = repository("repo");
  expect(claudeTrustKey(join(repo, "src"))).toBe(repo);
  const worktree = join(root, "repo-worktree");
  git(repo, "worktree", "add", "-q", worktree);
  expect(claudeTrustKey(worktree)).toBe(repo);
});

test("a folder outside a repository is its own key, and the home directory has none", () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  expect(claudeTrustKey(plain)).toBe(plain);
  expect(claudeTrustKey(homedir())).toBeUndefined();
});

test("the config file is in the config dir, or beside the home directory without one", () => {
  expect(claudeJsonPath("/config")).toBe("/config/.claude.json");
  expect(claudeJsonPath(undefined)).toBe(join(homedir(), ".claude.json"));
});

test("trust is added and every other key is kept", async () => {
  const config = join(root, "config-kept");
  const plain = join(root, "kept");
  mkdirSync(plain);
  mkdirSync(config);
  const path = join(config, ".claude.json");
  writeFileSync(
    path,
    JSON.stringify({ oauthAccount: { id: "a" }, projects: { "/other": { allowedTools: ["x"] }, [plain]: { mcp: 1 } } }),
    { mode: 0o600 },
  );
  expect(await trustClaudeWorkspace(plain, config)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    oauthAccount: { id: "a" },
    projects: { "/other": { allowedTools: ["x"] }, [plain]: { mcp: 1, hasTrustDialogAccepted: true } },
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  // Already trusted: nothing to write.
  expect(await trustClaudeWorkspace(plain, config)).toBe(false);
});

test("a missing file or projects map is created", async () => {
  const plain = join(root, "fresh");
  mkdirSync(plain);
  const missing = join(root, "config-missing");
  expect(await trustClaudeWorkspace(plain, missing)).toBe(true);
  expect(JSON.parse(readFileSync(join(missing, ".claude.json"), "utf8"))).toEqual({
    projects: { [plain]: { hasTrustDialogAccepted: true } },
  });
  const empty = join(root, "config-empty");
  mkdirSync(empty);
  writeFileSync(join(empty, ".claude.json"), JSON.stringify({ theme: "dark" }));
  expect(await trustClaudeWorkspace(plain, empty)).toBe(true);
  expect(JSON.parse(readFileSync(join(empty, ".claude.json"), "utf8"))).toEqual({
    theme: "dark",
    projects: { [plain]: { hasTrustDialogAccepted: true } },
  });
});

test("an unparsable file is left untouched and the error is reported", async () => {
  const plain = join(root, "broken");
  mkdirSync(plain);
  const config = join(root, "config-broken");
  mkdirSync(config);
  const path = join(config, ".claude.json");
  writeFileSync(path, '{"projects": {');
  await expect(trustClaudeWorkspace(plain, config)).rejects.toThrow("is not valid JSON");
  expect(readFileSync(path, "utf8")).toBe('{"projects": {');
  writeFileSync(path, "[]");
  await expect(trustClaudeWorkspace(plain, config)).rejects.toThrow("is not a JSON object");
  expect(readFileSync(path, "utf8")).toBe("[]");
});

test("the home directory and the root are never written", async () => {
  const config = join(root, "config-home");
  await expect(trustClaudeWorkspace(homedir(), config)).rejects.toThrow("never marks");
  await expect(trustClaudeWorkspace("/", config)).rejects.toThrow("never marks");
  expect(existsSync(config)).toBe(false);
});

test("a write waits for Claude's config lock and takes over one its holder left behind", async () => {
  const plain = join(root, "locked");
  mkdirSync(plain);
  const config = join(root, "config-locked");
  mkdirSync(config);
  const path = join(config, ".claude.json");
  writeFileSync(path, "{}");
  // Held by a live writer: the change waits for it and sees what that writer saved.
  mkdirSync(`${path}.lock`);
  setTimeout(() => {
    writeFileSync(path, JSON.stringify({ theme: "light" }));
    rmSync(`${path}.lock`, { recursive: true });
  }, 200);
  expect(await trustClaudeWorkspace(plain, config)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    theme: "light",
    projects: { [plain]: { hasTrustDialogAccepted: true } },
  });
  expect(existsSync(`${path}.lock`)).toBe(false);
  // Left by a writer that died: stale after proper-lockfile's 10 seconds.
  const other = join(root, "locked-stale");
  mkdirSync(other);
  mkdirSync(`${path}.lock`);
  utimesSync(`${path}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  expect(await trustClaudeWorkspace(other, config)).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("the running Claude's config dir is read from its own environment, under any launcher", async () => {
  // An executable named claude, started by a wrapper that gives it another config dir than the wrapper has.
  const bin = join(root, "bin");
  mkdirSync(bin);
  copyFileSync(Bun.which("sleep") as string, join(bin, "claude"));
  const wrapper = Bun.spawn(["sh", "-c", `CLAUDE_CONFIG_DIR=/chosen "${join(bin, "claude")}" 30; :`], {
    env: { ...Bun.env, CLAUDE_CONFIG_DIR: "/wrapper" },
  });
  try {
    expect(await startedClaude(wrapper.pid, 5_000)).toEqual({ configDir: "/chosen" });
  } finally {
    wrapper.kill();
    await wrapper.exited;
  }
  const other = Bun.spawn(["sleep", "30"]);
  try {
    expect(runningClaude(other.pid)).toBeUndefined();
    expect(await startedClaude(other.pid, 100)).toBeUndefined();
  } finally {
    other.kill();
  }
});
