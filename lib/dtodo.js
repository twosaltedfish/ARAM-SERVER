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
 * 把 aramgg 英雄条目归一化成统一结构。
 * - icon 可能是完整 URL 或 [id, url] 元组，统一成完整 CDN URL。
 * - tier 字符串 "1".."5" 转整数；winRate 是 0~1 小数，原样保留。
 */
function normalizeChampion(c) {
  const id = String(c.id);
  let icon = c.icon;
  if (Array.isArray(icon)) {
    icon = `${ICON_CDN}/${id}.png`;
  }
  if (!icon || typeof icon !== 'string') {
    icon = `${ICON_CDN}/${id}.png`;
  }
  return {
    id,
    name: c.name || '',
    alias: c.alias || '',
    title: c.title || '',
    icon,
    tier: parseInt(c.tier, 10) || 0,
    winRate: typeof c.winRate === 'number' ? c.winRate : 0,
    pickRate: typeof c.pickRate === 'number' ? c.pickRate : 0,
  };
}

module.exports = { BASE, ICON_CDN, fetchJson, fetchThrottled, normalizeChampion };
