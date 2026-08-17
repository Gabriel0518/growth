import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { login, register } from './actions';

import { readSession } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getStringParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 主站账号登录/注册页：不依赖飞书，账号数据由 PostgreSQL 保存。 */
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
  const mode = getStringParam(params['mode']) === 'register' ? 'register' : 'login';
  const error = getStringParam(params['error']);
  const errorMessage =
    error === 'login'
      ? '用户名或密码错误'
      : error === 'invalid_username'
        ? '用户名需为 3-64 位小写字母、数字或 . _ @ -'
        : error === 'invalid_password'
          ? '密码长度需为 8-128 位'
          : error === 'username_exists'
            ? '用户名已存在，请直接登录'
            : error === 'mismatch'
              ? '两次输入的密码不一致'
              : '';

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-dark px-4">
      <div className="w-full max-w-[380px] rounded-xl border border-white/10 bg-[#12122a] p-9 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <h1 className="mb-2 text-center text-xl font-bold text-[#8888cc]">📊 Sitin 仪表板</h1>
        <p className="mb-6 text-center text-sm text-text-dim">
          {mode === 'register' ? '创建你的数据平台账号' : '使用账号密码登录'}
        </p>
        {errorMessage ? (
          <div className="mb-4 text-center text-sm text-red">{errorMessage}</div>
        ) : null}

        {mode === 'register' ? (
          <form action={register}>
            <label htmlFor="register-username" className="mb-1.5 block text-sm text-text-dim">
              用户名
            </label>
            <input
              id="register-username"
              name="username"
              type="text"
              autoComplete="username"
              minLength={3}
              maxLength={64}
              required
              className="mb-3 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <label htmlFor="register-password" className="mb-1.5 block text-sm text-text-dim">
              密码
            </label>
            <input
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              className="mb-3 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <label
              htmlFor="register-confirm-password"
              className="mb-1.5 block text-sm text-text-dim"
            >
              确认密码
            </label>
            <input
              id="register-confirm-password"
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              className="mb-5 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="w-full rounded-md bg-accent py-2.5 font-semibold text-bg-dark transition-opacity hover:opacity-85"
            >
              注册并登录
            </button>
          </form>
        ) : (
          <form action={login}>
            <label htmlFor="login-username" className="mb-1.5 block text-sm text-text-dim">
              用户名
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              required
              className="mb-3 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <label htmlFor="login-password" className="mb-1.5 block text-sm text-text-dim">
              密码
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mb-5 w-full rounded-md border border-white/10 bg-bg-dark px-3 py-2.5 text-text outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="w-full rounded-md bg-accent py-2.5 font-semibold text-bg-dark transition-opacity hover:opacity-85"
            >
              登录
            </button>
          </form>
        )}

        <div className="mt-6 border-t border-white/10 pt-5 text-center text-sm text-text-dim">
          {mode === 'register' ? (
            <a href="/login" className="text-accent hover:underline">
              已有账号？返回登录
            </a>
          ) : (
            <a href="/login?mode=register" className="text-accent hover:underline">
              还没有账号？立即注册
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
