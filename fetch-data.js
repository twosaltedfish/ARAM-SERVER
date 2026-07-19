'use strict';

require('dotenv').config();
const { db, getMeta, setMeta } = require('./db');
const { fetchThrottled, normalizeChampion } = require('./lib/dtodo');

const API_KEY = process.env.DTODO_API_KEY;
if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('缺少 DTODO_API_KEY，请在 .env 中填写真实 Key');
  process.exit(1);
}

const FETCH_DETAILS = process.env.FETCH_DETAILS !== 'false';

async function run() {
  console.log('[sync] 开始拉取数据...');

  // 1) config.json（免费、不消耗 credits）——拿到版本与 dataVersion 作为缓存键
  const config = await fetchThrottled('/config.json', { apiKey: API_KEY });
  const version = config.gamePatch || config.version || '';
  const updatedAt = config.generatedAt || '';
  const dataVersion = config.dataVersion || '';

  const lastVersion = getMeta('dataVersion');
  console.log(`[sync] dataVersion local=${lastVersion || 'none'} remote=${dataVersion}`);

  // 数据未变更则跳过全量拉取，省 credits
  if (lastVersion && lastVersion === dataVersion) {
    console.log('[sync] 数据未变更，跳过全量拉取（节省 credits）');
    setMeta('version', version);
    setMeta('updatedAt', updatedAt);
    return;
  }

  // 2) 英雄榜单
  const championsRaw = await fetchThrottled('/champions.json', { apiKey: API_KEY });
  const champions = (Array.isArray(championsRaw) ? championsRaw : []).map(normalizeChampion);
  console.log(`[sync] 英雄榜 ${champions.length} 条`);

  const upsertChamp = db.prepare(`
    INSERT OR REPLACE INTO champions (id, name, alias, title, icon, tier, winRate, pickRate, raw)
    VALUES (@id, @name, @alias, @title, @icon, @tier, @winRate, @pickRate, @raw)
  `);
  const txChamp = db.transaction((list) => {
    for (const c of list) {
      upsertChamp.run({ ...c, raw: JSON.stringify(c) });
    }
  });
  txChamp(champions);

  // 3) 海克斯强化库
  const augmentsRaw = await fetchThrottled('/augments.json', { apiKey: API_KEY });
  const upsertAug = db.prepare('INSERT OR REPLACE INTO augments (id, payload) VALUES (?, ?)');
  const txAug = db.transaction((list) => {
    const arr = Array.isArray(list) ? list : (list && list.data) || [];
    arr.forEach((a, i) => upsertAug.run(String(a.id != null ? a.id : i), JSON.stringify(a)));
  });
  txAug(augmentsRaw);
  console.log('[sync] 强化库已写入');

  // 4) 装备库
  const itemsRaw = await fetchThrottled('/items.json', { apiKey: API_KEY });
  const upsertItem = db.prepare('INSERT OR REPLACE INTO items (id, payload) VALUES (?, ?)');
  const txItem = db.transaction((list) => {
    const arr = Array.isArray(list) ? list : (list && list.data) || [];
    arr.forEach((it, i) => upsertItem.run(String(it.id != null ? it.id : i), JSON.stringify(it)));
  });
  txItem(itemsRaw);
  console.log('[sync] 装备库已写入');

  // 5) 每个英雄详情（按需开关，默认开）
  if (FETCH_DETAILS) {
    const upsertDetail = db.prepare(
      'INSERT OR REPLACE INTO champion_detail (id, payload, updatedAt) VALUES (?, ?, ?)'
    );
    const now = new Date().toISOString();
    let ok = 0;
    for (const c of champions) {
      try {
        const detail = await fetchThrottled(`/champions/${c.id}.json`, { apiKey: API_KEY });
        upsertDetail.run(c.id, JSON.stringify(detail), now);
        ok++;
      } catch (e) {
        console.warn(`[sync] 英雄 ${c.id} 详情失败: ${e.message}`);
      }
    }
    console.log(`[sync] 英雄详情 ${ok}/${champions.length} 条`);
  }

  // 6) 写回 meta
  setMeta('dataVersion', dataVersion);
  setMeta('version', version);
  setMeta('updatedAt', updatedAt);
  setMeta('lastSync', new Date().toISOString());
  console.log('[sync] 完成 ✅');
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[sync] 失败:', e);
    process.exit(1);
  });
