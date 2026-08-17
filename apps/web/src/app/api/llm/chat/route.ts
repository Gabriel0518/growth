import { config } from '@/lib/config';
import { requireApiAuth } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LLM_TIMEOUT = 180_000; // 180s，与旧 server.js 一致

interface ChatBody {
  messages?: unknown;
  model?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function sseError(message: string, statusCode?: number): string {
  const payload = statusCode == null ? { error: message } : { error: message, statusCode };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** POST /api/llm/chat：把对话透传到 SiliconFlow（OpenAI 兼容）chat/completions，支持 SSE 流式代理。 */
export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages array required' }, { status: 400 });
  }

  const targetModel =
    typeof body.model === 'string' && body.model !== '' ? body.model : config.llm.model;
  const useStream = body.stream !== false;
  const payload = {
    model: targetModel,
    messages,
    stream: useStream,
    ...(body.temperature == null ? {} : { temperature: body.temperature }),
    ...(body.max_tokens == null ? {} : { max_tokens: body.max_tokens }),
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LLM_TIMEOUT);
  const abortMessage = (err: unknown): string =>
    timedOut ? 'LLM request timeout' : (err as Error).message;

  let upstream: Response;
  try {
    upstream = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const message = abortMessage(error);
    if (useStream) return new Response(sseError(message), { headers: SSE_HEADERS });
    return Response.json({ error: message }, { status: 502 });
  }

  if (!useStream) {
    const text = await upstream.text();
    clearTimeout(timer);
    try {
      return Response.json(JSON.parse(text));
    } catch {
      return Response.json(
        { error: 'Invalid LLM response', raw: text.slice(0, 500) },
        { status: 502 },
      );
    }
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    clearTimeout(timer);
    let errMsg = errText;
    try {
      errMsg = (JSON.parse(errText) as { error?: { message?: string } }).error?.message ?? errText;
    } catch {
      /* 非 JSON，保留原文 */
    }
    return new Response(sseError(errMsg, upstream.status), { headers: SSE_HEADERS });
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          clearTimeout(timer);
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        streamController.enqueue(encoder.encode(sseError(abortMessage(error))));
        streamController.close();
        clearTimeout(timer);
      }
    },
    cancel() {
      void reader.cancel();
      clearTimeout(timer);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
