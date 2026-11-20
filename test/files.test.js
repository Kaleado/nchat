// Files stored on the hub: streaming upload and download, size limits,
// expiry by time and by total size, and cut-off uploads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-files-"));
process.env.NCHAT_SOCKET = path.join(TMP, "hub.sock");
process.env.NCHAT_DATA = path.join(TMP, "data");
process.env.NCHAT_CONFIG = path.join(TMP, "config.json");
process.env.NCHAT_NQUEUE = "0";

const { startHub, stopHub } = await import("../lib/hub.js");
const { call, upload, download } = await import("../lib/common.js");
const { parseSize, parseDuration, formatSize } = await import("../lib/files.js");

const config = (files) => fs.writeFileSync(process.env.NCHAT_CONFIG, JSON.stringify({ files }));
const blob = (name, bytes) => { const p = path.join(TMP, name); fs.writeFileSync(p, bytes); return p; };
const blobs = () => fs.readdirSync(path.join(TMP, "data", "files"));

before(async () => {
  await startHub({ silent: true });
  await call("register", { nick: "alice" });
  await call("register", { nick: "bob" });
});
after(async () => { await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("sizes and durations", () => {
  assert.equal(parseSize("4GiB"), 4 * 1024 ** 3);
  assert.equal(parseSize("500MB"), 500 * 1024 ** 2);
  assert.equal(parseSize("1.5k"), 1536);
  assert.equal(parseSize(2048), 2048);
  assert.equal(parseSize("off"), null);
  assert.throws(() => parseSize("lots"), /invalid size/);
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration(10), 10_000);
  assert.equal(parseDuration("none"), null);
  assert.throws(() => parseDuration("soon"), /invalid duration/);
  assert.equal(formatSize(1536), "1.5KiB");
});

test("a binary file round-trips through the hub and shows in history", async () => {
  config({});
  const bytes = crypto.randomBytes(5 * 1024 * 1024 + 17); // several socket chunks
  const r = await upload({ from: "alice", to: "bob", name: "/some/where/data.bin" }, blob("data.bin", bytes));
  assert.equal(r.file.name, "data.bin"); // just the name, not the sender's path
  assert.equal(r.file.size, bytes.length);
  assert.ok(r.file.expiresAt > Date.now() + 6 * 86_400_000, "default ttl is 7 days");

  const dest = path.join(TMP, "got.bin");
  await download(r.fileId, dest);
  assert.ok(fs.readFileSync(dest).equals(bytes));
  assert.ok(!fs.existsSync(`${dest}.part`));

  const { messages } = await call("dmHistory", { a: "alice", b: "bob" });
  assert.ok(messages.some((m) => m.file === r.fileId && /shared file data\.bin/.test(m.text)));
  const { files } = await call("files", {});
  assert.ok(files.find((f) => f.id === r.fileId).stored);
});

test("an empty file works too", async () => {
  const r = await upload({ from: "alice", channel: "general", name: "empty" }, blob("empty", ""));
  const dest = path.join(TMP, "empty.out");
  await download(r.fileId, dest);
  assert.equal(fs.readFileSync(dest).length, 0);
});

test("files over maxFileSize are refused before they're sent", async () => {
  config({ maxFileSize: "1KiB" });
  await assert.rejects(() => upload({ from: "alice", to: "bob", name: "big" }, blob("big", Buffer.alloc(2048))), /over the hub's limit of 1KiB/);
  assert.ok(!blobs().some((b) => b.endsWith(".part")));
  config({});
});

test("maxTotalSize expires the oldest files to make room", async () => {
  config({ maxTotalSize: "10KiB", maxFileSize: "20KiB" });
  // earlier tests' files are evicted first, then these in order
  const a = await upload({ from: "alice", to: "bob", name: "a" }, blob("a", Buffer.alloc(6 * 1024, 1)));
  const b = await upload({ from: "alice", to: "bob", name: "b" }, blob("b", Buffer.alloc(6 * 1024, 2)));
  const { files } = await call("files", {});
  const fa = files.find((f) => f.id === a.fileId), fb = files.find((f) => f.id === b.fileId);
  assert.equal(fa.stored, false);
  assert.equal(fa.expiredBy, "space");
  assert.equal(fb.stored, true);
  await assert.rejects(() => download(a.fileId, path.join(TMP, "a.out")), /expired \(the hub needed the space\)/);
  assert.ok(!blobs().includes(a.fileId));
  await assert.rejects(() => upload({ from: "alice", to: "bob", name: "huge" }, blob("huge", Buffer.alloc(11 * 1024))), /total storage/);
  config({});
});

test("files expire after their ttl", async () => {
  config({ ttl: "1s" });
  const r = await upload({ from: "alice", to: "bob", name: "short" }, blob("short", "x"));
  await new Promise((res) => setTimeout(res, 1100));
  await assert.rejects(() => download(r.fileId, path.join(TMP, "short.out")), /past its time to live/);
  const { files } = await call("files", {});
  assert.equal(files.find((f) => f.id === r.fileId).expiredBy, "ttl");
  config({ ttl: "off" });
  const kept = await upload({ from: "alice", to: "bob", name: "kept" }, blob("kept", "y"));
  assert.equal(kept.file.expiresAt, null);
  config({});
});

test("an upload cut off part way leaves nothing behind", async () => {
  config({});
  const before = (await call("files", {})).files.length;
  await new Promise((resolve) => {
    const sock = net.connect(process.env.NCHAT_SOCKET);
    sock.on("connect", () => sock.write(JSON.stringify({ id: "u", method: "upload", params: { from: "alice", to: "bob", name: "cut", size: 1000 } }) + "\n"));
    sock.once("data", () => { sock.write(Buffer.alloc(100)); setTimeout(() => { sock.destroy(); resolve(); }, 50); });
  });
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(!blobs().some((b) => b.endsWith(".part")));
  assert.equal((await call("files", {})).files.length, before);
});

test("requests on the same connection keep working after an upload", async () => {
  const bytes = Buffer.from("hello\nworld\n");
  const reply = await new Promise((resolve) => {
    const sock = net.connect(process.env.NCHAT_SOCKET);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify({ id: "u", method: "upload", params: { from: "alice", to: "bob", name: "lines", size: bytes.length } }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (lines.length === 1) sock.write(Buffer.concat([bytes, Buffer.from(JSON.stringify({ id: "p", method: "ping" }) + "\n")]));
      if (lines.length === 3) { sock.end(); resolve(lines); }
    });
  });
  assert.equal(reply[1].result.ok, true);
  assert.deepEqual(reply[2], { id: "p", result: "pong" });
});

test("a broken config is reported", async () => {
  config({ maxFileSize: "huge" });
  await assert.rejects(() => call("files", {}), /invalid size "huge"/);
  config({ unknownThing: 1 });
  await assert.rejects(() => call("files", {}), /unknown setting files\.unknownThing/);
  config({});
});

test("a second hub won't take over a socket that answers", async () => {
  await assert.rejects(() => startHub({ silent: true }), /already answering/);
  assert.deepEqual(await call("ping", {}), "pong");
});
