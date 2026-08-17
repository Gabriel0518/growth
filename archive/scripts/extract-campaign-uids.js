#!/usr/bin/env node
/**
 * 本地 AF 归因圈人：从某 campaign 的 af_complete_registration 事件提取 user_id 列表
 * ==========================================================================
 * 这是「DataFinder 人群行为查询」链路的前半段：本地归因 → user_id 人群。
 * 输出的 user_id 直接喂给 scripts/byteplus-df-query.js。
 *
 * 用法:
 *   node extract-campaign-uids.js <app_id> <campaign> [outFile]
 *   例: node extract-campaign-uids.js com.doni.appa "Doni And_syh_260701_AEO" output/doni_syh_uids.txt
 *
 * 数据源: /home/admin/dataserver/data.db (records_YYYYMM 表)
 * payload 结构: user_id 藏在 event_value 嵌套 JSON 里（{"user_id":6602652}），campaign 在顶层。
 *
 * ⚠️ 仅对有 user_id 的产品有效：走 AF 归因的安卓产品可用；Romi iOS 用 Adjust 无 user_id，不适用。
 */
'use strict';
const path = require('path');
const fs = require('fs');
let Database;
try { Database = require('better-sqlite3'); }
catch { console.error('需要 better-sqlite3（dashboard 目录已装）。改到 dashboard 下跑或 npm i。'); process.exit(1); }

const DB = '/home/admin/dataserver/data.db';
const [appId, campaign, outFile] = process.argv.slice(2);
if (!appId || !campaign) {
  console.error('用法: node extract-campaign-uids.js <app_id> <campaign> [outFile]');
  process.exit(1);
}

const db = new Database(DB, { readonly: true });
// 找所有 records_* 表
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%'").all().map(r => r.name);

const sql = tables.map(t => `
  SELECT json_extract(json_extract(payload,'$.event_value'),'$.user_id') AS uid
  FROM ${t}
  WHERE app_id = ?
    AND json_extract(payload,'$.event_name') = 'af_complete_registration'
    AND json_extract(payload,'$.campaign') = ?
`).join(' UNION ALL ');

const rows = db.prepare(sql).all(...tables.flatMap(() => [appId, campaign]));
const uids = [...new Set(rows.map(r => r.uid).filter(v => v !== null && v !== undefined).map(String))];

console.log(`app_id=${appId} campaign="${campaign}"`);
console.log(`命中记录 ${rows.length} 条 → 去重 user_id ${uids.length} 个`);

if (outFile) {
  const abs = path.resolve(outFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, uids.join('\n') + '\n');
  console.log('已写入', abs);
} else {
  console.log(uids.slice(0, 25).join(','), uids.length > 25 ? '...' : '');
}
db.close();
