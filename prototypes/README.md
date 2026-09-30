# Pi remote control prototype

Load the extension explicitly in an interactive Pi session:

```sh
pi -e /absolute/path/to/kiln/prototypes/pi-remote.js
```

It uses Node's standard library and Pi's extension API, with no fork or package install. It is
opt-in and does not change sessions started by kiln. Verified with Pi 0.99.1.

The status line shows an owner-only Unix socket in a private temporary directory under
`XDG_RUNTIME_DIR`, or the system temporary directory. A `session.json` file alongside it contains
the PID, socket and working directory for a future gateway to discover. The directory has mode
0700; the socket and descriptor have mode 0600. Shutdown removes them. An abrupt process death can
leave a stale directory; discovery must check the PID and socket before offering it.

The protocol is JSONL. Commands carry an optional `id`; responses echo it with `success` and
`data` or `error`. Supported commands are:

- `{"id":"1","type":"get_state"}`: current session ID, directory, idle state and last 200 branch entries.
- `{"id":"2","type":"prompt","message":"..."}`: send plain text when idle; busy sessions reject it.
- `{"id":"3","type":"abort"}`: interrupt the current operation.

Connected clients also receive `event` records for agent, message and tool lifecycle events.
Requests are capped at 64 KiB and clients that fall behind are disconnected. Reconnect with
`get_state` to recover recent context. This is a small proof of the extension seam, not a full RPC
implementation. Do not forward arbitrary RPC commands or shell execution through a gateway.

A production gateway needs pairing and authentication before forwarding requests, one active
remote writer, sequence numbers and replay, session discovery, and a strategy for dialogs in the
existing TUI. Pi's separate RPC mode forwards supported extension dialogs, but does not attach to
an already-running interactive process. This prototype cannot answer those dialogs remotely.

The protocol test uses a fake extension host. The real Pi smoke test loaded this file, queried
state without a provider configured, verified permissions, and checked shutdown cleanup. No real
prompt was sent; live provider output and abort during a model turn remain unverified.
