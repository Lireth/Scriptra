/**
 * MOBI (MOBI7/PalmDoc + HUFF/CDIC) 主进程导入解析器
 *
 * 算法参考 foliate-js（MIT License, Copyright (c) 2020 John Factotum），
 * 仅取其二进制解析逻辑以 TypeScript 重新实现，用于提取元数据 / 封面 / 纯文本。
 * 阅读渲染由渲染进程内置的 foliate 引擎完成（支持 MOBI6 与 KF8）。
 */

import fs from 'node:fs'
import {
  CONTENT_TEXT_CAP, stripHtml,
  type CoverData, type ParsedMeta, titleFromFilename,
} from './common'
import { log } from '../logger'

/* ------------------------------ 基础工具 ------------------------------ */

function getUint(buf: Uint8Array, offset: number, size: 1 | 2 | 4): number {
  if (size === 1) return buf[offset]
  if (size === 2) return (buf[offset] << 8) | buf[offset + 1]
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
}

/** 从数据末尾反向读取变长整数（MOBI 尾部条目） */
function getVarLenFromEnd(a: Uint8Array): number {
  let value = 0
  const start = Math.max(0, a.length - 4)
  for (let i = start; i < a.length; i++) {
    if (a[i] & 0b1000_0000) value = 0
    value = (value << 7) | (a[i] & 0b0111_1111)
  }
  return value
}

function countBitsSet(x: number): number {
  let count = 0
  for (; x > 0; x >>= 1) if (x & 1) count++
  return count
}

/** PalmDOC LZ77 解压 */
function decompressPalmDOC(array: Uint8Array): Uint8Array {
  const output: number[] = []
  for (let i = 0; i < array.length; i++) {
    const byte = array[i]
    if (byte === 0) output.push(0)
    else if (byte <= 8) {
      for (let j = 0; j < byte; j++) output.push(array[++i])
    } else if (byte <= 0b0111_1111) output.push(byte)
    else if (byte <= 0b1011_1111) {
      const bytes = (byte << 8) | array[++i]
      const distance = (bytes & 0b0011_1111_1111_1111) >>> 3
      const length = (bytes & 0b111) + 3
      for (let j = 0; j < length; j++) output.push(output[output.length - distance])
    } else {
      output.push(32, byte ^ 0b1000_0000)
    }
  }
  return Uint8Array.from(output)
}

/** 32 位位读取（HUFF 解码用） */
function read32Bits(byteArray: Uint8Array, from: number): number {
  const startByte = from >> 3
  const end = from + 32
  const endByte = end >> 3
  let bits = 0n
  for (let i = startByte; i <= endByte; i++) {
    bits = (bits << 8n) | BigInt(byteArray[i] ?? 0)
  }
  return Number((bits >> BigInt(8 - (end & 7))) & 0xffffffffn)
}

/** HUFF/CDIC 解压器（MOBI 压缩类型 17480） */
function buildHuffCdic(
  buf: Buffer,
  huffcdic: number,
  numHuffcdic: number,
  recordAt: (i: number) => Uint8Array,
): (a: Uint8Array) => Uint8Array {
  const huff = recordAt(huffcdic)
  const offset1 = getUint(huff, 8, 4)
  const offset2 = getUint(huff, 12, 4)
  const table1: [number, number, number][] = []
  for (let i = 0; i < 256; i++) {
    const x = getUint(huff, offset1 + i * 4, 4)
    table1.push([x & 0b1000_0000, x & 0b1_1111, x >>> 8])
  }
  const table2: ([number, number] | null)[] = [null]
  for (let i = 0; i < 32; i++) {
    table2.push([
      getUint(huff, offset2 + i * 8, 4),
      getUint(huff, offset2 + i * 8 + 4, 4),
    ])
  }
  const dictionary: [Uint8Array, boolean][] = []
  for (let i = 1; i < numHuffcdic; i++) {
    const cdic = recordAt(huffcdic + i)
    const codeLength = getUint(cdic, 8, 2)
    const numEntries = getUint(cdic, 12, 2)
    const n = Math.min(1 << codeLength, numEntries - dictionary.length)
    const buffer = cdic.subarray(getUint(cdic, 4, 4))
    for (let j = 0; j < n; j++) {
      const offset = getUint(buffer, j * 2, 2)
      const x = getUint(buffer, offset, 2)
      const length = x & 0x7fff
      const decompressed = (x & 0x8000) !== 0
      dictionary.push([buffer.subarray(offset + 2, offset + 2 + length), decompressed])
    }
  }
  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const r = new Uint8Array(a.length + b.length)
    r.set(a); r.set(b, a.length)
    return r
  }
  const decompress = (byteArray: Uint8Array): Uint8Array => {
    let output: Uint8Array = new Uint8Array()
    const bitLength = byteArray.byteLength * 8
    for (let i = 0; i < bitLength;) {
      const bits = read32Bits(byteArray, i)
      let [found, codeLength, value] = table1[bits >>> 24]
      if (!found) {
        while (bits >>> (32 - codeLength) < table2[codeLength]![0]) codeLength += 1
        value = table2[codeLength]![1]
      }
      if ((i += codeLength) > bitLength) break
      const code = value - (bits >>> (32 - codeLength))
      const entry = dictionary[code]
      if (!entry) break
      let [result, isDecompressed] = entry
      if (!isDecompressed) {
        result = decompress(result)
        dictionary[code] = [result, true]
      }
      output = concat(output, result)
    }
    return output
  }
  void buf
  return decompress
}

