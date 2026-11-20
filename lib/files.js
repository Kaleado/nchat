// Shared files: their contents live on the hub, in <data>/files/<id>, so
// anyone who can reach the hub (e.g. through `nchat tunnel`) can fetch them.
// Stored files expire after a time (ttl) and/or when the total stored size
// would go over a limit (oldest first). Both, and the largest file accepted,
// are set in the hub's config file under "files".
import fs from "node:fs";
import path from "node:path";
import { dataPath, NCHAT_HOME, now } from "./common.js";

export const DEFAULTS = { maxFileSize: "4GiB", ttl: "7d", maxTotalSize: "20GiB" };

const SIZE_UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
const OFF = (v) => v === null || v === false || v === 0 || v === "0" || v === "off" || v === "none";

// "4GiB", "500MB", "1.5g", 1048576 (bytes); "off" for no limit (null).
// K/M/G/T are binary (1024-based), with or without "B" or "iB".
export function parseSize(v) {
  if (OFF(v)) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(i?b)?\s*$/i.exec(String(v));
  if (!m) throw new Error(`invalid size "${v}" (e.g. 4GiB, 500MB, off)`);
  return Math.floor(parseFloat(m[1]) * SIZE_UNITS[(m[2] || "b").toLowerCase()]);
}

const DURATION_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// "7d", "12h", "30m", "2w", 3600 (seconds); "off" for no expiry (null). In ms.
export function parseDuration(v) {
  if (OFF(v)) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 1000;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i.exec(String(v));
  if (!m) throw new Error(`invalid duration "${v}" (e.g. 7d, 12h, 30m, off)`);
  return parseFloat(m[1]) * DURATION_UNITS[m[2].toLowerCase()];
}

export function formatSize(n) {
  if (n == null) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0).replace(/\.0$/, "") : n}${units[i]}`;
}

export const configPath = () => process.env.NCHAT_CONFIG || path.join(NCHAT_HOME, "config.json");

// The hub's file settings, read fresh each time so edits apply without a
// restart. A broken config is an error, not a silent fallback to defaults.
export function loadConfig() {
  let raw = {};
  const p = configPath();
  if (fs.existsSync(p)) {
    try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { throw new Error(`reading ${p}: ${e.message}`); }
  }
  const f = { ...DEFAULTS, ...(raw.files || {}) };
  for (const k of Object.keys(raw.files || {})) {
    if (!(k in DEFAULTS)) throw new Error(`${p}: unknown setting files.${k} (known: ${Object.keys(DEFAULTS).join(", ")})`);
  }
  return { maxFileSize: parseSize(f.maxFileSize), ttl: parseDuration(f.ttl), maxTotalSize: parseSize(f.maxTotalSize) };
}

export const blobDir = () => {
  const dir = dataPath("files");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
export const blobPath = (fid) => path.join(blobDir(), fid);
export const partPath = (fid) => path.join(blobDir(), `${fid}.part`);

// Storage bookkeeping over the hub's state.files.
export class FileStore {
  constructor(files, save) {
    this.files = files; // id -> metadata; stored ones have stored: true
    this.save = save;
    this.inflight = new Map(); // id -> bytes reserved for an upload in progress
  }

  stored() { return Object.values(this.files).filter((f) => f.stored); }

  used() {
    let n = 0;
    for (const f of this.stored()) n += f.size;
    for (const s of this.inflight.values()) n += s;
    return n;
  }

  expiresAt(f, cfg = loadConfig()) { return f.stored && cfg.ttl != null ? f.ts + cfg.ttl : null; }

  expire(f, reason) {
    try { fs.unlinkSync(blobPath(f.id)); } catch {}
    f.stored = false;
    f.expired = now();
    f.expiredBy = reason;
  }

  // Remove files past their ttl, and anything on disk the hub doesn't know
  // (an upload cut short by a crash).
  prune(cfg = loadConfig()) {
    let changed = false;
    if (cfg.ttl != null) {
      for (const f of this.stored()) if (now() >= f.ts + cfg.ttl) { this.expire(f, "ttl"); changed = true; }
    }
    try {
      for (const name of fs.readdirSync(blobDir())) {
        const id = name.replace(/\.part$/, "");
        const live = name.endsWith(".part") ? this.inflight.has(id) : this.files[id]?.stored;
        if (!live) try { fs.unlinkSync(path.join(blobDir(), name)); } catch {}
      }
    } catch {}
    if (changed) this.save();
  }

  // Make room for `size` more bytes and hold it for upload `fid`, expiring
  // the oldest files if the total would go over the limit.
  reserve(fid, size, cfg = loadConfig()) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid file size");
    if (cfg.maxFileSize != null && size > cfg.maxFileSize) {
      throw new Error(`file is ${formatSize(size)}, over the hub's limit of ${formatSize(cfg.maxFileSize)} (files.maxFileSize)`);
    }
    this.prune(cfg);
    if (cfg.maxTotalSize != null) {
      if (size > cfg.maxTotalSize) {
        throw new Error(`file is ${formatSize(size)}, over the hub's total storage of ${formatSize(cfg.maxTotalSize)} (files.maxTotalSize)`);
      }
      const oldest = this.stored().sort((a, b) => a.ts - b.ts);
      let evicted = false;
      while (this.used() + size > cfg.maxTotalSize && oldest.length) { this.expire(oldest.shift(), "space"); evicted = true; }
      if (evicted) this.save();
      if (this.used() + size > cfg.maxTotalSize) {
        throw new Error("the hub's file storage is taken up by uploads in progress; try again shortly");
      }
    }
    this.inflight.set(fid, size);
  }

  release(fid) {
    this.inflight.delete(fid);
    try { fs.unlinkSync(partPath(fid)); } catch {}
  }

  // The upload finished: its part file becomes the stored file.
  commit(fid, meta) {
    fs.renameSync(partPath(fid), blobPath(fid));
    this.inflight.delete(fid);
    this.files[fid] = { ...meta, id: fid, stored: true };
    return this.files[fid];
  }
}
