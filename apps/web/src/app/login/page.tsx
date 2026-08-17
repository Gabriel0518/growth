import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { login } from './actions';

import { config } from '@/lib/config';
import { readSession } from '@/lib/dashboard/auth';
import { listUsers } from '@/lib/feishu/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 登录页（方案 C）：
 * - 首次登录：跳飞书 OAuth 授权（/auth/start）。
 * - 二次登录：从已授权名录选人，POST /login/pick 推卡片确认。
 * - 兜底：仅 LEGACY_ADMIN_LOGIN=1 时渲染账密表单（应急）。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const hdrs = await headers();
  const cookie = hdrs.get('cookie');
  const request = new Request('http://internal/login', {
    headers: cookie ? { cookie } : {},
  });
  if (readSession(request).authenticated) redirect('/');

  const params = await searchParams;
  const errorKind = params['error'];
  const errorMessage =
    errorKind === 'oauth'
      ? '飞书授权失败，请重试'
      : errorKind === undefined
        ? ''
        : '用户名或密码错误';

  const users = await listUsers();

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-dark">
      <div className="w-[380px] rounded-xl border border-white/10 bg-[#12122a] p-9 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <h1 className="mb-6 text-center text-xl font-bold text-[#8888cc]">📊 Sitin 仪表板</h1>
        {errorMessage ? (
          <div className="mb-3 text-center text-sm text-red">{errorMessage}</div>
        ) : null}

        <a
          href="/auth/start"
          className="block w-full rounded-md bg-accent py-2.5 text-center font-semibold text-bg-dark transition-opacity hover:opacity-85"
        >
          🆕 首次登录（飞书授权）
        </a>

        <div className="my-5 flex items-center gap-3 text-xs text-text-dim">
          <span className="h-px flex-1 bg-white/10" />
          或 已授权用户
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <form action="/login/pick" method="post">
          <select
            name="open_id"
            required
            defaultValue=""
            disabled={users.length === 0}
            className="mb-3 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
          >
            <option value="" disabled>
              {users.length === 0 ? '（暂无已授权用户）' : '选择你的名字…'}
            </option>
            {users.map((u) => (
              <option key={u.openId} value={u.openId}>
                {u.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={users.length === 0}
            className="w-full rounded-md border border-white/10 bg-[#1a1a3a] py-2.5 text-text transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            👤 我是本人，推送确认
          </button>
        </form>

        {config.legacyAdminLogin ? (
          <form action={login} className="mt-6 border-t border-white/10 pt-5">
            <label htmlFor="username" className="mb-1.5 block text-sm text-text-dim">
              用户名（应急登录）
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
              className="mb-3 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <label htmlFor="password" className="mb-1.5 block text-sm text-text-dim">
              密码
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mb-3 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="w-full rounded-md border border-white/10 bg-[#1a1a3a] py-2.5 text-text transition-opacity hover:opacity-85"
            >
              登录
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
