/**
 * IPC 接口注册
 *
 * 所有跨进程调用集中在此注册，统一错误记录。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  IPC, type Annotation, type BookQuery, type BookUpdatePatch, type ImportOutcome,
} from '../../shared/types'
import { log } from '../logger'
import {
  addAnnotation, listAnnotations, removeAnnotation, updateAnnotation,
} from '../db/annotations'
import {
  getBook, indexBookText, lastReadBook, libraryStats, listBooks, setBookProgress, updateBook,
} from '../db/books'
import {
  buildOpenPayload, closeSessionFor, coverDataUrl, deleteBooks, getEpubResource, importFiles, scanFolder,
} from '../services/library'
import { getSettings, setSettings } from '../services/settings'

function handle(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args as never[])
    } catch (e) {
      log.error(`IPC ${channel} 处理失败:`, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  })
}

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerIpcHandlers(): void {
  /* ------------------------------ 应用 ------------------------------ */

  handle(IPC.AppGetInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))

  handle(IPC.DialogPickFiles, async (event) => {
    const win = senderWindow(event)
    const opts: Electron.OpenDialogOptions = {
      title: '导入电子书',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '电子书', extensions: ['epub', 'pdf', 'mobi', 'azw', 'txt'] },
        { name: 'EPUB', extensions: ['epub'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'MOBI / AZW', extensions: ['mobi', 'azw'] },
        { name: 'TXT', extensions: ['txt'] },
      ],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  handle(IPC.DialogPickFolder, async (event) => {
    const win = senderWindow(event)
    const opts: Electron.OpenDialogOptions = {
      title: '选择要扫描的文件夹',
      properties: ['openDirectory'],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  /* ------------------------------ 书库 ------------------------------ */

  handle(IPC.LibraryImport, (event, paths: string[]) =>
    importFiles(Array.isArray(paths) ? paths : [], event.sender) as Promise<ImportOutcome>)

  handle(IPC.LibraryScan, (event, folder: string) =>
    scanFolder(String(folder), event.sender) as Promise<ImportOutcome>)

  handle(IPC.LibraryList, (_e, query: BookQuery) => listBooks(query ?? {}))

  handle(IPC.LibraryGet, (_e, id: string) => getBook(String(id)))

  handle(IPC.LibraryUpdate, (_e, id: string, patch: BookUpdatePatch) =>
    updateBook(String(id), patch ?? {}))

  handle(IPC.LibraryRemove, async (_e, ids: string[]) => {
    const list = Array.isArray(ids) ? ids.map(String) : []
    await deleteBooks(list)
    return true
  })

  handle(IPC.LibraryStats, () => libraryStats())

  handle(IPC.LibraryCover, (_e, id: string) => coverDataUrl(String(id)) ?? '')

  handle(IPC.LibraryContinue, () => lastReadBook())

  /* ------------------------------ 阅读 ------------------------------ */

  handle(IPC.BookOpen, async (_e, id: string) => {
    const book = getBook(String(id))
    if (!book) throw new Error('书籍不存在')
    const { payload } = await buildOpenPayload(book)
    return payload
  })

  handle(IPC.BookClose, (_e, id: string) => {
    closeSessionFor(String(id))
    return true
  })

  handle(IPC.BookGetResource, async (_e, id: string, resPath: string) => {
    const res = await getEpubResource(String(id), String(resPath))
    if (!res) throw new Error(`资源不存在: ${resPath}`)
    return res
  })

  handle(IPC.BookSetProgress, (_e, id: string, progress: number, detail: unknown) => {
    setBookProgress(String(id), Number(progress) || 0, detail as never)
    return true
  })

  handle(IPC.BookIndexText, (_e, id: string, text: string) => {
    indexBookText(String(id), String(text ?? ''))
    return true
  })

  /* ------------------------------ 注释 ------------------------------ */

  handle(IPC.AnnList, (_e, bookId: string) => listAnnotations(String(bookId)))

  handle(IPC.AnnAdd, (_e, data: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>) =>
    addAnnotation({
      bookId: String(data.bookId),
      type: data.type,
      color: data.color,
      text: data.text,
      note: data.note,
      locator: data.locator,
    }))

  handle(IPC.AnnUpdate, (_e, id: string, patch: { color?: string; note?: string }) =>
    updateAnnotation(String(id), patch ?? {}))

  handle(IPC.AnnRemove, (_e, id: string) => {
    removeAnnotation(String(id))
    return true
  })

  /* ------------------------------ 设置与日志 ------------------------------ */

  handle(IPC.SettingsGet, () => getSettings())

  handle(IPC.SettingsSet, (_e, patch: Record<string, unknown>) => setSettings(patch as never))

  handle(IPC.LogRenderer, (_e, level: string, message: string) => {
    const msg = `[渲染进程] ${message}`
    if (level === 'error') log.renderer.error(msg)
    else if (level === 'warn') log.renderer.warn(msg)
    else log.renderer.info(msg)
    return true
  })
}
