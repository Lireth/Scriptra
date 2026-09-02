/**
 * Scriptra（观笺）主进程入口
 *
 * 职责：
 * - 创建与管理主窗口
 * - 应用生命周期管理（ready / window-all-closed / activate）
 * - 单实例锁，避免重复启动
 * - 安全策略（CSP 响应头、权限拦截、导航拦截）
 * - 数据库与 IPC 初始化
 */

import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { log } from './logger'
import { closeDb, getDb } from './db/database'
import { registerIpcHandlers } from './ipc/register'
import { libraryDir, coversDir } from './services/library'

const isDev = process.argv.includes('--dev') || !app.isPackaged
/** E2E 自动化测试模式：窗口不显示，通过 CDP 驱动 */
const isE2E = process.env.SCRIPTRA_E2E === '1'
const INDEX_PATH = path.join(__dirname, '../renderer/index.html')
const INDEX_URL = pathToFileURL(INDEX_PATH).href

/** @type {BrowserWindow | null} */
let mainWindow: BrowserWindow | null = null

/* ------------------------------ 单实例锁 ------------------------------ */

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 用户尝试启动第二个实例时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

/* ------------------------------ 安全策略 ------------------------------ */

/**
 * 为页面注入严格的内容安全策略：
 * - 允许内联样式（EPUB/MOBI 章节自带样式）
 * - 允许 data:/blob: 图片（章节内嵌资源以 data URL / Blob 提供）
 */
function configureSecurity(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; "
          + "script-src 'self'; "
          + "style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data: blob:; "
          + "font-src 'self' data:; "
          + "connect-src 'self' data: blob:; "
          + "media-src 'self' data: blob:;",
        ],
      },
    })
  })

  // 拒绝一切权限请求（摄像头、麦克风、地理位置等）
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
}

/**
 * 拦截窗口内导航与弹窗，外部链接交由系统浏览器打开
 */
function attachWindowGuards(win: BrowserWindow): void {
  const { webContents } = win

  webContents.on('will-navigate', (event, url) => {
    if (url !== INDEX_URL) {
      event.preventDefault()
      log.warn(`已拦截非法导航: ${url}`)
    }
  })

  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

/* ------------------------------ 窗口管理 ------------------------------ */

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    title: '观笺 Scriptra',
    backgroundColor: '#f5f3ef',
    show: false, // 等待 ready-to-show 再显示，避免白屏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 开启上下文隔离
      nodeIntegration: false,   // 渲染进程禁用 Node
      sandbox: true,            // 渲染进程运行于沙箱
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  mainWindow = win

  win.loadFile(INDEX_PATH)

  attachWindowGuards(win)

  win.once('ready-to-show', () => {
    if (!isE2E) win.show()
  })

  if (isDev && !isE2E) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  win.on('closed', () => {
    mainWindow = null
  })

  // 渲染进程崩溃等异常事件记录日志
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程异常退出:', details)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload()
    }
  })
  win.webContents.on('unresponsive', () => {
    log.warn('窗口无响应')
  })
}

/* ------------------------------ 应用生命周期 ------------------------------ */

// Windows 任务栏通知分组标识
app.setAppUserModelId('com.scriptra.desktop')

// 未捕获异常与 Promise 拒绝记录日志，避免静默失败
process.on('uncaughtException', (err) => {
  log.error('主进程未捕获异常:', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('主进程未处理的 Promise 拒绝:', reason)
})

app.whenReady().then(() => {
  try {
    // 初始化数据目录与数据库
    libraryDir()
    coversDir()
    getDb()
    log.info('应用启动，版本:', app.getVersion())
  } catch (e) {
    log.error('数据库初始化失败:', e)
    dialog.showErrorBox(
      '观笺 Scriptra 启动失败',
      '本地数据库初始化失败，请检查用户数据目录权限后重试。\n\n'
      + (e instanceof Error ? e.message : String(e)),
    )
    app.quit()
    return
  }

  configureSecurity()
  registerIpcHandlers()

  if (!isDev) {
    Menu.setApplicationMenu(null)
  }

  createMainWindow()

  app.on('activate', () => {
    // macOS 在 Dock 图标点击且无窗口时重建窗口（Windows 下无副作用）
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // 非 macOS 平台关闭所有窗口即退出
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  log.info('应用即将退出')
  closeDb()
})
