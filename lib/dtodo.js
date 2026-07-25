'use strict';

const BASE = 'https://data.dtodo.cn/api/v1/zh-CN';
const ICON_CDN = 'https://cdn.dtodo.cn/hextech/champion-icons';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 请求 aramgg 接口，自动解包推荐入口的 { meta, data } 结构。
 * 关键：fetch 默认无超时，北京服务器到 data.dtodo.cn 偶发连接挂起会导致无限卡死，
 * 因此用 AbortController 设 20s 超时；整个“建连 + 读 body”任一环节出错（含响应体中途
 * 断开 UND_ERR_BODY_TIMEOUT/terminated）都按退避重试（不消耗 credits）。
 * 命中 429 限速会先在同 Key 内退避重试，仍持续限速则抛 RATELIMIT 让上层切换到下一 Key 继续；
 * 402 表示当日额度耗尽，抛 QUOTA 让上层标记该 Key 耗尽并切换下一 Key。
 * ⚠️ 注意：第三方接口「额度超出」也可能返回 429（与限速同一状态码），因此 429 不能想当然当成
 * 限速——需要读取响应体判断：命中额度关键词(quota/额度/余额/credits…)即按 QUOTA 处理（换 Key +
 * 标记当日耗尽），否则才按限速退避。见 fetchWithKey 内 looksLikeQuota 判定。
 *
 * 多 Key 支持：通过 DTODO_API_KEYS=key1,key2（兼容单 Key 的 DTODO_API_KEY）配置多个
 * Key，采用「顺序耗尽」策略——按配置顺序逐 Key 尝试，某 Key 额度耗尽(402 或 429-额度)或限速
 * (429-限速)都自动切换到下一个 Key；不做轮询/负载均衡；所有 Key 都不可用则抛错。
 * 显式传入 apiKey 时仍走单 Key（脚本指定场景，如 fetch-one）。
 */

// ===== API Key 池：多 Key 共享每日额度 =====
function loadKeys() {
  const env = process.env.DTODO_API_KEYS || process.env.DTODO_API_KEY || '';
  return env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'your_api_key_here');
}

const KEY_POOL = loadKeys();
// 每个 Key 的运行态：剩余额度(从 x-credits-remaining 学习，Infinity 表示未知) + 当天是否耗尽
const keyState = new Map();
KEY_POOL.forEach((k) => keyState.set(k, { remaining: Infinity, exhausted: false }));

let lastResetDay = new Date().toISOString().slice(0, 10);

// 跨午夜自动重置“当天耗尽”标记，新一天额度恢复
function resetExhaustedIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDay) {
    keyState.forEach((s) => {
      s.exhausted = false;
    });
    lastResetDay = today;
  }
}

// 选 Key：顺序耗尽策略（见 fetchJson）——keyState.exhausted 标记额度耗尽的 Key，
// 多 Key 循环会跳过它并前进到下一个 Key；限速(RATELIMIT)不标记耗尽、仅本次请求换 Key。

function markExhausted(key) {
  const s = keyState.get(key);
  if (s) s.exhausted = true;
}

function noteRemaining(key, remaining) {
  const s = keyState.get(key);
  if (s && Number.isFinite(remaining)) s.remaining = remaining;
}

function keyPoolSize() {
  return KEY_POOL.length;
}

// 读取错误响应体（429/402 等）用于区分「额度耗尽」与「限速」——两者都可能返回 429。
async function readErrorHint(res) {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      // 尝试解析 JSON，把整段序列化后做关键词匹配，覆盖 message/error/code 等字段
      return JSON.stringify(JSON.parse(text));
    } catch {
      return text;
    }
  } catch {
    return '';
  }
}

// 命中额度相关关键词即判定为「额度耗尽」（当日 credits 用尽），否则按真正限速处理。
// 注意关键词需避开「rate limit exceeded」里的 exceed/out of 等限速常用词，否则会误判。
function looksLikeQuota(hint) {
  return /quota|额度|余额|配额|credits?|insufficient|depleted|用完|不足/i.test(hint);
}

