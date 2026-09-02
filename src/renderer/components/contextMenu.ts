/**
 * 自定义右键菜单
 */

import { el } from '../util'

export interface MenuItem {
  label: string
  action?: () => void
  danger?: boolean
  separatorBefore?: boolean
  disabled?: boolean
}

export function openContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu()
  const root = document.getElementById('overlay-root')
  if (!root) return

  const menu = el('div', 'context-menu')
  for (const item of items) {
    if (item.separatorBefore) menu.appendChild(el('div', 'ctx-sep'))
    const btn = el('button', 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : ''))
    btn.textContent = item.label
    if (!item.disabled) {
      btn.onclick = () => {
        closeContextMenu()
        item.action?.()
      }
    }
    menu.appendChild(btn)
  }
  menu.style.left = '0px'
  menu.style.top = '0px'
  root.appendChild(menu)

  // 视口内收拢
  const rect = menu.getBoundingClientRect()
  const left = Math.min(x, window.innerWidth - rect.width - 8)
  const top = Math.min(y, window.innerHeight - rect.height - 8)
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
  menu.classList.add('show')

  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeContextMenu()
  }
  setTimeout(() => {
    document.addEventListener('mousedown', close, { once: true })
    document.addEventListener('contextmenu', close, { once: true })
  }, 0)
}

export function closeContextMenu(): void {
  document.querySelectorAll('.context-menu').forEach((m) => m.remove())
}
