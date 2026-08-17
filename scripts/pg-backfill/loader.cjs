/* eslint-disable */
// One-off backfill loader: reads NDJSON (one JSON array per line) from stdin and
// bulk-inserts into PG via the socat tunnel (127.0.0.1:15432). Idempotent.
//
// Usage:
//   node loader.cjs ddl                         -> create records_202605/202606
//   node loader.cjs records <table>  < ndjson   -> load a records_YYYYMM table (cols: id + RECORD_COLUMNS)
//   node loader.cjs userlookup                  < ndjson  -> load user_lookup (cols: user_id,app_id,event_time,install_time,payload,table_name)
//   node loader.cjs seqfix <table>              -> setval id sequence to max(id)
//   node loader.cjs counts                      -> print row counts
const { Client } = require('pg');
const readline = require('node:readline');
const zlib = require('node:zlib');
const fs = require('node:fs');
const { Readable } = require('node:stream');

// Resolve the NDJSON input source:
//   SRC_URL=<http url to .gz>  -> fetch + gunzip (pod pulls straight from server, no relay)
//   GZFILE=<path to .gz>       -> read file + gunzip
//   (else)                     -> raw NDJSON on stdin
async function inputStream() {
  if (process.env.SRC_URL) {
    const res = await fetch(process.env.SRC_URL);
    if (!res.ok) throw new Error(`fetch ${process.env.SRC_URL} -> ${res.status}`);
    return Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  }
  if (process.env.GZFILE) {
    return fs.createReadStream(process.env.GZFILE).pipe(zlib.createGunzip());
  }
  return process.stdin;
}

const RECORD_COLUMNS = [
  'source','app_id','event_name','event_time','revenue','currency','campaign',
  'media_source','ad_id','adset','country','device_id','install_time',
  'is_retargeting','payload','created_at',
];
const REC_COLS = ['id', ...RECORD_COLUMNS]; // 17
const UL_COLS = ['user_id','app_id','event_time','install_time','payload','table_name']; // 6

function recordDDL(table) {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, app_id TEXT, event_name TEXT,
      event_time TEXT, revenue DOUBLE PRECISION, currency TEXT DEFAULT 'USD',
      campaign TEXT, media_source TEXT, ad_id TEXT, adset TEXT, country TEXT,
      device_id TEXT, install_time TEXT, is_retargeting INTEGER DEFAULT 0,
      payload TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_source ON ${table}(source);
    CREATE INDEX IF NOT EXISTS idx_${table}_app ON ${table}(app_id);
    CREATE INDEX IF NOT EXISTS idx_${table}_event ON ${table}(event_name);
    CREATE INDEX IF NOT EXISTS idx_${table}_time ON ${table}(event_time);
    CREATE INDEX IF NOT EXISTS idx_${table}_created ON ${table}(created_at);
    CREATE INDEX IF NOT EXISTS idx_${table}_evt_time_range ON ${table}(event_name, event_time);
    CREATE INDEX IF NOT EXISTS idx_${table}_evt_inst_range ON ${table}(event_name, install_time);
  `;
}

function newClient() {
  // In-cluster (pod) run: use DATABASE_URL (fast pod<->RDS). Local run: socat tunnel.
  if (process.env.DATABASE_URL) return new Client({ connectionString: process.env.DATABASE_URL });
  return new Client({
    host: '127.0.0.1', port: 15432, user: 'postgres',
    password: process.env.PGPASSWORD, database: 'agentic_ug', ssl: false,
  });
}

async function loadStream({ table, cols, conflict }) {
  const c = newClient();
  await c.connect();
  const ncol = cols.length;
  // Stay under PG's 65535 bound-param limit; large batches cut round-trips.
  const BATCH = Math.floor(60000 / ncol);
  let batch = [];
  let total = 0;
  let bad = 0;

  async function flush() {
    if (batch.length === 0) return;
    const tuples = [];
    const params = [];
    let p = 1;
    for (const row of batch) {
      tuples.push('(' + cols.map(() => '$' + p++).join(',') + ')');
      for (let i = 0; i < ncol; i++) params.push(row[i] === undefined ? null : row[i]);
    }
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${conflict}`;
    await c.query(sql, params);
    total += batch.length;
    batch = [];
    if (total % 50000 === 0) process.stderr.write(`  ${table}: ${total} rows\n`);
  }

  const rl = readline.createInterface({ input: await inputStream(), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let arr;
    try { arr = JSON.parse(line); } catch { bad++; continue; }
    if (!Array.isArray(arr) || arr.length !== ncol) { bad++; continue; }
    batch.push(arr);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  await c.end();
  process.stderr.write(`DONE ${table}: inserted-attempted ${total} rows, skipped-malformed ${bad}\n`);
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'ddl') {
    const c = newClient(); await c.connect();
    for (const t of ['records_202605', 'records_202606']) { await c.query(recordDDL(t)); console.log('ensured', t); }
    await c.end(); return;
  }
  if (mode === 'records') {
    if (!/^records_\d{6}$/.test(arg)) throw new Error('bad table ' + arg);
    await loadStream({ table: arg, cols: REC_COLS, conflict: 'ON CONFLICT (id) DO NOTHING' });
    return;
  }
  if (mode === 'userlookup') {
    await loadStream({ table: 'user_lookup', cols: UL_COLS, conflict: 'ON CONFLICT (user_id) DO NOTHING' });
    return;
  }
  if (mode === 'seqfix') {
    const c = newClient(); await c.connect();
    const r = await c.query(`SELECT setval(pg_get_serial_sequence('${arg}','id'), COALESCE((SELECT MAX(id) FROM ${arg}),1), true) AS s`);
    console.log('seq', arg, '->', r.rows[0].s);
    await c.end(); return;
  }
  if (mode === 'counts') {
    const c = newClient(); await c.connect();
    for (const t of ['records_202605','records_202606','records_202607','user_lookup','athena_revenue']) {
      try { const q = await c.query(`select count(*)::bigint n from ${t}`); console.log(t, '=', q.rows[0].n); }
      catch (e) { console.log(t, 'ERR', e.message); }
    }
    await c.end(); return;
  }
  throw new Error('unknown mode ' + mode);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
