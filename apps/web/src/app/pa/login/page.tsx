'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';

import { AreaChart } from '@/components/pa';
import { usePaStore } from '@/components/pa';
import { Button, StatusPill } from '@/components/ui';

/** 登录页左侧的势能示意图。数值是演示用的固定序列，不参与业务计算。 */
const MOMENTUM = [12, 18, 16, 27, 34, 41, 39, 52, 61, 68, 79];

function LoginForm(): ReactNode {
  const router = useRouter();
  const params = useSearchParams();
  const { state, dispatch } = usePaStore();
  const [email, setEmail] = useState('han.xu@acme.com');
  const [password, setPassword] = useState('prototype');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  // 登录后回到原本要去的地方。?next= 由 AppShell 在弹回时写入，
  // 这样分享出去的深链接不会在登录后丢失。
  const next = params.get('next') ?? '/pa';

  useEffect(() => {
    if (state.signedIn) router.replace(next);
  }, [state.signedIn, next, router]);

  // @types/react 已弃用 FormEvent，改用 SyntheticEvent（提交事件只用到 preventDefault）
  function submit(event: React.SyntheticEvent): void {
    event.preventDefault();
    const found: { email?: string; password?: string } = {};
    // 错误文案一律 "Couldn't …"，不用 "Failed to …"，也不暴露任何状态码。
    if (!email.trim()) found.email = "Couldn't sign in — enter your work email.";
    else if (!email.includes('@'))
      found.email = "Couldn't sign in — that doesn't look like an email address.";
    if (!password) found.password = "Couldn't sign in — enter your password.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    dispatch({ type: 'signIn', email: email.trim() });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
      {/* 左栏是品牌叙事，窄屏直接隐藏 —— 挤成两行反而两边都读不好 */}
      <section className="relative hidden flex-col gap-[14px] overflow-hidden bg-pa-bg-app px-[56px] py-[30px] lg:flex">
        <span className="absolute left-[47%] top-[-78px] h-[190px] w-[190px] rounded-full bg-pa-chart-4" />
        <span className="absolute left-[-58px] top-[-28px] h-[120px] w-[120px] rounded-full bg-pa-chart-1 opacity-90" />
        <span className="absolute bottom-[-66px] left-[-54px] h-[150px] w-[150px] rounded-full bg-pa-accent" />

        <div className="relative z-[2] flex items-center gap-[10px] text-pa-14 font-bold">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-pa-md bg-pa-accent text-pa-11 text-pa-on-accent">
            PA
          </span>
          Partnership ADS
        </div>
        <p className="relative z-[2] mt-[34px] font-pa-mono text-pa-10 uppercase tracking-[0.16em] text-pa-content-tertiary">
          Campaign intelligence / Live
        </p>
        <h1 className="relative z-[2] mt-pa-2 text-pa-34 font-bold tracking-[-0.02em]">
          Move across platforms.
          <br />
          Build influence at scale.
        </h1>
        <p className="relative z-[2] max-w-[380px] text-pa-13 text-pa-content-body">
          Intelligently orchestrate a rich KOL advertising network across every social channel.
        </p>

        <div className="relative z-[2] mt-[14px] max-w-[470px] rounded-pa-lg border border-pa-border bg-pa-surface p-pa-5 shadow-pa-1">
          <div className="flex items-center justify-between">
            <span className="text-pa-11 font-semibold">Campaign momentum</span>
            <StatusPill tone="positive">growth signal</StatusPill>
          </div>
          <div className="pa-num mt-pa-3 text-[30px] font-bold leading-[38px]">+42.8%</div>
          <p className="pa-num mt-px text-pa-11 text-pa-positive">
            ▲ signal rising across every active channel
          </p>
          <div className="mt-[14px]">
            <AreaChart points={MOMENTUM} label="Campaign momentum" height={150} />
          </div>
          <div className="mt-pa-2 flex justify-between font-pa-mono text-pa-9 text-pa-content-placeholder">
            {['launch', 'learn', 'scale', 'lift', 'next'].map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="grid place-items-center border-l border-pa-border bg-pa-surface px-pa-8 py-[40px]">
        <div className="grid w-full max-w-[380px] gap-pa-4">
          <div className="flex items-center gap-[10px] text-pa-14 font-bold lg:hidden">
            <span className="grid h-[30px] w-[30px] place-items-center rounded-pa-md bg-pa-accent text-pa-11 text-pa-on-accent">
              PA
            </span>
            Partnership ADS
          </div>
          <h2 className="mt-[26px] text-pa-25 font-bold tracking-[-0.01em]">Welcome back</h2>
          <p className="text-pa-11 text-pa-content-tertiary">
            Sign in to pick up where your campaigns left off.
          </p>

          <form onSubmit={submit} noValidate className="mt-[6px] grid gap-pa-4">
            <div className="grid gap-[6px]">
              <label
                htmlFor="pa-email"
                className="text-pa-12 font-semibold text-pa-content-secondary"
              >
                Work email
              </label>
              <input
                id="pa-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                aria-invalid={errors.email === undefined ? undefined : true}
                className={`h-[var(--pa-hit-target)] w-full rounded-pa-md border bg-pa-surface px-[14px] text-pa-13 outline-none focus:border-pa-ring focus:shadow-[0_0_0_3px_rgba(8,145,178,0.16)] ${
                  errors.email === undefined ? 'border-pa-border' : 'border-pa-negative'
                }`}
              />
              {errors.email === undefined ? null : (
                <p className="text-pa-11 text-pa-negative">{errors.email}</p>
              )}
            </div>

            <div className="grid gap-[6px]">
              <label
                htmlFor="pa-password"
                className="text-pa-12 font-semibold text-pa-content-secondary"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="pa-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                  aria-invalid={errors.password === undefined ? undefined : true}
                  className={`h-[var(--pa-hit-target)] w-full rounded-pa-md border bg-pa-surface pl-[14px] pr-[64px] text-pa-13 outline-none focus:border-pa-ring focus:shadow-[0_0_0_3px_rgba(8,145,178,0.16)] ${
                    errors.password === undefined ? 'border-pa-border' : 'border-pa-negative'
                  }`}
                />
                <div className="absolute right-[6px] top-1/2 -translate-y-1/2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowPassword((v) => !v);
                    }}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </Button>
                </div>
              </div>
              {errors.password === undefined ? null : (
                <p className="text-pa-11 text-pa-negative">{errors.password}</p>
              )}
            </div>

            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>

          <p className="text-center text-pa-11 text-pa-content-tertiary">
            Accounts are provisioned by your workspace admin.
          </p>
        </div>
      </section>
    </div>
  );
}

export default function LoginPage(): ReactNode {
  // useSearchParams 需要 Suspense 边界，否则整页会被强制变成动态渲染。
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
