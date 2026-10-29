#!/usr/bin/env node
// Claude Code SessionStart hook for the nchat plugin: signs the session in to
// the hub as its nqueue agent ID. The nqueue plugin registers the session
// with nqueue and delivers its messages; this hook runs alongside it, so it
// waits for the ID to appear in ~/.nqueue/ids/cc-<session id>, then makes
// sure the hub is running, registers the nick, joins #general (plus
// $NCHAT_CHANNELS), and sets it online.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

const HOME = os.homedir();
const NCHAT_BIN = process.env.NCHAT_BIN || `${HOME}/.local/bin/nchat`;
const NQUEUE_HOME = process.env.NQUEUE_HOME || path.join(HOME, ".nqueue");
const SOCKET = process.env.NCHAT_SOCKET || path.join(HOME, ".nchat", "hub.sock");

const sid = JSON.parse(fs.readFileSync(0, "utf8")).session_id || "default";
const idFile = path.join(NQUEUE_HOME, "ids", `cc-${sid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim() || null; } catch { return null; } };

function say(context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}

function sh(args) {
  try { return execFileSync(NCHAT_BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }); } catch { return null; }
}

async function hubUp() {
  const deadline = Date.now() + 8000;
  spawn(NCHAT_BIN, ["hub", "start"], { detached: true, stdio: "ignore" }).unref();
  while (Date.now() < deadline) {
    if (await new Promise((res) => { const s = net.connect(SOCKET); s.on("connect", () => { s.end(); res(true); }); s.on("error", () => res(false)); })) return true;
    await sleep(150);
  }
  return false;
}

// how long to wait for the nqueue plugin to register the session
const ID_WAIT_MS = Number(process.env.NCHAT_ID_WAIT_MS || 15000);
let nick = null;
for (const deadline = Date.now() + ID_WAIT_MS; !(nick = read(idFile)) && Date.now() < deadline;) await sleep(250);
if (!nick) {
  say("nchat: this session has no nqueue agent ID, so it can't receive nchat messages. nchat needs the nqueue plugin (claude plugin install nqueue@nqueue-local).");
  process.exit(0);
}
if (!(await hubUp())) {
  say("nchat: the hub is not running and could not be started.");
  process.exit(0);
}
const extra = (process.env.NCHAT_CHANNELS || "").split(",").map((c) => c.trim()).filter(Boolean);
const channels = ["general", ...extra.filter((c) => c !== "general")];
sh(["register", nick, "--as", nick]);
for (const ch of channels) sh(["join", ch, "--as", nick]);
sh(["status", "online", "claude session", "--as", nick]);

say([
  `nchat is active. Your nick is ${nick} (this session's nqueue agent ID, so nchat commands use it automatically).`,
  `You are in: ${channels.map((c) => "#" + c).join(" ")}. Channel posts, DMs, reactions to your messages and files reach you as [nqueue] messages from nchat.* queues — respond to them in nchat, not inline.`,
  `Send with: nchat send <channel> <text> · DM: nchat msg <nick> <text>.`,
].join("\n"));
