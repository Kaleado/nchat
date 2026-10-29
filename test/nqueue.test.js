// Delivery through nqueue, end to end: the hub publishes to nqueue queues,
// and agents read them with `nqueue dequeue`, as the nqueue plugin and
// extension do. Needs nqueue (NQUEUE_BIN, default `nqueue` on PATH) and
// valkey-server (on PATH, or NQUEUE_VALKEY_SERVER); skipped without them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-nqueue-"));
process.env.NCHAT_SOCKET = path.join(TMP, "hub.sock");
process.env.NCHAT_DATA = path.join(TMP, "data");
process.env.NQUEUE_HOME = path.join(TMP, "nqueue");
delete process.env.NCHAT_NQUEUE;
delete process.env.NQUEUE_ID;
delete process.env.NQUEUE_VALKEY;
const NQUEUE_BIN = process.env.NQUEUE_BIN || "nqueue";
const VALKEY = process.env.NQUEUE_VALKEY_SERVER || "valkey-server";
const available = (bin) => spawnSync(bin, ["--version"]).status === 0;
const skip = !available(NQUEUE_BIN) ? `${NQUEUE_BIN} not found` : !available(VALKEY) ? `${VALKEY} not found` : false;

const { startHub, stopHub } = await import("../lib/hub.js");
const { call } = await import("../lib/common.js");

function nq(args, as) {
  const env = { ...process.env };
  if (as) env.NQUEUE_ID = as;
  const r = spawnSync(NQUEUE_BIN, args, { encoding: "utf8", env });
  assert.equal(r.status, 0, `nqueue ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// What the nqueue plugin would deliver to agent `id` now.
function deliveries(id, urgentOnly = false) {
  const out = nq(["dequeue", ...(urgentOnly ? ["--urgent-only"] : [])], id);
  return out ? out.split("\n").map((l) => JSON.parse(l).message) : [];
}
const bodies = (id, urgentOnly) => deliveries(id, urgentOnly).map((m) => m.body);

before(async () => {
  if (skip) return;
  await startHub({ silent: true }); // starts nqueue's server too
  // two agent sessions, registered with nqueue by its plugin
  nq(["register", "alice"]);
  nq(["register", "bob"]);
  for (const nick of ["alice", "bob"]) {
    await call("register", { nick });
    await call("join", { nick, channel: "general" });
  }
});

after(async () => {
  if (!skip) {
    await stopHub();
    spawnSync("pkill", ["-f", path.join(TMP, "nqueue", "valkey.sock")]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("channel posts reach other members, not the sender", { skip }, async () => {
  const { message } = await call("send", { from: "alice", channel: "general", text: "hello all" });
  const got = deliveries("bob");
  assert.equal(got.length, 1);
  assert.equal(got[0].queue, "nchat.general");
  assert.equal(got[0].from, "alice");
  assert.equal(got[0].urgency, "non-urgent");
  assert.equal(got[0].body, `#general <alice> hello all  [${message.id}]`);
  assert.deepEqual(bodies("alice"), [], "no echo of your own post");
});

test("DMs are urgent, in the recipient's inbox", { skip }, async () => {
  await call("dm", { from: "alice", to: "bob", text: "got a minute?" });
  const got = deliveries("bob", true);
  assert.equal(got.length, 1);
  assert.equal(got[0].queue, "nchat.dm.bob");
  assert.match(got[0].body, /^DM from alice: got a minute\?/);
  assert.deepEqual(bodies("alice"), []);
});

test("reactions reach the message's author", { skip }, async () => {
  const { message } = await call("send", { from: "alice", channel: "general", text: "shipping it" });
  bodies("bob");
  await call("react", { by: "bob", channel: "general", messageId: message.id, reaction: "ok" });
  assert.deepEqual(bodies("alice"), [`bob reacted (ok) to your message in #general: shipping it  [${message.id}]`]);
  // toggling it off doesn't notify, and nor does reacting to your own
  await call("react", { by: "bob", channel: "general", messageId: message.id, reaction: "ok" });
  await call("react", { by: "alice", channel: "general", messageId: message.id, reaction: "done" });
  assert.deepEqual(bodies("alice"), []);
});

test("files go to the channel or the recipient", { skip }, async () => {
  await call("sendFile", { from: "alice", to: "bob", name: "r.json", size: 3, path: "/tmp/r.json" });
  assert.match(bodies("bob")[0], /^file r\.json \(3b\) from alice at \/tmp\/r\.json/);
  await call("sendFile", { from: "bob", channel: "general", name: "n.md", size: 9, path: "/tmp/n.md" });
  assert.match(bodies("alice")[0], /^#general file n\.md \(9b\) from bob/);
});

test("joining and parting subscribe and unsubscribe", { skip }, async () => {
  await call("join", { nick: "bob", channel: "dev" });
  await call("send", { from: "alice", channel: "dev", text: "in dev" });
  assert.deepEqual(bodies("bob").map((b) => b.replace(/  \[.*\]$/, "")), ["#dev <alice> in dev"]);
  await call("part", { nick: "bob", channel: "dev" });
  await call("send", { from: "alice", channel: "dev", text: "after bob left" });
  assert.deepEqual(bodies("bob"), []);
});

test("nicks that aren't agent sessions can post, and keep an inbox", { skip }, async () => {
  await call("register", { nick: "carol" }); // e.g. a human on the TUI
  await call("join", { nick: "carol", channel: "general" });
  await call("send", { from: "carol", channel: "general", text: "hi from the tui" });
  assert.match(bodies("bob")[0], /^#general <carol> hi from the tui/);
  await call("dm", { from: "bob", to: "carol", text: "hello carol" });
  // a session started as carol later gets what came meanwhile
  nq(["register", "carol"]);
  assert.match(bodies("carol").join("\n"), /DM from bob: hello carol/);
});

test("messages wait for a session that is offline", { skip }, async () => {
  nq(["unregister"], "bob");
  await call("dm", { from: "alice", to: "bob", text: "while you were out" });
  nq(["register", "bob"]);
  assert.match(bodies("bob").join("\n"), /while you were out/);
});
