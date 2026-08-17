'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 轮询 /login/status：confirmed → 跳首页；rejected/expired/none → 停轮询并提示。
 * 无状态：真身在 pending cookie + PG 挑战，本组件只负责轮询与跳转。
 */
export function WaitingClient({ name }: { name: string }): ReactNode {
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch('/login/status', { cache: 'no-store' });
          const json = (await res.json()) as { status?: string };
          switch (json.status) {
            case 'confirmed': {
              clearInterval(timer);
              globalThis.location.href = '/';
              break;
            }
            case 'rejected': {
              clearInterval(timer);
              setMessage('❌ 已被拒绝');
              break;
            }
            case 'expired':
            case 'none': {
              clearInterval(timer);
              setMessage('⌛ 已超时或失效，请返回重试');
              break;
            }
            default: {
              // pending：继续等下一轮。
              break;
            }
          }
        } catch {
          // 单次轮询失败忽略，下个周期自然重试。
        }
      })();
    }, 1500);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="text-center">
      <h2 className="mb-3 text-lg font-semibold text-text">
        📲 已向 {name} 的飞书推送确认卡片
      </h2>
      <p className="text-text-dim">请在飞书中点击「✅ 确认登录」…</p>
      <p className="mt-4 min-h-6 text-sm text-text-dim">{message}</p>
      <a href="/login" className="mt-6 inline-block text-sm text-accent hover:underline">
        返回登录
      </a>
    </div>
  );
}
