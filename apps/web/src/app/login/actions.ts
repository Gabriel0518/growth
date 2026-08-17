'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { config } from '@/lib/config';
import {
  buildSessionToken,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SEC,
} from '@/lib/dashboard/auth';

/** 校验用户名/密码，成功则种 session cookie 并跳首页；失败跳回带 error。 */
export async function login(formData: FormData): Promise<void> {
  const username = formData.get('username');
  const password = formData.get('password');
  if (username === config.adminUser && password === config.adminPass) {
    const token = buildSessionToken({ authenticated: true, panelAccess: false });
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_SEC,
    });
    redirect('/');
  }
  redirect('/login?error=1');
}
