// nchat hub daemon: facilitates sessions talking to each other.
// Stores users, channels, messages, DMs, statuses, file transfers.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_PATH, dataPath, readJSON, writeJSON, id, now, validNick, validChannel, dmKeyOf, writePidFile, removePidFile } from "./common.js";

const usersFile = dataPath("users.json");
const stateFile = dataPath("state.json");

// users: nick -> { nick, hostname, status, statusText, lastSeen, acked }
// acked: the ts of the newest event the nick's client has confirmed handling
// (method "ack"); a subscribe with replay gets everything newer again, so
// what arrives while a session is stopped, resuming or reconnecting isn't lost
// state: { channels: {name: {name, topic, members:[], messages:[]}}, dms: {"a|b": []}, files: {id: {...}} }
let users, state;

function loadState() {
  users = readJSON(usersFile, {});
  state = readJSON(stateFile, { channels: {}, dms: {}, files: {} });
  state.channels["general"] ||= { name: "general", topic: "Lobby", members: [], messages: [] };
  // users from before acks: nothing old to replay
  for (const u of Object.values(users)) u.acked ??= now();
}
const subscribers = new Map(); // connId -> { sock, nick }
let connSeq = 0;

// Reactions agents and humans can attach to messages.
const REACTIONS = new Set(["ok", "error", "in-progress", "done", "todo", "question", "star", "eyes", "fire"]);

const saveUsers = () => writeJSON(usersFile, users);
const saveState = () => writeJSON(stateFile, state);

function ensureChannel(name) {
  if (!validChannel(name)) throw new Error("invalid channel name");
  state.channels[name] ||= { name, topic: "", members: [], messages: [] };
  return state.channels[name];
}
function dmKey(a, b) { return dmKeyOf(a, b); }

function getOrCreateUser(nick, hostname) {
  if (!validNick(nick)) throw new Error("invalid nickname (1-32 chars, alnum, _ or -)");
  if (!users[nick]) users[nick] = { nick, hostname, status: "offline", statusText: "", lastSeen: now(), created: now(), acked: now() };
  return users[nick];
}

function notify(nick, event) {
  for (const [cid, s] of subscribers) {
    if (s.nick === nick && s.sock.writable) s.sock.write(JSON.stringify(event) + "\n");
  }
}
function notifyChannel(channel, event) {
  for (const m of ensureChannel(channel).members) notify(m, { ...event, channel });
}
function allNicks() { return Object.keys(users); }
function subscribed(nick) {
  for (const s of subscribers.values()) if (s.nick === nick && s.sock.writable) return true;
  return false;
}

const REPLAY_MAX = 200;
// The events for nick newer than its ack, as they were sent live (with
// replay: true): DMs to it, its channels' messages and files to it or its
// channels, from others; oldest first, the newest REPLAY_MAX.
function pendingFor(nick) {
  const since = users[nick]?.acked ?? now();
  const out = [];
  for (const msgs of Object.values(state.dms)) {
    for (const m of msgs) if (m.to === nick && m.from !== nick && m.ts > since) out.push({ event: "dm", message: m, replay: true });
  }
  const mine = new Set();
  for (const ch of Object.values(state.channels)) {
    if (!ch.members.includes(nick)) continue;
    mine.add(ch.name);
    for (const m of ch.messages) {
      if (m.ts > since && m.from !== nick && m.from !== "system") out.push({ event: "message", message: m, channel: ch.name, replay: true });
    }
  }
  for (const f of Object.values(state.files)) {
    if (f.ts > since && f.from !== nick && (f.to === nick || (!f.to && mine.has(f.channel)))) out.push({ event: "file", file: f, replay: true });
  }
  const ts = (e) => (e.message || e.file).ts;
  return out.sort((a, b) => ts(a) - ts(b)).slice(-REPLAY_MAX);
}

