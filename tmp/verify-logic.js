'use strict';
// 临时验证：用真实原始数据验证 splitTags + 聚合逻辑（不依赖 better-sqlite3）
const fs = require('fs');
const p = 'C:/Users/lice/Desktop/champion-875.raw.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = [{ id: '875', payload: JSON.stringify(j) }];

function splitTags(str) {
  if (!str || typeof str !== 'string') return [];
  return str.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

const championTagCount = new Map();
const buildTagCount = new Map();
const perChampion = {};
let totalBuilds = 0;

rows.forEach((row) => {
  const raw = JSON.parse(row.payload);
  const data = raw.data || raw;
  const builds = data.builds || [];
  const champTags = new Set();
  builds.forEach((b) => {
    if (!b || !b.tags) return;
    const tags = splitTags(b.tags.primary_tags_f3pie);
    if (!tags.length) return;
    totalBuilds += 1;
    tags.forEach((t) => {
      champTags.add(t);
      buildTagCount.set(t, (buildTagCount.get(t) || 0) + 1);
    });
  });
  if (champTags.size) {
    perChampion[row.id] = [...champTags];
    champTags.forEach((t) => championTagCount.set(t, (championTagCount.get(t) || 0) + 1));
  }
});

const distinctTags = [...championTagCount.keys()].sort();
console.log('championsWithDetail =', rows.length);
console.log('totalBuilds =', totalBuilds);
console.log('distinctTagCount =', distinctTags.length, '->', distinctTags);
console.log('perChampion =', JSON.stringify(perChampion));
console.log('buildTagCount =', [...buildTagCount.entries()]);
console.log('championTagCount =', [...championTagCount.entries()]);
