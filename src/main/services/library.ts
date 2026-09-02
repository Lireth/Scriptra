/**
 * 书库服务：扫描 / 导入 / 删除 / 封面读取
 */

import { WebContents } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { IPC, type Book, type BookFormat, type BookManifest, type ImportOutcome, type ImportProgressEvent, type OpenBookPayload } from '../../shared/types'
import { log } from '../logger'
import { findByHash, getBook, getBookPaths, insertBook, removeBooks } from '../db/books'
import { cjkSpace, getDb } from '../db/database'
import { parseEpubFile, parseEpubZip } from '../parsers/epub'
import { parseMobiFile } from '../parsers/mobimeta'
import { parsePdfFile } from '../parsers/pdfmeta'
import { decodeText, parseTxtFile, splitChapters } from '../parsers/txt'
import { CONTENT_TEXT_CAP } from '../parsers/common'

export const IMPORT_EXTS: Record<string, BookFormat> = {
  '.epub': 'epub',
  '.pdf': 'pdf',
  '.mobi': 'mobi',
  '.azw': 'mobi',
  '.txt': 'txt',
}

export function libraryDir(): string {
  const dir = path.join(app.getPath('userData'), 'library')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sendProgress(sender: WebContents | null, evt: ImportProgressEvent): void {
  try { sender?.send(IPC.EventImportProgress, evt) } catch { /* 窗口可能已关闭 */ }
}

/** 应用退出标志：导入循环据此中止，避免中途被杀留下脏数据 */
let quitRequested = false
export function requestQuitImports(): void { quitRequested = true }

/** 导入防重入锁：并发导入会让同一文件绕过 hash 去重检查、重复入库 */
let importing = false

/** 文件指纹：大小 + 首部 64KB 哈希，用于去重 */
function fileHash(filePath: string, size: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(Math.min(65536, size))
    fs.readSync(fd, head, 0, head.length, 0)
    return crypto.createHash('sha1').update(`${size}:`).update(head).digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

async function importOne(
  filePath: string,
  sender: WebContents | null,
  index: number,
  total: number,
): Promise<'imported' | 'skipped'> {
  const ext = path.extname(filePath).toLowerCase()
  const format = IMPORT_EXTS[ext]
  if (!format) throw new Error('不支持的文件格式')

  const stat = await fsp.stat(filePath)
  const hash = fileHash(filePath, stat.size)
  if (findByHash(hash)) return 'skipped'

  sendProgress(sender, { current: index, total, path: filePath, stage: 'import' })

  // 解析元数据 / 封面 / 正文
  let title = ''
  let author = ''
  let description = ''
  let publisher = ''
  let language = ''
  let year = ''
  let cover: { mime: string; bytes: Buffer } | null = null
  let contentText = ''
  let contentIndexed = false

  if (format === 'epub') {
    const r = await parseEpubFile(filePath)
    ;({ title, author, description, publisher, language, year } = r.meta)
    cover = r.cover
    contentText = r.contentText
    contentIndexed = true
  } else if (format === 'mobi') {
    const r = parseMobiFile(filePath)
    ;({ title, author, description, publisher, language, year } = r.meta)
    cover = r.cover
    contentText = r.contentText
    contentIndexed = !!contentText
  } else if (format === 'pdf') {
    const r = await parsePdfFile(filePath, (page, numPages) => {
      sendProgress(sender, { current: page, total: numPages, path: filePath, stage: 'pdf-text' })
    })
    ;({ title, author } = r.meta)
    contentText = r.contentText
    contentIndexed = !!contentText
  } else {
    const r = parseTxtFile(filePath)
    ;({ title, author } = r.meta)
    language = r.meta.language
    contentText = r.contentText
    contentIndexed = true
  }

  // 先落盘再入库：失败时清理临时文件，不留下脏数据
  const id = randomUUID()
  const storedPath = path.join(libraryDir(), `${id}${ext}`)
  let coverPath = ''
  try {
    await fsp.copyFile(filePath, storedPath)

    if (cover) {
      const extMap: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
        'image/webp': '.webp', 'image/svg+xml': '.svg',
      }
      coverPath = path.join(coversDir(), id + (extMap[cover.mime] ?? '.jpg'))
      await fsp.writeFile(coverPath, cover.bytes)
    }

    insertBook({
      id,
      title: title || path.basename(filePath, ext),
      author,
      format,
      description,
      publisher,
      language,
      year,
      storedPath,
      coverPath,
      sourcePath: filePath,
      size: stat.size,
      fileHash: hash,
      contentIndexed,
    })

    if (contentText) {
      getDb().prepare('DELETE FROM books_fts WHERE book_id = ?').run(id)
      getDb().prepare('INSERT INTO books_fts (book_id, title, author, content) VALUES (?, ?, ?, ?)')
        .run(id, cjkSpace(title), cjkSpace(author), cjkSpace(contentText.slice(0, CONTENT_TEXT_CAP)))
    }
  } catch (e) {
    // 回滚：删除已落盘的文件
    try { await fsp.unlink(storedPath) } catch { /* ignore */ }
    if (coverPath) { try { await fsp.unlink(coverPath) } catch { /* ignore */ } }
    throw e
  }

  return 'imported'
}

export async function importFiles(paths: string[], sender: WebContents | null): Promise<ImportOutcome> {
  if (importing) {
    log.warn('已有导入任务在进行中，忽略重复请求')
    return { imported: 0, skipped: 0, failed: [] }
  }
  importing = true
  try {
    return await runImport(paths, sender)
  } finally {
    importing = false
  }
}

async function runImport(paths: string[], sender: WebContents | null): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: 0, skipped: 0, failed: [] }
  const total = paths.length
  for (let i = 0; i < paths.length; i++) {
    if (quitRequested) {
      log.info('应用退出，导入中止')
      break
    }
    const p = paths[i]
    try {
      const r = await importOne(p, sender, i + 1, total)
      if (r === 'imported') outcome.imported++
      else outcome.skipped++
    } catch (e) {
      log.warn(`导入失败: ${p}`, e)
      outcome.failed.push({ path: p, reason: e instanceof Error ? e.message : String(e) })
    }
    sendProgress(sender, { current: i + 1, total, path: p, stage: 'import' })
  }
  log.info(`导入完成: 成功 ${outcome.imported}，跳过 ${outcome.skipped}，失败 ${outcome.failed.length}`)
  return outcome
}

