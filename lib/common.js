// Shared types and helpers for nchat hub/CLI/extension.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ~/.nchat: the human's nick file, the hub's config, tunnels.
export const NCHAT_HOME = process.env.NCHAT_HOME || path.join(os.homedir(), ".nchat");
export const SOCKET_PATH = process.env.NCHAT_SOCKET || path.join(os.homedir(), ".nchat", "hub.sock");
export const NICK_FILE = path.join(NCHAT_HOME, "nick");
export const TUNNELS_DIR = path.join(NCHAT_HOME, "tunnels");
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

// Whether something (a hub, or a tunnel to one) answers on `socket`.
export function socketAlive(socket = SOCKET_PATH, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect(socket);
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.on("connect", () => { clearTimeout(t); s.end(); resolve(true); });
    s.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

// Split newline-terminated JSON lines off the front of a byte buffer,
// stopping early when `onLine` returns false. Returns the rest.
function takeLines(buf, onLine) {
  let idx;
  while ((idx = buf.indexOf(10)) !== -1) {
    const line = buf.subarray(0, idx).toString("utf8").trim();
    buf = buf.subarray(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (onLine(msg) === false) break;
  }
  return buf;
}

// Upload the file at `filePath` to the hub, streaming it: the hub first
// says whether it will take the file (size limits), then the bytes follow
// the request on the same connection. Resolves to the stored file's info.
export function upload(params, filePath) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const sock = net.connect(SOCKET_PATH);
    let buf = Buffer.alloc(0), done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      if (err) { sock.destroy(); reject(err); } else { sock.end(); resolve(result); }
    };
    sock.on("connect", () => sock.write(JSON.stringify({ id: id(), method: "upload", params: { ...params, size } }) + "\n"));
    sock.on("data", (d) => {
      buf = takeLines(Buffer.concat([buf, d]), (msg) => {
        if (msg.error) return finish(new Error(msg.error)), false;
        if (msg.result?.ready) {
          let sent = 0;
          const rs = fs.createReadStream(filePath);
          rs.on("data", (c) => { sent += c.length; });
          rs.on("error", (e) => finish(new Error(`reading ${filePath}: ${e.message}`)));
          rs.on("end", () => { if (sent !== size) finish(new Error(`${filePath} changed while it was being sent`)); });
          rs.pipe(sock, { end: false });
        } else if (msg.result?.ok) finish(null, msg.result);
      });
    });
    sock.on("error", (e) => finish(new Error(`cannot reach hub: ${e.message}`)));
    sock.on("close", () => finish(new Error("the hub closed the connection before the upload finished")));
  });
}

// Download a stored file from the hub into `dest`, via `dest`.part so a
// cut-off transfer never leaves a partial file under the real name.
export function download(fileId, dest) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET_PATH);
    const part = `${dest}.part`;
    let buf = Buffer.alloc(0), file = null, ws = null, got = 0, done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) { ws?.destroy(); try { fs.unlinkSync(part); } catch {} reject(err); } else resolve(result);
    };
    const write = (chunk) => {
      got += chunk.length;
      if (got > file.size) return finish(new Error("the hub sent more than the file's size"));
      if (!ws.write(chunk)) { sock.pause(); ws.once("drain", () => sock.resume()); }
    };
    sock.on("connect", () => sock.write(JSON.stringify({ id: id(), method: "download", params: { fileId } }) + "\n"));
    sock.on("data", (d) => {
      if (ws) return write(d);
      buf = takeLines(Buffer.concat([buf, d]), (msg) => {
        if (msg.error) return finish(new Error(msg.error)), false;
        if (!msg.result?.file) return;
        file = msg.result.file;
        ws = fs.createWriteStream(part, { mode: 0o644 });
        ws.on("error", (e) => finish(new Error(`writing ${part}: ${e.message}`)));
        return false;
      });
      if (ws && buf.length) { const rest = buf; buf = Buffer.alloc(0); write(rest); }
    });
    sock.on("end", () => {
      if (!ws) return finish(new Error("the hub closed the connection"));
      ws.end(() => {
        if (got !== file.size) return finish(new Error(`transfer cut short (${got} of ${file.size} bytes)`));
        fs.renameSync(part, dest);
        finish(null, file);
      });
    });
    sock.on("error", (e) => finish(new Error(`cannot reach hub: ${e.message}`)));
  });
}

// --- validation helpers ---
export function validNick(n) { return /^[a-zA-Z0-9_-]{1,32}$/.test(n || ""); }
export function validChannel(c) { return /^[a-zA-Z0-9_-]{1,64}$/.test(c || ""); }
export function dmKeyOf(a, b) { return [a, b].sort().join("|"); }
