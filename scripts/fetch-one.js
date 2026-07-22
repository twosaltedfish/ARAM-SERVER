'use strict';

/**
 * 一次性测试脚本：拉取单个英雄的真实详情，用于校准归一化逻辑。
 *
 * 用法（在 backend 目录下执行，需 .env 里已配置 DTODO_API_KEY）：
 *   node scripts/fetch-one.js            # 默认 id=875（雷娜塔 Renata Glasc）
 *   node scripts/fetch-one.js 266        # 指定英雄 id（如 266 = 亚托克斯 Aatrox）
 *
 * 它会做三件事：
 *   1) 请求 /champions/{id}.json 的【原始完整响应】，保存到 tmp/champion-{id}.raw.json
 *   2) 若 champions/items 表已同步，取出 base 与 itemNameById，跑一遍
 *      normalizeChampionDetail，保存到 tmp/champion-{id}.normalized.json
 *   3) 在控制台打印原始结构概览 + 归一化后结构概览，方便直接肉眼对照
 *
 * 只消耗 1 credit，不写业务库（champion_detail 表不动），纯只读验证。
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { BASE, normalizeChampionDetail } = require('../lib/dtodo');

const API_KEY = process.env.DTODO_API_KEY;
if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('❌ 缺少 DTODO_API_KEY，请在 backend/.env 中填写真实 Key');
  process.exit(1);
}

const id = String(process.argv[2] || '875');

// tmp 输出目录（相对 backend 根）
const OUT_DIR = path.resolve(__dirname, '..', 'tmp');
fs.mkdirSync(OUT_DIR, { recursive: true });

// 打印一个对象的“形状”（顶层键 + 每个键的类型/长度），不打印海量内容
function shape(obj, indent = '') {
  if (obj == null) return String(obj);
  if (Array.isArray(obj)) {
    const sample = obj.length ? shape(obj[0], indent + '  ') : '(empty)';
    return `Array(${obj.length}) of ${sample}`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    const lines = keys.map((k) => {
      const v = obj[k];
      let desc;
      if (v == null) desc = String(v);
      else if (Array.isArray(v)) desc = `Array(${v.length})`;
      else if (typeof v === 'object') desc = `{ ${Object.keys(v).slice(0, 8).join(', ')} }`;
      else desc = `${typeof v}: ${JSON.stringify(v)}`.slice(0, 80);
      return `${indent}  ${k}: ${desc}`;
    });
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  return `${typeof obj}: ${JSON.stringify(obj)}`;
}

async function main() {
  const url = `${BASE}/champions/${id}.json`;
  console.log(`\n🔎 拉取真实详情：${url}\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error(`❌ 请求失败：${e.name === 'AbortError' ? '超时(20s)' : e.message}`);
    process.exit(1);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`❌ HTTP ${res.status}：${body.slice(0, 300)}`);
    process.exit(1);
  }

  const full = await res.json();
  // 推荐入口会把数据包在 data 字段里；这里两份都留，方便对照
  const data = full && typeof full === 'object' && 'data' in full ? full.data : full;

  // 1) 保存原始完整响应
  const rawPath = path.join(OUT_DIR, `champion-${id}.raw.json`);
  fs.writeFileSync(rawPath, JSON.stringify(full, null, 2), 'utf8');
  console.log(`✅ 原始响应已保存：${rawPath}（${fs.statSync(rawPath).size} 字节）`);

  console.log('\n================ 原始 data 结构概览 ================');
  console.log(shape(data));

  // 2) 尝试用已同步的 champions/items 表补 base 与 itemNameById（可选）
  let base = {};
  let itemNameById = {};
  try {
    const { db } = require('../db');
    const row = db.prepare('SELECT * FROM champions WHERE id = ?').get(id);
    if (row) {
      base = {
        name: row.name,
        alias: row.alias,
        title: row.title,
        iconUrl: row.icon,
        tier: row.tier,
        winRate: row.winRate,
        pickRate: row.pickRate,
      };
      console.log(`\nℹ️  champions 表命中 base：${row.name} T${row.tier}`);
    } else {
      console.log('\nℹ️  champions 表未命中该 id（先跑过 npm run sync 才有 base，本次用原始字段兜底）');
    }
    const items = db.prepare('SELECT id, payload FROM items').all();
    items.forEach((it) => {
      try {
        const p = JSON.parse(it.payload);
        if (p && p.name) itemNameById[String(it.id)] = p.name;
      } catch (_) {}
    });
    if (items.length) console.log(`ℹ️  items 表载入 ${items.length} 条，用于装备 id→中文名兜底`);
  } catch (e) {
    console.log(`\nℹ️  跳过 DB 补全（${e.message}），仅用原始字段归一化`);
  }

  // 3) 归一化并保存
  const normalized = normalizeChampionDetail(data, base, itemNameById);
  const normPath = path.join(OUT_DIR, `champion-${id}.normalized.json`);
  fs.writeFileSync(normPath, JSON.stringify(normalized, null, 2), 'utf8');
  console.log(`\n✅ 归一化结果已保存：${normPath}`);

  console.log('\n================ 归一化后结构概览（详情页消费的形状）================');
  console.log(
    JSON.stringify(
      {
        champion: normalized.champion,
        augments_count: normalized.augments.length,
        augments_sample: normalized.augments[0] || null,
        coreGroups_count: normalized.coreGroups.length,
        coreGroups_sample: normalized.coreGroups[0] || null,
        startingSets_count: normalized.startingSets.length,
        recItems_count: normalized.recItems.length,
        augmentTrios_count: normalized.augmentTrios.length,
        augmentTrios_sample: normalized.augmentTrios[0] || null,
        builds_count: normalized.builds.length,
        builds_sample: normalized.builds[0] || null,
      },
      null,
      2
    )
  );

  console.log('\n🎯 完成。把上面「原始 data 结构概览」贴给我，我据此校准 normalizeChampionDetail。');
  console.log(`   （完整原始 JSON 也在：${rawPath}，可 cat 查看）\n`);
  process.exit(0);
}

main();