/* ------------------------------ 主流程 ------------------------------ */

export interface MobiParseResult {
  meta: ParsedMeta
  cover: CoverData | null
  contentText: string
  isKf8: boolean
}

export function parseMobiFile(filePath: string): MobiParseResult {
  const buf = fs.readFileSync(filePath)
  const numRecords = buf.readUInt16BE(76)
  const offsets: number[] = []
  for (let i = 0; i < numRecords; i++) offsets.push(buf.readUInt32BE(78 + i * 8))

  const recordAt = (i: number): Uint8Array => {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    if (start === undefined) throw new RangeError(`MOBI 记录越界: ${i}`)
    return buf.subarray(start, end)
  }

  const r0 = recordAt(0)
  const r0buf = Buffer.from(r0.buffer, r0.byteOffset, r0.byteLength)

  // PDB 名称（兜底标题）
  const pdbName = r0buf.subarray(0, 32).toString('latin1').replace(/\0.*$/, '').trim()
  const fallbackTitle = titleFromFilename(filePath)

  // PalmDOC 头
  const compression = r0buf.readUInt16BE(0)
  const numTextRecords = r0buf.readUInt16BE(8)
  const encryption = r0buf.readUInt16BE(12)
  if (encryption !== 0) throw new Error('该 MOBI 文件已加密，暂不支持')

  const magic = r0buf.subarray(16, 20).toString('latin1')
  let encoding: string = 'utf-8'
  let titleOffset = 0
  let titleLength = pdbName.length
  let resourceStart = numRecords
  let huffcdic = -1
  let numHuffcdic = 0
  let exthFlag = 0
  let trailingFlags = 0
  let mobiVersion = 0
  let headerLength = 0
  let exthData: Uint8Array | null = null

  if (magic === 'MOBI') {
    mobiVersion = r0buf.readUInt32BE(36)
    headerLength = r0buf.readUInt32BE(20)
    encoding = r0buf.readUInt32BE(28) === 1252 ? 'windows-1252' : 'utf-8'
    titleOffset = r0buf.readUInt32BE(84)
    titleLength = r0buf.readUInt32BE(88)
    resourceStart = r0buf.readUInt32BE(108)
    huffcdic = r0buf.readUInt32BE(112)
    numHuffcdic = r0buf.readUInt32BE(116)
    exthFlag = r0buf.readUInt32BE(128)
    trailingFlags = headerLength >= 0xE4 ? r0buf.readUInt32BE(240) : 0
    if (exthFlag & 0x40) exthData = r0.subarray(16 + headerLength)
  } else {
    // PalmDOC 纯文本（TEXtREAd），无 MOBI 头
    encoding = 'windows-1252'
    titleLength = pdbName.length
  }

  // EXTH 解析
  const exth = parseExth(exthData)

  const decoder = new TextDecoder(encoding)
  const decode = (a: Uint8Array): string => decoder.decode(a)

  let title = ''
  if (magic === 'MOBI' && titleLength > 0 && titleOffset > 0) {
    title = decode(r0.subarray(titleOffset, titleOffset + titleLength))
  }
  title = (exth?.title || title || pdbName || fallbackTitle).trim()

  const meta: ParsedMeta = {
    title,
    author: exth?.creator ?? '',
    description: exth?.description ?? '',
    publisher: exth?.publisher ?? '',
    language: exth?.language ?? '',
    year: (exth?.date ?? '').match(/\d{4}/)?.[0] ?? '',
  }

  // 封面：EXTH 201 指向的资源记录，或从资源区顺序扫描图片魔数
  let cover: CoverData | null = null
  const imageAt = (recIndex: number): CoverData | null => {
    try {
      const raw = recordAt(resourceStart + recIndex)
      const mime = sniffImage(raw)
      return mime ? { mime, bytes: Buffer.from(raw) } : null
    } catch { return null }
  }
  if (exth?.coverOffset !== undefined) cover = imageAt(exth.coverOffset)
  if (!cover) {
    for (let i = 0; i < Math.min(numRecords - resourceStart, 60); i++) {
      const hit = imageAt(i)
      if (hit) { cover = hit; break }
    }
  }

  // 正文（仅 MOBI7；KF8 由渲染进程打开后延迟回传建立索引）
  const isKf8 = mobiVersion >= 8 || (exth?.boundary !== undefined && exth.boundary < 0xffffffff)
  let contentText = ''
  if (!isKf8 && numTextRecords > 0) {
    try {
      let decompress: (a: Uint8Array) => Uint8Array
      if (compression === 1) decompress = (a) => a
      else if (compression === 2) decompress = decompressPalmDOC
      else if (compression === 17480) {
        decompress = buildHuffCdic(buf, huffcdic, numHuffcdic, recordAt)
      } else throw new Error(`未知压缩类型: ${compression}`)

      const multibyte = (trailingFlags & 1) !== 0
      const numTrailing = countBitsSet(trailingFlags >>> 1)
      const chunks: Uint8Array[] = []
      let total = 0
      for (let i = 1; i <= numTextRecords && total < CONTENT_TEXT_CAP; i++) {
        let rec = recordAt(i)
        for (let k = 0; k < numTrailing; k++) {
          const n = getVarLenFromEnd(rec)
          rec = rec.subarray(0, rec.length - Math.min(n, rec.length))
        }
        if (multibyte && rec.length) {
          const n = (rec[rec.length - 1] & 0b11) + 1
          rec = rec.subarray(0, rec.length - Math.min(n, rec.length))
        }
        const text = decompress(rec)
        chunks.push(text)
        total += text.length
      }
      const all = chunks.reduce((acc, cur) => {
        const r = new Uint8Array(acc.length + cur.length)
        r.set(acc); r.set(cur, acc.length)
        return r
      }, new Uint8Array())
      contentText = stripHtml(decode(all)).slice(0, CONTENT_TEXT_CAP)
    } catch (e) {
      log.warn(`MOBI 正文解压失败（不影响导入）: ${filePath}`, e)
    }
  }

  return { meta, cover, contentText, isKf8 }
}

