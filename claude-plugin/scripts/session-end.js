#!/usr/bin/env node
// Claude Code nchat plugin: session-end cleanup.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const NCHAT_BIN = process.env.NCHAT_BIN || `${HOME}/.local/bin/nchat`;
let sid = "default", nick = null;
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  sid = input.session_id || sid;
} catch {}
const nickFile = path.join(HOME, ".nchat", "nicks", `cc-${sid}`);
try { nick = fs.readFileSync(nickFile, "utf8").trim(); } catch {}
if (nick) {
  try { execFileSync(NCHAT_BIN, ["status", "offline", "--as", nick], { stdio: "ignore" }); } catch {}
}
// stop this session's `nchat listen` and drop its spool
const spool = path.join(HOME, ".nchat", "spool", sid);
for (const p of [`${spool}.pid`, `${spool}.wait`]) {
  try { process.kill(Number(fs.readFileSync(p, "utf8"))); } catch {}
}
// (the nick file stays, so a resumed session keeps its nick)
for (const f of [path.join(HOME, ".nchat", `cc-env-${sid}`), `${spool}.pid`, `${spool}.wait`, `${spool}.log`, `${spool}.off`, `${spool}.acked`]) {
  try { fs.unlinkSync(f); } catch {}
}
