import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type {
  Message,
  ModelHistoryEntry,
  ScheduleChannelBinding,
  ScheduleConfig,
  Session as SessionData,
  SessionSource,
  SessionStatus,
} from '@zero-os/shared'

export interface SessionRow {
  id: string
  source: SessionSource
  status: SessionStatus
  currentModel: string
  modelHistory: ModelHistoryEntry[]
  summary?: string
  tags: string[]
  channelName?: string
  channelId?: string
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
  model_history_json: string
  summary: string | null
  tags_json: string
  channel_name: string | null
  channel_id: string | null
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

interface RawChannelModelRow {
  source: string
  channel_name: string
  channel_id: string
  model: string
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
        model_history_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        channel_name TEXT,
        channel_id TEXT,
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
      CREATE TABLE IF NOT EXISTS channel_models (
        source TEXT NOT NULL,
        channel_name TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, channel_name, channel_id)
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

    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(source, channel_id)')
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_sessions_channel_instance ON sessions(source, channel_name, channel_id)',
    )
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)')
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
        one_shot INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT 'runtime',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  /**
   * Save or update a session's metadata.
   */
  saveSession(data: SessionData, agentConfigJson?: string, systemPrompt?: string): void {
    this.db.run(
      `INSERT OR REPLACE INTO sessions
       (id, source, status, current_model, model_history_json, summary, tags_json, channel_name, channel_id, agent_config_json, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.source,
        data.status,
        data.currentModel,
        JSON.stringify(data.modelHistory),
        data.summary ?? null,
        JSON.stringify(data.tags),
        data.channelName ?? null,
        data.channelId ?? null,
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

  saveChannelModel(
    source: SessionSource,
    channelId: string,
    model: string,
    channelName?: string,
  ): void {
    this.db.run(
      `INSERT OR REPLACE INTO channel_models (source, channel_name, channel_id, model, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [source, channelName ?? '', channelId, model, new Date().toISOString()],
    )
  }

  getChannelModel(
    source: SessionSource,
    channelId: string,
    channelName?: string,
  ): string | undefined {
    const row = this.db
      .query(
        'SELECT model FROM channel_models WHERE source = ? AND channel_name = ? AND channel_id = ?',
      )
      .get(source, channelName ?? '', channelId) as { model: string } | null
    return row?.model ?? undefined
  }

  loadChannelModels(): Array<{
    source: SessionSource
    channelName?: string
    channelId: string
    model: string
  }> {
    const rows = this.db
      .query(
        'SELECT source, channel_name, channel_id, model, updated_at FROM channel_models ORDER BY updated_at DESC',
      )
      .all() as RawChannelModelRow[]

    return rows.map((row) => ({
      source: row.source as SessionSource,
      channelName: row.channel_name || undefined,
      channelId: row.channel_id,
      model: row.model,
    }))
  }

  /**
   * Update session status only.
   */
  updateStatus(sessionId: string, status: SessionStatus, updatedAt: string): void {
    this.db.run('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      updatedAt,
      sessionId,
    ])
  }

  /**
   * Load all active/idle sessions (for startup recovery).
   */
  loadActiveSessions(): SessionRow[] {
    const rows = this.db
      .query(`SELECT * FROM sessions WHERE status IN ('active', 'idle') ORDER BY updated_at DESC`)
      .all() as RawSessionRow[]
    return rows.map(toSessionRow)
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
   * Load all sessions with optional filtering.
   */
  loadAllSessions(filter?: {
    status?: SessionStatus
    limit?: number
    offset?: number
  }): SessionRow[] {
    let sql = 'SELECT * FROM sessions'
    const params: SQLQueryBindings[] = []

    if (filter?.status) {
      sql += ' WHERE status = ?'
      params.push(filter.status)
    }

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
   * Get channel mappings for active sessions (for startup recovery).
   */
  getChannelMappings(): Array<{
    id: string
    source: SessionSource
    channelName?: string
    channelId: string
  }> {
    const rows = this.db
      .query(
        `SELECT id, source, channel_name, channel_id FROM sessions WHERE channel_id IS NOT NULL AND status IN ('active', 'idle')`,
      )
      .all() as Array<{
      id: string
      source: string
      channel_name: string | null
      channel_id: string
    }>
    return rows.map((r) => ({
      id: r.id,
      source: r.source as SessionSource,
      channelName: r.channel_name ?? undefined,
      channelId: r.channel_id,
    }))
  }

  /**
   * Permanently delete a session and its messages.
   */
  deleteSession(sessionId: string): boolean {
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
        channel_source, channel_name, channel_id, one_shot, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          source: row.channel_source,
          channelName: row.channel_name,
          channelId: row.channel_id,
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
    status: row.status as SessionStatus,
    currentModel: row.current_model,
    modelHistory: JSON.parse(row.model_history_json) as ModelHistoryEntry[],
    summary: row.summary ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    channelName: row.channel_name ?? undefined,
    channelId: row.channel_id ?? undefined,
    agentConfigJson: row.agent_config_json ?? undefined,
    systemPrompt: row.system_prompt ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
