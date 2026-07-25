'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, getMeta } = require('./db');
const { normalizeChampionDetail } = require('./lib/dtodo');

const app = express();
const PORT = process.env.PORT || 3000;

// 个人项目，开放 CORS 便于本地/浏览器调试；生产可改为指定域名
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function sourceMeta() {
  return {
    version: getMeta('version') || '',
    updatedAt: getMeta('updatedAt') || '',
    dataVersion: getMeta('dataVersion') || '',
    lastSync: getMeta('lastSync') || '',
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// 同步状态：读取 sync-daily.sh 写入的 data/sync-status.json，便于远程查看上次同步成败与报错原因
const SYNC_STATUS_FILE = path.join(__dirname, 'data', 'sync-status.json');
app.get('/api/sync-status', (req, res) => {
  try {
    if (fs.existsSync(SYNC_STATUS_FILE)) {
      res.json(JSON.parse(fs.readFileSync(SYNC_STATUS_FILE, 'utf8')));
    } else {
      res.json({ lastRun: '', ok: null, error: '尚无同步记录（尚未跑过 sync-daily.sh）' });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 英雄强度榜：按胜率降序，字段对齐小程序 utils/champions.js 的 mock 结构
app.get('/api/champions', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT id, name, alias, title, icon, tier, winRate FROM champions ORDER BY winRate DESC')
      .all();
    const champions = rows.map((r) => ({
      id: r.id,
      name: r.name,
      alias: r.alias,
      title: r.title,
      iconUrl: r.icon,
      tier: r.tier,
      winRate: r.winRate,
    }));
    res.json({ source: sourceMeta(), champions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 英雄榜源数据（原始 raw）：查看缓存下来的第三方原始 JSON，用于核对字段/调试。
// 区别于 /api/champions（归一化子集），这里返回入库时原样保存的 champions.raw。
app.get('/api/champions-raw', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT id, name, updatedAt, raw FROM champions ORDER BY id')
      .all();
    const champions = rows.map((r) => {
      let raw = null;
      try {
        raw = r.raw ? JSON.parse(r.raw) : null;
      } catch (e) {
        raw = { __parseError: String(e), __rawText: r.raw };
      }
      return { id: r.id, name: r.name, updatedAt: r.updatedAt, raw };
    });
    res.json({ source: sourceMeta(), count: champions.length, champions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 单英雄详情：归一化成小程序详情页所需结构后返回。
// 需每日拉取时开启 FETCH_DETAILS=true（默认关闭，省 credits）。未同步返回 404。
app.get('/api/champions/:id', (req, res) => {
  const id = String(req.params.id);
  try {
    const row = db.prepare('SELECT payload FROM champion_detail WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ error: '该英雄详情尚未同步（后端需 FETCH_DETAILS=true npm run sync）' });
    }
    const raw = JSON.parse(row.payload);
    // base 取自己同步好的 champions 表，保证头部信息与英雄榜一致
    const champRow = db
      .prepare('SELECT id, name, alias, title, icon, tier, winRate, pickRate FROM champions WHERE id = ?')
      .get(id);
    const base = champRow
      ? {
          id: champRow.id,
          name: champRow.name,
          alias: champRow.alias,
          title: champRow.title,
          iconUrl: champRow.icon,
          tier: champRow.tier,
          winRate: champRow.winRate,
          pickRate: champRow.pickRate,
        }
      : { id };
    // items 库建 id→name，给出装/装备兜底中文名
    const itemRows = db.prepare('SELECT id, payload FROM items').all();
    const itemNameById = {};
    itemRows.forEach((r) => {
      try {
        const it = JSON.parse(r.payload);
        itemNameById[String(it.id != null ? it.id : r.id)] = it.name || '';
      } catch (e) {
        /* 跳过损坏记录 */
      }
    });
    res.json(normalizeChampionDetail(raw, base, itemNameById));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 海克斯强化库
app.get('/api/augments', (req, res) => {
  try {
    const rows = db.prepare('SELECT payload FROM augments').all();
    res.json({ source: sourceMeta(), augments: rows.map((r) => JSON.parse(r.payload)) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 装备库
app.get('/api/items', (req, res) => {
  try {
    const rows = db.prepare('SELECT payload FROM items').all();
    res.json({ source: sourceMeta(), items: rows.map((r) => JSON.parse(r.payload)) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[server] 监听 http://0.0.0.0:${PORT}`);
});
