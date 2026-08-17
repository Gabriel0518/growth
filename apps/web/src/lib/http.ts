import type { RawParams } from '@agentic-ug/core';

/** query string → 普通对象（重复键取最后一个，对齐 Python dict(query_params)）。 */
export function queryParams(request: Request): RawParams {
  return Object.fromEntries(new URL(request.url).searchParams);
}

function asParams(value: unknown): RawParams | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawParams)
    : null;
}

/**
 * 解析回调 POST 入参 —— 覆盖 AF/Adjust 各种投递形态，替代旧 readJsonOrQuery：
 *  1. 始终并入 URL query（AF 经典 postback 常把宏放 query string，即便走 POST）。
 *  2. JSON 对象 → 合并；JSON 数组（AF Push 批量投递）→ 逐条展开为多条记录。
 *  3. application/x-www-form-urlencoded / text（含 = 的键值）→ 解析表单键值合并。
 * 返回 ≥1 个参数对象。附 content-type/method/shape 打点：旧实现会把表单 body 静默丢弃
 * （request.json() 抛错 → 回退到空 query → 空记录），正是「配了回调却没数据」的典型成因。
 */
export async function readCallbackParams(request: Request): Promise<RawParams[]> {
  const base = queryParams(request);
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch {
    bodyText = '';
  }
  const trimmed = bodyText.trim();

  let records: RawParams[] = [base];
  let shape = 'query-only';

  if (trimmed) {
    const looksJson = ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
    let handled = false;

    if (looksJson) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const rows = parsed
            .map((e) => asParams(e))
            .filter((e): e is RawParams => e !== null)
            .map((e) => ({ ...base, ...e }));
          if (rows.length > 0) {
            records = rows;
            shape = `json-array[${rows.length.toString()}]`;
            handled = true;
          }
        } else {
          const obj = asParams(parsed);
          if (obj) {
            records = [{ ...base, ...obj }];
            shape = 'json-object';
            handled = true;
          }
        }
      } catch {
        // 非法 JSON：继续尝试按表单解析。
      }
    }

    if (!handled) {
      const form = Object.fromEntries(new URLSearchParams(trimmed));
      if (Object.keys(form).length > 0) {
        records = [{ ...base, ...form }];
        shape = 'form-urlencoded';
      }
    }
  }

  console.log(
    `[callback] parsed method=${request.method} ct=${ct || '(none)'} ` +
      `bodyLen=${bodyText.length.toString()} shape=${shape} records=${records.length.toString()}`,
  );
  return records;
}
