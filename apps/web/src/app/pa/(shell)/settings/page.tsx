'use client';

import type { ReactNode } from 'react';

import { Card, CardHead, Eyebrow, PageHeader, useToast, usePaStore } from '@/components/pa';
import { Avatar, Button, DataTrust } from '@/components/ui';

/**
 * 指标口径说明。
 * 「一个数字只有一个口径」是本设计系统的第二条原则 —— 把定义写在产品里，
 * 而不是留在某份文档里让人各自理解（DESIGN-SPEC §1.2）。
 */
const DEFINITIONS: [string, string][] = [
  ['Spend', 'Billed cost on the connected ad account. Excludes agency fees and taxes.'],
  ['Impressions', 'Times an ad was rendered. One person seeing three posts counts as three.'],
  ['Reach', 'Unique people. Always lower than impressions.'],
  ['Installs', 'Attributed by the MMP callback, deduplicated per device.'],
  ['CPI', 'Spend ÷ installs. The total row is blended, never an average of rows.'],
  ['ROAS', 'Attributed revenue ÷ spend. The total row is blended, never an average of rows.'],
];

export default function SettingsPage(): ReactNode {
  const { state } = usePaStore();
  const toast = useToast();

  return (
    <>
      <Eyebrow>Manage / Workspace</Eyebrow>
      <PageHeader title="Settings" lede="Profile, connected ad accounts and metric definitions." />

      <div className="grid gap-pa-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHead title="Profile" />
          <div className="flex flex-wrap items-center gap-pa-4 p-pa-4">
            <Avatar name={state.user.name} size="l" />
            <div className="min-w-0 flex-1">
              <b className="text-pa-15">{state.user.name}</b>
              <div className="text-pa-12 text-pa-content-tertiary">{state.user.role}</div>
              <div className="pa-num text-pa-12 text-pa-content-body">{state.user.email}</div>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                toast('Profile editing is not wired up yet');
              }}
            >
              Edit profile
            </Button>
          </div>
        </Card>

        <Card>
          <CardHead
            title="Connected ad accounts"
            sub="Delivery is billed to the account on the campaign"
          />
          <div className="p-pa-4">
            {state.adAccounts.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <b className="block truncate text-pa-13">
                    {a.platform} · {a.owner}
                  </b>
                  <span className="pa-num block truncate text-pa-11 text-pa-content-tertiary">
                    {a.id} · connected {a.connected}
                  </span>
                </div>
                <DataTrust state={a.state === 'ok' ? 'fresh' : 'stale'}>
                  {a.state === 'ok' ? 'connected' : 'token expiring'}
                </DataTrust>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-pa-3">
        <CardHead
          title="Metric definitions"
          sub="One number, one definition — used everywhere in this workspace"
        />
        <div className="p-pa-4">
          <dl>
            {DEFINITIONS.map(([term, body]) => (
              <div
                key={term}
                className="grid gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0 md:grid-cols-[160px_1fr]"
              >
                <dt className="font-pa-mono text-pa-11 uppercase tracking-[0.1em] text-pa-content-tertiary">
                  {term}
                </dt>
                <dd className="text-pa-12 text-pa-content-body">{body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Card>
    </>
  );
}
