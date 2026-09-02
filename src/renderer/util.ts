/**
 * 渲染进程通用工具
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector(sel)
  if (!node) throw new Error(`元素未找到: ${sel}`)
  return node as T
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }) as T
}

export function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        fn(...args)
      }, ms - (now - last))
    }
  }) as T
}

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatTime(ts: number): string {
  if (!ts) return '未读'
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const diff = (today.getTime() - d.getTime()) / 86400000
  if (diff < 7) return `${Math.floor(diff)} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 无封面时的占位封面（SVG data URL） */
export function placeholderCover(title: string, author: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const t = esc(title.slice(0, 12))
  const a = esc(author.slice(0, 10))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="#d8cfc0"/><stop offset="1" stop-color="#b8ab94"/>`
    + `</linearGradient></defs>`
    + `<rect width="300" height="420" fill="url(#g)"/>`
    + `<rect x="14" y="14" width="272" height="392" fill="none" stroke="#8d7f66" stroke-width="2" rx="6"/>`
    + `<text x="150" y="200" font-family="Georgia, '宋体', serif" font-size="40" fill="#5d5240" text-anchor="middle">${t}</text>`
    + `<text x="150" y="250" font-family="'微软雅黑', sans-serif" font-size="16" fill="#7d715c" text-anchor="middle">${a}</text>`
    + `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** ArrayBuffer -> data URL（章节内嵌图片 / 字体使用） */
export function abToDataUrl(mime: string, buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return `data:${mime};base64,${btoa(bin)}`
}

/** 相对路径解析（POSIX 规则，zip 包内路径） */
export function resolveZipPath(baseDir: string, href: string): string {
  if (href.startsWith('/')) return href.slice(1)
  if (href.startsWith('#')) return href
  const stack = baseDir ? baseDir.split('/') : []
  for (const seg of href.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}
