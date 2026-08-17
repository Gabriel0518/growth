import { requireApiAuth } from '@/lib/dashboard/auth';
import { fetchXmpCampaigns, purgeIncompleteXmpCache } from '@/lib/dashboard/xmp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RETRIES = 2;
const RETRY_WAIT_MS = 60_000;
const BETWEEN_DATES_MS = 10_000;
const CHANNELS = ['FB', 'GG', 'TT'] as const;

let backfillRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POST /api/xmp-backfill：按日强制重拉 XMP，NDJSON 流式回报进度（复刻旧 /api/xmp-backfill）。 */
export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const rawDates = (body as { dates?: unknown }).dates;
  if (!Array.isArray(rawDates) || rawDates.length === 0) {
    return Response.json({ error: 'dates array required' }, { status: 400 });
  }
  const validDates = rawDates.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d));
  if (validDates.length === 0) {
    return Response.json({ error: 'No valid dates' }, { status: 400 });
  }
  if (backfillRunning) {
    return Response.json({ error: 'Backfill already in progress' }, { status: 409 });
  }
  backfillRunning = true;

  const encoder = new TextEncoder();
  const total = validDates.length;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const send = (obj: unknown): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      try {
        let completed = 0;
        for (const date of validDates) {
          send({ status: 'fetching', date, completed, total });
          let success = false;

          for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
            try {
              await purgeIncompleteXmpCache(date);
              const rows = await fetchXmpCampaigns(date);
              const have = new Set(rows.map((r) => r.channel));
              if (CHANNELS.every((ch) => have.has(ch))) {
                success = true;
                break;
              }
              if (attempt < MAX_RETRIES) {
                const missingChannels = CHANNELS.filter((ch) => !have.has(ch));
                send({
                  status: 'retrying',
                  date,
                  attempt: attempt + 1,
                  maxRetries: MAX_RETRIES,
                  missingChannels,
                  completed,
                  total,
                });
                await sleep(RETRY_WAIT_MS);
              }
            } catch (error) {
              if (attempt < MAX_RETRIES) {
                send({
                  status: 'retrying',
                  date,
                  attempt: attempt + 1,
                  maxRetries: MAX_RETRIES,
                  error: (error as Error).message,
                  completed,
                  total,
                });
                await sleep(RETRY_WAIT_MS);
              }
            }
          }

          completed += 1;
          if (success) {
            send({ status: 'done', date, completed, total });
          } else {
            send({
              status: 'partial',
              date,
              completed,
              total,
              message: '部分渠道未补全（QPM限频）',
            });
          }
          if (completed < total) await sleep(BETWEEN_DATES_MS);
        }
        send({ status: 'complete', completed, total });
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        backfillRunning = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
