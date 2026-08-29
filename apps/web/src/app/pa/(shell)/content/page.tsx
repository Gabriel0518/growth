'use client';

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import {
  AssetCard,
  Card,
  DeltaList,
  Dialog,
  Drawer,
  EmptyState,
  Eyebrow,
  PageHeader,
  useToast,
  usePaStore,
} from '@/components/pa';
import { Button, Checkbox, Dropdown, SearchField, Segment, StatusPill } from '@/components/ui';
import { compact, int, roas } from '@/lib/pa/format';
import { ASSET_LABEL, ASSET_TONE_OF } from '@/lib/pa/status';

export default function ContentPage(): ReactNode {
  const { state, dispatch } = usePaStore();
  const toast = useToast();
  const [origin, setOrigin] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [productId, setProductId] = useState('all');
  const [campaignId, setCampaignId] = useState('all');
  const [creatorId, setCreatorId] = useState('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');

  const assets = state.assets.filter((a) => {
    if (origin !== 'all' && a.origin !== origin) return false;
    if (status !== 'all' && a.status !== status) return false;
    if (
      productId !== 'all' &&
      (a.productId ?? state.campaigns.find((c) => c.id === a.campaignId)?.productId) !== productId
    )
      return false;
    if (campaignId !== 'all' && a.campaignId !== campaignId) return false;
    if (creatorId !== 'all' && a.creatorId !== creatorId) return false;
    if (query && !a.file.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const opened = state.assets.find((a) => a.id === openId);
  const openedCreator = state.creators.find((c) => c.id === opened?.creatorId);
  const originals = state.assets.filter((a) => a.origin === 'original');

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0] ?? null;
    setUploadFile(file);
    if (file && !uploadName) setUploadName(file.name.replace(/\.[^.]+$/, ''));
  }

  function uploadSource(): void {
    if (!uploadName.trim() || !uploadFile) {
      toast("Couldn't upload — choose a video file and give it a name", 'error');
      return;
    }
    const extension = uploadFile.name.split('.').pop()?.toUpperCase() || 'MP4';
    dispatch({
      type: 'addAsset',
      asset: {
        id: `upload-${String(Date.now())}`,
        file: `${uploadName.trim()}.${uploadFile.name.split('.').pop() ?? 'mp4'}`,
        kind: extension,
        ratio: '9:16',
        len: null,
        status: 'ready',
        origin: 'original',
        hue: 196,
        campaignId: 'unassigned',
      },
    });
    setUploadOpen(false);
    setUploadFile(null);
    setUploadName('');
    if (fileRef.current) fileRef.current.value = '';
    toast('Source video uploaded to the library', 'ok');
  }

  return (
    <>
      <Eyebrow>Library / Creative</Eyebrow>
      <PageHeader
        title="Content"
        badge={
          <span className="pa-num inline-flex h-[22px] items-center rounded-pa-full bg-pa-surface-muted px-[10px] text-pa-11 text-pa-content-body">
            {int(state.assets.length)} assets
          </span>
        }
        lede="Source footage and the AI variants generated from it, per campaign and creator."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setUploadOpen(true);
              }}
            >
              Upload
            </Button>
            <Button
              onClick={() => {
                setGenOpen(true);
              }}
            >
              Generate variants
            </Button>
          </>
        }
      />

      <div className="mb-pa-4 grid gap-pa-3 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-wrap gap-pa-3">
          <Segment
            aria-label="Origin"
            value={origin}
            onChange={setOrigin}
            items={[
              { value: 'all', label: 'All' },
              { value: 'original', label: 'Source' },
              { value: 'ai', label: 'AI variants' },
            ]}
          />
          <div className="w-[170px]">
            <Dropdown
              aria-label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'ready', label: 'Ready' },
                { value: 'generating', label: 'Generating' },
                { value: 'review', label: 'Needs review' },
                { value: 'failed', label: 'Failed' },
              ]}
            />
          </div>
          <div className="w-[180px]">
            <Dropdown
              aria-label="Application"
              value={productId}
              onChange={setProductId}
              options={[
                { value: 'all', label: 'All applications' },
                ...state.products.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </div>
          <div className="w-[190px]">
            <Dropdown
              aria-label="Campaign"
              value={campaignId}
              onChange={setCampaignId}
              options={[
                { value: 'all', label: 'All campaigns' },
                { value: 'unassigned', label: 'Unassigned' },
                ...state.campaigns.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
          <div className="w-[180px]">
            <Dropdown
              aria-label="KOL"
              value={creatorId}
              onChange={setCreatorId}
              options={[
                { value: 'all', label: 'All KOLs' },
                ...state.creators.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
        </div>
        <div className="w-[240px]">
          <SearchField value={query} onChange={setQuery} placeholder="Search file name" />
        </div>
      </div>

      <div className="mb-pa-4 flex flex-wrap items-center gap-pa-2 text-pa-11 text-pa-content-tertiary">
        <span className="rounded-pa-full bg-pa-surface-muted px-[10px] py-[5px]">
          {state.assets.filter((asset) => asset.origin === 'original').length} source videos
        </span>
        <span className="rounded-pa-full bg-pa-surface-muted px-[10px] py-[5px]">
          {state.assets.filter((asset) => asset.origin === 'ai').length} AI generated videos
        </span>
        <span className="text-pa-10">
          Filter by application, campaign, or KOL to trace every variant.
        </span>
      </div>

      {assets.length === 0 ? (
        <Card>
          <EmptyState
            title={query ? 'No creative matches that search' : 'The library is empty'}
            description={
              query
                ? 'Try a shorter term, or clear the status and origin filters.'
                : 'Upload source footage, then generate a variant for each creator on a campaign.'
            }
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setOrigin('all');
                  setStatus('all');
                  setQuery('');
                  setProductId('all');
                  setCampaignId('all');
                  setCreatorId('all');
                }}
              >
                Clear all filters
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-pa-3">
          {assets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              creator={state.creators.find((c) => c.id === asset.creatorId)}
              onOpen={() => {
                setOpenId(asset.id);
              }}
            />
          ))}
        </div>
      )}

      {opened && (
        <Dialog
          title={opened.file}
          lede={`${opened.kind} · ${opened.ratio}${opened.len === null ? '' : ` · ${opened.len}`}`}
          onClose={() => {
            setOpenId(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpenId(null);
                }}
              >
                Close
              </Button>
              {opened.status === 'review' && (
                <Button
                  variant="danger"
                  onClick={() => {
                    dispatch({ type: 'updateAsset', id: opened.id, patch: { status: 'failed' } });
                    setOpenId(null);
                    toast(`Rejected ${opened.file}`, 'ok');
                  }}
                >
                  Reject variant
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-pa-3">
            <StatusPill tone={ASSET_TONE_OF(opened.status)}>
              {ASSET_LABEL[opened.status]}
            </StatusPill>
            <span className="text-pa-12 text-pa-content-body">
              {opened.origin === 'ai'
                ? `AI variant${openedCreator === undefined ? '' : ` for ${openedCreator.name}`}`
                : 'Source footage'}
            </span>
          </div>

          <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-pa-lg bg-pa-surface-muted">
            {opened.previewUrl ? (
              <video
                src={opened.previewUrl}
                poster={opened.cover ?? openedCreator?.avatar}
                controls
                playsInline
                className="aspect-[9/16] h-auto w-full object-cover"
              />
            ) : (
              <div
                className="grid aspect-[9/16] place-items-center"
                style={{
                  background: opened.cover
                    ? `linear-gradient(155deg, rgba(15,23,42,.06), rgba(15,23,42,.68)), url(${opened.cover}) center / cover`
                    : `linear-gradient(145deg, hsl(${String(opened.hue)} 46% 62%), hsl(${String((opened.hue + 38) % 360)} 42% 38%))`,
                }}
              >
                <span className="rounded-pa-full bg-black/50 px-pa-3 py-pa-2 text-pa-11 font-semibold text-white">
                  Preview frame
                </span>
              </div>
            )}
          </div>

          <div className="grid gap-pa-2 rounded-pa-md bg-pa-surface-muted p-pa-3 text-pa-11 text-pa-content-tertiary">
            <div className="flex items-center justify-between gap-pa-3">
              <span>Application</span>
              <b className="text-pa-content-body">
                {state.products.find(
                  (product) =>
                    product.id ===
                    (opened.productId ??
                      state.campaigns.find((campaign) => campaign.id === opened.campaignId)
                        ?.productId),
                )?.name ?? 'Unassigned'}
              </b>
            </div>
            <div className="flex items-center justify-between gap-pa-3">
              <span>Campaign</span>
              <b className="truncate text-pa-content-body">
                {state.campaigns.find((campaign) => campaign.id === opened.campaignId)?.name ??
                  'Unassigned'}
              </b>
            </div>
            {opened.sourceAssetId ? (
              <div className="flex items-center justify-between gap-pa-3">
                <span>Generated from</span>
                <b className="truncate text-pa-content-body">
                  {state.assets.find((asset) => asset.id === opened.sourceAssetId)?.file ??
                    opened.sourceAssetId}
                </b>
              </div>
            ) : null}
          </div>

          {opened.error === undefined ? null : (
            <div className="rounded-pa-md bg-pa-negative-subtle p-pa-4 text-pa-12 text-pa-negative">
              {/* 错误文案说 "Couldn't …"，不说 "Failed to …"，也不暴露状态码 */}
              Couldn&apos;t generate this variant — {opened.error}
            </div>
          )}

          {opened.perf === undefined ? null : (
            <DeltaList
              rows={[
                { label: 'Impressions', from: '—', to: compact(opened.perf.impressions) },
                { label: 'CTR', from: '—', to: `${opened.perf.ctr.toFixed(1)}%` },
                { label: 'ROAS', from: '—', to: roas(opened.perf.roas) },
                { label: 'Used on', from: '—', to: `${String(opened.perf.campaigns)} campaigns` },
              ]}
            />
          )}
        </Dialog>
      )}

      {genOpen && (
        <Drawer
          title="Generate creative variants"
          lede="Pick source footage; the system renders one variant per creator on the campaign."
          onClose={() => {
            setGenOpen(false);
            setSources([]);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setGenOpen(false);
                  setSources([]);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (sources.length === 0) {
                    toast("Couldn't start — pick at least one source asset", 'error');
                    return;
                  }
                  toast(
                    `Queued ${String(sources.length)} generation task${sources.length === 1 ? '' : 's'}`,
                    'ok',
                  );
                  setGenOpen(false);
                  setSources([]);
                }}
              >
                Start generation
              </Button>
            </>
          }
        >
          <div>
            <Eyebrow className="mb-pa-2">① Source footage</Eyebrow>
            {originals.map((asset) => (
              <Checkbox
                key={asset.id}
                checked={sources.includes(asset.id)}
                onChange={(on) => {
                  setSources((prev) =>
                    on ? [...prev, asset.id] : prev.filter((id) => id !== asset.id),
                  );
                }}
                label={<span className="text-pa-12">{asset.file}</span>}
              />
            ))}
          </div>

          <div className="mt-pa-5">
            {/* Prompt 按批次统一生效：一次生成任务共用一段修改说明，
                需要不同修改就分批生成（BACKLOG.md 2026-08-21 确认）。 */}
            <Eyebrow className="mb-pa-2">② Edit instructions</Eyebrow>
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
              }}
              rows={4}
              placeholder="Swap the background to a bright kitchen and add subtitles."
              className="w-full rounded-pa-md border border-pa-border bg-pa-surface p-pa-3 text-pa-13 outline-none placeholder:text-pa-content-placeholder focus:border-pa-ring"
            />
            <p className="mt-pa-2 text-pa-11 text-pa-content-tertiary">
              Applied to every asset in this batch. Split the batch if some clips need different
              edits.
            </p>
          </div>
        </Drawer>
      )}

      {uploadOpen && (
        <Dialog
          title="Upload source video"
          lede="Add original footage to the library. You can attach it to a campaign during campaign setup."
          onClose={() => setUploadOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setUploadOpen(false)}>
                Cancel
              </Button>
              <Button onClick={uploadSource}>Upload source</Button>
            </>
          }
        >
          <div className="grid gap-pa-2">
            <label
              htmlFor="pa-upload-name"
              className="text-pa-12 font-semibold text-pa-content-secondary"
            >
              Asset name
            </label>
            <input
              id="pa-upload-name"
              value={uploadName}
              onChange={(event) => setUploadName(event.target.value)}
              placeholder="summer_hook_v4"
              className="h-[var(--pa-hit-target)] rounded-pa-md border border-pa-border bg-pa-surface px-[14px] text-pa-13 outline-none focus:border-pa-ring"
            />
          </div>
          <div className="grid gap-pa-2">
            <label
              htmlFor="pa-upload-file"
              className="text-pa-12 font-semibold text-pa-content-secondary"
            >
              Video file
            </label>
            <input
              ref={fileRef}
              id="pa-upload-file"
              type="file"
              accept="video/*"
              onChange={onFileChange}
              className="block w-full rounded-pa-md border border-dashed border-pa-border-strong bg-pa-surface-muted p-pa-3 text-pa-12"
            />
            <p className="text-pa-11 text-pa-content-tertiary">
              MP4 or MOV · 9:16 recommended for creator placements.
            </p>
          </div>
        </Dialog>
      )}
    </>
  );
}
