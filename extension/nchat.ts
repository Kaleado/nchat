// nchat pi extension: connects this pi session to the nchat hub and
// notifies the agent when messages, DMs, files, or presence events arrive.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH = process.env.NCHAT_SOCKET || path.join(os.homedir(), ".nchat", "hub.sock");
// Random nicks are short human-readable names (e.g. "swift-otter-42").
const ADJECTIVES = ["swift", "brave", "calm", "clever", "eager", "gentle", "jolly", "lucky", "mellow", "nimble", "quiet", "sunny", "witty", "zesty"];
const NOUNS = ["otter", "fox", "hawk", "lynx", "badger", "heron", "ibex", "raven", "stoat", "tapir", "wombat", "gecko", "puffin", "marmot"];
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
const randomNick = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(Math.random() * 90) + 10}`;
const NICKS_DIR = path.join(path.dirname(SOCKET_PATH), "nicks");
// Identity: $NCHAT_NICK, else the nick recorded for this pi *session*
// (nicks/pi-<session id>, kept across restarts and reloads, so a resumed
// session keeps its nick), else a random one, recorded there. The pid file
// nicks/<pid> mirrors it for the CLI, which finds its pi session's nick by
// walking up the process tree; it goes when the process does.
const PID_FILE = path.join(NICKS_DIR, String(process.pid));
const read = (f: string) => { try { return fs.readFileSync(f, "utf8").trim() || null; } catch { return null; } };
function resolveNick(sessionId: string | null): string {
  if (process.env.NCHAT_NICK) return process.env.NCHAT_NICK;
  const sessionFile = sessionId ? path.join(NICKS_DIR, `pi-${sessionId}`) : null;
  const nick = (sessionFile && read(sessionFile)) || read(PID_FILE) || randomNick();
  try {
    fs.mkdirSync(NICKS_DIR, { recursive: true });
    if (sessionFile && read(sessionFile) !== nick) fs.writeFileSync(sessionFile, nick + "\n");
    if (read(PID_FILE) !== nick) fs.writeFileSync(PID_FILE, nick + "\n");
  } catch {}
  return nick;
}
let NICK = process.env.NCHAT_NICK || read(PID_FILE) || "";

// Clean up pid nick files from dead processes (pi-<session> files stay).
try {
  for (const f of fs.readdirSync(NICKS_DIR)) {
    if (!/^\d+$/.test(f)) continue;
    const pid = parseInt(f, 10);
    if (pid !== process.pid) {
      try { process.kill(pid, 0); } catch {
        try { fs.unlinkSync(path.join(NICKS_DIR, f)); } catch {}
      }
    }
  }
} catch {}
// Set NCHAT_NOTIFY_TURN=0 to only queue notifications (agent sees them on
// its next interaction) instead of waking the agent with a turn.
const TRIGGER_TURNS = process.env.NCHAT_NOTIFY_TURN !== "0";
const BATCH_MS = 1500; // coalesce bursts of messages into one notification
// Channels this session joins automatically (comma-separated).
// #general is always joined; extra channels come from $NCHAT_CHANNELS.
const EXTRA_CHANNELS = (process.env.NCHAT_CHANNELS || "").split(",").map((c: string) => c.trim()).filter(Boolean);
const CHANNELS = [...new Set(["general", ...EXTRA_CHANNELS])];

interface EventMsg { event: string; [k: string]: unknown }

export default function nchatExtension(pi: ExtensionAPI) {
  // pi can load this file twice (from ~/.pi/agent/extensions and from
  // --extension): only the first copy connects, or every event comes twice
  const g = globalThis as any;
  if (g.__nchatExtensionLoaded) return;
  g.__nchatExtensionLoaded = true;
  let sock: net.Socket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCtx: ExtensionContext | null = null;
  let generation = 0; // bumped on every connect; stale sockets' handlers no-op
  const seenIds = new Set<string>(); // dedupe event ids across sockets/retries

  let pending: string[] = [];       // messages batched for the model
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;                 // a run is in progress

  function fmtEvent(msg: EventMsg): string | null {
    if (msg.event === "message" && msg.message) {
      const m = msg.message as any;
      if (m.from === NICK) return null;
      if (m.type === "join" || m.type === "part") return null;
      return `#${m.channel} <${m.from}> ${m.text}`;
    }
    if (msg.event === "dm" && msg.message) {
      const m = msg.message as any;
      if (m.from === NICK) return null;
      return `DM from ${m.from}: ${m.text}`;
    }
    if (msg.event === "reaction" && msg.message) {
      const m = msg.message as any;
      if (m.from !== NICK) return null; // only surface reactions to our own messages
      const where = m.channel ? `#${m.channel}` : "DM";
      return `${(msg as any).by} reacted (${(msg as any).reaction}) to your message in ${where}: ${String(m.text).slice(0, 80)}`;
    }
    if (msg.event === "file" && msg.file) {
      const f = msg.file as any;
      if (f.from === NICK) return null;
      return `file ${f.name} (${f.size}b) from ${f.from}${f.to ? ` (to you)` : ` in #${f.channel}`}`;
    }
    return null; // presence and other events are UI-only
  }

  function notifyHuman(text: string) {
    try {
      (lastCtx as any)?.ui?.notify?.(text, "info");
    } catch {}
  }

  function updateWidget(extra?: string) {
    try {
      (lastCtx as any)?.ui?.setWidget?.(
        "nchat",
        [`nchat: ${NICK}${extra ? ` ${extra}` : ""} — DM me with: nchat msg ${NICK} <text>`],
        { placement: "belowEditor" },
      );
    } catch {}
  }

  function queue(text: string, dedupeId?: string) {
    if (dedupeId) {
      if (seenIds.has(dedupeId)) return;
      seenIds.add(dedupeId);
      if (seenIds.size > 1000) {
        // bound memory: drop the oldest quarter
        const it = seenIds.values();
        for (let i = 0; i < 250; i++) {
          const v = it.next().value;
          if (v !== undefined) seenIds.delete(v);
        }
      }
    }
    pending.push(text);
    if (flushTimer) return;
    flushTimer = setTimeout(flush, BATCH_MS);
  }

  function flush() {
    flushTimer = null;
    const lines = pending.splice(0, pending.length);
    if (!lines.length) return;
    notifyHuman(`nchat: ${lines.length} new message(s)`);
    if (TRIGGER_TURNS) {
      // Wake the agent: starts a run when idle, queues a follow-up while busy.
      pi.sendMessage(
        { customType: "nchat-notification", content: `[nchat notification]\n${lines.join("\n")}`, display: true },
        { triggerTurn: true, deliverAs: busy ? "followUp" : undefined },
      );
    } else {
      // Deliver without waking; the model sees it on its next interaction.
      pi.sendMessage(
        { customType: "nchat-notification", content: `[nchat notification]\n${lines.join("\n")}`, display: true },
        { triggerTurn: false },
      );
    }
  }

  function disconnectCurrent() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock) {
      const old = sock;
      sock = null;
      old.removeAllListeners();
      old.destroy();
    }
  }

  function connect() {
    if (closed) return;
    disconnectCurrent(); // never leak a previous (still-subscribed) socket
    const gen = ++generation;
    const mySock = net.connect(SOCKET_PATH);
    sock = mySock;
    mySock.on("connect", () => {
      if (gen !== generation || closed) return;
      mySock.write(JSON.stringify({ id: "sub", method: "subscribe", params: { nick: NICK } }) + "\n");
      mySock.write(JSON.stringify({ id: "reg", method: "register", params: { nick: NICK, hostname: os.hostname() } }) + "\n");
      mySock.write(JSON.stringify({ id: "st", method: "status", params: { nick: NICK, status: "online", statusText: "pi session" } }) + "\n");
      for (const ch of CHANNELS) {
        mySock.write(JSON.stringify({ id: `join:${ch}`, method: "join", params: { nick: NICK, channel: ch } }) + "\n");
      }
      updateWidget(`(${CHANNELS.map((c) => "#" + c).join(" ")})`);
    });
    let myBuffer = ""; // per-socket: no interleaving from stale sockets
    mySock.on("data", (d) => {
      if (gen !== generation || closed) return;
      myBuffer += d;
      let idx: number;
      while ((idx = myBuffer.indexOf("\n")) !== -1) {
        const line = myBuffer.slice(0, idx); myBuffer = myBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (!msg.event) continue;
        if (msg.event === "presence") {
          notifyHuman(`nchat: ${(msg as any).nick} is ${(msg as any).status}`);
          continue;
        }
        const text = fmtEvent(msg);
        if (text) queue(text, msg.message?.id ?? msg.file?.id);
      }
    });
    mySock.on("error", () => scheduleReconnect());
    mySock.on("close", () => {
      if (gen !== generation || closed) return; // replaced on purpose; ignore
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    closed = false;
    busy = false;
    // the session (and so the nick) is known only now; a resume, new or
    // fork can change it, and then the connection is redone as the new nick
    let sessionId: string | null = null;
    try { sessionId = ctx.sessionManager.getSessionId(); } catch {}
    const nick = resolveNick(sessionId);
    if (nick !== NICK || !sock) {
      if (sock && NICK) {
        try { sock.write(JSON.stringify({ id: "off", method: "status", params: { nick: NICK, status: "offline" } }) + "\n"); } catch {}
      }
      NICK = nick;
      connect();
    }
    updateWidget(`(${CHANNELS.map((c) => "#" + c).join(" ")})`);
  });

  pi.on("agent_start", async () => { busy = true; });
  pi.on("agent_end", async () => { busy = false; });

  pi.registerCommand("nchat-reconnect", {
    description: "Reconnect the nchat extension to the hub",
    handler: async () => {
      connect(); // handles teardown of any existing connection itself
    },
  });

  pi.on("session_shutdown", async () => {
    closed = true;
    g.__nchatExtensionLoaded = false; // a reload loads it afresh
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    try { fs.unlinkSync(PID_FILE); } catch {}
    // send offline status before teardown
    if (sock) {
      try {
        sock.write(JSON.stringify({ id: "off", method: "status", params: { nick: NICK, status: "offline" } }) + "\n");
      } catch {}
    }
    disconnectCurrent();
    updateWidget("(offline)");
    pending = [];
    lastCtx = null;
  });
}
