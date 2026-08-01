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
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 解析 JSON 请求体（POST/DELETE 添加别名时使用）
app.use(express.json());

// 可选管理员鉴权：仅当配置了 ADMIN_TOKEN 环境变量时才校验，
// 调用写接口需带请求头 x-admin-token 或查询参数 ?token=...；未配置则放行（个人项目便捷）。
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next();
  const provided = req.get('x-admin-token') || (req.query && req.query.token);
  if (provided !== token) {
    return res.status(401).json({ error: '未授权：需 x-admin-token 请求头（或 ?token=）' });
  }
  next();
}

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

// 英雄强度榜：按胜率降序；把用户自定义别名合并进 alias 字段，使前端按 alias 搜索可命中。
app.get('/api/champions', (req, res) => {
  try {
    // 读取全部自定义别名，构造 champion_id -> [alias,...] 映射
    const aliasRows = db.prepare('SELECT champion_id, alias FROM champion_aliases').all();
    const customAliasMap = {};
    for (const r of aliasRows) {
      (customAliasMap[r.champion_id] || (customAliasMap[r.champion_id] = [])).push(r.alias);
    }
    const rows = db
      .prepare('SELECT id, name, alias, title, icon, tier, winRate, pinyin, pinyin_initials FROM champions ORDER BY tier ASC, winRate DESC')
      .all();
    const champions = rows.map((r) => {
      const custom = customAliasMap[r.id] || [];
      return {
        id: r.id,
        name: r.name,
        alias: r.alias, // 仅展示数据源原始别名，避免页面堆一堆别名
        aliases: custom, // 自定义别名数组，前端搜索时与 alias 一起匹配
        pinyin: r.pinyin || '', // 全拼（拼音搜索用，随英雄榜同步写入）
        pinyinInitials: r.pinyin_initials || '', // 首字母（如 ys）
        title: r.title,
        iconUrl: r.icon,
        tier: r.tier,
        winRate: r.winRate,
      };
    });
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
      .prepare('SELECT id, name, updatedAt,信仰 raw FROM champions ORDER BY id')
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

// 单英雄详情源数据（查 champion_detail 表）：按 id 精确取数，返回该英雄抓取后未处理的 payload 原样。
// 区别于 /api/champions（归一化子集）与 /api/champions-raw（全量 champions.raw），这里读 champion_detail.payload。
app.get('/api/champions/:id/source', (req, res) => {
  const id = String(req.params.id);
  try {
    const row = db.prepare('SELECT payload FROM champion_detail WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'champion not found', id });
    let raw = null;
    try {
      raw = row.payload ? JSON.parse(row.payload) : null;
    } catch (e) {
      raw = { __parseError: String(e), __payloadText: row.payload };
    }
    res.json({ id, raw });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- 自定义英雄别名管理（独立于 champions 表，sync 不覆盖）----
// 查看某英雄全部自定义别名（每条带自增 id，供前端精确修改/删除）
app.get('/api/champions/:id/aliases', (req, res) => {
  const id = String(req.params.id);
  try {
    const rows = db
      .prepare('SELECT id, alias, created_at FROM champion_aliases WHERE champion_id = ? ORDER BY id')
      .all(id)
      .map((r) => ({ id: r.id, alias: r.alias, createdAt: r.created_at }));
    res.json({ id, aliases: rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 添加别名：body { "alias": "压缩" } 或 { "aliases": ["压缩","风男"] }
app.post('/api/champions/:id/aliases', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const body = req.body || {};
  const incoming = Array.isArray(body.aliases)
    ? body.aliases
    : body.alias != null
    ? [body.alias]
    : null;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: '请提供 alias（字符串）或 aliases（数组）' });
  }
  const list = [...new Set(incoming.map((s) => String(s).trim()).filter(Boolean))];
  if (list.length === 0) return res.status(400).json({ error: '别名不能为空' });
  const insert = db.prepare('INSERT OR IGNORE INTO champion_aliases (champion_id, alias) VALUES (?, ?)');
  let inserted = 0;
  const tx = db.transaction((items) => {
    for (const a of items) inserted += insert.run(id, a).changes;
  });
  try {
    tx(list);
    const all = db
      .prepare('SELECT id, alias, created_at FROM champion_aliases WHERE champion_id = ? ORDER BY id')
      .all(id)
      .map((r) => ({ id: r.id, alias: r.alias, createdAt: r.created_at }));
    res.json({ id, aliases: all, added: inserted, skipped: list.length - inserted });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 修改（重命名）某条别名：PUT /api/champions/:id/aliases/:aliasId  body { "alias": "新名字" }
app.put('/api/champions/:id/aliases/:aliasId', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const aliasId = Number(req.params.aliasId);
  const body = req.body || {};
  const newAlias = typeof body.alias === 'string' ? body.alias.trim() : '';
  if (!newAlias) return res.status(400).json({ error: '请提供 alias（新别名文本）' });
  try {
    const existing = db
      .prepare('SELECT id, alias FROM champion_aliases WHERE champion_id = ? AND id = ?')
      .get(id, aliasId);
    if (!existing) return res.status(404).json({ error: '未找到该别名' });
    if (existing.alias === newAlias) return res.json({ id, aliasId, alias: newAlias, changed: false });
    const clash = db
      .prepare('SELECT id FROM champion_aliases WHERE champion_id = ? AND alias = ?')
      .get(id, newAlias);
    if (clash) return res.status(409).json({ error: '该英雄已存在同名别名' });
    db.prepare('UPDATE champion_aliases SET alias = ? WHERE champion_id = ? AND id = ?')
      .run(newAlias, id, aliasId);
    res.json({ id, aliasId, alias: newAlias, changed: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 删除某条别名（按 id 精确定位）：DELETE /api/champions/:id/aliases/:aliasId
app.delete('/api/champions/:id/aliases/:aliasId', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const aliasId = Number(req.params.aliasId);
  try {
    const info = db.prepare('DELETE FROM champion_aliases WHERE champion_id = ? AND id = ?').run(id, aliasId);
    const all = db
      .prepare('SELECT id, alias, created_at FROM champion_aliases WHERE champion_id = ? ORDER BY id')
      .all(id)
      .map((r) => ({ id: r.id, alias: r.alias, createdAt: r.created_at }));
    res.json({ id, aliases: all, removed: info.changes });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 删除别名：body { "alias": "压缩" } / { "aliases": [...] } 删指定；{ "clear": true } 清空该英雄全部
app.delete('/api/champions/:id/aliases', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const body = req.body || {};
  if (body.clear) {
    const info = db.prepare('DELETE FROM champion_aliases WHERE champion_id = ?').run(id);
    return res.json({ id, cleared: info.changes, aliases: [] });
  }
  const incoming = Array.isArray(body.aliases)
    ? body.aliases
    : body.alias != null
    ? [body.alias]
    : null;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: '请提供 alias（字符串）或 aliases（数组）；或 clear:true 清空' });
  }
  const list = [...new Set(incoming.map((s) => String(s).trim()).filter(Boolean))];
  const del = db.prepare('DELETE FROM champion_aliases WHERE champion_id = ? AND alias = ?');
  const tx = db.transaction((items) => {
    for (const a of items) del.run(id, a);
  });
  try {
    tx(list);
    const all = db
      .prepare('SELECT id, alias, created_at FROM champion_aliases WHERE champion_id = ? ORDER BY id')
      .all(id)
      .map((r) => ({ id: r.id, alias: r.alias, createdAt: r.created_at }));
    res.json({ id, aliases: all, removed: list.length });
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
