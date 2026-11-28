// The kiln web client. It calls the same API as the phone; the device token lives only in an HttpOnly cookie.
// Every string from the server is set as text, never parsed as HTML: transcripts carry whatever agents printed.

const byId = (id) => document.getElementById(id);
const state = {
  snapshot: undefined,
  /** The id of the open session, and what the conversation view last read for it. */
  open: undefined,
  view: undefined,
  items: [],
  cursor: undefined,
  socket: undefined,
  viewTimer: undefined,
  reconnect: 1000,
  /** The tmux name of a session this browser just started, opened once it is listed. */
  starting: undefined,
  /** A reply is on its way, so Send waits for its answer. */
  sending: false,
};

/** An element with text children; strings become text nodes. */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

class Unpaired extends Error {}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers ?? {}) }, credentials: "same-origin", cache: "no-store" };
  if (options.json !== undefined) {
    init.method = init.method ?? "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.json);
    delete init.json;
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/v1/pair") {
    showPairing("This browser is not paired, or its pairing was revoked. Pair it again.");
    throw new Unpaired();
  }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function ago(at) {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function sessionState(row) {
  if (row.where === "cloud") return "cloud";
  if (row.resumable) return "stopped";
  return row.activity ?? "unknown";
}

// Pairing

function showPairing(note) {
  closeSocket();
  stopViewing();
  state.snapshot = undefined;
  byId("app").hidden = true;
  byId("pairing").hidden = false;
  if (note) byId("pair-note").textContent = note;
  const code = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (code) byId("pair-code").value = code;
  // The code leaves the address bar and history as soon as it is read.
  if (location.hash) history.replaceState(null, "", location.pathname);
}

byId("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("pair-error").textContent = "";
  try {
    await api("/v1/pair", { json: { code: byId("pair-code").value.trim(), name: byId("pair-name").value.trim() } });
    byId("pair-code").value = "";
    await begin();
  } catch (error) {
    byId("pair-error").textContent = error.message;
  }
});

byId("unpair").addEventListener("click", async () => {
  try {
    await api("/v1/unpair", { method: "POST" });
  } catch (error) {
    if (error instanceof Unpaired) return;
  }
  showPairing("This browser is unpaired.");
});

// Session list

function closeSocket() {
  const socket = state.socket;
  state.socket = undefined;
  if (socket) socket.close();
}

