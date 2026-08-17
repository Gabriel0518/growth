'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { registerDashboardAccount, verifyDashboardCredentials } from '@/lib/dashboard/account-auth';
import { buildSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SEC } from '@/lib/dashboard/auth';

async function startSession(username: string, displayName: string): Promise<void> {
  const token = buildSessionToken({
    authenticated: true,
    panelAccess: false,
    name: displayName || username,
  });
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

function getFormString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** 校验普通账号密码，成功后种 session cookie 并跳首页。 */
export async function login(formData: FormData): Promise<void> {
  const username = getFormString(formData, 'username');
  const password = getFormString(formData, 'password');
  const account = await verifyDashboardCredentials(username, password);
  if (account === undefined) redirect('/login?error=login');

  await startSession(account.username, account.displayName);
  redirect('/');
}

/** 创建普通账号并立即登录。 */
export async function register(formData: FormData): Promise<void> {
  const username = getFormString(formData, 'username');
  const password = getFormString(formData, 'password');
  const confirmPassword = getFormString(formData, 'confirm_password');

  if (password !== confirmPassword) redirect('/login?mode=register&error=mismatch');

  const result = await registerDashboardAccount(username, password);
  if (!result.ok) redirect(`/login?mode=register&error=${result.reason}`);

  await startSession(result.account.username, result.account.displayName);
  redirect('/');
}
