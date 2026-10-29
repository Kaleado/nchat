// Delivery to agents through nqueue. The hub keeps chat state; nqueue gets
// each message to the agents that should see it, and the nqueue plugin or
// extension in each agent session injects it.
//
// - each channel is a broadcast queue, nchat.<channel>, its members
//   subscribed
// - each nick has an inbox queue, nchat.dm.<nick>, for DMs, reactions to its
//   messages and files sent to it
//
// Queue policies come from this repo's .nqueue.toml. A nick is an nqueue
// agent ID: an agent session's nick is its nqueue ID. Every call is
// best-effort: if nqueue is unavailable, chat still works, but agents aren't
// notified. NCHAT_NQUEUE=0 turns this off.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NQUEUE_BIN = process.env.NQUEUE_BIN || "nqueue";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const enabled = () => process.env.NCHAT_NQUEUE !== "0";

export const channelQueue = (channel) => `nchat.${channel}`;
export const inboxQueue = (nick) => `nchat.dm.${nick}`;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function agentEnv(as) {
  const env = { ...process.env };
  if (as) env.NQUEUE_ID = as;
  else delete env.NQUEUE_ID;
  return env;
}

function nq(args, as) {
  const r = spawnSync(NQUEUE_BIN, args, {
    cwd: ROOT, // so the repo config's policies apply
    encoding: "utf8",
    timeout: 5000,
    env: agentEnv(as),
  });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() || String(r.error || "") };
}

let warned = false;
function warn(what, r) {
  if (warned || process.env.NCHAT_NQUEUE_QUIET) return;
  warned = true;
  console.error(`nchat: nqueue ${what} failed, agents won't be notified until it works: ${r.stderr}`);
}

// Starts nqueue's server if it isn't running.
export function ensureServer() {
  if (!enabled() || nq(["status"]).ok) return;
  try { spawn(NQUEUE_BIN, ["daemon"], { detached: true, stdio: "ignore" }).unref(); } catch { return; }
  for (let i = 0; i < 40 && !nq(["status"]).ok; i++) sleepSync(100);
}

const agents = new Set();
const queues = new Set();

// nqueue only knows agents that registered: create nick as an offline agent
// if it's new, so it can publish and keep subscriptions until a session
// registers as it.
function ensureAgent(nick) {
  if (agents.has(nick)) return true;
  const r = nq(["register", nick]);
  if (r.ok) nq(["unregister"], nick);
  else if (!/already in use/.test(r.stderr)) { warn("register", r); return false; }
  agents.add(nick);
  return true;
}

function ensureQueue(queue, policy) {
  if (queues.has(queue)) return true;
  const r = nq(["create", queue, "--policy", policy]);
  if (!r.ok && !/already exists/.test(r.stderr)) { warn("create", r); return false; }
  queues.add(queue);
  return true;
}

function subscribeTo(nick, queue, policy) {
  if (!enabled() || !ensureAgent(nick) || !ensureQueue(queue, policy)) return;
  const r = nq(["subscribe", queue], nick);
  if (!r.ok) warn("subscribe", r);
}

// A nick exists: give it an inbox.
export function setupNick(nick) {
  subscribeTo(nick, inboxQueue(nick), "nchat-dm");
}

export function joinChannel(nick, channel) {
  subscribeTo(nick, channelQueue(channel), "nchat-channel");
}

export function partChannel(nick, channel) {
  if (!enabled()) return;
  nq(["unsubscribe", channelQueue(channel)], nick);
}

function publish(queue, policy, from, text) {
  if (!enabled() || !ensureAgent(from) || !ensureQueue(queue, policy)) return;
  const r = nq(["enqueue", queue, text], from);
  if (!r.ok) warn("enqueue", r);
}

export function postToChannel(channel, from, text) {
  publish(channelQueue(channel), "nchat-channel", from, text);
}

export function sendToInbox(nick, from, text) {
  publish(inboxQueue(nick), "nchat-dm", from, text);
}

// Forget what was set up, e.g. after nqueue's data was reset.
export function reset() {
  agents.clear();
  queues.clear();
}
