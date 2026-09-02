/**
 * EPUB 解析器（主进程导入用：元数据 / 封面 / 全文索引 / 阅读清单）
 *
 * 基于 JSZip 解包，OPF / NCX 使用 fast-xml-parser 解析。
 */

import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import path from 'node:path'
import type { BookManifest, TocItem } from '../../shared/types'
import {
  CONTENT_TEXT_CAP, decodeEntities, stripHtml,
  type CoverData, type ParsedMeta, titleFromFilename,
} from './common'
import { log } from '../logger'

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

type AnyObj = Record<string, unknown>

function asArray<T>(v: unknown): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? (v as T[]) : [v as T]
}

function text(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') {
    const o = v as AnyObj
    if ('#text' in o) return String(o['#text'])
    if ('@_href' in o) return String(o['@_href'])
    return ''
  }
  return String(v)
}

function attr(o: unknown, name: string): string {
  if (!o || typeof o !== 'object') return ''
  const a = (o as AnyObj)['@_' + name]
  return a === undefined ? '' : String(a)
}

export interface EpubParseResult {
  meta: ParsedMeta
  cover: CoverData | null
  contentText: string
  manifest: BookManifest
  zipBuffer: Buffer
}

export async function parseEpubFile(filePath: string): Promise<EpubParseResult> {
  const zipBuffer = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(zipBuffer)
  const { meta, cover, manifest } = await parseEpubZip(zip, titleFromFilename(filePath))
  const contentText = await extractEpubText(zip, manifest)
  return { meta, cover, contentText, manifest, zipBuffer }
}

/** 在 JSZip 实例上解析 OPF 结构（导入与打开书籍时共用） */
export async function parseEpubZip(
  zip: JSZip,
  fallbackTitle: string,
): Promise<{ meta: ParsedMeta; cover: CoverData | null; manifest: BookManifest }> {
  // 1. container.xml -> OPF 路径
  const opfPath = await findOpfPath(zip)
  const opfEntry = entryAt(zip, opfPath)
  if (!opfEntry) throw new Error('EPUB 缺少 OPF 文件')
  const opfText = await opfEntry.async('string')
  const opf = xml.parse(opfText) as AnyObj
  const pkg = (opf.package ?? opf['opf:package'] ?? {}) as AnyObj
  const opfDir = path.posix.dirname(opfPath)

  // 2. 元数据
  const metaEl = (pkg.metadata ?? pkg['opf:metadata'] ?? {}) as AnyObj
  const title = firstText(metaEl['dc:title']) || fallbackTitle
  const author = firstText(metaEl['dc:creator'])
  const description = firstText(metaEl['dc:description'])
  const publisher = firstText(metaEl['dc:publisher'])
  const language = firstText(metaEl['dc:language'])
  const date = firstText(metaEl['dc:date'])
  const year = (date || '').match(/\d{4}/)?.[0] ?? ''

  // 3. manifest / spine
  const manifestEl = (pkg.manifest ?? {}) as AnyObj
  const items = asArray<AnyObj>(manifestEl.item)
  const idMap = new Map<string, { href: string; mediaType: string; properties: string }>()
  for (const it of items) {
    const href = attr(it, 'href')
    if (!href) continue
    idMap.set(attr(it, 'id'), {
      href: decodeURIComponent(href),
      mediaType: attr(it, 'media-type'),
      properties: attr(it, 'properties'),
    })
  }
  const spineEl = (pkg.spine ?? {}) as AnyObj
  const spineRefs = asArray<AnyObj>(spineEl.itemref)
  const spine: { href: string; title: string }[] = []
  for (const ref of spineRefs) {
    const item = idMap.get(attr(ref, 'idref'))
    if (!item) continue
    if (item.mediaType && !/xhtml|html/i.test(item.mediaType)) continue
    spine.push({ href: resolvePath(opfDir, item.href), title: '' })
  }

  // 4. 封面：properties=cover-image 或 <meta name="cover" content="id">
  let cover: CoverData | null = null
  let coverHref = ''
  for (const it of idMap.values()) {
    if (/\bcover-image\b/.test(it.properties)) { coverHref = it.href; break }
  }
  if (!coverHref) {
    const metas = asArray<AnyObj>(metaEl.meta).filter((m) => attr(m, 'name') === 'cover')
    const coverId = metas.length ? attr(metas[0], 'content') : ''
    if (coverId && idMap.has(coverId)) coverHref = idMap.get(coverId)!.href
  }
  if (coverHref) {
    const entry = entryAt(zip, resolvePath(opfDir, coverHref))
    if (entry) {
      const mime = coverHref.endsWith('.png') ? 'image/png'
        : coverHref.endsWith('.gif') ? 'image/gif'
        : coverHref.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      cover = { mime, bytes: await entry.async('nodebuffer') }
    }
  }

  // 5. 目录（NCX 或 EPUB3 nav）
  const toc = await extractToc(zip, opfDir, idMap, pkg, spine)

  // 用目录标题回填 spine 标题
  const tocMap = new Map<string, string>()
  for (const t of toc) {
    tocMap.set(t.href.split('#')[0], t.title)
  }
  for (const s of spine) {
    if (!s.title) s.title = tocMap.get(s.href) || ''
  }

  return {
    meta: { title, author, description, publisher, language, year },
    cover,
    manifest: { spine, toc },
  }
}

