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

function migrate(d: DatabaseSync): void {
  // 兼容处理：若 books_fts 曾以普通表创建，先移除再升级为 FTS5 虚拟表
  const ftsInfo = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'books_fts'").get() as
    { sql: string } | undefined
  if (ftsInfo && !/using\s+fts5/i.test(ftsInfo.sql)) {
    d.exec('DROP TABLE books_fts')
    log.warn('books_fts 为旧版普通表，已重建为 FTS5 虚拟表（需重新导入或重建索引）')
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
      book_id    TEXT NOT NULL,
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
}

/** 中文逐字切分：CJK 字符之间插入空格，配合 FTS5 短语查询实现子串检索 */
export function cjkSpace(text: string): string {
  return text.replace(/([\u4e00-\u9fff])/g, '$1 ').trim()
}