function connect() {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/events`);
  state.socket = socket;
  socket.onopen = () => {
    state.reconnect = 1000;
    byId("live").textContent = "live";
    byId("live").classList.add("on");
  };
  socket.onmessage = (event) => receive(JSON.parse(event.data));
  socket.onclose = (event) => {
    if (state.socket !== socket) return;
    state.socket = undefined;
    byId("live").textContent = "offline";
    byId("live").classList.remove("on");
    if (event.code === 4001) return showPairing("This browser's pairing was revoked. Pair it again to continue.");
    // Reconnecting backs off to a minute; a revoked or unpaired browser lands on the pairing form instead.
    setTimeout(() => {
      if (state.snapshot && !state.socket) void reload();
    }, state.reconnect);
    state.reconnect = Math.min(state.reconnect * 2, 60_000);
  };
}

async function reload() {
  try {
    receive(await api("/v1/sessions"));
    connect();
  } catch (error) {
    if (!(error instanceof Unpaired)) byId("problem").textContent = error.message;
  }
}

function receive(snapshot) {
  const first = !state.snapshot;
  state.snapshot = snapshot;
  byId("host").textContent = snapshot.host;
  byId("problem").textContent = snapshot.problem ?? "";
  byId("readonly").hidden = snapshot.write;
  byId("new").hidden = !snapshot.write;
  const agents = [...new Set(snapshot.sessions.map((row) => row.agent))].sort();
  const filter = byId("agent-filter");
  const chosen = filter.value;
  filter.replaceChildren(
    el("option", { value: "" }, "All agents"),
    ...agents.map((agent) => el("option", { value: agent }, agent)),
  );
  filter.value = agents.includes(chosen) ? chosen : "";
  renderList();
  if (state.starting) {
    const started = snapshot.sessions.find((row) => row.terminal === state.starting);
    if (started) {
      state.starting = undefined;
      openSession(started.id);
    }
  }
  if (state.open) renderHeader();
  if (first && location.hash.startsWith("#session=")) openSession(decodeURIComponent(location.hash.slice(9)));
}

function visibleSessions() {
  const query = byId("search").value.trim().toLowerCase();
  const agent = byId("agent-filter").value;
  const wanted = byId("state-filter").value;
  return state.snapshot.sessions
    .filter((row) => !agent || row.agent === agent)
    .filter((row) => !wanted || sessionState(row) === wanted)
    .filter(
      (row) =>
        !query ||
        [row.title, row.cwd, row.repository, row.branch, row.agent, row.account]
          .filter(Boolean)
          .some((text) => text.toLowerCase().includes(query)),
    )
    .sort((a, b) => (b.lastActiveAt ?? b.startedAt) - (a.lastActiveAt ?? a.startedAt));
}

function renderList() {
  if (!state.snapshot) return;
  const rows = visibleSessions();
  byId("sessions").replaceChildren(
    ...rows.map((row) =>
      el(
        "li",
        { class: row.id === state.open ? "open" : undefined },
        el(
          "button",
          { type: "button", onclick: () => openSession(row.id), title: row.cwd },
          el("span", { class: `dot ${row.activity ?? ""}`, "aria-label": sessionState(row) }),
          el("span", { class: "title" }, row.title || row.id),
          el("span", { class: "age" }, ago(row.lastActiveAt ?? row.startedAt)),
          el(
            "span",
            { class: "meta" },
            [row.agent, sessionState(row), row.repository ?? row.cwd, row.branch].filter(Boolean).join(" · "),
          ),
        ),
      ),
    ),
  );
  if (!rows.length) byId("sessions").append(el("li", { class: "note" }, "No sessions match."));
}

for (const id of ["search", "agent-filter", "state-filter"]) byId(id).addEventListener("input", renderList);

// Conversation

function current() {
  return state.snapshot?.sessions.find((row) => row.id === state.open);
}

function stopViewing() {
  clearTimeout(state.viewTimer);
  state.viewTimer = undefined;
  state.open = undefined;
  state.view = undefined;
}

function openSession(id) {
  stopViewing();
  state.open = id;
  state.items = [];
  state.cursor = undefined;
  history.replaceState(null, "", `#session=${encodeURIComponent(id)}`);
  byId("app").classList.add("viewing");
  const detail = byId("detail");
  detail.replaceChildren(
    el("header", {}),
    el("div", { class: "conversation", id: "conversation" }),
    el("div", { id: "menu" }),
    el("form", { class: "compose", id: "compose", hidden: true }),
  );
  renderHeader();
  renderList();
  void readView(id);
}

function renderHeader() {
  const row = current();
  const header = byId("detail").querySelector("header");
  if (!header) return;
  if (!row) {
    header.replaceChildren(el("h2", {}, "This session is no longer listed"));
    return;
  }
  const write = state.snapshot.write;
  const abilities = state.view?.abilities;
  header.replaceChildren(
    el("button", { type: "button", class: "quiet back", onclick: closeView }, "Back"),
    el(
      "div",
      { class: "heading" },
      el("h2", {}, row.title || row.id),
      el(
        "div",
        { class: "meta" },
        [row.agent, row.account, sessionState(row), row.cwd, row.branch].filter(Boolean).join(" · "),
      ),
    ),
    write && row.resumable ? el("button", { type: "button", onclick: () => act("resume") }, "Resume") : undefined,
    write && abilities?.stop
      ? el("button", { type: "button", class: "danger", onclick: () => act("interrupt") }, "Stop")
      : undefined,
  );
}

function closeView() {
  stopViewing();
  history.replaceState(null, "", location.pathname);
  byId("app").classList.remove("viewing");
  byId("detail").replaceChildren(el("p", { class: "empty" }, "Pick a session to see its conversation."));
  renderList();
}

