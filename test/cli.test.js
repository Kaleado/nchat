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
process.env.NCHAT_NQUEUE = "0"; // delivery through nqueue is tested in nqueue.test.js
// the tests' own identities only (not the session running them)
delete process.env.NCHAT_NICK;
delete process.env.NCHAT_SESSION;
delete process.env.NQUEUE_ID;

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

test("getfile downloads a shared file, and won't overwrite without --force", async () => {
  const f = path.join(TMP, "report.txt");
  fs.writeFileSync(f, "the report");
  let r = await run(["sendfile", f, "--channel", "general", "--as", "cli_alice"]);
  assert.equal(r.code, 0, r.err);
  const fid = r.out.match(/\[(\w+)\]/)[1];
  r = await run(["files"]);
  assert.match(r.out, new RegExp(`\\[${fid}\\] report\\.txt \\(10B\\) from cli_alice -> #general  expires `));
  const dir = fs.mkdtempSync(path.join(TMP, "dl-"));
  r = await run(["getfile", fid.slice(0, 6), dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(path.join(dir, "report.txt"), "utf8"), "the report");
  r = await run(["getfile", fid, dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /already exists/);
  fs.writeFileSync(path.join(dir, "report.txt"), "old");
  r = await run(["getfile", fid, dir, "--force"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(path.join(dir, "report.txt"), "utf8"), "the report");
  r = await run(["history", "general"]);
  assert.match(r.out, /cli_alice: shared file report\.txt \(10B\)/);
});

test("tunnel asks the other machine for its socket, then forwards to it", async () => {
  const log = path.join(TMP, "ssh.log");
  const ssh = path.join(TMP, "fake-ssh");
  fs.writeFileSync(ssh, `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *printf*) printf /home/me/.nchat/hub.sock ;; esac\n`, { mode: 0o755 });
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  let r = await run(["tunnel", "me@box", "--", "-p", "2222"], { NCHAT_SSH: ssh, NCHAT_HOME: path.join(home, ".nchat") });
  assert.equal(r.code, 0, r.err);
  const local = path.join(home, ".nchat", "tunnels", "me@box.sock");
  assert.match(r.err, new RegExp(`export NCHAT_SOCKET=${local.replace(/[.]/g, "\\.")}`));
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^-p 2222 -- me@box sh -c /);
  assert.equal(calls[1], `-N -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L ${local}:/home/me/.nchat/hub.sock -p 2222 -- me@box`);
  assert.equal(fs.statSync(path.dirname(local)).mode & 0o777, 0o700);
});

test("hub start won't start a hub on a tunnel's socket or over one that answers", async () => {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const tunnelSock = path.join(home, ".nchat", "tunnels", "box.sock");
  let r = await run(["hub", "start"], { NCHAT_HOME: path.join(home, ".nchat"), NCHAT_SOCKET: tunnelSock });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /tunnel's socket/);
  // the hub these tests use answers on NCHAT_SOCKET, without a pid file of ours
  r = await run(["hub", "start"], { NCHAT_HOME: path.join(home, ".nchat") });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /already/);
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

// --- agent sessions: the nick is the session's nqueue agent ID ---
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const inSession = (id) => ({ NQUEUE_ID: id });

test("nick is the session's nqueue agent ID, ahead of NCHAT_NICK", async () => {
  let r = await run(["nick"], { ...inSession("calm-fox-11"), NCHAT_NICK: "other" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "calm-fox-11 (nqueue agent ID)");
  r = await run(["send", "general", "from the session"], inSession("calm-fox-11"));
  assert.equal(r.code, 0, r.err);
  r = await run(["history", "general", "--n", "1"]);
  assert.match(r.out, /calm-fox-11: from the session/);
  r = await run(["nick"], { NCHAT_NICK: "plain" });
  assert.equal(r.out.trim(), "plain (NCHAT_NICK)");
});

test("nicks can't be switched", async () => {
  const r = await run(["nick", "x1"], inSession("calm-fox-11"));
  assert.equal(r.code, 1);
  assert.match(r.err, /can't be switched.*NQUEUE_ID=<nick>/);
});

test("acting as another nick than the session receives as warns", async () => {
  await run(["register", "sess_e", "--as", "sess_e"]);
  const r = await run(["send", "general", "hi", "--as", "someone_else"], inSession("sess_e"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /receives messages as sess_e/);
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
