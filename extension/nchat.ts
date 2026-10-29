// nchat pi extension: signs this pi session in to the nchat hub as its
// nqueue agent ID. Messages reach the agent through nqueue: the nqueue
// extension registers the session and delivers what the hub publishes to
// its queues (nchat.<channel>, nchat.dm.<nick>). This extension only keeps
// the hub's view of the session — registered, in its channels, online.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH = process.env.NCHAT_SOCKET || path.join(os.homedir(), ".nchat", "hub.sock");
const NQUEUE_HOME = process.env.NQUEUE_HOME || path.join(os.homedir(), ".nqueue");
// #general is always joined; extra channels come from $NCHAT_CHANNELS.
const EXTRA_CHANNELS = (process.env.NCHAT_CHANNELS || "").split(",").map((c: string) => c.trim()).filter(Boolean);
const CHANNELS = [...new Set(["general", ...EXTRA_CHANNELS])];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (f: string) => { try { return fs.readFileSync(f, "utf8").trim() || null; } catch { return null; } };

// One request to the hub.
function call(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET_PATH);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("hub timeout")); }, 10000);
    sock.on("connect", () => sock.write(JSON.stringify({ id: "1", method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      clearTimeout(timer);
      sock.end();
      const msg = JSON.parse(buf.slice(0, idx));
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export default function nchatExtension(pi: ExtensionAPI) {
  // pi can load this file twice (from ~/.pi/agent/extensions and from
  // --extension): only the first copy runs
  const g = globalThis as any;
  if (g.__nchatExtensionLoaded) return;
  g.__nchatExtensionLoaded = true;
  let nick: string | null = null;
  let lastCtx: ExtensionContext | null = null;

  function notifyHuman(text: string, level = "info") {
    try { (lastCtx as any)?.ui?.notify?.(text, level); } catch {}
  }

  function updateWidget(extra?: string) {
    try {
      (lastCtx as any)?.ui?.setWidget?.(
        "nchat",
        [`nchat: ${nick ?? "-"}${extra ? ` ${extra}` : ""}${nick ? ` — DM me with: nchat msg ${nick} <text>` : ""}`],
        { placement: "belowEditor" },
      );
    } catch {}
  }

  async function offline(n: string | null) {
    if (n) await call("status", { nick: n, status: "offline" }).catch(() => {});
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    let sessionId: string | null = null;
    try { sessionId = ctx.sessionManager.getSessionId(); } catch {}
    // the nqueue extension records the session's ID; it may start after us
    const idFile = sessionId ? path.join(NQUEUE_HOME, "ids", `pi-${sessionId}`) : null;
    let next: string | null = null;
    for (let i = 0; i < 60 && !(next = (idFile && read(idFile)) || null); i++) await sleep(250);
    if (!next) {
      notifyHuman("nchat: this session has no nqueue agent ID; nchat needs the nqueue extension", "warning");
      updateWidget("(no nqueue ID)");
      return;
    }
    if (nick && nick !== next) await offline(nick); // switched sessions
    nick = next;
    try {
      await call("register", { nick, hostname: os.hostname() });
      for (const channel of CHANNELS) await call("join", { nick, channel });
      await call("status", { nick, status: "online", statusText: "pi session", ifOffline: true });
      updateWidget(`(${CHANNELS.map((c) => "#" + c).join(" ")})`);
    } catch (e) {
      notifyHuman(`nchat: could not reach the hub (${(e as Error).message}); run \`nchat hub\``, "warning");
      updateWidget("(hub unreachable)");
    }
  });

  pi.on("session_shutdown", async () => {
    g.__nchatExtensionLoaded = false; // a reload loads it afresh
    await offline(nick);
    updateWidget("(offline)");
    lastCtx = null;
  });
}
