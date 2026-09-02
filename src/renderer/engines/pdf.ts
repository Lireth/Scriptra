/**
 * PDF 阅读引擎（pdf.js v3）
 *
 * - 连续滚动渲染，仅渲染可视页 ±1，控制内存与 GPU 占用
 * - 文本层支持选择与复制
 * - 高亮 / 笔记以归一化矩形叠加在页面上，随缩放自适应
 */

import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { Annotation, ReaderStyle } from '../../shared/types'
import { clamp } from '../util'
import {
  buildTextCache, cacheText, findOccurrences, makeExcerpt, MAX_SEARCH_MARKS,
  READER_THEMES, unwrapMarks, wrapRangeWithClass,
} from './common'
import { registerEngine, type EngineCallbacks, type EnginePayload, type ReaderEngine, type SearchHit, type TocEntry } from './types'

interface PageSlot {
  el: HTMLElement
  canvasBox: HTMLDivElement
  page: number
  rendered: boolean
  renderTask?: { cancel(): void; promise: Promise<unknown> }
  renderToken?: number
  overlay: HTMLDivElement
  width: number
  height: number
}

const pdfjsAny = pdfjsLib as unknown as {
  getDocument(src: {
    data: ArrayBuffer
    cMapUrl?: string
    cMapPacked?: boolean
    standardFontDataUrl?: string
    isEvalSupported?: boolean
  }): { promise: Promise<PDFDocumentProxy> }
  renderTextLayer(params: {
    textContentSource: ReadableStream<unknown> | unknown
    container: HTMLElement
    viewport: unknown
  }): { promise: Promise<void>; cancel(): void }
  GlobalWorkerOptions: { workerSrc: string }
}

if (!pdfjsAny.GlobalWorkerOptions.workerSrc) {
  pdfjsAny.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js'
}

const MAX_CANVAS_DPR = 2

class PdfEngine implements ReaderEngine {
  private container!: HTMLElement
  private scroller!: HTMLElement
  private style!: ReaderStyle
  private cb!: EngineCallbacks
  private payload!: EnginePayload
  private doc: PDFDocumentProxy | null = null
  private slots: PageSlot[] = []
  private annotations: Annotation[] = []
  private current = 1
  private destroyed = false
  private firstPageAspect = 1.414
  private onScrollHandler: (() => void) | null = null
  private mouseUpHandler: (() => void) | null = null
  private clickHandler: ((e: MouseEvent) => void) | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private lastLayoutWidth = 0
  private renderQueued = false
  /** 性能基线：打开时刻与首页渲染完成标记 */
  private openedAt = 0
  private firstPageLogged = false

  async open(
    container: HTMLElement,
    payload: EnginePayload,
    style: ReaderStyle,
    cb: EngineCallbacks,
  ): Promise<void> {
    this.container = container
    this.payload = payload
    this.style = style
    this.cb = cb
    this.annotations = payload.annotations ?? []

    if (!payload.fileData) throw new Error('PDF 文件数据缺失')
    this.doc = await pdfjsAny.getDocument({
      data: payload.fileData,
      cMapUrl: './cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './standard_fonts/',
      // 关闭字体 eval 路径，规避 CVE-2024-4367（渲染不可信 PDF）
      isEvalSupported: false,
    }).promise

    // 用第一页尺寸估算占位高度
    try {
      const p1 = await this.doc.getPage(1)
      const vp = p1.getViewport({ scale: 1 })
      this.firstPageAspect = vp.height / vp.width
      p1.cleanup()
    } catch { /* 使用默认纵横比 */ }

    const n = this.doc.numPages
    this.scroller = document.createElement('div')
    this.scroller.className = 'pdf-reader'
    container.appendChild(this.scroller)

    for (let i = 1; i <= n; i++) {
      const pageEl = document.createElement('div')
      pageEl.className = 'pdf-page'
      pageEl.dataset.page = String(i)
      const canvasBox = document.createElement('div')
      canvasBox.className = 'pdf-canvas-box'
      canvasBox.style.aspectRatio = `1 / ${this.firstPageAspect.toFixed(4)}`
      const overlay = document.createElement('div')
      overlay.className = 'pdf-overlay'
      canvasBox.appendChild(overlay)
      pageEl.appendChild(canvasBox)
      this.scroller.appendChild(pageEl)
      this.slots.push({
        el: pageEl, canvasBox, page: i, rendered: false, overlay, width: 0, height: 0,
      })
    }

    this.onScrollHandler = () => this.scheduleRenderVisible()
    this.scroller.addEventListener('scroll', this.onScrollHandler, { passive: true })

    this.mouseUpHandler = () => this.emitSelection()
    this.scroller.addEventListener('mouseup', this.mouseUpHandler)

    this.clickHandler = (e) => {
      const mark = (e.target as Element).closest?.('.pdf-hl') as HTMLElement | null
      if (mark?.dataset.ann) {
        const ann = this.annotations.find((a) => a.id === mark.dataset.ann)
        if (ann) this.cb.onMarkClick(ann)
      }
    }
    this.scroller.addEventListener('click', this.clickHandler)

    this.applyAnnotations(this.annotations)

    // 恢复进度
    const detail = payload.progressDetail
    const startPage = detail && detail.kind === 'pdf' ? Math.max(1, Math.min(detail.page, n)) : 1
    this.lastLayoutWidth = this.pageWidthPx()
    this.openedAt = performance.now()
    await this.renderVisible()
    if (startPage > 1) {
      const slot = this.slots[startPage - 1]
      if (slot) this.scroller.scrollTop = slot.el.offsetTop + (detail?.kind === 'pdf' ? detail.top * slot.el.offsetHeight : 0)
      await this.renderVisible()
    }
    this.reportProgress()
    cb.onTocReady([])
  }

