/**
 * TXT 解析器：编码探测 + 章节切分
 */

import fs from 'node:fs'
import { CONTENT_TEXT_CAP, type ParsedMeta, titleFromFilename } from './common'

const CHAPTER_RE =
  /^\s*(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章回节卷集部篇话]|Chapter\s+\d+|CHAPTER\s+[IVXLC\d]+|序章|序幕|楔子|引子|尾声|后记|前言|番外)\s*[^\n]{0,40}$/m

export interface TxtParseResult {
  meta: ParsedMeta
  contentText: string
  /** UTF-8 全文 */
  text: string
  /** 各章节在全文中的起始偏移（字符数） */
  chapterStarts: number[]
  chapterTitles: string[]
}

export function decodeText(buf: Buffer): string {
  // BOM 检测
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf-8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2))
  }
  // 严格 UTF-8 解码失败则回退 GB18030
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gb18030').decode(buf)
  }
}

export function splitChapters(text: string): { starts: number[]; titles: string[] } {
  const lines = text.split('\n')
  const starts: number[] = []
  const titles: string[] = []

  // 计算每行起始偏移
  let offset = 0
  const lineOffsets: number[] = []
  for (const line of lines) {
    lineOffsets.push(offset)
    offset += line.length + 1
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.length > 50) continue
    if (CHAPTER_RE.test(line) || new RegExp(CHAPTER_RE.source.replace('^\\s*', '^')).test(line)) {
      starts.push(lineOffsets[i])
      titles.push(line.slice(0, 40))
    }
  }

  // 章节过少则不切分
  if (starts.length < 2) {
    return { starts: [0], titles: ['全文'] }
  }
  // 若第一章之前还有大量内容，补充“开篇”
  if (starts[0] > 2000) {
    starts.unshift(0)
    titles.unshift('开篇')
  }
  return { starts, titles }
}

export function parseTxtFile(filePath: string): TxtParseResult {
  const buf = fs.readFileSync(filePath)
  const text = decodeText(buf)
  const { starts, titles } = splitChapters(text)
  const meta: ParsedMeta = {
    title: titleFromFilename(filePath),
    author: '',
    description: '',
    publisher: '',
    language: 'zh',
    year: '',
  }
  return {
    meta,
    contentText: text.slice(0, CONTENT_TEXT_CAP),
    text,
    chapterStarts: starts,
    chapterTitles: titles,
  }
}
