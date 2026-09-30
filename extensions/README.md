# Pi remote control

Run `kiln pi install` and restart Pi to enable the bundled extension. For an isolated session,
load it explicitly with `pi -e /absolute/path/to/kiln/extensions/pi-remote.js`.

The bridge owns a private directory under XDG_RUNTIME_DIR, or the system temporary directory.
The directory has mode 0700; its Unix socket and discovery descriptor have mode 0600. Discovery
checks ownership, permissions and the live process start time. Shutdown removes them.

Commands use JSONL: get_state, prompt and abort, each with a request ID. Phone commands also carry
the paired device identity and expected session ID. The extension rejects a changed session, busy
prompts and a second writer. Prompt request IDs are retained in a bounded cache so a reconnect
cannot submit the same prompt twice. Writer leases expire after 30 seconds without a read.

State includes the session ID, live name, cwd, activity, instance ID and monotonic sequence.
Transcript reads return the last 40 messages, limited to 4,000 characters each; image payloads are
omitted. Streaming text is included while a turn runs. The phone reads a fresh snapshot every
second and on reconnect, so it does not need event replay. Requests and slow clients are bounded.

Only paired phones can use the localhost gateway endpoints. No arbitrary socket path, shell
command or unrestricted RPC method is accepted. The extension has no network listener.
Dialogs in other extensions must be answered in the local terminal. The local Pi terminal stays usable.
