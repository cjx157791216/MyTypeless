import { randomUUID } from 'crypto'
import type { MeetingDetail, MeetingDiagram, MeetingFolder, MeetingSegment, MeetingSource, MeetingSpeaker, MeetingStatus, MeetingSummary, MeetingTrack, Voiceprint } from '../../shared/types'
import { SAMPLE_RATE } from '../live.ts'
import { EMBED_MODEL } from './cluster.ts'

/**
 * 会议存储（D-015、D-016）：会议、说话人（含每人一个声音特征向量）、按句的转写、已保存的声纹。
 * 表结构见 `history.ts`；录音不进数据库（临时文件路径记在 meetings.audio_path / app_audio_path，整理完删除；
 * 用户开启保存会议录音时另存的 WAV 路径记在 saved_audio_path，D-044）。
 * 线上会议（D-033）分两路：track 0 = 麦克风（现场），1 = 应用声音（线上）；说话人与句子各属一路，两路各自区分说话人、各自编号。
 * 连接由 `initMeetingStore` 注入（不直接依赖 electron，可被 test/ 用 node:sqlite 内存库导入；history.ts 在 open() 里注入）。
 */

/** store 用到的 better-sqlite3 / node:sqlite 公共子集（better-sqlite3 的 Database 结构上满足它） */
export interface SqlConn {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
  transaction<T>(fn: () => T): () => T
}

let conn: SqlConn | null = null

/** 注入数据库连接；必须在第一次使用前调用（src/main/index.ts 的 whenReady 开头） */
export function initMeetingStore(d: SqlConn): void {
  conn = d
}

function db(): SqlConn {
  if (!conn) throw new Error('会议存储未初始化：先调用 initMeetingStore')
  return conn
}

/** 会议文件夹与回收站的表结构（D-050）：history.ts 的 open() 在 migrateColumns() 之后调用，幂等 */
export function ensureFolderSchema(d: SqlConn): void {
  d.exec(`CREATE TABLE IF NOT EXISTS meeting_folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  const cols = new Set((d.prepare(`PRAGMA table_info(meetings)`).all() as Array<{ name: string }>).map((c) => c.name))
  if (!cols.has('folder_id')) d.exec(`ALTER TABLE meetings ADD COLUMN folder_id TEXT`) // NULL = 未分类；旧行加列后自动 NULL，无需回填
  if (!cols.has('deleted_at')) d.exec(`ALTER TABLE meetings ADD COLUMN deleted_at INTEGER`) // NULL = 正常；非 NULL = 移入回收站的时间戳（软删除）
  d.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_folder ON meetings(folder_id)`)
}

const ms = (samples: number) => Math.round((samples / SAMPLE_RATE) * 1000)

function toBlob(v: Float32Array | null): Buffer | null {
  return v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null
}

function fromBlob(b: Buffer | null): Float32Array | null {
  if (!b) return null
  const copy = new Uint8Array(b) // 对齐到 4 字节
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}

export interface MeetingRow {
  id: string
  title: string
  started_at: number
  ended_at: number | null
  duration_ms: number
  status: MeetingStatus
  expected_speakers: number | null
  minutes: string | null
  minutes_error: string | null
  audio_path: string | null
  embed_model: string | null // 算逐句声纹用的声纹模型（NULL = 旧模型 CAM++，D-026）
  source: MeetingSource
  app_audio_path: string | null // 应用声音的临时录音（D-033）
  app_name: string | null
  expected_remote: number | null // 线上人数
  saved_audio_path: string | null // 保存下来的会议录音（D-044，用户的文件，删除会议时不删）
  diagrams: string | null // 内容分析生成的图表（D-048），JSON 数组 [{ title, code }]；没有为 NULL
  folder_id: string | null // 所属文件夹（D-050）；NULL = 未分类
  deleted_at: number | null // 移入回收站的时间戳（D-050）；NULL = 正常
}

export interface SpeakerRow {
  id: number
  meeting_id: string
  label: number
  name: string | null
  voiceprint_id: number | null
  centroid: Float32Array | null
  track: MeetingTrack
  auto_named: number // 1 = 名字由声纹自动认出（D-042）
}