// ----- request handlers -----
const handlers = {
  ping: () => "pong",

  register({ nick, hostname }) {
    const u = getOrCreateUser(nick, hostname || "unknown");
    u.lastSeen = now();
    u.hostname = hostname || u.hostname;
    saveUsers();
    return { ok: true, user: u };
  },

  whoami({ nick }) {
    const u = users[nick];
    if (!u) throw new Error(`unknown user ${nick}`);
    return { user: u };
  },

  users: () => ({ users: allNicks().map((n) => users[n]) }),

  join({ nick, channel }) {
    getOrCreateUser(nick, "unknown");
    const ch = ensureChannel(channel);
    if (!ch.members.includes(nick)) {
      ch.members.push(nick);
      ch.messages.push({ id: id(), ts: now(), from: "system", type: "join", text: `${nick} joined #${channel}` });
      notifyChannel(channel, { event: "message", message: { from: "system", type: "join", text: `${nick} joined #${channel}` } });
      saveState();
    }
    return { ok: true, channel: ch };
  },

  part({ nick, channel }) {
    const ch = state.channels[channel];
    if (ch) {
      ch.members = ch.members.filter((m) => m !== nick);
      ch.messages.push({ id: id(), ts: now(), from: "system", type: "part", text: `${nick} left #${channel}` });
      notifyChannel(channel, { event: "message", message: { from: "system", type: "part", text: `${nick} left #${channel}` } });
      saveState();
    }
    return { ok: true };
  },

  channels: () => ({ channels: Object.values(state.channels).map((c) => ({ name: c.name, topic: c.topic, members: [...c.members], count: c.messages.length })) }),

  topic({ channel, topic, by }) {
    const ch = ensureChannel(channel);
    ch.topic = topic;
    ch.messages.push({ id: id(), ts: now(), from: "system", type: "topic", text: `${by} set topic: ${topic}` });
    notifyChannel(channel, { event: "message", message: { from: "system", type: "topic", text: `${by} set topic: ${topic}` } });
    saveState();
    return { ok: true, topic };
  },

  send({ from, channel, text }) {
    if (!text) throw new Error("empty message");
    const ch = ensureChannel(channel);
    const msg = { id: id(), ts: now(), from, channel, text };
    ch.messages.push(msg);
    if (ch.messages.length > 5000) ch.messages.splice(0, ch.messages.length - 5000);
    notifyChannel(channel, { event: "message", message: msg });
    saveState();
    return { ok: true, message: msg };
  },

  dm({ from, to, text }) {
    if (!users[to]) throw new Error(`unknown user ${to}`);
    const key = dmKey(from, to);
    const msg = { id: id(), ts: now(), from, to, text };
    (state.dms[key] ||= []).push(msg);
    notify(to, { event: "dm", message: msg });
    notify(from, { event: "dm", message: msg });
    saveState();
    return { ok: true, message: msg };
  },

  history({ channel, limit = 100, before }) {
    const ch = state.channels[channel];
    if (!ch) throw new Error(`unknown channel #${channel}`);
    let msgs = ch.messages;
    if (before) msgs = msgs.filter((m) => m.ts < before);
    return { messages: msgs.slice(-limit) };
  },

  dmHistory({ a, b, limit = 100 }) {
    const msgs = state.dms[dmKey(a, b)] || [];
    return { messages: msgs.slice(-limit) };
  },

  dms: () => ({ dms: Object.keys(state.dms) }),

  react({ by, channel, to, messageId, reaction }) {
    if (!REACTIONS.has(reaction)) throw new Error(`unknown reaction "${reaction}" (allowed: ${[...REACTIONS].join(", ")})`);
    const find = (list) => list.find((m) => m.id === messageId);
    let m, scope;
    if (to) {
      const key = dmKey(by, to);
      m = find(state.dms[key] || []);
      scope = key;
    } else {
      const ch = ensureChannel(channel);
      m = find(ch.messages);
      scope = ch.name;
    }
    if (!m) throw new Error(`no message ${messageId} in ${to ? `dm with ${to}` : `#${channel}`}`);
    if (!by) throw new Error("specify --as <nick> or NCHAT_NICK");
    m.reactions ||= {};
    const list = (m.reactions[reaction] ||= []);
    const i = list.indexOf(by);
    if (i === -1) list.push(by); else list.splice(i, 1); // toggle
    const evt = { event: "reaction", message: m, by, reaction };
    if (to) { notify(by, evt); notify(to, evt); }
    else notifyChannel(channel, evt);
    saveState();
    return { ok: true, message: m, scope };
  },

  status({ nick, status, statusText, ifOffline }) {
    const u = getOrCreateUser(nick, "unknown");
    // ifOffline: a reconnecting client keeps a status the agent set itself
    if (ifOffline && u.status !== "offline") return { ok: true, user: u };
    if (status) u.status = status; // online | away | busy | offline
    if (statusText !== undefined) u.statusText = statusText;
    u.lastSeen = now();
    saveUsers();
    notifyChannelAll({ event: "presence", nick, status: u.status, statusText: u.statusText });
    return { ok: true, user: u };
  },

  sendFile({ from, channel, to, name, size, path: filePath }) {
    const fid = id();
    state.files[fid] = { id: fid, from, channel: channel || null, to: to || null, name, size, path: filePath, ts: now() };
    const evt = { event: "file", file: state.files[fid] };
    if (to) notify(to, evt);
    else notifyChannel(channel, evt);
    saveState();
    return { ok: true, fileId: fid, file: state.files[fid] };
  },

  files: () => ({ files: Object.values(state.files) }),

  subs: () => ({ count: subscribers.size, nicks: [...subscribers.values()].map((s) => s.nick) }),

  // the client has handled nick's events up to ts
  ack({ nick, ts }) {
    const u = users[nick];
    if (!u) throw new Error(`unknown user ${nick}`);
    if (typeof ts !== "number") throw new Error("ack needs a numeric ts");
    if (ts > (u.acked ?? 0)) { u.acked = ts; saveUsers(); }
    return { ok: true, acked: u.acked };
  },

  pending({ nick }) {
    return { events: pendingFor(nick) };
  },

  subscribe({ nick }) {
    // handled specially at connection level
    return { ok: true };
  },
};

function notifyChannelAll(event) {
  for (const s of subscribers.values()) if (s.sock.writable) s.sock.write(JSON.stringify(event) + "\n");
}

const server = net.createServer((sock) => {
  const connId = ++connSeq;
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line) continue;
      let req; try { req = JSON.parse(line); } catch { continue; }
      if (req.method === "subscribe") {
        const nick = req.params?.nick || null;
        subscribers.set(connId, { sock, nick });
        sock.write(JSON.stringify({ id: req.id, result: { ok: true } }) + "\n");
        // replay: what came for the nick since its last ack (it may have
        // been away, or its previous connection may have dropped)
        if (nick && req.params?.replay && users[nick]) {
          for (const e of pendingFor(nick)) sock.write(JSON.stringify(e) + "\n");
        }
        continue;
      }
      const handler = handlers[req.method];
      if (!handler) { sock.write(JSON.stringify({ id: req.id, error: `unknown method ${req.method}` }) + "\n"); continue; }
      try {
        const result = handler(req.params || {});
        if (req.method !== "ping") { /* track activity */ }
        sock.write(JSON.stringify({ id: req.id, result }) + "\n");
      } catch (e) {
        sock.write(JSON.stringify({ id: req.id, error: String(e.message || e) }) + "\n");
      }
    }
  });
  sock.on("close", () => {
    const s = subscribers.get(connId);
    subscribers.delete(connId);
    // offline only when the nick's last connection goes: a client that
    // reconnected closes its old socket after the new one is up
    if (s?.nick && !subscribed(s.nick)) {
      const u = users[s.nick];
      if (u && u.status !== "offline") { u.status = "offline"; saveUsers(); notifyChannelAll({ event: "presence", nick: s.nick, status: "offline" }); }
    }
  });
  sock.on("error", () => {});
});

// cleanup stale socket, then listen
export function startHub({ silent = false } = {}) {
  loadState();
  process.title = "nchat-hub";
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
  return new Promise((resolve) => {
    server.listen(SOCKET_PATH, () => {
      writePidFile(process.pid);
      if (!silent) console.log(`nchat hub listening on ${SOCKET_PATH} (data: ${dataPath()})`);
      resolve(server);
    });
  });
}

export async function stopHub() {
  saveUsers();
  saveState();
  for (const [, s] of subscribers) s.sock.destroy();
  subscribers.clear();
  await new Promise((r) => server.close(r));
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  removePidFile();
}

process.on("SIGINT", async () => { await stopHub(); process.exit(0); });
process.on("SIGTERM", async () => { await stopHub(); process.exit(0); });

// run as daemon unless imported (e.g. by tests)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startHub();
}
