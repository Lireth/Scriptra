/**
 * TXT 阅读引擎
 *
 * 主进程已完成编码探测与章节切分，引擎按偏移取段并排版。
 * 支持选区高亮 / 笔记（文本偏移定位）、书签与进度恢复。
 */

import type { Annotation, ReaderStyle } from '../../shared/types'
import { escapeHtml } from '../util'
import {
  buildTextCache, cacheText, findOccurrences, makeExcerpt, MAX_SEARCH_MARKS,
  READER_THEMES, unwrapMarks, wrapRangeWithClass, wrapRangeWithMark, type TextCache,
} from './common'
import { registerEngine, type EngineCallbacks, type EnginePayload, type ReaderEngine, type SearchHit, type TocEntry } from './types'

class TxtEngine implements ReaderEngine {
  private container!: HTMLElement
  private scroller!: HTMLElement
  private style!: ReaderStyle
  private cb!: EngineCallbacks
  private payload!: EnginePayload
  private annotations: Annotation[] = []
  private chapters: string[] = []
  private titles: string[] = []
  private cache: TextCache = { nodes: [], starts: [], total: 0 }
  private current = -1
  private destroyed = false
  private onScroll: (() => void) | null = null

  private get chapterCount(): number {
    return this.chapters.length
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

    const text = payload.fileData
      ? new TextDecoder('utf-8').decode(payload.fileData)
      : ''
    const starts = payload.manifest?.chapterStarts ?? [0]
    const spine = payload.manifest?.spine ?? []
    this.titles = spine.map((s) => s.title || '未命名章节')
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : text.length
      this.chapters.push(text.slice(starts[i], end))
    }

    this.scroller = document.createElement('div')
    this.scroller.className = 'txt-reader scriptra-doc'
    container.appendChild(this.scroller)

    this.onScroll = () => this.reportProgress()
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.scroller.addEventListener('mouseup', () => this.emitSelection())
    this.scroller.addEventListener('keyup', () => this.emitSelection())
    this.scroller.addEventListener('click', (e) => {
      const mark = (e.target as Element).closest?.('.scriptra-hl') as HTMLElement | null
      if (mark?.dataset.ann) {
        const ann = this.annotations.find((a) => a.id === mark.dataset.ann)
        if (ann) this.cb.onMarkClick(ann)
      }
    })

    const detail = payload.progressDetail
    const startChapter = detail && detail.kind === 'doc'
      ? Math.min(detail.chapter, Math.max(0, this.chapterCount - 1)) : 0
    const startRatio = detail && detail.kind === 'doc' ? detail.ratio : 0