// 单次请求（绑定单个 Key）：整个“建连 + 读 body”任一环节出错都退避重试；
// 402 → QUOTA（不重试、交给上层换 Key）；429 需读 body 区分：
//   - 命中额度关键词 → 视为 QUOTA，立即抛出让上层换 Key（同 Key 退避无意义，额度不会秒恢复）
//   - 否则视为真正限速 → 同 Key 退避重试，仍持续则抛 RATELIMIT 让上层切换下一 Key
async function fetchWithKey(url, apiKey, { retries = 5, timeoutMs = 20000, trackHeader = false } = {}) {
  const mask = apiKey.slice(-4);
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        // undici 专用：避免大响应体/慢网络被过早断流（如 augmentTrios 详情）
        headersTimeout: 30000,
        bodyTimeout: 120000,
      });

      if (res.status === 402) {
        // 当日 credits 额度耗尽，抛特殊错误让上层换 Key 或停止（不重试）
        throw Object.assign(new Error('QUOTA_EXCEEDED'), { code: 'QUOTA' });
      }
      if (res.status === 429) {
        clearTimeout(timer);
        // 额度耗尽也可能返回 429，需读 body 区分：
        // 命中额度关键词 → 视为 QUOTA，立即抛出让上层换 Key、标记该 Key 当日耗尽（同 Key 退避无意义）；
        // 否则视为真正限速 → 先同 Key 退避重试，仍持续则抛 RATELIMIT 切换下一 Key。
        const hint = await readErrorHint(res);
        if (looksLikeQuota(hint)) {
          console.warn(`[dtodo] 429 命中额度耗尽关键词，按 QUOTA 处理 key…${mask}`);
          throw Object.assign(new Error('QUOTA_EXCEEDED'), { code: 'QUOTA' });
        }
        const wait = 3000 * attempt;
        if (attempt < retries) {
          console.warn(`[dtodo] 429 限速 key…${mask} ${attempt}/${retries}，退避 ${wait}ms 后同 Key 重试`);
          await sleep(wait);
          continue;
        }
        // 同 Key 内部退避重试仍持续 429 → 抛 RATELIMIT，由多 Key 上层切换到下一 Key 继续
        throw Object.assign(new Error('RATE_LIMITED'), { code: 'RATELIMIT' });
      }
      if (!res.ok) {
        throw new Error(`dtodo ${url} HTTP ${res.status}`);
      }

      if (trackHeader) {
        const rem = parseInt(res.headers.get('x-credits-remaining'), 10);
        noteRemaining(apiKey, rem);
      }

      // 读 body 也在 try 内：网络中途断开(UND_ERR_BODY_TIMEOUT/terminated)会在此抛出并重试
      const data = await res.json();
      clearTimeout(timer);
      // 推荐入口（不带 /data/）会把数据包在 data 字段里
      if (data && typeof data === 'object' && 'data' in data) {
        return data.data;
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      // 额度耗尽(402)与限速(429)都不在本 Key 内重试，直接向上抛，交给多 Key 上层换 Key
      if (e.code === 'QUOTA' || e.code === 'RATELIMIT') throw e;
      if (e.name === 'AbortError') {
        console.warn(`[dtodo] ⏱️ 请求超时(${timeoutMs}ms) ${url}，key…${mask} ${attempt}/${retries} 重试...`);
      } else {
        console.warn(`[dtodo] 网络错误 ${url}: ${e.message}，key…${mask} ${attempt}/${retries} 重试...`);
      }
      await sleep(2000 * attempt);
      continue;
    }
  }
  throw new Error(`dtodo ${url} 重试 ${retries} 次后仍失败（疑似服务器到 data.dtodo.cn 网络不通）`);
}

const RATE_COOLDOWN_MS = 5000; // 单个 Key 命中 429 后的初始冷却时间，连续命中会指数退避（上限 60s）