interface ExthData {
  title?: string
  creator?: string
  publisher?: string
  description?: string
  language?: string
  date?: string
  coverOffset?: number
  thumbnailOffset?: number
  boundary?: number
}

function parseExth(data: Uint8Array | null): ExthData | null {
  if (!data || data.length < 12) return null
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (buf.subarray(0, 4).toString('latin1') !== 'EXTH') return null
  const count = buf.readUInt32BE(8)
  let pos = 12
  const out: ExthData = {}
  const str = (b: Buffer) => {
    const t = new TextDecoder('utf-8', { fatal: false }).decode(b)
    return t
  }
  for (let i = 0; i < count && pos + 8 <= buf.length; i++) {
    const type = buf.readUInt32BE(pos)
    const len = buf.readUInt32BE(pos + 4)
    if (len < 8 || pos + len > buf.length) break
    const value = buf.subarray(pos + 8, pos + len)
    // 数值型 EXTH（boundary/cover/thumbnail offset）需至少 4 字节，
    // 畸形或被截断的 MOBI 会给出更短的 value，越界读会抛 RangeError
    const u32 = (b: Buffer): number | undefined => (b.length >= 4 ? b.readUInt32BE(0) : undefined)
    switch (type) {
      case 100: out.creator = out.creator ? out.creator + ', ' + str(value) : str(value); break
      case 101: out.publisher = str(value); break
      case 103: out.description = str(value); break
      case 104: break
      case 106: out.date = str(value); break
      case 113: out.boundary = u32(value); break
      case 201: out.coverOffset = u32(value); break
      case 202: out.thumbnailOffset = u32(value); break
      case 503: out.title = str(value); break
      case 524: out.language = str(value); break
      default: break
    }
    pos += len
  }
  return out
}

function sniffImage(b: Uint8Array): string | null {
  if (b.length < 8) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}
