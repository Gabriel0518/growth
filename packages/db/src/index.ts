export { resolveDsn, getPool, closePool, query, queryOne } from './pool.js';

export {
  RECORD_COLUMNS,
  AF_UID_EXPR,
  AD_UID_EXPR,
  ensureRecordTable,
  ensureSharedTables,
  ensureIngestInbox,
  ensureDashboardTables,
  ensureAuthTables,
  ensureDemoUserTable,
  ensureAdTables,
} from './schema.js';

export type { RecordColumn } from './schema.js';
