/**
 * 阅读器外壳：工具栏 / 目录与批注面板 / 排版设置抽屉 / 选区弹窗 / 进度保存
 */

import {
  HIGHLIGHT_COLORS, type Annotation, type Book, type ReaderStyle, type ThemeName,
} from '../../shared/types'
import { clamp, debounce, el, formatTime } from '../util'
import {
  loadEngineScript, getEngine,
  type EngineCallbacks, type ReaderEngine, type SelectionInfo, type TocEntry,
} from '../engines/types'
import { toast, withToast } from '../components/toast'
import { confirmDialog } from '../components/dialogs'

const FONT_OPTIONS = [
  { label: '系统默认', value: "'Segoe UI', '微软雅黑', 'Microsoft YaHei', sans-serif" },
  { label: '宋体', value: "'宋体', SimSun, serif" },
  { label: '楷体', value: "'楷体', KaiTi, serif" },
  { label: '黑体', value: "'黑体', SimHei, sans-serif" },
  { label: '仿宋', value: "'仿宋', FangSong, serif" },
  { label: '微软雅黑', value: "'微软雅黑', 'Microsoft YaHei', sans-serif" },
  { label: 'Georgia（西文）', value: "Georgia, 'Times New Roman', serif" },
]

const THEME_SWATCHES: { name: ThemeName; label: string; bg: string }[] = [
  { name: 'light', label: '亮色', bg: '#fbfaf7' },
  { name: 'sepia', label: '羊皮纸', bg: '#f4ecd8' },
  { name: 'green', label: '护眼', bg: '#cfe6d0' },
  { name: 'dark', label: '夜间', bg: '#232529' },
]

const STYLE_KEY = 'scriptra.readerStyle'

function defaultStyle(): ReaderStyle {
  return {
    fontFamily: FONT_OPTIONS[0].value,
    fontSize: 18,
    lineHeight: 1.8,
    theme: 'light',
    pageWidth: 780,
  }
}

function loadStyle(): ReaderStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY)
    if (raw) return { ...defaultStyle(), ...JSON.parse(raw) }
  } catch { /* 损坏的配置使用默认值 */ }
  return defaultStyle()
}

export class ReaderView {
  private root: HTMLElement
  private engine: ReaderEngine | null = null
  private book: Book | null = null
  private style: ReaderStyle = loadStyle()
  private annotations: Annotation[] = []
  private tocEntries: TocEntry[] = []
  private currentChapter = 0
  private percent = 0
  private progressLabel = ''
  private lastDetail: unknown = null
  private activePanel: 'toc' | 'ann' | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private selection: SelectionInfo | null = null
  private popup: HTMLElement | null = null
  private openSeq = 0
  private progressEl: HTMLElement | null = null
  private progressTrack: HTMLElement | null = null
  private progressFill: HTMLElement | null = null
  private progressLabelEl: HTMLElement | null = null
  /**
   * 排版变更防抖：MOBI 需整章重渲染、PDF 曾需全页重绘，
   * 滑杆每 tick 直调会连续重排造成卡顿；合并为停顿 150ms 后应用一次
   */
  private applyStyleDebounced = debounce(() => this.engine?.applyStyle(this.style), 150)

  constructor(root: HTMLElement) {
    this.root = root
    this.build()
    // 窗口尺寸变化（最大化 / 还原 / 拖拽边框）时通知阅读引擎重排
    window.addEventListener('resize', () => this.engine?.onResize?.())
  }

  /* ------------------------------ DOM ------------------------------ */

