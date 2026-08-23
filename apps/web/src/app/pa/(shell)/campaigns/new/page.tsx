'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { Card, Dialog, Eyebrow, PageHeader, Stepper, useToast, usePaStore } from '@/components/pa';
import { Avatar, Button, buttonClasses, DataTrust, Dropdown } from '@/components/ui';
import type { Draft } from '@/lib/pa/types';

/** 新草稿的默认值。与 Figma `03.1 · Create campaign — Ad setup` 一致。 */
function blankDraft(): Draft {
  return {
    accountId: 'act_8821345607',
    plan: 'US · Summer partnership / installs',
    name: '',
    market: 'United States',
    productId: 'yahtzee',
    schedule: '2026-09-01 → 2026-09-30',
    currency: 'USD',
    cap: 120_000,
    mode: 'installs',
    targetRoas: 4,
    kolTarget: 40,
    channels: ['ig', 'tt'],
    days: 30,
  };
}

function Field({
  label,
  htmlFor,
  hint,
  hintTone,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  hintTone?: 'warning' | undefined;
  error?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="grid gap-[6px]">
      <label htmlFor={htmlFor} className="text-pa-12 font-semibold text-pa-content-secondary">
        {label}
      </label>
      {children}
      {error === undefined ? null : <p className="text-pa-11 text-pa-negative">{error}</p>}
      {hint === undefined || error !== undefined ? null : (
        <p
          className={`text-pa-11 ${hintTone === 'warning' ? 'text-pa-warning' : 'text-pa-content-tertiary'}`}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

const INPUT =
  'h-[var(--pa-hit-target)] w-full rounded-pa-md border border-pa-border bg-pa-surface px-[14px] text-pa-13 outline-none focus:border-pa-ring focus:shadow-[0_0_0_3px_rgba(8,145,178,0.16)]';
const INPUT_RO = `${INPUT} bg-pa-surface-muted text-pa-content-body`;

export default function AdSetupPage(): ReactNode {
  const { state, dispatch } = usePaStore();
  const router = useRouter();
  const toast = useToast();
  const [draft, setLocal] = useState<Draft>(() => state.draft ?? blankDraft());
  const [nameError, setNameError] = useState<string | undefined>();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 草稿存回 store，跨步骤（step1 → step2 → 审核）不丢。
  useEffect(() => {
    dispatch({ type: 'setDraft', draft });
  }, [draft, dispatch]);

  const product = state.products.find((p) => p.id === draft.productId);
  const account = state.adAccounts.find((a) => a.id === draft.accountId);

  function next(): void {
    if (!draft.name.trim()) {
      setNameError("Couldn't continue — give the campaign a name.");
      return;
    }
    setNameError(undefined);
    router.push('/pa/campaigns/new/goal');
  }

  return (
    <>
      <Eyebrow>New campaign / Ad setup</Eyebrow>
      <PageHeader
        title="New campaign"
        lede="Step 1 of 2 — connect an ad account and build the ad plan."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              toast('Draft saved — it stays in this session only', 'ok');
            }}
          >
            Save draft
          </Button>
        }
      />

      <Stepper steps={['Ad setup', 'Conversion goal']} active={1} />

      {/* 授权是门槛不是步骤：没有连上广告账号，整页就该不可用（CREATE-CAMPAIGN.md） */}
      <Card padded className="mb-pa-4 flex flex-wrap items-center justify-between gap-pa-3">
        <div className="flex items-center gap-pa-3">
          <Avatar name={account?.platform ?? 'Meta'} size="m" className="rounded-pa-md" />
          <div>
            <b className="text-pa-13">
              {account?.platform} · {account?.owner}
            </b>
            <div className="pa-num text-pa-11 text-pa-content-tertiary">
              {account?.id} · connected {account?.connected}
            </div>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setAccountsOpen(true);
          }}
        >
          Manage accounts
        </Button>
      </Card>

      <Card padded className="mb-pa-4">
        <Eyebrow className="mb-pa-1">① Ad plan</Eyebrow>
        <p className="mb-pa-3 text-pa-11 text-pa-content-tertiary">
          Pick a plan from the connected account, or create one here.
        </p>

        <div className="grid gap-pa-4 md:grid-cols-2">
          <Field label="Campaign name" htmlFor="pa-cname" error={nameError}>
            <input
              id="pa-cname"
              className={nameError === undefined ? INPUT : `${INPUT} border-pa-negative`}
              value={draft.name}
              placeholder="Summer partnership"
              onChange={(event) => {
                setLocal({ ...draft, name: event.target.value });
              }}
            />
          </Field>
          <Field
            label="Objective"
            htmlFor="pa-cobj"
            hint="Derived from the product. Change it on step 2."
          >
            <input id="pa-cobj" className={INPUT_RO} value={product?.objective ?? ''} readOnly />
          </Field>

          <Field
            label="Product"
            htmlFor="pa-cprod"
            hint="Drives the KOL estimate"
            hintTone="warning"
          >
            <Dropdown
              aria-label="Product"
              value={draft.productId}
              onChange={(v) => {
                setLocal({ ...draft, productId: v });
              }}
              options={state.products.map((p) => ({
                value: p.id,
                label: `${p.name} · ${p.category}`,
              }))}
            />
          </Field>
          <Field label="Market" htmlFor="pa-cmarket">
            <Dropdown
              aria-label="Market"
              value={draft.market}
              onChange={(v) => {
                setLocal({ ...draft, market: v });
              }}
              options={['United States', 'APAC', 'EU', 'NA', 'JP', 'SEA'].map((m) => ({
                value: m,
                label: m,
              }))}
            />
          </Field>

          <Field label="Schedule" htmlFor="pa-csched">
            <input
              id="pa-csched"
              className={INPUT}
              value={draft.schedule}
              onChange={(event) => {
                setLocal({ ...draft, schedule: event.target.value });
              }}
            />
          </Field>
          <Field label="Landing / App" htmlFor="pa-cland">
            <input
              id="pa-cland"
              className={INPUT_RO}
              value={product ? `${product.name} — ${product.platforms}` : ''}
              readOnly
            />
          </Field>

          <Field label="Currency" htmlFor="pa-ccur">
            <Dropdown
              aria-label="Currency"
              value={draft.currency}
              onChange={(v) => {
                setLocal({ ...draft, currency: v });
              }}
              options={[
                { value: 'USD', label: 'USD' },
                { value: 'EUR', label: 'EUR' },
                { value: 'JPY', label: 'JPY' },
              ]}
            />
          </Field>
          <Field label="Ad account" htmlFor="pa-cacct">
            <input
              id="pa-cacct"
              className={`${INPUT_RO} pa-num`}
              value={draft.accountId}
              readOnly
            />
          </Field>
        </div>

        <p className="mt-[14px] text-pa-11 text-pa-content-tertiary">
          Auto-filled from the selected plan. Edit any field to override.
        </p>

        <div className="mt-[14px] flex flex-wrap items-center gap-pa-3 rounded-pa-md bg-pa-surface-muted p-pa-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAdvancedOpen(true);
            }}
          >
            ▸ Advanced
          </Button>
          <span className="text-pa-11 text-pa-content-tertiary">
            Pixel ID, app events, UTM parameters, exclusion lists
          </span>
        </div>

        <div className="mt-pa-5 flex flex-wrap items-center justify-between gap-pa-3">
          <Link href="/pa/campaigns" className={buttonClasses('secondary')}>
            Cancel
          </Link>
          <Button onClick={next}>Continue to goal</Button>
        </div>
      </Card>

      {accountsOpen && (
        <Dialog
          title="Connected ad accounts"
          lede="Campaign delivery is billed to the account you pick on step 1."
          onClose={() => {
            setAccountsOpen(false);
          }}
          footer={
            <Button
              variant="secondary"
              onClick={() => {
                setAccountsOpen(false);
              }}
            >
              Close
            </Button>
          }
        >
          <div>
            {state.adAccounts.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between border-b border-pa-border-subtle py-pa-3 last:border-b-0"
              >
                <div>
                  <b className="text-pa-13">
                    {a.platform} · {a.owner}
                  </b>
                  <div className="pa-num text-pa-11 text-pa-content-tertiary">
                    {a.id} · connected {a.connected}
                  </div>
                </div>
                <DataTrust state={a.state === 'ok' ? 'fresh' : 'stale'}>
                  {a.state === 'ok' ? 'connected' : 'token expiring'}
                </DataTrust>
              </div>
            ))}
          </div>
        </Dialog>
      )}

      {advancedOpen && (
        <Dialog
          title="Advanced ad settings"
          lede="These carry over from the connected ad account unless overridden."
          onClose={() => {
            setAdvancedOpen(false);
          }}
          footer={
            <Button
              variant="secondary"
              onClick={() => {
                setAdvancedOpen(false);
              }}
            >
              Keep settings
            </Button>
          }
        >
          <Field label="Pixel ID" htmlFor="pa-pixel">
            <input id="pa-pixel" className={`${INPUT} pa-num`} defaultValue="px_44192083" />
          </Field>
          <Field label="UTM template" htmlFor="pa-utm">
            <input
              id="pa-utm"
              className={`${INPUT} pa-num`}
              defaultValue="utm_source={{platform}}&utm_campaign={{campaign_id}}"
            />
          </Field>
        </Dialog>
      )}
    </>
  );
}
