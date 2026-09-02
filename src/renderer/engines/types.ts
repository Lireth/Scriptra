/**
 * 阅读引擎契约：主壳与各格式引擎之间的接口
 */

import type {
  Annotation, AnnotationLocator, BookFormat, OpenBookPayload, ProgressDetail, ReaderStyle,
} from '../../shared/types'

export type EnginePayload = Omit<OpenBookPayload, 'annotations'> & { annotations: Annotation[] }

export interface ProgressInfo {
  /** 0 ~ 1 */
  percent: number
  /** 展示用文案，如 “第 3 / 24 章” */
  label: string
  detail: ProgressDetail
}

export interface SelectionInfo {
  text: string
  locator: AnnotationLocator
}

export interface TocEntry {
  title: string
  index: number
  level: number
}

export interface EngineCallbacks {
  onProgress(p: ProgressInfo): void
  onSelection(sel: SelectionInfo | null): void
  onTocReady(items: TocEntry[]): void
  onChapterChange(index: number): void
  /** 点击已存在的高亮标记 */
  onMarkClick(ann: Annotation): void
}

export interface ReaderEngine {
  open(
    container: HTMLElement,
    payload: EnginePayload,
    style: ReaderStyle,
    cb: EngineCallbacks,
  ): Promise<void>
  goChapter(index: number): Promise<void>
  applyStyle(style: ReaderStyle): void
  applyAnnotations(list: Annotation[]): void
  clearSelection(): void
  nextChapter(): Promise<boolean>
  prevChapter(): Promise<boolean>
  destroy(): void
}

const ENGINES_KEY = '__scriptraEngines'

export function registerEngine(format: string, factory: () => ReaderEngine): void {
  const w = window as unknown as Record<string, Record<string, () => unknown>>
  w[ENGINES_KEY] ??= {}
  w[ENGINES_KEY][format] = factory as () => unknown
}

/** 按需注入引擎脚本（懒加载，减小首屏体积） */
export function loadEngineScript(format: BookFormat): Promise<void> {
  const w = window as unknown as Record<string, Record<string, unknown>>
  w[ENGINES_KEY] ??= {}
  if (w[ENGINES_KEY][format]) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `./engine-${format}.js`
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`阅读引擎加载失败: ${format}`))
    document.head.appendChild(s)
  })
}

export function getEngine(format: BookFormat): ReaderEngine {
  const w = window as unknown as Record<string, Record<string, () => ReaderEngine>>
  const factory = w[ENGINES_KEY]?.[format]
  if (!factory) throw new Error(`引擎未注册: ${format}`)
  return factory()
}
