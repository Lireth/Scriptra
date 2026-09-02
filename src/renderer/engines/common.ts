/**
 * HTML 文档类引擎基座（EPUB / MOBI / TXT 共用）
 *
 * - 以 sandbox iframe 渲染章节（不执行书内脚本）
 * - 正文文本偏移 <-> DOM 位置双向映射（高亮 / 笔记定位的基础）
 * - 章节滚动进度、选区事件、书内链接拦截、注释回填
 */

import type { Annotation, ReaderStyle } from '../../shared/types'
import {
  el,
} from '../util'
import type {
  EngineCallbacks, EnginePayload, ProgressInfo, ReaderEngine, SelectionInfo, TocEntry,
} from './types'

/* ------------------------------ 文本偏移映射 ------------------------------ */

export interface TextCache {
  nodes: Text[]
  starts: number[]
  total: number
}

const SCRIPT_STYLE_FILTER = (n: Node): number => {
  const p = (n as Text).parentElement
  if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT
  return NodeFilter.FILTER_ACCEPT
}

export function buildTextCache(root: Node): TextCache {
  const nodes: Text[] = []
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: SCRIPT_STYLE_FILTER,
  })
  let n = walker.nextNode()
  while (n) {
    nodes.push(n as Text)
    n = walker.nextNode()
  }
  const starts: number[] = []
  let acc = 0
  for (const t of nodes) {
    starts.push(acc)
    acc += t.data.length
  }
  return { nodes, starts, total: acc }
}

function nearestTextIn(node: Node, forward: boolean): Text | null {
  const walker = node.ownerDocument!.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: SCRIPT_STYLE_FILTER,
  })
  let n = forward ? walker.nextNode() : walker.lastChild()
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) return n as Text
    n = forward ? walker.nextNode() : walker.previousNode()
  }
  return null
}

/** DOM 位置 -> 全文偏移 */
export function globalFromDom(cache: TextCache, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = cache.nodes.indexOf(node as Text)
    if (i >= 0) return cache.starts[i] + Math.min(offset, node.textContent!.length)
    return null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const elNode = node as Element
    const child = elNode.childNodes[offset] ?? elNode.childNodes[offset - 1]
    if (child) {
      const t = nearestTextIn(child, true) ?? (child.parentElement ? nearestTextIn(child.parentElement, true) : null)
      if (t) {
        const i = cache.nodes.indexOf(t)
        if (i >= 0) return cache.starts[i]
      }
    }
  }
  return null
}

/** 全文偏移 -> DOM 位置 */
export function pointFromOffset(cache: TextCache, target: number): { node: Text; offset: number } {
  // 二分查找
  let lo = 0
  let hi = cache.starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cache.starts[mid] <= target) lo = mid
    else hi = mid - 1
  }
  const node = cache.nodes[lo]
  if (!node) {
    // 空文档兜底
    return { node: null as unknown as Text, offset: 0 }
  }
  return { node, offset: Math.min(target - cache.starts[lo], node.data.length) }
}

export function rangeFromOffsets(
  doc: Document,
  cache: TextCache,
  start: number,
  end: number,
): Range | null {
  if (!cache.nodes.length || end <= start) return null
  const a = pointFromOffset(cache, start)
  const b = pointFromOffset(cache, end - 1)
  if (!a.node || !b.node) return null
  const range = doc.createRange()
  try {
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset + 1)
  } catch {
    return null
  }
  return range
}

/** 在选区外套上高亮标记 */
export function wrapRangeWithMark(
  doc: Document,
  cache: TextCache,
  ann: Annotation,
): void {
  const range = rangeFromOffsets(doc, cache, ann.locator.kind === 'text' ? ann.locator.start : 0,
    ann.locator.kind === 'text' ? ann.locator.end : 0)
  if (!range) return

  const root = range.commonAncestorContainer
  const rootEl = root.nodeType === Node.TEXT_NODE ? root.parentElement! : (root as Element)
  const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode: SCRIPT_STYLE_FILTER,
  })
  const targets: Text[] = []
  let n = walker.nextNode()
  while (n) {
    const tn = n as Text
    if (range.intersectsNode(tn) && tn.data.length) targets.push(tn)
    n = walker.nextNode()
  }

  for (const tn of targets) {
    let s = 0
    let e = tn.data.length
    if (tn === range.startContainer) s = range.startOffset
    if (tn === range.endContainer) e = range.endOffset
    if (s >= e) continue

    const mid = s > 0 ? tn.splitText(s) : tn
    const right = e - s < mid.data.length ? mid.splitText(e - s) : mid

    const mark = doc.createElement('mark')
    mark.className = 'scriptra-hl'
    mark.dataset.ann = ann.id
    mark.style.backgroundColor = ann.color || '#ffd54d'
    mark.style.color = 'inherit'
    const parent = right.parentNode
    if (!parent) continue
    parent.insertBefore(mark, right)
    mark.appendChild(right)
  }
}

