// SQLite store (node:sqlite, built into Node 22.5+ — no native build).
// One envelope = one document + its signers + an append-only event log.
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { env, ensureDataDirs } from "./env.mjs"

let db

const SCHEMA = `
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  property_address TEXT,
  agreement_date TEXT,
  message TEXT,
  source TEXT NOT NULL,            -- 'upload' | 'drive'
  drive_file_id TEXT,
  drive_folder_id TEXT,
  drive_final_id TEXT,
  drive_final_link TEXT,
  original_sha256 TEXT NOT NULL,
  original_path TEXT NOT NULL,
  signed_sha256 TEXT,              -- document with signatures, before the certificate
  final_sha256 TEXT,               -- the file everyone receives
  final_path TEXT,
  page_count INTEGER NOT NULL,
  is_template INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,            -- 'in_progress' | 'completed' | 'voided' | 'declined'
  created_at TEXT NOT NULL,
  completed_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_by TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  order_index INTEGER NOT NULL,
  role TEXT NOT NULL,              -- 'seller' | 'buyer'
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  placement TEXT NOT NULL,         -- 'template' | 'addendum'
  token_hash TEXT,
  token_expires_at TEXT,
  status TEXT NOT NULL,            -- 'waiting' | 'sent' | 'opened' | 'consented' | 'signed' | 'declined'
  sent_at TEXT,
  send_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  open_ip TEXT, open_ua TEXT, open_geo TEXT,
  consented_at TEXT,
  consent_version TEXT,
  consent_ip TEXT, consent_ua TEXT, consent_geo TEXT,
  signed_at TEXT,
  sign_ip TEXT, sign_ua TEXT, sign_geo TEXT,
  typed_name TEXT,
  signature_method TEXT,           -- 'typed' | 'drawn'
  signature_png BLOB,
  declined_at TEXT,
  decline_reason TEXT,
  sms_verified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS signers_env ON signers(envelope_id, order_index);
CREATE INDEX IF NOT EXISTS signers_token ON signers(token_hash);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  signer_id TEXT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  ip TEXT, ua TEXT, geo TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS events_env ON events(envelope_id, id);
CREATE TABLE IF NOT EXISTS backups (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);
`

export function getDb() {
  if (db) return db
  ensureDataDirs()
  db = new DatabaseSync(path.join(env.dataDir, "esign.sqlite"))
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA)
  return db
}

export function now() {
  return new Date().toISOString()
}

export function one(sql, ...params) {
  return getDb().prepare(sql).get(...params) ?? null
}
export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params)
}
export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params)
}

export function addEvent(envelopeId, kind, { signerId = null, ip = null, ua = null, geo = null, details = null } = {}) {
  run(
    "INSERT INTO events (envelope_id, signer_id, kind, at, ip, ua, geo, details) VALUES (?,?,?,?,?,?,?,?)",
    envelopeId, signerId, kind, now(), ip, ua, geo ? JSON.stringify(geo) : null, details ? JSON.stringify(details) : null
  )
}

export function getEnvelope(id) {
  return one("SELECT * FROM envelopes WHERE id = ?", id)
}
export function getSigners(envelopeId) {
  return all("SELECT * FROM signers WHERE envelope_id = ? ORDER BY order_index, rowid", envelopeId)
}
export function getSigner(id) {
  return one("SELECT * FROM signers WHERE id = ?", id)
}
export function getEvents(envelopeId) {
  return all("SELECT * FROM events WHERE envelope_id = ? ORDER BY id", envelopeId)
}
export function listEnvelopes(limit = 100) {
  return all("SELECT * FROM envelopes ORDER BY created_at DESC LIMIT ?", limit)
}
