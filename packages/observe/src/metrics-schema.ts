import type { Database } from 'bun:sqlite'

export function initializeMetricsSchema(db: Database): void {
  configureMetricsConnection(db)
  db.run(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      event TEXT NOT NULL,
      success INTEGER DEFAULT 1,
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      status TEXT NOT NULL,
      diagnosis TEXT,
      action TEXT,
      result TEXT,
      created_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      category TEXT NOT NULL,
      purpose TEXT NOT NULL,
      parent_session_id TEXT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      overall_score INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence TEXT NOT NULL,
      summary TEXT,
      dimensions_json TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      signals_json TEXT,
      generated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_requests_session_created ON requests(session_id, created_at)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_operations_tool ON operations(tool)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_operations_session ON operations(session_id)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_repairs_created ON repairs(created_at)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_session ON usage_ledger(session_id)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_purpose ON usage_ledger(purpose)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_created ON usage_ledger(created_at)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_parent ON usage_ledger(parent_session_id)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_evaluations_session ON evaluations(session_id)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_evaluations_created ON evaluations(created_at)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_evaluations_verdict ON evaluations(verdict)
  `)

  ensureUsageLedgerColumns(db)
  migrateLegacyRequestsToUsageLedger(db)
}

function configureMetricsConnection(db: Database): void {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
}

function ensureUsageLedgerColumns(db: Database): void {
  try {
    db.run('ALTER TABLE usage_ledger ADD COLUMN reasoning_tokens INTEGER DEFAULT 0')
  } catch {
    // Column already exists on upgraded installations.
  }
}

export function migrateLegacyRequestsToUsageLedger(db: Database): void {
  const boundary = db
    .query(
      `SELECT MIN(created_at) as firstCreatedAt
       FROM usage_ledger
       WHERE purpose = 'agent_loop'`,
    )
    .get() as { firstCreatedAt: string | null } | null

  const firstUsageCreatedAt = boundary?.firstCreatedAt ?? null
  // The initial rollout mirrored fresh agent_loop traffic into usage_ledger with
  // new local IDs, so migration can't de-duplicate by request ID alone. The
  // equality branch keeps same-timestamp legacy rows from being skipped while
  // still avoiding duplicate inserts for rows that were already mirrored.
  const whereClause = firstUsageCreatedAt
    ? `WHERE r.created_at < ?
         OR (
           r.created_at = ?
           AND NOT EXISTS (
             SELECT 1
             FROM usage_ledger u
             WHERE u.purpose = 'agent_loop'
               AND u.session_id = r.session_id
               AND u.parent_session_id IS NULL
               AND u.model = r.model
               AND u.provider = r.provider
               AND u.input_tokens = r.input_tokens
               AND u.output_tokens = r.output_tokens
               AND u.cache_write_tokens = r.cache_write_tokens
               AND u.cache_read_tokens = r.cache_read_tokens
               AND u.reasoning_tokens = 0
               AND ABS(u.cost - r.cost) < 0.0000001
               AND u.duration_ms = r.duration_ms
               AND u.created_at = r.created_at
           )
         )`
    : ''

  db.run(
    `INSERT OR IGNORE INTO usage_ledger (
       id, session_id, category, purpose, parent_session_id, model, provider,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       reasoning_tokens, cost, duration_ms, metadata, created_at
     )
     SELECT
       'migrated_' || r.id,
       r.session_id,
       'completion',
       'agent_loop',
       NULL,
       r.model,
       r.provider,
       r.input_tokens,
       r.output_tokens,
       r.cache_write_tokens,
       r.cache_read_tokens,
       0,
       r.cost,
       r.duration_ms,
       NULL,
       r.created_at
     FROM requests r
     ${whereClause}`,
    firstUsageCreatedAt ? [firstUsageCreatedAt, firstUsageCreatedAt] : [],
  )
}
