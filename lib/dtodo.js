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
 *   champion / augments / coreGroups / startingSets / augmentTrios / builds / recItems
 * 所有比例字段仍是 0~1 小数，这里统一转成 '52.3%' 文本或 '—'（无数据）。
 * base 取自己同步好的 champions 表（与英雄榜字段一致），保证头部信息与榜单统一。
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
// 装备名解析：优先用条目自带 name，再用 items 库 id→name 兜底，最后退回 id
function itemName(it, itemNameById) {
  if (it && typeof it.name === 'string' && it.name) return it.name;
  if (it && it.id != null && itemNameById && itemNameById[String(it.id)]) return itemNameById[String(it.id)];
  return it && it.id != null ? String(it.id) : '';
}
function flattenItemNames(arr, itemNameById) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  arr.forEach((set) => {
    const list = Array.isArray(set) ? set : [set];
    list.forEach((it) => {
      const n = itemName(it, itemNameById);
      if (n) out.push(n);
    });
  });
  return out;
}

function normalizeChampionDetail(raw, base = {}, itemNameById = {}) {
  raw = raw || {};

  // 1) 英雄头部（优先用榜单已同步的 base，与小程序英雄榜一致）
  const champRaw = raw.champion || {};
  const champGames = champRaw.games != null ? champRaw.games : champRaw.stats && champRaw.stats.games;
  const bTier = base.tier || 0;
  const bWR = base.winRate || 0;
  const bPR = base.pickRate || 0;
  const champion = {
    name: base.name || champRaw.name || '',
    alias: base.alias || champRaw.alias || '',
    title: base.title || champRaw.title || '',
    iconUrl: base.iconUrl || champRaw.iconUrl || '',
    tier: bTier,
    tierClass: 'tier-' + (bTier || 0),
    tierText: bTier > 0 ? 'T' + bTier : '—',
    winRateText: bWR > 0 ? pct(bWR) : '—',
    pickRateText: bPR > 0 ? pct(bPR) : '—',
    gamesText: gamesText(champGames),
  };

  // 2) 海克斯推荐（该英雄海克斯表现，按胜率降序取前 10）
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
          rarityText: ri.text,
          rarityClass: ri.cls,
          tier: s.tier || 0,
          tierText: ti.text,
          tierClass: ti.cls,
          winRateText: num(s.winRate) ? pct(s.winRate) : '—',
          pickRateText: num(s.pickRate) ? pct(s.pickRate) : '—',
          gamesText: gamesText(s.games),
        },
      };
    })
    .sort((x, y) => y._wr - x._wr)
    .slice(0, 10)
    .map((x) => x.out);

  // 3) 该英雄装备表现（用于核心装备 / 装备推荐），按胜率降序
  const itemPerf = (raw.items || [])
    .map((it) => {
      const s = it.stats || {};
      return {
        id: String(it.id != null ? it.id : ''),
        name: it.name || itemNameById[String(it.id)] || '',
        winRate: num(s.winRate) ? s.winRate : null,
        pickRate: num(s.pickRate) ? s.pickRate : null,
      };
    })
    .filter((x) => x.id)
    .sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

  // 4) 核心装备：top9 按胜率分 3 组，每组整组胜率/选取率取均值
  const coreGroups = [];
  const top9 = itemPerf.slice(0, 9);
  for (let g = 0; g < 3; g++) {
    const grp = top9.slice(g * 3, g * 3 + 3);
    if (!grp.length) break;
    const wrs = grp.map((x) => x.winRate).filter((v) => v != null);
    const prs = grp.map((x) => x.pickRate).filter((v) => v != null);
    const avgWR = wrs.length ? wrs.reduce((s, v) => s + v, 0) / wrs.length : null;
    const avgPR = prs.length ? prs.reduce((s, v) => s + v, 0) / prs.length : null;
    coreGroups.push({
      id: 'cg-' + g,
      items: grp.map((x) => ({ id: x.id, name: x.name })),
      winRateText: avgWR != null ? pct(avgWR) : '—',
      pickRateText: avgPR != null ? pct(avgPR) : '—',
    });
  }

  // 5) 出门装：取 builds[0].startingItems（数组的若干套，每套若干装备）
  const buildsRaw = raw.builds || [];
  const firstBuild = buildsRaw[0] || {};
  const startingSets = (Array.isArray(firstBuild.startingItems) ? firstBuild.startingItems : [])
    .slice(0, 3)
    .map((set, i) => ({
      id: 'set-' + i,
      items: (Array.isArray(set) ? set : [set])
        .filter((it) => it != null)
        .map((it) => ({ id: String(it.id != null ? it.id : ''), name: itemName(it, itemNameById) })),
    }))
    .filter((set) => set.items.length);

  // 6) 装备推荐：top12 装备图标
  const recItems = itemPerf.slice(0, 12).map((x) => ({ id: x.id, name: x.name }));

  // 7) 推荐海克斯组合：top5 按胜率
  const augmentTrios = (raw.augmentTrios || [])
    .map((t, i) => {
      const augs = Array.isArray(t.augments) ? t.augments : [];
      const s = t.stats || t;
      const names = augs.length ? augs.map((a) => a.name || '') : Array.isArray(t.names) ? t.names : [];
      return {
        _wr: num(s.winRate) ? s.winRate : -1,
        out: {
          id: 'trio-' + i,
          names,
          namesText: names.join(' + '),
          rarityClasses: augs.map((a) => rarityInfo(a.rarity).cls),
          winRateText: num(s.winRate) ? pct(s.winRate) : '—',
          pickRateText: num(s.pickRate) ? pct(s.pickRate) : '—',
          gamesText: gamesText(s.games),
        },
      };
    })
    .sort((x, y) => y._wr - x._wr)
    .slice(0, 5)
    .map((x) => x.out);

  // 8) 推荐出装（多流派）
  const builds = buildsRaw.map((b, i) => ({
    tag: b.tag || '流派' + (i + 1),
    coreItems: (b.coreItems || []).map((it) => ({ name: itemName(it, itemNameById) })),
    extensions: (b.itemExtensions || []).map((it) => ({ name: itemName(it, itemNameById) })),
    situational: (b.situationalItems || []).map((it) => ({ name: itemName(it, itemNameById) })),
    starting: flattenItemNames(b.startingItems, itemNameById).map((n) => ({ name: n })),
  }));

  return { champion, augments, coreGroups, startingSets, augmentTrios, builds, recItems };
}

module.exports = { BASE, ICON_CDN, fetchJson, fetchThrottled, normalizeChampion, normalizeChampionDetail };
