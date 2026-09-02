/**
 * 轻量 Toast 通知
 */

import { el } from '../util'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export function toast(message: string, kind: ToastKind = 'info', duration = 2800): void {
  const container = document.getElementById('toast-container')
  if (!container) return
  const item = el('div', `toast toast-${kind}`)
  item.textContent = message
  container.appendChild(item)
  requestAnimationFrame(() => item.classList.add('show'))
  setTimeout(() => {
    item.classList.remove('show')
    setTimeout(() => item.remove(), 260)
  }, duration)
}

export async function withToast<T>(
  label: string,
  fn: () => Promise<T>,
  okMsg?: (r: T) => string,
): Promise<T | null> {
  try {
    const r = await fn()
    if (okMsg) toast(okMsg(r), 'success')
    return r
  } catch (e) {
    toast(`${label}失败：${e instanceof Error ? e.message : String(e)}`, 'error', 4200)
    window.scriptra.log('error', `${label}失败: ${e instanceof Error ? e.stack : String(e)}`)
    return null
  }
}
