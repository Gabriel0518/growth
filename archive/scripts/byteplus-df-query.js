#!/usr/bin/env node
/**
 * BytePlus DataFinder 人群行为查询工具（只读）
 * ============================================
 * 用途：把一批业务 user_id（通常来自本地 AF 归因圈选的某 campaign 人群）
 *       喂给 DataFinder，聚合查询该人群的产品内行为指标（如人均收发消息数）。
 *
 * ⚠️ 全程只读，绝不调用任何写/元数据接口。
 *
 * 依赖：仅 Node 内置模块（crypto/https/fs）。凭据从 /etc/environment 注入：
 *       BYTEPLUS_DATAFINDER_AK / BYTEPLUS_DATAFINDER_SK
 *   运行前：  set -a; . /etc/environment; set +a
 *
 * 命令：
 *   node byteplus-df-query.js active [appId] [days]
 *       验签名/连通性：查活跃用户数近 N 天（默认 812405 / 5天）
 *
 *   node byteplus-df-query.js flow <appId> <userId>
 *       查单用户行为流（验 id 口径：本地 user_id 是否 == DataFinder user_unique_id）
 *
 *   node byteplus-df-query.js events <appId> [keyword]
 *       列事件元数据，可选关键词过滤（找"收发消息"等事件的真实事件名）
 *
 *   node byteplus-df-query.js cohort-metric <appId> <uidsFile> <eventName> <indicator> [days]
 *       核心：按 uidsFile（每行一个 user_id）圈定人群，查该事件的指标
 *       indicator: pv(总次数) | event_users(触发人数)
 *
 *   node byteplus-df-query.js msg-avg <appId> <uidsFile> <sendEvent> <recvEvent> [days]
 *       一站式：算该人群的人均收发消息数（发/收各查次数+人数，输出多口径人均）
 *
 * ── 血泪经验（都已固化在本脚本，改前先读 docs/byteplus-datafinder.md 第12节）──
 *  1. 签名：sign_key 是 HmacSHA256 的 **hexdigest 字符串**，再当下一次 hmac 的 key
 *     （不是 raw bytes！用 raw bytes 会报 "authorization is invalid"）。
 *  2. period 必须用 type:'last'（近N天）。type:'range' 固定区间缺必填字段会 400。
 *  3. 次数指标叫 **pv**（不是 event_count！event_count 报"操作失败"）；人数=event_users。
 *  4. 人群过滤的 profile_filters condition 字段名（照官方 SDK condition.py）：
 *       property_value_type / property_name / property_operation / property_values / property_type
 *     且 property_type 用 **'profile'**（不是 'user'），过滤维度用 **'user_id'**（不是 user_unique_id）。
 *  5. id 口径：本地业务 user_id == DataFinder user_unique_id == profile 属性 user_id（已实测一致）。
 */
'use strict';
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const AK = process.env.BYTEPLUS_DATAFINDER_AK;
const SK = process.env.BYTEPLUS_DATAFINDER_SK;
const HOST = 'analytics.byteplusapi.com'; // SaaS-非云原生海外(BytePlus)环境专用地址

if (!AK || !SK) {
  console.error('缺少 BYTEPLUS_DATAFINDER_AK / SK。先执行: set -a; . /etc/environment; set +a');
  process.exit(1);
}

