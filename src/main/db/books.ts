/**
 * 书库数据访问层（books 表 + FTS 全文索引）
 */

import { randomUUID } from 'node:crypto'
import type {
  Book, BookFormat, BookQuery, BookUpdatePatch, LibraryStats,
  ProgressDetail, ReadingStatus,
} from '../../shared/types'
import { cjkSpace, getDb } from './database'
import { log } from '../logger'

interface BookRow {
  id: string
  title: string
  author: string
  format: string
  category: string
  status: string
  favorite: number
  rating: number
  description: string
  publisher: string
  language: string
  year: string
  size: number
  progress: number
  progress_detail: string
  file_hash: string
  content_indexed: number
  added_at: number
  updated_at: number
  last_read_at: number
  stored_path?: string
  cover_path?: string
  source_path?: string
}

function rowToBook(r: BookRow): Book {
  let detail: ProgressDetail | null = null
  try { detail = r.progress_detail ? JSON.parse(r.progress_detail) : null } catch { detail = null }
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    format: r.format as BookFormat,
    category: r.category,
    status: r.status as ReadingStatus,
    favorite: !!r.favorite,
    rating: r.rating,
    description: r.description,
    publisher: r.publisher,
    language: r.language,
    year: r.year,
    size: r.size,
    progress: r.progress,
    progressDetail: detail,
    contentIndexed: !!r.content_indexed,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
    lastReadAt: r.last_read_at,
  }
}

export interface InsertBook {
  /** 可预先生成 id（导入流程需要先以 id 命名落盘文件，再入库） */
  id?: string
  title: string
  author: string
  format: BookFormat
  category?: string
  description?: string
  publisher?: string
  language?: string
  year?: string
  storedPath: string
  coverPath?: string
  sourcePath?: string
  size: number
  fileHash: string
  contentIndexed?: boolean
}

export function insertBook(b: InsertBook): Book {
  const d = getDb()
  const id = b.id ?? randomUUID()
  const now = Date.now()
  d.prepare(`
    INSERT INTO books (id, title, author, format, category, description, publisher, language,
      year, stored_path, cover_path, source_path, size, file_hash, content_indexed,
      added_at, updated_at, last_read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, b.title, b.author, b.format, b.category ?? '未分类', b.description ?? '',
    b.publisher ?? '', b.language ?? '', b.year ?? '',
    b.storedPath, b.coverPath ?? '', b.sourcePath ?? '', b.size, b.fileHash,
    b.contentIndexed ? 1 : 0, now, now, 0,
  )
  indexSearchable(id, b.title, b.author, '')
  return getBook(id)!
}

export function getBook(id: string): Book | null {
  const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined
  return row ? rowToBook(row) : null
}

export function getBookPaths(id: string): { storedPath: string; coverPath: string } | null {
  const row = getDb().prepare('SELECT stored_path, cover_path FROM books WHERE id = ?').get(id) as
    { stored_path: string; cover_path: string } | undefined
  return row ? { storedPath: row.stored_path, coverPath: row.cover_path } : null
}

export function findByHash(hash: string): Book | null {
  const row = getDb().prepare('SELECT * FROM books WHERE file_hash = ? LIMIT 1').get(hash) as BookRow | undefined
  return row ? rowToBook(row) : null
}

/** 构建 FTS5 查询表达式：中文按短语逐字匹配，西文前缀匹配 */
export function buildFtsQuery(q: string): string {
  const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  const parts: string[] = []
  for (const t of terms) {
    const safe = t.replace(/["*()]/g, ' ')
    if (!safe) continue
    if (/[\u4e00-\u9fff]/.test(safe)) {
      const spaced = cjkSpace(safe)
      parts.push(`"${spaced}"`)
    } else {
      parts.push(`"${safe}"*`)
    }
  }
  return parts.join(' AND ')
}

export function listBooks(query: BookQuery): Book[] {
  const d = getDb()
  const where: string[] = []
  const params: (string | number)[] = []

  if (query.status && query.status !== 'all') {
    where.push('b.status = ?')
    params.push(query.status)
  }
  if (query.favorite) {
    where.push('b.favorite = 1')
  }
  if (query.category) {
    where.push('b.category = ?')
    params.push(query.category)
  }
  if (query.author) {
    where.push('b.author = ?')
    params.push(query.author)
  }
  if (query.format) {
    where.push('b.format = ?')
    params.push(query.format)
  }

  let joins = ''
  if (query.q && query.q.trim()) {
    const fts = buildFtsQuery(query.q)
    if (fts) {
      joins = 'JOIN books_fts f ON f.book_id = b.id'
      where.push('books_fts MATCH ?')
      params.push(fts)
    }
  }

  const sortMap: Record<string, string> = {
    recent: 'CASE WHEN b.last_read_at > 0 THEN b.last_read_at ELSE b.updated_at END DESC',
    added: 'b.added_at DESC',
    title: `b.title COLLATE NOCASE`,
    author: `b.author COLLATE NOCASE`,
    rating: 'b.rating DESC, b.updated_at DESC',
  }
  const orderBy = sortMap[query.sort ?? 'added'] ?? sortMap.added

  const limit = clampInt(query.limit, 120, 1, 500)
  const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)

  const sql = `
    SELECT b.* FROM books b ${joins}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `
  try {
    const rows = d.prepare(sql).all(...params) as unknown as BookRow[]
    return rows.map(rowToBook)
  } catch (e) {
    log.error('书库查询失败:', e, sql, params)
    return []
  }
}

export function updateBook(id: string, patch: BookUpdatePatch): Book | null {
  const d = getDb()
  const sets: string[] = []
  const params: (string | number)[] = []
  const map: Record<string, string> = {
    title: 'title', author: 'author', category: 'category',
    status: 'status', rating: 'rating', description: 'description',
  }
  for (const [k, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[k]
    if (v !== undefined) {
      sets.push(`${col} = ?`)
      params.push(v as string | number)
    }
  }
  if (patch.favorite !== undefined) {
    sets.push('favorite = ?')
    params.push(patch.favorite ? 1 : 0)
  }
  if (!sets.length) return getBook(id)
  sets.push('updated_at = ?')
  params.push(Date.now())
  params.push(id)
  d.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  const book = getBook(id)
  if (book) indexSearchable(id, book.title, book.author)
  return book
}

export function setBookProgress(id: string, progress: number, detail: ProgressDetail | null): void {
  const d = getDb()
  const book = getBook(id)
  if (!book) return
  let status = book.status
  // 仅在"正在阅读"时自动升级为已读完；用户手动标记的"未读"不被覆盖
  if (progress >= 0.98) {
    if (status === 'reading') status = 'finished'
  } else if (progress > 0.002 && status === 'unread') status = 'reading'
  d.prepare(`
    UPDATE books SET progress = ?, progress_detail = ?, status = ?, last_read_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    Math.max(0, Math.min(1, progress)),
    // detail 为 null/undefined 时存空串；否则存 JSON（避免 JSON.stringify('') 写入 '""'）
    detail ? JSON.stringify(detail) : '',
    status, Date.now(), Date.now(), id,
  )
}

