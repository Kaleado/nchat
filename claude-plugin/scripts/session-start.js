#!/usr/bin/env node
// Claude Code SessionStart hook for the nchat plugin.
// Mirrors the pi extension: ensure hub, resolve a per-session nick, register,
// join #general, set status online, and start a background listener that
// spools live events for the drain/stop hooks to deliver.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

const HOME = os.homedir();
const NCHAT_DIR = path.join(HOME, ".nchat");
const NCHAT_BIN = process.env.NCHAT_BIN || `${HOME}/.local/bin/nchat`;

const ADJECTIVES = ["swift", "brave", "calm", "clever", "eager", "gentle", "jolly", "lucky", "mellow", "nimble", "quiet", "sunny", "witty", "zesty"];
const NOUNS = ["otter", "fox", "hawk", "lynx", "badger", "heron", "ibex", "raven", "stoat", "tapir", "wombat", "gecko", "puffin", "marmot"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randomNick = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(Math.random() * 90) + 10}`;

const sid = JSON.parse(fs.readFileSync(0, "utf8")).session_id || "default";
const nickDir = path.join(NCHAT_DIR, "nicks");
const nickFile = path.join(nickDir, `cc-${sid}`);
const spoolDir = path.join(NCHAT_DIR, "spool");
const spoolFile = path.join(spoolDir, `${sid}.log`);

function sh(args, opts = {}) {
  try { return execFileSync(NCHAT_BIN, args, { encoding: "utf8", ...opts }); } catch { return null; }
}

// wait for the hub socket (start it if needed)
async function waitForHub() {
  const sockPath = process.env.NCHAT_SOCKET || path.join(NCHAT_DIR, "hub.sock");
  const deadline = Date.now() + 8000;
  spawn(NCHAT_BIN, ["hub", "start"], { detached: true, stdio: "ignore" }).unref();
  while (Date.now() < deadline) {
    if (await new Promise((res) => { const s = net.connect(sockPath); s.on("connect", () => { s.end(); res(true); }); s.on("error", () => res(false)); })) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const nick = process.env.NCHAT_NICK || (() => { try { return fs.readFileSync(nickFile, "utf8").trim() || null; } catch { return null; } })() || randomNick();
fs.mkdirSync(nickDir, { recursive: true });
fs.writeFileSync(nickFile, nick + "\n");
// and under the claude process's pid, where the nchat CLI (run from this
// session's Bash tool) finds it by walking up its process tree
function claudePid() {
  let pid = process.ppid;
  for (let hops = 0; hops < 16 && pid > 1; hops++) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (argv.some((a) => a.slice(a.lastIndexOf("/") + 1) === "claude")) return pid;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = parseInt(stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[1], 10);
    } catch { return null; }
  }
  return null;
}
const ownerPid = claudePid();
if (ownerPid) fs.writeFileSync(path.join(nickDir, String(ownerPid)), nick + "\n");
// Per-session env so `nchat send` (without --as) uses this session's nick.
// Claude Code sources $CLAUDE_ENV_FILE before each Bash command; the
// per-session file is there to source by hand. (One shared ~/.nchat/cc-env
// let concurrent sessions overwrite each other's nick.)
const envLine = `export NCHAT_NICK=${nick}\n`;
const envFile = path.join(NCHAT_DIR, `cc-env-${sid}`);
fs.writeFileSync(envFile, envLine);
if (process.env.CLAUDE_ENV_FILE) {
  try { fs.appendFileSync(process.env.CLAUDE_ENV_FILE, envLine); } catch {}
}
fs.mkdirSync(spoolDir, { recursive: true });

await waitForHub();
sh(["register", nick]);
sh(["join", "general", "--as", nick]);
sh(["status", "online", "claude session", "--as", nick]);

// start the event listener spooling to the session file
try { fs.unlinkSync(spoolFile); } catch {}
const pidFile = path.join(spoolDir, `${sid}.pid`);
try { process.kill(Number(fs.readFileSync(pidFile, "utf8"))); } catch {} // resume/clear: replace the old listener
const child = spawn(NCHAT_BIN, ["listen", "--as", nick], { detached: true, stdio: ["ignore", fs.openSync(spoolFile, "a"), "ignore"] });
child.unref();
fs.writeFileSync(pidFile, String(child.pid)); // session-end stops it
fs.writeFileSync(path.join(spoolDir, `${sid}.off`), "0");

const extra = (process.env.NCHAT_CHANNELS || "").split(",").map((c) => c.trim()).filter(Boolean);
const channels = ["general", ...extra.filter((c) => c !== "general")];
for (const ch of extra) sh(["join", ch, "--as", nick]);

const context = [
  `nchat is active. Your nick is ${nick} (identity: pass --as ${nick} to nchat, or \`source ${envFile}\`).`,
  `You are in: ${channels.map((c) => "#" + c).join(" ")}. Incoming messages, DMs, reactions, and file offers will be delivered to you automatically — respond to nchat messages in nchat, not inline.`,
  `Send with: nchat send <channel> <text> --as ${nick} · DM: nchat msg <nick> <text> --as ${nick}.`,
].join("\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
}));