  private build(): void {
    this.root.innerHTML = ''
    this.root.className = 'view reader-view hidden'

    const topbar = el('header', 'reader-topbar')
    topbar.id = 'reader-topbar'

    const back = el('button', 'icon-btn')
    back.title = '返回书库（Esc）'
    back.textContent = '← 书库'
    back.onclick = () => this.close()
    topbar.appendChild(back)

    const title = el('div', 'reader-title')
    title.id = 'reader-title'
    topbar.appendChild(title)

    const chapterSel = el('select', 'chapter-select') as HTMLSelectElement
    chapterSel.id = 'chapter-select'
    chapterSel.onchange = () => {
      const idx = Number(chapterSel.value)
      if (!Number.isNaN(idx)) void this.engine?.goChapter(idx)
    }
    topbar.appendChild(chapterSel)

    const spacer = el('div', 'flex-spacer')
    topbar.appendChild(spacer)

    const btnToc = el('button', 'icon-btn', '目录')
    btnToc.id = 'btn-toc'
    btnToc.onclick = () => this.togglePanel('toc')
    const btnAnn = el('button', 'icon-btn', '批注')
    btnAnn.id = 'btn-ann'
    btnAnn.onclick = () => this.togglePanel('ann')
    const btnMark = el('button', 'icon-btn', '书签')
    btnMark.id = 'btn-bookmark'
    btnMark.onclick = () => void this.addBookmark()
    const btnSettings = el('button', 'icon-btn', '排版')
    btnSettings.id = 'btn-settings'
    btnSettings.onclick = () => this.toggleSettings()
    topbar.appendChild(btnToc)
    topbar.appendChild(btnAnn)
    topbar.appendChild(btnMark)
    topbar.appendChild(btnSettings)

    const body = el('div', 'reader-body')
    const panel = el('aside', 'reader-panel hidden')
    panel.id = 'reader-panel'
    const container = el('div', 'reader-container')
    container.id = 'reader-container'
    body.appendChild(panel)
    body.appendChild(container)

    const bottom = el('footer', 'reader-bottombar')
    const prev = el('button', 'icon-btn', '上一章')
    prev.onclick = () => void this.engine?.prevChapter()
    const next = el('button', 'icon-btn', '下一章')
    next.onclick = () => void this.engine?.nextChapter()
    const progress = el('div', 'reader-progress')
    progress.id = 'reader-progress'
    bottom.appendChild(prev)
    bottom.appendChild(progress)
    bottom.appendChild(next)

    const settings = el('aside', 'reader-settings hidden')
    settings.id = 'reader-settings'

    this.root.appendChild(topbar)
    this.root.appendChild(body)
    this.root.appendChild(bottom)
    this.root.appendChild(settings)
  }

  /* ------------------------------ 打开 / 关闭 ------------------------------ */