export interface SegmentRow {
  id: number
  speakerId: number | null
  track: MeetingTrack
  startSample: number
  endSample: number
  text: string
  locked: boolean
}

export function createMeeting(m: {
  title: string
  startedAt: number
  expectedSpeakers: number | null
  audioPath: string | null
  source?: MeetingSource
  appAudioPath?: string | null
  appName?: string | null
  expectedRemote?: number | null
}): string {
  const id = randomUUID()
  db()
    .prepare(
      `INSERT INTO meetings (id, title, started_at, status, expected_speakers, audio_path, embed_model, source, app_audio_path, app_name, expected_remote)
       VALUES (?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, m.title, m.startedAt, m.expectedSpeakers, m.audioPath, EMBED_MODEL, m.source ?? 'mic', m.appAudioPath ?? null, m.appName ?? null, m.expectedRemote ?? null)
  return id
}

/** 这场会议的逐句声纹是否由当前声纹模型算出（只有这样才能与声纹库比较、保存声纹） */
export function usesCurrentModel(id: string): boolean {
  return getMeetingRow(id)?.embed_model === EMBED_MODEL
}

/** 旧模型的会议重新整理时：清掉旧声纹，改由当前模型从临时录音重算 */
export function resetEmbeddings(id: string): void {
  const d = db()
  d.prepare(`UPDATE meeting_segments SET embedding = NULL WHERE meeting_id = ?`).run(id)
  d.prepare(`UPDATE meeting_speakers SET centroid = NULL, voiceprint_id = NULL WHERE meeting_id = ?`).run(id)
  d.prepare(`UPDATE meetings SET embed_model = ? WHERE id = ?`).run(EMBED_MODEL, id)
}

export function updateMeeting(
  id: string,
  patch: Partial<{
    title: string
    status: MeetingStatus
    endedAt: number
    durationMs: number
    minutes: string | null
    minutesError: string | null
    audioPath: string | null
    appAudioPath: string | null
    savedAudioPath: string | null
    source: MeetingSource
    expectedSpeakers: number | null
    diagrams: string | null
  }>
): void {
  const cols: Record<string, string> = {
    title: 'title',
    status: 'status',
    endedAt: 'ended_at',
    durationMs: 'duration_ms',
    minutes: 'minutes',
    minutesError: 'minutes_error',
    audioPath: 'audio_path',
    appAudioPath: 'app_audio_path',
    savedAudioPath: 'saved_audio_path',
    source: 'source',
    expectedSpeakers: 'expected_speakers',
    diagrams: 'diagrams'
  }
  const keys = Object.keys(patch).filter((k) => k in cols)
  if (!keys.length) return
  const sql = `UPDATE meetings SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`
  db()
    .prepare(sql)
    .run(...keys.map((k) => (patch as Record<string, unknown>)[k] ?? null), id)
}

export function getMeetingRow(id: string): MeetingRow | null {
  return (db().prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as MeetingRow | undefined) ?? null
}

/** 异常中断（进行中或整理中）的会议；回收站里的脏数据（理论上不该存在，防御）不捞回 */
export function unfinishedMeetings(): MeetingRow[] {
  return db().prepare(`SELECT * FROM meetings WHERE status IN ('recording', 'paused', 'processing') AND deleted_at IS NULL`).all() as MeetingRow[]
}

/** 默认名：只有一路声音时「说话人 N」；麦克风 + 应用声音时分「现场 N」「线上 N」（D-033） */
export function displayName(s: { label: number; name: string | null; track?: number }, source: MeetingSource = 'mic'): string {
  if (s.name?.trim()) return s.name.trim()
  if (source !== 'mixed') return `说话人 ${s.label}`
  return `${s.track === 1 ? '线上' : '现场'} ${s.label}`
}

/** 会议录音的各路：[一路, 临时录音路径]（只用应用声音时只有第 1 路） */
export function trackPaths(r: Pick<MeetingRow, 'source' | 'audio_path' | 'app_audio_path'>): Array<[MeetingTrack, string | null]> {
  if (r.source === 'app') return [[1, r.app_audio_path]]
  if (r.source === 'mixed') return [[0, r.audio_path], [1, r.app_audio_path]]
  return [[0, r.audio_path]]
}

export function listMeetings(): MeetingSummary[] {
  const rows = db().prepare(`SELECT * FROM meetings ORDER BY started_at DESC`).all() as MeetingRow[]
  const speakerStmt = db().prepare(
    `SELECT s.label, s.name, s.track FROM meeting_speakers s
     WHERE s.meeting_id = ? AND EXISTS (SELECT 1 FROM meeting_segments g WHERE g.speaker_id = s.id)
     ORDER BY s.track, s.label`
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status,
    speakers: (speakerStmt.all(r.id) as Array<{ label: number; name: string | null; track: number }>).map((s) => displayName(s, r.source)),
    hasMinutes: !!r.minutes,
    folderId: r.folder_id ?? null,
    deletedAt: r.deleted_at ?? null
  }))
}

/** 解析会议图表（D-048）：存的是 JSON 数组 [{ title, code }]；坏数据按没有图表处理 */
function parseDiagramsJson(json: string | null | undefined): MeetingDiagram[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: MeetingDiagram[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const code = (item as { code?: unknown }).code
      if (typeof code !== 'string') continue
      const title = (item as { title?: unknown }).title
      out.push({ title: typeof title === 'string' && title.trim() ? title.trim() : '图表', code })
    }
    return out
  } catch {
    return []
  }
}

export function getMeetingDetail(id: string): MeetingDetail | null {
  const r = getMeetingRow(id)
  if (!r) return null
  const segments = listSegments(id)
  const counts = new Map<number, number>()
  for (const s of segments) if (s.speakerId !== null) counts.set(s.speakerId, (counts.get(s.speakerId) ?? 0) + 1)
  const speakerList: MeetingSpeaker[] = listSpeakers(id)
    .filter((s) => counts.has(s.id))
    .map((s) => ({
      id: s.id,
      label: s.label,
      track: s.track,
      name: s.name,
      voiceprintId: s.voiceprint_id,
      displayName: displayName(s, r.source),
      segmentCount: counts.get(s.id) ?? 0
    }))
  const segs: MeetingSegment[] = segments.map((s) => ({
    id: s.id,
    speakerId: s.speakerId,
    track: s.track,
    startMs: ms(s.startSample),
    endMs: ms(s.endSample),
    text: s.text,
    locked: s.locked
  }))
  return {
    id: r.id,
    title: r.title,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status,
    speakers: speakerList.map((s) => s.displayName),
    hasMinutes: !!r.minutes,
    folderId: r.folder_id ?? null,
    deletedAt: r.deleted_at ?? null,
    source: r.source,
    appName: r.app_name,
    expectedSpeakers: r.expected_speakers,
    expectedRemote: r.expected_remote,
    speakerList,
    segments: segs,
    minutes: r.minutes,
    minutesError: r.minutes_error,
    savedAudioPath: r.saved_audio_path ?? null,
    diagrams: parseDiagramsJson(r.diagrams)
  }
}

/** 彻底删除会议的全部数据（D-050：回收站里的会议也走这里）；返回临时录音路径（由调用方删除文件），用户另存的录音不删 */
export function deleteMeeting(id: string): string[] {
  const row = getMeetingRow(id)
  const audio = [row?.audio_path, row?.app_audio_path].filter((p): p is string => !!p)
  const d = db()
  d.transaction(() => {
    d.prepare(`DELETE FROM meeting_segments WHERE meeting_id = ?`).run(id)
    d.prepare(`DELETE FROM meeting_speakers WHERE meeting_id = ?`).run(id)
    d.prepare(`DELETE FROM meetings WHERE id = ?`).run(id)
  })()
  return audio
}

// —— 会议文件夹与回收站（D-050）——

export function listFolders(): MeetingFolder[] {
  return (db()
    .prepare(`SELECT id, name, created_at FROM meeting_folders ORDER BY created_at, rowid`)
    .all() as Array<{ id: string; name: string; created_at: number }>).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }))
}

/** 新建文件夹：trim 后空名不建（folder 为 null）；列表照 dictAdd 模式返回最新，UI 便于选中新建项 */
export function createFolder(name: string): { folder: MeetingFolder | null; folders: MeetingFolder[] } {
  const trimmed = name.trim()
  if (!trimmed) return { folder: null, folders: listFolders() }
  const folder: MeetingFolder = { id: randomUUID(), name: trimmed, createdAt: Date.now() }
  db().prepare(`INSERT INTO meeting_folders (id, name, created_at) VALUES (?, ?, ?)`).run(folder.id, folder.name, folder.createdAt)
  return { folder, folders: listFolders() }
}

export function renameFolder(id: string, name: string): MeetingFolder[] {
  const trimmed = name.trim()
  if (trimmed) db().prepare(`UPDATE meeting_folders SET name = ? WHERE id = ?`).run(trimmed, id)
  return listFolders()
}

/** 删除文件夹：其中所有会议（含回收站里的）回到「未分类」，不删会议 */
export function deleteFolder(id: string): MeetingFolder[] {
  const d = db()
  d.transaction(() => {
    d.prepare(`UPDATE meetings SET folder_id = NULL WHERE folder_id = ?`).run(id)
    d.prepare(`DELETE FROM meeting_folders WHERE id = ?`).run(id)
  })()
  return listFolders()
}

/** 移动会议到文件夹（folderId 为 null = 移到「未分类」）；目标不存在或会议在回收站中为 false */
export function moveMeetingToFolder(meetingId: string, folderId: string | null): boolean {
  const r = getMeetingRow(meetingId)
  if (!r || r.deleted_at !== null) return false
  if (folderId !== null && !db().prepare(`SELECT 1 FROM meeting_folders WHERE id = ?`).get(folderId)) return false
  db().prepare(`UPDATE meetings SET folder_id = ? WHERE id = ?`).run(folderId, meetingId)
  return true
}

/** 移入回收站（软删除，只置 deleted_at，folder_id 保留——恢复回原文件夹）；进行中或整理中 false */
export function trashMeeting(id: string): boolean {
  const r = getMeetingRow(id)
  if (!r || r.deleted_at !== null) return false
  if (r.status === 'recording' || r.status === 'paused' || r.status === 'processing') return false
  db().prepare(`UPDATE meetings SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(Date.now(), id)
  return true
}

/** 从回收站恢复；不在回收站中的会议 false */
export function restoreMeeting(id: string): boolean {
  const info = db().prepare(`UPDATE meetings SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`).run(id)
  return Number(info.changes) > 0
}

// —— 说话人 ——

export function listSpeakers(meetingId: string): SpeakerRow[] {
  const rows = db().prepare(`SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY track, label`).all(meetingId) as Array<
    Omit<SpeakerRow, 'centroid'> & { centroid: Buffer | null }
  >
  return rows.map((r) => ({ ...r, centroid: fromBlob(r.centroid) }))
}

export function getSpeaker(id: number): SpeakerRow | null {
  const r = db().prepare(`SELECT * FROM meeting_speakers WHERE id = ?`).get(id) as (Omit<SpeakerRow, 'centroid'> & { centroid: Buffer | null }) | undefined
  return r ? { ...r, centroid: fromBlob(r.centroid) } : null
}

export function addSpeaker(meetingId: string, track: MeetingTrack = 0, name: string | null = null, voiceprintId: number | null = null): number {
  const d = db()
  const next = (d.prepare(`SELECT COALESCE(MAX(label), 0) + 1 AS n FROM meeting_speakers WHERE meeting_id = ? AND track = ?`).get(meetingId, track) as { n: number }).n
  const info = d
    .prepare(`INSERT INTO meeting_speakers (meeting_id, label, name, voiceprint_id, track) VALUES (?, ?, ?, ?, ?)`)
    .run(meetingId, next, name, voiceprintId, track)
  return Number(info.lastInsertRowid)
}

export function updateSpeaker(
  id: number,
  patch: Partial<{ name: string | null; voiceprintId: number | null; centroid: Float32Array | null; autoNamed: boolean }>
): void {
  const d = db()
  if ('name' in patch) d.prepare(`UPDATE meeting_speakers SET name = ? WHERE id = ?`).run(patch.name, id)
  if ('voiceprintId' in patch) d.prepare(`UPDATE meeting_speakers SET voiceprint_id = ? WHERE id = ?`).run(patch.voiceprintId, id)
  if ('centroid' in patch) d.prepare(`UPDATE meeting_speakers SET centroid = ? WHERE id = ?`).run(toBlob(patch.centroid ?? null), id)
  if ('autoNamed' in patch) d.prepare(`UPDATE meeting_speakers SET auto_named = ? WHERE id = ?`).run(patch.autoNamed ? 1 : 0, id)
}

/** 合并说话人：from 的句子全部归到 into，删除 from（from 的名字在 into 没名字时继承） */
export function mergeSpeakers(from: number, into: number): void {
  const d = db()
  d.transaction(() => {
    const a = getSpeaker(from)
    const b = getSpeaker(into)
    if (a && b && !b.name && a.name) d.prepare(`UPDATE meeting_speakers SET name = ?, voiceprint_id = ?, auto_named = ? WHERE id = ?`).run(a.name, a.voiceprint_id, a.auto_named, into)
    d.prepare(`UPDATE meeting_segments SET speaker_id = ? WHERE speaker_id = ?`).run(into, from)
    d.prepare(`DELETE FROM meeting_speakers WHERE id = ?`).run(from)
  })()
}

// —— 句子 ——

export function addSegment(
  meetingId: string,
  seg: { speakerId: number | null; startSample: number; endSample: number; text: string; embedding?: Float32Array | null; track?: MeetingTrack }
): number {
  const info = db()
    .prepare(`INSERT INTO meeting_segments (meeting_id, speaker_id, start_sample, end_sample, text, embedding, track) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(meetingId, seg.speakerId, seg.startSample, seg.endSample, seg.text, toBlob(seg.embedding ?? null), seg.track ?? 0)
  return Number(info.lastInsertRowid)
}

/** 逐句声纹（D-020）：会后按人数重新区分说话人用 */
export function setSegmentEmbedding(id: number, v: Float32Array): void {
  db().prepare(`UPDATE meeting_segments SET embedding = ? WHERE id = ?`).run(toBlob(v), id)
}

export function segmentEmbeddings(meetingId: string): Map<number, Float32Array> {
  const rows = db().prepare(`SELECT id, embedding FROM meeting_segments WHERE meeting_id = ? AND embedding IS NOT NULL`).all(meetingId) as Array<{
    id: number
    embedding: Buffer
  }>
  return new Map(rows.map((r) => [r.id, fromBlob(r.embedding)!]))
}

export function setExpectedSpeakers(id: string, n: number | null, track: MeetingTrack = 0): void {
  db()
    .prepare(`UPDATE meetings SET ${track === 1 ? 'expected_remote' : 'expected_speakers'} = ? WHERE id = ?`)
    .run(n, id)
}

/** 这一路的参会人数 */
export function expectedOf(r: Pick<MeetingRow, 'expected_speakers' | 'expected_remote'>, track: MeetingTrack): number | null {
  return track === 1 ? r.expected_remote : r.expected_speakers
}

export function setSegmentSpeaker(id: number, speakerId: number | null, locked?: boolean): void {
  if (locked === undefined) db().prepare(`UPDATE meeting_segments SET speaker_id = ? WHERE id = ?`).run(speakerId, id)
  else db().prepare(`UPDATE meeting_segments SET speaker_id = ?, locked = ? WHERE id = ?`).run(speakerId, locked ? 1 : 0, id)
}

export function listSegments(meetingId: string): SegmentRow[] {
  const rows = db()
    .prepare(`SELECT id, speaker_id, track, start_sample, end_sample, text, locked FROM meeting_segments WHERE meeting_id = ? ORDER BY start_sample, id`)
    .all(meetingId) as Array<{ id: number; speaker_id: number | null; track: MeetingTrack; start_sample: number; end_sample: number; text: string; locked: number }>
  return rows.map((r) => ({
    id: r.id,
    speakerId: r.speaker_id,
    track: r.track,
    startSample: r.start_sample,
    endSample: r.end_sample,
    text: r.text,
    locked: !!r.locked
  }))
}

/** 「说话人 N」按第一次发言的先后重新编号（名字不变；每一路各自编号） */
export function relabelSpeakers(meetingId: string): void {
  const d = db()
  const order = d
    .prepare(
      `SELECT s.id, s.track FROM meeting_speakers s
       JOIN (SELECT speaker_id, MIN(start_sample) AS first FROM meeting_segments WHERE meeting_id = ? GROUP BY speaker_id) f ON f.speaker_id = s.id
       WHERE s.meeting_id = ? ORDER BY f.first`
    )
    .all(meetingId, meetingId) as Array<{ id: number; track: number }>
  d.transaction(() => {
    const stmt = d.prepare(`UPDATE meeting_speakers SET label = ? WHERE id = ?`)
    const next = [0, 0]
    for (const r of order) stmt.run(++next[r.track === 1 ? 1 : 0], r.id)
  })()
}

/** 删掉没有句子的说话人（重新归类、合并之后） */
export function pruneSpeakers(meetingId: string): void {
  db()
    .prepare(`DELETE FROM meeting_speakers WHERE meeting_id = ? AND NOT EXISTS (SELECT 1 FROM meeting_segments g WHERE g.speaker_id = meeting_speakers.id)`)
    .run(meetingId)
}

// —— 声纹库（D-016）——

export function listVoiceprints(): Voiceprint[] {
  return (db().prepare(`SELECT id, name, samples, created_at, updated_at FROM voiceprints ORDER BY updated_at DESC`).all() as Array<{
    id: number
    name: string
    samples: number
    created_at: number
    updated_at: number
  }>).map((r) => ({ id: r.id, name: r.name, samples: r.samples, createdAt: r.created_at, updatedAt: r.updated_at }))
}

export function voiceprintVectors(): Array<{ id: number; name: string; samples: number; vector: Float32Array }> {
  return (db().prepare(`SELECT id, name, samples, vector FROM voiceprints WHERE model = ?`).all(EMBED_MODEL) as Array<{ id: number; name: string; samples: number; vector: Buffer }>).map(
    (r) => ({ id: r.id, name: r.name, samples: r.samples, vector: fromBlob(r.vector)! })
  )
}

export function saveVoiceprint(p: { id?: number | null; name: string; vector: Float32Array; samples: number }): number {
  const d = db()
  const now = Date.now()
  if (p.id) {
    d.prepare(`UPDATE voiceprints SET name = ?, vector = ?, samples = ?, model = ?, updated_at = ? WHERE id = ?`).run(p.name, toBlob(p.vector), p.samples, EMBED_MODEL, now, p.id)
    return p.id
  }
  const info = d.prepare(`INSERT INTO voiceprints (name, vector, samples, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(p.name, toBlob(p.vector), p.samples, EMBED_MODEL, now, now)
  return Number(info.lastInsertRowid)
}

export function renameVoiceprint(id: number, name: string): void {
  const d = db()
  d.transaction(() => {
    d.prepare(`UPDATE voiceprints SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id)
    d.prepare(`UPDATE meeting_speakers SET name = ? WHERE voiceprint_id = ?`).run(name, id)
  })()
}

/** 删除声纹：立即生效；已有会议里的名字保留，只是不再关联声纹 */
export function deleteVoiceprint(id: number): void {
  const d = db()
  d.transaction(() => {
    d.prepare(`DELETE FROM voiceprints WHERE id = ?`).run(id)
    d.prepare(`UPDATE meeting_speakers SET voiceprint_id = NULL WHERE voiceprint_id = ?`).run(id)
  })()
}
