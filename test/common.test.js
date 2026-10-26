// Unit tests for lib/common.js helpers (no hub needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validNick, validChannel, dmKeyOf } from "../lib/common.js";
import net from "node:net";
import path from "node:path";
import os from "node:os";

test("validNick accepts valid nicknames", () => {
  assert.equal(validNick("alice"), true);
  assert.equal(validNick("Agent_1"), true);
  assert.equal(validNick("a-b_c9"), true);
});

test("validNick rejects invalid nicknames", () => {
  assert.equal(validNick(""), false);
  assert.equal(validNick("has space"), false);
  assert.equal(validNick("has.dot"), false);
  assert.equal(validNick("x".repeat(33)), false);
  assert.equal(validNick(null), false);
  assert.equal(validNick(undefined), false);
});

test("validChannel accepts/rejects channel names", () => {
  assert.equal(validChannel("general"), true);
  assert.equal(validChannel("dev-chat_2"), true);
  assert.equal(validChannel("#general"), false); // no hash prefix
  assert.equal(validChannel(""), false);
  assert.equal(validChannel("x".repeat(65)), false);
});

test("dmKey is order-independent", () => {
  assert.equal(dmKeyOf("alice", "bob"), dmKeyOf("bob", "alice"));
  assert.notEqual(dmKeyOf("alice", "bob"), dmKeyOf("alice", "carol"));
});
