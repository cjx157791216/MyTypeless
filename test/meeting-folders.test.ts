// 会议文件夹与回收站（D-050）：store 层用 node:sqlite 内存库测迁移、文件夹 CRUD、移动、软删 / 恢复 / 彻底删除。
// fixture 手写"当前生产形状"（migrateColumns 跑完、还没有 folder_id / deleted_at）的四张表，跑 ensureFolderSchema 补列——老库升级本身是被测行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { SqlConn } from '../src/main/meeting/store.ts'
import {
  addSegment,
  addSpeaker,
  createFolder,
  createMeeting,
  deleteFolder,
  deleteMeeting,
  ensureFolderSchema,
  getMeetingRow,
  initMeetingStore,
  listFolders,
  listMeetings,
  listSegments,
  listSpeakers,
  listVoiceprints,
  moveMeetingToFolder,
  renameFolder,
  restoreMeeting,
  saveVoiceprint,
  trashMeeting,
  unfinishedMeetings,
  updateMeeting
} from '../src/main/meeting/store.ts'

/** node:sqlite → SqlConn 适配器（transaction 用显式 BEGIN/COMMIT 实现） */
function adapt(d: DatabaseSync): SqlConn {
  return {
    exec: (sql) => d.exec(sql),
    prepare: (sql) => {
      const s = d.prepare(sql)
      return {
        run: (...p) => s.run(...p) as { lastInsertRowid: number | bigint },
        get: (...p) => s.get(...p),
        all: (...p) => s.all(...p)
      }
    },
    transaction: (fn) => () => {
      d.exec('BEGIN')
      try {
        const r = fn()
        d.exec('COMMIT')
        return r
      } catch (e) {
        d.exec('ROLLBACK')
        throw e
      }
    }
  }
}

