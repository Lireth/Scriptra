/**
 * TXT 解析器：编码探测 + 章节切分
 */

import fs from 'node:fs'
import { CONTENT_TEXT_CAP, type ParsedMeta, titleFromFilename } from './common'

/** 数字章号（第N章 / Chapter N），供序贯校验提取数值；罗马数字仅参与匹配 */
const CHAPTER_NUM_RE =
  /第\s*([0-9零一二三四五六七八九十百千万两]+)\s*[章回节卷集部篇话]|Chapter\s+(\d+)|CHAPTER\s+([IVXLC\d]+)/

/** 特殊章名（序章/尾声等），全书一般仅出现一次 */
const CHAPTER_SPECIAL_RE = /^(序章|序幕|楔子|引子|尾声|后记|前言|番外)/

/**
 * 章节标题行：关键词开头 + 标题尾（≤30 字符）。
 * 标题部分禁止句读标点——正文句"第三节会议开始前，他出了门"会因此被排除，
 * 而真实章节标题几乎不含这些符号。
 */
const CHAPTER_LINE_RE = new RegExp(
  `^(?:${CHAPTER_NUM_RE.source}|${CHAPTER_SPECIAL_RE.source})\\s*[^，。！？；、…,.!?]{0,30}$`,
)

/** 中文数字转数值（支持 到 万）；无法解析返回 null */
function cnNumToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let total = 0
  let section = 0
  let cur = 0
  for (const ch of s) {
    if (ch in digits) cur = digits[ch]
    else if (ch in units) {
      const u = units[ch]
      if (u === 10000) {
        total = (total + section + cur) * 10000
        section = 0
      } else {
        section += (cur || 1) * u
      }
      cur = 0
    } else {
      return null
    }
  }
  const v = total + section + cur
  return Number.isFinite(v) && v > 0 ? v : null
}

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

  // 收集候选章节行
  const cands: { start: number; title: string; num: number | null; special: string | null }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.length > 50) continue
    if (!CHAPTER_LINE_RE.test(line)) continue
    let num: number | null = null
    const nm = CHAPTER_NUM_RE.exec(line)
    if (nm) {
      if (nm[1]) num = cnNumToInt(nm[1])
      else if (nm[2]) num = parseInt(nm[2], 10)
      // 罗马数字章号（nm[3]）不参与数值校验
      if (num !== null && !Number.isFinite(num)) num = null
    }
    const sm = CHAPTER_SPECIAL_RE.exec(line)
    cands.push({ start: lineOffsets[i], title: line.slice(0, 40), num, special: sm?.[1] ?? null })
  }

  // 序贯过滤：数字章号应保持递增（允许 v===1 的分卷重置）；
  // 章号倒退的行大概率是正文引用（"在第三章里写过"），予以剔除
  const seenSpecial = new Set<string>()
  let lastNum = 0
  for (const c of cands) {
    if (c.special) {
      if (seenSpecial.has(c.special)) continue
      seenSpecial.add(c.special)
    } else if (c.num !== null) {
      if (c.num <= lastNum && c.num !== 1) continue
      lastNum = c.num
    }
    starts.push(c.start)
    titles.push(c.title)
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