function firstText(v: unknown): string {
  const arr = asArray(v)
  return decodeEntities(text(arr[0])).trim()
}

function resolvePath(baseDir: string, href: string): string {
  if (href.startsWith('/')) return href.slice(1)
  return path.posix.normalize(path.posix.join(baseDir, href))
}

function entryAt(zip: JSZip, p: string): JSZip.JSZipObject | null {
  return zip.file(p) ?? zip.file(decodeURIComponent(p)) ?? null
}

async function findOpfPath(zip: JSZip): Promise<string> {
  const container = zip.file('META-INF/container.xml')
  if (!container) throw new Error('EPUB 缺少 container.xml')
  const doc = xml.parse(await container.async('string')) as AnyObj
  const root = (doc.container ?? {}) as AnyObj
  const rootfiles = asArray<AnyObj>((root.rootfiles as AnyObj | undefined ?? {}).rootfile)
  for (const rf of rootfiles) {
    const full = attr(rf, 'full-path')
    if (full) return decodeURIComponent(full)
  }
  throw new Error('container.xml 中未找到 OPF')
}

async function extractToc(
  zip: JSZip,
  opfDir: string,
  idMap: Map<string, { href: string; mediaType: string; properties: string }>,
  pkg: AnyObj,
  spine: { href: string }[],
): Promise<TocItem[]> {
  const spineIndex = new Map(spine.map((s, i) => [s.href, i]))
  const toSpineIdx = (href: string): number => spineIndex.get(href.split('#')[0]) ?? -1

  // NCX
  const ncxId = asArray<AnyObj>(((pkg.manifest ?? {}) as AnyObj).item)
    .find((it) => attr(it, 'media-type') === 'application/x-dtbncx+xml')
  if (ncxId) {
    const entry = entryAt(zip, resolvePath(opfDir, idMap.get(attr(ncxId, 'id'))?.href ?? ''))
    if (entry) {
      try {
        const ncx = xml.parse(await entry.async('string')) as AnyObj
        const ncxRoot = (ncx.ncx ?? {}) as AnyObj
        const navMap = ((ncxRoot.navMap ?? {}) as AnyObj).navPoint
        const items: TocItem[] = []
        const walk = (points: AnyObj[], level: number) => {
          for (const p of points) {
            const label = firstText(((p.navLabel ?? {}) as AnyObj).text)
            const src = attr((p.content ?? {}) as AnyObj, 'src')
            const href = resolvePath(opfDir, decodeURIComponent(src))
            if (href && toSpineIdx(href) >= 0) items.push({ href, title: label, level })
            const children = asArray<AnyObj>(p.navPoint)
            if (children.length) walk(children, level + 1)
          }
        }
        walk(asArray<AnyObj>(navMap), 0)
        if (items.length) return items
      } catch (e) {
        log.warn('解析 NCX 失败:', e)
      }
    }
  }

  // EPUB3 nav
  const navItem = [...idMap.values()].find((it) => /\bnav\b/.test(it.properties))
  if (navItem) {
    const navAbsPath = resolvePath(opfDir, navItem.href)
    const navDir = path.posix.dirname(navAbsPath)
    const entry = entryAt(zip, navAbsPath)
    if (entry) {
      try {
        const html = await entry.async('string')
        const items: TocItem[] = []
        const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        let m: RegExpExecArray | null
        while ((m = re.exec(html))) {
          const href = resolvePath(navDir, decodeURIComponent(m[1].replace(/^#/, '')))
          const title = stripHtml(m[2]).slice(0, 120)
          if (href && title && toSpineIdx(href) >= 0) items.push({ href, title, level: 0 })
        }
        if (items.length) return items
      } catch (e) {
        log.warn('解析 EPUB3 nav 失败:', e)
      }
    }
  }

  return []
}

async function extractEpubText(zip: JSZip, manifest: BookManifest): Promise<string> {
  const parts: string[] = []
  let total = 0
  for (const s of manifest.spine) {
    if (total >= CONTENT_TEXT_CAP) break
    const entry = entryAt(zip, s.href)
    if (!entry) continue
    try {
      const html = await entry.async('string')
      const t = stripHtml(html)
      if (t) {
        parts.push(t)
        total += t.length
      }
    } catch (e) {
      log.warn(`提取章节文本失败: ${s.href}`, e)
    }
  }
  return parts.join('\n').slice(0, CONTENT_TEXT_CAP)
}
