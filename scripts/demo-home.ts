/**
 * A home directory the demo sessions' paths live in, so the shots never depend on this machine's home or repositories.
 * Import it before anything that reads the home: it points HOME at a scratch directory holding the repositories the
 * demo sessions work in, with `atlas` also checked out as a linked worktree, which is how kiln groups it under `atlas`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (Bun.env.KILN_DEMO_HOME) {
  // This is the child: its HOME is already the demo home.
} else {
  const demoHome = mkdtempSync(join(tmpdir(), "kiln-demo-home-"));

  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=demo",
        "-c",
        "user.email=demo@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd, stdout: "ignore", stderr: "pipe", env: { PATH: Bun.env.PATH ?? "", HOME: demoHome } },
    );
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  };

  for (const repository of ["atlas", "blog", "dotfiles", "kiln"]) {
    const directory = join(demoHome, "code", repository);
    mkdirSync(directory, { recursive: true });
    git(directory, "init", "-q");
    git(directory, "commit", "-q", "--allow-empty", "-m", "init");
  }
  mkdirSync(join(demoHome, ".worktrees", "atlas"), { recursive: true });
  git(
    join(demoHome, "code", "atlas"),
    "worktree",
    "add",
    "-q",
    "-b",
    "feat/search-index",
    join(demoHome, ".worktrees", "atlas", "search-index"),
  );

  // Bun reads the home directory once at startup, so the script runs again as a child that starts with it. The parent
  // only waits and cleans up; the child is the run that draws the shots.
  const child = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    env: { ...Bun.env, HOME: demoHome, KILN_DEMO_HOME: demoHome },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  rmSync(demoHome, { recursive: true, force: true });
  process.exit(child.exitCode ?? 1);
}
