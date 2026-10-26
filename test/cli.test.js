// End-to-end CLI tests: spawn bin/nchat against a hub running in-process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-cli-"));
process.env.NCHAT_SOCKET = path.join(TMP, "hub.sock");
process.env.NCHAT_DATA = path.join(TMP, "data");
// the tests' own identities only (not the session running them)
delete process.env.NCHAT_NICK;
delete process.env.NCHAT_SESSION;

const { startHub, stopHub } = await import("../lib/hub.js");

const run = (args, env = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "bin", "nchat"), ...args], {
      env: { ...process.env, ...env },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => reject(new Error("cli timeout")), 10000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });

before(async () => { await startHub({ silent: true }); });
after(async () => { await stopHub(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("help prints usage", async () => {
  const { code, out } = await run(["help"]);
  assert.equal(code, 0);
  assert.match(out, /nchat/);
  assert.match(out, /Usage:/);
});

test("register then join then send then history roundtrip", async () => {
  let r = await run(["register", "cli_alice"], { NCHAT_NICK: "cli_alice" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /registered as cli_alice/);

  r = await run(["join", "general", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /joined #general/);

  r = await run(["send", "general", "hi from cli", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sent to #general/);

  r = await run(["history", "general", "--n", "10"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hi from cli/);
  assert.match(r.out, /cli_alice: hi from cli/);
});

test("join without identity fails", async () => {
  const r = await run(["join", "general"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--as/);
});

test("unknown command fails with usage", async () => {
  const r = await run(["frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown command/);
});

test("dm and dmhistory", async () => {
  await run(["register", "cli_bob"], { NCHAT_NICK: "cli_bob" });
  let r = await run(["msg", "cli_bob", "hello bob", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dm sent/);
  r = await run(["dmhistory", "cli_alice", "--as", "cli_bob"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hello bob/);
});

test("status command updates presence", async () => {
  let r = await run(["status", "busy", "on a call", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /busy/);
  r = await run(["whoami", "cli_alice"]);
  assert.match(r.out, /"status":\s*"busy"/);
  assert.match(r.out, /on a call/);
});

test("users and channels listings", async () => {
  let r = await run(["users"]);
  assert.match(r.out, /cli_alice/);
  r = await run(["channels"]);
  assert.match(r.out, /#general/);
});

test("sendfile and files", async () => {
  const f = path.join(TMP, "payload.txt");
  fs.writeFileSync(f, "payload");
  let r = await run(["sendfile", f, "--to", "cli_bob", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /file shared/);
  r = await run(["files"]);
  assert.match(r.out, /payload\.txt/);
});

test("topic get and set", async () => {
  let r = await run(["topic", "general", "The Lobby", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  r = await run(["topic", "general"]);
  assert.equal(r.out.trim(), "The Lobby");
});

test("part removes member", async () => {
  const r = await run(["part", "general", "--as", "cli_bob"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /left #general/);
});

test("listen receives events for its nick", async () => {
  const p = spawn(process.execPath, [path.join(ROOT, "bin", "nchat"), "listen", "--as", "cli_bob"]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await new Promise((r) => setTimeout(r, 400));
  await run(["msg", "cli_bob", "listen test", "--as", "cli_alice"]);
  await new Promise((r) => setTimeout(r, 300));
  p.kill();
  assert.match(out, /"event":"dm"/);
  assert.match(out, /listen test/);
});

// --- agent sessions: the nick in nicks/<session file>, switched by `nchat nick` ---
const NICKS = path.join(TMP, "nicks");
const inSession = (key) => ({ NCHAT_SESSION: key });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("nick shows the session's nick, and switches it", async () => {
  fs.mkdirSync(NICKS, { recursive: true });
  fs.writeFileSync(path.join(NICKS, "pi-s1"), "sess_a\n");
  await run(["register", "sess_a", "--as", "sess_a"]);
  let r = await run(["nick"], inSession("pi-s1"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^sess_a \(session pi-s1\)/);
  r = await run(["nick", "sess_b"], inSession("pi-s1"));
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(path.join(NICKS, "pi-s1"), "utf8").trim(), "sess_b");
  // and commands now act as the new nick
  r = await run(["send", "general", "as b now"], inSession("pi-s1"));
  assert.equal(r.code, 0, r.err);
  r = await run(["history", "general", "--n", "1"]);
  assert.match(r.out, /sess_b: as b now/);
  r = await run(["users"]);
  assert.match(r.out, /sess_a\s+offline/);
});

test("register inside a session becomes the nick", async () => {
  fs.writeFileSync(path.join(NICKS, "pi-s2"), "sess_c\n");
  const r = await run(["register", "sess_d"], inSession("pi-s2"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /this session now sends and receives as sess_d/);
  assert.equal(fs.readFileSync(path.join(NICKS, "pi-s2"), "utf8").trim(), "sess_d");
});

test("nick outside a session refuses to switch", async () => {
  const r = await run(["nick", "x1"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not in an agent session/);
});

test("acting as another nick than the session receives as warns", async () => {
  fs.writeFileSync(path.join(NICKS, "pi-s3"), "sess_e\n");
  await run(["register", "sess_e", "--as", "sess_e"]);
  const r = await run(["send", "general", "hi", "--as", "someone_else"], inSession("pi-s3"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /receives messages as sess_e.*nchat nick someone_else/);
});

// a long-running `nchat listen`, its events as they come
function listen(args, env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, "bin", "nchat"), "listen", ...args], { env: { ...process.env, ...env } });
  const events = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  return { p, events, texts: () => events.map((e) => e.message?.text).filter(Boolean) };
}
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await wait(50); }
  return false;
}

test("listen replays what came while away, then follows the nick file", async () => {
  const file = path.join(NICKS, "cc-l1");
  fs.writeFileSync(file, "lis_a\n");
  await run(["register", "lis_a", "--as", "lis_a"]);
  await run(["register", "lis_b", "--as", "lis_b"]);
  await wait(5);
  await run(["msg", "lis_a", "sent before listening", "--as", "cli_alice"]);
  const l = listen(["--as", "lis_a", "--follow", file]);
  try {
    assert.ok(await until(() => l.texts().includes("sent before listening")), "replayed");
    fs.writeFileSync(file, "lis_b\n");
    await wait(1500); // it polls the file each second
    await run(["msg", "lis_b", "to the new nick", "--as", "cli_alice"]);
    assert.ok(await until(() => l.texts().includes("to the new nick")), JSON.stringify(l.texts()));
  } finally { l.p.kill(); }
});

test("listen reconnects when the hub restarts", async () => {
  await run(["register", "lis_c", "--as", "lis_c"]);
  const l = listen(["--as", "lis_c"]);
  try {
    await wait(300);
    await stopHub();
    await run(["help"]); // (nothing listening for a moment)
    await startHub({ silent: true });
    await wait(2500); // it retries every 2 s
    await run(["msg", "lis_c", "after the restart", "--as", "cli_alice"]);
    assert.ok(await until(() => l.texts().includes("after the restart")), JSON.stringify(l.texts()));
  } finally { l.p.kill(); }
});
