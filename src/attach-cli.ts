import { openSession } from "./launcher";
import { answersTo, listSessions } from "./sessions";
import { loadSettings } from "./settings";
import { attach } from "./tmux";

/**
 * `kiln attach <name>`: what Enter does on a row, for the session `kiln msg list` names (its identity or process
 * alias). Attaching hands this terminal to the session's tmux session until it is detached.
 */
export async function runAttachCli(args: string[]): Promise<number> {
  const [name] = args;
  if (args.length !== 1 || !name) throw new Error("usage: kiln attach <name>");
  const settings = loadSettings();
  const session = (await listSessions({ kitty: false }, true)).find((item) => answersTo(item, name));
  if (!session) {
    console.error(`kiln: no session "${name}"`);
    return 1;
  }
  const outcome = await openSession(session, settings);
  switch (outcome.kind) {
    case "attach":
      await attach(outcome.name, settings);
      if (outcome.notice) console.error(outcome.notice);
      return 0;
    case "notice":
      console.error(`kiln: ${outcome.text}`);
      return 1;
    case "done":
      return 0;
  }
}
