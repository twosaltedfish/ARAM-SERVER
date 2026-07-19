'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'aram.db');

// 确保数据库目录存在
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS champions (
  id       TEXT PRIMARY KEY,
  name     TEXT,
  alias    TEXT,
  title    TEXT,
  icon     TEXT,
  tier     INTEGER,
  winRate  REAL,
  pickRate REAL,
  raw      TEXT
);

CREATE TABLE IF NOT EXISTS champion_detail (
  id        TEXT PRIMARY KEY,
  payload   TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS augments (
  id      TEXT PRIMARY KEY,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id      TEXT PRIMARY KEY,
  payload TEXT
);
`);

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = { db, getMeta, setMeta, DB_PATH };
