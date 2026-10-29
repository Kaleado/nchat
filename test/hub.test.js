// Integration tests: hub API over its unix socket, with isolated state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-test-"));
process.env.NCHAT_SOCKET = path.join(TMP, "hub.sock");
process.env.NCHAT_DATA = path.join(TMP, "data");
process.env.NCHAT_NQUEUE = "0"; // delivery through nqueue is tested in nqueue.test.js

const { startHub, stopHub } = await import("../lib/hub.js");
const { call } = await import("../lib/common.js");

before(async () => { await startHub({ silent: true }); });
after(async () => { await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

// subscriber helper: raw connection receiving events
async function subscribe(nick, extra = {}) {
  return await new Promise((resolve) => {
    const sock = net.connect(process.env.NCHAT_SOCKET);
    const events = [];
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "s1", method: "subscribe", params: { nick, ...extra } }) + "\n");
      resolve({ sock, events });
    });
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event) events.push(msg);
      }
    });
  });
}
const drain = async (sub) => { const s = await sub; await new Promise((r) => setTimeout(r, 100)); return s.events.splice(0); };

test("register creates and returns user", async () => {
  const r = await call("register", { nick: "alice", hostname: "h1" });
  assert.equal(r.ok, true);
  assert.equal(r.user.nick, "alice");
  assert.equal(r.user.hostname, "h1");
});

test("register rejects invalid nicknames", async () => {
  await assert.rejects(() => call("register", { nick: "bad nick" }), /invalid nickname/);
});

test("join adds member and emits system message to subscribers", async () => {
  const sub = await subscribe("bob");
  await call("register", { nick: "bob" });
  await drain(await Promise.resolve(sub)); // clear register side effects
  const r = await call("join", { nick: "bob", channel: "general" });
  assert.equal(r.ok, true);
  assert.ok(r.channel.members.includes("bob"));
  await new Promise((r) => setTimeout(r, 100));
  const joins = sub.events.filter((e) => e.event === "message" && e.message?.type === "join");
  assert.equal(joins.length, 1);
  assert.match(joins[0].message.text, /bob joined #general/);
  sub.sock.end();
});

test("join rejects invalid channel names", async () => {
  await assert.rejects(() => call("join", { nick: "alice", channel: "#bad name" }), /invalid channel/);
});

test("send delivers message to channel subscriber and history", async () => {
  await call("join", { nick: "alice", channel: "room1" });
  const sub = await subscribe("alice");
  await drain(sub);
  const r = await call("send", { from: "alice", channel: "room1", text: "hello room" });
  assert.equal(r.ok, true);
  await new Promise((r) => setTimeout(r, 100));
  const msgs = sub.events.filter((e) => e.event === "message" && e.message?.text === "hello room");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].channel, "room1");
  sub.sock.end();
  const h = await call("history", { channel: "room1" });
  assert.ok(h.messages.some((m) => m.text === "hello room" && m.from === "alice"));
});

test("history rejects unknown channel", async () => {
  await assert.rejects(() => call("history", { channel: "nope" }), /unknown channel/);
});

test("dm delivers to recipient subscriber, rejects unknown user", async () => {
  const sub = await subscribe("bob");
  await drain(sub);
  const r = await call("dm", { from: "alice", to: "bob", text: "psst" });
  assert.equal(r.ok, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sub.events.some((e) => e.event === "dm" && e.message.text === "psst" && e.message.from === "alice"));
  sub.sock.end();
  await assert.rejects(() => call("dm", { from: "alice", to: "ghost", text: "hi" }), /unknown user/);
});

test("dmHistory is symmetric", async () => {
  const a = await call("dmHistory", { a: "alice", b: "bob" });
  const b = await call("dmHistory", { a: "bob", b: "alice" });
  assert.equal(a.messages.length, b.messages.length);
  assert.ok(a.messages.some((m) => m.text === "psst"));
});

