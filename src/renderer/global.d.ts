/**
 * window.scriptra（preload 暴露的 API）类型声明
 */

import type {
  Annotation, Book, BookQuery, BookUpdatePatch, ImportOutcome, LibraryStats,
  OpenBookPayload, ReaderStyle,
} from '../shared/types'

export interface ScriptraApi {
  getInfo(): Promise<{ version: string; platform: string; electron: string; chrome: string; node: string }>
  pickFiles(): Promise<string[]>
  pickFolder(): Promise<string | null>

  importFiles(paths: string[]): Promise<ImportOutcome>
  scanFolder(folder: string): Promise<ImportOutcome>
  cancelImport(): Promise<boolean>
  pathForFile(file: File): string
  listBooks(query: BookQuery): Promise<Book[]>
  getBook(id: string): Promise<Book | null>
  updateBook(id: string, patch: BookUpdatePatch): Promise<Book>
  removeBooks(ids: string[]): Promise<boolean>
  stats(): Promise<LibraryStats>
  continueReading(): Promise<Book | null>

  openBook(id: string): Promise<Omit<OpenBookPayload, 'annotations'> & { annotations?: Annotation[] }>
  closeBook(id: string): Promise<boolean>
  getResource(id: string, path: string): Promise<{ mime: string; bytes: ArrayBuffer }>
  setProgress(id: string, progress: number, detail: unknown): Promise<boolean>
  indexText(id: string, text: string): Promise<boolean>

  listAnnotations(bookId: string): Promise<Annotation[]>
  addAnnotation(data: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'>): Promise<Annotation>
  updateAnnotation(id: string, patch: { color?: string; note?: string }): Promise<Annotation | null>
  removeAnnotation(id: string): Promise<boolean>
  exportAnnotations(bookId: string, format: 'md' | 'json'): Promise<{ path: string | null }>
  importAnnotations(): Promise<{ restored: number; skipped: number; unknownBooks: number } | null>

  getSettings(): Promise<{ scanFolders: string[] }>
  setSettings(patch: unknown): Promise<unknown>
  log(level: 'info' | 'warn' | 'error', message: string): Promise<boolean>
  openExternal(url: string): Promise<boolean>

  onImportProgress(handler: (payload: {
    current: number; total: number; path: string; stage: string
  }) => void): () => void

  onImportRequest(handler: (paths: string[]) => void): () => void
}

declare global {
  interface Window {
    scriptra: ScriptraApi
    __scriptraEngines?: Record<string, () => unknown>
  }
}

export {}