  private pageWidthPx(): number {
    return Math.max(320, this.scroller.clientWidth - 32)
  }

  /**
   * 窗口尺寸变化（最大化 / 还原 / 拖拽边框）后重排：
   * 按新宽度更新所有页面占位尺寸，重渲染可视页，并保持当前阅读位置
   */
  onResize(): void {
    if (this.destroyed || !this.doc) return
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      this.relayout()
    }, 120)
  }

  private relayout(): void {
    if (this.destroyed || !this.doc || !this.slots.length) return
    const w = this.pageWidthPx()
    if (w === this.lastLayoutWidth) return
    this.lastLayoutWidth = w

    // 记录当前阅读位置（页码 + 页内比例），重排后恢复
    const curSlot = this.slots[this.current - 1]
    let ratio = 0
    if (curSlot && curSlot.el.offsetHeight > 0) {
      ratio = clamp((this.scroller.scrollTop - curSlot.el.offsetTop) / curSlot.el.offsetHeight, 0, 1)
    }

    const placeholderH = `${(w * this.firstPageAspect).toFixed(1)}px`
    for (const slot of this.slots) {
      slot.el.style.width = `${w}px`
      slot.el.style.height = placeholderH
    }

    this.renderVisible()

    if (curSlot) {
      this.scroller.scrollTop = curSlot.el.offsetTop + ratio * curSlot.el.offsetHeight
    }
    this.reportProgress()
  }

  /** 滚动事件用 rAF 合帧，避免每帧同步读全部页的布局属性造成抖动 */
  private scheduleRenderVisible(): void {
    if (this.renderQueued || this.destroyed) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      if (!this.destroyed) this.renderVisible()
    })
  }

  /** 渲染可视页与相邻页 */
  private renderVisible(): void {
    if (this.destroyed || !this.doc) return
    const viewTop = this.scroller.scrollTop
    const viewBottom = viewTop + this.scroller.clientHeight
    const w = this.pageWidthPx()

    let current = 1
    for (const slot of this.slots) {
      const top = slot.el.offsetTop
      // 取"顶部参考线（视口 35% 处）落在哪一页"作为当前页。
      // 若按页底判定，PDF 页高约为视口的 2.4 倍，页码会滞后实际阅读位置 1~2 页，
      // 且恢复进度时 top 被钳制到 1，导致开关书后进度逐渐漂移。
      if (top <= viewTop + this.scroller.clientHeight * 0.35) current = slot.page
    }
    if (current !== this.current) {
      this.current = current
      this.reportProgress()
    }

    for (const slot of this.slots) {
      const top = slot.el.offsetTop
      const bottom = top + slot.el.offsetHeight
      const visible = bottom > viewTop - 800 && top < viewBottom + 800
      if (visible && !slot.rendered) {
        void this.renderPage(slot, w)
      } else if (!visible && slot.rendered) {
        // 释放远处页面，控制内存
        const canvas = slot.canvasBox.querySelector('canvas')
        const textLayer = slot.canvasBox.querySelector('.textLayer')
        canvas?.remove()
        textLayer?.remove()
        slot.rendered = false
      } else if (visible && slot.rendered && slot.width !== w) {
        void this.renderPage(slot, w)
      }
    }
  }

  private async renderPage(slot: PageSlot, width: number): Promise<void> {
    if (this.destroyed || !this.doc) return
    slot.renderTask?.cancel()
    slot.width = width
    // slot 级渲染令牌：并发（如 resize 与初次渲染重叠）时只应用最后一次
    const token = (slot.renderToken = (slot.renderToken ?? 0) + 1)

    let page: PDFPageProxy
    try {
      page = await this.doc.getPage(slot.page)
    } catch { return }
    if (this.destroyed || slot.renderToken !== token) { page.cleanup(); return }

    const base = page.getViewport({ scale: 1 })
    const scale = width / base.width
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR)
    const viewport = page.getViewport({ scale: scale * dpr })

    slot.el.style.width = `${width}px`
    slot.el.style.height = `${(base.height * scale).toFixed(1)}px`

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = `${base.width * scale}px`
    canvas.style.height = `${base.height * scale}px`

    const oldCanvas = slot.canvasBox.querySelector('canvas')
    const oldText = slot.canvasBox.querySelector('.textLayer')
    slot.canvasBox.insertBefore(canvas, slot.canvasBox.firstChild)
    oldCanvas?.remove()
    oldText?.remove()

    try {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const task = page.render({
        canvasContext: ctx,
        viewport,
        // 画布恒为白底；夜间主题由 CSS 反色实现（见 .pdf-dark 规则），无需差异化渲染
        background: '#ffffff',
      })
      slot.renderTask = task
      await task.promise
      if (this.destroyed || slot.renderToken !== token) return

      // 文本层（选择 / 复制）：使用 CSS 尺寸视口，避免 dpr 放大导致文本层超出页面产生横向滚动
      const textEl = document.createElement('div')
      textEl.className = 'textLayer'
      textEl.style.setProperty('--scale-factor', String(scale))
      slot.canvasBox.appendChild(textEl)
      const tc = await page.streamTextContent()
      if (this.destroyed || slot.renderToken !== token) { textEl.remove(); return }
      const tlTask = pdfjsAny.renderTextLayer({
        textContentSource: tc,
        container: textEl,
        viewport: page.getViewport({ scale }),
      })
      slot.renderTask = tlTask
      await tlTask.promise
      if (this.destroyed || slot.renderToken !== token) return

      slot.rendered = true
      if (!this.firstPageLogged) {
        this.firstPageLogged = true
        window.scriptra.log('info',
          `[perf] PDF 首页渲染: ${Math.round(performance.now() - this.openedAt)}ms`)
      }
      this.drawOverlays(slot)
      // 搜索激活时，页面（重）渲染完成后自动重套该页搜索标记（B15：
      // textLayer 随页面重渲染重建，先前套上的标记会随之丢失）
      if (this.searchQuery) {
        const layer = slot.canvasBox.querySelector('.textLayer') as HTMLElement | null
        if (layer) {
          layer.classList.add('has-search-marks')
          this.applySearchMarks(layer)
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'RenderingCancelledException') {
        window.scriptra.log('warn', `PDF 页面渲染失败: ${e}`)
      }
    } finally {
      page.cleanup()
    }
  }

  private drawOverlays(slot: PageSlot): void {
    slot.overlay.innerHTML = ''
    const page = slot.page
    for (const ann of this.annotations) {
      if (ann.locator.kind !== 'pdf' || ann.locator.page !== page) continue
      for (const [l, t, w, h] of ann.locator.rects) {
        const div = document.createElement('div')
        div.className = 'pdf-hl'
        div.dataset.ann = ann.id
        div.style.left = `${(l * 100).toFixed(3)}%`
        div.style.top = `${(t * 100).toFixed(3)}%`
        div.style.width = `${(w * 100).toFixed(3)}%`
        div.style.height = `${(h * 100).toFixed(3)}%`
        div.style.backgroundColor = ann.color || '#ffd54d'
        slot.overlay.appendChild(div)
      }
    }
  }

  private reportProgress(): void {
    if (this.destroyed || !this.doc) return
    const slot = this.slots[this.current - 1]
    let top = 0
    if (slot) {
      const max = Math.max(1, slot.el.offsetHeight - this.scroller.clientHeight)
      top = clamp((this.scroller.scrollTop - slot.el.offsetTop) / max, 0, 1)
    }
    const n = this.doc.numPages
    this.cb.onProgress({
      percent: clamp((this.current - 1 + top) / n, 0, 1),
      label: `第 ${this.current} / ${n} 页`,
      detail: { kind: 'pdf', page: this.current, top },
    })
  }

  private emitSelection(): void {
    if (this.destroyed) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      this.cb.onSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const text = sel.toString()
    if (!text.trim()) {
      this.cb.onSelection(null)
      return
    }
    const pageEl = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement)?.closest('.pdf-page') as HTMLElement | null
    if (!pageEl) {
      this.cb.onSelection(null)
      return
    }
    const box = pageEl.querySelector('.pdf-canvas-box')!.getBoundingClientRect()
    const rects: [number, number, number, number][] = []
    for (const r of [...range.getClientRects()]) {
      if (r.width <= 0.5 || r.height <= 0.5) continue
      const l = clamp((r.left - box.left) / box.width, 0, 1)
      const t = clamp((r.top - box.top) / box.height, 0, 1)
      const w = Math.min(r.width / box.width, 1 - l)
      const h = Math.min(r.height / box.height, 1 - t)
      if (w > 0.001 && h > 0.001) rects.push([l, t, w, h])
      if (rects.length >= 40) break
    }
    if (!rects.length) {
      this.cb.onSelection(null)
      return
    }
    const page = Number(pageEl.dataset.page)
    this.cb.onSelection({
      text,
      locator: { kind: 'pdf', page, rects },
    })
  }

  async goChapter(index: number, ratio = 0): Promise<void> {
    const page = index + 1
    await this.goPage(page, ratio)
  }

  private async goPage(page: number, ratio = 0): Promise<void> {
    if (!this.doc) return
    const p = Math.max(1, Math.min(page, this.doc.numPages))
    const slot = this.slots[p - 1]
    if (slot) {
      this.scroller.scrollTop = slot.el.offsetTop - 8 + ratio * slot.el.offsetHeight
      await this.renderVisible()
    }
  }

  async nextChapter(): Promise<boolean> {
    if (!this.doc || this.current >= this.doc.numPages) return false
    await this.goPage(this.current + 1)
    return true
  }

  async prevChapter(): Promise<boolean> {
    if (this.current <= 1) return false
    await this.goPage(this.current - 1)
    return true
  }

  applyStyle(style: ReaderStyle): void {
    this.style = style
    const t = READER_THEMES[style.theme] ?? READER_THEMES.light
    this.scroller.style.background = t.bg
    // 夜间主题经 CSS 反色实现（.pdf-dark），切换主题无需重绘页面
    this.scroller.classList.toggle('pdf-dark', style.theme === 'dark')
  }

  applyAnnotations(list: Annotation[]): void {
    this.annotations = list
    for (const slot of this.slots) this.drawOverlays(slot)
  }

  clearSelection(): void {
    try { window.getSelection()?.removeAllRanges() } catch { /* 忽略 */ }
  }

  /* ------------------------------ 书内搜索 ------------------------------ */

  private searchSeq = 0
  private searchQuery = ''

  async search(query: string, onProgress?: (done: number, total: number) => void): Promise<SearchHit[]> {
    const seq = ++this.searchSeq
    this.searchQuery = query
    this.clearSearchMarks()
    const hits: SearchHit[] = []
    const needle = query.toLowerCase()
    if (!this.doc || !needle) return hits
    const n = this.doc.numPages
    for (let p = 1; p <= n; p++) {
      if (this.destroyed || seq !== this.searchSeq) return hits
      try {
        const page = await this.doc.getPage(p)
        if (this.destroyed || seq !== this.searchSeq) { page.cleanup(); return hits }
        const tc = await page.getTextContent()
        const text = tc.items.map((it) => ('str' in it ? (it as { str: string }).str : '')).join('')
        for (const [m, occ] of findOccurrences(text, needle).entries()) {
          hits.push({
            chapter: p - 1, matchIndex: m,
            label: `第 ${p} / ${n} 页`,
            excerpt: makeExcerpt(text, occ.start, occ.end),
          })
        }
        page.cleanup()
      } catch { /* 单页提取失败跳过 */ }
      onProgress?.(p, n)
      // 让出主线程，保持搜索期间滚动与输入响应
      if (p % 5 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    return hits
  }

  async goToHit(hit: SearchHit): Promise<void> {
    await this.goPage(hit.chapter + 1)
    await this.highlightSearchHits(hit.chapter + 1, hit.matchIndex)
  }

  clearSearch(): void {
    this.searchSeq++
    this.searchQuery = ''
    this.clearSearchMarks()
  }

  private clearSearchMarks(): void {
    if (!this.scroller) return
    unwrapMarks(this.scroller, 'mark.scriptra-search')
    // 恢复文本层默认透明度（搜索期间临时提升以便看清标记）
    this.scroller.querySelectorAll('.textLayer.has-search-marks')
      .forEach((l) => l.classList.remove('has-search-marks'))
  }

  /** 等待目标页文本层渲染完成 */
  private async waitForTextLayer(page: number, timeoutMs = 3000): Promise<HTMLElement | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.destroyed) return null
      const layer = this.scroller.querySelector(`.pdf-page[data-page="${page}"] .textLayer`) as HTMLElement | null
      if (layer?.querySelector('span')) return layer
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  /**
   * 在指定文本层上套搜索标记，返回聚焦标记（供滚动定位）。
   * focusIndex < 0 时不高亮 current（用于页面重渲染后的自动补套）。
   */
  private applySearchMarks(layer: HTMLElement, focusIndex = -1): HTMLElement | null {
    if (!this.searchQuery) return null
    let cache = buildTextCache(layer)
    const occs = findOccurrences(cacheText(cache), this.searchQuery.toLowerCase(), MAX_SEARCH_MARKS)
    if (!occs.length) return null
    const focusAt = focusIndex >= 0 ? Math.min(focusIndex, occs.length - 1) : -1
    let focusMark: HTMLElement | null = null
    for (const [i, occ] of occs.entries()) {
      const mark = wrapRangeWithClass(document, cache, occ.start, occ.end,
        i === focusAt ? 'scriptra-search current' : 'scriptra-search')
      // splitText 改变文本节点，逐个重建保证后续偏移有效
      cache = buildTextCache(layer)
      if (i === focusAt) focusMark = mark
    }
    return focusMark
  }

  private async highlightSearchHits(page: number, focusIndex: number): Promise<void> {
    const layer = await this.waitForTextLayer(page)
    if (!layer || this.destroyed || !this.searchQuery) return
    this.clearSearchMarks()
    layer.classList.add('has-search-marks')
    const focusMark = this.applySearchMarks(layer, focusIndex)
    focusMark?.scrollIntoView({ block: 'center' })
  }

  focusAnnotation(annId: string): boolean {
    const mark = this.scroller?.querySelector(`.pdf-hl[data-ann="${annId}"]`) as HTMLElement | null
    if (!mark) return false
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
    mark.classList.add('flash')
    setTimeout(() => mark.classList.remove('flash'), 1200)
    return true
  }

  tocEntries(): TocEntry[] {
    return []
  }

  destroy(): void {
    this.destroyed = true
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = null
    }
    if (this.onScrollHandler) this.scroller?.removeEventListener('scroll', this.onScrollHandler)
    if (this.mouseUpHandler) this.scroller?.removeEventListener('mouseup', this.mouseUpHandler)
    if (this.clickHandler) this.scroller?.removeEventListener('click', this.clickHandler)
    for (const slot of this.slots) slot.renderTask?.cancel()
    this.slots = []
    void this.doc?.destroy()
    this.doc = null
    this.scroller?.remove()
  }
}

registerEngine('pdf', () => new PdfEngine())
