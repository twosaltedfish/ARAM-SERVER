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

// 海克斯强化库 / 装备库：现在默认开启。策略是「榜单/详情未变化当日」用省下的额度同步这两项基础数据，
// 变化当日则把额度优先给榜单/详情（见下方 championsUnchanged 分流）。
// 关闭：在 .env 显式设置 FETCH_AUGMENTS=false / FETCH_ITEMS=false。
const FETCH_AUGMENTS = process.env.FETCH_AUGMENTS !== 'false';
const FETCH_ITEMS = process.env.FETCH_ITEMS !== 'false';

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
  return db.prepare('SELECT id,name,alias,title,icon,tier,winRate,pickRate,raw,pinyin,pinyin_initials FROM champions').all();
}

// 把「详情」文件（数组 / {data:[...]} / {items:[...]} / {list:[...]} / 以 id 为键的对象）规范化成
// [{ id, payload }]，以便按 id 拆分存入 augment_details / item_details 表。
// 第三方 .zh_cn.json 本地化详情文件形态未完全确定，这里尽量兼容多种结构：
//   - 数组：直接逐条
//   - { data:[] } / { items:[] } / { list:[] }：取数组
//   - 以 id 为键的对象 { "123": {...}, ... }：展开为数组，id 取自键（或对象自身 id 字段）
// id 缺失时用下标兜底，保证每条都能入库。
function normalizeDetailEntries(raw) {
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.data)) entries = raw.data;
    else if (Array.isArray(raw.items)) entries = raw.items;
    else if (Array.isArray(raw.list)) entries = raw.list;
    else {
      // 以 id 为键的对象
      entries = Object.entries(raw).map(([k, v]) =>
        v && typeof v === 'object' ? { ...v, id: v.id != null ? v.id : k } : { id: k, value: v }
      );
    }
  }
  return entries.map((e, i) => {
    const id = e && typeof e === 'object' && e.id != null ? e.id : i;
    return { id: String(id), payload: JSON.stringify(e) };
  });
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

  // 版本(version)与源数据生成日期(updatedAt/generatedAt)两者都相同 → 判定「榜单/详情未变化」。
  // 此时不消耗 credits 重拉榜单/详情，改为把额度用于同步装备/海克斯基础数据（见下方 augments/items 段）。
  // 两者任一不同（含首次运行/本地无记录）→ 判定「榜单/详情有变化」，优先拉取榜单与详情。
  // FORCE=true 时忽略此比对，强制视为有变化（优先榜单/详情）。
  const championsUnchanged = !FORCE && lastVersion && lastVersion === dataVersion && lastUpdatedAt && lastUpdatedAt === updatedAt;
  if (championsUnchanged) {
    console.log('[sync] 榜单/详情未变化（version 与 generatedAt 均一致），将额度用于基础数据同步');
  } else {
    console.log('[sync] 榜单/详情有变化（或首次运行/FORCE），优先拉取榜单与详情');
  }

  // 2) 英雄榜单
  const today = todayStr();
  let champions;
  let champRawMap = null;
  const championsDate = getMeta('championsDate');
  if (championsUnchanged) {
    // 榜单未变：直接复用库内英雄（不拉 champions.json，省 1 credit）
    champions = loadChampionsFromDb(); // 含 raw/pinyin 列，沿用库内已存数据
    console.log(`[sync] 榜单未变化，复用库内 ${champions.length} 条英雄（不拉 champions.json）`);
  } else if (!FORCE && championsDate && isToday(championsDate)) {
    champions = loadChampionsFromDb(); // 含 raw 列，可沿用库内已存的原始 JSON（不破坏已保留数据）
    console.log(`[sync] 英雄榜命中当日缓存（${champions.length} 条），跳过拉取`);
  } else {
    const championsRaw = await fetchThrottled('/champions.json');
    const rawList = Array.isArray(championsRaw) ? championsRaw : [];
    champions = rawList.map(normalizeChampion);
    champRawMap = new Map(champions.map((c, i) => [c.id, rawList[i]]));
    console.log(`[sync] 英雄榜 ${champions.length} 条`);
  }
  // 同步阶段现算拼音：把中文 name 转成全拼 / 首字母，随英雄榜一起入库（一次计算，搜索只读）。
  // 仅当真正重新拉取（非复用库内）时重算并回写；复用库内时数据已是最新，跳过避免无谓写入。
  if (!championsUnchanged && champions && champions.length) {
    for (const c of champions) {
      if (c && typeof c.name === 'string') {
        c.pinyin = pinyin(c.name, { toneType: 'none' }).replace(/\s/g, '');
        c.pinyinInitials = pinyin(c.name, { pattern: 'first', toneType: 'none' }).replace(/\s/g, '');
      }
    }
  }
  if (!championsUnchanged) setMeta('championsDate', today);

  const upsertChamp = db.prepare(`
    INSERT OR REPLACE INTO champions (id, name, alias, title, icon, tier, winRate, pickRate, raw, updatedAt, pinyin, pinyin_initials)
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
  // 榜单未变时库内已是最新，跳过回写
  if (!championsUnchanged) txChamp(champions);

  // 3) 海克斯强化库（默认开启）。仅当「榜单/详情未变化」时才同步——把省下的额度用于此处；
  //    榜单/详情有变化的日子，额度优先给榜单/详情，跳过此处（见 championsUnchanged 分流）。
  if ((championsUnchanged || FORCE) && FETCH_AUGMENTS) {
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
  } else if (!championsUnchanged && !FORCE) {
    console.log('[sync] 榜单/详情有变化，跳过海克斯强化库（额度优先用于榜单/详情）');
  } else {
    console.log('[sync] 跳过海克斯强化库（FETCH_AUGMENTS=false）');
  }

  // 4) 装备库（默认开启）。触发逻辑同海克斯强化库：仅榜单/详情未变化当日同步。
  if ((championsUnchanged || FORCE) && FETCH_ITEMS) {
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
  } else if (!championsUnchanged && !FORCE) {
    console.log('[sync] 榜单/详情有变化，跳过装备库（额度优先用于榜单/详情）');
  } else {
    console.log('[sync] 跳过装备库（FETCH_ITEMS=false）');
  }

  // 3b) 海克斯强化「详情」（每个海克斯的详细数据）。
  //     来源：/data/aram-mayhem-augments.zh_cn.json（单个文件，含全部海克斯完整字段）。
  //     触发逻辑同强化库列表：仅「榜单/详情未变化」当日（或 FORCE）同步；变化当日额度优先给榜单/详情。
  //     单列 try 保护：详情拉取失败不影响榜单/列表等其他数据继续写入。
  if ((championsUnchanged || FORCE) && FETCH_AUGMENTS) {
    const adDate = getMeta('augmentDetailDate');
    if (!FORCE && adDate && isToday(adDate)) {
      console.log('[sync] 强化详情命中当日缓存，跳过拉取');
    } else {
      try {
        const detailRaw = await fetchThrottled('/data/aram-mayhem-augments.zh_cn.json');
        const entries = normalizeDetailEntries(detailRaw);
        const upsertAD = db.prepare('INSERT OR REPLACE INTO augment_details (id, payload, updatedAt) VALUES (?, ?, ?)');
        const txAD = db.transaction((list) => {
          list.forEach((e) => upsertAD.run(e.id, e.payload, today));
        });
        txAD(entries);
        setMeta('augmentDetailDate', today);
        console.log(`[sync] 强化详情已写入 ${entries.length} 条`);
        if (entries[0]) {
          try {
            console.log('[sync] 强化详情样本 keys:', Object.keys(JSON.parse(entries[0].payload)).join(','));
          } catch (_) {
            /* 样本仅用于调试，解析失败忽略 */
          }
        }
      } catch (e) {
        console.warn('[sync] 强化详情拉取失败（不影响其他数据）:', e.message);
      }
    }
  } else if (!championsUnchanged && !FORCE) {
    console.log('[sync] 榜单/详情有变化，跳过海克斯强化详情（额度优先用于榜单/详情）');
  } else {
    console.log('[sync] 跳过海克斯强化详情（FETCH_AUGMENTS=false）');
  }

  // 4b) 装备「详情」（每个装备的详细数据）。
  //     来源：/data/items-zh_cn.json（单个文件，含全部装备完整字段）。
  //     触发逻辑同装备库列表：仅「榜单/详情未变化」当日（或 FORCE）同步。
  if ((championsUnchanged || FORCE) && FETCH_ITEMS) {
    const idDate = getMeta('itemDetailDate');
    if (!FORCE && idDate && isToday(idDate)) {
      console.log('[sync] 装备详情命中当日缓存，跳过拉取');
    } else {
      try {
        const detailRaw = await fetchThrottled('/data/items-zh_cn.json');
        const entries = normalizeDetailEntries(detailRaw);
        const upsertID = db.prepare('INSERT OR REPLACE INTO item_details (id, payload, updatedAt) VALUES (?, ?, ?)');
        const txID = db.transaction((list) => {
          list.forEach((e) => upsertID.run(e.id, e.payload, today));
        });
        txID(entries);
        setMeta('itemDetailDate', today);
        console.log(`[sync] 装备详情已写入 ${entries.length} 条`);
        if (entries[0]) {
          try {
            console.log('[sync] 装备详情样本 keys:', Object.keys(JSON.parse(entries[0].payload)).join(','));
          } catch (_) {
            /* 样本仅用于调试，解析失败忽略 */
          }
        }
      } catch (e) {
        console.warn('[sync] 装备详情拉取失败（不影响其他数据）:', e.message);
      }
    }
  } else if (!championsUnchanged && !FORCE) {
    console.log('[sync] 榜单/详情有变化，跳过装备详情（额度优先用于榜单/详情）');
  } else {
    console.log('[sync] 跳过装备详情（FETCH_ITEMS=false）');
  }

  // 5) 英雄详情（全量拉取；当日已拉取过的英雄自动跳过，省 credits）
  //    榜单/详情未变化时整体跳过重拉（额度留给基础数据）；有变化且开启 FETCH_DETAILS 才拉取
  if (!championsUnchanged && FETCH_DETAILS) {
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
  } else if (championsUnchanged) {
    console.log('[sync] 榜单未变化，跳过英雄详情重拉（省 credits）');
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
