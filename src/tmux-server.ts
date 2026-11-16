import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Stops a private tmux server started with `-L name` and removes its socket file, which tmux leaves in
 * `$TMUX_TMPDIR/tmux-<uid>/` (`/tmp` when unset) after the server exits. For tests and scripts that run their own server.
 */
export function killServer(name: string): void {
  Bun.spawnSync(["tmux", "-L", name, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  rmSync(join(Bun.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.()}`, name), { force: true });
}
