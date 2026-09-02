/**
 * PDF 主进程导入解析器（pdf.js legacy 构建跑在 Node 主进程）
 *
 * 提取元数据与全书文本用于索引；渲染由渲染进程完成。
 * - 无页数上限，逐页提取直至全书完成
 * - 通过 onProgress 回调回报提取进度（页码），供导入界面展示
 * - 保留超大字符安全上限（约数千页文本量），防御构造异常的 PDF
 */

import fs from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.js'
import { type ParsedMeta, titleFromFilename } from './common'
import { log } from '../logger'

/** 全文索引的字符安全上限（防御解压炸弹类 PDF），约相当于 3000+ 页密集文本 */
const PDF_TEXT_CAP = 8_000_000

/** 每页提取之间的让步间隔：每隔 N 页让出事件循环，保持 IPC / 进度事件畅通 */
const YIELD_EVERY_PAGES = 8

const setImmediateP = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export type PdfExtractProgress = (page: number, numPages: number) => void

export async function parsePdfFile(
  filePath: string,
  onProgress?: PdfExtractProgress,
): Promise<{ meta: ParsedMeta; contentText: string }> {
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

    const numPages = doc.numPages
    const parts: string[] = []
    let total = 0
    let hitCap = false

    for (let p = 1; p <= numPages; p++) {
      if (total >= PDF_TEXT_CAP) {
        hitCap = true
        break
      }
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

      onProgress?.(p, numPages)
      // 定期让出事件循环，避免大文档提取期间阻塞进度事件与窗口消息
      if (p % YIELD_EVERY_PAGES === 0) await setImmediateP()
    }

    if (hitCap) {
      log.warn(`PDF 文本达到索引安全上限（${PDF_TEXT_CAP} 字符），后续页未索引: ${filePath}`)
    }
    log.info(`PDF 全文索引完成: ${filePath}（共 ${numPages} 页，提取 ${total} 字符）`)

    return {
      meta: {
        title: title || titleFromFilename(filePath),
        author,
        description: '',
        publisher: '',
        language: '',
        year: '',
      },
      contentText: parts.join('\n').slice(0, PDF_TEXT_CAP),
    }
  } finally {
    try { await doc.destroy() } catch { /* 忽略销毁错误 */ }
  }
}
