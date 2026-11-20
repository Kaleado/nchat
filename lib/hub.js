// nchat hub daemon: facilitates sessions talking to each other.
// Stores users, channels, messages, DMs, statuses, file transfers. Agents are
// notified through nqueue (see nq.js); live events on the socket are for
// the TUI and `nchat listen`.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_PATH, TUNNELS_DIR, dataPath, readJSON, writeJSON, id, now, validNick, validChannel, dmKeyOf, writePidFile, removePidFile, socketAlive } from "./common.js";
import * as nq from "./nq.js";
import { FileStore, loadConfig, blobPath, partPath, formatSize } from "./files.js";

const usersFile = dataPath("users.json");
const stateFile = dataPath("state.json");

// users: nick -> { nick, hostname, status, statusText, lastSeen }
// state: { channels: {name: {name, topic, members:[], messages:[]}}, dms: {"a|b": []}, files: {id: {...}} }
let users, state, fileStore;

function loadState() {
  users = readJSON(usersFile, {});
  state = readJSON(stateFile, { channels: {}, dms: {}, files: {} });
  state.files ||= {};
  fileStore = new FileStore(state.files, () => saveState());
  state.channels["general"] ||= { name: "general", topic: "Lobby", members: [], messages: [] };
}

// Bring nqueue in line with the hub: every nick has an inbox, and channel
// members are subscribed (nqueue may be new, or its data reset).
function syncNqueue() {
  if (!nq.enabled()) return;
  nq.ensureServer();
  for (const nick of Object.keys(users)) nq.setupNick(nick);
  for (const ch of Object.values(state.channels)) for (const m of ch.members) nq.joinChannel(m, ch.name);
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
  if (!users[nick]) {
    users[nick] = { nick, hostname, status: "offline", statusText: "", lastSeen: now(), created: now() };
    nq.setupNick(nick);
  }
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
      nq.joinChannel(nick, channel);
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
      nq.partChannel(nick, channel);
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
    if (validNick(by)) nq.postToChannel(channel, by, `#${channel} ${by} set the topic: ${topic}`);
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
    nq.postToChannel(channel, from, `#${channel} <${from}> ${text}  [${msg.id}]`);
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
    nq.sendToInbox(to, from, `DM from ${from}: ${text}  [${msg.id}]`);
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
    // tell the author, unless they reacted to their own message
    if (i === -1 && m.from !== by && users[m.from]) {
      const where = to ? "DM" : `#${channel}`;
      nq.sendToInbox(m.from, by, `${by} reacted (${reaction}) to your message in ${where}: ${String(m.text).slice(0, 80)}  [${m.id}]`);
    }
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
    const line = `file ${name} (${size}b) from ${from} at ${filePath}  [${fid}]`;
    if (to) nq.sendToInbox(to, from, line);
    else nq.postToChannel(channel, from, `#${channel} ${line}`);
    saveState();
    return { ok: true, fileId: fid, file: state.files[fid] };
  },

  // Stored files carry when they expire (from the current ttl); expired
  // ones say so; path-only shares from older clients have neither.
  files: () => {
    const cfg = loadConfig();
    fileStore.prune(cfg);
    return { files: Object.values(state.files).map((f) => ({ ...f, expiresAt: fileStore.expiresAt(f, cfg) })) };
  },

  subs: () => ({ count: subscribers.size, nicks: [...subscribers.values()].map((s) => s.nick) }),

  subscribe({ nick }) {
    // handled specially at connection level
    return { ok: true };
  },
};

// A file share in the conversation's history, notified like a message.
function shareFile(f) {
  const text = `shared file ${f.name} (${formatSize(f.size)}) [${f.id}]`;
  const msg = { id: id(), ts: now(), from: f.from, text, file: f.id };
  if (f.to) { msg.to = f.to; (state.dms[dmKey(f.from, f.to)] ||= []).push(msg); }
  else { msg.channel = f.channel; ensureChannel(f.channel).messages.push(msg); }
  const evt = { event: "file", file: f, message: msg };
  if (f.to) { notify(f.to, evt); notify(f.from, evt); } else notifyChannel(f.channel, evt);
  const line = `file ${f.name} (${formatSize(f.size)}) from ${f.from}  [${f.id}]; fetch it with \`nchat getfile ${f.id}\``;
  if (f.to) nq.sendToInbox(f.to, f.from, line);
  else nq.postToChannel(f.channel, f.from, `#${f.channel} ${line}`);
}

// Check an upload request and hold room for it. Returns the file's metadata.
function startUpload({ from, channel, to, name, size }, fid) {
  if (!validNick(from)) throw new Error("specify --as <nick> or NCHAT_NICK");
  getOrCreateUser(from, "unknown");
  if (to) { if (!users[to]) throw new Error(`unknown user ${to}`); }
  else ensureChannel(channel || "general");
  const base = path.basename(String(name || "")).replace(/[\x00-\x1f]/g, "");
  if (!base || base === "." || base === "..") throw new Error("invalid file name");
  fileStore.reserve(fid, size);
  return { from, channel: to ? null : channel || "general", to: to || null, name: base, size, ts: now() };
}

function notifyChannelAll(event) {
  for (const s of subscribers.values()) if (s.sock.writable) s.sock.write(JSON.stringify(event) + "\n");
}

const reply = (sock, rid, body) => { if (sock.writable) sock.write(JSON.stringify({ id: rid, ...body }) + "\n"); };

