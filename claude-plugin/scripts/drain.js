#!/usr/bin/env node
// Claude Code nchat plugin: drain hook.
// Runs on UserPromptSubmit and PostToolUse (and on Stop as a fallback check): reads new events
// from this session's spool file and either injects them as context or, on
// Stop, blocks the stop so Claude is woken to handle new messages — mirroring
// the pi extension's queue + triggerTurn behavior.
// "Wait" mode is an asyncRewake hook: it stays in the background while the
// session is idle and, once messages arrive, exits 2 with them on stderr,
// which wakes Claude.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";

const HOME = os.homedir();
const NICKS_DIR = path.join(HOME, ".nchat", "nicks");
const spoolDir = path.join(HOME, ".nchat", "spool");
const BATCH_MS = 1500;
const MAX_LINES = 40;
const POLL_MS = 1000;

const eventName = process.argv[2] || "UserPromptSubmit";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const sid = input.session_id || "default";
const spoolFile = path.join(spoolDir, `${sid}.log`);
const offFile = path.join(spoolDir, `${sid}.off`);
// the newest event delivered so far: replays of older ones are dropped
const ackedFile = path.join(spoolDir, `${sid}.acked`);
const NCHAT_BIN = process.env.NCHAT_BIN || `${HOME}/.local/bin/nchat`;
// this session's nick, as session-start.js recorded it (hooks only see
// NCHAT_NICK if it was set before Claude Code started)
const NICK = process.env.NCHAT_NICK || (() => {
  try { return fs.readFileSync(path.join(NICKS_DIR, `cc-${sid}`), "utf8").trim() || null; } catch { return null; }
})();

function fmt(e) {
  try {
    const msg = JSON.parse(e);
    if (!msg.event) return null;
    if (msg.event === "message" && msg.message) {
      const m = msg.message;
      if (NICK && m.from === NICK) return null; // self-echo filter
      if (m.type === "join" || m.type === "part") return null;
      return `#${m.channel} <${m.from}> ${m.text}`;
    }
    if (msg.event === "dm" && msg.message) {
      const m = msg.message;
      if (NICK && m.from === NICK) return null;
      return `DM from ${m.from}: ${m.text}`;
    }
    if (msg.event === "reaction" && msg.message && NICK && msg.message.from !== NICK) return null;
    if (msg.event === "reaction" && msg.message) return `${msg.by} reacted (${msg.reaction}) to your message: ${String(msg.message.text).slice(0, 80)}`;
    if (msg.event === "file" && msg.file) return `file ${msg.file.name} (${msg.file.size}b) from ${msg.file.from}`;
    return null;
  } catch { return null; }
}

// read only the not-yet-delivered tail of the spool, mark it delivered, and
// return its events
function drain() {
let raw = "";
try { raw = fs.readFileSync(spoolFile, "utf8"); } catch {}
let off = 0;
try { off = parseInt(fs.readFileSync(offFile, "utf8").trim(), 10) || 0; } catch {}
const newData = raw.slice(off);
const lines = newData.split("\n").filter(Boolean);
// drop what was delivered already (a reconnecting listener replays
// everything not acked yet) and repeats within the batch
let acked = 0;
try { acked = Number(fs.readFileSync(ackedFile, "utf8")) || 0; } catch {}
let newest = acked;
const ids = new Set();
const fresh = lines.filter((l) => {
  let e; try { e = JSON.parse(l); } catch { return false; }
  const item = e.message || e.file;
  if (!item?.ts) return true; // reactions, presence: no ts
  if (item.ts <= acked || ids.has(item.id)) return false;
  ids.add(item.id);
  newest = Math.max(newest, item.ts);
  return true;
});
const events = fresh.map(fmt).filter(Boolean);
if (newest > acked) {
  fs.writeFileSync(ackedFile, String(newest));
  // and to the hub, so a later listener (resume, restart) starts after them
  if (NICK) { try { execFileSync(NCHAT_BIN, ["ack", String(newest), "--as", NICK], { stdio: "ignore", timeout: 5000 }); } catch {} }
}
const seen = lines.join("\n").length + (lines.length ? 1 : 0);
const newOff = off + (lines.length ? seen : 0);

// keep only trailing complete lines as consumed (partial last line stays pending)
let consumed = 0;
const lastNl = raw.lastIndexOf("\n", off + newData.length - 1);
if (lastNl >= off) consumed = lastNl + 1 - off;
const finalOff = off + consumed;

fs.writeFileSync(offFile, String(finalOff));
return events;
}

