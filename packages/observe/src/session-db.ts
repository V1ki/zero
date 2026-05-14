import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type {
  ChannelSessionBinding,
  Message,
  ModelHistoryEntry,
  ReasoningEffort,
  ScheduleChannelBinding,
  ScheduleConfig,
  Session as SessionData,
  SessionSource,
  TimelineCompactionBlock,
} from '@zero-os/shared'
import { normalizeReasoningEffort } from '@zero-os/shared'

export interface SessionRow {
  id: string
  source: SessionSource
  currentModel: string
  reasoningEffort?: ReasoningEffort
  modelHistory: ModelHistoryEntry[]
  summary?: string
  tags: string[]
  channelName?: string
  channelId?: string
  participantId?: string
  agentConfigJson?: string
  systemPrompt?: string
  createdAt: string
  updatedAt: string
}

interface RawSessionRow {
  id: string
  source: string
  status: string
  current_model: string
  reasoning_effort: string | null
  model_history_json: string
  summary: string | null
  tags_json: string
  channel_name: string | null
  channel_id: string | null
  participant_id: string | null
  agent_config_json: string | null
  system_prompt: string | null
  created_at: string
  updated_at: string
}

interface RawMessagesRow {
  session_id: string
  messages_json: string
  message_count: number
  updated_at: string
}

interface RawCompactionBlocksRow {
  session_id: string
  blocks_json: string
  block_count: number
  updated_at: string
}

interface RawChannelModelRow {
  source: string
  channel_name: string
  channel_id: string
  participant_id: string
  model: string
  updated_at: string
}

interface RawBindingRow {
  source: string
  channel_name: string
  channel_id: string
  participant_id: string
  session_id: string
  updated_at: string
}

/**
 * SQLite-based session persistence for ZeRo OS.
 * Stores session metadata and conversation messages.
 */
