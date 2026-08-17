import { currentTable } from '@agentic-ug/core';

import { queueSize } from '../../lib/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 健康检查（对齐旧 dataserver GET /）。 */
export async function GET(): Promise<Response> {
  return Response.json({
    status: 'ok',
    version: '3.0.0',
    queue_size: await queueSize(),
    current_table: currentTable(),
  });
}
