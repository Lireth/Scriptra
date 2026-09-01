/**
 * Scriptra（观笺）主进程入口
 *
 * 职责：
 * - 创建与管理主窗口
 * - 应用生命周期管理（ready / window-all-closed / activate）
 * - 单实例锁，避免重复启动
 * - 安全策略（CSP 响应头、权限拦截、导航拦截）
 * - Windows 平台通知栏图标与任务栏分组
 */

const { app, BrowserWindow, session, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const log = require('./logger');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const INDEX_PATH = path.join(__dirname, '../renderer/index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).href;

/** @type {BrowserWindow | null} */
let mainWindow = null;

/* ------------------------------ 单实例锁 ------------------------------ */

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户尝试启动第二个实例时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* ------------------------------ 安全策略 ------------------------------ */

/**
 * 为页面注入严格的内容安全策略（仅拦截网络加载，不影响本地资源）
 */
function configureSecurity() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
            : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
        ],
      },
    });
  });

  // 拒绝一切权限请求（摄像头、麦克风、地理位置等），按需在此放行
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

/**
 * 拦截窗口内导航与弹窗，外部链接交由系统浏览器打开
 */
function attachWindowGuards(win) {
  const { webContents } = win;

  webContents.on('will-navigate', (event, url) => {
    if (url !== INDEX_URL) {
      event.preventDefault();
      log.warn(`已拦截非法导航: ${url}`);
    }
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

/* ------------------------------ 窗口管理 ------------------------------ */

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '观笺 Scriptra',
    backgroundColor: '#f5f6f8',
    show: false, // 等待 ready-to-show 再显示，避免白屏
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 开启上下文隔离
      nodeIntegration: false,   // 渲染进程禁用 Node
      sandbox: true,            // 渲染进程运行于沙箱
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(INDEX_PATH);

  attachWindowGuards(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 渲染进程崩溃等异常事件记录日志
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('渲染进程异常退出:', details);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });
  mainWindow.webContents.on('unresponsive', () => {
    log.warn('窗口无响应');
  });
}

/* ------------------------------ IPC 通信 ------------------------------ */

function registerIpcHandlers() {
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:get-platform', () => process.platform);
}

/* ------------------------------ 应用生命周期 ------------------------------ */

// Windows 任务栏通知分组标识
app.setAppUserModelId('com.scriptra.desktop');

// 未捕获异常与 Promise 拒绝记录日志，避免静默失败
process.on('uncaughtException', (err) => {
  log.error('主进程未捕获异常:', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('主进程未处理的 Promise 拒绝:', reason);
});

app.whenReady().then(() => {
  configureSecurity();
  registerIpcHandlers();

  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  createMainWindow();

  app.on('activate', () => {
    // macOS 在 Dock 图标点击且无窗口时重建窗口（Windows 下无副作用）
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 非 macOS 平台关闭所有窗口即退出
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log.info('应用即将退出');
});
