/**
 * Fetcher 层轻量结构化日志 —— 与 apps/web 的 logger 格式一致（单行 key=value）。
 * packages/ 不能依赖 apps/，故在此独立维护一份同格式的 logger。
 */

function formatLine(level: string, message: string, extra?: string): string {
  const ts = new Date().toISOString();
  // 用双引号包裹 message，与 apps/web 端 logger 格式一致
  const line = `[${ts}] ${level} msg="${message}"${extra ? ` ${extra}` : ''}`;
  return line;
}

export const Logger = {
  info(message: string): void {
    console.log(formatLine('INFO', message));
  },
  warn(message: string): void {
    console.warn(formatLine('WARN', message));
  },
  error(message: string): void {
    console.error(formatLine('ERROR', message));
  },
};
