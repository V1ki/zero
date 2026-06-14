import type { Database } from 'bun:sqlite'

type ParticipantScopedTable = 'channel_models' | 'channel_session_bindings'

export function initializeSessionDbSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_model TEXT NOT NULL,
      reasoning_effort TEXT,
      model_history_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      channel_name TEXT,
      channel_id TEXT,
      participant_id TEXT,
      agent_config_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS session_messages (
      session_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS session_compaction_blocks (
      session_id TEXT PRIMARY KEY,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      block_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS channel_models (
      source TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL,
      participant_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, channel_name, channel_id, participant_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS channel_session_bindings (
      source TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL,
      participant_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, channel_name, channel_id, participant_id)
    )
  `)

  addColumnIfMissing(db, 'sessions', 'system_prompt TEXT')
  addColumnIfMissing(db, 'sessions', 'channel_name TEXT')
  addColumnIfMissing(db, 'sessions', 'participant_id TEXT')
  addColumnIfMissing(db, 'sessions', 'reasoning_effort TEXT')

  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)')
  migrateParticipantScopedTables(db)

  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(source, channel_id)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_sessions_channel_instance ON sessions(source, channel_name, channel_id, participant_id)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_channel_session_bindings_session ON channel_session_bindings(session_id)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_channel_session_bindings_updated ON channel_session_bindings(updated_at)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_channel_models_updated ON channel_models(updated_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      name TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      instruction TEXT NOT NULL,
      model TEXT,
      overlap_policy TEXT,
      misfire_policy TEXT,
      channel_source TEXT,
      channel_name TEXT,
      channel_id TEXT,
      channel_participant_id TEXT,
      delivery_channel_id TEXT,
      one_shot INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'runtime',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  addColumnIfMissing(db, 'schedules', 'channel_participant_id TEXT')
  addColumnIfMissing(db, 'schedules', 'delivery_channel_id TEXT')

  backfillLegacyBindings(db)
}

export function backfillLegacyBindings(db: Database): void {
  const existingBindings = db
    .query('SELECT COUNT(*) AS count FROM channel_session_bindings')
    .get() as { count: number } | null
  if ((existingBindings?.count ?? 0) > 0) {
    return
  }

  // Bootstrap v1 of the binding model from legacy status rows: only recoverable active/idle
  // sessions participate, duplicates collapse to the newest row, and web is normalized to the
  // singleton (web, web, default) binding.
  db.run(`
    WITH ranked AS (
      SELECT
        source,
        CASE WHEN source = 'web' THEN 'web' ELSE COALESCE(channel_name, '') END AS bind_channel_name,
        COALESCE(channel_id, CASE WHEN source = 'web' THEN 'default' END) AS bind_channel_id,
        id AS session_id,
        updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY
            source,
            CASE WHEN source = 'web' THEN 'web' ELSE COALESCE(channel_name, '') END,
            COALESCE(channel_id, CASE WHEN source = 'web' THEN 'default' END)
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM sessions
      WHERE status IN ('active', 'idle')
        AND (channel_id IS NOT NULL OR source = 'web')
    )
    INSERT INTO channel_session_bindings (source, channel_name, channel_id, participant_id, session_id, updated_at)
    SELECT source, bind_channel_name, bind_channel_id, '', session_id, updated_at
    FROM ranked
    WHERE rn = 1 AND bind_channel_id IS NOT NULL
  `)
}

function migrateParticipantScopedTables(db: Database): void {
  ensureParticipantPrimaryKey(db, 'channel_models', [
    'source TEXT NOT NULL',
    "channel_name TEXT NOT NULL DEFAULT ''",
    'channel_id TEXT NOT NULL',
    "participant_id TEXT NOT NULL DEFAULT ''",
    'model TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
    'PRIMARY KEY (source, channel_name, channel_id, participant_id)',
  ])

  ensureParticipantPrimaryKey(db, 'channel_session_bindings', [
    'source TEXT NOT NULL',
    "channel_name TEXT NOT NULL DEFAULT ''",
    'channel_id TEXT NOT NULL',
    "participant_id TEXT NOT NULL DEFAULT ''",
    'session_id TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
    'PRIMARY KEY (source, channel_name, channel_id, participant_id)',
  ])
}

function ensureParticipantPrimaryKey(
  db: Database,
  table: ParticipantScopedTable,
  columns: string[],
): void {
  const tableInfo = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    pk: number
  }>
  const participantColumn = tableInfo.find((column) => column.name === 'participant_id')
  if (participantColumn && participantColumn.pk > 0) return

  const tempTable = `${table}_participant_migration`
  db.run(`DROP TABLE IF EXISTS ${tempTable}`)
  db.run(`CREATE TABLE ${tempTable} (${columns.join(', ')})`)

  const participantExpr = participantColumn ? "COALESCE(participant_id, '')" : "''"

  if (table === 'channel_models') {
    db.run(`
      INSERT OR REPLACE INTO ${tempTable}
        (source, channel_name, channel_id, participant_id, model, updated_at)
      SELECT source, channel_name, channel_id, ${participantExpr}, model, updated_at
      FROM ${table}
    `)
  } else {
    db.run(`
      INSERT OR REPLACE INTO ${tempTable}
        (source, channel_name, channel_id, participant_id, session_id, updated_at)
      SELECT source, channel_name, channel_id, ${participantExpr}, session_id, updated_at
      FROM ${table}
    `)
  }

  db.run(`DROP TABLE ${table}`)
  db.run(`ALTER TABLE ${tempTable} RENAME TO ${table}`)
}

function addColumnIfMissing(db: Database, table: string, columnDefinition: string): void {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`)
  } catch {
    // Column already exists.
  }
}
