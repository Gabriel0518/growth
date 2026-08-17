/**
 * Multi-App Data Center 日活抓取。
 * 网站时区为美西（PST/PDT），查北京昨日日活需传美西前一天（即北京昨日 -1 天）。
 * 每日北京 1 点跑一次，结果 upsert 进 daily_snapshots(kind='dau')。
 */

import { request as httpRequest } from 'node:http';

import { query } from '@agentic-ug/db';

const DAU_API_HOST = '62.234.39.191';
const DAU_API_PORT = 8765;
const DAU_USERNAME = 'admin';
const DAU_PASSWORD = '0123210';

export interface DauItem {
  product: string;
  dau: number;
}

/** iOS 产品名（网站 key）→ 我方产品名 */
const IOS_MAP: Record<string, string> = {
  Gracechat: 'GraceChat',
  Dora: 'Dora iOS',
  Romi: 'Romi iOS',
  Luma: 'Luma',
  Mora: 'Mora iOS',
};

/** Android 产品名（网站 key）→ 我方产品名 */
const ANDROID_MAP: Record<string, string> = {
  Dora: 'Dora And',
  Romi: 'Romi And',
  Doni: 'Doni',
  Jovia: 'Jovia And',
  Kira: 'Kira And',
  Nalo: 'Nalo And',
  Ruby: 'Ruby And',
};

interface ApiResponse {
  json: unknown;
  setCookie: string[];
}

function apiRequest(
  path: string,
  method: string,
  body: string,
  cookie: string,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: DAU_API_HOST,
        port: DAU_API_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const setCookie = res.headers['set-cookie'] ?? [];
        let data = '';
        res.on('data', (chunk) => { data += String(chunk); });
        res.on('end', () => {
          try { resolve({ json: JSON.parse(data), setCookie }); } catch { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DAU API timeout')); });
    req.write(body);
    req.end();
  });
}

function pad2(n: number): string { return n.toString().padStart(2, '0'); }

function ymdOffset(offsetDays: number): string {
  const d = new Date(Date.now() + 8 * 3_600_000 - offsetDays * 86_400_000);
  return `${d.getUTCFullYear().toString()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 把 YYYY-MM-DD 按天偏移（负数往前推）。 */
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear().toString()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 登录取 auth cookie。
 * 站点用 `Set-Cookie: auth=...` 下发凭证，响应体只有 `{"ok": true}`；
 * 早期版本把 token 放在 body，故两条路径都留：优先读响应头，回退 body 的 auth/token。
 */
async function login(): Promise<string> {
  const { json, setCookie } = await apiRequest(
    '/api/login', 'POST',
    JSON.stringify({ username: DAU_USERNAME, password: DAU_PASSWORD }),
    '',
  );
  const fromHeader = setCookie
    .map((c) => /(?:^|;\s*)auth=([^;]*)/.exec(c)?.[1] ?? '')
    .find((v) => v !== '');
  if (fromHeader) return `auth=${fromHeader}`;
  const resp = json as Record<string, unknown>;
  const token = (resp['auth'] ?? resp['token'] ?? '') as string;
  if (!token) throw new Error(`DAU login failed: ${JSON.stringify(resp).slice(0, 200)}`);
  return `auth=${token}`;
}

/**
 * 抓取指定网站日（美西口径）的日活数据；不传则取「北京昨日」对应的美西前天（-2 天偏移）。
 */
export async function fetchDau(westernDateOverride?: string): Promise<DauItem[]> {
  const cookie = await login();
  // 北京昨日 = 美西前天（UTC+8 昨日 → 美西约 -8h，差 2 个自然日）
  const westernDate = westernDateOverride ?? ymdOffset(2);
  const { json } = await apiRequest(
    '/api/cached-data', 'POST',
    JSON.stringify({ start: westernDate, end: westernDate }),
    cookie,
  );
  const overview = json as Record<string, unknown>;
  const data = overview['data'] as Record<string, unknown> | undefined;
  const ios = (data?.['ios'] as Record<string, unknown> | undefined)?.['overview'] as Record<string, Record<string, unknown>> | undefined ?? {};
  const android = (data?.['android'] as Record<string, unknown> | undefined)?.['overview'] as Record<string, Record<string, unknown>> | undefined ?? {};

  const items: DauItem[] = [];
  for (const [key, mapped] of Object.entries(IOS_MAP)) {
    const dau = Number(((ios[key]?.['dau'] as Record<string, unknown> | undefined)?.['all'] as Record<string, unknown> | undefined)?.['value'] ?? 0);
    items.push({ product: mapped, dau: Number.isFinite(dau) ? dau : 0 });
  }
  for (const [key, mapped] of Object.entries(ANDROID_MAP)) {
    const dau = Number(((android[key]?.['dau'] as Record<string, unknown> | undefined)?.['all'] as Record<string, unknown> | undefined)?.['value'] ?? 0);
    items.push({ product: mapped, dau: Number.isFinite(dau) ? dau : 0 });
  }
  // Kira iOS 不在网站上
  items.push({ product: 'Kira iOS', dau: 0 });
  return items;
}

/**
 * 将日活数据 upsert 进 daily_snapshots(kind='dau')，date 默认为北京昨日。
 * 传 beijingDateOverride 可回补历史某天，日期口径与每日任务一致：
 * 存储日 = 查询的网站日 + 1（即 date=2026-08-01 落的是网站 2026-07-31 的日活）。
 */
export async function fetchDauDaily(beijingDateOverride?: string): Promise<{ date: string; products: number }> {
  const beijingYesterday = beijingDateOverride ?? ymdOffset(1);
  const items = await fetchDau(
    beijingDateOverride ? shiftYmd(beijingDateOverride, -1) : ymdOffset(2),
  );
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ('dau', $1, $2)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [beijingYesterday, JSON.stringify(items)],
  );
  console.log(`[DAU] Saved ${items.length.toString()} products for ${beijingYesterday}`);
  return { date: beijingYesterday, products: items.length };
}
