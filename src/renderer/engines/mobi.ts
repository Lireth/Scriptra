/**
 * MOBI / AZW 阅读引擎（基于内置 foliate-js 引擎）
 *
 * - MOBI6（PalmDoc / HUFF-CDIC）与 KF8 均可打开
 * - 图片资源由引擎转换为 blob: URL
 * - 打开后若主进程未建立全文索引，则回传文本延迟建索引
 */

import type { Annotation, ReaderStyle } from '../../shared/types'
import {
  buildTextCache, globalFromDom, wrapRangeWithMark, type TextCache,
} from './common'
import { registerEngine, type EngineCallbacks, type EnginePayload, type ReaderEngine, type TocEntry } from './types'
// @ts-expect-error 第三方 ESM 模块，无类型声明
import { MOBI } from '../vendor/foliate-mobi.js'

interface FoliateSection {
  id: number
  size: number
  createDocument(): Promise<Document>
}

interface FoliateBook {
  sections: FoliateSection[]
  toc?: { label?: string; href?: string; subitems?: unknown[] }[]
  metadata: { title?: string; author?: string[] | string }
  replaceResources(target: Document | string): Promise<unknown>
  resolveHref(href: string): { index: number } | null
  destroy(): void
}

class MobiEngine implements ReaderEngine {
  private container!: HTMLElement
  private iframe!: HTMLIFrameElement
  private style!: ReaderStyle
  private cb!: EngineCallbacks
  private payload!: EnginePayload
  private annotations: Annotation[] = []
  private book: FoliateBook | null = null
  private isKF8 = false
  private weights: number[] = []
  private tocList: TocEntry[] = []
  private current = -1
  private destroyed = false
  private cache: TextCache = { nodes: [], starts: [], total: 0 }
  private parser = new DOMParser()
  private serializer = new XMLSerializer()
  private indexSent = false

  private get chapterCount(): number {
    return this.book?.sections.length ?? 0
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

    if (!payload.fileData) throw new Error('MOBI 文件数据缺失')
    const mobi = new MOBI({ unzlib: undefined })
    const book = (await mobi.open(new Blob([payload.fileData]))) as FoliateBook
    this.book = book
    const headers = (mobi as unknown as {
      headers?: { mobi?: { version: number }; kf8?: unknown }
    }).headers
    this.isKF8 = !!(headers && (headers.mobi?.version ?? 0) >= 8 || headers?.kf8)

    this.weights = book.sections.map((s) => Math.max(1, s.size))

    // 目录扁平化
    const flat: { label: string; href: string; level: number }[] = []
    const walk = (items: { label?: string; href?: string; subitems?: { label?: string; href?: string; subitems?: unknown[] }[] }[], level: number) => {
      for (const it of items ?? []) {
        if (it.href) flat.push({ label: it.label ?? '', href: it.href, level })
        if (it.subitems?.length) walk(it.subitems as never, level + 1)
      }
    }
    walk((book.toc ?? []) as never, 0)
    this.tocList = []
    for (const item of flat) {
      try {
        const loc = book.resolveHref(item.href)
        if (loc && loc.index >= 0 && loc.index < this.chapterCount) {
          this.tocList.push({ title: item.label || `第 ${loc.index + 1} 节`, index: loc.index, level: item.level })
        }
      } catch { /* 忽略无法解析的目录项 */ }
    }
    if (!this.tocList.length) {
      this.tocList = book.sections.map((s, i) => ({ title: `第 ${i + 1} 节`, index: i, level: 0 }))
    }

    // iframe（不执行书内脚本）
    this.iframe = document.createElement('iframe')
    this.iframe.className = 'reader-iframe'
    this.iframe.setAttribute('sandbox', 'allow-same-origin')
    container.appendChild(this.iframe)

    const detail = payload.progressDetail
    const startChapter = detail && detail.kind === 'doc'
      ? Math.min(detail.chapter, Math.max(0, this.chapterCount - 1)) : 0
    const startRatio = detail && detail.kind === 'doc' ? detail.ratio : 0

    await this.showChapter(startChapter, startRatio)
    cb.onTocReady(this.tocList)

    // 延迟建立全文索引
    if (!payload.contentIndexed && !this.indexSent) {
      this.indexSent = true
      this.collectTextForIndex()
    }
  }