// Connections carry newline-separated JSON requests, except while a file is
// being uploaded (raw bytes follow an upload request) or downloaded (raw
// bytes follow the response, then the connection ends).
const server = net.createServer((sock) => {
  const connId = ++connSeq;
  let buf = Buffer.alloc(0);
  let up = null; // { rid, fid, meta, remaining, ws }
  let finishing = false; // an upload's bytes are in; later requests wait for its reply

  const failUpload = (msg) => {
    if (!up) return;
    const u = up; up = null;
    u.ws.destroy();
    fileStore.release(u.fid);
    if (msg) reply(sock, u.rid, { error: msg });
  };

  // Feed upload bytes; returns whatever came after the file.
  const feed = (chunk) => {
    const take = Math.min(chunk.length, up.remaining);
    if (take) {
      up.remaining -= take;
      if (!up.ws.write(chunk.subarray(0, take))) { sock.pause(); up.ws.once("drain", () => sock.resume()); }
    }
    if (up.remaining === 0) {
      const u = up; up = null;
      finishing = true;
      u.ws.end(() => {
        try {
          const f = fileStore.commit(u.fid, u.meta);
          shareFile(f);
          saveState();
          reply(sock, u.rid, { result: { ok: true, fileId: f.id, file: { ...f, expiresAt: fileStore.expiresAt(f) } } });
        } catch (e) {
          fileStore.release(u.fid);
          reply(sock, u.rid, { error: String(e.message || e) });
        }
        finishing = false;
        processBuf();
      });
    }
    return chunk.subarray(take);
  };

  const handleLine = (req) => {
    if (req.method === "subscribe") {
      subscribers.set(connId, { sock, nick: req.params?.nick || null });
      reply(sock, req.id, { result: { ok: true } });
      return;
    }
    if (req.method === "upload") {
      const fid = id();
      try {
        const meta = startUpload(req.params || {}, fid);
        const ws = fs.createWriteStream(partPath(fid), { mode: 0o600 });
        ws.on("error", (e) => failUpload(`storing the file on the hub: ${e.message}`));
        up = { rid: req.id, fid, meta, remaining: meta.size, ws };
        reply(sock, req.id, { result: { ready: true, fileId: fid } });
        if (meta.size === 0) feed(Buffer.alloc(0));
      } catch (e) {
        reply(sock, req.id, { error: String(e.message || e) });
      }
      return;
    }
    if (req.method === "download") {
      try { fileStore.prune(); } catch (e) { return reply(sock, req.id, { error: String(e.message || e) }); }
      const f = state.files[req.params?.fileId];
      if (!f) return reply(sock, req.id, { error: `no file ${req.params?.fileId}` });
      if (!f.stored) {
        const why = f.expired ? `expired (${f.expiredBy === "space" ? "the hub needed the space" : "past its time to live"})` : `not stored on the hub (shared as a path: ${f.path})`;
        return reply(sock, req.id, { error: `file ${f.id} (${f.name}) is ${why}` });
      }
      const rs = fs.createReadStream(blobPath(f.id));
      rs.on("open", () => { reply(sock, req.id, { result: { file: f } }); rs.pipe(sock); });
      rs.on("error", (e) => { reply(sock, req.id, { error: `reading ${f.id}: ${e.message}` }); sock.end(); });
      return "stop";
    }
    const handler = handlers[req.method];
    if (!handler) return reply(sock, req.id, { error: `unknown method ${req.method}` });
    try {
      reply(sock, req.id, { result: handler(req.params || {}) });
    } catch (e) {
      reply(sock, req.id, { error: String(e.message || e) });
    }
  };

  let stopped = false;
  // Handle the requests in buf, until an upload takes over the connection.
  const processBuf = () => {
    let idx;
    while (!stopped && !up && !finishing && (idx = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf8").trim();
      buf = buf.subarray(idx + 1);
      if (!line) continue;
      let req; try { req = JSON.parse(line); } catch { continue; }
      if (handleLine(req) === "stop") { stopped = true; return; }
      if (up && buf.length) { const rest = buf; buf = Buffer.alloc(0); buf = feed(rest); }
    }
  };
  sock.on("data", (d) => {
    if (stopped) return;
    if (up) d = feed(d);
    if (d.length) buf = buf.length ? Buffer.concat([buf, d]) : d;
    processBuf();
  });
  sock.on("close", () => {
    failUpload(null);
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
let pruneTimer = null;

export async function startHub({ silent = false } = {}) {
  // Never take over a socket that answers: it's a running hub, or a tunnel
  // to one, and replacing it would split the chat in two.
  if (await socketAlive(SOCKET_PATH)) throw new Error(`a hub (or a tunnel to one) is already answering on ${SOCKET_PATH}`);
  if (path.resolve(SOCKET_PATH).startsWith(path.resolve(TUNNELS_DIR) + path.sep)) {
    throw new Error(`${SOCKET_PATH} is a tunnel's socket; start the tunnel (nchat tunnel), not a hub`);
  }
  loadConfig(); // a broken config fails the start, not the first upload
  loadState();
  fileStore.prune();
  pruneTimer = setInterval(() => { try { fileStore.prune(); } catch (e) { console.error(`nchat hub: pruning files: ${e.message}`); } }, 60_000);
  pruneTimer.unref();
  nq.reset();
  syncNqueue();
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
  clearInterval(pruneTimer);
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
  startHub().catch((e) => { console.error(`nchat hub: ${e.message}`); process.exit(1); });
}
