'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { Breadcrumbs, type Crumb } from './breadcrumbs';
import { DeltaList, Dialog } from './dialog';
import { LogRow } from './log-row';
import { NAV_GROUPS, navKeyFor } from './nav';
import { usePaStore } from './store';
import { useToast } from './toast';

import { Avatar, BrandLockup, Button, SearchField, Sidebar } from '@/components/ui';
import { activeCampaigns } from '@/lib/pa/derive';

/** 页面把自己的面包屑传上来。默认只有根节点。 */
const CRUMB_ROOT: Crumb = { label: 'Sitin.ai', href: '/pa' };

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const router = useRouter();
  const { state, dispatch } = usePaStore();
  const toast = useToast();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [query, setQuery] = useState('');

  /**
   * 未登录访问受保护路由 → 弹到登录页，并把原目的地记在 ?next= 上，
   * 登录后继续走完。分享出去的深链接因此不会在登录后丢失。
   * 这是路由层的行为，与真实鉴权无关 —— 后者下一轮接。
   */
  useEffect(() => {
    // ⚠️ 必须等 hydrated —— 否则会在会话恢复落地之前就弹走，表现为「刷新即登出」。
    if (state.hydrated && !state.signedIn) {
      router.replace(`/pa/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [state.hydrated, state.signedIn, pathname, router]);

  if (!state.signedIn) return null;

  const active = activeCampaigns(state.campaigns).length;

  function runSearch(): void {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const campaign = state.campaigns.find((c) =>
      `${c.name} ${c.market} ${c.id}`.toLowerCase().includes(q),
    );
    if (campaign) {
      setQuery('');
      router.push(`/pa/campaigns/${campaign.id}`);
      return;
    }
    const creator = state.creators.find((c) => `${c.name} ${c.handle}`.toLowerCase().includes(q));
    if (creator) {
      setQuery('');
      router.push(`/pa/kols/${creator.id}`);
      return;
    }
    toast(`Nothing matches “${query.trim()}”`);
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        active={navKeyFor(pathname)}
        items={NAV_GROUPS.flatMap((g) =>
          g.items.map((item) => ({
            key: item.key,
            label: item.label,
            href: item.href,
            icon: item.icon,
            ...(item.counted ? { badge: active } : {}),
          })),
        )}
        brand={
          <Link href="/pa" className="flex items-center gap-[10px]">
            <BrandLockup compact />
          </Link>
        }
        footer={
          <>
            <div className="rounded-pa-md border border-pa-border p-pa-3">
              <div className="flex items-center justify-between text-pa-11">
                <span>Monthly spend</span>
                <b className="pa-num">{state.monthlySpendPct}%</b>
              </div>
              <div className="mt-[10px] h-[5px] overflow-hidden rounded-pa-full bg-pa-surface-muted">
                <i
                  className="block h-full rounded-pa-full bg-pa-accent"
                  style={{ width: `${String(state.monthlySpendPct)}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSignOutOpen(true);
              }}
              title="Sign out"
              className="flex items-center gap-pa-3 rounded-pa-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
            >
              <Avatar name={state.user.name} size="s" />
              <span>
                <b className="block text-pa-12">{state.user.name}</b>
                <span className="block text-pa-11 text-pa-content-tertiary">{state.user.role}</span>
              </span>
            </button>
          </>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[64px] shrink-0 items-center gap-pa-4 border-b border-pa-border bg-pa-surface px-pa-6">
          <Breadcrumbs items={[CRUMB_ROOT]} />
          <div className="ml-auto flex items-center gap-pa-3">
            <div className="hidden w-[224px] sm:block">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  runSearch();
                }}
              >
                <SearchField
                  value={query}
                  onChange={setQuery}
                  placeholder="Search campaigns or KOLs"
                />
              </form>
            </div>
            <button
              type="button"
              onClick={() => {
                setActivityOpen(true);
              }}
              aria-label="Recent activity"
              className="grid h-[36px] w-[36px] place-items-center rounded-pa-md border border-pa-border bg-pa-surface hover:bg-pa-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
            >
              <svg
                viewBox="0 0 15 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="h-[15px] w-[15px]"
                aria-hidden="true"
              >
                <path
                  d="M3.4 6.2a4.1 4.1 0 018.2 0c0 3 .9 4.3 1.4 4.8H2c.5-.5 1.4-1.8 1.4-4.8z"
                  strokeLinejoin="round"
                />
                <path d="M6 12.6a1.7 1.7 0 003 0" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {/* 内容区流式拉宽、封顶 1440 —— 再宽下去表格一行会长到眼睛难以从行首追到行尾 */}
        <main className="px-pa-6 pb-[56px] pt-[28px]">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </main>
      </div>

      {signOutOpen && (
        <Dialog
          title="Sign out of Partnership ADS?"
          onClose={() => {
            setSignOutOpen(false);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setSignOutOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setSignOutOpen(false);
                  dispatch({ type: 'signOut' });
                }}
              >
                Sign out
              </Button>
            </>
          }
        >
          <DeltaList rows={[{ label: 'Session', from: state.user.email, to: 'Signed out' }]} />
          <p className="text-pa-12 text-pa-content-body">
            Nothing in this workspace is persisted yet, so signing back in restores the same data.
          </p>
        </Dialog>
      )}

      {activityOpen && (
        <Dialog
          title="Recent activity"
          lede="Automation events across every campaign in this workspace."
          onClose={() => {
            setActivityOpen(false);
          }}
          footer={
            <Button
              variant="secondary"
              onClick={() => {
                setActivityOpen(false);
              }}
            >
              Close
            </Button>
          }
        >
          <div>
            {state.automationLog.slice(0, 6).map((entry) => (
              <LogRow key={`${entry.t}-${entry.title}`} entry={entry} />
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
