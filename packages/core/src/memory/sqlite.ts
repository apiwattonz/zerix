import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { ContextChunk, MemoryTier } from '../types/index.js'
import type { MemoryTierStore, TierStats } from './types.js'

interface ChunkRow {
  id: string
  content: string
  tokens: number
  type: ContextChunk['type']
  score: number
  tier: MemoryTier
  created_at: number
  accessed_at: number
  access_count: number
  ttl: number | null
  metadata: string
}

/**
 * SQLite-backed memory tier implementation for L2 RAM.
 */
export class SQLiteTier implements MemoryTierStore {
  private readonly db: Database.Database

  public constructor(
    private readonly tier: MemoryTier,
    private readonly maxTokens: number,
    dbPath = '.zerix/memory.db'
  ) {
    const resolvedPath = path.resolve(dbPath)
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })

    this.db = new Database(resolvedPath)
    this.db.pragma('journal_mode = WAL')
    this.initializeSchema()
  }

  public read(): ContextChunk[] {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE tier = ? ORDER BY created_at ASC')
    const rows = stmt.all(this.tier) as ChunkRow[]
    return rows.map((row) => this.rowToChunk(row))
  }

  public write(chunk: ContextChunk): void {
    const ok = this.tryWrite(chunk)
    if (!ok) {
      throw new Error(
        `Cannot write chunk ${chunk.id} to ${this.tier}: token budget exceeded (${this.totalTokens()} + ${chunk.tokens} > ${this.maxTokens})`
      )
    }
  }

  public tryWrite(chunk: ContextChunk): boolean {
    const existing = this.getById(chunk.id)
    const existingTokens = existing?.tokens ?? 0
    const nextTotal = this.totalTokens() - existingTokens + chunk.tokens
    if (nextTotal > this.maxTokens) {
      return false
    }

    const stmt = this.db.prepare(
      `INSERT INTO chunks (
         id, content, tokens, type, score, tier, created_at, accessed_at, access_count, ttl, metadata
       ) VALUES (
         @id, @content, @tokens, @type, @score, @tier, @created_at, @accessed_at, @access_count, @ttl, @metadata
       )
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         tokens = excluded.tokens,
         type = excluded.type,
         score = excluded.score,
         tier = excluded.tier,
         created_at = excluded.created_at,
         accessed_at = excluded.accessed_at,
         access_count = excluded.access_count,
         ttl = excluded.ttl,
         metadata = excluded.metadata`
    )

    stmt.run({
      id: chunk.id,
      content: chunk.content,
      tokens: chunk.tokens,
      type: chunk.type,
      score: chunk.score,
      tier: this.tier,
      created_at: chunk.createdAt,
      accessed_at: chunk.accessedAt,
      access_count: chunk.accessCount,
      ttl: chunk.ttl,
      metadata: JSON.stringify(chunk.metadata ?? {})
    })

    return true
  }

  public search(query: string, limit = 10): ContextChunk[] {
    const normalized = query.trim()
    if (!normalized) {
      return []
    }

    const stmt = this.db.prepare(
      'SELECT * FROM chunks WHERE tier = ? AND content LIKE ? ORDER BY score DESC, created_at DESC LIMIT ?'
    )

    const rows = stmt.all(this.tier, `%${normalized}%`, Math.max(0, limit)) as ChunkRow[]

    return rows.map((row) => this.rowToChunk(row))
  }

  public delete(chunkId: string): boolean {
    const stmt = this.db.prepare<[string, MemoryTier]>('DELETE FROM chunks WHERE id = ? AND tier = ?')
    const result = stmt.run(chunkId, this.tier)
    return result.changes > 0
  }

  public clear(): void {
    const stmt = this.db.prepare('DELETE FROM chunks WHERE tier = ?')
    stmt.run(this.tier)
  }

  public stats(): TierStats {
    const totalTokens = this.totalTokens()
    const countStmt = this.db.prepare('SELECT COUNT(1) as count FROM chunks WHERE tier = ?')
    const countRow = countStmt.get(this.tier) as { count: number } | undefined
    const count = countRow?.count ?? 0

    return {
      chunkCount: count,
      totalTokens,
      maxTokens: this.maxTokens,
      utilization: this.maxTokens > 0 ? totalTokens / this.maxTokens : 0
    }
  }

  public close(): void {
    this.db.close()
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        type TEXT NOT NULL,
        score REAL DEFAULT 0,
        tier TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        access_count INTEGER DEFAULT 0,
        ttl INTEGER,
        metadata TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_tier ON chunks(tier);
      CREATE INDEX IF NOT EXISTS idx_score ON chunks(score);
      CREATE INDEX IF NOT EXISTS idx_type ON chunks(type);
    `)
  }

  private getById(id: string): ContextChunk | null {
    const stmt = this.db.prepare<[string], ChunkRow>('SELECT * FROM chunks WHERE id = ? LIMIT 1')
    const row = stmt.get(id)
    return row ? this.rowToChunk(row) : null
  }

  private totalTokens(): number {
    const stmt = this.db.prepare('SELECT SUM(tokens) as total FROM chunks WHERE tier = ?')
    const row = stmt.get(this.tier) as { total: number | null } | undefined
    return row?.total ?? 0
  }

  private rowToChunk(row: ChunkRow): ContextChunk {
    let metadata: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.metadata)
      if (parsed && typeof parsed === 'object') {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      metadata = {}
    }

    return {
      id: row.id,
      content: row.content,
      tokens: row.tokens,
      type: row.type,
      score: row.score,
      tier: row.tier,
      createdAt: row.created_at,
      accessedAt: row.accessed_at,
      accessCount: row.access_count,
      ttl: row.ttl,
      metadata
    }
  }
}