    await this.showChapter(startChapter, startRatio)
    cb.onTocReady(this.tocEntries())
  }

  private tocEntries(): TocEntry[] {
    return this.titles.map((t, i) => ({ title: t, index: i, level: 0 }))
  }

  private async showChapter(index: number, restoreRatio = 0): Promise<void> {
    if (this.destroyed) return
    this.current = index
    const body = this.chapters[index] || ''
    const html = body
      .split(/\n{2,}|\r\n\r\n/)
      .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('')
    this.scroller.innerHTML =
      `<div class="txt-title">${escapeHtml(this.titles[index] ?? '')}</div><div class="txt-content">${html}</div>`
    this.applyStyle(this.style)
    this.cache = buildTextCache(this.scroller.querySelector('.txt-content')!)
    this.applyAnnotations(this.annotations)
    requestAnimationFrame(() => {
      const max = this.scroller.scrollHeight - this.scroller.clientHeight
      this.scroller.scrollTop = Math.max(0, max * Math.max(0, Math.min(1, restoreRatio || 0)))
      this.reportProgress()
    })
    this.cb.onChapterChange(index)
  }

  private reportProgress(): void {
    if (this.destroyed || this.current < 0) return
    const max = this.scroller.scrollHeight - this.scroller.clientHeight
    const ratio = max > 0 ? Math.max(0, Math.min(1, this.scroller.scrollTop / max)) : 1
    const count = Math.max(1, this.chapterCount)
    this.cb.onProgress({
      percent: Math.max(0, Math.min(1, (this.current + ratio) / count)),
      label: `第 ${this.current + 1} / ${this.chapterCount} 章`,
      detail: { kind: 'doc', chapter: this.current, ratio },
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
    if (!this.scroller.contains(range.commonAncestorContainer)) {
      this.cb.onSelection(null)
      return
    }
    const text = sel.toString()
    if (!text.trim()) {
      this.cb.onSelection(null)
      return
    }
    const start = globalFromDom(this.cache, range.startContainer, range.startOffset)
    const end = globalFromDom(this.cache, range.endContainer, range.endOffset)
    if (start === null || end === null || end - start < 1) {
      this.cb.onSelection(null)
      return
    }
    this.cb.onSelection({
      text,
      locator: { kind: 'text', chapter: this.current, start, end },
    })
  }

  async goChapter(index: number): Promise<void> {
    const idx = Math.max(0, Math.min(index, this.chapterCount - 1))
    if (idx === this.current) {
      this.scroller.scrollTop = 0
      this.reportProgress()
      return
    }
    await this.showChapter(idx, 0)
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

  async scrollByScreen(dir: 1 | -1): Promise<boolean> {
    const max = this.scroller.scrollHeight - this.scroller.clientHeight
    const y = this.scroller.scrollTop
    if (dir > 0) {
      if (max - y < 4) return false
      this.scroller.scrollTop = Math.min(max, y + this.scroller.clientHeight * 0.9)
      return true
    }
    if (y <= 4) return false
    this.scroller.scrollTop = Math.max(0, y - this.scroller.clientHeight * 0.9)
    return true
  }

  applyStyle(style: ReaderStyle): void {
    this.style = style
    if (!this.scroller) return
    const t = READER_THEMES[style.theme] ?? READER_THEMES.light
    this.scroller.style.background = t.bg
    this.scroller.style.color = t.fg
    this.scroller.style.setProperty('--rlink', t.link)
    this.scroller.style.fontFamily = style.fontFamily
    this.scroller.style.fontSize = `${style.fontSize}px`
    this.scroller.style.lineHeight = String(style.lineHeight)
    this.scroller.style.maxWidth = `${style.pageWidth}px`
  }

  applyAnnotations(list: Annotation[]): void {
    this.annotations = list
    if (!this.scroller || this.current < 0) return
    this.scroller.querySelectorAll('mark.scriptra-hl').forEach((m) => {
      const parent = m.parentNode
      if (!parent) return
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    })
    this.cache = buildTextCache(this.scroller.querySelector('.txt-content')!)
    const doc = document
    for (const ann of list) {
      if (ann.locator.kind !== 'text') continue
      if (ann.locator.chapter !== this.current) continue
      if (ann.locator.start >= ann.locator.end) continue
      wrapRangeWithMark(doc, this.cache, ann)
      // splitText 会使 cache 失效，逐个重建保证后续高亮定位准确
      this.cache = buildTextCache(this.scroller.querySelector('.txt-content')!)
    }
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
    if (!needle) return hits
    const total = this.chapterCount
    for (let i = 0; i < total; i++) {
      if (this.destroyed || seq !== this.searchSeq) return hits
      const text = this.chapters[i] ?? ''
      for (const [m, occ] of findOccurrences(text, needle).entries()) {
        hits.push({
          chapter: i, matchIndex: m,
          label: `第 ${i + 1} / ${total} 章`,
          excerpt: makeExcerpt(text, occ.start, occ.end),
        })
      }
      onProgress?.(i + 1, total)
      // 章节在内存中遍历很快，定期让步仅为刷新进度 UI
      if (i % 50 === 49) await new Promise((r) => setTimeout(r, 0))
    }
    return hits
  }

  async goToHit(hit: SearchHit): Promise<void> {
    if (hit.chapter !== this.current) await this.showChapter(hit.chapter, 0)
    this.highlightSearchHits(hit.matchIndex)
  }

  clearSearch(): void {
    this.searchSeq++
    this.searchQuery = ''
    this.clearSearchMarks()
  }

  private clearSearchMarks(): void {
    if (this.scroller) unwrapMarks(this.scroller, 'mark.scriptra-search')
  }

  /** 在当前章节 DOM 内套上搜索标记并滚动到指定序号的命中 */
  private highlightSearchHits(focusIndex: number): void {
    const content = this.scroller.querySelector('.txt-content')
    if (!content || !this.searchQuery) return
    this.clearSearchMarks()
    let cache = buildTextCache(content)
    const occs = findOccurrences(cacheText(cache), this.searchQuery.toLowerCase(), MAX_SEARCH_MARKS)
    const focusAt = Math.min(focusIndex, occs.length - 1)
    let focusMark: HTMLElement | null = null
    for (const [i, occ] of occs.entries()) {
      const mark = wrapRangeWithClass(document, cache, occ.start, occ.end,
        i === focusAt ? 'scriptra-search current' : 'scriptra-search')
      // splitText 改变文本节点，逐个重建保证后续偏移有效
      cache = buildTextCache(content)
      if (i === focusAt) focusMark = mark
    }
    focusMark?.scrollIntoView({ block: 'center' })
  }

  focusAnnotation(annId: string): boolean {
    const mark = this.scroller?.querySelector(`mark[data-ann="${annId}"]`) as HTMLElement | null
    if (!mark) return false
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
    mark.classList.add('flash')
    setTimeout(() => mark.classList.remove('flash'), 1200)
    return true
  }

  destroy(): void {
    this.destroyed = true
    if (this.onScroll) this.scroller.removeEventListener('scroll', this.onScroll)
    this.scroller.remove()
    this.chapters = []
    this.cache = { nodes: [], starts: [], total: 0 }
  }
}

function globalFromDom(cache: TextCache, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = cache.nodes.indexOf(node as Text)
    if (i >= 0) return cache.starts[i] + Math.min(offset, node.textContent!.length)
  }
  return null
}

registerEngine('txt', () => new TxtEngine())
