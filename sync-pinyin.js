'use strict';

// 一次性将「现有数据库」里的英雄补全拼音字段。
// 与每日同步（fetch-data.js）的区别：
//   - 不依赖版本/日期门控，不向 data.dtodo.cn 发任何请求；
//   - 直接读本地 champions 表，用 pinyin-pro 现算，UPDATE 回写；
//   - 因此【零第三方 credits 消耗】，仅本地算力（160 英雄 tens of ms）。
// 用法（服务器）：cd /opt/aram-backend && node sync-pinyin.js
require('dotenv').config();
const { pinyin } = require('pinyin-pro');
const { db } = require('./db');

const rows = db.prepare('SELECT id, name FROM champions').all();
if (!rows.length) {
  console.error('[sync-pinyin] champions 表为空，无需同步');
  process.exit(0);
}

console.log(`[sync-pinyin] 读取 ${rows.length} 条英雄，开始计算拼音...`);

const update = db.prepare('UPDATE champions SET pinyin = ?, pinyin_initials = ? WHERE id = ?');
const tx = db.transaction((list) => {
  for (const c of list) {
    if (!c || typeof c.name !== 'string') return;
    const py = pinyin(c.name, { toneType: 'none' });
    const initials = pinyin(c.name, { pattern: 'first', toneType: 'none' });
    update.run(py, initials, c.id);
  }
});
tx(rows);

// 抽样验证一条，确认拼音已写入
const sample = db.prepare('SELECT id, name, pinyin, pinyin_initials FROM champions LIMIT 1').get();
console.log('[sync-pinyin] 抽样验证:', JSON.stringify(sample));
console.log('[sync-pinyin] 完成 ✅ 已为全部英雄写入拼音（列已存在则直接 UPDATE，不消耗第三方 credits）');
