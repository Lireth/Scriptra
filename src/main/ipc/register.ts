/**
 * IPC 接口注册
 *
 * 所有跨进程调用集中在此注册，统一错误记录。
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
  buildOpenPayload, closeSessionFor, deleteBooks, getEpubResource, importFiles, requestCancelImport, scanFolder,
} from '../services/library'
import { getSettings, recordScanFolder, setSettings } from '../services/settings'
import {
  ANN_TYPES, annotationLocator, bool, FORMATS, importPaths, int, oneOf, optStr,
  progressDetail, ratio, STATUSES, str, strArray,
} from './validate'

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
    importFiles(importPaths(paths), event.sender) as Promise<ImportOutcome>)

  handle(IPC.LibraryScan, async (event, folder: string) => {
    const f = str(folder, 1024)
    const r = await scanFolder(f, event.sender) as ImportOutcome
    // 扫描成功后记录历史目录，供工具栏一键重扫
    recordScanFolder(f)
    return r
  })

  handle(IPC.LibraryCancelImport, () => {
    requestCancelImport()
    return true
  })

  handle(IPC.LibraryList, (_e, query: BookQuery) => listBooks(sanitizeQuery(query)))

  handle(IPC.LibraryGet, (_e, id: string) => getBook(str(id, 64)))

  handle(IPC.LibraryUpdate, (_e, id: string, patch: BookUpdatePatch) =>
    updateBook(str(id, 64), sanitizePatch(patch)))

  handle(IPC.LibraryRemove, async (_e, ids: string[]) => {
    await deleteBooks(strArray(ids, 500, 64))
    return true
  })

  handle(IPC.LibraryStats, () => libraryStats())

  handle(IPC.LibraryContinue, () => lastReadBook())

  /* ------------------------------ 阅读 ------------------------------ */

  handle(IPC.BookOpen, async (_e, id: string) => {
    const book = getBook(str(id, 64))
    if (!book) throw new Error('书籍不存在')
    const { payload } = await buildOpenPayload(book)
    return payload
  })

  handle(IPC.BookClose, (_e, id: string) => {
    closeSessionFor(str(id, 64))
    return true
  })

  handle(IPC.BookGetResource, async (_e, id: string, resPath: string) => {
    const res = await getEpubResource(str(id, 64), str(resPath, 2048))
    if (!res) throw new Error(`资源不存在: ${resPath}`)
    return res
  })

  handle(IPC.BookSetProgress, (_e, id: string, progress: number, detail: unknown) => {
    setBookProgress(str(id, 64), ratio(progress), progressDetail(detail))
    return true
  })

  handle(IPC.BookIndexText, (_e, id: string, text: string) => {
    // 截断到索引上限，避免超大字符串在 cjkSpace 正则中长时间占用主进程
    indexBookText(str(id, 64), str(text, 600_000))
    return true
  })

  /* ------------------------------ 注释 ------------------------------ */

  handle(IPC.AnnList, (_e, bookId: string) => listAnnotations(str(bookId, 64)))

  handle(IPC.AnnAdd, (_e, data: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>) => {
    const locator = annotationLocator(data?.locator)
    if (!locator) throw new Error('非法的批注定位')
    const bookId = str(data.bookId, 64)
    if (!getBook(bookId)) throw new Error('书籍不存在')
    return addAnnotation({
      bookId,
      type: oneOf(data.type, ANN_TYPES, 'highlight'),
      color: str(data.color, 32),
      text: str(data.text, 4000),
      note: str(data.note, 8000),
      locator,
    })
  })

  handle(IPC.AnnUpdate, (_e, id: string, patch: { color?: string; note?: string }) =>
    updateAnnotation(str(id, 64), {
      color: optStr(patch?.color, 32),
      note: optStr(patch?.note, 8000),
    }))

  handle(IPC.AnnRemove, (_e, id: string) => {
    removeAnnotation(str(id, 64))
    return true
  })

  /* ------------------------------ 设置与日志 ------------------------------ */

  handle(IPC.SettingsGet, () => getSettings())

  handle(IPC.SettingsSet, (_e, patch: Record<string, unknown>) =>
    setSettings({ scanFolders: strArray(patch?.scanFolders, 100, 1024) }))

  handle(IPC.LogRenderer, (_e, level: string, message: string) => {
    const msg = `[渲染进程] ${str(message, 8000)}`
    const lv = str(level, 16)
    if (lv === 'error') log.renderer.error(msg)
    else if (lv === 'warn') log.renderer.warn(msg)
    else log.renderer.info(msg)
    return true
  })

  /* ------------------------------ 外部链接 ------------------------------ */

  handle(IPC.ShellOpenExternal, (_e, url: string) => {
    const u = str(url, 2048)
    // 仅放行 http/https，防止渲染进程借道打开 file: /自定义协议
    if (/^https?:\/\//i.test(u)) void shell.openExternal(u)
    else log.warn(`已拦截非法外链请求: ${u}`)
    return true
  })
}

/** 书库查询参数净化 */
function sanitizeQuery(q: BookQuery | undefined): BookQuery {
  const out: BookQuery = {}
  if (!q || typeof q !== 'object') return out
  if (typeof q.q === 'string') out.q = str(q.q, 200)
  if (q.status && q.status !== 'all') out.status = oneOf(q.status, STATUSES, 'unread')
  else if (q.status === 'all') out.status = 'all'
  if (typeof q.favorite === 'boolean') out.favorite = q.favorite
  if (typeof q.category === 'string') out.category = str(q.category, 200)
  if (typeof q.author === 'string') out.author = str(q.author, 200)
  if (q.format) out.format = oneOf(q.format, FORMATS, 'epub')
  if (q.sort) out.sort = q.sort
  out.limit = int(q.limit, 120, 1, 500)
  out.offset = int(q.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  return out
}

/** 书籍更新补丁净化（仅保留白名单字段，做枚举/数值/长度校验） */
function sanitizePatch(p: BookUpdatePatch | undefined): BookUpdatePatch {
  const out: BookUpdatePatch = {}
  if (!p || typeof p !== 'object') return out
  if (p.title !== undefined) out.title = str(p.title, 400)
  if (p.author !== undefined) out.author = str(p.author, 200)
  if (p.category !== undefined) out.category = str(p.category, 200)
  if (p.description !== undefined) out.description = str(p.description, 20000)
  if (p.status !== undefined) out.status = oneOf(p.status, STATUSES, 'unread')
  if (p.rating !== undefined) out.rating = int(p.rating, 0, 0, 5)
  if (p.favorite !== undefined) out.favorite = bool(p.favorite)
  return out
}
