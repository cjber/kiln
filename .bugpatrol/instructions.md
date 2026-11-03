# kiln

kiln is a terminal session list (a TUI) for the coding-agent sessions on this machine. Each row is
one session: native Claude, Codex, OpenCode or Pi sessions, plus read-only Codex Cloud tasks and
optional Claude cloud sessions. Opening a row hands the terminal to that provider's own TUI. Do not
open rows for this review.

The screen is a header line (`harness  task  status  updated`), then session rows grouped under
orange directory headings. A session waiting for input is yellow, a ready one is green, a working
one is subdued text. The header always shows a count of sessions waiting for input.

## How to run it

Never run `bun start` or `kiln` itself: that lists the real sessions on this machine. Run the list on
seeded sessions with the QA driver, which starts it in a private tmux server, presses the keys you
give, prints the screen and stops:

```sh
bun scripts/qa-drive.ts COLS ROWS SEED [key...]
```

- `SEED` is `short` (seven sessions: every agent, a parent with a child, a background job, a stopped
  session, an unknown status), `many` (60 sessions with long, wide-character, emoji, empty and
  multi-line titles, long paths and branches) or `empty`.
- Each key is a tmux key name (`Down`, `Up`, `Tab`, `Left`, `Right`, `Escape`, `BSpace`, `C-d`,
  `C-u`) or literal text (`j`, `/`, `fix`). Every call starts fresh, so repeat the keys that lead to
  a state.
- Try narrow and short terminals (`40 10`, `60 8`) as well as wide ones (`160 40`).

## Keys

- `j`/`k` and the arrows move the cursor; `g`/`G` jump to the top and bottom; `Ctrl-d`/`Ctrl-u` page.
- `/` filters titles, directories, agent names and status; `Enter` keeps the filter, `Escape` clears it.
- `Tab` expands the children of a session; `o` cycles the sort order.
- `n` opens the agent picker (`Escape` leaves it); `x` asks to close a session (`Escape` or `n` cancels).
- `r` refreshes; `q` quits.

## What to check, UX first

Report each of these as a bug when it is wrong, with the driver command that shows it:

- Column alignment: the header columns must line up with the rows, for every agent name and for
  titles with wide characters (CJK, emoji).
- Truncation: long titles, directory paths and branches must end in an ellipsis, never clip
  mid-character or overflow their column. Control characters in a title must never break a row.
- Status wording and colour: the status column and the detail line must agree with the meaning
  (needs input, ready, working, unknown, completed, stopped).
- Hints: the key hints at the bottom must only offer keys that do something on that screen.
- Empty state: with no sessions the list must still show the header or a clear message.
- The header must stay put while the list scrolls; the cursor must stay visible.
- Small terminals: nothing may overlap or wrap into the next line.

## Never do these things

- Never press `Enter` on a session row, `Enter` in the agent picker, or `y` in a close prompt.
- Never press `s` or `S`: they open an editor or change real skill links.
- Do not run any command other than the QA driver.
