'use strict';

const fs = require('fs');
const path = require('path');

// 图标落盘根目录：<backend>/public/icons/{category}/{id}.png
// 经 nginx /icons 托管（1Panel 配置文件编辑器维护），由 CDN 加速。
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ICONS_DIR = path.join(PUBLIC_DIR, 'icons');

const DEFAULT_TIMEOUT = 20000; // 单张图片下载超时（ms）

function localIconUrl(baseUrl, category, safeId) {
  return `${baseUrl.replace(/\/$/, '')}/icons/${category}/${safeId}.png`;
}

// id 可能含非文件名安全字符，统一清洗避免路径穿越 / URL 异常
function safeIdOf(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function isLocalUrl(url) {
  return typeof url === 'string' && url.indexOf('/icons/') !== -1;
}

function looksLikeHttp(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// 实际下载：fetch + 超时 + 自动跟随重定向 + 写文件
async function downloadOne(remoteUrl, filePath, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(remoteUrl, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf || buf.length === 0) throw new Error('empty body');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载单个图标到本地，返回结构化结果：
 *   { status: 'downloaded', localUrl }       成功（existing:true 表示文件已在、仅纠正 DB）
 *   { status: 'skipped', reason }            已本地化 / 无远程源 → 不改写
 *   { status: 'failed', error }              下载失败 → 保留原 URL，不阻断
 *
 * 幂等：本地文件已存在则跳过下载（existing:true 仍返回 downloaded 以纠正 DB 字段）。
 * 失败不抛异常，由调用方决定是否保留原第三方 URL。
 */
async function downloadIcon(category, id, remoteUrl, opts = {}) {
  const baseUrl = opts.baseUrl || 'https://www.liceworld.online';
  const safeId = safeIdOf(id);
  const filePath = path.join(ICONS_DIR, category, `${safeId}.png`);
  const localUrl = localIconUrl(baseUrl, category, safeId);

  // 字段已是自有域名 → 无需处理
  if (isLocalUrl(remoteUrl)) return { status: 'skipped', reason: 'already-local' };
  // 无有效远程源（空串/非 http）→ 无法下载，保留原样
  if (!looksLikeHttp(remoteUrl)) return { status: 'skipped', reason: 'no-remote' };

  // 文件已存在：不重复下载，仅把 DB 字段纠正为本地 URL（处理「文件在但库未改」的情况）
  if (fs.existsSync(filePath)) {
    return { status: 'downloaded', localUrl, existing: true };
  }

  try {
    await downloadOne(remoteUrl, filePath, opts.timeout || DEFAULT_TIMEOUT);
    return { status: 'downloaded', localUrl };
  } catch (e) {
    return { status: 'failed', error: e.message || String(e) };
  }
}

module.exports = { downloadIcon, ICONS_DIR, isLocalUrl, safeIdOf };
