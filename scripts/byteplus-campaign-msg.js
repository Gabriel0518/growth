#!/usr/bin/env node
/**
 * BytePlus DataFinder：按 campaign 名查「新用户发消息 人均次数(PV/UV)」（只读）
 * ==========================================================================
 * 直接用 profile 属性 `campaign` 过滤，无需本地 user_id 归因。
 * （Romi iOS 走 Adjust 没 user_id，本方法专治这种；campaign 属性已在 BytePlus 配好。）
 *
 * 口径（屹恒 2026-07-17 定死）：
 *   事件 = romi_send_message_to_user
 *   过滤 = campaign=<名> AND user_is_new=1（只看新用户）
 *   指标 = 人均次数 = PV/UV
 *     - PV = 新用户发消息总次数
 *     - UV = 发过消息的新用户数（事件自身的 event_users，不是全部新用户）
 *   ⚠️ 人均次数只能自己算 Σpv / Σuv，不能把 BytePlus 逐时返回的 events_per_user 相加/平均
 *      （那是每个小时桶各自的比值，跨桶不可加）。
 *
 * ★ 取数窗口（滑动小时窗口，绕开当天数据延迟）：
 *   ① 看 BytePlus 能看到的「最新一小时」逐时数据；
 *   ② 按当前北京小时 H 往前推 H 个小时 → 取「最新那一小时 + 前面 H 个小时」= 共 (H+1) 个逐时桶。
 *   例：现在北京 10 点(H=10) → 取最新 11 个小时桶（= 北京当天 00:00~10:00 已过去的时长）。
 *   BytePlus ~10h 延迟，最新可能只到昨天 23:00，但仍能拿这段等长窗口的累计。
 *
 * hour 粒度窗口上限 9 天：last{unit:'hour'} 的 amount 被当「天」用，amount≥10 报错。
 *   固定 last{amount:9,unit:'hour'} 取最近 9 天逐时，再从尾部截最新 (H+1) 桶。
 *
 * 用法:
 *   node byteplus-campaign-msg.js "<campaign名>" [hours] [app_id] [sendEvent]
 *     hours 省略 = 自动按当前北京小时 H → 取最新 (H+1) 个小时桶
 *     hours 给数字 = 强制取最新 N 个小时桶
 *   例: node byteplus-campaign-msg.js "Romi iOS_syh_260416_VO"
 *       node byteplus-campaign-msg.js "Romi iOS_syh_260416_VO" 11
 * 默认: app_id=844532(Romi) / sendEvent=romi_send_message_to_user
 *
 * ⚠️ 全程只读。凭据来自 /etc/environment（先 `set -a; . /etc/environment; set +a`）。
 * 踩坑固化见 docs/byteplus-datafinder.md 第 12.7 节。
 */
'use strict';
const crypto = require('crypto');
const https = require('https');

const AK = process.env.BYTEPLUS_DATAFINDER_AK;
const SK = process.env.BYTEPLUS_DATAFINDER_SK;
const HOST = 'analytics.byteplusapi.com';

if (!AK || !SK) {
  console.error('缺少 BYTEPLUS_DATAFINDER_AK / SK。先执行: set -a; . /etc/environment; set +a');
  process.exit(1);
}

const campaign = process.argv[2];
const hoursArg = process.argv[3];
const appId = Number(process.argv[4] || 844532);
const sendEvent = process.argv[5] || 'romi_send_message_to_user';

if (!campaign) {
  console.error('用法: node byteplus-campaign-msg.js "<campaign名>" [hours] [app_id] [sendEvent]');
  process.exit(1);
}

function beijingHour() {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date());
  return parseInt(s, 10);
}
const bjHour = beijingHour();
const wantHours = hoursArg ? Math.max(1, parseInt(hoursArg, 10)) : (bjHour + 1);

