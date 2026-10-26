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
const events = lines.map(fmt).filter(Boolean);
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
  // nothing more can arrive once this session's `nchat listen` is gone
  const listening = () => {
    try { process.kill(Number(fs.readFileSync(path.join(spoolDir, `${sid}.pid`), "utf8")), 0); return true; } catch { return false; }
  };
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
