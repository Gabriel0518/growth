import type pg from 'pg';

/**
 * 记录表列顺序 —— 与旧 dataserver/db.py 的 RECORD_COLUMNS 完全一致，
 * 批量写入的行元组必须按此顺序排列。
 */
export const RECORD_COLUMNS = [
  'source',
  'app_id',
  'event_name',
  'event_time',
  'revenue',
  'currency',
  'campaign',
  'media_source',
  'ad_id',
  'adset',
  'country',
  'device_id',
  'install_time',
  'is_retargeting',
  'payload',
  'created_at',
] as const;

export type RecordColumn = (typeof RECORD_COLUMNS)[number];

/**
 * 注册事件去重的 user_id 提取表达式（PG 版，复刻旧 SQLite AF_UID_EXPR/AD_UID_EXPR）。
 * AF：user_id 双重嵌套于 payload.event_value（本身是 JSON 字符串）。
 * AD：user_id 在 payload 顶层，仅纯数字视为有效（占位宏/空串视为无 uid，保留不去重）。
 * 嵌套 CASE 逐层守卫：payload / event_value 非 `{…}` 时短路，避免 ::jsonb 在非法 JSON 上抛错
 * （既保护查询，也保护下方表达式局部索引的建立）。schema 与 dashboard 查询共用同一字符串，
 * 以便规划器命中该索引。
 */
export const AF_UID_EXPR =
  "CASE WHEN payload ~ '^[[:space:]]*[{]' THEN " +
  "CASE WHEN (payload::jsonb->>'event_value') ~ '^[[:space:]]*[{]' " +
  "THEN (payload::jsonb->>'event_value')::jsonb->>'user_id' ELSE NULL END ELSE NULL END";

export const AD_UID_EXPR =
  "CASE WHEN payload ~ '^[[:space:]]*[{]' THEN " +
  "CASE WHEN (payload::jsonb->>'user_id') ~ '^[0-9]+$' " +
  "THEN (payload::jsonb->>'user_id') ELSE NULL END ELSE NULL END";

type Queryable = Pick<pg.PoolClient, 'query'> | Pick<pg.Pool, 'query'>;

/**
 * 确保月表 records_YYYYMM 存在（列语义与旧 SQLite/asyncpg 版一致）。
 * 7 个索引缺一不可：range 复合索引支撑 dashboard 单日范围扫描，删了会退化全表扫。
 */
export async function ensureRecordTable(conn: Queryable, tableName: string): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id              BIGSERIAL PRIMARY KEY,
      source          TEXT NOT NULL,
      app_id          TEXT,
      event_name      TEXT,
      event_time      TEXT,
      revenue         DOUBLE PRECISION,
      currency        TEXT DEFAULT 'USD',
      campaign        TEXT,
      media_source    TEXT,
      ad_id           TEXT,
      adset           TEXT,
      country         TEXT,
      device_id       TEXT,
      install_time    TEXT,
      is_retargeting  INTEGER DEFAULT 0,
      payload         TEXT,
      created_at      TEXT
    )
  `);
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_source ON ${tableName}(source)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_app ON ${tableName}(app_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_event ON ${tableName}(event_name)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_time ON ${tableName}(event_time)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_created ON ${tableName}(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_evt_time_range ON ${tableName}(event_name, event_time)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_evt_inst_range ON ${tableName}(event_name, install_time)`,
    // 注册去重用：AF/AD user_id 表达式局部索引（复刻旧 dataserver/app.py 手补的 AF uid 索引）。
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_af_uid ON ${tableName} ((${AF_UID_EXPR})) WHERE event_name = 'af_complete_registration'`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_ad_uid ON ${tableName} ((${AD_UID_EXPR})) WHERE event_name = 'ad_complete_registration'`,
  ];
  for (const stmt of indexes) {
    await conn.query(stmt);
  }
}

/**
 * 飞书 OAuth + 卡片确认登录用表（方案 C）。幂等 DDL，migrate 自动应用。
 * - fs_user：已授权用户名录，二次登录靠它列出可选人（open_id 是飞书侧稳定主键）。
 * - login_challenge：一次性登录/敏感操作挑战。nonce 一次性，TTL 由写入方按 expires_at 控制；
 *   卡片回调按 nonce 命中并校验 open_id 归属（防串号），仅 pending 可被 confirm/reject。
 * 邮箱反查 open_id 不可靠（通讯录常缺登记邮箱），故走 OAuth 拿 open_id，别退回邮箱反查。
 */