// —— 签名 ——
function hmacHex(key, msg) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf-8')).update(msg, 'utf-8').digest('hex');
}
function buildAuth(method, uri, body) {
  const ts = Math.floor(Date.now() / 1000);
  const expire = 1800;
  const info = `ak-v1/${AK}/${ts}/${expire}`;
  const signKey = hmacHex(SK, info);
  const canonical = `HTTPMethod:${method}\nCanonicalURI:${uri}\nCanonicalQueryString:\nCanonicalBody:${body}`;
  return `${info}/${hmacHex(signKey, canonical)}`;
}
function post(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const uri = '/datafinder' + path;
    const body = JSON.stringify(bodyObj);
    const auth = buildAuth('POST', uri, body);
    const req = https.request({
      host: HOST, path: uri, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth, 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { let j; try { j = JSON.parse(data); } catch { j = { code: -1, raw: data.slice(0, 300) }; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

// —— DSL：hour 粒度，事件=发消息，过滤 campaign + user_is_new=1 ——
const CONDNEW = { property_value_type: 'string', property_name: 'user_is_new', property_operation: '=', property_values: ['1'], property_type: 'profile' };
function condCampaign() {
  return { property_value_type: 'string', property_name: 'campaign', property_operation: '=', property_values: [campaign], property_type: 'profile' };
}
function hourQuery(indicator) {
  return {
    version: 3, app_ids: [appId], use_app_cloud_id: true,
    periods: [{ granularity: 'hour', type: 'last', last: { amount: 9, unit: 'hour' }, timezone: 'Asia/Shanghai' }],
    content: {
      query_type: 'event', profile_groups_v2: [],
      profile_filters: [{ show_name: 'c', show_label: 'c', expression: { logic: 'and', conditions: [condCampaign(), CONDNEW] } }],
      queries: [[{ event_type: 'origin', show_name: 'x', event_name: sendEvent, groups: [], groups_v2: [], filters: [], show_label: 'x', event_indicator: indicator }]],
      option: { skip_cache: false },
    },
  };
}
// 取「最新 N 个小时桶」求和；返回覆盖首尾小时
function sumLatestHours(j, n) {
  const d0 = j && j.data && j.data[0];
  if (!d0) return { err: '无 data' };
  if (d0.result_status && d0.result_status !== 'SUCCESS') return { err: d0.error_message || 'FAIL' };
  const dl = d0.date_index_list || [];
  const it = d0.data_item_list && d0.data_item_list[0];
  if (!it || !dl.length) return { err: '无 data_item' };
  const start = Math.max(0, dl.length - n);
  const labels = dl.slice(start);
  const vals = it.data.slice(start);
  const sum = vals.reduce((a, b) => a + (b || 0), 0);
  return { sum, from: labels[0], to: labels[labels.length - 1], count: labels.length };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`app_id=${appId} campaign="${campaign}"`);
  console.log(`事件=${sendEvent} + 过滤 user_is_new=1（只看新用户）`);
  console.log(`当前北京小时 H=${bjHour} → 取最新 ${wantHours} 个小时桶  指标=人均次数(PV/UV)\n`);

  const rPv = await post('/openapi/v1/analysis', hourQuery('pv'));
  await sleep(800);
  const rUv = await post('/openapi/v1/analysis', hourQuery('event_users'));

  if (rPv.json.code !== 200) { console.error('PV 查询失败:', rPv.json.code, rPv.json.message); process.exit(2); }
  if (rUv.json.code !== 200) { console.error('UV 查询失败:', rUv.json.code, rUv.json.message); process.exit(2); }

  const p = sumLatestHours(rPv.json, wantHours);
  const u = sumLatestHours(rUv.json, wantHours);
  if (p.err) { console.error('PV 汇总异常:', p.err); process.exit(2); }
  if (u.err) { console.error('UV 汇总异常:', u.err); process.exit(2); }

  const PV = p.sum;   // 新用户发消息总次数
  const UV = u.sum;   // 发过消息的新用户数
  const avg = UV > 0 ? (PV / UV) : 0; // 人均次数 = PV/UV

  console.log(`窗口: 最新 ${p.count} 小时（北京 ${p.from} ~ ${p.to}）`);
  console.log(`PV 新用户发消息总次数 = ${PV}`);
  console.log(`UV 发消息的新用户数   = ${UV}`);
  console.log(`人均次数(PV/UV)       = ${avg.toFixed(2)}`);

  console.log(`\nRESULT ${JSON.stringify({ appId, campaign, sendEvent, filter: 'user_is_new=1', beijingHour: bjHour, hoursWindow: p.count, fromHourBJ: p.from, toHourBJ: p.to, pv: PV, uv: UV, avgPvPerUv: Number(avg.toFixed(4)) })}`);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
