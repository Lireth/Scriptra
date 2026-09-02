/**
 * EPUB 阅读引擎
 *
 * 章节资源经主进程 IPC 读取，渲染前在渲染进程重写：
 * - <script> 一律移除（安全）
 * - 图片 / 字体 -> data URL
 * - 外链 CSS -> 内联 <style>（并重写其中的 url()）
 */

import type { TocItem } from '../../shared/types'
import { DocEngine, buildTextCache, type TextCache } from './common'
import { abToDataUrl, resolveZipPath } from '../util'
import { registerEngine, type TocEntry } from './types'

const MAX_ASSET_BYTES = 4 * 1024 * 1024

class EpubEngine extends DocEngine {
  private spine: { href: string; title: string }[] = []
  private tocItems: TocItem[] = []
  private assetCache = new Map<string, string>()
  private cssCache = new Map<string, string>()

  protected get chapterCount(): number {
    return this.spine.length
  }

  protected tocEntries(): TocEntry[] {
    const spineIndex = new Map(this.spine.map((s, i) => [s.href, i]))
    const out: TocEntry[] = []
    const walk = (items: TocItem[]) => {
      for (const t of items) {
        const idx = spineIndex.get(t.href) ?? this.chapterIndexByHref(t.href)
        if (idx >= 0) out.push({ title: t.title || `第 ${idx + 1} 节`, index: idx, level: t.level })
        // 子级已由主进程拍平
      }
    }
    walk(this.tocItems)
    if (!out.length) return super.tocEntries()
    return out
  }

  protected chapterIndexByHref(href: string): number {
    const clean = href.split('#')[0]
    let i = this.spine.findIndex((s) => s.href === clean)
    if (i >= 0) return i
    i = this.spine.findIndex((s) => s.href.endsWith('/' + clean) || clean.endsWith('/' + s.href))
    return i
  }

  async open(
    container: HTMLElement,
    payload: Parameters<DocEngine['open']>[1],
    style: Parameters<DocEngine['open']>[2],
    cb: Parameters<DocEngine['open']>[3],
  ): Promise<void> {
    this.spine = payload.manifest?.spine ?? []
    this.tocItems = payload.manifest?.toc ?? []
    if (!this.spine.length) throw new Error('EPUB 解析结果为空')
    await super.open(container, payload, style, cb)
  }

  /** 搜索用轻量解析：仅取文本，跳过图片/CSS 重写，全书扫描快一个量级 */
  protected async chapterSearchCache(index: number): Promise<TextCache | null> {
    const href = this.spine[index]?.href
    if (!href) return null
    const raw = await this.fetchText(href)
    if (!raw) return null
    const doc = new DOMParser().parseFromString(raw, 'text/html')
    return doc.body ? buildTextCache(doc.body) : null
  }

  protected async loadChapterHtml(index: number): Promise<string> {
    const href = this.spine[index].href
    const raw = await this.fetchText(href)
    if (!raw) return `<p style="opacity:.6">章节加载失败：${href}</p>`

    const doc = new DOMParser().parseFromString(raw, 'text/html')
    // 移除脚本
    doc.querySelectorAll('script').forEach((s) => s.remove())

    const baseDir = href.includes('/') ? href.slice(0, href.lastIndexOf('/')) : ''

    // 外链样式内联（fetchCss 已按 CSS 自身目录把 url() 解析为 zip 绝对路径）
    for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
      const cssHref = resolveZipPath(baseDir, (link as HTMLLinkElement).getAttribute('href') || '')
      const css = await this.fetchCss(cssHref)
      if (css) {
        const style = doc.createElement('style')
        // 标记为已解析，避免下方二次 rewriteCssUrls 造成路径前缀重复
        style.dataset.resolved = '1'
        style.textContent = css
        link.replaceWith(style)
      } else {
        link.remove()
      }
    }
    // 仅处理书中原本的内联 <style>（其 url() 相对 HTML 目录），跳过上面已解析的外链样式
    doc.querySelectorAll('style:not([data-resolved])').forEach((st) => {
      st.textContent = rewriteCssUrls(st.textContent || '', baseDir, this)
    })

    // 媒体资源 -> data URL
    await rewriteMedia(doc, baseDir, this)

