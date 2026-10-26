// Shared types and helpers for nchat hub/CLI/extension.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const SOCKET_PATH = process.env.NCHAT_SOCKET || path.join(os.homedir(), ".nchat", "hub.sock");
export const DATA_DIR = process.env.NCHAT_DATA || path.join(os.homedir(), ".nchat", "data");
export const PID_FILE = path.join(path.dirname(SOCKET_PATH), "hub.pid");

// --- hub process management (pid file + safe kill) ---
export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const DEFAULT_SOCKET = path.join(os.homedir(), ".nchat", "hub.sock");

function cmdlineIsHub(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    if (!/hub\.js/.test(cmd) && !/nchat-hub/.test(cmd)) return false;
    // Scope to this socket: a hub's effective socket comes from its environ,
    // falling back to the default path. Without this, a fallback scan could
    // match an unrelated hub instance listening on a different socket.
    const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    const m = env.match(/NCHAT_SOCKET=([^\0]*)/);
    const theirSocket = m ? m[1] : DEFAULT_SOCKET;
    return theirSocket === SOCKET_PATH;
  } catch { return false; }
}

// Returns the live hub pid from the pid file, or null.
export function readHubPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (pid && isAlive(pid) && cmdlineIsHub(pid)) return pid;
  } catch {}
  return null;
}

export function writePidFile(pid) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

export function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// Stop a running hub gracefully: SIGTERM, wait, SIGKILL if needed.
export async function stopHubProcess({ timeout = 5000 } = {}) {
  let pid = readHubPid();
  if (!pid) {
    // fallback: scan /proc for a hub process (e.g. pid file lost)
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const p = parseInt(entry, 10);
      if (p === process.pid) continue;
      if (cmdlineIsHub(p)) { pid = p; break; }
    }
  }
  if (!pid) return { stopped: false, reason: "not running" };
  try { process.kill(pid, "SIGTERM"); } catch (e) {
    if (e.code === "ESRCH") { removePidFile(); return { stopped: false, reason: "not running" }; }
    throw e;
  }
  const deadline = Date.now() + timeout;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    deadline && await new Promise((r) => setTimeout(r, 300));
  }
  removePidFile();
  return { stopped: isAlive(pid) ? false : true, pid, killed: isAlive(pid) ? false : true };
}

export const id = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const now = () => Date.now();

export function dataPath(...parts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, ...parts);
}

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// --- JSON-RPC-ish client over unix socket ---
export function call(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET_PATH);
    let buf = "";
    const timeout = setTimeout(() => { sock.destroy(); reject(new Error("hub timeout")); }, 10000);
    sock.on("connect", () => sock.write(JSON.stringify({ id: id(), method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id) { clearTimeout(timeout); sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.result); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timeout); reject(new Error(`cannot reach hub: ${e.message}`)); });
  });
}

// --- validation helpers ---
export function validNick(n) { return /^[a-zA-Z0-9_-]{1,32}$/.test(n || ""); }
export function validChannel(c) { return /^[a-zA-Z0-9_-]{1,64}$/.test(c || ""); }
export function dmKeyOf(a, b) { return [a, b].sort().join("|"); }
