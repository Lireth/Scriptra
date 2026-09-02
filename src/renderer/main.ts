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
  if (!typing && e.key === 'Enter') {
    libraryView.openSelected()
    return
  }
  if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
    libraryView.removeSelected()
  }
})

/* ------------------------------ 启动 ------------------------------ */

void libraryView.refresh()

window.scriptra.getInfo().then((info) => {
  document.documentElement.dataset.appVersion = info.version
}).catch(() => undefined)
