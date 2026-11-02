# kiln

kiln is a terminal session list (a TUI) for the coding-agent sessions on this machine. Each row is
one session: native Claude, Codex, OpenCode or Pi sessions, plus read-only Codex Cloud tasks and
optional Claude cloud sessions. Opening a row hands the terminal to that provider's own TUI. Do not
open rows for this review.

The screen is a header line (`harness  task  status  updated`), then session rows grouped under
orange directory headings. A session waiting for input is yellow, a ready one is green, a working
one is subdued text. The header always shows a count of sessions waiting for input.

## Keys

- `j`/`k` and the arrows move the cursor.
- `/` filters titles, directories, agent names and status.
- `Tab` expands the children of a session; `o` cycles the sort order.
- `r` refreshes; `q` quits.

## What to check, UX first

Report each of these as a bug when it is wrong, with the key presses that show it:

- Column alignment: the header columns must line up with the rows. The `harness` column now also
  holds `opencode` (9 characters). Note any row or column that misaligns.
- Truncation: long titles, directory paths and branches must end in an ellipsis, never clip
  mid-character or overflow their column.
- Status wording and colour: the status column and the row colour must agree with the meaning
  (yellow = waiting for you, green = ready, subdued = working, grey = stopped).
- Empty state: with no sessions the list must still show the header or a clear message, never a
  blank screen or stray characters.
- The header must stay put while the list scrolls.

## Never do these things

- Do not open a session (`Enter`), start a new session (`n`), or close one (`x`). These spawn or
  end real agent sessions.
- Do not edit settings (`s`) or skills (`S`).
- Do not run shell commands in a session.
