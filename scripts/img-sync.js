'use strict';

// 独立图片同步脚本：把 champions / augments / items 三张列表表中已有的第三方图标
// 下载到本地 public/icons，并把库内 URL 改写为自有域名。
// 与 fetch-data.js 完全解耦——只读取已有 iconUrl，不拉取任何第三方数据、不消耗 API credits。
// 运行：node scripts/img-sync.js
// 可选环境变量：IMG_BASE_URL（默认 https://www.liceworld.online）、IMG_CONCURRENCY（默认 12）

const { db } = require('../db');
const { downloadIcon } = require('../lib/icon-sync');

const BASE_URL = process.env.IMG_BASE_URL || 'https://www.liceworld.online';
const CONCURRENCY = Math.max(1, parseInt(process.env.IMG_CONCURRENCY, 10) || 12);

// 三张列表表配置。champions 用独立 icon 列；augments/items 图标在 payload JSON 的 iconUrl 字段。
const TABLES = [
  { table: 'champions', category: 'champions', mode: 'column', col: 'icon' },
  { table: 'augments', category: 'augments', mode: 'payload', key: 'iconUrl' },
  { table: 'items', category: 'items', mode: 'payload', key: 'iconUrl' },
];

// 简易并发池：同时最多 limit 个异步任务
function mapLimit(items, limit, fn) {
  return new Promise((resolve) => {
    const results = new Array(items.length);
    let i = 0;
    let active = 0;
    let done = 0;
    const tick = () => {
      if (done >= items.length && active === 0) return resolve(results);
      while (active < limit && i < items.length) {
        const idx = i++;
        const item = items[idx];
        active++;
        Promise.resolve()
          .then(() => fn(item, idx))
          .catch((e) => ({ status: 'failed', error: e.message || String(e) }))
          .then((r) => { results[idx] = r; })
          .finally(() => {
            active--;
            done++;
            if (done % 50 === 0) process.stdout.write(`\r    进度 ${done}/${items.length}`);
            tick();
          });
      }
    };
    tick();
  });
}

// champions：icon 是直接列
async function processColumnRow(cfg, row) {
  const remoteUrl = row[cfg.col];
  if (!remoteUrl) return { status: 'skip', reason: 'no-icon' };
  const r = await downloadIcon(cfg.category, row.id, remoteUrl, { baseUrl: BASE_URL });
  if (r.status === 'downloaded') {
    db.prepare(`UPDATE ${cfg.table} SET ${cfg.col} = ? WHERE id = ?`).run(r.localUrl, row.id);
  }
  return r;
}

// augments/items：图标在 payload JSON 内（优先 iconUrl，其次 icon）
async function processPayloadRow(cfg, row) {
  let obj;
  try {
    obj = JSON.parse(row.payload);
  } catch (_) {
    return { status: 'skip', reason: 'bad-json' };
  }
  const keyName = obj.iconUrl != null ? 'iconUrl' : obj.icon != null ? 'icon' : null;
  if (!keyName) return { status: 'skip', reason: 'no-icon' };
  const remoteUrl = obj[keyName];
  const r = await downloadIcon(cfg.category, row.id, remoteUrl, { baseUrl: BASE_URL });
  if (r.status === 'downloaded') {
    obj[keyName] = r.localUrl;
    db.prepare(`UPDATE ${cfg.table} SET payload = ? WHERE id = ?`).run(JSON.stringify(obj), row.id);
  }
  return r;
}

async function syncTable(cfg) {
  const col = cfg.mode === 'column' ? cfg.col : 'payload';
  const rows = db.prepare(`SELECT id, ${col} FROM ${cfg.table}`).all();
  console.log(`[img-sync] ${cfg.table}: ${rows.length} 行`);
  const stats = { downloaded: 0, skipped: 0, failed: 0 };
  await mapLimit(rows, CONCURRENCY, async (row) => {
    const res = cfg.mode === 'column'
      ? await processColumnRow(cfg, row)
      : await processPayloadRow(cfg, row);
    if (res.status === 'downloaded') stats.downloaded++;
    else if (res.status === 'failed') {
      stats.failed++;
      console.warn(`\n  ✗ ${cfg.table}/${row.id}: ${res.error}`);
    } else stats.skipped++;
  });
  console.log(`\r[img-sync] ${cfg.table} 完成 → 下载 ${stats.downloaded} / 跳过 ${stats.skipped} / 失败 ${stats.failed}`);
  return stats;
}

async function main() {
  console.log(`[img-sync] 开始（BASE_URL=${BASE_URL}, 并发=${CONCURRENCY}）`);
  const total = { downloaded: 0, skipped: 0, failed: 0 };
  for (const cfg of TABLES) {
    const s = await syncTable(cfg);
    total.downloaded += s.downloaded;
    total.skipped += s.skipped;
    total.failed += s.failed;
  }
  console.log(`[img-sync] 全部完成 ✅ 下载 ${total.downloaded} / 跳过 ${total.skipped} / 失败 ${total.failed}`);
  if (total.failed > 0) {
    console.log('[img-sync] 失败项已保留原第三方 URL，可重跑本脚本重试');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[img-sync] 失败:', e);
    process.exit(1);
  });