    // 收集 head 中的样式（外链 CSS 内联结果 + 原书内联样式）。
    // wrapChapterDoc 只序列化 body，head 内样式需经 extraHead 带入，否则整章排版丢失。
    // 跳过 body 内的 <style>（极少见），它们已随 body.innerHTML 序列化，避免重复注入。
    const headCss = [...doc.querySelectorAll('style')]
      .filter((st) => !doc.body.contains(st))
      .map((st) => st.textContent || '')
      .join('\n')

    // 移除内联事件与 javascript: 链接
    doc.querySelectorAll('[onclick], [onload], [onerror]').forEach((n) => {
      for (const attr of [...n.attributes]) {
        if (/^on/i.test(attr.name)) n.removeAttribute(attr.name)
      }
    })
    doc.querySelectorAll('a[href^="javascript:"]').forEach((a) => a.removeAttribute('href'))

    return this.wrapChapterDoc(doc.body.innerHTML, headCss ? `<style>${headCss}</style>` : '')
  }

  private async fetchText(path: string): Promise<string | null> {
    try {
      const res = await window.scriptra.getResource(this.payload.id, path)
      return new TextDecoder('utf-8').decode(res.bytes)
    } catch {
      return null
    }
  }

  private async fetchCss(path: string): Promise<string | null> {
    if (this.cssCache.has(path)) return this.cssCache.get(path)!
    const text = await this.fetchText(path)
    if (text === null) return null
    const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const rewritten = rewriteCssUrls(text, baseDir, this)
    this.cssCache.set(path, rewritten)
    return rewritten
  }

  /** 资源 -> data URL（带缓存与大小限制） */
  async asset(path: string): Promise<string | null> {
    if (this.assetCache.has(path)) return this.assetCache.get(path)!
    try {
      const res = await window.scriptra.getResource(this.payload.id, path)
      if (res.bytes.byteLength > MAX_ASSET_BYTES) return null
      const url = abToDataUrl(res.mime, res.bytes)
      this.assetCache.set(path, url)
      return url
    } catch {
      return null
    }
  }
}

function rewriteCssUrls(css: string, baseDir: string, engine: EpubEngine): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, quote, rawUrl: string) => {
      const url = rawUrl.trim()
      if (!url || url.startsWith('data:') || url.startsWith('http')) return m
      const abs = resolveZipPath(baseDir, url)
      // url() 在异步替换前先生成占位，加载完成后再注入会比较复杂；
      // 由于字体/背景图是渐进增强，这里同步返回原样，由加载器二次处理
      void engine
      return `url(${quote}${abs}${quote})`
    })
}

async function rewriteMedia(doc: Document, baseDir: string, engine: EpubEngine): Promise<void> {
  const jobs: Promise<void>[] = []

  const handle = (elm: Element, attrName: string) => {
    const raw = elm.getAttribute(attrName)
    if (!raw) return
    const url = raw.trim()
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http')) return
    const abs = resolveZipPath(baseDir, url.split('#')[0])
    jobs.push(engine.asset(abs).then((u) => {
      if (u) elm.setAttribute(attrName, u)
      else elm.setAttribute(attrName, '')
    }))
  }

  for (const img of [...doc.querySelectorAll('img, image')]) {
    handle(img, 'src')
    handle(img, 'xlink:href')
    handle(img, 'href')
  }
  for (const media of [...doc.querySelectorAll('video, audio, source, track')]) {
    handle(media, 'src')
    handle(media, 'poster')
  }
  // CSS 内的 url()：此时 url 已由 rewriteCssUrls 解析为 zip 绝对路径，直接取资源
  for (const st of [...doc.querySelectorAll('style')]) {
    const css = st.textContent || ''
    if (!css.includes('url(')) continue
    const matches = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
    const pairs = await Promise.all(matches.map(async (m) => {
      const raw = m[2].trim()
      if (raw.startsWith('data:') || raw.startsWith('http')) return null
      return [m[0], (await engine.asset(raw)) ?? m[0]] as const
    }))
    let out = css
    for (const pair of pairs) {
      if (!pair) continue
      out = out.split(pair[0]).join(pair[1])
    }
    st.textContent = out
  }

  await Promise.all(jobs)
}

registerEngine('epub', () => new EpubEngine())
