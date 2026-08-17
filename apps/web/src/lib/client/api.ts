/**
 * 前端 API 客户端 —— 复刻旧 app.js 的 fetch 语义：同源 /api/*，凭 session cookie 鉴权。
 * 旧 apiUrl(path) 直接返回 path（后端用 cookie 鉴权，不追加 key），此处保持一致。
 */

export function apiUrl(path: string): string {
  return path;
}

/** GET JSON；非 2xx 抛错。 */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(apiUrl(path), signal ? { signal } : {});
  if (!resp.ok) throw new Error(`GET ${path} → ${resp.status.toString()}`);
  return resp.json() as Promise<T>;
}

/** GET JSON；失败/超时返回 null（复刻旧的软失败分支，如 af-summary/channel-summary）。 */
export async function getJsonSoft<T>(
  path: string,
  timeoutMs?: number,
): Promise<T | null> {
  try {
    const opts: RequestInit = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs != null) {
      const controller = new AbortController();
      timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      opts.signal = controller.signal;
    }
    const resp = await fetch(apiUrl(path), opts);
    if (timer) clearTimeout(timer);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** POST JSON body；返回解析后的 JSON。 */
export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return resp.json() as Promise<T>;
}
