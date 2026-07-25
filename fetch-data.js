'use strict';

require('dotenv').config();
const { db, getMeta, setMeta } = require('./db');
const { fetchThrottled, normalizeChampion, keyPoolSize } = require('./lib/dtodo');

if (keyPoolSize() === 0) {
  console.error('缺少 API Key：请在 .env 配置 DTODO_API_KEYS=key1,key2（或兼容单 Key 的 DTODO_API_KEY）');
  process.exit(1);
}
console.log(`[sync] 已加载 ${keyPoolSize()} 个 API Key，将自动负载均衡并按剩余额度切换`);

// 英雄详情同步：拉取全部英雄详情（champions/{id}.json，全量 173 名）。
// 全量 173 英雄×2 ≈ 346 credits，需配置多 Key（DTODO_API_KEYS）叠加额度（如 2 Key=400/天）；
// 单 Key(200/天)不够，额度耗尽会中途停止（QUOTA_EXCEEDED）。开启：FETCH_DETAILS=true。
const FETCH_DETAILS = process.env.FETCH_DETAILS === 'true';

// 海克斯强化库 / 装备库：1.0.0 版本不涉及，默认关闭以省 credits。
// 需要时用 FETCH_AUGMENTS=true / FETCH_ITEMS=true 单独开启（或在 .env 设置）。
const FETCH_AUGMENTS = process.env.FETCH_AUGMENTS === 'true';
const FETCH_ITEMS = process.env.FETCH_ITEMS === 'true';

// FORCE=true 时忽略 dataVersion 比对，强制全量重新拉取（用于修复解析 bug 后重刷数据）。
// 用法：FORCE=true npm run sync
const FORCE = process.env.FORCE === 'true';

async function run() {
  console.log('[sync] 开始拉取数据...');

  // 1) config.json（免费、不消耗 credits）——拿到版本与 dataVersion 作为缓存键
  const config = await fetchThrottled('/config.json');
  const version = config.gamePatch || config.version || '';
  const updatedAt = config.generatedAt || '';
  const dataVersion = config.dataVersion || '';

  const lastVersion = getMeta('dataVersion');
  console.log(`[sync] dataVersion local=${lastVersion || 'none'} remote=${dataVersion}`);

  // 数据未变更则跳过全量拉取，省 credits（FORCE=true 时强制重拉，用于修复解析 bug 后重刷）
  if (!FORCE && lastVersion && lastVersion === dataVersion) {
    console.log('[sync] 数据未变更，跳过全量拉取（节省 credits）');
    setMeta('version', version);
    setMeta('updatedAt', updatedAt);
    return;
  }
  if (FORCE) {
    console.log('[sync] FORCE=true，强制全量重新拉取');
  }

  // 2) 英雄榜单
  const championsRaw = await fetchThrottled('/champions.json');
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

  // 3) 海克斯强化库（1.0.0 暂不涉及，默认关闭；开启：FETCH_AUGMENTS=true）
  if (FETCH_AUGMENTS) {
    const augmentsRaw = await fetchThrottled('/augments.json');
    const upsertAug = db.prepare('INSERT OR REPLACE INTO augments (id, payload) VALUES (?, ?)');
    const txAug = db.transaction((list) => {
      const arr = Array.isArray(list) ? list : (list && list.data) || [];
      arr.forEach((a, i) => upsertAug.run(String(a.id != null ? a.id : i), JSON.stringify(a)));
    });
    txAug(augmentsRaw);
    console.log('[sync] 强化库已写入');
  } else {
    console.log('[sync] 跳过海克斯强化库（FETCH_AUGMENTS=false）');
  }

  // 4) 装备库（1.0.0 暂不涉及，默认关闭；开启：FETCH_ITEMS=true）
  if (FETCH_ITEMS) {
    const itemsRaw = await fetchThrottled('/items.json');
    const upsertItem = db.prepare('INSERT OR REPLACE INTO items (id, payload) VALUES (?, ?)');
    const txItem = db.transaction((list) => {
      const arr = Array.isArray(list) ? list : (list && list.data) || [];
      arr.forEach((it, i) => upsertItem.run(String(it.id != null ? it.id : i), JSON.stringify(it)));
    });
    txItem(itemsRaw);
    console.log('[sync] 装备库已写入');
  } else {
    console.log('[sync] 跳过装备库（FETCH_ITEMS=false）');
  }

  // 5) 英雄详情（全量拉取，不再按胜率截取前 N 名）
  if (FETCH_DETAILS) {
    const upsertDetail = db.prepare(
      'INSERT OR REPLACE INTO champion_detail (id, payload, updatedAt) VALUES (?, ?, ?)'
    );
    const now = new Date().toISOString();
    let ok = 0;
    let quotaHit = false;
    for (let i = 0; i < champions.length; i++) {
      const c = champions[i];
      try {
        const detail = await fetchThrottled(`/champions/${c.id}.json`);
        upsertDetail.run(c.id, JSON.stringify(detail), now);
        ok++;
      } catch (e) {
        if (e.message === 'QUOTA_EXCEEDED') {
          quotaHit = true;
          console.warn('[sync] 当日 API 额度耗尽，停止拉取剩余英雄详情');
          break;
        }
        console.warn(`[sync] 英雄 ${c.id} 详情失败: ${e.message}`);
      }
      if ((i + 1) % 10 === 0) {
        console.log(`[sync] 英雄详情进度 ${i + 1}/${champions.length}`);
      }
    }
    console.log(`[sync] 英雄详情 ${ok}/${champions.length} 条${quotaHit ? '（额度耗尽提前结束）' : ''}`);
  } else {
    console.log('[sync] 跳过英雄详情（默认关闭，开启：FETCH_DETAILS=true）');
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
