# kiln for Android

The kiln app shows the coding-agent sessions running on a paired computer: Claude, Codex, OpenCode
and Pi. Here it runs on a dedicated emulator, paired to a test server with seeded sessions, so
nothing you do reaches a real computer or agent.

## Getting in

The app opens on the pairing screen with an invitation already filled in. Tap **Connect machine**
once. The invitation works once; if pairing fails, report it.

The test server seeds seven sessions: a Codex session waiting for input with one child session,
a finished Claude task, an idle OpenCode session, a Claude background job that completed, a Pi
session with no status, and a Claude session a restart stopped. Every 20 seconds the child flips
between working and needs input, so the list updates live.

## Main flows

- The session list: grouped by directory, with the tabs **live**, **history** and **hidden**.
- Filter and sort controls; expanding a session's children (`[+1]`).
- Tapping a row: opens the session details sheet (or a handoff link for Claude and Codex).
- Swiping a row to hide it, then finding it under **hidden**.
- The machine menu at the top: machines list, reconnect, pair another, forget.
- Rotating to landscape and back; the system back button on each screen.

## What to check, UX first

- Text that is cut off, overlaps, or does not fit at the default and the largest font size.
- Wording: status names, empty states, error messages, button labels that do not say what they do.
- Counts that disagree with the list (the "need input" count in the header).
- State lost on rotation or on returning to the app.
- Controls that do nothing, or do something other than their label.

## Never do these things

- Do not open links that leave the app (the Claude, ChatGPT or Tailscale apps, or a browser).
- Do not tap **Forget** on the machine: it removes the only pairing, and the invitation cannot be reused.