  /** 解压全文（渲染进程内已完成解压），回传主进程建索引 */
  private collectTextForIndex(): void {
    const book = this.book
    if (!book) return
    const jobs = book.sections.map((s) => s.createDocument())
    void Promise.all(jobs).then((docs) => {
      let text = ''
      for (const d of docs) text += (d.body?.innerText ?? d.body?.textContent ?? '') + '\n'
      text = text.replace(/\s+/g, ' ').trim().slice(0, 600_000)
      if (text.length > 50) {
        void window.scriptra.indexText(this.payload.id, text)
      }
    }).catch(() => undefined)
  }

  private async loadChapterHtml(index: number): Promise<string> {
    const book = this.book!
    const section = book.sections[index]
    if (!section) return '<p style="opacity:.6">章节不存在</p>'
    let doc: Document
    try {
      doc = await section.createDocument()
      if (!this.isKF8) {
        await book.replaceResources(doc)
      } else {
        // KF8 的资源替换基于字符串
        const str = this.serializer.serializeToString(doc)
        const replaced = await book.replaceResources(str)
        doc = this.parser.parseFromString(String(replaced), 'text/html')
      }
    } catch (e) {
      return `<p style="opacity:.6">章节渲染失败：${e instanceof Error ? e.message : e}</p>`
    }
    doc.querySelectorAll('script').forEach((s) => s.remove())
    doc.querySelectorAll('a[href^="javascript:"]').forEach((a) => a.removeAttribute('href'))
    return this.wrapDoc(doc)
  }

