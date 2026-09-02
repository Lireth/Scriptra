/**
 * SQLite 数据库层（基于 Node 内置 node:sqlite，无原生模块依赖）
 *
 * - 书库表 books：元数据、分类、阅读状态、进度
 * - 全文索引 books_fts：FTS5，支持书名 / 作者 / 正文检索
 * - 注释表 annotations：书签 / 高亮 / 笔记
 */

import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from '../logger'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db

  const dir = path.join(app.getPath('userData'), 'library-data')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'scriptra.db')

  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')

  migrate(db)
  log.info('数据库已打开:', file)
  return db
}

export function closeDb(): void {
  if (db) {
    try { db.close() } catch (e) { log.warn('关闭数据库失败:', e) }
    db = null
  }
}

/** 当前 schema 版本：新增迁移时递增，并在 migrations 表中补对应处理 */
const SCHEMA_VERSION = 2

function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const version = row?.user_version ?? 0

  // 兼容处理：若 books_fts 曾以普通表创建，先移除再升级为 FTS5 虚拟表
  const ftsInfo = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'books_fts'").get() as
    { sql: string } | undefined
  let ftsRebuilt = false
  if (ftsInfo && !/using\s+fts5/i.test(ftsInfo.sql)) {
    d.exec('DROP TABLE books_fts')
    ftsRebuilt = true
    log.warn('books_fts 为旧版普通表，已重建为 FTS5 虚拟表')
  }

  // v1 -> v2：旧库的 annotations 表无外键，删除书籍会残留孤儿注释。
  // 检测到缺失 REFERENCES 时重建该表以启用级联删除。
  const annInfo = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'annotations'").get() as
    { sql: string } | undefined
  const needAnnFk = !!annInfo && !/references\s+books/i.test(annInfo.sql)
  if (needAnnFk) {
    d.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE annotations_new (
        id         TEXT PRIMARY KEY,
        book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '',
        text       TEXT NOT NULL DEFAULT '',
        note       TEXT NOT NULL DEFAULT '',
        locator    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO annotations_new SELECT id, book_id, type, color, text, note, locator, created_at, updated_at
        FROM annotations WHERE book_id IN (SELECT id FROM books);
      DROP TABLE annotations;
      ALTER TABLE annotations_new RENAME TO annotations;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
    log.info('已为 annotations 表补建外键（级联删除），并清理孤儿注释')
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      author          TEXT NOT NULL DEFAULT '',
      format          TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT '未分类',
      status          TEXT NOT NULL DEFAULT 'unread',
      favorite        INTEGER NOT NULL DEFAULT 0,
      rating          INTEGER NOT NULL DEFAULT 0,
      description     TEXT NOT NULL DEFAULT '',
      publisher       TEXT NOT NULL DEFAULT '',
      language        TEXT NOT NULL DEFAULT '',
      year            TEXT NOT NULL DEFAULT '',
      source_path     TEXT NOT NULL DEFAULT '',
      stored_path     TEXT NOT NULL,
      cover_path      TEXT NOT NULL DEFAULT '',
      size            INTEGER NOT NULL DEFAULT 0,
      progress        REAL NOT NULL DEFAULT 0,
      progress_detail TEXT NOT NULL DEFAULT '',
      file_hash       TEXT NOT NULL DEFAULT '',
      content_indexed INTEGER NOT NULL DEFAULT 0,
      added_at        INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_read_at    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_books_status    ON books(status);
    CREATE INDEX IF NOT EXISTS idx_books_category  ON books(category);
    CREATE INDEX IF NOT EXISTS idx_books_lastread  ON books(last_read_at DESC);
    CREATE INDEX IF NOT EXISTS idx_books_hash      ON books(file_hash);

    CREATE TABLE IF NOT EXISTS annotations (
      id         TEXT PRIMARY KEY,
      book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      locator    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ann_book ON annotations(book_id, type);

    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      book_id UNINDEXED,
      title,
      author,
      content
    );
  `)

  // FTS 被重建（旧版普通表升级）后，正文内容无法从 books 表恢复：
  // 复位 content_indexed，打开书籍时由 buildOpenPayload 惰性重建
  // （EPUB/TXT/PDF 在主进程提取，MOBI 由渲染引擎回传文本）；
  // 同时用 books 表现有书名/作者回填 FTS，保证元数据检索立即可用。
  // 注意：仅在实际发生重建时复位，避免健康库升级后误清 EPUB/TXT 的正文索引。
  if (ftsRebuilt) {
    rebuildFtsMeta(d)
    d.exec('UPDATE books SET content_indexed = 0')
    log.info('已重建全文索引元数据并复位正文索引标记（下次打开书籍将重建正文索引）')
  }

  if (version !== SCHEMA_VERSION) {
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
}

/** 用 books 表的标题/作者重建 FTS 行（正文留空，由惰性索引或重新导入补全） */
export function rebuildFtsMeta(d: DatabaseSync = getDb()): void {
  const books = d.prepare('SELECT id, title, author FROM books').all() as unknown as
    { id: string; title: string; author: string }[]
  d.exec('DELETE FROM books_fts')
  const ins = d.prepare('INSERT INTO books_fts (book_id, title, author, content) VALUES (?, ?, ?, ?)')
  for (const b of books) {
    ins.run(b.id, cjkSpace(b.title), cjkSpace(b.author), '')
  }
}

/** 中文逐字切分：CJK 字符之间插入空格，配合 FTS5 短语查询实现子串检索 */
export function cjkSpace(text: string): string {
  return text.replace(/([\u4e00-\u9fff])/g, '$1 ').trim()
}
