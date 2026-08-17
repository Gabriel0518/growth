/**
 * Facebook Graph API HTTP 客户端。
 * 封装 graph.facebook.com 直连，统一注入 access_token、错误码标准化、
 * 请求/响应详细日志（单行 | 分隔，避免 SLS 拆行）。
 */

import { Logger } from './logger.js';

const API_BASE = 'https://graph.facebook.com';

export class FacebookClient {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    version = 'v25.0',
  ) {
    this.baseUrl = `${API_BASE}/${version}`;
  }

  /** GET 请求，返回解析后的 JSON。 */
  async get<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('access_token', this.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return this.fetchJson<T>(url.toString(), { method: 'GET' });
  }

  /** POST 请求，body 为 JSON。 */
  async post<T = unknown>(path: string, data: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('access_token', this.token);
    return this.fetchJson<T>(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  /** POST 请求，body 为 FormData（适用于文件上传/adcreatives 等需 multipart 的场景）。 */
  async postMultipart<T = unknown>(path: string, formData: FormData): Promise<T> {
    // token 作为表单字段注入（FB 同时接受 access_token 在 URL 或 FormData 中）
    formData.set('access_token', this.token);
    return this.fetchJson<T>(`${this.baseUrl}/${path}`, {
      method: 'POST',
      body: formData,
    });
  }

  /** POST 请求，body 为 URLSearchParams（application/x-www-form-urlencoded）。 */
  async postForm<T = unknown>(path: string, data: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('access_token', this.token);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) {
      form.set(k, v);
    }
    return this.fetchJson<T>(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  }

  /** DELETE 请求。 */
  async delete<T = unknown>(path: string): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('access_token', this.token);
    return this.fetchJson<T>(url.toString(), { method: 'DELETE' });
  }

  /** 只组装请求 URL（不实际发出），方便上层自定义 HTTP。预留 API。 */
  buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.searchParams.set('access_token', this.token);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ── 核心：统一 fetch + 日志 ──

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const method = init.method ?? 'GET';
    const pathOnly = url.split('?')[0] ?? '/';

    // ── 请求详情摘要 ──
    const reqUrl = new URL(url);
    const reqParams: Record<string, string> = {};
    for (const [k, v] of reqUrl.searchParams) {
      reqParams[k] = k === 'access_token' ? '<TOKEN>' : v;
    }

    const reqBody = init.body;
    let bodyBrief = '';
    if (reqBody) {
      if (reqBody instanceof FormData) {
        const fields: string[] = [];
        for (const [k, v] of reqBody.entries()) {
          if (k === 'access_token') {
            fields.push('access_token=<TOKEN>');
          } else {
            const vs = typeof v === 'string' ? v : `[File: ${v.name}]`;
            fields.push(`${k}=${vs.length > 400 ? `${vs.slice(0, 400)}[TRUNCATED]` : vs}`);
          }
        }
        bodyBrief = fields.join(' | ');
      } else if (typeof reqBody === 'string') {
        bodyBrief = reqBody.length > 1000 ? `${reqBody.slice(0, 1000)}[TRUNCATED ${String(reqBody.length)}]` : reqBody;
      }
    }

    Logger.info(
      [
        `[FB] >>> REQUEST`,
        `method=${method}`,
        `url=${url}`,
        `path=${pathOnly}`,
        `params=${JSON.stringify(reqParams)}`,
        bodyBrief ? `payload=${bodyBrief}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    );

    // ── 发请求 ──
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 30_000);
    const res = await fetch(url, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timeout);
    });
    const durationMs = Date.now() - startedAt;
    const rawBody = await res.text();

    // ── 响应日志 ──
    const MAX_BODY = 4000;
    const compactBody = rawBody.replaceAll(/\s+/g, ' ');
    const bodyStr = compactBody.length > MAX_BODY
      ? `${compactBody.slice(0, MAX_BODY)} [truncated ${String(compactBody.length - MAX_BODY)}B]`
      : compactBody;

    if (!res.ok || rawBody.length === 0) {
      Logger.error(
        [
          `[FB] <<< RESPONSE`,
          `path=${pathOnly}`,
          `method=${method}`,
          `status=${String(res.status)} FAIL`,
          `durationMs=${String(durationMs)}`,
          `body=${bodyStr}`,
        ].join(' | '),
      );
      throw FacebookClient.parseError(res.status, rawBody, method, url);
    }

    const data: unknown = JSON.parse(rawBody);
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const err = (data as {
        error: {
          code: number;
          message: string;
          error_user_title?: string;
          error_user_msg?: string;
        };
      }).error;
      const detail = [
        `code=${String(err.code)}`,
        `msg="${err.message}"`,
        err.error_user_title ? `title="${err.error_user_title}"` : '',
        err.error_user_msg ? `user_msg="${err.error_user_msg}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      Logger.error(
        [
          `[FB] <<< RESPONSE`,
          `path=${pathOnly}`,
          `method=${method}`,
          `status=${String(res.status)} FAIL`,
          `durationMs=${String(durationMs)}`,
          detail,
          `body=${bodyStr}`,
        ].join(' | '),
      );
      throw new Error(`FB API 错误 [${detail}]`);
    }

    const summary = summarize(data);
    Logger.info(
      [
        `[FB] <<< RESPONSE`,
        `path=${pathOnly}`,
        `method=${method}`,
        `status=${String(res.status)} OK`,
        `durationMs=${String(durationMs)}`,
        summary,
        `body=${bodyStr}`,
      ]
        .filter(Boolean)
        .join(' | '),
    );
    return data as T;
  }

  /** 把 FB 错误码映射为可读中文描述。 */
  static parseError(_status: number, body: string, _method: string, _url: string): Error {
    let code = 'UNKNOWN';
    let message = body.slice(0, 300);
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
        const err = (parsed as {
          error: {
            code: number;
            message: string;
            error_user_title?: string;
            error_user_msg?: string;
          };
        }).error;
        code = String(err.code);
        message = [
          err.message,
          err.error_user_title ? `[${err.error_user_title}]` : '',
          err.error_user_msg ? `(${err.error_user_msg})` : '',
        ]
          .filter(Boolean)
          .join(' ');
      }
    } catch {
      // body 不是 JSON，用原始文本
    }

    const label = FACEBOOK_ERROR_LABELS[code] ?? `FB API 错误 [code=${code}]`;
    return new Error(`${label}: ${message}`);
  }
}

/** 将 FB 响应转为单行摘要——标条数或 id，不展开完整 JSON 字段。 */
function summarize(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const d = data as Record<string, unknown>;
  if (Array.isArray(d['data'])) return `results=${String(d['data'].length)}`;
  if (typeof d['id'] === 'string') return `id=${d['id']}`;
  if (typeof d['name'] === 'string') return `name=${d['name']}`;
  return '';
}

/** FB 常见错误码 → 中文标签。 */
const FACEBOOK_ERROR_LABELS: Record<string, string> = {
  '100': 'FB 参数无效',
  '190': 'FB Token 无效或过期',
  '194': 'FB 缺少必填参数',
  '200': 'FB 权限不足',
  '270': 'FB App 权限不足（需 App Review 上线）',
  '368': 'FB 操作被限制（滥用或违规）',
  '500': 'FB 内容违规',
  '613': 'FB API 调用频率超限',
  '2635': 'FB API 版本已废弃',
  '80004': 'FB 广告账户调用次数过多',
};