// ── HMAC-SHA256 签名（照官方 rangersdk/dslclient/dsl_sign.py）──
function sha256HmacHex(key, msg) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf-8')).update(msg, 'utf-8').digest('hex');
}
function buildAuth(method, uri, queryString, body) {
  const ts = Math.floor(Date.now() / 1000);
  const expire = 1800;
  const signKeyInfo = `ak-v1/${AK}/${ts}/${expire}`;
  const signKey = sha256HmacHex(SK, signKeyInfo); // ← hexdigest 字符串
  const canonical =
    `HTTPMethod:${method}\n` +
    `CanonicalURI:${uri}\n` +
    `CanonicalQueryString:${queryString}\n` +
    `CanonicalBody:${body}`;
  const signature = sha256HmacHex(signKey, canonical); // ← 用 hex 字符串当 key
  return `${signKeyInfo}/${signature}`;
}
function post(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const uri = '/datafinder' + path; // context-path
    const body = JSON.stringify(bodyObj);
    const auth = buildAuth('POST', uri, '', body);
    const req = https.request({
      host: HOST, path: uri, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(data); } catch { j = { code: -1, raw: data }; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

// ── DSL 构造 ──
function lastPeriod(days) {
  return [{ granularity: 'day', type: 'last', last: { amount: days, unit: 'day' }, timezone: 'Asia/Shanghai' }];
}
// 人群过滤：按 user_id 列表（property_type=profile, 字段名 user_id）
function uidFilter(uids) {
  return {
    show_name: '人群', show_label: 'grp',
    expression: {
      logic: 'and',
      conditions: [{
        property_value_type: 'string',
        property_name: 'user_id',
        property_operation: 'in',
        property_values: uids,
        property_type: 'profile',
      }],
    },
  };
}
function eventQuery(appId, days, eventName, indicator, uids) {
  return {
    version: 3, app_ids: [appId], use_app_cloud_id: true, periods: lastPeriod(days),
    content: {
      query_type: 'event', profile_groups_v2: [],
      profile_filters: uids && uids.length ? [uidFilter(uids)] : [],
      queries: [[{
        event_type: 'origin', show_name: 'x', event_name: eventName,
        groups: [], groups_v2: [], filters: [], show_label: 'x', event_indicator: indicator,
      }]],
      option: { skip_cache: false },
    },
  };
}
function sumOf(j) {
  const it = j && j.data && j.data[0] && j.data[0].data_item_list && j.data[0].data_item_list[0];
  return it ? it.sum : null;
}
function readUids(file) {
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 命令 ──
async function cmdActive(appId, days) {
  console.log(`[active] app_id=${appId} 活跃用户数近${days}天...`);
  const dsl = eventQuery(appId, days, 'app_launch', 'event_users', null);
  const r = await post('/openapi/v1/analysis', dsl);
  console.log('HTTP', r.status, 'code', r.json.code);
  const it = r.json.data && r.json.data[0] && r.json.data[0].data_item_list[0];
  if (it) console.log('日活序列:', it.data, '| sum', it.sum);
  else console.log(JSON.stringify(r.json).slice(0, 400));
}

async function cmdFlow(appId, uid) {
  console.log(`[flow] app_id=${appId} uid=${uid} (验 id 口径)...`);
  const r = await post(`/openapi/v1/${appId}/behaviors/flows`, {
    query_id: String(uid), query_type: 'user_unique_id',
    count: 10, orientation: 'earlier', timestamp: Date.now(), current_earliest_timestamp: null,
  });
  console.log('HTTP', r.status, 'code', r.json.code);
  const f = r.json.data && r.json.data.flow && r.json.data.flow[0];
  if (f) console.log('命中! user_unique_id=', f.user && f.user.user_unique_id, '| user_id=', f.user && f.user.user_id, '| 首条事件=', f.event_name);
  else console.log(JSON.stringify(r.json).slice(0, 400));
}

async function cmdEvents(appId, keyword) {
  const r = await post(`/openapi/v1/metadata/${appId}/list/events`, {});
  const list = (r.json.data && (r.json.data.events || r.json.data.list || r.json.data)) || [];
  const arr = Array.isArray(list) ? list : [];
  console.log(`[events] app_id=${appId} 事件总数=${arr.length}`);
  const hit = keyword
    ? arr.filter(e => JSON.stringify(e).toLowerCase().includes(keyword.toLowerCase()))
    : arr;
  hit.forEach(e => console.log(' -', e.name || e.event_name, e.show_name ? `(${e.show_name})` : ''));
}

async function cmdCohortMetric(appId, uidsFile, eventName, indicator, days) {
  const uids = readUids(uidsFile);
  console.log(`[cohort-metric] app_id=${appId} 人群=${uids.length}人 event=${eventName} indicator=${indicator} 近${days}天`);
  const r = await post('/openapi/v1/analysis', eventQuery(appId, days, eventName, indicator, uids));
  console.log('HTTP', r.status, 'code', r.json.code, r.json.code !== 200 ? ('MSG:' + r.json.message) : '');
  console.log('结果 sum =', sumOf(r.json));
}

async function cmdMsgAvg(appId, uidsFile, sendEvent, recvEvent, days) {
  const uids = readUids(uidsFile);
  const N = uids.length;
  console.log(`[msg-avg] app_id=${appId} 人群=${N}人 近${days}天\n`);
  const get = async (ev, ind) => { const r = await post('/openapi/v1/analysis', eventQuery(appId, days, ev, ind, uids)); await sleep(700); return { code: r.json.code, sum: sumOf(r.json), msg: r.json.message }; };
  const sendCnt = await get(sendEvent, 'pv');
  const sendUsr = await get(sendEvent, 'event_users');
  const recvCnt = await get(recvEvent, 'pv');
  const recvUsr = await get(recvEvent, 'event_users');
  const sc = sendCnt.sum || 0, rc = recvCnt.sum || 0;
  console.log(`发消息: 总次数=${sendCnt.sum} 触发人数=${sendUsr.sum}${sendCnt.code !== 200 ? ' ERR:' + sendCnt.msg : ''}`);
  console.log(`收消息: 总次数=${recvCnt.sum} 触发人数=${recvUsr.sum}${recvCnt.code !== 200 ? ' ERR:' + recvCnt.msg : ''}`);
  console.log('\n=== 人均口径 ===');
  console.log(`人群规模(圈选): ${N}`);
  console.log(`人均发消息(÷全人群${N}): ${(sc / N).toFixed(2)}`);
  console.log(`人均收消息(÷全人群${N}): ${(rc / N).toFixed(2)}`);
  console.log(`人均收发合计(÷全人群${N}): ${((sc + rc) / N).toFixed(2)}`);
  if (sendUsr.sum) console.log(`人均发消息(÷发过消息的${sendUsr.sum}活跃者): ${(sc / sendUsr.sum).toFixed(2)}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'active': return cmdActive(Number(args[0]) || 812405, Number(args[1]) || 5);
    case 'flow': return cmdFlow(Number(args[0]), args[1]);
    case 'events': return cmdEvents(Number(args[0]), args[1]);
    case 'cohort-metric': return cmdCohortMetric(Number(args[0]), args[1], args[2], args[3], Number(args[4]) || 14);
    case 'msg-avg': return cmdMsgAvg(Number(args[0]), args[1], args[2], args[3], Number(args[4]) || 14);
    default:
      console.log('命令: active | flow | events | cohort-metric | msg-avg（见文件头注释）');
      process.exit(1);
  }
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
