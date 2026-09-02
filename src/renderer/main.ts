/**
 * 渲染进程入口：视图装配与全局快捷键
 */

import { setupErrorReporting } from './errors'
import { LibraryView } from './views/library'
import { ReaderView } from './views/reader'
import { showHelpDialog } from './components/dialogs'

setupErrorReporting()

const libraryView = new LibraryView(document.getElementById('view-library')!)
const readerView = new ReaderView(document.getElementById('view-reader')!)

libraryView.onOpenBook = (book) => void readerView.open(book)
;(window as unknown as { __refreshLibrary?: () => void }).__refreshLibrary = () => {
  void libraryView.refresh()
}

/* ------------------------------ 全局快捷键 ------------------------------ */

function isReaderActive(): boolean {
  return !document.getElementById('view-reader')?.classList.contains('hidden')
}

/* ------------------------------ 拖拽导入 ------------------------------ */

/** 与主进程 IMPORT_EXTS 对齐（拖拽侧先过滤，避免目录/无关文件进入导入流程） */
const DROP_EXTS = new Set(['.epub', '.pdf', '.mobi', '.azw', '.txt'])

window.addEventListener('dragover', (e) => {
  if (isReaderActive()) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
})
window.addEventListener('drop', (e) => {
  if (isReaderActive()) return
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files
    .map((f) => window.scriptra.pathForFile(f))
    .filter((p) => DROP_EXTS.has(p.slice(p.lastIndexOf('.')).toLowerCase()))
  if (paths.length) void libraryView.importPaths(paths)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault()
    showHelpDialog()
    return
  }

  if (isReaderActive()) {
    readerView.handleKey(e)
    return
  }

  // 书库快捷键
  const target = e.target as HTMLElement
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

  if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault()
    if (e.shiftKey) void libraryView.scanFolder()
    else void libraryView.importFiles()
    return
  }
  if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    libraryView.focusSearch()
    return
  }
  if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    // 书库方向键导航（卡片有焦点时由卡片自身处理，此处兜底无焦点场景）
    e.preventDefault()
    const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1
    libraryView.moveSelection(dir)
    return
  }
  if (!typing && e.key === 'Enter') {
    libraryView.openSelected()
    return
  }
  if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
    libraryView.removeSelected()
  }
})

/* ------------------------------ 启动 ------------------------------ */

// 文件关联 / 第二实例触发：双击电子书文件直接导入并打开书库刷新
window.scriptra.onImportRequest((paths) => {
  if (paths.length) void libraryView.importPaths(paths)
})

// 性能基线：书库首屏数据拉取 + 渲染完成时刻（页面导航起算）
void libraryView.refresh().then(() => {
  window.scriptra.log('info', `[perf] 书库首屏就绪: ${Math.round(performance.now())}ms`)
})

window.scriptra.getInfo().then((info) => {
  document.documentElement.dataset.appVersion = info.version
}).catch(() => undefined)
