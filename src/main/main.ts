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

import { app, BrowserWindow, dialog, Menu, net, protocol, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/types'
import { log } from './logger'
import { closeDb, getDb } from './db/database'
import { getBookPaths } from './db/books'
import { registerIpcHandlers } from './ipc/register'
import { libraryDir, coversDir, requestQuitImports } from './services/library'

const isDev = process.argv.includes('--dev') || !app.isPackaged
/** E2E 自动化测试模式：窗口不显示，通过 CDP 驱动 */
const isE2E = process.env.SCRIPTRA_E2E === '1'
const INDEX_PATH = path.join(__dirname, '../renderer/index.html')
const INDEX_URL = pathToFileURL(INDEX_PATH).href

/** 性能基线：主进程模块加载时刻（冷启动各阶段耗时以此为起点，写入 logs/main.log） */
const BOOT_T0 = performance.now()

/** @type {BrowserWindow | null} */
let mainWindow: BrowserWindow | null = null

/* ------------------------------ 单实例锁 ------------------------------ */

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // 用户尝试启动第二个实例时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    // 第二实例携带电子书路径（文件关联双击 / 拖到快捷方式）：转发给现有窗口导入
    const paths = ebookPathsFromArgv(argv)
    if (paths.length && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.EventImportRequest, paths)
    }
  })
}

/** 可导入的电子书扩展名（与 IMPORT_EXTS 对齐，不含 txt：避免误关联普通文本） */
const OPEN_EXTS = new Set(['.epub', '.pdf', '.mobi', '.azw'])

/** 从命令行参数中筛出电子书路径（Windows 文件关联会把文件路径追加到 argv） */
function ebookPathsFromArgv(argv: string[]): string[] {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && OPEN_EXTS.has(path.extname(a).toLowerCase()))
}

/* ------------------------------ 安全策略 ------------------------------ */

// app ready 前：注册封面自定义协议（绕过 CSP，缓存/生命周期交给 Chromium 管理）
protocol.registerSchemesAsPrivileged([
  { scheme: 'cover', privileges: { standard: true, bypassCSP: true } },
])

/** 封面协议：cover://<bookId> 直接读磁盘封面文件，取代逐本 base64 IPC */
function registerCoverProtocol(): void {
  protocol.handle('cover', (request) => {
    const id = new URL(request.url).host
    // 书籍 id 为 UUID，防止借道协议读取任意路径
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      return new Response(null, { status: 400 })
    }
    const paths = getBookPaths(id)
    if (!paths?.coverPath || !fs.existsSync(paths.coverPath)) {
      return new Response(null, { status: 404 })
    }
    return net.fetch(pathToFileURL(paths.coverPath).toString())
  })
}

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
    log.info(`[perf] 窗口首帧就绪(ready-to-show): ${Math.round(performance.now() - BOOT_T0)}ms`)
    if (!isE2E) win.show()
    // 启动参数携带电子书路径（文件关联双击打开）：通知渲染进程导入
    const openPaths = ebookPathsFromArgv(process.argv)
    if (openPaths.length && !mainWindow?.isDestroyed()) {
      mainWindow!.webContents.send(IPC.EventImportRequest, openPaths)
    }
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

// 第二实例：退出并跳过全部全局副作用，避免与主实例竞态
if (!gotTheLock) {
  app.quit()
} else {

// Windows 任务栏通知分组标识
app.setAppUserModelId('com.scriptra.desktop')

// 禁用硬件加速：
// 实测 Windows 下最大化窗口会触发 GPU 进程崩溃（exit_code=34），
// 崩溃后合成器停止更新，整个界面冻结在旧尺寸（右侧留白）。
// 阅读器以文本渲染为主，软件渲染完全够用，可彻底规避该类 GPU 驱动问题。
app.disableHardwareAcceleration()

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
  registerCoverProtocol()
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
  requestQuitImports()
  closeDb()
})

}

