/**
 * 全自动日报飞书写入 —— 每日北京 2 点 cron 触发。
 *
 * 通过 lark-cli --as bot 调用飞书 API（替代 FEISHU_APP_ID/FEISHU_APP_SECRET），
 * 因为本机只有 lark-cli（cli_a948fa581ff8dccd）可用，无需额外环境变量。
 *
 * 读昨日 personal/correction/dau/main 快照，按投手×产品×渠道写入对应飞书分表。
 * 分表名格式："{product} {channel}"，例如 "Romi iOS FB"。
 * 幂等：同一日期行已存在则跳过。
 */

import { execFileSync } from 'node:child_process';

import { queryOne } from '@agentic-ug/db';

/** lark-cli 二进制路径。 */
const LARK_CLI = `${process.env['HOME'] ?? '/home/admin'}/.npm-global/bin/lark-cli`;

/**
 * 调 lark-cli api --as bot，返回 data 字段。
 * @param method HTTP 方法
 * @param path API 路径
 * @param params URL 查询参数（可选）
 * @param body 请求体（可选）
 */
function larkApi(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Record<string, unknown> {
  const args: string[] = ['api', '--as', 'bot', '--format', 'json', method, path];
  if (params) {
    args.push('--params', JSON.stringify(params));
  }
  if (body !== undefined) {
    args.push('--data', JSON.stringify(body));
  }
  const result = execFileSync(LARK_CLI, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${process.env['HOME'] ?? ''}/.npm-global/bin:${process.env['PATH'] ?? ''}`,
    },
  });
  const parsed = JSON.parse(result) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: unknown;
  };
  if (parsed.ok !== true) {
    throw new Error(`lark-cli ${method} ${path} failed: ${JSON.stringify(parsed.error ?? parsed)}`);
  }
  return parsed.data ?? {};
}

/** 投手代码 → wiki 节点 token（全自动日报文件夹下各人的表格）。 */
const OPERATOR_WIKI: Record<string, string> = {
  syh: 'De69wfcRli0M8EkHKywcwq6inse',
  lh: 'MqjCwfbtpiOpZhke6SqcJ0fbnBl',
  zm1: 'FhtIwhlCqimvVSk0B2fcxEnjnxg',
  wcx: 'CV2NwMgZAiDJDikYfbQc1TbYnsc',
  zmf: 'OlfIwSlNEiSerxknbGvcJukKn0c',
  mcy: 'YZ4jwzB6iiBVFhkINesc3eCMnUq',
  wvv: 'TvfZwN51KivBMzkGU0ScGjJBnbg',
  ymt: 'TNcbwKokCivijHkX6xhcTymxnSh',
  zjc: 'NASfw7LicijrNBkBInacAqjbnHh',
  wty: 'L02owS4GZi9VOmk2h2JcpYFenGh',
};

const SHEET_HEADERS = [
  '日期',
  '渠道',
  '消耗',
  '男生人数',
  '单价',
  '原始收入',
  '修正收入',
  '修正扣费收入',
  '投放利润',
  '返点',
  'PWA成本',
  '运营净利润',
  '总ROAS',
];

function yesterdayBeijing(): string {
  return new Date(Date.now() + 8 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 通过 wiki 节点 token 获取对应电子表格的 spreadsheet_token。
 */
function getSpreadsheetToken(wikiToken: string): string {
  const data = larkApi('GET', '/open-apis/wiki/v2/spaces/get_node', { token: wikiToken });
  const node = data['node'] as Record<string, unknown> | undefined;
  const objToken = typeof node?.['obj_token'] === 'string' ? node['obj_token'] : null;
  if (!objToken) throw new Error(`No obj_token for wiki ${wikiToken}`);
  return objToken;
}

interface SheetInfo {
  sheetId: string;
  title: string;
  rowCount: number;
}

/**
 * 获取电子表格的所有分表信息。
 */
function listSheets(spreadsheetToken: string): SheetInfo[] {
  const data = larkApi('GET', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`);
  const sheets = (data['sheets'] ?? []) as Record<string, unknown>[];
  return sheets.map((s) => ({
    sheetId: typeof s['sheetId'] === 'string' ? s['sheetId'] : '',
    title: typeof s['title'] === 'string' ? s['title'] : '',
    rowCount: Number(
      (s['gridProperties'] as Record<string, unknown> | undefined)?.['rowCount'] ?? 0,
    ),
  }));
}

/**
 * 新增一个分表，返回 sheetId。
 */
function addSheet(spreadsheetToken: string, title: string): string {
  const data = larkApi(
    'POST',
    `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/sheets_batch_update`,
    undefined,
    { requests: [{ addSheet: { properties: { title } } }] },
  );
  const replies = (data['replies'] ?? []) as Record<string, unknown>[];
  const addSheetResult = replies[0]?.['addSheet'] as Record<string, unknown> | undefined;
  const props = addSheetResult?.['properties'] as Record<string, unknown> | undefined;
  const sheetId = typeof props?.['sheetId'] === 'string' ? props['sheetId'] : null;
  if (!sheetId) throw new Error(`No sheetId in addSheet response`);
  return sheetId;
}

/**
 * 写入单元格范围（纯值，公式以 = 开头）。
 */
function writeRange(
  spreadsheetToken: string,
  sheetId: string,
  range: string,
  values: unknown[][],
): void {
  larkApi('PUT', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`, undefined, {
    valueRange: { range: `${sheetId}!${range}`, values },
  });
}

/**
 * 读取某列值（A 列用于幂等判断）。
 */
function readColumn(spreadsheetToken: string, sheetId: string, range: string): unknown[][] {
  try {
    const data = larkApi(
      'GET',
      `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(`${sheetId}!${range}`)}`,
    );
    const vr = data['valueRange'] as Record<string, unknown> | undefined;
    return (vr?.['values'] ?? []) as unknown[][];
  } catch {
    return [];
  }
}

interface PersonalChannel {
  channel: string;
  count?: number;
  cost?: number;
  revenue?: number;
  deductedRevenue?: number;
}
interface PersonalProduct {
  product: string;
  channels?: PersonalChannel[];
}
interface PersonalOperator {
  operator: string;
  products?: PersonalProduct[];
}
interface PersonalSnapshot {
  operators: PersonalOperator[];
}
type CorrectionFactor = number | { fb: number; other: number };
type FactorMap = Record<string, CorrectionFactor>;
interface DauItem {
  product: string;
  dau: number;
}

function getChannelFactor(factors: FactorMap, product: string, channel: string): number {
  const f = factors[product];
  if (f === undefined) return 1;
  if (typeof f === 'number') return f;
  return channel === 'FB' ? f.fb : f.other;
}

export async function fetchFeishuDailyReport(date?: string): Promise<void> {
  const targetDate = date ?? yesterdayBeijing();
  console.log(`[FeishuReport] Writing daily report for ${targetDate}`);

  // ── 读数据 ──
  const personalRow = await queryOne<{ payload: PersonalSnapshot }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'personal' AND date = $1",
    [targetDate],
  );
  if (!personalRow) {
    console.warn(`[FeishuReport] No personal snapshot for ${targetDate}, skipping`);
    return;
  }
  const personal = personalRow.payload;

  const correctionRow = await queryOne<{ payload: FactorMap }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'correction' AND date = $1",
    [targetDate],
  );
  const factors: FactorMap = correctionRow?.payload ?? {};

  const dauRow = await queryOne<{ payload: DauItem[] }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'dau' AND date = $1",
    [targetDate],
  );
  const dauItems: DauItem[] = dauRow?.payload ?? [];
  const totalDau = dauItems.reduce((s, d) => s + d.dau, 0);
  const dauByProduct = new Map<string, number>(dauItems.map((d) => [d.product, d.dau]));

  // pwaWithdrawal：从 main snapshot 最后一条读取
  const mainRow = await queryOne<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'main' AND date = $1",
    [targetDate],
  );
  const snapshots = (mainRow ? mainRow.payload['snapshots'] : []) as Record<string, unknown>[];
  const lastSnap = snapshots.at(-1);
  const pwaWithdrawal =
    typeof lastSnap?.['pwaWithdrawal'] === 'number' ? lastSnap['pwaWithdrawal'] : 0;

  // PWA XMP 消耗
  const xmpCacheRow = await queryOne<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM xmp_cache WHERE cache_key = $1 AND expires_at > now()',
    [`xmp-campaigns-${targetDate}`],
  );
  const xmpData = (xmpCacheRow ? xmpCacheRow.payload['data'] : []) as Record<string, unknown>[];
  const pwaCostXmp = xmpData
    .filter((r) => r['product'] === 'PWA')
    .reduce((s, r) => s + (typeof r['cost'] === 'number' ? r['cost'] : 0), 0);
  const totalPwaCost = pwaCostXmp + pwaWithdrawal;

  // 按产品 DAU 分配 PWA 成本
  const pwaCostByProduct = new Map<string, number>();
  if (totalDau > 0 && totalPwaCost > 0) {
    for (const [product, dau] of dauByProduct) {
      pwaCostByProduct.set(product, totalPwaCost * (dau / totalDau));
    }
  }

  // 计算每个产品所有投手的修正收入之和
  const productTotalCorrectedRevenue = new Map<string, number>();
  for (const op of personal.operators) {
    for (const prod of op.products ?? []) {
      for (const ch of prod.channels ?? []) {
        if ((ch.cost ?? 0) <= 0) continue;
        const cf = getChannelFactor(factors, prod.product, ch.channel);
        const corrRev = (ch.revenue ?? 0) * cf;
        productTotalCorrectedRevenue.set(
          prod.product,
          (productTotalCorrectedRevenue.get(prod.product) ?? 0) + corrRev,
        );
      }
    }
  }

  // 缓存 spreadsheet token（每个 operator 只查一次）
  const spreadsheetTokenCache = new Map<string, string>();

  for (const op of personal.operators) {
    const wikiToken = OPERATOR_WIKI[op.operator];
    if (!wikiToken) continue;

    let spreadsheetToken = spreadsheetTokenCache.get(op.operator);
    if (!spreadsheetToken) {
      try {
        spreadsheetToken = getSpreadsheetToken(wikiToken);
        spreadsheetTokenCache.set(op.operator, spreadsheetToken);
      } catch (error) {
        console.error(
          `[FeishuReport] ${op.operator}: get spreadsheet token failed: ${(error as Error).message}`,
        );
        continue;
      }
    }

    let sheets = listSheets(spreadsheetToken);

    for (const prod of op.products ?? []) {
      for (const ch of prod.channels ?? []) {
        if ((ch.cost ?? 0) <= 0) continue;

        const sheetTitle = `${prod.product} ${ch.channel}`;
        let sheet = sheets.find((s) => s.title === sheetTitle);
        let sheetId: string;

        if (sheet) {
          sheetId = sheet.sheetId;
        } else {
          // 新建分表
          try {
            sheetId = addSheet(spreadsheetToken, sheetTitle);
            sheets = listSheets(spreadsheetToken);
            sheet = sheets.find((s) => s.sheetId === sheetId);
          } catch (error) {
            console.error(
              `[FeishuReport] ${op.operator} ${sheetTitle}: add sheet failed: ${(error as Error).message}`,
            );
            continue;
          }
          // 写表头
          try {
            writeRange(spreadsheetToken, sheetId, 'A1:M1', [SHEET_HEADERS]);
          } catch (error) {
            console.error(
              `[FeishuReport] ${op.operator} ${sheetTitle}: write header failed: ${(error as Error).message}`,
            );
          }
        }

        // 幂等：检查 A 列是否已有该日期
        try {
          const existing = readColumn(spreadsheetToken, sheetId, 'A2:A200');
          const alreadyExists = existing.some((row) => row[0] === targetDate);
          if (alreadyExists) {
            console.log(
              `[FeishuReport] ${op.operator} ${sheetTitle}: ${targetDate} already exists, skipping`,
            );
            continue;
          }
        } catch {
          // 读失败则继续写（幂等失效但不阻塞）
        }

        // 计算数值
        const cf = getChannelFactor(factors, prod.product, ch.channel);
        const cost = ch.cost ?? 0;
        const count = ch.count ?? 0;
        const rawRevenue = ch.revenue ?? 0;
        const corrRev = rawRevenue * cf;
        const corrDeducted = (ch.deductedRevenue ?? 0) * cf;

        // PWA 成本分配
        const productPwaCost = pwaCostByProduct.get(prod.product) ?? 0;
        const productTotalRev = productTotalCorrectedRevenue.get(prod.product) ?? 0;
        const pwaCostForRow =
          productTotalRev > 0 ? productPwaCost * (corrRev / productTotalRev) : 0;

        // 确定追加行号
        const currentSheet = sheets.find((s) => s.sheetId === sheetId);
        const nextRow = Math.max(2, (currentSheet?.rowCount ?? 1) + 1);
        const nextRowStr = nextRow.toString();
        const rowRef = `A${nextRowStr}:M${nextRowStr}`;

        const row: unknown[] = [
          targetDate, // A 日期
          ch.channel, // B 渠道
          cost, // C 消耗
          count, // D 男生人数
          `=IF(D${nextRowStr}>0,C${nextRowStr}/D${nextRowStr},0)`, // E 单价
          rawRevenue, // F 原始收入
          corrRev, // G 修正收入
          corrDeducted, // H 修正扣费收入
          `=H${nextRowStr}*0.99-C${nextRowStr}`, // I 投放利润
          `=IF(B${nextRowStr}="TT",C${nextRowStr}*0.025,0)`, // J 返点
          pwaCostForRow, // K PWA成本
          `=I${nextRowStr}+J${nextRowStr}-K${nextRowStr}`, // L 运营净利润
          `=IF(C${nextRowStr}>0,G${nextRowStr}/C${nextRowStr},0)`, // M 总ROAS
        ];

        try {
          writeRange(spreadsheetToken, sheetId, rowRef, [row]);
          console.log(`[FeishuReport] ${op.operator} ${sheetTitle}: wrote row for ${targetDate}`);
        } catch (error) {
          console.error(
            `[FeishuReport] ${op.operator} ${sheetTitle}: write row failed: ${(error as Error).message}`,
          );
        }
      }
    }
  }

  console.log(`[FeishuReport] Done for ${targetDate}`);
}
