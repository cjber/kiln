/** zoxide's own ranking, best first. Without zoxide the picker simply starts empty and takes a typed path. */
export function rankedDirectories(): string[] {
  if (!Bun.which("zoxide")) return [];
  const listed = Bun.spawnSync(["zoxide", "query", "--list"], { stdout: "pipe", stderr: "ignore" });
  return listed.exitCode === 0 ? listed.stdout.toString().split("\n").filter(Boolean) : [];
}

export function recordDirectory(path: string): void {
  if (Bun.which("zoxide")) Bun.spawnSync(["zoxide", "add", "--", path], { stderr: "ignore" });
}