/** 当前生产形状（不含本 PR 新增的 folder_id / deleted_at） */
function setup(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      duration_ms INTEGER DEFAULT 0, status TEXT NOT NULL, expected_speakers INTEGER,
      minutes TEXT, minutes_error TEXT, audio_path TEXT, embed_model TEXT,
      source TEXT NOT NULL DEFAULT 'mic', app_audio_path TEXT, app_name TEXT,
      expected_remote INTEGER, saved_audio_path TEXT, diagrams TEXT
    );
    CREATE TABLE meeting_speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, label INTEGER, name TEXT,
      voiceprint_id INTEGER, centroid BLOB, track INTEGER NOT NULL DEFAULT 0, auto_named INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE meeting_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, speaker_id INTEGER, start_sample INTEGER,
      end_sample INTEGER, text TEXT, locked INTEGER DEFAULT 0, embedding BLOB, track INTEGER DEFAULT 0
    );
    CREATE TABLE voiceprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, vector BLOB, samples INTEGER,
      created_at INTEGER, updated_at INTEGER, model TEXT
    );
  `)
  const conn = adapt(d)
  ensureFolderSchema(conn)
  initMeetingStore(conn)
  return d
}

/** 一场已结束的会议（软删除与彻底删除只对结束态有效） */
function doneMeeting(title: string, audioPath?: string): string {
  const id = createMeeting({ title, startedAt: 1700000000000, expectedSpeakers: null, audioPath: audioPath ?? null })
  updateMeeting(id, { status: 'done', durationMs: 60_000 })
  return id
}

test('迁移：建 meeting_folders 表、给老形状 meetings 补 folder_id / deleted_at，幂等，老数据两列为 NULL', () => {
  const d = setup()
  const cols = () => new Set((d.prepare('PRAGMA table_info(meetings)').all() as Array<{ name: string }>).map((c) => c.name))
  assert.ok(cols().has('folder_id') && cols().has('deleted_at'))
  assert.ok((d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_folders'").get() as { name: string } | undefined))
  ensureFolderSchema(adapt(d)) // 再跑一遍不炸（幂等）
  const id = createMeeting({ title: '老库会议', startedAt: 1, expectedSpeakers: null, audioPath: null })
  const r = getMeetingRow(id)!
  assert.equal(r.folder_id, null)
  assert.equal(r.deleted_at, null)
})

test('文件夹 CRUD：建（空名不建）、按创建时间排序、重命名（空名不动）', () => {
  setup()
  const a = createFolder('工作例会').folder!
  assert.equal(a.name, '工作例会')
  const empty = createFolder('   ')
  assert.equal(empty.folder, null)
  assert.equal(empty.folders.length, 1)
  const b = createFolder('客户拜访').folder!
  const folders = listFolders()
  assert.deepEqual(folders.map((f) => f.name), ['工作例会', '客户拜访']) // 创建顺序
  assert.ok(b.createdAt >= a.createdAt)
  renameFolder(a.id, '周会')
  assert.equal(listFolders()[0].name, '周会')
  renameFolder(a.id, '  ')
  assert.equal(listFolders()[0].name, '周会') // 空名不动
})

test('移动：移入 / 移出 / 目标不存在 false / 回收站中 false；新会议固定未分类', () => {
  setup()
  const id = createMeeting({ title: '会议', startedAt: 1, expectedSpeakers: null, audioPath: null })
  assert.equal(getMeetingRow(id)!.folder_id, null) // 新会议未分类
  const f = createFolder('工作').folder!
  assert.equal(moveMeetingToFolder(id, f.id), true)
  assert.equal(getMeetingRow(id)!.folder_id, f.id)
  assert.equal(moveMeetingToFolder(id, null), true)
  assert.equal(getMeetingRow(id)!.folder_id, null)
  assert.equal(moveMeetingToFolder(id, '不存在的id'), false)
  updateMeeting(id, { status: 'done' })
  assert.equal(trashMeeting(id), true)
  assert.equal(moveMeetingToFolder(id, f.id), false) // 回收站中的会议不能移动
})

test('软删与恢复：deleted_at 置与清、folder_id 保留、重复 trash false、未 trash 的 restore false、进行中拒绝', () => {
  setup()
  const f = createFolder('工作').folder!
  const id = doneMeeting('周会')
  moveMeetingToFolder(id, f.id)
  assert.equal(trashMeeting(id), true)
  const trashed = getMeetingRow(id)!
  assert.ok(trashed.deleted_at !== null && trashed.deleted_at > 0)
  assert.equal(trashed.folder_id, f.id) // 原文件夹保留，恢复回原处
  assert.equal(trashMeeting(id), false) // 已在回收站
  assert.equal(restoreMeeting(id), true)
  assert.equal(getMeetingRow(id)!.deleted_at, null)
  assert.equal(restoreMeeting(id), false) // 不在回收站
  const live = createMeeting({ title: '进行中', startedAt: 2, expectedSpeakers: null, audioPath: null }) // status = recording
  assert.equal(trashMeeting(live), false)
})

test('删除文件夹：其中会议（含回收站里的）全部回到未分类，文件夹消失，会议不删', () => {
  setup()
  const f = createFolder('工作').folder!
  const a = doneMeeting('正常')
  const b = doneMeeting('回收站里的')
  for (const id of [a, b]) moveMeetingToFolder(id, f.id)
  trashMeeting(b)
  const folders = deleteFolder(f.id)
  assert.equal(folders.length, 0)
  assert.equal(getMeetingRow(a)!.folder_id, null)
  assert.equal(getMeetingRow(b)!.folder_id, null)
  assert.ok(getMeetingRow(b)!.deleted_at !== null) // 回收站状态不变
  assert.notEqual(getMeetingRow(a), undefined) // 会议不删
})

test('彻底删除复用 deleteMeeting：三表行删、返回两路临时录音路径、不含用户另存录音、voiceprints 不动', () => {
  setup()
  const id = doneMeeting('要删的', '/tmp/audio.pcm')
  updateMeeting(id, { appAudioPath: '/tmp/app.pcm', savedAudioPath: '/Users/x/会议.wav' })
  const sid = addSpeaker(id)
  addSegment(id, { speakerId: sid, startSample: 0, endSample: 16000, text: '你好' })
  saveVoiceprint({ name: '我', vector: new Float32Array([1, 2, 3, 4]), samples: 3 })
  trashMeeting(id)
  const paths = deleteMeeting(id)
  assert.deepEqual(paths, ['/tmp/audio.pcm', '/tmp/app.pcm']) // 只有临时录音；saved 的不删（D-044）
  assert.equal(getMeetingRow(id), null)
  assert.equal(listSpeakers(id).length, 0)
  assert.equal(listSegments(id).length, 0)
  assert.equal(listVoiceprints().length, 1) // 声纹库不动
})

test('列表语义：listMeetings 含回收站且 folderId/deletedAt 正确；unfinishedMeetings 排除回收站', () => {
  const d = setup()
  const f = createFolder('工作').folder!
  const normal = doneMeeting('正常')
  const trashed = doneMeeting('回收站')
  moveMeetingToFolder(trashed, f.id)
  trashMeeting(trashed)
  const all = listMeetings()
  assert.equal(all.length, 2)
  const byId = new Map(all.map((m) => [m.id, m]))
  assert.equal(byId.get(normal)!.deletedAt, null)
  assert.equal(byId.get(normal)!.folderId, null)
  assert.ok(byId.get(trashed)!.deletedAt !== null)
  assert.equal(byId.get(trashed)!.folderId, f.id)
  // 防御条件：哪怕出现 processing + 在回收站的行（绕过 store guard 才可能），中断恢复也不碰它
  d.prepare(`INSERT INTO meetings (id, title, started_at, status, deleted_at) VALUES ('x', '脏数据', 3, 'processing', 123)`).run()
  assert.equal(unfinishedMeetings().some((m) => m.id === 'x'), false)
  assert.equal(unfinishedMeetings().some((m) => m.id === trashed), false)
})
