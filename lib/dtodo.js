'use strict';

const BASE = 'https://data.dtodo.cn/api/v1/zh-CN';
const ICON_CDN = 'https://cdn.dtodo.cn/hextech/champion-icons';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 请求 aramgg 接口，自动解包推荐入口的 { meta, data } 结构。
 * 关键：fetch 默认无超时，北京服务器到 data.dtodo.cn 偶发连接挂起会导致无限卡死，
 * 因此用 AbortController 设 20s 超时；超时/网络错误按退避重试（不消耗 credits）。
 * 命中 429 限速也退避重试；402 表示当日额度耗尽，抛 QUOTA_EXCEEDED 让上层停止。
 */
async function fetchJson(apiPath, { apiKey, retries = 4, timeoutMs = 20000 } = {}) {
  const url = BASE + apiPath;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        console.warn(`[dtodo] ⏱️ 请求超时(${timeoutMs}ms) ${apiPath}，${attempt}/${retries} 重试...`);
      } else {
        console.warn(`[dtodo] 网络错误 ${apiPath}: ${e.message}，${attempt}/${retries} 重试...`);
      }
      await sleep(2000 * attempt);
      continue;
    }
    clearTimeout(timer);

    if (res.status === 402) {
      // 当日 credits 额度耗尽，抛特殊错误让上层停止拉取
      throw new Error('QUOTA_EXCEEDED');
    }
    if (res.status === 429) {
      const wait = 5000 * attempt;
      console.warn(`[dtodo] 429 限速，${attempt}/${retries} 次重试，等待 ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      throw new Error(`dtodo ${apiPath} HTTP ${res.status}`);
    }

    const data = await res.json();
    // 推荐入口（不带 /data/）会把数据包在 data 字段里
    if (data && typeof data === 'object' && 'data' in data) {
      return data.data;
    }
    return data;
  }
  throw new Error(`dtodo ${apiPath} 重试 ${retries} 次后仍失败（疑似服务器到 data.dtodo.cn 网络不通）`);
}

/**
 * 带节流的请求：每次请求后 sleep 1.2s，遵守 60 req/min 限速。
 * 当前只拉 config + champions + augments + items 共 4 个请求；
 * 即便将来按需开英雄详情（前 N 名），间隔也远低于每日一次的频率。
 */
async function fetchThrottled(apiPath, opts) {
  const data = await fetchJson(apiPath, opts);
  await sleep(1200);
  return data;
}

/**
 * 把 aramgg 英雄榜单条目归一化成统一结构。
 * 关键：推荐入口 /champions.json 的胜率/强度/登场率包在 stats 对象里
 * （PublicChampion.stats: { tier, wins, games, winRate, pickRate, ... }），
 * 顶层只有 id/name/alias/title/roles/iconUrl。stats 可能为 null（无数据英雄）。
 * - 图标字段名为 iconUrl，缺失时回退 CDN 拼接。
 * - tier 是 "1".."5" 或数字，转整数；winRate/pickRate 是 0~1 小数，原样保留。
 */
function normalizeChampion(c) {
  const id = String(c.id);
  const stats = c.stats || {};
  const icon = c.iconUrl || `${ICON_CDN}/${id}.png`;
  const tierVal = stats.tier != null ? parseInt(stats.tier, 10) : 0;
  return {
    id,
    name: c.name || '',
    alias: c.alias || '',
    title: c.title || '',
    icon,
    tier: tierVal || 0,
    winRate: typeof stats.winRate === 'number' ? stats.winRate : 0,
    pickRate: typeof stats.pickRate === 'number' ? stats.pickRate : 0,
  };
}

/**
 * 把单英雄详情原始返回（/champions/{id}.json 的 data 对象）归一化成
 * 小程序英雄详情页所需的结构。详情页字段定义见 frontend/utils/champions.js：
 *   champion / augments / coreGroups / augmentTrios / builds / recItems
 * 取数严格对齐前端给定字段（已用 id=875 校验）：
 *   英雄信息    : name/alias/title ← data.champion；winRate/pickRate/tier ← data.champion.stats（场次 games 已舍弃）
 *   海克斯推荐  : iconUrl ← data.augments[].iconUrl；tier ← data.augments[].stats.tier；
 *                rarity/rarityName/rarityDisplayName ← data.augments[]；pickRate/winRate ← data.augments[].stats
 *   装备构建    : tag ← data.builds[].tags.primary_tags_f3pie；
 *                coreItems[].items[]/winRate/pickRate ← data.builds[].coreItems；
 *                situationalItems[] ← data.builds[].situationalItems
 *   推荐海克斯组合: augments[].{name,iconUrl,rarity,rarityName} ← data.augmentTrios[].augments；
 *                winRateTier/pickRateTier ← data.augmentTrios[]
 * 推荐海克斯组合按系数降序：coefficient = W_WR*(6-胜率排名) + W_PR*(6-登场率排名)，系数越高越前。
 *
 * base 取自己同步好的 champions 表（与英雄榜字段一致），保证头部信息与榜单统一；
 * 若 base 缺失则回退到 champion.stats。
 */
function pct(x) {
  return (x * 100).toFixed(1) + '%';
}
function num(v) {
  return typeof v === 'number' && !isNaN(v);
}
function gamesText(n) {
  if (num(n) && n > 0) return Math.round(n).toLocaleString('en-US');
  return '';
}
function rarityInfo(r) {
  if (r === 2) return { text: '棱彩', cls: 'r-prism' };
  if (r === 1) return { text: '黄金', cls: 'r-gold' };
  return { text: '白银', cls: 'r-silver' };
}
function tierInfo(t) {
  const n = parseInt(t, 10);
  if (n >= 1 && n <= 5) return { text: 'T' + n, cls: 'tier-' + n };
  return { text: '—', cls: 'tier-0' };
}
// 每个流派自带的核心装备：每组带该组真实胜率/选取率（builds[].coreItems 每项自带）。
function buildCoreGroups(coreItems) {
  return (coreItems || [])
    .slice(0, 3)
    .map((grp, g) => {
      const items = (grp.items || [])
        .filter((it) => it != null)
        .map((it) => ({ id: String(it.id != null ? it.id : ''), name: it.name, iconUrl: it.iconUrl || '' }));
      return {
        id: 'cg-' + g,
        items,
        winRateText: num(grp.winRate) ? pct(grp.winRate) : '—',
        pickRateText: num(grp.pickRate) ? pct(grp.pickRate) : '—',
      };
    })
    .filter((grp) => grp.items.length);
}

// 每个流派自带的装备推荐：直接取 situationalItems（已是平铺物品列表，每项含 iconUrl）。
function buildRecItems(situationalItems, itemNameById) {
  return (situationalItems || [])
    .map((it) => ({
      id: String(it.id != null ? it.id : ''),
      name: it.name || itemNameById[String(it.id)] || '',
      iconUrl: it.iconUrl || '',
    }))
    .filter((x) => x.id);
}

function normalizeChampionDetail(raw, base = {}, itemNameById = {}) {
  raw = raw || {};

  // 1) 英雄信息
  //    取数：name/alias/title ← data.champion；winRate/pickRate/tier ← data.champion.stats
  //    场次(games)按需求舍弃，不再输出。
  const champRaw = raw.champion || {};
  const champStats = champRaw.stats || {};
  const bTier = base.tier || champStats.tier || 0;
  const bWR = base.winRate || champStats.winRate || 0;
  const bPR = base.pickRate || champStats.pickRate || 0;
  const champion = {
    name: base.name || champRaw.name || '',
    alias: base.alias || champRaw.alias || '',
    title: base.title || champRaw.title || '',
    iconUrl: base.iconUrl || champRaw.iconUrl || '',
    tier: bTier,
    tierClass: 'tier-' + (bTier || 0),
    tierText: bTier > 0 ? 'T' + bTier : '—',
    winRate: bWR,
    pickRate: bPR,
    winRateText: bWR > 0 ? pct(bWR) : '—',
    pickRateText: bPR > 0 ? pct(bPR) : '—',
  };

  // 2) 海克斯推荐
  //    取数：iconUrl ← data.augments[].iconUrl
  //          tier ← data.augments[].stats.tier
  //          rarity / rarityName / rarityDisplayName ← data.augments[]
  //          pickRate / winRate ← data.augments[].stats
  const augments = (raw.augments || [])
    .map((a) => {
      const s = a.stats || {};
      const ri = rarityInfo(a.rarity);
      const ti = tierInfo(s.tier);
      return {
        _wr: num(s.winRate) ? s.winRate : -1,
        out: {
          id: String(a.id != null ? a.id : a.name),
          name: a.name || '',
          iconUrl: a.iconUrl || '',
          tier: num(s.tier) ? s.tier : 0,
          rarity: a.rarity,
          rarityName: a.rarityName || '',
          rarityDisplayName: a.rarityDisplayName || '',
          pickRate: num(s.pickRate) ? s.pickRate : 0,
          winRate: num(s.winRate) ? s.winRate : 0,
          // 展示辅助字段（由上方原始字段推导，页面渲染用）
          tierText: ti.text,
          tierClass: ti.cls,
          rarityText: a.rarityDisplayName || ri.text,
          rarityClass: ri.cls,
          pickRateText: num(s.pickRate) ? pct(s.pickRate) : '—',
          winRateText: num(s.winRate) ? pct(s.winRate) : '—',
        },
      };
    })
    .sort((x, y) => y._wr - x._wr)
    .map((x) => x.out);

  // 3) 装备构建（按角色标签切换）
  //    取数：tag ← data.builds[].tags.primary_tags_f3pie
  //          coreItems[].items[] 为核心装备组（每组 3 件，含 iconUrl）
  //          coreItems[].winRate / .pickRate 为该组胜率/选取率
  //          situationalItems[] 为装备推荐（含 iconUrl）
  const buildsRaw = raw.builds || [];
  const firstBuild = buildsRaw[0] || {};
  const builds = buildsRaw.map((b, i) => {
    const tags = b.tags || {};
    const primaryTag =
      tags.primary_tags_f3pie || tags.primary_tags || Object.values(tags)[0] || '';
    return {
      tag: primaryTag ? String(primaryTag) : '流派' + (i + 1),
      coreGroups: buildCoreGroups(b.coreItems),
      recItems: buildRecItems(b.situationalItems, itemNameById),
    };
  });
  const coreGroups = buildCoreGroups(firstBuild.coreItems);
  const recItems = buildRecItems(firstBuild.situationalItems, itemNameById);

  // 4) 推荐海克斯组合
  //    取数：augments[].{name,iconUrl,rarity,rarityName} ← data.augmentTrios[].augments
  //          winRateTier / pickRateTier ← data.augmentTrios[]（1 最佳，5 最差）
  //    排序系数：coefficient = W_WR*(6-胜率排名) + W_PR*(6-登场率排名)，系数越高排序越前。
  //    胜率权重高于登场率（强度优先）；权重可调。
  const W_WR = 2;
  const W_PR = 1;
  const MAX_TIER = 5;
  const augmentTrios = (raw.augmentTrios || [])
    .map((t, i) => {
      const augs = Array.isArray(t.augments) ? t.augments : [];
      const wrTier = num(t.winRateTier) ? t.winRateTier : MAX_TIER;
      const prTier = num(t.pickRateTier) ? t.pickRateTier : MAX_TIER;
      const coefficient = W_WR * (MAX_TIER + 1 - wrTier) + W_PR * (MAX_TIER + 1 - prTier);
      return {
        _coef: coefficient,
        _tie: wrTier + prTier,
        _idx: i,
        out: {
          id: 'trio-' + i,
          coefficient,
          winRateTier: wrTier,
          pickRateTier: prTier,
          augments: augs.map((a) => {
            const ri = rarityInfo(a.rarity);
            return {
              name: a.name || '',
              iconUrl: a.iconUrl || '',
              rarity: a.rarity,
              rarityName: a.rarityName || '',
              rarityDisplayName: a.rarityDisplayName || '',
              rarityClass: ri.cls,
            };
          }),
        },
      };
    })
    .sort((x, y) => y._coef - x._coef || x._tie - y._tie || x._idx - y._idx)
    .map((x) => x.out);

  return { champion, augments, coreGroups, augmentTrios, builds, recItems };
}

module.exports = { BASE, ICON_CDN, fetchJson, fetchThrottled, normalizeChampion, normalizeChampionDetail };
