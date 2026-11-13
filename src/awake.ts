/**
 * A logind sleep lock held while agents work, so an idle timer's `systemctl suspend` is refused and the work goes on.
 * Only sleep is inhibited: idle daemons still blank and lock the screens, which an `idle` lock would stop.
 */
export type Lock = { release: () => void; released: Promise<unknown> };

/**
 * `systemd-inhibit` holds the lock while `cat` reads kiln's end of a pipe. If kiln dies, however it dies, the pipe
 * closes, `cat` exits and logind drops the lock, so it can never outlive kiln.
 */
export function inhibitSleep(): Lock | undefined {
  const command = Bun.which("systemd-inhibit");
  if (!command) return undefined;
  try {
    const child = Bun.spawn(
      [command, "--what=sleep", "--mode=block", "--who=kiln", "--why=An agent is working", "cat"],
      { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
    );
    return { release: () => child.kill(), released: child.exited };
  } catch {
    return undefined;
  }
}

/** Takes the lock when something works and lets it go when nothing does; call it on every refresh. */
export function keepAwake(take: () => Lock | undefined = inhibitSleep): (working: boolean) => void {
  let held: Lock | undefined;
  return (working) => {
    if (working && !held) {
      const lock = take();
      held = lock;
      // A lock that ends by itself, such as logind restarting, is taken again on the next refresh.
      void lock?.released.then(() => {
        if (held === lock) held = undefined;
      });
    } else if (!working && held) {
      held.release();
      held = undefined;
    }
  };
}