  private wrapDoc(doc: Document): string {
    const t = this.style
    const theme = { light: { bg: '#fbfaf7', fg: '#2c2a25' }, sepia: { bg: '#f4ecd8', fg: '#5b4636' }, green: { bg: '#cfe6d0', fg: '#22382a' }, dark: { bg: '#232529', fg: '#c8c4bc' } }[t.theme]
      ?? { bg: '#fbfaf7', fg: '#2c2a25' }
    const css = `
      body { background:${theme.bg}; color:${theme.fg}; font-family:${t.fontFamily};
        font-size:${t.fontSize}px; line-height:${t.lineHeight}; max-width:${t.pageWidth}px;
        margin:0 auto; padding:24px 20px 45vh; word-wrap:break-word; }
      img, svg { max-width:100% !important; height:auto; }
      a { color:#3d6a8f; text-decoration:none; }
      p { margin:0.6em 0; text-align:justify; }
      .scriptra-hl { border-radius:2px; padding:0 1px; }
      .scriptra-hl.flash { outline:2px solid #e07b39; animation:scriptra-flash 1.2s ease-out; }
      @keyframes scriptra-flash {
        0% { box-shadow:0 0 0 4px rgba(224,123,57,0.6); }
        100% { box-shadow:0 0 0 4px rgba(224,123,57,0); }
      }
      ::selection { background:rgba(120,160,220,0.45); }
    `
    const inner = doc.body?.innerHTML ?? doc.documentElement.innerHTML
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${inner}</body></html>`
  }

  private async showChapter(index: number, restoreRatio = 0): Promise<void> {
    if (this.destroyed) return
    const html = await this.loadChapterHtml(index)
    if (this.destroyed) return
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

    const doc = this.iframe.contentDocument ?? this.iframe.contentWindow!.document
    const win = this.iframe.contentWindow!

    // 滚动进度
    win.onscroll = () => {
      if (this.destroyed || this.current < 0) return
      const docEl = doc.documentElement
      const max = docEl.scrollHeight - win.innerHeight
      const ratio = max > 0 ? Math.max(0, Math.min(1, win.scrollY / max)) : 1
      this.cb.onProgress({
        percent: this.percentFor(this.current, ratio),
        label: `第 ${this.current + 1} / ${this.chapterCount} 节`,
        detail: { kind: 'doc', chapter: this.current, ratio },
      })
    }

    // 选区与点击
    doc.onmouseup = () => this.emitSelection(doc, win)
    doc.onkeyup = () => this.emitSelection(doc, win)
    // 焦点在 iframe 内时键盘事件不冒泡到主文档，转发给外壳
    doc.onkeydown = (e) => this.cb.onKey?.(e)
    doc.onclick = (e) => {
      const target = e.target as Element
      const mark = target.closest?.('.scriptra-hl') as HTMLElement | null
      if (mark?.dataset.ann) {
        const ann = this.annotations.find((a) => a.id === mark.dataset.ann)
        if (ann) { e.preventDefault(); this.cb.onMarkClick(ann); return }
      }
      const link = target.closest?.('a[href]') as HTMLAnchorElement | null
      if (link) {
        e.preventDefault()
        const href = link.getAttribute('href') || ''
        if (href.startsWith('filepos:')) {
          try {
            const loc = this.book!.resolveHref(href)
            if (loc && loc.index >= 0) void this.showChapter(loc.index, 0)
          } catch { /* 忽略 */ }
        }
      }
    }

    this.cache = doc.body ? buildTextCache(doc.body) : { nodes: [], starts: [], total: 0 }
    this.applyAnnotations(this.annotations)

    const docEl = doc.documentElement
    const max = docEl.scrollHeight - win.innerHeight
    win.scrollTo(0, Math.max(0, max * Math.max(0, Math.min(1, restoreRatio || 0))))
    this.cb.onChapterChange(index)
  }

  private percentFor(index: number, ratio: number): number {
    const w = this.weights
    const total = w.reduce((s, x) => s + x, 0) || 1
    const before = w.slice(0, index).reduce((s, x) => s + x, 0)
    return Math.max(0, Math.min(1, (before + w[index] * ratio) / total))
  }

  private emitSelection(doc: Document, win: Window): void {
    const sel = win.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
      this.cb.onSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const start = globalFromDom(this.cache, range.startContainer, range.startOffset)
    const end = globalFromDom(this.cache, range.endContainer, range.endOffset)
    if (start === null || end === null || end - start < 1) {
      this.cb.onSelection(null)
      return
    }
    this.cb.onSelection({
      text: sel.toString(),
      locator: { kind: 'text', chapter: this.current, start, end },
    })
    void doc
  }

  async goChapter(index: number, ratio = 0): Promise<void> {
    const idx = Math.max(0, Math.min(index, this.chapterCount - 1))
    if (idx === this.current) {
      const doc = this.iframe?.contentDocument
      const win = this.iframe?.contentWindow
      if (doc && win && ratio > 0) {
        const max = doc.documentElement.scrollHeight - win.innerHeight
        win.scrollTo(0, Math.max(0, max * Math.max(0, Math.min(1, ratio))))
      } else {
        this.iframe?.contentWindow?.scrollTo(0, 0)
      }
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
    // 重新渲染当前章节以应用样式，并保持滚动位置
    if (this.current >= 0 && !this.destroyed && this.book) {
      const doc = this.iframe?.contentDocument
      const win = this.iframe?.contentWindow
      if (doc && win) {
        const docEl = doc.documentElement
        const max = docEl.scrollHeight - win.innerHeight
        const ratio = max > 0 ? win.scrollY / max : 0
        void this.showChapter(this.current, ratio)
      }
    }
  }

  applyAnnotations(list: Annotation[]): void {
    this.annotations = list
    const doc = this.iframe?.contentDocument
    if (!doc?.body || this.current < 0) return
    doc.querySelectorAll('mark.scriptra-hl').forEach((m) => {
      const parent = m.parentNode
      if (!parent) return
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    })
    this.cache = buildTextCache(doc.body)
    for (const ann of list) {
      if (ann.locator.kind !== 'text') continue
      if (ann.locator.chapter !== this.current) continue
      if (ann.locator.start >= ann.locator.end) continue
      wrapRangeWithMark(doc, this.cache, ann)
    }
  }

  clearSelection(): void {
    try { this.iframe?.contentWindow?.getSelection()?.removeAllRanges() } catch { /* 忽略 */ }
  }

  focusAnnotation(annId: string): void {
    const mark = this.iframe?.contentDocument?.querySelector(`mark[data-ann="${annId}"]`) as HTMLElement | null
    if (!mark) return
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
    mark.classList.add('flash')
    setTimeout(() => mark.classList.remove('flash'), 1200)
  }

  destroy(): void {
    this.destroyed = true
    try { this.book?.destroy() } catch { /* 忽略 */ }
    this.book = null
    this.cache = { nodes: [], starts: [], total: 0 }
    this.iframe?.remove()
  }
}

registerEngine('mobi', () => new MobiEngine())
