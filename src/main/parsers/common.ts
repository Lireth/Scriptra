/**
 * 解析器公共工具
 */

export interface ParsedMeta {
  title: string
  author: string
  description: string
  publisher: string
  language: string
  year: string
}

export interface CoverData {
  mime: string
  /** Node Buffer */
  bytes: Buffer
}

/** 正文索引进库的字符上限，避免超大书籍拖慢导入 */
export const CONTENT_TEXT_CAP = 600_000

export function titleFromFilename(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p
  return base.replace(/\.[^.]+$/, '').trim() || '未命名'
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', hellip: '…',
}

export function decodeEntities(s: string): string {
  if (!s) return ''
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
}

/** 粗粒度 HTML 转纯文本（用于全文索引，不用于展示） */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}
