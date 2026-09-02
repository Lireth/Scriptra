/**
 * 注释（书签 / 高亮 / 笔记）数据访问层
 */

import { randomUUID } from 'node:crypto'
import type { Annotation, AnnotationLocator, AnnotationType } from '../../shared/types'
import { getDb } from './database'

interface AnnRow {
  id: string
  book_id: string
  type: string
  color: string
  text: string
  note: string
  locator: string
  created_at: number
  updated_at: number
}

function rowToAnn(r: AnnRow): Annotation {
  let locator: AnnotationLocator
  try { locator = JSON.parse(r.locator) } catch { locator = { kind: 'doc', chapter: 0, ratio: 0 } }
  return {
    id: r.id,
    bookId: r.book_id,
    type: r.type as AnnotationType,
    color: r.color,
    text: r.text,
    note: r.note,
    locator,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listAnnotations(bookId: string): Annotation[] {
  const rows = getDb().prepare(
    'SELECT * FROM annotations WHERE book_id = ? ORDER BY created_at ASC',
  ).all(bookId) as unknown as AnnRow[]
  return rows.map(rowToAnn)
}

export interface AddAnnotation {
  bookId: string
  type: AnnotationType
  color?: string
  text?: string
  note?: string
  locator: AnnotationLocator
}

export function addAnnotation(a: AddAnnotation): Annotation {
  const id = randomUUID()
  const now = Date.now()
  getDb().prepare(`
    INSERT INTO annotations (id, book_id, type, color, text, note, locator, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, a.bookId, a.type, a.color ?? '', a.text ?? '', a.note ?? '',
    JSON.stringify(a.locator), now, now)
  return {
    id, bookId: a.bookId, type: a.type, color: a.color ?? '', text: a.text ?? '',
    note: a.note ?? '', locator: a.locator, createdAt: now, updatedAt: now,
  }
}

export function updateAnnotation(
  id: string,
  patch: { color?: string; note?: string },
): Annotation | null {
  const sets: string[] = ['updated_at = ?']
  const params: (string | number)[] = [Date.now()]
  if (patch.color !== undefined) { sets.push('color = ?'); params.push(patch.color) }
  if (patch.note !== undefined) { sets.push('note = ?'); params.push(patch.note) }
  params.push(id)
  getDb().prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  const row = getDb().prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnRow | undefined
  return row ? rowToAnn(row) : null
}

export function removeAnnotation(id: string): void {
  getDb().prepare('DELETE FROM annotations WHERE id = ?').run(id)
}

export function getAnnotation(id: string): Annotation | null {
  const row = getDb().prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnRow | undefined
  return row ? rowToAnn(row) : null
}

export interface ImportAnnotation {
  /** 缺省时生成新 id */
  id?: string
  bookId: string
  type: AnnotationType
  color?: string
  text?: string
  note?: string
  locator: AnnotationLocator
  createdAt?: number
  updatedAt?: number
}

/** 备份恢复插入：按 id 去重，返回是否新增 */
export function importAnnotation(a: ImportAnnotation): 'imported' | 'skipped' {
  const id = a.id ?? randomUUID()
  if (getAnnotation(id)) return 'skipped'
  const now = Date.now()
  const createdAt = typeof a.createdAt === 'number' && a.createdAt > 0 ? Math.trunc(a.createdAt) : now
  const updatedAt = typeof a.updatedAt === 'number' && a.updatedAt > 0 ? Math.trunc(a.updatedAt) : createdAt
  getDb().prepare(`
    INSERT INTO annotations (id, book_id, type, color, text, note, locator, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, a.bookId, a.type, a.color ?? '', a.text ?? '', a.note ?? '',
    JSON.stringify(a.locator), createdAt, updatedAt)
  return 'imported'
}
