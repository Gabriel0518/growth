/**
 * 投放模块结构化日志 —— 基于 AsyncLocalStorage 的 trace ID 注入。
 *
 * 解决的问题：
 *   1. SLS 中日志被拆成多条 context（多行 JSON → logtail 按换行拆分）
 *   2. 同一链路上的日志无法串联（没有统一的 trace ID）
 *   3. console.log 格式不统一，排查困难
 *
 * 输出格式（单行，无换行）：
 *   [2026-07-29T10:00:00.123Z] INFO traceId=req_abc123 msg="开始同步" campaigns=13
 *
 * 使用方式：
 *   1. Route Handler 入口用 withTraceGuard 包装 withGuard 回调
 *   2. 业务代码中用 logger.info/warn/error 替代 console.log
 *   3. traceId 自动贯穿整个 AsyncLocalStorage 上下文
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

// ── 类型 ──

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

interface TraceStore {
  traceId: string;
}

// ── AsyncLocalStorage ──

const traceStorage = new AsyncLocalStorage<TraceStore>();

/** 获取当前请求的 trace ID（不存在返回空字符串）。 */
function getTraceId(): string {
  return traceStorage.getStore()?.traceId ?? '';
}

/** 生成 trace ID：req_ 前缀 + 8 字节 base64url 随机 */
function generateTraceId(): string {
  return `req_${crypto.randomBytes(8).toString('base64url')}`;
}

// ── 核心函数 ──

/**
 * 在 AsyncLocalStorage 上下文中执行回调，自动注入 traceId。
 * 用法：包装 Route Handler 的 withGuard 回调。
 *
 *   return withGuard(request, auth, () =>
 *     withTrace(async () => {
 *       logger.info('开始处理');
 *       const result = await ...
 *     })
 *   );
 */
export async function withTrace<T>(fn: () => Promise<T>): Promise<T> {
  const traceId = generateTraceId();
  return traceStorage.run({ traceId }, fn);
}

// ── 格式化输出 ──

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(extra)) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    // 去掉换行和多余空格，确保单行
    const safe = serialized.replaceAll(/\s+/g, ' ');
    parts.push(`${key}=${safe}`);
  }
  return ` ${parts.join(' ')}`;
}

function writeLog(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  const traceId = getTraceId();
  const timestamp = new Date().toISOString();
  const tracePart = traceId ? ` traceId=${traceId}` : '';
  const extraPart = formatExtra(extra);
  // 用双引号包裹 message 防止空格被日志工具拆散
  const line = `[${timestamp}] ${level}${tracePart} msg="${message}"${extraPart}`;

  // 统一走 stdout；ERROR 额外加 ERROR 前缀便于 grep
  console.log(line);
}

// ── 对外 API ──

export const logger = {
  info(message: string, detail?: unknown): void {
    writeLog('INFO', message, normalizeDetail(detail));
  },
  warn(message: string, detail?: unknown): void {
    writeLog('WARN', message, normalizeDetail(detail));
  },
  error(message: string, detail?: unknown): void {
    writeLog('ERROR', message, normalizeDetail(detail));
  },
  /** 记录异常（自动提取 error.message 和 stack 首行） */
  exception(error_: unknown, context?: string): void {
    const msg = error_ instanceof Error ? error_.message : String(error_);
    const stack = error_ instanceof Error ? error_.stack?.split('\n')[1]?.trim() : undefined;
    writeLog('ERROR', context ? `${context}: ${msg}` : msg, stack ? { stack: stack.slice(0, 200) } : undefined);
  },
};

/** 将 logger.info(msg, anything) 的后缀转为 key=value 对象。 */
function normalizeDetail(detail: unknown): Record<string, unknown> | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'object') return detail as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return { detail: String(detail) };
}