async function fetchJson(apiPath, { apiKey, retries = 4, timeoutMs = 20000 } = {}) {
  const url = BASE + apiPath;
  const explicitKey = apiKey && apiKey !== 'your_api_key_here' ? apiKey : null;

  // 显式传入 Key（脚本指定）→ 单 Key 模式，直接走 fetchWithKey（429 内部退避重试）
  if (explicitKey) {
    return fetchWithKey(url, explicitKey, { retries, timeoutMs, trackHeader: true });
  }

  // 多 Key 模式：按 DTODO_API_KEYS 配置顺序逐 Key 尝试。
  // - 某 Key 额度耗尽(402/QUOTA)：标记 exhausted 并跳过（顺序耗尽策略）
  // - 某 Key 限速(429/RATELIMIT)：标记该 Key 冷却（指数退避），统一冷却后整轮重试；
  //   即便所有 Key 同属一个账户被一起限速，也会整体退避等待限速窗口重置，而非死磕或秒失败
  // - 其他网络/HTTP 错误：直接抛出，不换 Key（避免误烧其他 Key 额度）
  if (!KEY_POOL.length) {
    throw new Error('NO_API_KEY_CONFIGURED');
  }
  resetExhaustedIfNewDay();
  let lastErr;
  let guard = 0;
  while (true) {
    if (++guard > 20) {
      throw lastErr || new Error(`dtodo ${apiPath} 重试过多，所有 Key 暂不可用`);
    }
    let progressed = false;
    for (const key of KEY_POOL) {
      const st = keyState.get(key);
      if (st.exhausted) continue;
      if (st.rateLimitedUntil && st.rateLimitedUntil > Date.now()) continue;
      progressed = true;
      try {
        return await fetchWithKey(url, key, { retries, timeoutMs, trackHeader: true });
      } catch (e) {
        if (e.code === 'QUOTA') {
          markExhausted(key);
          console.warn(`[dtodo] Key…${key.slice(-4)} 当日额度耗尽，切换下一 Key`);
        } else if (e.code === 'RATELIMIT') {
          // 该 Key 进入冷却；连续命中指数退避，避免对同账户限速狂打
          st.rlCount = (st.rlCount || 0) + 1;
          const cd = Math.min(60000, RATE_COOLDOWN_MS * Math.pow(2, st.rlCount - 1));
          st.rateLimitedUntil = Date.now() + cd;
          console.warn(`[dtodo] Key…${key.slice(-4)} 限速，冷却 ${Math.round(cd / 1000)}s 后重试`);
        } else {
          throw e; // 网络/HTTP 其他错误直接抛出（不误烧其他 Key 额度）
        }
        lastErr = e;
      }
    }
    if (progressed) continue; // 有 Key 试过但都失败，重新循环（冷却中的 Key 下一轮可重试）
    // 所有 Key 都 exhausted 或 处于冷却中
    const cooldowns = KEY_POOL.map((k) => keyState.get(k).rateLimitedUntil || 0).filter((t) => t > Date.now());
    if (cooldowns.length) {
      const wait = Math.min(...cooldowns) - Date.now() + 500;
      console.warn(`[dtodo] 所有可用 Key 限速中，统一冷却 ${Math.ceil(wait / 1000)}s 后重试`);
      await sleep(wait);
      continue;
    }
    if (KEY_POOL.some((k) => keyState.get(k).exhausted)) {
      throw lastErr || new Error(`dtodo ${apiPath} 所有 Key 额度耗尽`);
    }
    throw lastErr || new Error(`dtodo ${apiPath} 所有 Key 暂不可用`);
  }
}

const MIN_INTERVAL_MS = 3000; // 每个成功请求后强制最小间隔，避免突发请求触发网关限速/超时
let lastSuccessEnd = 0;

/**
 * 带节流的请求：保证两次「成功」请求之间至少间隔 MIN_INTERVAL_MS。
 * 单次 curl 正常，但连续高频请求容易被网关限速/超时（偶发 UND_ERR_BODY_TIMEOUT），
 * 故强制错峰。计时以“上一次成功完成”为基准，失败的请求不计入间隔、不阻塞下次重试。
 */
async function fetchThrottled(apiPath, opts) {
  const gap = Date.now() - lastSuccessEnd;
  if (gap < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - gap);
  const data = await fetchJson(apiPath, opts); // 成功才更新时间戳
  lastSuccessEnd = Date.now();
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
      // 排序键：1)强度等级(升序,T1最前) 2)胜率(降序) 3)登场率(降序)
      const tierVal = num(s.tier) ? Number(s.tier) : (parseInt(s.tier, 10) || 99);
      const wr = num(s.winRate) ? s.winRate : -1;
      const pr = num(s.pickRate) ? s.pickRate : -1;
      return {
        _tier: tierVal,
        _wr: wr,
        _pr: pr,
        out: {
          id: String(a.id != null ? a.id : a.name),
          name: a.name || '',
          iconUrl: a.iconUrl || '',
          tier: tierVal >= 99 ? 0 : tierVal,
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
    .sort((x, y) => x._tier - y._tier || y._wr - x._wr || y._pr - x._pr)
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
    .slice(0, 8)
    .map((x) => x.out);

  return { champion, augments, coreGroups, augmentTrios, builds, recItems };
}

module.exports = { BASE, ICON_CDN, fetchJson, fetchThrottled, normalizeChampion, normalizeChampionDetail, keyPoolSize };
