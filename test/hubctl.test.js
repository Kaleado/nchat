// Hub lifecycle tests: nchat hub start/stop/restart/status against a real process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-hubctl-"));
process.env.NCHAT_SOCKET = path.join(TMP, "hub.sock");
process.env.NCHAT_DATA = path.join(TMP, "data");
process.env.NCHAT_NQUEUE = "0";

const { call } = await import("../lib/common.js");

const run = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "bin", "nchat"), ...args], { env: process.env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => reject(new Error("cli timeout")), 15000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });

const PID_FILE = path.join(TMP, "hub.pid");
const hubPid = () => {
  try { return parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10); } catch { return null; }
};
const procAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// wait until a process is gone
const waitGone = async (pid) => {
  for (let i = 0; i < 30 && procAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !procAlive(pid);
};

before(async () => {
  // make sure no hub from a previous run is alive in this TMP
  await run(["hub", "stop"]);
});

after(async () => {
  await run(["hub", "stop"]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("status: not running when no hub", async () => {
  const r = await run(["hub", "status"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not running/);
});

test("start: launches hub and reports pid", async () => {
  const r = await run(["hub"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hub started \(pid \d+\)/);
  const pid = hubPid();
  assert.ok(pid, "pid file written");
  assert.ok(procAlive(pid), "hub process alive");
  // socket is actually up
  const pong = await call("ping", {});
  assert.equal(pong, "pong");
});

test("start: idempotent when already running", async () => {
  const pidBefore = hubPid();
  const r = await run(["hub", "start"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /already running/);
  assert.equal(hubPid(), pidBefore, "no new hub spawned");
});

test("restart: replaces the process, preserves state", async () => {
  await call("register", { nick: "restart_test", hostname: "h" });
  const pidBefore = hubPid();
  const r = await run(["hub", "restart"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hub stopped/);
  assert.match(r.out, /hub started/);
  assert.ok(await waitGone(pidBefore), "old hub process gone");
  const pidAfter = hubPid();
  assert.ok(pidAfter && pidAfter !== pidBefore, "new pid, still running");
  // state survived the restart
  const { users } = await call("users", {});
  assert.ok(users.find((u) => u.nick === "restart_test"));
});

test("stop: terminates the hub and cleans up", async () => {
  const pid = hubPid();
  const r = await run(["hub", "stop"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hub stopped/);
  assert.ok(await waitGone(pid), "hub process gone");
  assert.equal(hubPid(), null, "pid file removed");
  assert.equal(fs.existsSync(process.env.NCHAT_SOCKET), false, "socket file removed");
});

test("stop: reports not running (exit 1) when already stopped", async () => {
  const r = await run(["hub", "stop"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not running/);
});

test("stop: never touches a hub on a different socket", async () => {
  // start a hub on a different socket under a separate TMP
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-other-"));
  const other = spawn(process.execPath, [path.join(ROOT, "lib", "hub.js")], {
    env: { ...process.env, NCHAT_SOCKET: path.join(TMP2, "hub.sock"), NCHAT_DATA: path.join(TMP2, "data") },
    detached: true, stdio: "ignore",
  });
  other.unref();
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(procAlive(other.pid), "other-socket hub is alive");

  // our socket has no hub; stopping must be a no-op and leave the other alone
  const r = await run(["hub", "stop"]);
  assert.match(r.out, /not running/);
  assert.ok(procAlive(other.pid), "other-socket hub survived");

  process.kill(other.pid, "SIGTERM");
  await waitGone(other.pid);
  fs.rmSync(TMP2, { recursive: true, force: true });
});

test("restart: works when hub is not running (starts fresh)", async () => {
  const r = await run(["hub", "restart"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hub started/);
  assert.ok(hubPid(), "hub now running");
  assert.equal(await call("ping", {}), "pong");
});

test("hub: unknown subcommand fails", async () => {
  const r = await run(["hub", "frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown hub command/);
});