test("status changes presence and broadcasts", async () => {
  const sub = await subscribe("carol");
  await call("register", { nick: "carol" });
  await drain(sub);
  await call("status", { nick: "alice", status: "away", statusText: "brb" });
  await new Promise((r) => setTimeout(r, 100));
  const p = sub.events.find((e) => e.event === "presence" && e.nick === "alice");
  assert.equal(p.status, "away");
  assert.equal(p.statusText, "brb");
  sub.sock.end();
  const { users } = await call("users", {});
  const alice = users.find((u) => u.nick === "alice");
  assert.equal(alice.status, "away");
});

test("whoami errors on unknown user", async () => {
  await assert.rejects(() => call("whoami", { nick: "ghost" }), /unknown user/);
});

test("sendFile notifies target and files lists it", async () => {
  const sub = await subscribe("bob");
  await drain(sub);
  const r = await call("sendFile", { from: "alice", to: "bob", name: "x.txt", size: 3, path: "/tmp/x.txt" });
  assert.equal(r.ok, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sub.events.some((e) => e.event === "file" && e.file.name === "x.txt"));
  sub.sock.end();
  const { files } = await call("files", {});
  assert.ok(files.some((f) => f.name === "x.txt" && f.to === "bob"));
});

test("topic set broadcast", async () => {
  const sub = await subscribe("alice");
  await drain(sub);
  await call("topic", { channel: "room1", topic: "Testing", by: "alice" });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sub.events.some((e) => e.event === "message" && e.message.type === "topic"));
  sub.sock.end();
  const { channels } = await call("channels", {});
  assert.equal(channels.find((c) => c.name === "room1").topic, "Testing");
});

test("state persists across hub restart", async () => {
  await stopHub();
  await startHub({ silent: true });
  const { channels } = await call("channels", {});
  assert.ok(channels.find((c) => c.name === "room1" && c.topic === "Testing"));
  const { users } = await call("users", {});
  assert.ok(users.find((u) => u.nick === "alice"));
});

test("subscriber disconnect marks user offline", async () => {
  const sub = await subscribe("dave");
  await call("register", { nick: "dave" });
  await call("status", { nick: "dave", status: "online" });
  await drain(sub);
  sub.sock.end();
  await new Promise((r) => setTimeout(r, 200));
  const { users } = await call("users", {});
  assert.equal(users.find((u) => u.nick === "dave").status, "offline");
});

test("unknown method returns error", async () => {
  await assert.rejects(() => call("bogusMethod", {}), /unknown method/);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a subscribe gets only live events", async () => {
  await call("register", { nick: "fred" });
  await call("dm", { from: "alice", to: "fred", text: "old" });
  const sub = await subscribe("fred");
  await wait(100);
  assert.deepEqual(sub.events, []);
  await call("dm", { from: "alice", to: "fred", text: "new" });
  await wait(100);
  assert.deepEqual(sub.events.map((e) => e.message.text), ["new"]);
  sub.sock.end();
});

test("ack and replay are gone: nqueue delivers to agents now", async () => {
  await assert.rejects(() => call("ack", { nick: "alice", ts: 1 }), /unknown method/);
});

test("closing one of a nick's two connections leaves it online", async () => {
  await call("register", { nick: "hank" });
  const old = await subscribe("hank");
  const cur = await subscribe("hank");
  await call("status", { nick: "hank", status: "online" });
  old.sock.end(); // a reconnect: the old socket closes after the new one is up
  await wait(200);
  let { users } = await call("users", {});
  assert.equal(users.find((u) => u.nick === "hank").status, "online");
  cur.sock.end();
  await wait(200);
  ({ users } = await call("users", {}));
  assert.equal(users.find((u) => u.nick === "hank").status, "offline");
});

test("status with ifOffline keeps a status the agent set", async () => {
  await call("register", { nick: "ivy" });
  await call("status", { nick: "ivy", status: "busy", statusText: "deep in a fix" });
  await call("status", { nick: "ivy", status: "online", statusText: "pi session", ifOffline: true });
  let { users } = await call("users", {});
  assert.equal(users.find((u) => u.nick === "ivy").statusText, "deep in a fix");
  await call("status", { nick: "ivy", status: "offline" });
  await call("status", { nick: "ivy", status: "online", statusText: "pi session", ifOffline: true });
  ({ users } = await call("users", {}));
  assert.equal(users.find((u) => u.nick === "ivy").status, "online");
});
