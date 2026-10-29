// The Claude Code plugin's hooks: the session signs in to the hub as its
// nqueue agent ID.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-plugin-"));
const IDS = path.join(HOME, "nqueue", "ids");
fs.mkdirSync(IDS, { recursive: true });
// a stand-in nchat that records its arguments
const STUB = path.join(HOME, "nchat-stub");
const CALLS = path.join(HOME, "calls");
fs.writeFileSync(STUB, `#!/bin/sh\necho "$@" >> ${CALLS}\n`, { mode: 0o755 });
// something listening where the hub would be, in its own process: the
// hooks run with spawnSync, which blocks this one
const SOCKET = path.join(HOME, "hub.sock");
const hub = spawn(process.execPath, ["-e", `require("net").createServer((s) => s.end()).listen(${JSON.stringify(SOCKET)})`]);
while (!fs.existsSync(SOCKET)) await new Promise((r) => setTimeout(r, 20));
after(() => { hub.kill(); fs.rmSync(HOME, { recursive: true, force: true }); });

const env = { ...process.env, HOME, NCHAT_BIN: STUB, NCHAT_SOCKET: SOCKET, NQUEUE_HOME: path.join(HOME, "nqueue"), NCHAT_ID_WAIT_MS: "500" };
delete env.NCHAT_CHANNELS;

function hook(script, sid, extra = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "claude-plugin", "scripts", script)], {
    input: JSON.stringify({ session_id: sid }),
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}
const calls = () => { try { return fs.readFileSync(CALLS, "utf8").trim().split("\n"); } catch { return []; } };

test("SessionStart signs in as the session's nqueue ID", () => {
  fs.writeFileSync(path.join(IDS, "cc-s1"), "calm-fox-11\n");
  fs.rmSync(CALLS, { force: true });
  const context = hook("session-start.js", "s1", { NCHAT_CHANNELS: "dev" });
  assert.match(context, /Your nick is calm-fox-11/);
  assert.match(context, /#general #dev/);
  const c = calls();
  assert.ok(c.includes("register calm-fox-11 --as calm-fox-11"), c.join("\n"));
  assert.ok(c.includes("join general --as calm-fox-11"));
  assert.ok(c.includes("join dev --as calm-fox-11"));
  assert.ok(c.includes("status online claude session --as calm-fox-11"));
});

test("SessionStart without an nqueue ID says nqueue is needed", () => {
  fs.rmSync(CALLS, { force: true });
  const context = hook("session-start.js", "no-such-session");
  assert.match(context, /needs the nqueue plugin/);
  assert.ok(!calls().some((c) => c.startsWith("register")));
});

test("SessionEnd sets the nick offline", () => {
  fs.writeFileSync(path.join(IDS, "cc-s2"), "brave-owl-22\n");
  fs.rmSync(CALLS, { force: true });
  hook("session-end.js", "s2");
  assert.deepEqual(calls(), ["status offline --as brave-owl-22"]);
});
