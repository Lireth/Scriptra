/**
 * IPC 入参净化：所有来自渲染进程的写通道数据在此统一校验，
 * 收敛"不可信书籍内容 + 全量 IPC"的攻击面（枚举白名单、数值夹取、
 * 字符串长度上限、数组数量上限、路径扩展名白名单）。
 */

import path from 'node:path'
import {
  type AnnotationType, type AnnotationLocator, type BookFormat, type ProgressDetail,
  type ReadingStatus,
} from '../../shared/types'

const STATUSES: ReadingStatus[] = ['unread', 'reading', 'finished']
const FORMATS: BookFormat[] = ['epub', 'pdf', 'mobi', 'txt']
const ANN_TYPES: AnnotationType[] = ['bookmark', 'highlight', 'note']

export const IMPORT_EXTS_SET = new Set(['.epub', '.pdf', '.mobi', '.azw', '.txt'])

/** 字符串：非字符串转空，超长截断 */
export function str(v: unknown, max = 4000): string {
  if (typeof v !== 'string') return ''
  return v.length > max ? v.slice(0, max) : v
}

/** 可选字符串：undefined 保持 undefined（用于 patch 局部更新语义） */
export function optStr(v: unknown, max = 4000): string | undefined {
  if (v === undefined) return undefined
  return str(v, max)
}

/** 布尔 */
export function bool(v: unknown): boolean {
  return !!v
}

/** 整数夹取 */
export function int(v: unknown, def: number, min: number, max: number): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

/** 0~1 浮点夹取 */
export function ratio(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/** 枚举白名单，非法回落默认值 */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return allowed.includes(v as T) ? (v as T) : def
}

/** 字符串数组：逐项 String 化、去空、限量 */
export function strArray(v: unknown, max: number, itemMax = 2048): string[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, max).map((x) => str(x, itemMax)).filter(Boolean)
}

/** 导入路径数组：限量 + 扩展名白名单，过滤越权文件 */
export function importPaths(v: unknown, max = 500): string[] {
  const list = strArray(v, max)
  return list.filter((p) => IMPORT_EXTS_SET.has(path.extname(p).toLowerCase()))
}

/** 阅读进度定位：仅接受 doc / pdf 两态，其余视为无定位 */
export function progressDetail(v: unknown): ProgressDetail | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind === 'doc') {
    return { kind: 'doc', chapter: int(o.chapter, 0, 0, 1_000_000), ratio: ratio(o.ratio) }
  }
  if (o.kind === 'pdf') {
    return { kind: 'pdf', page: int(o.page, 1, 1, 1_000_000), top: ratio(o.top) }
  }
  return null
}

/** 注释定位：校验四态结构，非法返回 null（由调用方拒绝写入） */
export function annotationLocator(v: unknown): AnnotationLocator | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  switch (o.kind) {
    case 'text':
      return {
        kind: 'text',
        chapter: int(o.chapter, 0, 0, 1_000_000),
        start: int(o.start, 0, 0, 100_000_000),
        end: int(o.end, 0, 0, 100_000_000),
      }
    case 'doc':
      return { kind: 'doc', chapter: int(o.chapter, 0, 0, 1_000_000), ratio: ratio(o.ratio) }
    case 'page':
      return { kind: 'page', page: int(o.page, 1, 1, 1_000_000), top: ratio(o.top) }
    case 'pdf': {
      const rects = Array.isArray(o.rects)
        ? o.rects.slice(0, 64).map((r) => {
            const a = Array.isArray(r) ? r : []
            return [ratio(a[0]), ratio(a[1]), ratio(a[2]), ratio(a[3])] as [number, number, number, number]
          })
        : []
      return { kind: 'pdf', page: int(o.page, 1, 1, 1_000_000), rects }
    }
    default:
      return null
  }
}

export { STATUSES, FORMATS, ANN_TYPES }