// This session's `nchat listen`: found by its command line (the session's
// nick file, which it follows), else by the pid file. If there is none (it
// crashed, or the pid file is stale), a new one is started: without it
// nothing reaches the spool and the session goes deaf. It replays what the
// hub has that wasn't acked, so nothing is lost meanwhile.
const nickFile = path.join(NICKS_DIR, `cc-${sid}`);
const pidFile = path.join(spoolDir, `${sid}.pid`);
function listenerPid() {
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
        if (argv.includes("listen") && argv.includes(nickFile)) return Number(entry);
      } catch {}
    }
  } catch {}
  try { const pid = Number(fs.readFileSync(pidFile, "utf8")); process.kill(pid, 0); return pid; } catch { return null; }
}
function ensureListener() {
  let pid = listenerPid();
  if (!pid && NICK) {
    try {
      const child = spawn(NCHAT_BIN, ["listen", "--as", NICK, "--follow", nickFile], {
        detached: true, stdio: ["ignore", fs.openSync(spoolFile, "a"), "ignore"],
      });
      child.unref();
      pid = child.pid;
    } catch {}
  }
  if (pid) { try { if (Number(fs.readFileSync(pidFile, "utf8")) !== pid) throw 0; } catch { fs.writeFileSync(pidFile, String(pid)); } }
  return pid;
}

function pending() {
  let size = 0, off = 0;
  try { size = fs.statSync(spoolFile).size; } catch {}
  try { off = parseInt(fs.readFileSync(offFile, "utf8").trim(), 10) || 0; } catch {}
  return size > off;
}

if (eventName === "Wait") {
  // one waiter per session: the newest replaces any earlier one, and
  // session-end removes the pid file (and stops us)
  const waitFile = path.join(spoolDir, `${sid}.wait`);
  try { const old = Number(fs.readFileSync(waitFile, "utf8")); if (old && old !== process.pid) process.kill(old); } catch {}
  fs.writeFileSync(waitFile, String(process.pid));
  const mine = () => { try { return Number(fs.readFileSync(waitFile, "utf8")) === process.pid; } catch { return false; } };
  // keep this session's listener running (session-end stops us through
  // the wait file); without a nick there's nothing to listen as
  const listening = () => !!ensureListener();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(2 * BATCH_MS); // let the synchronous Stop drain take what's already there
  for (;;) {
    if (!mine() || !listening()) process.exit(0);
    if (pending()) {
      await sleep(BATCH_MS); // let a burst of messages arrive together
      const events = drain();
      if (events.length) {
        try { fs.unlinkSync(waitFile); } catch {}
        process.stderr.write(`[nchat] new messages:\n${events.slice(-MAX_LINES).join("\n")}\nRespond in nchat (nchat send / nchat msg) to whoever is waiting, or just react ok (nchat react ok <id>) if you have nothing to add.`);
        process.exit(2);
      }
    }
    await sleep(POLL_MS);
  }
}

ensureListener();
const events = drain();
if (events.length) {
  const batch = events.slice(-MAX_LINES).join("\n");
  if (eventName === "Stop") {
    // wake Claude to handle the new messages
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[nchat] new messages:\n${batch}\nRespond in nchat (nchat send / nchat msg) to whoever is waiting, or just react ok (nchat react ok <id>) if you have nothing to add.`,
    }));
  } else {
    // UserPromptSubmit, or PostToolUse: delivered mid-turn, between tool calls
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: `[nchat notification]\n${batch}\nRespond in nchat, or react ok if you have nothing to add.` },
    }));
  }
} else if (eventName === "Stop") {
  // nothing new: allow stop but remind politely (no output = allow)
  process.exit(0);
}
