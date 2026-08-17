import pg from 'pg';

const { Pool } = pg;

/**
 * 构造连接串。优先级与旧 dataserver/db.py 完全一致：
 *   1. DATABASE_URL 完整 DSN
 *   2. 分量变量 DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME（兼容 libpq PG*）
 */
export function resolveDsn(): string {
  const url = process.env['DATABASE_URL'];
  if (url) return url;
  const host = process.env['DATABASE_HOST'] ?? process.env['PGHOST'] ?? 'localhost';
  const port = process.env['DATABASE_PORT'] ?? process.env['PGPORT'] ?? '5432';
  const user = process.env['DATABASE_USERNAME'] ?? process.env['PGUSER'] ?? 'postgres';
  const password = process.env['DATABASE_PASSWORD'] ?? process.env['PGPASSWORD'] ?? '';
  const name = process.env['DATABASE_NAME'] ?? process.env['PGDATABASE'] ?? 'agentic_ug';
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

function poolBounds(): { min: number; max: number } {
  return {
    min: Number.parseInt(process.env['DB_POOL_MIN'] ?? '2', 10),
    max: Number.parseInt(process.env['DB_POOL_MAX'] ?? '10', 10),
  };
}

let sharedPool: pg.Pool | undefined;

/** 进程级共享连接池（惰性创建，全仓库复用同一实例）。 */
export function getPool(): pg.Pool {
  if (!sharedPool) {
    const { min, max } = poolBounds();
    sharedPool = new Pool({ connectionString: resolveDsn(), min, max });
  }
  return sharedPool;
}

export async function closePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

/** 参数化查询，返回行数组。 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

/** 单行查询，无结果返回 undefined。 */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}
