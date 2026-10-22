import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import type { HistoryRecord, HistoryStats, StyleSample } from '../shared/types'

/**
 * M2 历史与词典存储：better-sqlite3（原创 schema）
 * - history: 听写记录
 * - dict_words: 个人词典（manual 手动 / auto 自动学习）
 * - style_samples: 风格学习的修改记录（D-041）
 * - meta: 迁移标记等
 * 首次运行自动迁移 M1 的 history.jsonl。
 */

const DB_FILE = 'mytypeless.db'
const LEGACY_JSONL = 'history.jsonl'

let db: Database.Database | null = null

function dbPath(): string {
  return join(app.getPath('userData'), DB_FILE)
}

/** 共享数据库连接（会议存储 `meeting/store.ts` 使用） */
export function database(): Database.Database {
  return open()
}

function open(): Database.Database {
  if (db) return db
  mkdirSync(app.getPath('userData'), { recursive: true })
  db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      raw_text TEXT NOT NULL DEFAULT '',
      polished_text TEXT NOT NULL DEFAULT '',
      app_name TEXT,
      app_bundle_id TEXT,
      mode TEXT NOT NULL DEFAULT 'dictation',
      status TEXT NOT NULL DEFAULT 'completed',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_history_mode_status ON history(mode, status);

    CREATE TABLE IF NOT EXISTS dict_words (
      word TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learn_counts (
      term TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dict_blocked (
      word TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- 会议模式（D-015、D-016）：只存文字、说话人与声音特征向量，不存录音
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      expected_speakers INTEGER,
      minutes TEXT,
      minutes_error TEXT,
      audio_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);

    CREATE TABLE IF NOT EXISTS meeting_speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      label INTEGER NOT NULL,
      name TEXT,
      voiceprint_id INTEGER,
      centroid BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_speakers ON meeting_speakers(meeting_id);

    CREATE TABLE IF NOT EXISTS meeting_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      speaker_id INTEGER,
      start_sample INTEGER NOT NULL,
      end_sample INTEGER NOT NULL,
      text TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_segments ON meeting_segments(meeting_id, start_sample);

    -- 风格学习（D-041）：写入的结果 → 用户改后的样子；只在本机，最多 STYLE_SAMPLES_MAX 条，可查看、删除
    CREATE TABLE IF NOT EXISTS style_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      app_name TEXT,
      before_text TEXT NOT NULL,
      after_text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voiceprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vector BLOB NOT NULL,
      samples INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  migrateColumns()
  migrateLegacyJsonl()
  return db
}

/** 增量补列（老库升级） */
function migrateColumns(): void {
  const d = db!
  const cols = new Set((d.prepare(`PRAGMA table_info(history)`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!cols.has('source_text')) d.exec(`ALTER TABLE history ADD COLUMN source_text TEXT`)
  // 会议逐句声纹（D-020）：会后按人数重新区分说话人；随会议删除
  const segCols = new Set((d.prepare(`PRAGMA table_info(meeting_segments)`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!segCols.has('embedding')) d.exec(`ALTER TABLE meeting_segments ADD COLUMN embedding BLOB`)
  // 声纹模型标识（D-026）：不同模型的声纹不能互相比较。旧库里的会议都是旧模型（CAM++）算的，标为 NULL；
  // 旧模型保存的声纹已无法认人，补列时一并删除（用户确认不保留），会议里对它们的引用清空
  const meetingCols = new Set((d.prepare(`PRAGMA table_info(meetings)`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!meetingCols.has('embed_model')) d.exec(`ALTER TABLE meetings ADD COLUMN embed_model TEXT`)
  // 线上会议的应用声音（D-033）：声音来源、应用声音的临时录音、线上人数；说话人与句子记下来自哪一路（0 = 麦克风 / 现场，1 = 应用 / 线上）
  if (!meetingCols.has('source')) d.exec(`ALTER TABLE meetings ADD COLUMN source TEXT NOT NULL DEFAULT 'mic'`)
  if (!meetingCols.has('app_audio_path')) d.exec(`ALTER TABLE meetings ADD COLUMN app_audio_path TEXT`)
  if (!meetingCols.has('app_name')) d.exec(`ALTER TABLE meetings ADD COLUMN app_name TEXT`)
  if (!meetingCols.has('expected_remote')) d.exec(`ALTER TABLE meetings ADD COLUMN expected_remote INTEGER`)
  // 保存下来的会议录音（D-044）：用户选的文件夹里的 WAV，删除会议时不删
  if (!meetingCols.has('saved_audio_path')) d.exec(`ALTER TABLE meetings ADD COLUMN saved_audio_path TEXT`)
  if (!segCols.has('track')) d.exec(`ALTER TABLE meeting_segments ADD COLUMN track INTEGER NOT NULL DEFAULT 0`)
  const speakerCols = new Set((d.prepare(`PRAGMA table_info(meeting_speakers)`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!speakerCols.has('track')) d.exec(`ALTER TABLE meeting_speakers ADD COLUMN track INTEGER NOT NULL DEFAULT 0`)
  // 名字是声纹自动认出的（D-042）：整体归类后会复核，分数掉下去就撤掉；用户改过名的为 0（已有的名字都当作用户确认过）
  if (!speakerCols.has('auto_named')) d.exec(`ALTER TABLE meeting_speakers ADD COLUMN auto_named INTEGER NOT NULL DEFAULT 0`)
  const printCols = new Set((d.prepare(`PRAGMA table_info(voiceprints)`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!printCols.has('model')) {
    d.exec(`ALTER TABLE voiceprints ADD COLUMN model TEXT`)
    d.exec(`DELETE FROM voiceprints WHERE model IS NULL`)
    d.exec(`UPDATE meeting_speakers SET voiceprint_id = NULL WHERE voiceprint_id IS NOT NULL`)
  }
}

/** M1 JSONL → SQLite 一次性迁移 */
function migrateLegacyJsonl(): void {
  const d = db!
  const done = d.prepare(`SELECT value FROM meta WHERE key='jsonl_migrated'`).get() as { value: string } | undefined
  if (done) return
  const legacyPath = join(app.getPath('userData'), LEGACY_JSONL)
  if (existsSync(legacyPath)) {
    try {
      const records = readFileSync(legacyPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as HistoryRecord)
      const insert = d.prepare(`INSERT OR IGNORE INTO history
        (id, created_at, duration_ms, raw_text, polished_text, app_name, mode, status, error)
        VALUES (@id, @createdAt, @durationMs, @rawText, @polishedText, @appName, @mode, @status, @error)`)
      const tx = d.transaction((rows: HistoryRecord[]) => {
        for (const r of rows) {
          insert.run({
            id: r.id,
            createdAt: r.createdAt,
            durationMs: r.durationMs,
            rawText: r.rawText ?? '',
            polishedText: r.polishedText ?? '',
            appName: r.appName ?? null,
            mode: r.mode ?? 'dictation',
            status: r.status ?? 'completed',
            error: r.error ?? null
          })
        }
      })
      tx(records.reverse())
    } catch {
      /* 迁移失败不阻塞启动 */
    }
  }
  d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('jsonl_migrated', '1')`).run()
}

// ---------- history ----------

export function appendHistory(rec: HistoryRecord): void {
  const d = open()
  d.prepare(`INSERT OR REPLACE INTO history
    (id, created_at, duration_ms, raw_text, polished_text, app_name, app_bundle_id, mode, status, error, source_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    rec.id, rec.createdAt, rec.durationMs, rec.rawText, rec.polishedText,
    rec.appName ?? null, rec.appBundleId ?? null,
    rec.mode, rec.status, rec.error ?? null, rec.sourceText ?? null
  )
}

function rowToRecord(r: Record<string, unknown>): HistoryRecord {
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    durationMs: Number(r.duration_ms),
    rawText: String(r.raw_text ?? ''),
    polishedText: String(r.polished_text ?? ''),
    appName: (r.app_name as string) ?? undefined,
    appBundleId: (r.app_bundle_id as string) ?? undefined,
    mode: r.mode as HistoryRecord['mode'],
    status: r.status as HistoryRecord['status'],
    error: (r.error as string) ?? undefined,
    sourceText: (r.source_text as string) ?? undefined
  }
}

export function listHistory(limit = 100, offset = 0): HistoryRecord[] {
  const rows = open().prepare(`SELECT * FROM history ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
  return (rows as Array<Record<string, unknown>>).map(rowToRecord)
}

export function getHistory(id: string): HistoryRecord | undefined {
  const row = open().prepare(`SELECT * FROM history WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToRecord(row) : undefined
}

export function deleteHistory(id: string): void {
  open().prepare(`DELETE FROM history WHERE id = ?`).run(id)
}

export function clearHistory(): void {
  open().prepare(`DELETE FROM history`).run()
}

export function newRecord(partial: Omit<HistoryRecord, 'id' | 'createdAt'>): HistoryRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ...partial
  }
}

// ---------- dictionary ----------

/** 词典：手动添加的优先（识别提示词有长度上限，先保证手动词），各自按最近添加排序 */
export function listWords(): Array<{ word: string; source: string }> {
  return open()
    .prepare(`SELECT word, source FROM dict_words ORDER BY (source = 'manual') DESC, created_at DESC LIMIT 500`)
    .all() as Array<{ word: string; source: string }>
}

/**
 * 自动学习计数（D-012）：累计到阈值即收录为 auto 词条；已在词典或被用户删除过的词不处理。
 * @returns 本次是否新收录
 */
export function countLearned(term: string, kind: 'correction' | 'frequent', threshold: number): boolean {
  const d = open()
  const w = term.trim()
  if (!w) return false
  if (d.prepare(`SELECT 1 FROM dict_words WHERE word = ? COLLATE NOCASE`).get(w)) return false
  if (d.prepare(`SELECT 1 FROM dict_blocked WHERE word = ? COLLATE NOCASE`).get(w)) return false
  d.prepare(`INSERT INTO learn_counts (term, kind, count, updated_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(term) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`).run(w, kind, Date.now())
  const row = d.prepare(`SELECT count FROM learn_counts WHERE term = ?`).get(w) as { count: number }
  if (row.count < threshold) return false
  addWord(w, 'auto')
  d.prepare(`DELETE FROM learn_counts WHERE term = ?`).run(w)
  return true
}

export function addWord(word: string, source: 'manual' | 'auto' = 'manual'): void {
  const w = word.trim()
  if (!w) return
  open()
    .prepare(`INSERT OR IGNORE INTO dict_words (word, source, created_at) VALUES (?, ?, ?)`)
    .run(w, source, Date.now())
}

export function removeWord(word: string): void {
  const d = open()
  const row = d.prepare(`SELECT source FROM dict_words WHERE word = ?`).get(word) as { source: string } | undefined
  d.prepare(`DELETE FROM dict_words WHERE word = ?`).run(word)
  // 删除自动学习的词：记入屏蔽表，以后不再自动学回来
  if (row?.source === 'auto') d.prepare(`INSERT OR IGNORE INTO dict_blocked (word, created_at) VALUES (?, ?)`).run(word, Date.now())
}

/** 首页使用概览：听写/翻译/改写的字数与时长（提问不计入字数） */
export function historyStats(): HistoryStats {
  const d = open()
  const all = d
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(duration_ms), 0) AS dur,
              COALESCE(SUM(CASE WHEN mode != 'ask' THEN LENGTH(polished_text) ELSE 0 END), 0) AS chars
       FROM history WHERE status = 'completed'`
    )
    .get() as { count: number; dur: number; chars: number }
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const week = d.prepare(`SELECT COUNT(*) AS n FROM history WHERE status = 'completed' AND created_at >= ?`).get(Date.now() - 7 * 86_400_000) as { n: number }
  const today = d
    .prepare(`SELECT COALESCE(SUM(LENGTH(polished_text)), 0) AS c FROM history WHERE status = 'completed' AND mode != 'ask' AND created_at >= ?`)
    .get(dayStart.getTime()) as { c: number }
  return { count: all.count, totalDurationMs: all.dur, totalChars: all.chars, weekCount: week.n, todayChars: today.c }
}

// —— 风格学习（D-041）——

export const STYLE_SAMPLES_MAX = 50

type StyleRow = { id: number; created_at: number; app_name: string | null; before_text: string; after_text: string }
const toSample = (r: StyleRow): StyleSample => ({ id: r.id, createdAt: r.created_at, appName: r.app_name ?? undefined, before: r.before_text, after: r.after_text })

/** 保存一条修改记录（同一次写入再次读到改动时传 id 更新），超出上限删掉最旧的；返回记录 id */
export function saveStyleSample(before: string, after: string, appName?: string, id?: number): number {
  const d = open()
  if (id && d.prepare(`UPDATE style_samples SET after_text = ? WHERE id = ?`).run(after, id).changes) return id
  const res = d.prepare(`INSERT INTO style_samples (created_at, app_name, before_text, after_text) VALUES (?, ?, ?, ?)`).run(Date.now(), appName ?? null, before, after)
  d.prepare(`DELETE FROM style_samples WHERE id NOT IN (SELECT id FROM style_samples ORDER BY created_at DESC, id DESC LIMIT ?)`).run(STYLE_SAMPLES_MAX)
  return Number(res.lastInsertRowid)
}

export function listStyleSamples(): StyleSample[] {
  return (open().prepare(`SELECT * FROM style_samples ORDER BY created_at DESC, id DESC`).all() as StyleRow[]).map(toSample)
}

/** 润色时用的示例：同一应用的优先，其余按时间从新到旧 */
export function pickStyleSamples(appName: string | undefined, limit: number): StyleSample[] {
  const all = listStyleSamples()
  const same = appName ? all.filter((x) => x.appName === appName) : []
  return [...same, ...all.filter((x) => !same.includes(x))].slice(0, limit)
}

export function deleteStyleSample(id: number): void {
  open().prepare(`DELETE FROM style_samples WHERE id = ?`).run(id)
}

export function clearStyleSamples(): void {
  open().exec(`DELETE FROM style_samples`)
}
