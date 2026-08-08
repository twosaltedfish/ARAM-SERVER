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
  raw      TEXT,
  pinyin          TEXT,
  pinyin_initials TEXT
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

-- 海克斯强化「详情」：单个文件 aram-mayhem-augments.zh_cn.json 的全量详细数据，按 id 拆分存储。
-- 与 augments（列表摘要）区分：列表只含 id/name/icon 等摘要，详情含描述、数值等完整字段。
CREATE TABLE IF NOT EXISTS augment_details (
  id        TEXT PRIMARY KEY,
  payload   TEXT,
  updatedAt TEXT
);

-- 装备「详情」：单个文件 items-zh_cn.json 的全量详细数据，按 id 拆分存储。
-- 与 items（列表摘要）区分：列表只含 id/name/icon 等摘要，详情含描述、属性等完整字段。
CREATE TABLE IF NOT EXISTS item_details (
  id        TEXT PRIMARY KEY,
  payload   TEXT,
  updatedAt TEXT
);

-- 用户自定义英雄别名：独立于 champions 表，sync 重刷不会覆盖。
-- champion_id 对应 champions.id（TEXT），alias 为自定义别名。
CREATE TABLE IF NOT EXISTS champion_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  champion_id TEXT NOT NULL,
  alias       TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(champion_id, alias)
);
`);

// 兼容旧库：为已存在的表补充 updatedAt 列（champion_detail 在建表时已含；其余三表按需补）
for (const t of ['champions', 'augments', 'items']) {
  try {
    db.exec(`ALTER TABLE ${t} ADD COLUMN updatedAt TEXT`);
  } catch (_) {
    /* 列已存在则忽略 */
  }
}
// 兼容旧库：champions 表补充 pinyin 两列（幂等，列已存在则静默跳过）
for (const col of ['pinyin', 'pinyin_initials']) {
  try {
    db.exec(`ALTER TABLE champions ADD COLUMN ${col} TEXT`);
  } catch (_) {
    /* 列已存在则忽略 */
  }
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = { db, getMeta, setMeta, DB_PATH };
