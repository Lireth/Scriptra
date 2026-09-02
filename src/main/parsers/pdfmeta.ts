/**
 * PDF 主进程导入解析器（pdf.js legacy 构建跑在 Node 主进程）
 *
 * 仅提取元数据与文本用于索引；渲染由渲染进程完成。
 */

import fs from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.js'
import { CONTENT_TEXT_CAP, type ParsedMeta, titleFromFilename } from './common'
import { log } from '../logger'

const MAX_INDEX_PAGES = 150

export async function parsePdfFile(filePath: string): Promise<{ meta: ParsedMeta; contentText: string }> {
  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise

  try {
    let title = ''
    let author = ''
    try {
      const meta = await doc.getMetadata()
      const info = (meta?.info ?? {}) as { Title?: string; Author?: string }
      title = (info.Title ?? '').trim()
      author = (info.Author ?? '').trim()
    } catch { /* 元数据缺失可忽略 */ }

    const parts: string[] = []
    let total = 0
    const pages = Math.min(doc.numPages, MAX_INDEX_PAGES)
    for (let p = 1; p <= pages && total < CONTENT_TEXT_CAP; p++) {
      try {
        const page = await doc.getPage(p)
        const tc = await page.getTextContent()
        const line = tc.items
          .map((it) => ('str' in it ? (it as { str: string }).str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (line) {
          parts.push(line)
          total += line.length
        }
        page.cleanup()
      } catch (e) {
        log.warn(`PDF 第 ${p} 页文本提取失败: ${filePath}`, e)
      }
    }

    return {
      meta: {
        title: title || titleFromFilename(filePath),
        author,
        description: '',
        publisher: '',
        language: '',
        year: '',
      },
      contentText: parts.join('\n').slice(0, CONTENT_TEXT_CAP),
    }
  } finally {
    try { await doc.destroy() } catch { /* 忽略销毁错误 */ }
  }
}
