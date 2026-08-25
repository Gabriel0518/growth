'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Card, Dialog, Eyebrow, PageHeader, Stepper, useToast, usePaStore } from '@/components/pa';
import { Button, buttonClasses, Dropdown, PlatformIcon, type Platform } from '@/components/ui';
import type { AdAccount, Draft } from '@/lib/pa/types';

const MARKET_OPTIONS = [
  { value: 'United States', label: 'United States' },
  { value: 'United States · English audience', label: 'United States · English audience' },
  { value: 'United States · Spanish audience', label: 'United States · Spanish audience' },
] as const;

function accountPlatform(platform: string): Platform {
  const value = platform.toLowerCase();
  if (value.includes('tiktok')) return 'tt';
  if (value.includes('google') || value.includes('youtube')) return 'yt';
  return 'ig';
}

function selectedMarkets(value: string): string[] {
  return value
    .split(',')
    .map((market) => market.trim())
    .filter(Boolean);
}

function MarketMultiSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = selectedMarkets(value);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnKeyDown);
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [open]);

  const label =
    selected.length === 0
      ? 'Select markets'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} markets selected`;

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        role="combobox"
        aria-label="Market"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="flex h-[var(--pa-hit-target)] w-full items-center justify-between gap-pa-3 rounded-pa-md border border-pa-border bg-pa-surface px-[14px] text-left text-pa-13 text-pa-content outline-none transition-[border-color,box-shadow] hover:border-pa-border-strong focus-visible:border-pa-ring focus-visible:shadow-[0_0_0_3px_rgba(8,145,178,0.16)]"
      >
        <span className={selected.length === 0 ? 'text-pa-content-placeholder' : 'truncate'}>
          {label}
        </span>
        <svg
          viewBox="0 0 10 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className={`h-[6px] w-[10px] shrink-0 text-pa-content-tertiary transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M1 1l4 4 4-4" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Markets"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 rounded-pa-md border border-pa-border bg-pa-surface p-[4px] shadow-pa-2"
        >
          {MARKET_OPTIONS.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label
                key={option.value}
                className="flex min-h-[40px] cursor-pointer items-center gap-pa-2 rounded-pa-sm px-pa-3 text-pa-13 text-pa-content-secondary transition-colors hover:bg-pa-surface-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((market) => market !== option.value);
                    onChange(next.join(', '));
                  }}
                  className="h-[16px] w-[16px] shrink-0 accent-pa-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
                />
                <span className={checked ? 'font-semibold text-pa-accent' : ''}>
                  {option.label}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 新草稿的默认值。与 Figma `03.1 · Create campaign — Ad setup` 一致。 */
function blankDraft(): Draft {
  return {
    accountId: '',
    plan: 'US · Summer partnership / installs',
    name: '',
    market: 'United States',
    productId: 'yahtzee',
    schedule: 'manual',
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
    if (account === undefined) {
      setAccountsOpen(true);
      toast('Connect an ad account before continuing.', 'error');
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

      <Card padded className="mb-pa-4 flex flex-wrap items-center justify-between gap-pa-3">
        {account === undefined ? (
          <div className="flex items-center gap-pa-3">
            <span
              className="grid h-[36px] w-[36px] place-items-center rounded-pa-md border border-dashed border-pa-border-strong bg-pa-surface-muted text-pa-content-tertiary"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="h-[18px] w-[18px]"
              >
                <path d="M10 4v12M4 10h12" strokeLinecap="round" />
              </svg>
            </span>
            <div>
              <b className="text-pa-13">No ad account connected</b>
              <div className="text-pa-11 text-pa-content-tertiary">
                Choose a channel account to start building ads.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-pa-3">
            <PlatformIcon platform={accountPlatform(account.platform)} />
            <div>
              <b className="text-pa-13">
                {account.platform} · {account.owner}
              </b>
              <div className="pa-num text-pa-11 text-pa-content-tertiary">
                {account.id} · connected {account.connected}
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-pa-2">
          <Button
            variant={account === undefined ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              setAccountsOpen(true);
            }}
          >
            {account === undefined ? 'Connect account' : 'Change account'}
          </Button>
          {account !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLocal({ ...draft, accountId: '' });
              }}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </Card>

      <Card padded className="mb-pa-4 border-pa-border-strong">
        <div className="mb-pa-5 flex items-center justify-between gap-pa-3 border-b border-pa-border-subtle pb-pa-4">
          <h2 className="text-pa-20 font-bold text-pa-content">Ads Plan</h2>
          <span className="text-pa-11 font-semibold uppercase tracking-[0.12em] text-pa-content-tertiary">
            Step 1
          </span>
        </div>

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
            <MarketMultiSelect
              value={draft.market}
              onChange={(market) => {
                setLocal({ ...draft, market });
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
        </div>
      </Card>

      <Card padded className="mb-pa-5 border-pa-border-strong">
        <details open>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-pa-3 [&::-webkit-details-marker]:hidden">
            <h2 className="text-pa-20 font-bold text-pa-content">Advanced</h2>
            <svg
              viewBox="0 0 10 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
              className="h-[6px] w-[10px] text-pa-content-tertiary"
            >
              <path d="M1 1l4 4 4-4" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="mt-pa-5 grid gap-pa-4 border-t border-pa-border-subtle pt-pa-5 md:grid-cols-2">
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
          </div>
        </details>
      </Card>

      <div className="mb-pa-4 flex flex-wrap items-center justify-between gap-pa-3">
        <Link href="/pa/campaigns" className={buttonClasses('secondary')}>
          Cancel
        </Link>
        <Button onClick={next}>Continue to goal</Button>
      </div>

      {accountsOpen && (
        <Dialog
          title="Connect an ad account"
          lede="Choose the channel account that will deliver this campaign."
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
            {state.adAccounts.map((a: AdAccount) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-pa-3">
                  <PlatformIcon platform={accountPlatform(a.platform)} />
                  <div className="min-w-0">
                    <b className="block truncate text-pa-13">
                      {a.platform} · {a.owner}
                    </b>
                    <div className="pa-num text-pa-11 text-pa-content-tertiary">
                      {a.id} · connected {a.connected}
                    </div>
                  </div>
                </div>
                <Button
                  variant={draft.accountId === a.id ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => {
                    setLocal({ ...draft, accountId: a.id });
                    setAccountsOpen(false);
                  }}
                >
                  {draft.accountId === a.id
                    ? 'Selected'
                    : a.state === 'ok'
                      ? 'Connect'
                      : 'Reconnect'}
                </Button>
              </div>
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}
