#!/usr/bin/env node
// Claude Code SessionEnd hook for the nchat plugin: sets the session's nick
// offline. (The nqueue plugin takes the agent offline in nqueue.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const NCHAT_BIN = process.env.NCHAT_BIN || `${HOME}/.local/bin/nchat`;
const NQUEUE_HOME = process.env.NQUEUE_HOME || path.join(HOME, ".nqueue");
let sid = "default";
try { sid = JSON.parse(fs.readFileSync(0, "utf8")).session_id || sid; } catch {}
let nick = null;
try { nick = fs.readFileSync(path.join(NQUEUE_HOME, "ids", `cc-${sid}`), "utf8").trim(); } catch {}
if (nick) {
  try { execFileSync(NCHAT_BIN, ["status", "offline", "--as", nick], { stdio: "ignore", timeout: 10000 }); } catch {}
}
