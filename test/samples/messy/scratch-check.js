// 一次性脚本：检查历史数据里有多少条记录缺少 id。
// 用完即删，不该进入版本库。

import fs from 'node:fs';

const raw = fs.readFileSync(new URL('../data/users.json', import.meta.url), 'utf8');
const rows = JSON.parse(raw);
const missing = rows.filter((r) => r.id === undefined).length;
console.log(`missing id: ${missing} / ${rows.length}`);
