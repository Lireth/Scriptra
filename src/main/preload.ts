/**
 * 预加载脚本（Preload）
 *
 * 通过 contextBridge 向渲染进程暴露类型化、最小化的 API。
 * 所有跨进程调用都走显式方法（无通用 invoke），通道白名单由代码本身保证。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  if (!Object.values(IPC).includes(channel as never)) {
    throw new Error(`未授权的 IPC 通道: ${channel}`)
  }
  return ipcRenderer.invoke(channel, ...args)
}

contextBridge.exposeInMainWorld('scriptra', {
  /* ------------------------------ 应用 ------------------------------ */
  getInfo: () => invoke(IPC.AppGetInfo),

  /* ------------------------------ 对话框 ------------------------------ */
  pickFiles: () => invoke(IPC.DialogPickFiles),
  pickFolder: () => invoke(IPC.DialogPickFolder),

  /* ------------------------------ 书库 ------------------------------ */
  importFiles: (paths: string[]) => invoke(IPC.LibraryImport, paths),
  scanFolder: (folder: string) => invoke(IPC.LibraryScan, folder),
  cancelImport: () => invoke(IPC.LibraryCancelImport),
  /** 拖拽落下的 File 对象转本地路径（必须在 preload 侧调用 webUtils） */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  listBooks: (query: unknown) => invoke(IPC.LibraryList, query),
  getBook: (id: string) => invoke(IPC.LibraryGet, id),
  updateBook: (id: string, patch: unknown) => invoke(IPC.LibraryUpdate, id, patch),
  removeBooks: (ids: string[]) => invoke(IPC.LibraryRemove, ids),
  stats: () => invoke(IPC.LibraryStats),
  continueReading: () => invoke(IPC.LibraryContinue),

  /* ------------------------------ 阅读 ------------------------------ */
  openBook: (id: string) => invoke(IPC.BookOpen, id),
  closeBook: (id: string) => invoke(IPC.BookClose, id),
  getResource: (id: string, path: string) => invoke(IPC.BookGetResource, id, path),
  setProgress: (id: string, progress: number, detail: unknown) =>
    invoke(IPC.BookSetProgress, id, progress, detail),
  indexText: (id: string, text: string) => invoke(IPC.BookIndexText, id, text),

  /* ------------------------------ 注释 ------------------------------ */
  listAnnotations: (bookId: string) => invoke(IPC.AnnList, bookId),
  addAnnotation: (data: unknown) => invoke(IPC.AnnAdd, data),
  updateAnnotation: (id: string, patch: unknown) => invoke(IPC.AnnUpdate, id, patch),
  removeAnnotation: (id: string) => invoke(IPC.AnnRemove, id),
  exportAnnotations: (bookId: string, format: 'md' | 'json') => invoke(IPC.AnnExport, bookId, format),
  importAnnotations: () => invoke(IPC.AnnImport),

  /* ------------------------------ 设置与日志 ------------------------------ */
  getSettings: () => invoke(IPC.SettingsGet),
  setSettings: (patch: unknown) => invoke(IPC.SettingsSet, patch),
  log: (level: 'info' | 'warn' | 'error', message: string) =>
    invoke(IPC.LogRenderer, level, String(message)),
  openExternal: (url: string) => invoke(IPC.ShellOpenExternal, url),

  /** 监听导入进度事件，返回取消监听函数 */
  onImportProgress: (handler: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on(IPC.EventImportProgress, listener as never)
    return () => ipcRenderer.removeListener(IPC.EventImportProgress, listener as never)
  },

  /** 监听文件关联 / 第二实例触发的导入请求，返回取消监听函数 */
  onImportRequest: (handler: (paths: string[]) => void): (() => void) => {
    const listener = (_event: unknown, paths: unknown) => {
      if (Array.isArray(paths)) handler(paths.filter((x): x is string => typeof x === 'string'))
    }
    ipcRenderer.on(IPC.EventImportRequest, listener as never)
    return () => ipcRenderer.removeListener(IPC.EventImportRequest, listener as never)
  },
})
