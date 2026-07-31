'use strict';

require('dotenv').config();
const { pinyin } = require('pinyin-pro');
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
// 缓存：每条详情记录 updatedAt 日期，若当日已拉取过则自动跳过（FORCE=true 时跳过此缓存，强制重拉），
// 因此同日内重复运行 sync 几乎不消耗 credits，仅跨天或 FORCE=true 时才重拉。
const FETCH_DETAILS = process.env.FETCH_DETAILS === 'true';

// 海克斯强化库 / 装备库：1.0.0 版本不涉及，默认关闭以省 credits。
// 需要时用 FETCH_AUGMENTS=true / FETCH_ITEMS=true 单独开启（或在 .env 设置）。
const FETCH_AUGMENTS = process.env.FETCH_AUGMENTS === 'true';
const FETCH_ITEMS = process.env.FETCH_ITEMS === 'true';

// 是否重新同步由「版本 version」与「源数据生成日期 updatedAt(generatedAt)」共同决定：
// 两者任一与本地存储不同即重新拉取；都相同则跳过以节省 credits（见下方 run() 判断）。
// FORCE=true 时忽略上述版本比对与所有当日日期缓存，强制全量重新拉取（用于修复解析 bug、验证全链路等）；
// 也可删除 data/aram.db 再 sync 实现彻底重刷。用法：FORCE=true npm run sync
const FORCE = process.env.FORCE === 'true';

// ===== 日期缓存工具 =====
// 每次成功拉取的数据都打上 updatedAt（YYYY-MM-DD）；若 updatedAt 为当天则跳过该数据，
// 避免同日内重复消耗 credits。此跳过始终生效。
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function isToday(dateStr) {
  return typeof dateStr === 'string' && dateStr.slice(0, 10) === todayStr();
}
// 从本地库读取已存的英雄榜（用于命中当日缓存时跳过重新拉取）；含 raw 列以便缓存路径沿用已存原始 JSON
function loadChampionsFromDb() {
  return db.prepare('SELECT id,name,alias,title,icon,tier,winRate,pickRate,raw,pinyin,pinyinInitials FROM champions').all();
}

