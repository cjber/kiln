import { closeSession, sessionAction } from "./launcher";
import { callerIdentity } from "./messages";
import { pickSessions } from "./resume-cli";
import { sessionTitle } from "./session-list";
import { listSessions, sessionIdentity } from "./sessions";

/** `kiln close`: what `x` does on a row, for every session named. No names lists the ones it can close. */
export async function runCloseCli(names: string[]): Promise<number> {
  const closable = (await listSessions({ kitty: false })).filter((session) => !("reason" in sessionAction(session)));
  if (!names.length) {
    for (const session of closable) console.log(`${sessionIdentity(session)}  ${sessionTitle(session)}`);
    if (!closable.length) console.log("no sessions kiln can close");
    return 0;
  }
  const chosen = pickSessions(closable, names, "closable");
  const me = callerIdentity();
  // An agent that closes its own session ends its turn mid-command and loses the rest of its work.
  if (me && chosen.some((session) => sessionIdentity(session) === me)) throw new Error(`${me} is this session`);
  let failed = 0;
  for (const session of chosen) {
    const result = await closeSession(session);
    if (result === true) console.log(`closed ${sessionIdentity(session)}`);
    else {
      failed++;
      console.error(`kiln: could not close ${sessionIdentity(session)}: ${result}`);
    }
  }
  return failed ? 1 : 0;
}