/* ------------------------------ 样式 ------------------------------ */

export const READER_THEMES: Record<ReaderStyle['theme'], { bg: string; fg: string; link: string }> = {
  light: { bg: '#fbfaf7', fg: '#2c2a25', link: '#3d6a8f' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a6d3b' },
  green: { bg: '#cfe6d0', fg: '#22382a', link: '#3d6a4f' },
  dark: { bg: '#232529', fg: '#c8c4bc', link: '#7fa8c9' },
}

export function readerStyleCss(style: ReaderStyle): string {
  const t = READER_THEMES[style.theme] ?? READER_THEMES.light
  return `
    :root {
      --rf: ${style.fontFamily};
      --rfz: ${style.fontSize}px;
      --rlh: ${style.lineHeight};
      --rbg: ${t.bg};
      --rfg: ${t.fg};
      --rlink: ${t.link};
      --rwidth: ${style.pageWidth}px;
    }
    html { background: var(--rbg); }
    body.scriptra-body {
      background: var(--rbg);
      color: var(--rfg);
      font-family: var(--rf) !important;
      font-size: var(--rfz) !important;
      line-height: var(--rlh) !important;
      max-width: var(--rwidth);
      margin: 0 auto;
      padding: 24px 20px 45vh;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    body.scriptra-body img, body.scriptra-body svg, body.scriptra-body video {
      max-width: 100% !important; height: auto;
    }
    body.scriptra-body a { color: var(--rlink); text-decoration: none; }
    body.scriptra-body p { margin: 0.6em 0; text-align: justify; }
    body.scriptra-body h1, body.scriptra-body h2, body.scriptra-body h3 {
      line-height: 1.4; margin: 1.2em 0 0.7em; text-align: left;
    }
    body.scriptra-body .scriptra-hl { border-radius: 2px; padding: 0 1px; }
    body.scriptra-body .scriptra-hl:hover { filter: brightness(0.94); }
    body.scriptra-body .scriptra-hl.flash {
      outline: 2px solid #e07b39;
      animation: scriptra-flash 1.2s ease-out;
    }
    @keyframes scriptra-flash {
      0% { box-shadow: 0 0 0 4px rgba(224, 123, 57, 0.6); }
      100% { box-shadow: 0 0 0 4px rgba(224, 123, 57, 0); }
    }
    body.scriptra-body ::selection { background: rgba(120, 160, 220, 0.45); }
    /* 隐藏书内原有固定元素，避免遮挡阅读 */
    body.scriptra-body div[class*="fixed"], body.scriptra-body [style*="position:fixed"],
    body.scriptra-body [style*="position: fixed"] { position: static !important; }
  `
}

/* ------------------------------ DocEngine ------------------------------ */

export abstract class DocEngine implements ReaderEngine {
  protected container!: HTMLElement
  protected iframe!: HTMLIFrameElement
  protected iwin!: Window
  protected idoc: Document | null = null
  protected style!: ReaderStyle
  protected cb!: EngineCallbacks
  protected payload!: EnginePayload
  protected annotations: Annotation[] = []
  protected cache: TextCache = { nodes: [], starts: [], total: 0 }
  protected current = -1
  protected destroyed = false
  private renderSeq = 0
  private scrollReport: (() => void) | null = null

  protected abstract get chapterCount(): number
  protected abstract loadChapterHtml(index: number): Promise<string>
  protected get weights(): number[] | null { return null }
  protected tocEntries(): TocEntry[] {
    const list: TocEntry[] = []
    for (let i = 0; i < this.chapterCount; i++) {
      list.push({ title: this.payload.manifest?.spine[i]?.title || `第 ${i + 1} 节`, index: i, level: 0 })
    }
    return list
  }

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

    this.iframe = el('iframe', 'reader-iframe')
    this.iframe.setAttribute('sandbox', 'allow-same-origin')
    container.appendChild(this.iframe)
    this.iwin = this.iframe.contentWindow!

    const detail = payload.progressDetail
    const startChapter = detail && detail.kind === 'doc'
      ? Math.min(detail.chapter, Math.max(0, this.chapterCount - 1))
      : 0
    const startRatio = detail && detail.kind === 'doc' ? detail.ratio : 0

    await this.showChapter(startChapter, startRatio)
    cb.onTocReady(this.tocEntries())
  }

  protected wrapChapterDoc(bodyHtml: string, extraHead = ''): string {
    const title = escapeText(this.payload.title)
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>`
      + `<style>${readerStyleCss(this.style)}</style>${extraHead}</head>`
      + `<body class="scriptra-body">${bodyHtml}</body></html>`
  }

  /** 渲染章节并等待 iframe 加载完成 */
  protected async showChapter(index: number, restoreRatio = 0, anchor = ''): Promise<void> {
    if (this.destroyed) return
    // 并发保护：快速翻章时只应用最后一次请求，丢弃被覆盖的过期渲染
    const seq = ++this.renderSeq
    const html = await this.loadChapterHtml(index)
    if (this.destroyed || seq !== this.renderSeq) return
    this.current = index

    await new Promise<void>((resolve) => {
      const frame = this.iframe
      const onLoad = () => {
        frame.removeEventListener('load', onLoad)
        resolve()
      }
      frame.addEventListener('load', onLoad)
      frame.srcdoc = html
    })
    if (this.destroyed || seq !== this.renderSeq) return

    this.idoc = this.iframe.contentDocument ?? this.iframe.contentWindow!.document
    this.iwin = this.iframe.contentWindow!
    this.rebuildTextCache()
    this.applyAnnotations(this.annotations)

    this.attachChapterEvents()

    // 恢复位置
    if (anchor) {
      const target = this.idoc.getElementById(anchor)
        ?? this.idoc.getElementsByName?.(anchor)[0]
      if (target) {
        ;(target as HTMLElement).scrollIntoView({ block: 'start' })
        this.reportProgress()
        return
      }
    }
    this.scrollToRatio(restoreRatio)
    this.reportProgress()
    this.cb.onChapterChange(index)
  }

  protected attachChapterEvents(): void {
    if (!this.idoc) return
    const doc = this.idoc
    const win = this.iwin

    if (this.scrollReport) {
      win.removeEventListener('scroll', this.scrollReport)
    }
    this.scrollReport = () => this.reportProgress()
    win.addEventListener('scroll', this.scrollReport, { passive: true })

    doc.onmouseup = () => this.emitSelection()
    doc.onkeyup = () => this.emitSelection()
    // 焦点进入 iframe 后键盘事件不会冒泡到主文档，这里转发给外壳统一处理
    doc.onkeydown = (e) => this.cb.onKey?.(e)
    doc.onselectionchange = () => {
      const sel = win.getSelection()
      if (!sel || sel.isCollapsed) this.cb.onSelection(null)
    }

    doc.onclick = (e) => {
      const target = e.target as Element
      // 高亮标记点击
      const mark = target.closest?.('.scriptra-hl') as HTMLElement | null
      if (mark?.dataset.ann) {
        const ann = this.annotations.find((a) => a.id === mark.dataset.ann)
        if (ann) {
          e.preventDefault()
          this.cb.onMarkClick(ann)
          return
        }
      }
      // 链接拦截
      const link = target.closest?.('a[href]') as HTMLAnchorElement | null
      if (link) {
        e.preventDefault()
        this.handleLink(link.getAttribute('href') || '')
      }
    }
  }

  protected handleLink(href: string): void {
    if (!href) return
    if (href.startsWith('#')) {
      const target = this.idoc?.getElementById(href.slice(1))
      if (target) target.scrollIntoView({ block: 'start' })
      return
    }
    const [path, frag] = href.split('#')
    const idx = this.chapterIndexByHref(decodeURIComponent(path))
    if (idx >= 0) {
      void this.showChapter(idx, 0, frag)
    }
  }

  protected chapterIndexByHref(_href: string): number {
    return -1
  }

  protected rebuildTextCache(): void {
    if (this.idoc?.body) this.cache = buildTextCache(this.idoc.body)
    else this.cache = { nodes: [], starts: [], total: 0 }
  }

  protected scrollToRatio(ratio: number): void {
    const win = this.iwin
    const max = win.document.documentElement.scrollHeight - win.innerHeight
    win.scrollTo(0, Math.max(0, max * clamp01(ratio)))
  }

  protected readingRatio(): number {
    const docEl = this.iwin.document.documentElement
    const max = docEl.scrollHeight - this.iwin.innerHeight
    if (max <= 0) return 1
    return clamp01(this.iwin.scrollY / max)
  }

  protected percentFor(index: number, ratio: number): number {
    const w = this.weights
    const count = Math.max(1, this.chapterCount)
    if (w && w.length === count) {
      const total = w.reduce((s, x) => s + x, 0) || 1
      const before = w.slice(0, index).reduce((s, x) => s + x, 0)
      return clamp01((before + w[index] * ratio) / total)
    }
    return clamp01((index + ratio) / count)
  }

  protected reportProgress(): void {
    if (this.destroyed || this.current < 0) return
    const ratio = this.readingRatio()
    const p: ProgressInfo = {
      percent: this.percentFor(this.current, ratio),
      label: `第 ${this.current + 1} / ${this.chapterCount} 章`,
      detail: { kind: 'doc', chapter: this.current, ratio },
    }
    this.cb.onProgress(p)
  }

  protected emitSelection(): void {
    if (this.destroyed) return
    const sel = this.iwin.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
      this.cb.onSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    let start = globalFromDom(this.cache, range.startContainer, range.startOffset)
    let end = globalFromDom(this.cache, range.endContainer, range.endOffset)
    if (start === null || end === null) {
      this.cb.onSelection(null)
      return
    }
    if (start > end) [start, end] = [end, start]
    if (end - start < 1) {
      this.cb.onSelection(null)
      return
    }
    const info: SelectionInfo = {
      text: sel.toString(),
      locator: { kind: 'text', chapter: this.current, start, end },
    }
    this.cb.onSelection(info)
  }

  /* ------------------------------ 接口实现 ------------------------------ */

  async goChapter(index: number, ratio = 0): Promise<void> {
    const idx = Math.max(0, Math.min(index, this.chapterCount - 1))
    if (idx === this.current) {
      if (ratio > 0) this.scrollToRatio(ratio)
      else this.iwin.scrollTo(0, 0)
      this.reportProgress()
      return
    }
    await this.showChapter(idx, ratio)
  }

  async nextChapter(): Promise<boolean> {
    if (this.current >= this.chapterCount - 1) return false
    await this.showChapter(this.current + 1, 0)
    return true
  }

  async prevChapter(): Promise<boolean> {
    if (this.current <= 0) return false
    await this.showChapter(this.current - 1, 0)
    return true
  }

  applyStyle(style: ReaderStyle): void {
    this.style = style
    if (!this.idoc) return
    let styleEl = this.idoc.getElementById('scriptra-style') as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = this.idoc.createElement('style')
      styleEl.id = 'scriptra-style'
      this.idoc.head.appendChild(styleEl)
    }
    styleEl.textContent = readerStyleCss(style)
  }

  applyAnnotations(list: Annotation[]): void {
    this.annotations = list
    if (!this.idoc?.body) return
    // 清除旧标记后重新套用当前章节的高亮
    this.idoc.querySelectorAll('mark.scriptra-hl').forEach((m) => unwrapMark(m as HTMLElement))
    this.rebuildTextCache()
    for (const ann of list) {
      if (ann.locator.kind !== 'text') continue
      if (ann.locator.chapter !== this.current) continue
      wrapRangeWithMark(this.idoc, this.cache, ann)
      // wrapRangeWithMark 内部 splitText 会改变文本节点，使 cache 失效；
      // 每应用一个高亮即重建，保证后续高亮基于最新偏移定位
      this.rebuildTextCache()
    }
  }

  clearSelection(): void {
    try { this.iwin.getSelection()?.removeAllRanges() } catch { /* 忽略 */ }
  }

  focusAnnotation(annId: string): void {
    const mark = this.idoc?.querySelector(`mark[data-ann="${annId}"]`) as HTMLElement | null
    if (!mark) return
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
    mark.classList.add('flash')
    setTimeout(() => mark.classList.remove('flash'), 1200)
  }

  destroy(): void {
    this.destroyed = true
    if (this.scrollReport && this.iwin) {
      this.iwin.removeEventListener('scroll', this.scrollReport)
      this.scrollReport = null
    }
    this.idoc = null
    this.cache = { nodes: [], starts: [], total: 0 }
    this.iframe?.remove()
  }
}

function unwrapMark(mark: HTMLElement): void {
  const parent = mark.parentNode
  if (!parent) return
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
  parent.removeChild(mark)
  parent.normalize()
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v || 0))
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}