async function run() {
  console.log('[sync] 开始拉取数据...');

  // 1) config.json（免费、不消耗 credits）——拿到版本与 dataVersion 作为缓存键
  const config = await fetchThrottled('/config.json');
  const version = config.gamePatch || config.version || '';
  const updatedAt = config.generatedAt || '';
  const dataVersion = config.dataVersion || '';

  const lastVersion = getMeta('dataVersion');
  const lastUpdatedAt = getMeta('updatedAt');
  console.log(`[sync] dataVersion local=${lastVersion || 'none'} remote=${dataVersion}`);
  console.log(`[sync] updatedAt  local=${lastUpdatedAt || 'none'} remote=${updatedAt}`);

  // 版本(version)与源数据生成日期(updatedAt/generatedAt)两者都相同 → 跳过全量拉取，省 credits；
  // 两者任一不同（含首次运行/本地无记录）→ 跑后续同步流程。FORCE=true 时忽略此比对，强制跑后续流程。
  if (!FORCE && lastVersion && lastVersion === dataVersion && lastUpdatedAt && lastUpdatedAt === updatedAt) {
    console.log('[sync] 版本与源数据生成日期均未变，跳过全量拉取（节省 credits）');
    return;
  }
  if (FORCE) {
    console.log('[sync] FORCE=true，强制全量重新拉取（忽略版本比对与当日日期缓存）');
  }

  // 2) 英雄榜单（命中当日缓存则跳过拉取，省 1 credit；FORCE=true 时强制重拉）
  const today = todayStr();
  let champions;
  // 第三方原始条目映射（id -> 原始对象），用于 raw 列完整保留原始数据，而非仅归一化子集
  let champRawMap = null;
  const championsDate = getMeta('championsDate');
  if (!FORCE && championsDate && isToday(championsDate)) {
    champions = loadChampionsFromDb(); // 含 raw 列，可沿用库内已存的原始 JSON（不破坏已保留数据）
    console.log(`[sync] 英雄榜命中当日缓存（${champions.length} 条），跳过拉取`);
  } else {
    const championsRaw = await fetchThrottled('/champions.json');
    const rawList = Array.isArray(championsRaw) ? championsRaw : [];
    champions = rawList.map(normalizeChampion);
    champRawMap = new Map(champions.map((c, i) => [c.id, rawList[i]]));
    console.log(`[sync] 英雄榜 ${champions.length} 条`);
  }
  // 同步阶段现算拼音：把中文 name 转成全拼 / 首字母，随英雄榜一起入库（一次计算，搜索只读）
  if (champions && champions.length) {
    for (const c of champions) {
      if (c && typeof c.name === 'string') {
        c.pinyin = pinyin(c.name, { toneType: 'none' }).join('');
        c.pinyinInitials = pinyin(c.name, { pattern: 'first', toneType: 'none' }).join('');
      }
    }
  }
  setMeta('championsDate', today);

  const upsertChamp = db.prepare(`
    INSERT OR REPLACE INTO champions (id, name, alias, title, icon, tier, winRate, pickRate, raw, updatedAt, pinyin, pinyinInitials)
    VALUES (@id, @name, @alias, @title, @icon, @tier, @winRate, @pickRate, @raw, @updatedAt, @pinyin, @pinyinInitials)
  `);
  const txChamp = db.transaction((list) => {
    for (const c of list) {
      // 优先存第三方原始条目（完整保留）；命中当日缓存时库内已含原始 raw 则沿用，不破坏已存数据
      const original = champRawMap ? champRawMap.get(c.id) : (c.raw || null);
      const rawStr = original ? JSON.stringify(original) : (c.raw || '{}');
      upsertChamp.run({ ...c, raw: rawStr, updatedAt: today });
    }
  });
  txChamp(champions);

  // 3) 海克斯强化库（1.0.0 暂不涉及，默认关闭；开启：FETCH_AUGMENTS=true）
  if (FETCH_AUGMENTS) {
    const augDate = getMeta('augmentsDate');
    if (!FORCE && augDate && isToday(augDate)) {
      console.log('[sync] 强化库命中当日缓存，跳过拉取');
    } else {
      const augmentsRaw = await fetchThrottled('/augments.json');
      const upsertAug = db.prepare('INSERT OR REPLACE INTO augments (id, payload, updatedAt) VALUES (?, ?, ?)');
      const txAug = db.transaction((list) => {
        const arr = Array.isArray(list) ? list : (list && list.data) || [];
        arr.forEach((a, i) => upsertAug.run(String(a.id != null ? a.id : i), JSON.stringify(a), today));
      });
      txAug(augmentsRaw);
      setMeta('augmentsDate', today);
      console.log('[sync] 强化库已写入');
    }
  } else {
    console.log('[sync] 跳过海克斯强化库（FETCH_AUGMENTS=false）');
  }

  // 4) 装备库（1.0.0 暂不涉及，默认关闭；开启：FETCH_ITEMS=true）
  if (FETCH_ITEMS) {
    const itemDate = getMeta('itemsDate');
    if (!FORCE && itemDate && isToday(itemDate)) {
      console.log('[sync] 装备库命中当日缓存，跳过拉取');
    } else {
      const itemsRaw = await fetchThrottled('/items.json');
      const upsertItem = db.prepare('INSERT OR REPLACE INTO items (id, payload, updatedAt) VALUES (?, ?, ?)');
      const txItem = db.transaction((list) => {
        const arr = Array.isArray(list) ? list : (list && list.data) || [];
        arr.forEach((it, i) => upsertItem.run(String(it.id != null ? it.id : i), JSON.stringify(it), today));
      });
      txItem(itemsRaw);
      setMeta('itemsDate', today);
      console.log('[sync] 装备库已写入');
    }
  } else {
    console.log('[sync] 跳过装备库（FETCH_ITEMS=false）');
  }

  // 5) 英雄详情（全量拉取；当日已拉取过的英雄自动跳过，省 credits）
  if (FETCH_DETAILS) {
    const upsertDetail = db.prepare(
      'INSERT OR REPLACE INTO champion_detail (id, payload, updatedAt) VALUES (?, ?, ?)'
    );
    const getDetailDate = db.prepare('SELECT updatedAt FROM champion_detail WHERE id = ?');
    const now = new Date().toISOString();
    let ok = 0;
    let cached = 0;
    let quotaHit = false;
    for (let i = 0; i < champions.length; i++) {
      const c = champions[i];
      // 当日已拉取过则跳过（FORCE=true 时强制重拉；跨天或删库才会重拉）
      const row = getDetailDate.get(c.id);
      if (!FORCE && row && row.updatedAt && isToday(row.updatedAt)) {
        cached++;
        if ((i + 1) % 10 === 0) {
          console.log(`[sync] 英雄详情进度(含缓存) ${i + 1}/${champions.length}`);
        }
        continue;
      }
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
    console.log(`[sync] 英雄详情 新拉 ${ok} / 缓存 ${cached} / 共 ${champions.length} 条${quotaHit ? '（额度耗尽提前结束）' : ''}`);
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