export async function ensureAuthTables(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS fs_user (
      open_id    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      union_id   TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS login_challenge (
      nonce      TEXT PRIMARY KEY,
      open_id    TEXT NOT NULL,
      purpose    TEXT NOT NULL DEFAULT 'login',
      status     TEXT NOT NULL DEFAULT 'pending',
      detail     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await conn.query(
    `CREATE INDEX IF NOT EXISTS idx_login_challenge_open ON login_challenge(open_id)`,
  );
}

/**
 * sitin.ai 客户门户（/demo）的独立账号表。**明文口令**：门户是对外演示 + 只读经营看板，
 * 屹恒明确要求登录账密直接落库、服务端逐字比对，不走环境变量、也不引哈希（演示级足够，
 * 真要上生产再换 bcrypt 即可，届时只改 verifyCredentials 一处）。
 * 幂等 DDL + 默认账号种子（ON CONFLICT DO NOTHING），migrate 与登录路由都可安全重复调用。
 */
export async function ensureDemoUserTable(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS demo_portal_user (
      username   TEXT PRIMARY KEY,
      password   TEXT NOT NULL,
      company    TEXT NOT NULL DEFAULT 'sitin.ai',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // 默认演示账号：用户名 sitin / 口令 aifantasy（与旧环境变量默认值一致，保证零配置可登录）。
  await conn.query(
    `INSERT INTO demo_portal_user (username, password, company)
          VALUES ('sitin', 'aifantasy', 'sitin.ai')
     ON CONFLICT (username) DO NOTHING`,
  );
}

/** user_lookup 与 athena_revenue 常驻表（沿用旧 schema）。 */
export async function ensureSharedTables(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS user_lookup (
      user_id      BIGINT PRIMARY KEY,
      app_id       TEXT,
      event_time   TEXT,
      install_time TEXT,
      payload      TEXT,
      table_name   TEXT
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS athena_revenue (
      date       TEXT PRIMARY KEY,
      items      JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 上报缓冲表 ingest_inbox —— 复刻旧版内存队列的「接受/批写」解耦。
 * UNLOGGED 降低写开销（重启丢失可接受：上报本身允许丢弃）。
 * 行元组以 JSONB 存储（按 RECORD_COLUMNS 顺序的数组），worker 批量消费后删除。
 */
export async function ensureIngestInbox(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS ingest_inbox (
      id         BIGSERIAL PRIMARY KEY,
      row        JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 看板统一存储表 —— 替代旧 dashboard/data/ 下的 JSON 文件。
 * 先以 JSONB 保留原始结构求零差异，后续再逐步结构化下沉。
 *
 * daily_snapshots 用 (kind, date) 复合主键统一承载所有按日 JSON blob：
 * kind='main'（旧 {date}.json）、'personal'（personal-{date}.json）、
 * 'creative'（creative-{date}.json）、'aigc'（aigc-{date}.json）。
 */
export async function ensureDashboardTables(conn: Queryable): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      kind       TEXT NOT NULL,
      date       TEXT NOT NULL,
      payload    JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, date)
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS xmp_cache (
      cache_key  TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS eltv_cache (
      key        TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // fetch_status 承载旧 fetcher.js 的进程内 fetchStatus 对象：单进程内存 → 跨进程 PG。
  // kind='main'（对应旧 getStatus()）；scheduler 写、/api/status 读、/api/refresh 判并发。
  await conn.query(`
    CREATE TABLE IF NOT EXISTS fetch_status (
      kind       TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 投放平台 Demo 阶段表（幂等 DDL）。
 * - 所有广告表主键为 SERIAL，外键为 INTEGER。
 */

/**
 * ad_group → ad_set 迁移：表改名 + 列改名 + 新列。
 * 旧表 ad_group 存在时自动备份→删表→重建为 ad_set。
 */
async function migrateAdGroupToAdSet(conn: Queryable): Promise<void> {
  const exists = await conn.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ad_group')`,
  );
  if (!exists.rows[0]?.exists) return; // 没有旧表，跳过

  console.log('[migrate] 检测到旧表 ad_group，开始迁移为 ad_set …');

  // 备份旧数据
  await conn.query(`CREATE TEMP TABLE _ad_group_bak AS SELECT * FROM ad_group`);
  await conn.query(`CREATE TEMP TABLE _ad_bak AS SELECT * FROM ad`);

  // 删旧表（逆序FK）
  await conn.query(`DROP TABLE IF EXISTS ad CASCADE`);
  await conn.query(`DROP TABLE IF EXISTS ad_group CASCADE`);

  // 建新表
  await conn.query(`
    CREATE TABLE ad_set (
      id                 SERIAL PRIMARY KEY,
      channel            VARCHAR NOT NULL DEFAULT 'fb',
      campaign_id        INTEGER NOT NULL REFERENCES ad_campaign(id),
      channel_adset_id   VARCHAR UNIQUE,
      name               VARCHAR NOT NULL,
      status             VARCHAR NOT NULL DEFAULT 'PAUSED',
      optimization_goal  VARCHAR,
      billing_event      VARCHAR,
      targeting          JSONB DEFAULT '{}',
      channel_extra      JSONB DEFAULT '{}',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await conn.query(`
    CREATE TABLE ad (
      id               SERIAL PRIMARY KEY,
      channel          VARCHAR NOT NULL DEFAULT 'fb',
      adset_id         INTEGER NOT NULL REFERENCES ad_set(id),
      ad_campaign_id   INTEGER REFERENCES ad_campaign(id),
      creative_id      INTEGER REFERENCES ad_creative(id),
      channel_ad_id    VARCHAR UNIQUE,
      name             VARCHAR NOT NULL,
      status           VARCHAR NOT NULL DEFAULT 'PAUSED',
      effective_status VARCHAR,
      channel_extra    JSONB DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // 恢复数据
  await conn.query(`
    INSERT INTO ad_set (campaign_id, channel_adset_id, name, status,
                        optimization_goal, billing_event, targeting)
    SELECT g.campaign_id, g.channel_adgroup_id, g.name, g.status,
           g.optimization_goal, g.billing_event, g.targeting
      FROM _ad_group_bak g
  `);

  await conn.query(`
    INSERT INTO ad (adset_id, channel_ad_id, name, status, effective_status, creative_id)
    SELECT s.id, a.channel_ad_id, a.name, a.status, a.effective_status, a.creative_id
      FROM _ad_bak a
      LEFT JOIN _ad_group_bak g ON g.id = a.adgroup_id
      LEFT JOIN ad_set s ON s.channel_adset_id = g.channel_adgroup_id
  `);

  console.log('[migrate] ad_group → ad_set 迁移完成');
}

export async function ensureAdTables(conn: Queryable): Promise<void> {
  await migrateAdGroupToAdSet(conn);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_campaign (
      id                    SERIAL PRIMARY KEY,
      channel               VARCHAR NOT NULL,
      channel_account_id    VARCHAR,
      channel_campaign_id   VARCHAR UNIQUE,
      name                VARCHAR NOT NULL,
      objective           VARCHAR,
      status              VARCHAR NOT NULL DEFAULT 'PAUSED',
      daily_budget        INTEGER,
      operator_code       VARCHAR,
      app_product         VARCHAR,
      creator          VARCHAR,
      channel_extra       JSONB DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_set (
      id                 SERIAL PRIMARY KEY,
      channel            VARCHAR NOT NULL DEFAULT 'fb',
      campaign_id        INTEGER NOT NULL REFERENCES ad_campaign(id),
      channel_adset_id   VARCHAR UNIQUE,
      name               VARCHAR NOT NULL,
      status             VARCHAR NOT NULL DEFAULT 'PAUSED',
      optimization_goal  VARCHAR,
      billing_event      VARCHAR,
      targeting          JSONB DEFAULT '{}',
      creator         VARCHAR,
      channel_extra      JSONB DEFAULT '{}',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_creative (
      id                  SERIAL PRIMARY KEY,
      channel             VARCHAR NOT NULL,
      channel_creative_id VARCHAR,
      channel_material_id VARCHAR NOT NULL,
      page_id             VARCHAR,
      ig_account_id       VARCHAR,
      cta_type            VARCHAR,
      titles              JSONB DEFAULT '[]',
      bodies              JSONB DEFAULT '[]',
      channel_extra       JSONB DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad (
      id               SERIAL PRIMARY KEY,
      channel          VARCHAR NOT NULL DEFAULT 'fb',
      adset_id         INTEGER NOT NULL REFERENCES ad_set(id),
      ad_campaign_id   INTEGER REFERENCES ad_campaign(id),
      creative_id      INTEGER REFERENCES ad_creative(id),
      channel_ad_id    VARCHAR UNIQUE,
      name             VARCHAR NOT NULL,
      status           VARCHAR NOT NULL DEFAULT 'PAUSED',
      effective_status VARCHAR,
      creator       VARCHAR,
      channel_extra    JSONB DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_material (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR NOT NULL,
      file_url        VARCHAR,
      source_type     VARCHAR NOT NULL DEFAULT 'file',
      partner_post_id VARCHAR,
      partner_page_id VARCHAR,
      mime_type       VARCHAR,
      duration_ms     INTEGER,
      file_size       BIGINT,
      app_product     VARCHAR,
      tags            JSONB DEFAULT '[]',
      creator      VARCHAR,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_material_upload (
      id                    SERIAL PRIMARY KEY,
      material_id           INTEGER NOT NULL REFERENCES ad_material(id),
      channel               VARCHAR NOT NULL,
      channel_material_id   VARCHAR,
      channel_thumbnail_url VARCHAR,
      status                VARCHAR NOT NULL DEFAULT 'uploading',
      channel_extra         JSONB DEFAULT '{}',
      uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(
    `CREATE INDEX IF NOT EXISTS idx_ad_material_upload_material ON ad_material_upload(material_id)`,
  );
  await conn.query(
    `CREATE INDEX IF NOT EXISTS idx_ad_material_upload_channel ON ad_material_upload(channel)`,
  );
  // 增量迁移：补 channel_account_id 列（区分不同广告账户的 Campaign）
  await conn.query(`ALTER TABLE ad_campaign ADD COLUMN IF NOT EXISTS channel_account_id VARCHAR`);
  // 旧数据回填：当前所有数据都属于同一个账户（act_646387524897026）
  await conn.query(
    `UPDATE ad_campaign SET channel_account_id = 'act_646387524897026' WHERE channel_account_id IS NULL`,
  );
  // PostgreSQL 不支持 ADD CONSTRAINT IF NOT EXISTS；按列检查，兼容新表的自动约束名。
  await conn.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ad_campaign'::regclass
          AND contype = 'u'
          AND conkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = 'ad_campaign'::regclass AND attname = 'channel_campaign_id'
          )]::smallint[]
      ) THEN
        ALTER TABLE ad_campaign
          ADD CONSTRAINT uq_ad_campaign_channel_id UNIQUE (channel_campaign_id);
      END IF;
    END $$
  `);
  await conn.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ad_set'::regclass
          AND contype = 'u'
          AND conkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = 'ad_set'::regclass AND attname = 'channel_adset_id'
          )]::smallint[]
      ) THEN
        ALTER TABLE ad_set
          ADD CONSTRAINT uq_ad_set_channel_id UNIQUE (channel_adset_id);
      END IF;
    END $$
  `);
  await conn.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ad'::regclass
          AND contype = 'u'
          AND conkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = 'ad'::regclass AND attname = 'channel_ad_id'
          )]::smallint[]
      ) THEN
        ALTER TABLE ad ADD CONSTRAINT uq_ad_channel_id UNIQUE (channel_ad_id);
      END IF;
    END $$
  `);

  // 投手信息表：存飞书登录后的邮箱与部门，权限校验用，独立于 fs_user（不污染旧表）。
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_operator_profile (
      open_id     TEXT PRIMARY KEY,
      email       TEXT,
      departments JSONB DEFAULT '[]',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // FB Token 管理表：存各套 token/app_id/app_secret 及所属 BM 信息。
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_fb_token (
      id           SERIAL PRIMARY KEY,
      token        TEXT NOT NULL,
      app_id       TEXT NOT NULL,
      app_secret   TEXT NOT NULL,
      bm_id        TEXT,
      bm_name      TEXT,
      name         TEXT,
      ad_accounts  JSONB DEFAULT '[]',
      available_pages JSONB DEFAULT '[]',
      is_active    BOOLEAN NOT NULL DEFAULT true,
      last_checked_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(
    `ALTER TABLE ad_fb_token ADD COLUMN IF NOT EXISTS available_pages JSONB DEFAULT '[]'`,
  );

  await conn.query(`
    CREATE TABLE IF NOT EXISTS ad_account_material (
      id                    SERIAL PRIMARY KEY,
      channel               VARCHAR NOT NULL DEFAULT 'fb',
      channel_account_id    VARCHAR NOT NULL,
      channel_material_id   VARCHAR NOT NULL,
      type                  VARCHAR NOT NULL,
      name                  VARCHAR,
      url                   TEXT,
      thumbnail_url         VARCHAR,
      status                VARCHAR,
      width                 INTEGER,
      height                INTEGER,
      length_ms             INTEGER,
      creator            VARCHAR,
      channel_extra         JSONB DEFAULT '{}',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await conn.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_account_material_channel ON ad_account_material(channel_material_id, channel_account_id)`,
  );

  // ── created_by → creator 列重命名（幂等：IF EXISTS 跳过已改完的表）──
  for (const tbl of ['ad_campaign', 'ad_set', 'ad', 'ad_material', 'ad_account_material']) {
    try {
      await conn.query(`ALTER TABLE ${tbl} RENAME COLUMN created_by TO creator`);
    } catch {
      /* 已存在或列不存在，跳过 */
    }
  }
  // ── 已存在表的列补充（幂等；新建表用）──
  await conn.query(`ALTER TABLE ad_campaign ADD COLUMN IF NOT EXISTS creator VARCHAR`);
  await conn.query(`ALTER TABLE ad_set ADD COLUMN IF NOT EXISTS creator VARCHAR`);
  await conn.query(`ALTER TABLE ad ADD COLUMN IF NOT EXISTS creator VARCHAR`);
  await conn.query(`ALTER TABLE ad_account_material ADD COLUMN IF NOT EXISTS creator VARCHAR`);
}
