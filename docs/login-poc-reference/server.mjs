/**
 * 方案 C 登录原型服务 —— 端口 8099
 * 首次登录：飞书 OAuth 授权拿 open_id+姓名 → 存库 → 推卡片确认 → 点确认放行
 * 二次登录：选人（已存的姓名）→ 用存的 open_id 推卡片 → 点确认放行
 * 敏感操作：/sensitive 演示，操作前推卡片二次确认
 * 卡片回调：长连接（无需公网）
 */
import express from 'express';
import session from 'express-session';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  APP_ID, APP_SECRET, buildAuthUrl, exchangeCode, upsertUser, listUsers, getUser,
  createChallenge, getChallenge, markChallenge, sendConfirmCard,
} from './lark.mjs';

const PORT = 8099;
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'poc-secret-please-change', resave: false, saveUninitialized: true, cookie: { maxAge: 7 * 864e5 } }));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

// ---------- 长连接：收卡片回调 ----------
const wsClient = new Lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: Lark.LoggerLevel.error });
const dispatcher = new Lark.EventDispatcher({}).register({
  'card.action.trigger': async (data) => {
    const value = data?.action?.value ?? {};
    const openId = data?.operator?.open_id;
    const nonce = value.nonce;
    console.log(`[card] ${openId} -> ${value.action} nonce=${nonce}`);
    const c = getChallenge(nonce);
    if (!c || c.status !== 'pending') {
      return { toast: { type: 'error', content: '该请求已失效' } };
    }
    if (c.open_id !== openId) {
      return { toast: { type: 'error', content: '非本人，拒绝' } };
    }
    if (value.action === 'confirm') {
      markChallenge(nonce, 'confirmed');
      return { toast: { type: 'success', content: '已确认 ✅' },
        card: { type: 'raw', data: { header: { template: 'green', title: { tag: 'plain_text', content: '✅ 已确认' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: `校验码 \`${nonce}\` 已确认，网页端可继续。` } }] } } };
    } else {
      markChallenge(nonce, 'rejected');
      return { toast: { type: 'info', content: '已拒绝' },
        card: { type: 'raw', data: { header: { template: 'red', title: { tag: 'plain_text', content: '✖️ 已拒绝' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: `已拒绝校验码 \`${nonce}\`。` } }] } } };
    }
  },
});
wsClient.start({ eventDispatcher: dispatcher });
console.log('[ws] 长连接已启动');

// ---------- 登录页 ----------
app.get('/login', (req, res) => {
  const users = listUsers();
  const options = users.map(u => `<option value="${u.open_id}">${u.name}</option>`).join('');
  res.send(`<!doctype html><meta charset=utf8><title>登录</title>
  <style>body{font-family:sans-serif;background:#0e0e1e;color:#eee;display:flex;justify-content:center;padding-top:80px}
  .box{background:#12122a;border:1px solid #333;border-radius:12px;padding:36px;width:380px}
  h1{color:#8888cc;text-align:center;font-size:20px}
  button,select{width:100%;padding:11px;margin-top:10px;border-radius:8px;border:1px solid #444;background:#1a1a3a;color:#eee;font-size:15px;cursor:pointer}
  .btn{background:#3b5bdb;border:none}.hr{margin:22px 0;border-top:1px solid #333;text-align:center}
  small{color:#888}</style>
  <div class=box><h1>📊 Sitin 仪表板</h1>
  <form action=/auth/start method=get>
    <button class=btn>🆕 首次登录（飞书授权）</button>
  </form>
  <div class=hr><small>—— 或 已授权用户 ——</small></div>
  <form action=/login/pick method=post>
    <select name=open_id required>${options || '<option disabled>（暂无已授权用户）</option>'}</select>
    <button>👤 我是本人，推送确认</button>
  </form>
  </div>`);
});

// 首次：跳 OAuth
app.get('/auth/start', (req, res) => {
  const host = req.headers.host;
  const redirectUri = `http://${host}/auth/callback`;
  const state = Math.random().toString(36).slice(2);
  req.session.oauthState = state;
  req.session.redirectUri = redirectUri;
  res.redirect(buildAuthUrl(redirectUri, state));
});