  async open(book: Book): Promise<void> {
    // 性能基线：从打开请求到引擎渲染完成的全链路耗时（含 openBook IPC + 引擎脚本加载）
    const openT0 = performance.now()
    if (this.engine) this.closeEngine()
    this.book = book
    const seq = ++this.openSeq

    // 视图切换
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'))
    this.root.classList.remove('hidden')
    const container = document.getElementById('reader-container')!
    container.innerHTML = ''

    const title = document.getElementById('reader-title')!
    title.textContent = `${book.title}${book.author ? ' · ' + book.author : ''}`

    this.activePanel = null
    document.getElementById('reader-panel')?.classList.add('hidden')
    document.getElementById('reader-settings')?.classList.add('hidden')

    let payload
    let annotations
    try {
      // 两请求相互独立，并行拉取缩短白屏
      ;[payload, annotations] = await Promise.all([
        window.scriptra.openBook(book.id),
        window.scriptra.listAnnotations(book.id),
      ])
      // 双击打开不同书时，丢弃过期请求结果
      if (seq !== this.openSeq || this.book?.id !== book.id) return
    } catch (e) {
      if (seq !== this.openSeq) return
      toast(`打开书籍失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      this.close()
      return
    }
    this.annotations = annotations

    const cb: EngineCallbacks = {
      onProgress: (p) => {
        this.percent = p.percent
        this.progressLabel = p.label
        this.lastDetail = p.detail
        this.updateProgressUi()
        this.scheduleSaveProgress(p.percent, p.detail)
      },
      onSelection: (sel) => {
        this.selection = sel
        if (sel) this.showSelectionPopup(sel)
        else this.closePopup()
      },
      onTocReady: (items) => {
        this.tocEntries = items
        this.buildChapterSelect(items)
        if (this.activePanel === 'toc') this.renderTocPanel()
      },
      onChapterChange: (idx) => {
        this.currentChapter = idx
        const sel = document.getElementById('chapter-select') as HTMLSelectElement | null
        if (sel) sel.value = String(idx)
        this.highlightToc(idx)
      },
      onMarkClick: (ann) => this.showAnnPopup(ann),
      onKey: (e) => this.handleKey(e),
    }

    try {
      await loadEngineScript(book.format)
      if (seq !== this.openSeq || this.book?.id !== book.id) return
      this.engine = getEngine(book.format)
      await this.engine.open(container, { ...payload, annotations: this.annotations }, this.style, cb)
      if (seq !== this.openSeq) return
      this.engine.applyStyle(this.style)
      this.applyThemeToChrome()
      this.renderAnnPanel()
      window.scriptra.log('info',
        `[perf] 打开书籍(${book.format}): ${Math.round(performance.now() - openT0)}ms`)
    } catch (e) {
      if (seq !== this.openSeq) return
      toast(`阅读引擎加载失败：${e instanceof Error ? e.message : String(e)}`, 'error', 5000)
      window.scriptra.log('error', `阅读引擎失败: ${e instanceof Error ? e.stack : String(e)}`)
      this.close()
    }
  }

  close(): void {
    this.closePopup()
    this.closeEngine()
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'))
    document.getElementById('view-library')?.classList.remove('hidden')
    void (window as unknown as { __refreshLibrary?: () => void }).__refreshLibrary?.()
  }

  private closeEngine(): void {
    // 先落盘待保存的进度，再清空 book（flushSaveProgress 依赖 this.book）
    this.flushSaveProgress()
    if (this.book) void window.scriptra.closeBook(this.book.id)
    this.engine?.destroy()
    this.engine = null
    this.book = null
  }

  /* ------------------------------ 进度 ------------------------------ */

  private updateProgressUi(): void {
    // 滚动每帧触发，复用子元素仅更新文本与宽度，避免整棵子树反复重建
    const bar = this.progressEl ??= document.getElementById('reader-progress')
    if (!bar) return
    if (!this.progressFill || !this.progressLabelEl || bar.firstChild !== this.progressTrack) {
      bar.innerHTML = ''
      const track = el('div', 'progress-track')
      const fill = el('div', 'progress-fill')
      track.appendChild(fill)
      const label = el('span', 'progress-label')
      bar.appendChild(track)
      bar.appendChild(label)
      this.progressTrack = track
      this.progressFill = fill
      this.progressLabelEl = label
    }
    this.progressFill.style.width = `${(this.percent * 100).toFixed(1)}%`
    this.progressLabelEl.textContent = `${this.progressLabel} · ${Math.round(this.percent * 100)}%`
  }

  private scheduleSaveProgress(percent: number, detail: unknown): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.book) void window.scriptra.setProgress(this.book.id, percent, detail)
    }, 900)
  }

  private flushSaveProgress(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      if (this.book) void window.scriptra.setProgress(this.book.id, this.percent, this.lastDetail)
    }
  }

  /* ------------------------------ 面板 ------------------------------ */

  private togglePanel(kind: 'toc' | 'ann'): void {
    this.activePanel = this.activePanel === kind ? null : kind
    const panel = document.getElementById('reader-panel')
    if (!panel) return
    panel.classList.toggle('hidden', !this.activePanel)
    if (this.activePanel === 'toc') this.renderTocPanel()
    else if (this.activePanel === 'ann') this.renderAnnPanel()
  }

  private renderTocPanel(): void {
    const panel = document.getElementById('reader-panel')
    if (!panel) return
    panel.innerHTML = ''
    panel.appendChild(el('div', 'panel-title', '目录'))
    const list = el('div', 'panel-list')
    if (!this.tocEntries.length) {
      list.appendChild(el('div', 'filter-empty', '本书暂无目录'))
    }
    for (const item of this.tocEntries) {
      const row = el('button', `toc-item${item.index === this.currentChapter ? ' active' : ''}`)
      row.dataset.idx = String(item.index)
      row.style.paddingLeft = `${14 + item.level * 14}px`
      row.textContent = item.title || `第 ${item.index + 1} 节`
      row.onclick = () => void this.engine?.goChapter(item.index)
      list.appendChild(row)
    }
    panel.appendChild(list)
  }

  private renderAnnPanel(): void {
    const panel = document.getElementById('reader-panel')
    if (!panel) return
    panel.innerHTML = ''
    panel.appendChild(el('div', 'panel-title', `批注（${this.annotations.length}）`))
    const list = el('div', 'panel-list')
    if (!this.annotations.length) {
      list.appendChild(el('div', 'filter-empty', '划选正文即可添加高亮或笔记'))
    }
    const sorted = [...this.annotations].sort((a, b) => b.createdAt - a.createdAt)
    for (const ann of sorted) {
      const row = el('div', 'ann-item')
      const head = el('div', 'ann-head')
      const badge = el('span',
        `ann-badge ann-${ann.type}${ann.type === 'highlight' ? '' : ''}`)
      badge.textContent = ann.type === 'bookmark' ? '书签' : ann.type === 'note' ? '笔记' : '高亮'
      if (ann.type === 'highlight') badge.style.background = ann.color || '#ffd54d'
      head.appendChild(badge)
      head.appendChild(el('span', 'ann-time', formatTime(ann.createdAt)))

      const del = el('button', 'ann-del', '删除')
      del.onclick = (e) => {
        e.stopPropagation()
        void withToast('删除批注', async () => {
          await window.scriptra.removeAnnotation(ann.id)
          this.annotations = this.annotations.filter((a) => a.id !== ann.id)
          this.engine?.applyAnnotations(this.annotations)
          this.renderAnnPanel()
        }, () => '已删除')
      }
      head.appendChild(del)
      row.appendChild(head)

      const jump = () => void this.jumpToAnn(ann)
      row.onclick = jump
      if (ann.text) row.appendChild(el('div', 'ann-text', ann.text.slice(0, 120)))
      if (ann.note) row.appendChild(el('div', 'ann-note', `✎ ${ann.note}`))
      list.appendChild(row)
    }
    panel.appendChild(list)
  }

  private async jumpToAnn(ann: Annotation): Promise<void> {
    const loc = ann.locator
    if (loc.kind === 'text' || loc.kind === 'doc') {
      await this.engine?.goChapter(loc.chapter, loc.kind === 'doc' ? loc.ratio : 0)
      if (loc.kind === 'text') await this.focusAnnotationWhenReady(ann.id)
    } else if (loc.kind === 'pdf') {
      await this.engine?.goChapter(loc.page - 1)
      await this.focusAnnotationWhenReady(ann.id)
    } else if (loc.kind === 'page') {
      // PDF 书签：跳转到页并恢复页内偏移
      await this.engine?.goChapter(loc.page - 1, loc.top)
    }
  }

  /**
   * 等待批注标记渲染完成后聚焦：goChapter 返回只代表章节文档已挂载，
   * PDF 页面绘制、快速连续跳章等场景下标记可能稍后才出现，轮询直至命中或超时。
   */
  private async focusAnnotationWhenReady(annId: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.engine?.focusAnnotation?.(annId)) return
      await new Promise((r) => setTimeout(r, 80))
    }
  }

  private highlightToc(index: number): void {
    document.querySelectorAll('.toc-item').forEach((n) => n.classList.remove('active'))
    const active = [...document.querySelectorAll('.toc-item')]
      .find((n) => (n as HTMLElement).dataset.idx === String(index))
    if (active) {
      active.classList.add('active')
      active.scrollIntoView({ block: 'nearest' })
    }
  }

  private buildChapterSelect(items: TocEntry[]): void {
    const sel = document.getElementById('chapter-select') as HTMLSelectElement | null
    if (!sel) return
    sel.innerHTML = ''
    if (!items.length) {
      sel.classList.add('hidden')
      return
    }
    sel.classList.remove('hidden')
    for (const item of items) {
      const opt = new Option(
        item.title || `第 ${item.index + 1} 节`, String(item.index))
      sel.appendChild(opt)
    }
    sel.value = String(this.currentChapter)
    for (const item of items) {
      void item
    }
  }

  /* ------------------------------ 排版设置 ------------------------------ */

  private toggleSettings(): void {
    const drawer = document.getElementById('reader-settings')
    if (!drawer) return
    if (drawer.classList.contains('hidden')) {
      this.renderSettings()
      drawer.classList.remove('hidden')
    } else {
      drawer.classList.add('hidden')
    }
  }

  private renderSettings(): void {
    const drawer = document.getElementById('reader-settings')
    if (!drawer) return
    drawer.innerHTML = ''
    drawer.appendChild(el('div', 'panel-title', '排版设置'))

    // 主题
    const themeRow = el('div', 'setting-row')
    themeRow.appendChild(el('div', 'setting-label', '阅读主题'))
    const swatches = el('div', 'theme-swatches')
    for (const t of THEME_SWATCHES) {
      const sw = el('button', `theme-swatch${this.style.theme === t.name ? ' active' : ''}`)
      sw.style.background = t.bg
      sw.title = t.label
      sw.onclick = () => {
        this.style.theme = t.name
        this.saveStyle()
        this.renderSettings()
      }
      swatches.appendChild(sw)
    }
    themeRow.appendChild(swatches)
    drawer.appendChild(themeRow)

    // 字体
    const fontRow = el('div', 'setting-row')
    fontRow.appendChild(el('div', 'setting-label', '正文字体'))
    const fontSel = el('select', 'form-input') as HTMLSelectElement
    for (const f of FONT_OPTIONS) fontSel.appendChild(new Option(f.label, f.value))
    fontSel.value = this.style.fontFamily
    if (fontSel.selectedIndex < 0) fontSel.selectedIndex = 0
    fontSel.onchange = () => {
      this.style.fontFamily = fontSel.value
      this.saveStyle()
    }
    fontRow.appendChild(fontSel)
    drawer.appendChild(fontRow)

    // 滑杆组
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const row = el('div', 'setting-row')
      const head = el('div', 'setting-label-row')
      head.appendChild(el('div', 'setting-label', label))
      const val = el('span', 'setting-value', fmt(get()))
      head.appendChild(val)
      row.appendChild(head)
      const input = el('input', 'setting-slider') as HTMLInputElement
      input.type = 'range'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(get())
      input.oninput = () => {
        set(Number(input.value))
        val.textContent = fmt(Number(input.value))
        this.saveStyle()
      }
      row.appendChild(input)
      drawer!.appendChild(row)
    }

    slider('字号', 12, 34, 1, () => this.style.fontSize, (v) => {
      this.style.fontSize = v
    }, (v) => `${v}px`)
    slider('行距', 1.4, 2.6, 0.1, () => this.style.lineHeight, (v) => {
      this.style.lineHeight = Math.round(v * 10) / 10
    }, (v) => v.toFixed(1))
    slider('版心宽度', 560, 1200, 20, () => this.style.pageWidth, (v) => {
      this.style.pageWidth = v
    }, (v) => `${v}px`)

    const resetRow = el('div', 'setting-row')
    const reset = el('button', 'btn', '恢复默认')
    reset.onclick = () => {
      this.style = defaultStyle()
      this.saveStyle()
      this.renderSettings()
    }
    resetRow.appendChild(reset)
    drawer.appendChild(resetRow)
  }

  private saveStyle(): void {
    localStorage.setItem(STYLE_KEY, JSON.stringify(this.style))
    this.applyStyleDebounced()
    this.applyThemeToChrome()
  }

  private applyThemeToChrome(): void {
    const root = this.root
    root.classList.remove('theme-light', 'theme-sepia', 'theme-green', 'theme-dark')
    root.classList.add(`theme-${this.style.theme}`)
  }

  /* ------------------------------ 书签 ------------------------------ */

  private async addBookmark(): Promise<void> {
    if (!this.book || !this.engine) return
    const detail = this.lastDetail as { kind?: string; chapter?: number; ratio?: number; page?: number; top?: number } | null
    if (!detail) {
      toast('进度尚未就绪，稍后再试', 'info')
      return
    }
    const locator = detail.kind === 'pdf'
      ? { kind: 'page' as const, page: detail.page ?? 1, top: detail.top ?? 0 }
      : { kind: 'doc' as const, chapter: detail.chapter ?? 0, ratio: detail.ratio ?? 0 }
    await withToast('添加书签', async () => {
      const ann = await window.scriptra.addAnnotation({
        bookId: this.book!.id,
        type: 'bookmark',
        color: '',
        text: '',
        note: '',
        locator,
      })
      this.annotations.push(ann)
      this.renderAnnPanel()
    }, () => '已添加书签')
  }

  /* ------------------------------ 选区弹窗 ------------------------------ */

  private showSelectionPopup(sel: SelectionInfo): void {
    this.closePopup()
    const rect = this.selectionRect()
    if (!rect) return
    const popup = el('div', 'ann-popup')
    popup.id = 'ann-popup'

    const colors = el('div', 'ann-colors')
    for (const c of HIGHLIGHT_COLORS) {
      const dot = el('button', 'color-dot')
      dot.style.background = c
      dot.onclick = (e) => {
        e.stopPropagation()
        void this.createHighlight(sel, c, '')
      }
      colors.appendChild(dot)
    }
    popup.appendChild(colors)

    const actions = el('div', 'ann-actions')
    const noteBtn = el('button', 'btn btn-small', '写笔记')
    noteBtn.onclick = (e) => {
      e.stopPropagation()
      this.showNoteEditor(sel, null)
    }
    const copyBtn = el('button', 'btn btn-small', '复制')
    copyBtn.onclick = (e) => {
      e.stopPropagation()
      void navigator.clipboard.writeText(sel.text)
      toast('已复制', 'success')
    }
    actions.appendChild(noteBtn)
    actions.appendChild(copyBtn)
    popup.appendChild(actions)

    this.positionPopup(popup, rect)
  }

  private showAnnPopup(ann: Annotation): void {
    this.closePopup()
    const popup = el('div', 'ann-popup')

    if (ann.text) popup.appendChild(el('div', 'ann-quote', ann.text.slice(0, 160)))

    const colors = el('div', 'ann-colors')
    for (const c of HIGHLIGHT_COLORS) {
      const dot = el('button', 'color-dot' + (ann.color === c ? ' active' : ''))
      dot.style.background = c
      dot.onclick = (e) => {
        e.stopPropagation()
        void withToast('修改颜色', async () => {
          const updated = await window.scriptra.updateAnnotation(ann.id, { color: c })
          if (updated) this.replaceAnnotation(updated)
        }, () => '已更新')
      }
      colors.appendChild(dot)
    }
    popup.appendChild(colors)

    const actions = el('div', 'ann-actions')
    const editBtn = el('button', 'btn btn-small', ann.type === 'bookmark' ? '重命名' : '编辑笔记')
    editBtn.onclick = (e) => {
      e.stopPropagation()
      this.showNoteEditor(null, ann)
    }
    const delBtn = el('button', 'btn btn-small btn-danger', '删除')
    delBtn.onclick = (e) => {
      e.stopPropagation()
      void withToast('删除批注', async () => {
        await window.scriptra.removeAnnotation(ann.id)
        this.annotations = this.annotations.filter((a) => a.id !== ann.id)
        this.engine?.applyAnnotations(this.annotations)
        this.renderAnnPanel()
        this.closePopup()
      }, () => '已删除')
    }
    actions.appendChild(editBtn)
    actions.appendChild(delBtn)
    popup.appendChild(actions)

    const rect = document.querySelector(`[data-ann="${ann.id}"]`)?.getBoundingClientRect() ?? null
    this.positionPopup(popup, rect)
  }

  private showNoteEditor(sel: SelectionInfo | null, ann: Annotation | null): void {
    const popup = document.getElementById('ann-popup')
    if (!popup) return
    popup.innerHTML = ''
    if (ann?.text) popup.appendChild(el('div', 'ann-quote', ann.text.slice(0, 120)))

    const ta = el('textarea', 'note-input') as HTMLTextAreaElement
    ta.rows = 3
    ta.placeholder = '写下你的想法…'
    ta.value = ann?.note ?? ''
    popup.appendChild(ta)

    const actions = el('div', 'ann-actions')
    const save = el('button', 'btn btn-small btn-primary', '保存')
    save.onclick = (e) => {
      e.stopPropagation()
      const note = ta.value
      void withToast('保存笔记', async () => {
        if (ann) {
          const updated = await window.scriptra.updateAnnotation(ann.id, { note })
          if (updated) this.replaceAnnotation(updated)
        } else if (sel) {
          await this.createHighlight(sel, HIGHLIGHT_COLORS[0], note)
        }
        this.closePopup()
      }, () => '笔记已保存')
    }
    const cancel = el('button', 'btn btn-small', '取消')
    cancel.onclick = (e) => {
      e.stopPropagation()
      if (ann) this.showAnnPopup(ann)
      else this.closePopup()
    }
    actions.appendChild(save)
    actions.appendChild(cancel)
    popup.appendChild(actions)
    ta.focus()
  }

  private async createHighlight(sel: SelectionInfo, color: string, note: string): Promise<void> {
    if (!this.book) return
    await withToast('添加高亮', async () => {
      const ann = await window.scriptra.addAnnotation({
        bookId: this.book!.id,
        type: note ? 'note' : 'highlight',
        color,
        text: sel.text.slice(0, 2000),
        note,
        locator: sel.locator,
      })
      this.annotations.push(ann)
      this.engine?.applyAnnotations(this.annotations)
      this.engine?.clearSelection()
      this.closePopup()
      this.renderAnnPanel()
    }, () => note ? '笔记已添加' : '高亮已添加')
  }

  private replaceAnnotation(updated: Annotation): void {
    const i = this.annotations.findIndex((a) => a.id === updated.id)
    if (i >= 0) this.annotations[i] = updated
    else this.annotations.push(updated)
    this.engine?.applyAnnotations(this.annotations)
    this.renderAnnPanel()
    this.closePopup()
  }

  private selectionRect(): DOMRect | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return rect
  }

  private positionPopup(popup: HTMLElement, rect: DOMRect | null): void {
    const container = document.getElementById('reader-container')
    container?.appendChild(popup)
    // 点击弹窗按钮时阻止焦点移出 iframe，否则 iframe 内选区折叠会提前销毁弹窗（按钮点不到）
    popup.addEventListener('mousedown', (e) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      e.preventDefault()
    })
    const cw = container?.getBoundingClientRect()
    if (!cw) return
    const pw = popup.offsetWidth || 220
    const ph = popup.offsetHeight || 90
    let x: number
    let y: number
    if (rect) {
      x = rect.left - cw.left + rect.width / 2 - pw / 2
      y = rect.top - cw.top - ph - 10
      if (y < 4) y = rect.bottom - cw.top + 10
    } else {
      x = (cw.width - pw) / 2
      y = 60
    }
    popup.style.left = `${clamp(x, 8, Math.max(8, cw.width - pw - 8))}px`
    popup.style.top = `${clamp(y, 8, Math.max(8, cw.height - ph - 8))}px`
  }

  private closePopup(): void {
    document.getElementById('ann-popup')?.remove()
  }

  /* ------------------------------ 外部控制 ------------------------------ */

  handleKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return

    if (e.key === 'Escape') {
      if (document.getElementById('ann-popup')) { this.closePopup(); return }
      if (this.activePanel) { this.togglePanel(this.activePanel); return }
      const drawer = document.getElementById('reader-settings')
      if (drawer && !drawer.classList.contains('hidden')) { drawer.classList.add('hidden'); return }
      this.close()
      return
    }

    if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      void this.addBookmark()
      return
    }
    if (e.ctrlKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault()
      this.togglePanel('toc')
      return
    }
    if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault()
      this.togglePanel('ann')
      return
    }
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      this.style.fontSize = clamp(this.style.fontSize + 1, 12, 34)
      this.saveStyle()
      return
    }
    if (e.ctrlKey && (e.key === '-' || e.key === '_')) {
      e.preventDefault()
      this.style.fontSize = clamp(this.style.fontSize - 1, 12, 34)
      this.saveStyle()
      return
    }

    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault()
      void this.goNext()
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault()
      void this.goPrev()
    }
  }

  /**
   * 方向键 / PgDn 前进：阅读型引擎章内滚动一屏，到章节边界再翻章；
   * PDF（未实现 scrollByScreen）保持整页翻页语义。
   */
  private async goNext(): Promise<void> {
    if (!this.engine) return
    if (this.engine.scrollByScreen && await this.engine.scrollByScreen(1)) return
    await this.engine.nextChapter()
  }

  private async goPrev(): Promise<void> {
    if (!this.engine) return
    if (this.engine.scrollByScreen && await this.engine.scrollByScreen(-1)) return
    await this.engine.prevChapter()
  }
}
