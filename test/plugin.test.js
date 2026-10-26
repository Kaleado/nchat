// The Claude Code plugin's drain hook: replayed events are delivered once,
// and what it delivers is acked to the hub (via `nchat ack`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nchat-plugin-"));
const SPOOL = path.join(HOME, ".nchat", "spool");
const NICKS = path.join(HOME, ".nchat", "nicks");
fs.mkdirSync(SPOOL, { recursive: true });
fs.mkdirSync(NICKS, { recursive: true });
// a stand-in nchat that records its arguments
const STUB = path.join(HOME, "nchat-stub");
const CALLS = path.join(HOME, "calls");
fs.writeFileSync(STUB, `#!/bin/sh\necho "$@" >> ${CALLS}\n`, { mode: 0o755 });

const dm = (id, ts, text) => JSON.stringify({ event: "dm", message: { id, ts, from: "qa", to: "me", text } });
function drain(sid, event = "UserPromptSubmit") {
  const r = spawnSync(process.execPath, [path.join(ROOT, "claude-plugin", "scripts", "drain.js"), event], {
    input: JSON.stringify({ session_id: sid }),
    env: { ...process.env, HOME, NCHAT_BIN: STUB, NCHAT_NICK: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}

test("drain delivers replayed events once and acks the newest", () => {
  fs.writeFileSync(path.join(NICKS, "cc-d1"), "me\n");
  // a reconnect replayed m1 and m2 after the live copies
  fs.writeFileSync(path.join(SPOOL, "d1.log"), [dm("m1", 100, "one"), dm("m2", 200, "two"), dm("m1", 100, "one"), dm("m2", 200, "two")].join("\n") + "\n");
  let out = drain("d1");
  assert.equal(out.match(/DM from qa: one/g).length, 1);
  assert.equal(out.match(/DM from qa: two/g).length, 1);
  assert.equal(fs.readFileSync(path.join(SPOOL, "d1.acked"), "utf8"), "200");
  assert.match(fs.readFileSync(CALLS, "utf8"), /^ack 200 --as me$/m);
  // a later replay of the same, plus a new one: only the new one
  fs.appendFileSync(path.join(SPOOL, "d1.log"), [dm("m2", 200, "two"), dm("m3", 300, "three")].join("\n") + "\n");
  out = drain("d1");
  assert.doesNotMatch(out, /two/);
  assert.match(out, /DM from qa: three/);
});
