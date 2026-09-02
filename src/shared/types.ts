/**
 * 共享类型定义（主进程 / 渲染进程 / 预加载共用）
 */

export type BookFormat = 'epub' | 'pdf' | 'mobi' | 'txt'
export type ReadingStatus = 'unread' | 'reading' | 'finished'
export type ThemeName = 'light' | 'sepia' | 'green' | 'dark'

/** 阅读进度定位（持久化到数据库） */
export type ProgressDetail =
  | { kind: 'doc'; chapter: number; ratio: number }   // EPUB / MOBI / TXT：章节 + 章内滚动比例
  | { kind: 'pdf'; page: number; top: number }        // PDF：页码 + 页内偏移

/** 注释定位 */
export type AnnotationLocator =
  | { kind: 'text'; chapter: number; start: number; end: number }                       // HTML 正文文本偏移
  | { kind: 'pdf'; page: number; rects: [number, number, number, number][] }            // PDF 归一化矩形 [l, t, w, h]
  | { kind: 'doc'; chapter: number; ratio: number }                                     // 文档书签
  | { kind: 'page'; page: number; top: number }                                         // PDF 书签

export type AnnotationType = 'bookmark' | 'highlight' | 'note'

export interface Annotation {
  id: string
  bookId: string
  type: AnnotationType
  color: string
  /** 高亮/笔记选中的原文 */
  text: string
  /** 笔记内容 */
  note: string
  locator: AnnotationLocator
  createdAt: number
  updatedAt: number
}

export interface Book {
  id: string
  title: string
  author: string
  format: BookFormat
  category: string
  status: ReadingStatus
  favorite: boolean
  rating: number
  description: string
  publisher: string
  language: string
  year: string
  size: number
  /** 0 ~ 1 */
  progress: number
  progressDetail: ProgressDetail | null
  contentIndexed: boolean
  addedAt: number
  updatedAt: number
  lastReadAt: number
}

export interface TocItem {
  href: string
  title: string
  level: number
}

export interface BookManifest {
  /** 章节序列：EPUB 为 spine href；MOBI/TXT 为章节标题 */
  spine: { href: string; title: string }[]
  toc: TocItem[]
  /** 各章节相对权重（用于平滑进度百分比），可缺省 */
  weights?: number[]
  /** TXT：各章节在全文中的字符起始偏移 */
  chapterStarts?: number[]
}

export interface BookQuery {
  q?: string
  status?: ReadingStatus | 'all'
  favorite?: boolean
  category?: string
  author?: string
  format?: BookFormat
  sort?: 'recent' | 'added' | 'title' | 'author' | 'rating'
  limit?: number
  offset?: number
}

export interface LibraryStats {
  total: number
  unread: number
  reading: number
  finished: number
  favorite: number
  categories: { name: string; count: number }[]
  authors: { name: string; count: number }[]
}

export interface ImportOutcome {
  imported: number
  skipped: number
  failed: { path: string; reason: string }[]
}

export interface BookResource {
  mime: string
  bytes: ArrayBuffer
}

export interface ReaderStyle {
  fontFamily: string
  fontSize: number
  lineHeight: number
  theme: ThemeName
  pageWidth: number
}

/** 打开书籍时主进程返回的载荷 */
export interface OpenBookPayload {
  id: string
  format: BookFormat
  title: string
  author: string
  manifest?: BookManifest
  /** PDF / MOBI 完整文件数据 */
  fileData?: ArrayBuffer
  annotations: Annotation[]
  progress: number
  progressDetail: ProgressDetail | null
  /** 正文是否已建立全文索引（MOBI HUFF/CDIC 延迟索引用） */
  contentIndexed: boolean
}

export interface BookUpdatePatch {
  title?: string
  author?: string
  category?: string
  status?: ReadingStatus
  favorite?: boolean
  rating?: number
  description?: string
}

export interface ImportProgressEvent {
  current: number
  total: number
  path: string
  /** scan：扫描文件；import：导入文件；pdf-text：PDF 全文逐页提取（current/total 为页码） */
  stage: 'scan' | 'import' | 'pdf-text'
}

/* ------------------------------ IPC 通道名 ------------------------------ */

export const IPC = {
  AppGetInfo: 'app:get-info',
  DialogPickFiles: 'dialog:pick-files',
  DialogPickFolder: 'dialog:pick-folder',
  LibraryImport: 'library:import',
  LibraryScan: 'library:scan',
  LibraryList: 'library:list',
  LibraryGet: 'library:get',
  LibraryUpdate: 'library:update',
  LibraryRemove: 'library:remove',
  LibraryStats: 'library:stats',
  LibraryContinue: 'library:continue',
  LibraryCancelImport: 'library:cancel-import',
  BookOpen: 'book:open',
  BookClose: 'book:close',
  BookGetFile: 'book:get-file',
  BookGetResource: 'book:get-resource',
  BookSetProgress: 'book:set-progress',
  BookIndexText: 'book:index-text',
  AnnList: 'ann:list',
  AnnAdd: 'ann:add',
  AnnUpdate: 'ann:update',
  AnnRemove: 'ann:remove',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  LogRenderer: 'log:renderer',
  /** 书内外部链接交由系统浏览器打开（主进程白名单校验） */
  ShellOpenExternal: 'shell:open-external',
  EventImportProgress: 'library:progress',
  /** 文件关联 / 第二实例传入的电子书路径，主进程 -> 渲染进程 */
  EventImportRequest: 'library:import-request',
} as const

export const HIGHLIGHT_COLORS = ['#ffd54d', '#9ae6b4', '#90cdf4', '#f6a6c1', '#d6bcfa']
