/**
 * 批注导出 / 导入备份
 *
 * - Markdown：单本书批注导出为可读文档（按时间正序，原文引用 + 笔记）
 * - JSON：批注结构化备份；导入按 id 去重合并，
 *   对应书籍已不存在或数据非法的条目跳过（不阻塞其余条目）
 */

import { BrowserWindow, dialog } from 'electron'
import fsp from 'node:fs/promises'
import type {
  Annotation, AnnotationImportResult, AnnotationLocator, Book,
} from '../../shared/types'
import { getBook } from '../db/books'
import { importAnnotation, listAnnotations } from '../db/annotations'
import { log } from '../logger'
import { ANN_TYPES, annotationLocator, oneOf, str } from '../ipc/validate'

/** 文件名安全化：去除 Windows 非法字符 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function locatorLabel(loc: AnnotationLocator): string {
  if (loc.kind === 'pdf' || loc.kind === 'page') return `第 ${loc.page} 页`
  return `第 ${loc.chapter + 1} 章`
}

function buildMarkdown(book: Book, anns: Annotation[]): string {
  const counts = { bookmark: 0, highlight: 0, note: 0 }
  for (const a of anns) counts[a.type]++
  const typeLabel: Record<Annotation['type'], string> = {
    bookmark: '书签', highlight: '高亮', note: '笔记',
  }

  const lines: string[] = [
    `# 《${book.title}》批注`,
    '',
    `- 作者：${book.author || '佚名'}`,
    `- 格式：${book.format.toUpperCase()}`,
    `- 批注数量：${anns.length}（书签 ${counts.bookmark} · 高亮 ${counts.highlight} · 笔记 ${counts.note}）`,
    `- 导出时间：${formatDateTime(Date.now())}`,
    '',
    '---',
  ]

  const sorted = [...anns].sort((a, b) => a.createdAt - b.createdAt)
  sorted.forEach((ann, i) => {
    lines.push('', `### ${i + 1}. ${typeLabel[ann.type]} · ${locatorLabel(ann.locator)}`)
    if (ann.text) {
      lines.push('', '> ' + ann.text.replace(/\n/g, '\n> '))
    }
    if (ann.note) {
      lines.push('', `**笔记：** ${ann.note}`)
    }
    lines.push('', `*${formatDateTime(ann.createdAt)}*`)
  })
  return lines.join('\n') + '\n'
}

export async function exportAnnotations(
  bookId: string,
  format: 'md' | 'json',
  win: BrowserWindow | null,
): Promise<{ path: string | null }> {
  const book = getBook(bookId)
  if (!book) throw new Error('书籍不存在')
  const anns = listAnnotations(bookId)

  const stamp = new Date().toISOString().slice(0, 10)
  const opts: Electron.SaveDialogOptions = {
    title: '导出批注',
    defaultPath: sanitizeFileName(`${book.title}-批注-${stamp}.${format}`),
    filters: format === 'md'
      ? [{ name: 'Markdown', extensions: ['md'] }]
      : [{ name: 'JSON', extensions: ['json'] }],
  }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return { path: null }

  const content = format === 'md'
    ? buildMarkdown(book, anns)
    : JSON.stringify({ app: 'scriptra', version: 1, exportedAt: Date.now(), annotations: anns }, null, 2)
  await fsp.writeFile(r.filePath, content, 'utf-8')
  log.info(`批注已导出: ${r.filePath}（${anns.length} 条，${format}）`)
  return { path: r.filePath }
}

export async function importAnnotations(
  win: BrowserWindow | null,
): Promise<AnnotationImportResult | null> {
  const opts: Electron.OpenDialogOptions = {
    title: '导入批注备份',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths[0]) return null

  const text = await fsp.readFile(r.filePaths[0], 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { annotations?: unknown } | null)?.annotations
  if (!Array.isArray(list)) throw new Error('备份文件格式不正确（缺少 annotations 数组）')

  const result: AnnotationImportResult = { restored: 0, skipped: 0, unknownBooks: 0 }
  // 条数安全上限：防止构造性超大文件拖垮主进程
  for (const entry of list.slice(0, 10_000)) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const bookId = str(o.bookId, 64)
    if (!bookId || !getBook(bookId)) {
      result.unknownBooks++
      continue
    }
    const locator = annotationLocator(o.locator)
    if (!locator) {
      result.skipped++
      continue
    }
    try {
      const out = importAnnotation({
        id: str(o.id, 64) || undefined,
        bookId,
        type: oneOf(o.type, ANN_TYPES, 'highlight'),
        color: str(o.color, 32),
        text: str(o.text, 4000),
        note: str(o.note, 8000),
        locator,
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : undefined,
        updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : undefined,
      })
      if (out === 'imported') result.restored++
      else result.skipped++
    } catch (e) {
      log.warn('批注恢复失败:', e)
      result.skipped++
    }
  }
  log.info(`批注备份导入完成: 恢复 ${result.restored}，跳过 ${result.skipped}，未知书籍 ${result.unknownBooks}`)
  return result
}
