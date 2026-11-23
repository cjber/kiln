import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeConfig,
  claudeTrustKey,
  launchProcesses,
  settleLaunch,
  trustClaudeWorkspace,
  withConfigLock,
  writeTrust,
} from "./claude-trust";

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

test("a process's config is in its config dir, or under its home directory without one", () => {
  expect(claudeConfig({ CLAUDE_CONFIG_DIR: "/config", HOME: "/home/a" })).toEqual({
    json: "/config/.claude.json",
    sessions: "/config/sessions",
  });
  expect(claudeConfig({ HOME: "/home/a" })).toEqual({
    json: "/home/a/.claude.json",
    sessions: "/home/a/.claude/sessions",
  });
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
  expect(await trustClaudeWorkspace(plain, join(config, ".claude.json"))).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    oauthAccount: { id: "a" },
    projects: {
      "/other": { allowedTools: ["x"] },
      [plain]: {
        mcp: 1,
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
    },
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  // Already trusted: nothing to write.
  expect(await trustClaudeWorkspace(plain, join(config, ".claude.json"))).toBe(false);
});

test("a trusted folder's outside imports are allowed once, and a decision already made stands (#278)", async () => {
  const config = join(root, "config-imports");
  const [unasked, declined] = ["imports-unasked", "imports-declined"].map((name) => join(root, name));
  for (const dir of [config, unasked, declined]) mkdirSync(dir);
  const path = join(config, ".claude.json");
  const declinedEntry = {
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: true,
  };
  // A folder a person trusted before still asked about its imports, a dialog no one answers for a spawned session.
  writeFileSync(
    path,
    JSON.stringify({ projects: { [unasked]: { hasTrustDialogAccepted: true }, [declined]: declinedEntry } }),
  );
  expect(await trustClaudeWorkspace(unasked, path)).toBe(true);
  expect(await trustClaudeWorkspace(declined, path)).toBe(false);
  expect(JSON.parse(readFileSync(path, "utf8")).projects).toEqual({
    [unasked]: {
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
    },
    [declined]: declinedEntry,
  });
});

test("an already trusted workspace can use a read-only config directory (#342)", async () => {
  const config = join(root, "config-read-only");
  const workspace = join(root, "trusted-read-only");
  const untrusted = join(root, "untrusted-read-only");
  for (const dir of [config, workspace, untrusted]) mkdirSync(dir);
  const path = join(config, ".claude.json");
  const original = JSON.stringify({
    projects: {
      [workspace]: {
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
      [untrusted]: { hasTrustDialogAccepted: true },
    },
  });
  writeFileSync(path, original);
  chmodSync(config, 0o500);
  try {
    expect(await trustClaudeWorkspace(workspace, path)).toBe(false);
    await expect(trustClaudeWorkspace(untrusted, path)).rejects.toThrow("EACCES");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(config)).toEqual([".claude.json"]);
  } finally {
    chmodSync(config, 0o700);
  }
});

test("a missing file or projects map is created", async () => {
  const plain = join(root, "fresh");
  mkdirSync(plain);
  const missing = join(root, "config-missing");
  expect(await trustClaudeWorkspace(plain, join(missing, ".claude.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(missing, ".claude.json"), "utf8"))).toEqual({
    projects: {
      [plain]: {
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
    },
  });
  const empty = join(root, "config-empty");
  mkdirSync(empty);
  writeFileSync(join(empty, ".claude.json"), JSON.stringify({ theme: "dark" }));
  expect(await trustClaudeWorkspace(plain, join(empty, ".claude.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(empty, ".claude.json"), "utf8"))).toEqual({
    theme: "dark",
    projects: {
      [plain]: {
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
    },
  });
});

test("an unparsable file is left untouched and the error is reported", async () => {
  const plain = join(root, "broken");
  mkdirSync(plain);
  const config = join(root, "config-broken");
  mkdirSync(config);
  const path = join(config, ".claude.json");
  writeFileSync(path, '{"projects": {');
  await expect(trustClaudeWorkspace(plain, join(config, ".claude.json"))).rejects.toThrow("is not valid JSON");
  expect(readFileSync(path, "utf8")).toBe('{"projects": {');
  writeFileSync(path, "[]");
  await expect(trustClaudeWorkspace(plain, join(config, ".claude.json"))).rejects.toThrow("is not a JSON object");
  expect(readFileSync(path, "utf8")).toBe("[]");
});

test("the home directory and the root are never written", async () => {
  const config = join(root, "config-home");
  await expect(trustClaudeWorkspace(homedir(), join(config, ".claude.json"))).rejects.toThrow("never marks");
  await expect(trustClaudeWorkspace("/", join(config, ".claude.json"))).rejects.toThrow("never marks");
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
  expect(await trustClaudeWorkspace(plain, join(config, ".claude.json"))).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    theme: "light",
    projects: {
      [plain]: {
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
    },
  });
  expect(existsSync(`${path}.lock`)).toBe(false);
  // Left by a writer that died: stale after proper-lockfile's 10 seconds.
  const other = join(root, "locked-stale");
  mkdirSync(other);
  mkdirSync(`${path}.lock`);
  utimesSync(`${path}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  expect(await trustClaudeWorkspace(other, join(config, ".claude.json"))).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a writer whose lock was taken over leaves the file and the new owner's lock alone", async () => {
  const plain = join(root, "taken");
  mkdirSync(plain);
  const config = join(root, "config-taken");
  mkdirSync(config);
  const path = join(config, ".claude.json");
  const lock = `${path}.lock`;
  writeFileSync(path, "{}");
  // As if kiln stalled past the stale time: another writer took the lock over and saved first.
  await expect(
    withConfigLock(path, (owned) => {
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
      utimesSync(lock, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
      writeFileSync(path, JSON.stringify({ theme: "light" }));
      return writeTrust(path, plain, owned);
    }),
  ).rejects.toThrow("lost");
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ theme: "light" }));
  expect(readdirSync(config).sort()).toEqual([".claude.json", ".claude.json.lock"]);
  rmSync(lock, { recursive: true });
  expect(await withConfigLock(path, (owned) => owned())).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

/** A launcher with config dir `outer` that hands the session id to a program with config dir `inner`, under any name. */
function launcher(id: string, outer: string, inner: string, helper: string) {
  // Each process stops its own child when stopped, so a test leaves nothing running.
  const program = 'sleep 30 & trap "kill $!; exit" TERM; wait';
  const script = [
    // A helper the launcher runs on another account, without the session id.
    `CLAUDE_CONFIG_DIR="${helper}" sh -c '${program}' & helper=$!`,
    `CLAUDE_CONFIG_DIR="${inner}" sh -c '${program}' 2.1.325 --session-id "$2" & claude=$!`,
    'trap "kill $helper $claude; exit" TERM',
    "wait",
  ].join("\n");
  return Bun.spawn(["sh", "-c", script, "launcher", "--session-id", id], {
    env: { ...Bun.env, CLAUDE_CONFIG_DIR: outer },
  });
}

async function launched(pid: number, id: string, count: number) {
  for (let tries = 0; ; tries++) {
    const found = launchProcesses(pid, id);
    if (found.length >= count || tries > 100) return found;
    await Bun.sleep(20);
  }
}

test("a launch is followed by its session id, under any launcher and program name", async () => {
  const id = crypto.randomUUID();
  const [outer, inner, helper] = ["launch-outer", "launch-inner", "launch-helper"].map((name) => join(root, name));
  const child = launcher(id, outer, inner, helper);
  try {
    const found = await launched(child.pid, id, 2);
    expect(found.map((process) => process.config.json)).toEqual([
      join(outer, ".claude.json"),
      join(inner, ".claude.json"),
    ]);
    expect(found[0]?.pid).toBe(child.pid);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("a launch that reaches an untrusted config is trusted there, and a registered one is settled", async () => {
  const id = crypto.randomUUID();
  const dir = join(root, "settle");
  mkdirSync(dir);
  const [outer, inner, helper] = ["settle-outer", "settle-inner", "settle-helper"].map((name) => join(root, name));
  await trustClaudeWorkspace(dir, join(outer, ".claude.json"));
  const child = launcher(id, outer, inner, helper);
  try {
    const found = await launched(child.pid, id, 2);
    // Claude under the launcher has a config that had not trusted the folder: it must start again.
    expect(await settleLaunch(child.pid, id, dir, 5_000)).toBe("untrusted");
    expect(JSON.parse(readFileSync(join(inner, ".claude.json"), "utf8")).projects[dir]).toEqual({
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
    });
    // The helper never carried the session id, so its account was left alone.
    expect(existsSync(join(helper, ".claude.json"))).toBe(false);
    // Trusted everywhere but not registered: nothing more to do once the wait ends.
    expect(await settleLaunch(child.pid, id, dir, 100)).toBe("unregistered");
    // Claude records its session only past the trust dialog.
    const claude = found[1]?.pid;
    mkdirSync(join(inner, "sessions"));
    writeFileSync(join(inner, "sessions", `${claude}.json`), JSON.stringify({ pid: claude, sessionId: id }));
    expect(await settleLaunch(child.pid, id, dir, 5_000)).toBe("registered");
  } finally {
    child.kill();
    await child.exited;
  }
  expect(await settleLaunch(child.pid, id, dir, 5_000)).toBe("ended");
});

test("a launch that has exited is settled while its parent has not collected it", async () => {
  // The parent never waits, so the exited launch stays a zombie, as a pane's process does until tmux collects it.
  const parent = Bun.spawn(["sh", "-c", "sh -c 'exit 7' & echo $!; exec sleep 30"], { stdout: "pipe" });
  try {
    const reader = parent.stdout.getReader();
    let printed = "";
    while (!printed.includes("\n")) printed += new TextDecoder().decode((await reader.read()).value);
    const launch = Number(printed.trim());
    for (let waited = 0; !readFileSync(`/proc/${launch}/stat`, "utf8").includes(") Z "); waited += 10) {
      expect(waited).toBeLessThan(5_000);
      await Bun.sleep(10);
    }
    expect(await settleLaunch(launch, crypto.randomUUID(), root, 5_000)).toBe("ended");
  } finally {
    parent.kill();
    await parent.exited;
  }
});