/** 递归扫描目录下的电子书文件 */
export async function scanFolder(
  folder: string,
  sender: WebContents | null,
): Promise<ImportOutcome> {
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || files.length > 2000) return
    let entries: fs.Dirent[] = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full, depth + 1)
      else if (ent.isFile() && IMPORT_EXTS[path.extname(ent.name).toLowerCase()]) {
        files.push(full)
      }
    }
  }
  await walk(folder, 0)
  log.info(`扫描目录 ${folder}: 发现 ${files.length} 个电子书文件`)
  return importFiles(files, sender)
}

export async function deleteBooks(ids: string[]): Promise<void> {
  const { storedPaths, coverPaths } = removeBooks(ids)
  for (const id of ids) closeSessionFor(id)
  for (const p of [...storedPaths, ...coverPaths]) {
    try { await fsp.unlink(p) } catch { /* 文件可能已不存在 */ }
  }
}

/* ------------------------------ 阅读会话（LRU） ------------------------------ */

interface Session {
  id: string
  format: BookFormat
  buffer: Buffer
  zip?: JSZip
  manifest?: BookManifest
  lastUsed: number
}

const MAX_SESSIONS = 2
const sessions = new Map<string, Session>()

export function closeSessionFor(id: string): void {
  sessions.delete(id)
}

function touch(s: Session): void {
  s.lastUsed = Date.now()
  // LRU：仅保留最近使用的有限会话，控制内存占用
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (oldest) sessions.delete(oldest.id)
  }
}

async function getSession(book: Book): Promise<Session> {
  const existing = sessions.get(book.id)
  if (existing) {
    touch(existing)
    return existing
  }
  const paths = getBookPaths(book.id)
  if (!paths || !paths.storedPath) throw new Error('书籍文件缺失')
  const buffer = await fsp.readFile(paths.storedPath)

  const s: Session = { id: book.id, format: book.format, buffer, lastUsed: Date.now() }
  if (book.format === 'epub') {
    s.zip = await JSZip.loadAsync(buffer)
    const parsed = await parseEpubZip(s.zip, book.title)
    s.manifest = parsed.manifest
  }
  sessions.set(book.id, s)
  touch(s)
  return s
}

