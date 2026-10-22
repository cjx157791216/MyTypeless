import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MeetingTrack } from '../shared/types'
import type { AnswerPayload } from '../shared/api'

/**
 * preload：只暴露白名单 API，保持 contextIsolation。
 */
const api = {
  /** 运行平台（process.platform），界面按平台显示键名与系统设置路径 */
  platform: process.platform as string,
  session: {
    start: (mode?: string) => ipcRenderer.invoke(IPC.sessionStart, mode),
    stop: () => ipcRenderer.invoke(IPC.sessionStop),
    cancel: () => ipcRenderer.invoke(IPC.sessionCancel),
    getState: () => ipcRenderer.invoke(IPC.sessionGetState),
    pushAudio: (buf: ArrayBuffer) => ipcRenderer.invoke(IPC.sessionAudioChunk, buf),
    audioFinal: () => ipcRenderer.invoke(IPC.sessionAudioFinal),
    onFlush: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on(IPC.captureFlush, listener)
      return () => ipcRenderer.removeListener(IPC.captureFlush, listener)
    },
    onStateChanged: (cb: (p: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p)
      ipcRenderer.on(IPC.stateChanged, listener)
      return () => ipcRenderer.removeListener(IPC.stateChanged, listener)
    },
    onAnswer: (cb: (a: AnswerPayload) => void) => {
      const listener = (_e: unknown, a: AnswerPayload) => cb(a)
      ipcRenderer.on(IPC.answerCardUpdate, listener)
      return () => ipcRenderer.removeListener(IPC.answerCardUpdate, listener)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: unknown) => ipcRenderer.invoke(IPC.settingsSet, patch),
    setKey: (which: 'asr' | 'llm', key: string) => ipcRenderer.invoke(IPC.settingsSetKey, which, key),
    asrHealth: (baseUrl?: string) => ipcRenderer.invoke(IPC.asrHealth, baseUrl),
    llmTest: (cfg: { baseUrl: string; model: string; apiKey?: string }) => ipcRenderer.invoke(IPC.llmTest, cfg)
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.modelList),
    download: (id: string) => ipcRenderer.invoke(IPC.modelDownload, id),
    cancel: (id: string) => ipcRenderer.invoke(IPC.modelCancel, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.modelRemove, id),
    onProgress: (cb: (p: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p)
      ipcRenderer.on(IPC.modelProgress, listener)
      return () => ipcRenderer.removeListener(IPC.modelProgress, listener)
    }
  },
  history: {
    list: (limit?: number, offset?: number) => ipcRenderer.invoke(IPC.historyList, limit, offset),
    remove: (id: string) => ipcRenderer.invoke(IPC.historyDelete, id),
    copy: (id: string) => ipcRenderer.invoke(IPC.historyCopy, id),
    clear: () => ipcRenderer.invoke(IPC.historyClear),
    stats: () => ipcRenderer.invoke(IPC.historyStats)
  },
  dict: {
    list: () => ipcRenderer.invoke(IPC.dictList),
    add: (word: string) => ipcRenderer.invoke(IPC.dictAdd, word),
    remove: (word: string) => ipcRenderer.invoke(IPC.dictRemove, word),
    onChanged: (cb: (terms: string[]) => void) => {
      const listener = (_e: unknown, terms: string[]) => cb(terms)
      ipcRenderer.on(IPC.dictChanged, listener)
      return () => ipcRenderer.removeListener(IPC.dictChanged, listener)
    }
  },
  meeting: {
    start: (opts?: unknown) => ipcRenderer.invoke(IPC.meetingStart, opts),
    pause: () => ipcRenderer.invoke(IPC.meetingPause),
    resume: () => ipcRenderer.invoke(IPC.meetingResume),
    stop: (opts?: { minutes?: boolean }) => ipcRenderer.invoke(IPC.meetingStop, opts),
    requestStop: () => ipcRenderer.invoke(IPC.meetingRequestStop),
    getLive: () => ipcRenderer.invoke(IPC.meetingGetLive),
    pushAudio: (buf: ArrayBuffer) => ipcRenderer.invoke(IPC.meetingAudioChunk, buf),
    list: () => ipcRenderer.invoke(IPC.meetingList),
    get: (id: string) => ipcRenderer.invoke(IPC.meetingGet, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.meetingDelete, id),
    setTitle: (id: string, title: string) => ipcRenderer.invoke(IPC.meetingSetTitle, id, title),
    renameSpeaker: (id: string, speakerId: number, name: string, remember: boolean) => ipcRenderer.invoke(IPC.meetingRenameSpeaker, id, speakerId, name, remember),
    assignSegment: (id: string, segmentId: number, speakerId: number | 'new') => ipcRenderer.invoke(IPC.meetingAssignSegment, id, segmentId, speakerId),
    mergeSpeakers: (id: string, from: number, into: number) => ipcRenderer.invoke(IPC.meetingMergeSpeakers, id, from, into),
    saveMinutes: (id: string, markdown: string) => ipcRenderer.invoke(IPC.meetingSaveMinutes, id, markdown),
    regenerate: (id: string) => ipcRenderer.invoke(IPC.meetingRegenerate, id),
    finish: (id: string, opts?: { minutes?: boolean }) => ipcRenderer.invoke(IPC.meetingFinish, id, opts),
    setExpected: (id: string, n: number, track?: MeetingTrack) => ipcRenderer.invoke(IPC.meetingSetExpected, id, n, track),
    audioApps: () => ipcRenderer.invoke(IPC.meetingAudioApps),
    prepareAppAudio: () => ipcRenderer.invoke(IPC.meetingPrepareAppAudio),
    exportMarkdown: (id: string) => ipcRenderer.invoke(IPC.meetingExport, id),
    audioDir: (action: 'pick' | 'open') => ipcRenderer.invoke(IPC.meetingAudioDir, action),
    revealAudio: (id: string) => ipcRenderer.invoke(IPC.meetingRevealAudio, id),
    onLive: (cb: (live: unknown) => void) => {
      const listener = (_e: unknown, live: unknown) => cb(live)
      ipcRenderer.on(IPC.meetingLive, listener)
      return () => ipcRenderer.removeListener(IPC.meetingLive, listener)
    },
    onChanged: (cb: (meetingId: string) => void) => {
      const listener = (_e: unknown, id: string) => cb(id)
      ipcRenderer.on(IPC.meetingChanged, listener)
      return () => ipcRenderer.removeListener(IPC.meetingChanged, listener)
    },
    onCapture: (cb: (c: { on: boolean; micDeviceId: string }) => void) => {
      const listener = (_e: unknown, c: { on: boolean; micDeviceId: string }) => cb(c)
      ipcRenderer.on(IPC.meetingCapture, listener)
      return () => ipcRenderer.removeListener(IPC.meetingCapture, listener)
    }
  },
  voiceprints: {
    list: () => ipcRenderer.invoke(IPC.voiceprintList),
    rename: (id: number, name: string) => ipcRenderer.invoke(IPC.voiceprintRename, id, name),
    remove: (id: number) => ipcRenderer.invoke(IPC.voiceprintDelete, id),
    model: (action: 'download' | 'cancel' | 'remove') => ipcRenderer.invoke(IPC.speakerModelAction, action)
  },
  styleSamples: {
    list: () => ipcRenderer.invoke(IPC.styleSampleList),
    remove: (id: number) => ipcRenderer.invoke(IPC.styleSampleDelete, id),
    clear: () => ipcRenderer.invoke(IPC.styleSampleClear)
  },
  system: {
    checkPermissions: () => ipcRenderer.invoke(IPC.checkPermissions),
    appInfo: () => ipcRenderer.invoke(IPC.appInfo),
    openPermissionSettings: () => ipcRenderer.invoke(IPC.openPermissionSettings),
    closeWindow: () => ipcRenderer.send(IPC.windowClose),
    openKeyboardSettings: () => ipcRenderer.invoke(IPC.openKeyboardSettings),
    resetAccessibility: () => ipcRenderer.invoke(IPC.resetAccessibility),
    setBarInteractive: (interactive: boolean) => ipcRenderer.send(IPC.barInteractive, interactive),
    answerInsert: (text: string) => ipcRenderer.invoke(IPC.answerInsert, text),
    onNavigate: (cb: (anchor: string) => void) => {
      const listener = (_e: unknown, a: string) => cb(a)
      ipcRenderer.on(IPC.navigate, listener)
      return () => ipcRenderer.removeListener(IPC.navigate, listener)
    }
  },
  update: {
    getState: () => ipcRenderer.invoke(IPC.updateGetState),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    cancel: () => ipcRenderer.invoke(IPC.updateCancel),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    openDownload: () => ipcRenderer.invoke(IPC.updateOpenDownload),
    onState: (cb: (s: unknown) => void) => {
      const listener = (_e: unknown, s: unknown) => cb(s)
      ipcRenderer.on(IPC.updateState, listener)
      return () => ipcRenderer.removeListener(IPC.updateState, listener)
    }
  }
}

contextBridge.exposeInMainWorld('mytypeless', api)

export type MyTypelessApi = typeof api
