#!/usr/bin/env node
/**
 * BytePlus DataFinder 新用户数查询（只读）
 * =========================================
 * 结论：DataFinder 事件分析里没有独立的"新用户"指标枚举。
 *   event_indicator 只有: events / event_users / uv_per_au / events_per_user / pv_per_au / measure
 * "新用户数(DNU)" 的正确算法 = 某活跃事件的 event_users(去重人数)，
 *   叠加预置用户属性过滤 user_is_new=1（property_type=profile）。
 *   user_is_new 是"在查询分析时间周期内是否新用户"，与时间粒度有关：
 *   granularity=day 时，用户只在其首次激活那天算新用户 → 按天序列 sum 即去重新用户数。
 *
 * 用法:
 *   node byteplus-df-newuser.js <appId> <uidsFile> <eventName> <days> [granularity]
 *   node byteplus-df-newuser.js probe <appId> <eventName> <days>   # 探针:验证 user_is_new 过滤可用+看全量新用户
 *
 * 复用 byteplus-df-query.js 的签名/POST 逻辑。
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const AK = process.env.BYTEPLUS_DATAFINDER_AK;
const SK = process.env.BYTEPLUS_DATAFINDER_SK;
const HOST = 'analytics.byteplusapi.com';
if (!AK || !SK) { console.error('缺 AK/SK: export $(grep -E BYTEPLUS_DATAFINDER /etc/environment | xargs)'); process.exit(1); }

function sha256HmacHex(key, msg) { return crypto.createHmac('sha256', Buffer.from(key, 'utf-8')).update(msg, 'utf-8').digest('hex'); }
function buildAuth(method, uri, qs, body) {
  const ts = Math.floor(Date.now() / 1000), expire = 1800;
  const info = `ak-v1/${AK}/${ts}/${expire}`;
  const signKey = sha256HmacHex(SK, info);
  const canonical = `HTTPMethod:${method}\nCanonicalURI:${uri}\nCanonicalQueryString:${qs}\nCanonicalBody:${body}`;
  return `${info}/${sha256HmacHex(signKey, canonical)}`;
}
function post(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const uri = '/datafinder' + path;
    const body = JSON.stringify(bodyObj);
    const auth = buildAuth('POST', uri, '', body);
    const req = https.request({ host: HOST, path: uri, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth, 'Content-Length': Buffer.byteLength(body) }, timeout: 40000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j; try { j = JSON.parse(d); } catch { j = { code: -1, raw: d }; } resolve({ status: res.statusCode, json: j }); }); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readUids(f) { return fs.readFileSync(f, 'utf-8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

function lastPeriod(days, gran) { return [{ granularity: gran || 'day', type: 'last', last: { amount: days, unit: 'day' }, timezone: 'Asia/Shanghai' }]; }

// 一个 condition
function cond(name, op, values, type, valType) {
  return { property_value_type: valType || 'string', property_name: name, property_operation: op, property_values: values, property_type: type || 'profile' };
}
// profile_filters: 组合多个 condition (logic=and)
function filters(conds) {
  return [{ show_name: 'f', show_label: 'f', expression: { logic: 'and', conditions: conds } }];
}

function dsl(appId, days, gran, eventName, conds) {
  return {
    version: 3, app_ids: [appId], use_app_cloud_id: true, periods: lastPeriod(days, gran),
    content: {
      query_type: 'event', profile_groups_v2: [],
      profile_filters: conds && conds.length ? filters(conds) : [],
      queries: [[{ event_type: 'origin', show_name: '新用户数', event_name: eventName, groups_v2: [], filters: [], show_label: 'nu', event_indicator: 'event_users' }]],
      option: { skip_cache: false },
    },
  };
}
function item(j) { return j && j.data && j.data[0] && j.data[0].data_item_list && j.data[0].data_item_list[0]; }

async function probe(appId, eventName, days) {
  // 试多种 user_is_new 值/类型写法，找出被接受且返回非0的
  const gran = 'day';
  const variants = [
    ['user_is_new="1" string', [cond('user_is_new', '=', ['1'], 'profile', 'string')]],
    ['user_is_new=1 int',      [cond('user_is_new', '=', [1],  'profile', 'int')]],
    ['user_is_new=true',       [cond('user_is_new', '=', ['true'], 'profile', 'string')]],
  ];
  for (const [label, conds] of variants) {
    const r = await post('/openapi/v1/analysis', dsl(appId, days, gran, eventName, conds));
    const it = item(r.json);
    console.log(`[probe] ${label} -> HTTP${r.status} code${r.json.code}${r.json.code !== 200 ? ' MSG:' + r.json.message : ''} | series=${it ? JSON.stringify(it.data) : 'null'} sum=${it ? it.sum : 'null'}`);
    await sleep(800);
  }
  // 对照：无过滤全量活跃 event_users（新+老）
  const rAll = await post('/openapi/v1/analysis', dsl(appId, days, gran, eventName, null));
  const itAll = item(rAll.json);
  console.log(`[probe] 全量活跃(无过滤) -> code${rAll.json.code} series=${itAll ? JSON.stringify(itAll.data) : 'null'} sum=${itAll ? itAll.sum : 'null'} dates=${rAll.json.data && rAll.json.data[0] ? JSON.stringify(rAll.json.data[0].date_index_list) : ''}`);
}

async function run(appId, uidsFile, eventName, days, gran) {
  gran = gran || 'day';
  const uids = readUids(uidsFile);
  console.log(`[newuser] app=${appId} 人群=${uids.length} event=${eventName} 近${days}天 gran=${gran}`);
  const conds = [
    cond('user_id', 'in', uids, 'profile', 'string'),
    cond('user_is_new', '=', ['1'], 'profile', 'string'),
  ];
  const r = await post('/openapi/v1/analysis', dsl(appId, days, gran, eventName, conds));
  const it = item(r.json);
  const dates = r.json.data && r.json.data[0] ? r.json.data[0].date_index_list : null;
  console.log(`HTTP${r.status} code${r.json.code}${r.json.code !== 200 ? ' MSG:' + r.json.message : ''}`);
  if (it) {
    console.log('日期序列:', JSON.stringify(dates));
    console.log('新用户日序列:', JSON.stringify(it.data));
    console.log('sum(去重新用户数) =', it.sum);
  } else {
    console.log(JSON.stringify(r.json).slice(0, 500));
  }
  await sleep(800);
  // 对照：同人群、同窗口，不加 user_is_new（该人群总活跃去重人数）
  const conds2 = [cond('user_id', 'in', uids, 'profile', 'string')];
  const r2 = await post('/openapi/v1/analysis', dsl(appId, days, gran, eventName, conds2));
  const it2 = item(r2.json);
  if (it2) console.log(`[对照] 该人群总活跃去重(不加new过滤) 日序列=${JSON.stringify(it2.data)} sum=${it2.sum}`);
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'probe') return probe(Number(a[0]), a[1], Number(a[2]) || 5);
  if (cmd && !isNaN(Number(cmd))) return run(Number(cmd), a[0], a[1], Number(a[2]) || 5, a[3]);
  console.log('用法: node byteplus-df-newuser.js <appId> <uidsFile> <eventName> <days> [gran]\n      node byteplus-df-newuser.js probe <appId> <eventName> <days>');
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