async function act(action) {
  const row = current();
  if (!row) return;
  try {
    const result = await api(`/v1/sessions/${encodeURIComponent(row.id)}/${action}`, { method: "POST" });
    if (action === "resume") state.starting = result.terminal;
    composeNote(action === "resume" ? "Resuming in kiln on the computer" : "Stopped");
  } catch (error) {
    if (!(error instanceof Unpaired)) composeNote(error.message, true);
  }
}

async function readView(id) {
  if (state.open !== id) return;
  try {
    const query = state.cursor ? `?cursor=${encodeURIComponent(state.cursor)}` : "";
    const view = await api(`/v1/sessions/${encodeURIComponent(id)}/view${query}`);
    if (state.open !== id) return;
    state.view = view;
    if (view.reset) state.items = [];
    // A re-read item replaces the one with its id; new ones append in order.
    for (const item of view.items) {
      const index = state.items.findIndex((held) => held.id === item.id);
      if (index >= 0) state.items[index] = item;
      else state.items.push(item);
    }
    state.cursor = view.cursor || undefined;
    renderConversation();
  } catch (error) {
    if (error instanceof Unpaired) return;
    renderUnreadable(error.message);
  }
  if (state.open === id) state.viewTimer = setTimeout(() => readView(id), document.hidden ? 10_000 : 2_000);
}

function renderUnreadable(message) {
  const conversation = byId("conversation");
  if (conversation) conversation.replaceChildren(el("p", { class: "note" }, message));
}

function itemNode(item) {
  switch (item.kind) {
    case "tool":
      return el("div", { class: "item tool" }, el("b", {}, item.tool), " ", item.text);
    case "result":
      return el("div", { class: `item result${item.error ? " error" : ""}` }, item.text);
    default:
      return el("div", { class: `item ${item.kind}` }, item.text);
  }
}

function renderConversation() {
  const view = state.view;
  const conversation = byId("conversation");
  if (!view || !conversation) return;
  const follow =
    !conversation.childElementCount ||
    conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
  const nodes = state.items.map(itemNode);
  for (const message of view.queued) nodes.push(el("div", { class: "item you queued" }, message.text));
  if (!view.abilities.read)
    nodes.unshift(el("p", { class: "note" }, "kiln cannot read this agent's conversation; you can still message it."));
  conversation.replaceChildren(...nodes);
  if (follow) conversation.scrollTop = conversation.scrollHeight;
  renderMenu();
  renderCompose();
  renderHeader();
}

function renderMenu() {
  const menu = byId("menu");
  const prompt = state.view?.prompt;
  if (!prompt || !state.snapshot.write) {
    menu.replaceChildren();
    menu.className = "";
    return;
  }
  if (menu.dataset.key === prompt.key) return;
  menu.dataset.key = prompt.key;
  menu.className = "menu";
  menu.replaceChildren(
    ...prompt.context.map((line) => el("p", { class: "note" }, line)),
    el("p", {}, el("b", {}, prompt.question)),
    el(
      "div",
      { class: "options" },
      prompt.options.map((option) =>
        el(
          "button",
          {
            type: "button",
            class: option.typed ? "quiet" : undefined,
            title: option.typed ? "Sends what is in the reply box" : option.detail || undefined,
            onclick: () => answer(prompt, option),
          },
          `${option.number}. ${option.label}`,
        ),
      ),
    ),
  );
}

async function answer(prompt, option) {
  const row = current();
  const box = byId("reply");
  if (!row) return;
  const text = option.typed ? (box?.value ?? "") : undefined;
  if (option.typed && !text.trim()) return composeNote("Write the answer in the reply box first", true);
  try {
    await api(`/v1/sessions/${encodeURIComponent(row.id)}/prompt`, {
      json: { key: prompt.key, option: option.number, text },
    });
    if (box && option.typed) box.value = "";
    byId("menu").replaceChildren();
    byId("menu").className = "";
    delete byId("menu").dataset.key;
    composeNote("Answered");
  } catch (error) {
    if (!(error instanceof Unpaired)) composeNote(error.message, true);
  }
}

