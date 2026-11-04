/** One process of the mailbox concurrency test: read an inbox and send in a tight loop, as busy agents do. */
import { pending, post, takeUnread } from "../src/mailbox";

const [path, index] = Bun.argv.slice(2) as [string, string];
for (let round = 0; round < 150; round++) {
  takeUnread(`codex:${index}`, path);
  if (round % 10 === 0) post(`claude:${index}-${round}`, `codex:${(Number(index) + 1) % 6}`, "hi", path);
  pending(path);
}