// OAuth 回调：换 open_id+姓名 → 存库 → 推卡片
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send('缺 code');
  try {
    const { openId, name } = await exchangeCode(code);
    upsertUser(openId, name);
    const nonce = createChallenge(openId, 'login');
    await sendConfirmCard(openId, { nonce, purpose: 'login', name });
    req.session.pendingNonce = nonce;
    req.session.pendingOpenId = openId;
    req.session.pendingName = name;
    res.redirect('/waiting');
  } catch (e) {
    res.send('OAuth 失败: ' + (e?.response?.data?.msg || e.message));
  }
});

// 二次：选人 → 推卡片
app.post('/login/pick', async (req, res) => {
  const openId = req.body.open_id;
  const u = getUser(openId);
  if (!u) return res.redirect('/login');
  const nonce = createChallenge(openId, 'login');
  await sendConfirmCard(openId, { nonce, purpose: 'login', name: u.name });
  req.session.pendingNonce = nonce;
  req.session.pendingOpenId = openId;
  req.session.pendingName = u.name;
  res.redirect('/waiting');
});

// 等待确认页（轮询）
app.get('/waiting', (req, res) => {
  if (!req.session.pendingNonce) return res.redirect('/login');
  res.send(`<!doctype html><meta charset=utf8><title>等待确认</title>
  <style>body{font-family:sans-serif;background:#0e0e1e;color:#eee;text-align:center;padding-top:120px}</style>
  <h2>📲 已向 ${req.session.pendingName || ''} 的飞书推送确认卡片</h2>
  <p>请在飞书中点击「✅ 确认登录」…</p><p id=s style=color:#888></p>
  <script>
  const t=setInterval(async()=>{const r=await fetch('/login/status');const j=await r.json();
    if(j.status==='confirmed'){clearInterval(t);location.href='/'}
    else if(j.status==='rejected'){document.getElementById('s').innerText='❌ 已被拒绝';clearInterval(t)}
    else if(j.status==='expired'){document.getElementById('s').innerText='⌛ 已超时，请重试';clearInterval(t)}
  },1500);
  </script>`);
});

// 轮询状态；确认则种 session
app.get('/login/status', (req, res) => {
  const nonce = req.session.pendingNonce;
  if (!nonce) return res.json({ status: 'none' });
  const c = getChallenge(nonce);
  if (!c) return res.json({ status: 'none' });
  if (c.status === 'confirmed') {
    req.session.authenticated = true;
    req.session.openId = req.session.pendingOpenId;
    req.session.name = req.session.pendingName;
    req.session.pendingNonce = null;
  }
  res.json({ status: c.status });
});

// 首页（受保护）
app.get('/', requireAuth, (req, res) => {
  res.send(`<!doctype html><meta charset=utf8><title>仪表板</title>
  <style>body{font-family:sans-serif;background:#0e0e1e;color:#eee;padding:60px}</style>
  <h1>✅ 已登录：${req.session.name}</h1>
  <p>open_id: <code>${req.session.openId}</code></p>
  <form action=/sensitive method=post><button style="padding:10px 20px">🔒 执行一个敏感操作（触发二次卡片确认）</button></form>
  <p><a href=/logout style=color:#88a>登出</a></p>`);
});

// 敏感操作：先推卡片确认
app.post('/sensitive', requireAuth, async (req, res) => {
  const nonce = createChallenge(req.session.openId, 'sensitive', '删除全部投放数据（演示）');
  await sendConfirmCard(req.session.openId, { nonce, purpose: 'sensitive', detail: '删除全部投放数据（演示）', name: req.session.name });
  req.session.opNonce = nonce;
  res.send(`<!doctype html><meta charset=utf8><style>body{font-family:sans-serif;background:#0e0e1e;color:#eee;text-align:center;padding-top:120px}</style>
  <h2>⚠️ 已推送敏感操作确认卡片</h2><p id=s>请在飞书确认…</p>
  <script>const t=setInterval(async()=>{const j=await(await fetch('/sensitive/status')).json();
   if(j.status==='confirmed'){document.getElementById('s').innerHTML='✅ 操作已执行（演示）';clearInterval(t)}
   else if(j.status!=='pending'){document.getElementById('s').innerText='❌ '+j.status;clearInterval(t)}},1500)</script>
  <p><a href=/ style=color:#88a>返回</a></p>`);
});
app.get('/sensitive/status', requireAuth, (req, res) => {
  const c = getChallenge(req.session.opNonce);
  res.json({ status: c?.status || 'none' });
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

app.listen(PORT, '0.0.0.0', () => console.log(`[poc] http://0.0.0.0:${PORT}`));