function renderCompose() {
  const compose = byId("compose");
  const view = state.view;
  if (!compose || !view) return;
  const blocked = view.abilities.reply;
  compose.hidden = !state.snapshot.write;
  if (!compose.firstChild) {
    compose.append(
      el("textarea", { id: "reply", rows: 2, placeholder: "Reply", "aria-label": "Reply" }),
      el("button", { type: "submit", id: "send" }, "Send"),
      el("p", { class: "note", id: "compose-note", role: "status" }),
    );
    compose.addEventListener("submit", send);
    byId("reply").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) compose.requestSubmit();
    });
  }
  byId("reply").disabled = Boolean(blocked);
  byId("send").disabled = Boolean(blocked) || state.sending;
  const note = byId("compose-note");
  if (!note.dataset.held) note.textContent = blocked ?? view.waiting ?? view.abilities.inbox ?? "";
}

function composeNote(text, error = false) {
  const note = byId("compose-note");
  if (!note) return;
  note.textContent = text;
  note.className = error ? "error" : "note";
  note.dataset.held = "1";
  setTimeout(() => {
    delete note.dataset.held;
    note.className = "note";
  }, 5000);
}

async function send(event) {
  event.preventDefault();
  const row = current();
  const box = byId("reply");
  const text = box.value.trim();
  if (!row || !text || state.sending) return;
  state.sending = true;
  byId("send").disabled = true;
  try {
    // The id makes a retried send post once.
    const result = await api(`/v1/sessions/${encodeURIComponent(row.id)}/messages`, {
      json: { text, id: crypto.randomUUID() },
    });
    box.value = "";
    composeNote(result.delivered ? "Delivered" : (result.reason ?? "Waiting in the mailbox"));
  } catch (error) {
    if (!(error instanceof Unpaired)) composeNote(error.message, true);
  } finally {
    state.sending = false;
    byId("send").disabled = false;
  }
}

// Starting a session

let offer;

byId("new").addEventListener("click", async () => {
  byId("start-error").textContent = "";
  try {
    offer = await api("/v1/directories");
  } catch (error) {
    if (!(error instanceof Unpaired)) byId("problem").textContent = error.message;
    return;
  }
  byId("start-agent").replaceChildren(...offer.agents.map((agent) => el("option", { value: agent }, agent)));
  byId("start-directory").replaceChildren(
    ...offer.directories.map((directory) => el("option", { value: directory }, directory)),
  );
  fillAccounts();
  byId("start-dialog").showModal();
});

function fillAccounts() {
  const agent = byId("start-agent").value;
  const accounts = (offer?.accounts ?? []).filter((account) => account.agent === agent);
  byId("start-account").replaceChildren(
    el("option", { value: "" }, "Any account"),
    ...accounts.map((account) =>
      el(
        "option",
        { value: account.name, disabled: account.state !== "ok" },
        account.state === "ok" ? account.name : `${account.name} (${account.state})`,
      ),
    ),
  );
  byId("start-account").parentElement.hidden = !accounts.length;
}

byId("start-agent").addEventListener("input", fillAccounts);
byId("start-cancel").addEventListener("click", () => byId("start-dialog").close());

byId("start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("start-submit").disabled = true;
  byId("start-error").textContent = "";
  try {
    const result = await api("/v1/sessions", {
      json: {
        agent: byId("start-agent").value,
        directory: byId("start-directory").value,
        prompt: byId("start-prompt").value,
        account: byId("start-account").value || undefined,
      },
    });
    state.starting = result.terminal;
    byId("start-prompt").value = "";
    byId("start-dialog").close();
  } catch (error) {
    if (!(error instanceof Unpaired)) byId("start-error").textContent = error.message;
  } finally {
    byId("start-submit").disabled = false;
  }
});

// Start

async function begin() {
  byId("pairing").hidden = true;
  byId("app").hidden = false;
  await reload();
}

setInterval(renderList, 30_000);
if (location.hash.startsWith("#pair=")) showPairing();
else void begin();