/** 将任意值安全转为整数并夹到 [min,max]，非法/缺省回落到 def */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

/** 延迟建立正文索引（MOBI HUFF/CDIC 等主进程无法解压时，由渲染进程回传文本） */
export function indexBookText(id: string, text: string): void {
  const capped = text.slice(0, 600_000)
  indexSearchable(id, undefined, undefined, cjkSpace(capped))
  getDb().prepare('UPDATE books SET content_indexed = 1 WHERE id = ?').run(id)
}

export function isContentIndexed(id: string): boolean {
  const row = getDb().prepare('SELECT content_indexed FROM books WHERE id = ?').get(id) as { content_indexed: number } | undefined
  return !!row && !!row.content_indexed
}

function indexSearchable(id: string, title?: string, author?: string, content?: string): void {
  const d = getDb()
  const prev = (d.prepare('SELECT title, author, content FROM books_fts WHERE book_id = ?').get(id) as
    { title: string; author: string; content: string } | undefined)
  d.prepare('DELETE FROM books_fts WHERE book_id = ?').run(id)
  const book = title === undefined || author === undefined
    ? (d.prepare('SELECT title, author FROM books WHERE id = ?').get(id) as { title: string; author: string } | undefined)
    : undefined
  d.prepare('INSERT INTO books_fts (book_id, title, author, content) VALUES (?, ?, ?, ?)').run(
    id,
    cjkSpace(title ?? book?.title ?? prev?.title ?? ''),
    cjkSpace(author ?? book?.author ?? prev?.author ?? ''),
    // content 为 undefined 时保留旧正文，避免编辑书名/作者把全文索引抹掉
    content ?? prev?.content ?? '',
  )
}

export function removeBooks(ids: string[]): { storedPaths: string[]; coverPaths: string[] } {
  const d = getDb()
  const storedPaths: string[] = []
  const coverPaths: string[] = []
  const getPaths = d.prepare('SELECT stored_path, cover_path FROM books WHERE id = ?')
  const delBook = d.prepare('DELETE FROM books WHERE id = ?')
  const delFts = d.prepare('DELETE FROM books_fts WHERE book_id = ?')
  // annotations 依赖外键级联删除
  // 整体包裹事务：任一删除失败即回滚，避免 books 已删而 FTS/注释残留的孤儿数据
  d.exec('BEGIN')
  try {
    for (const id of ids) {
      const row = getPaths.get(id) as { stored_path: string; cover_path: string } | undefined
      if (row?.stored_path) storedPaths.push(row.stored_path)
      if (row?.cover_path) coverPaths.push(row.cover_path)
      delFts.run(id)
      delBook.run(id)
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  return { storedPaths, coverPaths }
}

export function libraryStats(): LibraryStats {
  const d = getDb()
  const one = (sql: string): number => {
    const row = d.prepare(sql).get() as { c: number }
    return row?.c ?? 0
  }
  const distinct = (col: 'category' | 'author') =>
    (d.prepare(`SELECT ${col} AS name, COUNT(*) AS count FROM books GROUP BY ${col} ORDER BY count DESC LIMIT 80`).all() as unknown as { name: string; count: number }[])
      .filter((r) => r.name)

  return {
    total: one('SELECT COUNT(*) AS c FROM books'),
    unread: one(`SELECT COUNT(*) AS c FROM books WHERE status = 'unread'`),
    reading: one(`SELECT COUNT(*) AS c FROM books WHERE status = 'reading'`),
    finished: one(`SELECT COUNT(*) AS c FROM books WHERE status = 'finished'`),
    favorite: one('SELECT COUNT(*) AS c FROM books WHERE favorite = 1'),
    categories: distinct('category'),
    authors: distinct('author'),
  }
}

/** 最近阅读的一本书（用于“继续阅读”） */
export function lastReadBook(): Book | null {
  const row = getDb().prepare(
    'SELECT * FROM books WHERE last_read_at > 0 ORDER BY last_read_at DESC LIMIT 1',
  ).get() as BookRow | undefined
  return row ? rowToBook(row) : null
}
