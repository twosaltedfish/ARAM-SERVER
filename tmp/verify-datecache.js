const fs = require('fs');
const tmpDb = 'tmp/datecache-test.db';
if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
process.env.DB_PATH = tmpDb;
const { db } = require('../db.js'); // 自动建表 + 补 updatedAt 列

// 复制 fetch-data.js 中的判定逻辑
function isToday(dateStr) {
  return typeof dateStr === 'string' && dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
}
const getDetailDate = db.prepare('SELECT updatedAt FROM champion_detail WHERE id = ?');

// 种子：id=1 今天、id=2 昨天、id=3 不存在
const today = new Date().toISOString().slice(0, 10);
const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
db.prepare('INSERT OR REPLACE INTO champion_detail (id,payload,updatedAt) VALUES (?,?,?)').run('1', '{}', today);
db.prepare('INSERT OR REPLACE INTO champion_detail (id,payload,updatedAt) VALUES (?,?,?)').run('2', '{}', yest);

// 验证 champions 表也已含 updatedAt 列
const cols = db.prepare("PRAGMA table_info(champions)").all().map(c => c.name);
console.log('champions 列含 updatedAt:', cols.includes('updatedAt') ? '✅' : '❌');
const cols2 = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
console.log('items 列含 updatedAt:', cols2.includes('updatedAt') ? '✅' : '❌');

// 模拟跳过判定（非 FORCE）
let cached = 0;
['1', '2', '3'].forEach((id) => {
  const row = getDetailDate.get(id);
  if (row && row.updatedAt && isToday(row.updatedAt)) cached++;
});
console.log('应跳过数:', cached, '(应为 1，仅 id=1 是今天)');
console.log(cached === 1 ? '✅ 当日缓存跳过判定正确' : '❌ 判定错误');

fs.unlinkSync(tmpDb);
