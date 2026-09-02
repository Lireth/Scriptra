/**
 * pdfjs-dist legacy 构建（主进程使用）的最小类型声明
 */

declare module 'pdfjs-dist/legacy/build/pdf.js' {
  export interface PDFPageProxy {
    getTextContent(): Promise<{ items: { str?: string }[] }>
    cleanup(): void
  }
  export interface PDFDocumentProxy {
    numPages: number
    getMetadata(): Promise<{ info?: { Title?: string; Author?: string } }>
    getPage(num: number): Promise<PDFPageProxy>
    destroy(): Promise<void>
  }
  export interface GetDocumentParams {
    data?: Uint8Array
    url?: string
    useWorkerFetch?: boolean
    isEvalSupported?: boolean
    disableFontFace?: boolean
    cMapUrl?: string
    cMapPacked?: boolean
    standardFontDataUrl?: string
    verbosity?: number
  }
  export function getDocument(params: GetDocumentParams): { promise: Promise<PDFDocumentProxy> }
  export const version: string
}