export class SessionDB {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.configureConnection()
    this.initSchema()
  }

  static createInMemory(): SessionDB {
    return new SessionDB(':memory:')
  }

  private configureConnection(): void {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  }

  private initSchema(): void {
    this.db.run(`
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_compaction_blocks (
        session_id TEXT PRIMARY KEY,
        blocks_json TEXT NOT NULL DEFAULT '[]',
        block_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `)

    this.db.run(`
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

    this.db.run(`
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

    // Migration: add system_prompt column
    try {
      this.db.run('ALTER TABLE sessions ADD COLUMN system_prompt TEXT')
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE sessions ADD COLUMN channel_name TEXT')
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE sessions ADD COLUMN participant_id TEXT')
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT')
    } catch {
      // Column already exists
    }

    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)')
    this.migrateParticipantScopedTables()

    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(source, channel_id)')
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_sessions_channel_instance ON sessions(source, channel_name, channel_id, participant_id)',
    )
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)')
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_channel_session_bindings_session ON channel_session_bindings(session_id)',
    )
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_channel_session_bindings_updated ON channel_session_bindings(updated_at)',
    )
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_channel_models_updated ON channel_models(updated_at)',
    )

    this.db.run(`
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

    try {
      this.db.run('ALTER TABLE schedules ADD COLUMN channel_participant_id TEXT')
    } catch {
      // Column already exists
    }

    try {
      this.db.run('ALTER TABLE schedules ADD COLUMN delivery_channel_id TEXT')
    } catch {
      // Column already exists
    }

    this.backfillLegacyBindings()
  }

  private migrateParticipantScopedTables(): void {
    this.ensureParticipantPrimaryKey('channel_models', [
      'source TEXT NOT NULL',
      "channel_name TEXT NOT NULL DEFAULT ''",
      'channel_id TEXT NOT NULL',
      "participant_id TEXT NOT NULL DEFAULT ''",
      'model TEXT NOT NULL',
      'updated_at TEXT NOT NULL',
      'PRIMARY KEY (source, channel_name, channel_id, participant_id)',
    ])

    this.ensureParticipantPrimaryKey('channel_session_bindings', [
      'source TEXT NOT NULL',
      "channel_name TEXT NOT NULL DEFAULT ''",
      'channel_id TEXT NOT NULL',
      "participant_id TEXT NOT NULL DEFAULT ''",
      'session_id TEXT NOT NULL',
      'updated_at TEXT NOT NULL',
      'PRIMARY KEY (source, channel_name, channel_id, participant_id)',
    ])
  }

  private ensureParticipantPrimaryKey(
    table: 'channel_models' | 'channel_session_bindings',
    columns: string[],
  ): void {
    const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
      pk: number
    }>
    const participantColumn = tableInfo.find((column) => column.name === 'participant_id')
    if (participantColumn && participantColumn.pk > 0) return

    const tempTable = `${table}_participant_migration`
    this.db.run(`DROP TABLE IF EXISTS ${tempTable}`)
    this.db.run(`CREATE TABLE ${tempTable} (${columns.join(', ')})`)

    const participantExpr = participantColumn ? "COALESCE(participant_id, '')" : "''"

    if (table === 'channel_models') {
      this.db.run(`
        INSERT OR REPLACE INTO ${tempTable}
          (source, channel_name, channel_id, participant_id, model, updated_at)
        SELECT source, channel_name, channel_id, ${participantExpr}, model, updated_at
        FROM ${table}
      `)
    } else {
      this.db.run(`
        INSERT OR REPLACE INTO ${tempTable}
          (source, channel_name, channel_id, participant_id, session_id, updated_at)
        SELECT source, channel_name, channel_id, ${participantExpr}, session_id, updated_at
        FROM ${table}
      `)
    }

    this.db.run(`DROP TABLE ${table}`)
    this.db.run(`ALTER TABLE ${tempTable} RENAME TO ${table}`)
  }

  private backfillLegacyBindings(): void {
    const existingBindings = this.db
      .query('SELECT COUNT(*) AS count FROM channel_session_bindings')
      .get() as { count: number } | null
    if ((existingBindings?.count ?? 0) > 0) {
      return
    }

    // Bootstrap v1 of the binding model from legacy status rows: only recoverable active/idle
    // sessions participate, duplicates collapse to the newest row, and web is normalized to the
    // singleton (web, web, default) binding.
    this.db.run(`
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

  /**
   * Save or update a session's metadata.
   */
  saveSession(data: SessionData, agentConfigJson?: string, systemPrompt?: string): void {
    this.db.run(
      `INSERT INTO sessions
       (id, source, current_model, reasoning_effort, model_history_json, summary, tags_json, channel_name, channel_id, participant_id, agent_config_json, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source = excluded.source,
         current_model = excluded.current_model,
         reasoning_effort = excluded.reasoning_effort,
         model_history_json = excluded.model_history_json,
         summary = excluded.summary,
         tags_json = excluded.tags_json,
         channel_name = excluded.channel_name,
         channel_id = excluded.channel_id,
         participant_id = excluded.participant_id,
         agent_config_json = excluded.agent_config_json,
         system_prompt = excluded.system_prompt,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [
        data.id,
        data.source,
        data.currentModel,
        data.reasoningEffort ?? null,
        JSON.stringify(data.modelHistory),
        data.summary ?? null,
        JSON.stringify(data.tags),
        data.channelName ?? null,
        data.channelId ?? null,
        data.participantId ?? null,
        agentConfigJson ?? null,
        systemPrompt ?? null,
        data.createdAt,
        data.updatedAt,
      ],
    )
  }

  /**
   * Save or update a session's messages (full replace).
   */
  saveMessages(sessionId: string, messages: Message[]): void {
    this.db.run(
      `INSERT OR REPLACE INTO session_messages (session_id, messages_json, message_count, updated_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, JSON.stringify(messages), messages.length, new Date().toISOString()],
    )
  }

  /**
   * Save or update a session's timeline compaction blocks without mutating canonical messages.
   */
  saveCompactionBlocks(sessionId: string, blocks: TimelineCompactionBlock[]): void {
    this.db.run(
      `INSERT OR REPLACE INTO session_compaction_blocks (session_id, blocks_json, block_count, updated_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, JSON.stringify(blocks), blocks.length, new Date().toISOString()],
    )
  }

  saveChannelModel(
    source: SessionSource,
    channelId: string,
    model: string,
    channelName?: string,
    participantId?: string,
  ): void {
    this.db.run(
      `INSERT OR REPLACE INTO channel_models (source, channel_name, channel_id, participant_id, model, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [source, channelName ?? '', channelId, participantId ?? '', model, new Date().toISOString()],
    )
  }

  getChannelModel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): string | undefined {
    const row = this.db
      .query(
        'SELECT model FROM channel_models WHERE source = ? AND channel_name = ? AND channel_id = ? AND participant_id = ?',
      )
      .get(source, channelName ?? '', channelId, participantId ?? '') as { model: string } | null
    return row?.model ?? undefined
  }

  loadChannelModels(): Array<{
    source: SessionSource
    channelName?: string
    channelId: string
    participantId?: string
    model: string
  }> {
    const rows = this.db
      .query(
        'SELECT source, channel_name, channel_id, participant_id, model, updated_at FROM channel_models ORDER BY updated_at DESC',
      )
      .all() as RawChannelModelRow[]

    return rows.map((row) => ({
      source: row.source as SessionSource,
      channelName: row.channel_name || undefined,
      channelId: row.channel_id,
      participantId: row.participant_id || undefined,
      model: row.model,
    }))
  }

  saveBinding(
    source: SessionSource,
    channelId: string,
    sessionId: string,
    channelName?: string,
    updatedAt = new Date().toISOString(),
    participantId?: string,
  ): void {
    this.db.run(
      `INSERT INTO channel_session_bindings (source, channel_name, channel_id, participant_id, session_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, channel_name, channel_id, participant_id) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
      [source, channelName ?? '', channelId, participantId ?? '', sessionId, updatedAt],
    )
  }

  loadBindings(): ChannelSessionBinding[] {
    const rows = this.db
      .query(
        `SELECT source, channel_name, channel_id, participant_id, session_id, updated_at
         FROM channel_session_bindings
         ORDER BY updated_at DESC`,
      )
      .all() as RawBindingRow[]
    return rows.map(toChannelSessionBinding)
  }

  getBinding(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): ChannelSessionBinding | null {
    const row = this.db
      .query(
        `SELECT source, channel_name, channel_id, participant_id, session_id, updated_at
         FROM channel_session_bindings
         WHERE source = ? AND channel_name = ? AND channel_id = ? AND participant_id = ?`,
      )
      .get(source, channelName ?? '', channelId, participantId ?? '') as RawBindingRow | null

    return row ? toChannelSessionBinding(row) : null
  }

  deleteBinding(
    source: SessionSource,
    channelId: string,
    channelName?: string,
    participantId?: string,
  ): boolean {
    const result = this.db.run(
      'DELETE FROM channel_session_bindings WHERE source = ? AND channel_name = ? AND channel_id = ? AND participant_id = ?',
      [source, channelName ?? '', channelId, participantId ?? ''],
    )
    return result.changes > 0
  }

  deleteBindingsForSession(sessionId: string): number {
    const result = this.db.run('DELETE FROM channel_session_bindings WHERE session_id = ?', [
      sessionId,
    ])
    return result.changes
  }

  /**
   * Load messages for a specific session.
   */
  loadSessionMessages(sessionId: string): Message[] {
    const row = this.db
      .query('SELECT messages_json FROM session_messages WHERE session_id = ?')
      .get(sessionId) as RawMessagesRow | null
    if (!row) return []
    return JSON.parse(row.messages_json) as Message[]
  }

  /**
   * Load persisted timeline compaction blocks for a session.
   */
  loadSessionCompactionBlocks(sessionId: string): TimelineCompactionBlock[] {
    const row = this.db
      .query('SELECT blocks_json FROM session_compaction_blocks WHERE session_id = ?')
      .get(sessionId) as RawCompactionBlocksRow | null
    if (!row) return []
    return JSON.parse(row.blocks_json) as TimelineCompactionBlock[]
  }

  /**
   * Load all sessions with optional filtering.
   */
  loadAllSessions(filter?: {
    limit?: number
    offset?: number
  }): SessionRow[] {
    let sql = 'SELECT * FROM sessions'
    const params: SQLQueryBindings[] = []

    sql += ' ORDER BY updated_at DESC'

    if (filter?.limit) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
    }
    if (filter?.offset) {
      sql += ' OFFSET ?'
      params.push(filter.offset)
    }

    const rows = this.db.query(sql).all(...params) as RawSessionRow[]
    return rows.map(toSessionRow)
  }

  /**
   * Get a single session by ID.
   */
  getSession(sessionId: string): SessionRow | null {
    const row = this.db
      .query('SELECT * FROM sessions WHERE id = ?')
      .get(sessionId) as RawSessionRow | null
    if (!row) return null
    return toSessionRow(row)
  }

  /**
   * Permanently delete a session and its messages.
   */
  deleteSession(sessionId: string): boolean {
    this.deleteBindingsForSession(sessionId)
    this.db.run('DELETE FROM session_compaction_blocks WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM session_messages WHERE session_id = ?', [sessionId])
    const result = this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
    return result.changes > 0
  }

  // ── Schedule persistence ──

  saveSchedule(config: ScheduleConfig): void {
    const ts = new Date().toISOString()
    this.db.run(
      `INSERT OR REPLACE INTO schedules
       (name, cron, instruction, model, overlap_policy, misfire_policy,
        channel_source, channel_name, channel_id, channel_participant_id, delivery_channel_id,
        one_shot, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.name,
        config.cron,
        config.instruction,
        config.model ?? null,
        config.overlapPolicy ? JSON.stringify(config.overlapPolicy) : null,
        config.misfirePolicy ?? null,
        config.channel?.source ?? null,
        config.channel?.channelName ?? null,
        config.channel?.channelId ?? null,
        config.channel?.participantId ?? null,
        config.channel?.deliveryChannelId ?? null,
        config.oneShot ? 1 : 0,
        config.createdBy ?? 'runtime',
        ts,
        ts,
      ],
    )
  }

  deleteSchedule(name: string): boolean {
    const result = this.db.run('DELETE FROM schedules WHERE name = ?', [name])
    return result.changes > 0
  }

  loadRuntimeSchedules(): ScheduleConfig[] {
    const rows = this.db
      .query(`SELECT * FROM schedules WHERE created_by = 'runtime'`)
      .all() as Array<Record<string, unknown>>

    return rows.map((row) => {
      const config: ScheduleConfig = {
        name: row.name as string,
        cron: row.cron as string,
        instruction: row.instruction as string,
        createdBy: 'runtime',
      }
      if (row.model) config.model = row.model as string
      if (row.overlap_policy) {
        config.overlapPolicy = JSON.parse(row.overlap_policy as string)
      }
      if (row.misfire_policy) config.misfirePolicy = row.misfire_policy as 'skip' | 'run_once'
      if (row.one_shot) config.oneShot = true
      if (row.channel_source && row.channel_name && row.channel_id) {
        config.channel = {
          source: row.channel_source as SessionSource,
          channelName: row.channel_name as string,
          channelId: row.channel_id as string,
          participantId: row.channel_participant_id
            ? (row.channel_participant_id as string)
            : undefined,
          deliveryChannelId: row.delivery_channel_id
            ? (row.delivery_channel_id as string)
            : undefined,
        } as ScheduleChannelBinding
      }
      return config
    })
  }

  close(): void {
    this.db.close()
  }
}

function toSessionRow(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    source: row.source as SessionSource,
    currentModel: row.current_model,
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    modelHistory: JSON.parse(row.model_history_json) as ModelHistoryEntry[],
    summary: row.summary ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    channelName: row.channel_name ?? undefined,
    channelId: row.channel_id ?? undefined,
    participantId: row.participant_id ?? undefined,
    agentConfigJson: row.agent_config_json ?? undefined,
    systemPrompt: row.system_prompt ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toChannelSessionBinding(row: RawBindingRow): ChannelSessionBinding {
  return {
    source: row.source as SessionSource,
    channelName: row.channel_name || undefined,
    channelId: row.channel_id,
    participantId: row.participant_id || undefined,
    sessionId: row.session_id,
    updatedAt: row.updated_at,
  }
}
