/**
 * 对话框：元数据编辑 / 确认 / 快捷键帮助
 */

import type { Book } from '../../shared/types'
import { el } from '../util'
import { toast } from './toast'

function buildOverlay(
  title: string,
  onDismiss?: () => void,
): { overlay: HTMLDivElement; body: HTMLDivElement; close: () => void } {
  const overlay = el('div', 'modal-overlay')
  const dialog = el('div', 'modal')
  const header = el('div', 'modal-header')
  const titleEl = el('h3', '', title)
  const closeBtn = el('button', 'modal-close')
  closeBtn.textContent = '×'
  const body = el('div', 'modal-body')
  header.appendChild(titleEl)
  header.appendChild(closeBtn)
  dialog.appendChild(header)
  dialog.appendChild(body)
  overlay.appendChild(dialog)
  document.getElementById('overlay-root')?.appendChild(overlay)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    overlay.remove()
  }
  // 非按钮路径关闭（× / 遮罩 / Esc）时通知调用方收尾（如 resolve 取消值）
  const dismiss = () => {
    if (closed) return
    close()
    onDismiss?.()
  }
  closeBtn.onclick = dismiss
  overlay.onmousedown = (e) => {
    if (e.target === overlay) dismiss()
  }
  // 键盘支持：Esc 关闭；Enter 触发主操作按钮（textarea 内换行不劫持）
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      dismiss()
      return
    }
    if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
      const btn = dialog.querySelector<HTMLButtonElement>('.modal-actions .btn-primary')
        ?? dialog.querySelector<HTMLButtonElement>('.modal-actions .btn-danger')
      if (btn) {
        e.preventDefault()
        e.stopPropagation()
        btn.click()
      }
    }
  })
  // 初始焦点落在首个输入控件上，保证键盘事件进入 overlay；无输入控件时聚焦容器
  overlay.tabIndex = -1
  const firstInput = body.querySelector<HTMLElement>('input, select, textarea')
  ;(firstInput ?? overlay).focus()
  return { overlay, body, close }
}

export function confirmDialog(message: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const { body, close } = buildOverlay('确认操作', () => resolve(false))
    body.appendChild(el('p', 'confirm-text', message))
    const row = el('div', 'modal-actions')
    const cancel = el('button', 'btn')
    cancel.textContent = '取消'
    cancel.onclick = () => { close(); resolve(false) }
    const ok = el('button', 'btn ' + (danger ? 'btn-danger' : 'btn-primary'))
    ok.textContent = '确定'
    ok.onclick = () => { close(); resolve(true) }
    row.appendChild(cancel)
    row.appendChild(ok)
    body.appendChild(row)
  })
}

export interface MetaEditResult {
  title: string
  author: string
  category: string
  status: Book['status']
  favorite: boolean
  rating: number
  description: string
}

export function editMetadataDialog(book: Book, categories: string[]): Promise<MetaEditResult | null> {
  return new Promise((resolve) => {
    const { body, close } = buildOverlay('编辑书籍信息', () => resolve(null))

    const field = (label: string, input: HTMLElement) => {
      const row = el('div', 'form-row')
      const lab = el('label', 'form-label')
      lab.textContent = label
      row.appendChild(lab)
      row.appendChild(input)
      body.appendChild(row)
    }

    const inputOf = (value: string, list?: string[]) => {
      if (list && list.length) {
        const input = el('input', 'form-input') as HTMLInputElement
        input.value = value
        const wrap = el('div', 'combo')
        wrap.appendChild(input)
        const datalist = document.createElement('datalist')
        datalist.id = `dl-${Math.random().toString(36).slice(2, 8)}`
        for (const c of list) {
          const opt = document.createElement('option')
          opt.value = c
          datalist.appendChild(opt)
        }
        input.setAttribute('list', datalist.id)
        wrap.appendChild(datalist)
        const holder = { input }
        return { el: wrap, input: holder.input }
      }
      const input = el('input', 'form-input') as HTMLInputElement
      input.value = value
      return { el: input as HTMLElement, input }
    }

    const titleF = inputOf(book.title)
    const authorF = inputOf(book.author)
    const categoryF = inputOf(book.category, [...new Set([...(categories ?? []), '未分类'])])

    const statusSel = el('select', 'form-input') as HTMLSelectElement
    for (const [v, label] of [['unread', '未读'], ['reading', '在读'], ['finished', '已读']] as const) {
      const opt = document.createElement('option')
      opt.value = v
      opt.textContent = label
      if (book.status === v) opt.selected = true
      statusSel.appendChild(opt)
    }

    const favSel = el('select', 'form-input') as HTMLSelectElement
    favSel.appendChild(new Option('否', 'no', false, !book.favorite))
    favSel.appendChild(new Option('是', 'yes', false, book.favorite))

    const ratingSel = el('select', 'form-input') as HTMLSelectElement
    for (let i = 0; i <= 5; i++) ratingSel.appendChild(new Option(i ? '★'.repeat(i) : '未评分', String(i), false, book.rating === i))

    const descTa = el('textarea', 'form-input form-area') as HTMLTextAreaElement
    descTa.value = book.description
    descTa.rows = 4

    field('书名', titleF.el)
    field('作者', authorF.el)
    field('分类', categoryF.el)
    field('阅读状态', statusSel)
    field('收藏', favSel)
    field('评分', ratingSel)
    field('简介', descTa)

    const row = el('div', 'modal-actions')
    const cancel = el('button', 'btn')
    cancel.textContent = '取消'
    cancel.onclick = () => { close(); resolve(null) }
    const ok = el('button', 'btn btn-primary')
    ok.textContent = '保存'
    ok.onclick = () => {
      const title = titleF.input.value.trim()
      if (!title) {
        toast('书名不能为空', 'warn')
        return
      }
      close()
      resolve({
        title,
        author: authorF.input.value.trim(),
        category: categoryF.input.value.trim() || '未分类',
        status: statusSel.value as Book['status'],
        favorite: favSel.value === 'yes',
        rating: Number(ratingSel.value) || 0,
        description: descTa.value,
      })
    }
    row.appendChild(cancel)
    row.appendChild(ok)
    body.appendChild(row)
  })
}

export function showHelpDialog(): void {
  const { body, close } = buildOverlay('键盘快捷键')
  const shortcuts: [string, string][] = [
    ['全局', ''],
    ['Ctrl + O', '导入电子书文件'],
    ['Ctrl + Shift + O', '扫描文件夹'],
    ['Ctrl + F', '聚焦搜索框'],
    ['Enter', '打开选中的书'],
    ['Delete', '删除选中的书'],
    ['F1', '快捷键帮助'],
    ['阅读器', ''],
    ['← / →（或 PgUp / PgDn）', '章内滚动一屏，到边界翻章（PDF：翻页）'],
    ['Ctrl + D', '添加书签'],
    ['Ctrl + T', '目录面板'],
    ['Ctrl + B', '批注面板'],
    ['Ctrl + F', '书内搜索'],
    ['Ctrl + +/-', '字号调整'],
    ['Esc', '关闭面板 / 弹窗'],
  ]
  for (const [key, desc] of shortcuts) {
    if (!desc) {
      body.appendChild(el('div', 'help-group', key))
      continue
    }
    const row = el('div', 'help-row')
    const kbd = el('kbd', '', key)
    const d = el('span', '', desc)
    row.appendChild(kbd)
    row.appendChild(d)
    body.appendChild(row)
  }
  const row = el('div', 'modal-actions')
  const ok = el('button', 'btn btn-primary')
  ok.textContent = '知道了'
  ok.onclick = close
  row.appendChild(ok)
  body.appendChild(row)
}