/** 打开书籍：返回渲染进程所需载荷 */
export async function buildOpenPayload(book: Book): Promise<{
  payload: Omit<OpenBookPayload, 'annotations'>
}> {
  const s = await getSession(book)
  const base = {
    id: book.id,
    format: book.format,
    title: book.title,
    author: book.author,
    progress: book.progress,
    progressDetail: book.progressDetail,
    contentIndexed: book.contentIndexed,
  }

  if (book.format === 'epub') {
    return { payload: { ...base, manifest: s.manifest } }
  }
  if (book.format === 'pdf' || book.format === 'mobi') {
    const ab = s.buffer.buffer.slice(s.buffer.byteOffset, s.buffer.byteOffset + s.buffer.byteLength) as ArrayBuffer
    return { payload: { ...base, fileData: ab } }
  }
  // TXT：解码 + 章节切分
  const text = decodeText(s.buffer)
  const { starts, titles } = splitChapters(text)
  const ab = Buffer.from(text, 'utf-8')
  return {
    payload: {
      ...base,
      fileData: ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength) as ArrayBuffer,
      manifest: {
        spine: titles.map((t) => ({ href: '', title: t })),
        toc: [],
        chapterStarts: starts,
      },
    },
  }
}

/** EPUB 内部资源 */
export async function getEpubResource(
  bookId: string,
  resPath: string,
): Promise<{ mime: string; bytes: ArrayBuffer } | null> {
  // 会话可能已被 LRU 驱逐，此时按 bookId 重建，避免图片/样式裂图
  let s = sessions.get(bookId)
  if (!s?.zip) {
    const book = getBook(bookId)
    if (!book || book.format !== 'epub') return null
    try {
      s = await getSession(book)
    } catch (e) {
      log.warn(`重建 EPUB 会话失败: ${bookId}`, e)
      return null
    }
  }
  if (!s.zip) return null
  const entry = s.zip.file(resPath) ?? s.zip.file(safeDecodePath(resPath))
  if (!entry) return null
  // ZIP 炸弹防护：单条目解压后体积超限直接拒绝，避免主进程 OOM
  const uncompressed = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
  if (typeof uncompressed === 'number' && uncompressed > MAX_EPUB_RESOURCE_BYTES) {
    log.warn(`EPUB 资源过大已拒绝: ${resPath} (${uncompressed} bytes)`)
    return null
  }
  const name = resPath.toLowerCase()
  const mime = name.endsWith('.png') ? 'image/png'
    : name.endsWith('.gif') ? 'image/gif'
    : name.endsWith('.webp') ? 'image/webp'
    : name.endsWith('.svg') ? 'image/svg+xml'
    : name.endsWith('.css') ? 'text/css'
    : name.endsWith('.otf') ? 'font/otf'
    : name.endsWith('.ttf') ? 'font/ttf'
    : name.endsWith('.woff2') ? 'font/woff2'
    : name.endsWith('.woff') ? 'font/woff'
    : name.endsWith('.xhtml') || name.endsWith('.html') || name.endsWith('.htm') ? 'text/html'
    : 'image/jpeg'
  const bytes = await entry.async('arraybuffer')
  return { mime, bytes }
}

/** 单条目解压上限 32MB */
const MAX_EPUB_RESOURCE_BYTES = 32 * 1024 * 1024

function safeDecodePath(p: string): string {
  try { return decodeURIComponent(p) } catch { return p }
}

export function getFileBuffer(bookId: string): ArrayBuffer | null {
  const s = sessions.get(bookId)
  if (!s) return null
  return s.buffer.buffer.slice(s.buffer.byteOffset, s.buffer.byteOffset + s.buffer.byteLength) as ArrayBuffer
}

/** 封面 data URL（渲染进程网格展示用） */
export function coverDataUrl(bookId: string): string | null {
  const paths = getBookPaths(bookId)
  if (!paths?.coverPath || !fs.existsSync(paths.coverPath)) return null
  const buf = fs.readFileSync(paths.coverPath)
  const ext = path.extname(paths.coverPath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}
