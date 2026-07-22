'use strict';

// 聚合所有已同步英雄（champion_detail 表）中 builds 的标签种类。
// 标签字段：builds[].tags.primary_tags_f3pie，多个标签用 "," 分隔。
// 用法：node scripts/aggregate-tags.js   （DB 路径默认 data/aram.db，可用 DB_PATH 覆盖）
//
// 输出：
//   1) 控制台打印总览（英雄数 / 出装数 / 标签种类数 / 按频率排序的标签表）
//   2) JSON 落盘到 backend/tmp/tags-summary.json

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const TAG_FIELD = 'primary_tags_f3pie';
const OUT_DIR = path.join(__dirname, '..', 'tmp');
const OUT_FILE = path.join(OUT_DIR, 'tags-summary.json');

function splitTags(str) {
  if (!str || typeof str !== 'string') return [];
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function main() {
  const rows = db
    .prepare('SELECT id, payload FROM champion_detail')
    .all();

  if (rows.length === 0) {
    console.log('[aggregate-tags] champion_detail 表为空，没有可统计的英雄数据。');
    console.log('[aggregate-tags] 请先在服务器上执行 FETCH_DETAILS=true npm run sync 拉取英雄详情。');
    return;
  }

  let totalBuilds = 0;
  const perChampion = {};
  // tag -> 出现该标签的「英雄数」（同一英雄多套出装只计一次）
  const championTagCount = new Map();
  // tag -> 出现该标签的「出装数」（每套出装各计一次）
  const buildTagCount = new Map();

  rows.forEach((row) => {
    let raw;
    try {
      raw = JSON.parse(row.payload);
    } catch (e) {
      console.warn(`[aggregate-tags] 跳过 ${row.id}：payload 解析失败 - ${e.message}`);
      return;
    }
    const data = raw.data || raw;
    const builds = data.builds || [];
    const champTags = new Set();

    builds.forEach((b) => {
      if (!b || !b.tags) return;
      const tags = splitTags(b.tags[TAG_FIELD]);
      if (tags.length === 0) return;
      totalBuilds += 1;
      tags.forEach((t) => {
        champTags.add(t);
        buildTagCount.set(t, (buildTagCount.get(t) || 0) + 1);
      });
    });

    if (champTags.size > 0) {
      perChampion[row.id] = [...champTags];
      champTags.forEach((t) => {
        championTagCount.set(t, (championTagCount.get(t) || 0) + 1);
      });
    }
  });

  const distinctTags = [...championTagCount.keys()].sort();
  const tagsByFrequency = distinctTags
    .map((tag) => ({
      tag,
      championCount: championTagCount.get(tag),
      buildCount: buildTagCount.get(tag),
    }))
    .sort((a, b) => b.championCount - a.championCount || b.buildCount - a.buildCount);

  const summary = {
    generatedAt: new Date().toISOString(),
    championsWithDetail: rows.length,
    championsWithTags: Object.keys(perChampion).length,
    totalBuilds,
    distinctTagCount: distinctTags.length,
    tagsByFrequency,
    distinctTags,
    perChampion,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2), 'utf8');

  console.log('==================== 标签聚合结果 ====================');
  console.log(`已同步英雄数 (champion_detail): ${rows.length}`);
  console.log(`含标签的英雄数: ${summary.championsWithTags}`);
  console.log(`出装套数 (builds): ${totalBuilds}`);
  console.log(`\n>>> 标签种类总数: ${summary.distinctTagCount} <<<\n`);
  console.log('按英雄数降序排列:');
  console.log('  标签            英雄数  出装数');
  console.log('  ---------------  ------  ------');
  tagsByFrequency.forEach((t) => {
    console.log(
      '  ' + t.tag.padEnd(14, ' ') + '  ' + String(t.championCount).padStart(4) + '  ' + String(t.buildCount).padStart(4)
    );
  });
  console.log('\n完整 JSON 已写入: ' + OUT_FILE);
}

main();
