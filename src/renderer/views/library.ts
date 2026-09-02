/**
 * 书库视图：筛选 / 搜索 / 排序 / 网格与列表展示 / 导入 / 元数据编辑
 */

import type { Book, BookQuery, LibraryStats, ReadingStatus } from '../../shared/types'
import { el, formatSize, formatTime, placeholderCover } from '../util'
import { openContextMenu, type MenuItem } from '../components/contextMenu'
import { confirmDialog, editMetadataDialog } from '../components/dialogs'
import { toast, withToast } from '../components/toast'

interface LibState {
  q: string
  status: ReadingStatus | 'all'
  favorite: boolean
  category: string
  author: string
  sort: NonNullable<BookQuery['sort']>
  viewMode: 'grid' | 'list'
}

const STATUS_LABEL: Record<ReadingStatus, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读',
}

const FORMAT_LABEL: Record<string, string> = {
  epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', txt: 'TXT',
}

export class LibraryView {
  private root: HTMLElement
  private state: LibState = {
    q: '', status: 'all', favorite: false, category: '', author: '',
    sort: 'added',
    viewMode: (localStorage.getItem('scriptra.viewMode') as 'grid' | 'list') || 'grid',
  }
  private books: Book[] = []
  private stats: LibraryStats | null = null
  private selectedId: string | null = null
  private coverCache = new Map<string, string>()
  private loadedCount = 0
  private loadSeq = 0
  private coverObserver: IntersectionObserver | null = null

  /** 由 main.ts 注入：打开阅读器 */
  onOpenBook: (book: Book) => void = () => undefined

  constructor(root: HTMLElement) {
    this.root = root
    this.build()
  }

  /* ------------------------------ DOM 构建 ------------------------------ */

  private build(): void {
    this.root.innerHTML = ''
    this.root.className = 'view library-view'

    const sidebar = el('aside', 'lib-sidebar')
    sidebar.id = 'lib-sidebar'

    const main = el('main', 'lib-main')
    const toolbar = this.buildToolbar()
    const progress = el('div', 'import-progress hidden')
    progress.id = 'import-progress'
    const gridWrap = el('div', 'lib-content-wrap')
    const grid = el('div', 'book-grid')
    grid.id = 'book-container'
    const empty = el('div', 'empty-state hidden')
    empty.id = 'empty-state'
    gridWrap.appendChild(grid)
    gridWrap.appendChild(empty)

    main.appendChild(toolbar)
    main.appendChild(progress)
    main.appendChild(gridWrap)

    this.root.appendChild(sidebar)
    this.root.appendChild(main)
  }

  private buildToolbar(): HTMLElement {
    const toolbar = el('header', 'lib-toolbar')

    const search = el('input', 'search-input') as HTMLInputElement
    search.id = 'search-input'
    search.type = 'text'
    search.placeholder = '搜索书名、作者、正文…（Ctrl+F）'
    let t: ReturnType<typeof setTimeout> | null = null
    search.oninput = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        this.state.q = search.value
        void this.refresh()
      }, 300)
    }
    toolbar.appendChild(search)

    const sort = el('select', 'sort-select') as HTMLSelectElement
    for (const [v, label] of [
      ['added', '按添加时间'], ['recent', '按最近阅读'], ['title', '按书名'],
      ['author', '按作者'], ['rating', '按评分'],
    ] as const) {
      sort.appendChild(new Option(label, v))
    }
    sort.value = this.state.sort
    sort.onchange = () => {
      this.state.sort = sort.value as LibState['sort']
      void this.refresh()
    }
    toolbar.appendChild(sort)

    const spacer = el('div', 'flex-spacer')
    toolbar.appendChild(spacer)

    const toggle = el('div', 'view-toggle')
    const gridBtn = el('button', 'vt-btn' + (this.state.viewMode === 'grid' ? ' active' : ''))
    gridBtn.title = '网格视图'
    gridBtn.textContent = '▦'
    const listBtn = el('button', 'vt-btn' + (this.state.viewMode === 'list' ? ' active' : ''))
    listBtn.title = '列表视图'
    listBtn.textContent = '☰'
    gridBtn.onclick = () => this.setViewMode('grid', gridBtn, listBtn)
    listBtn.onclick = () => this.setViewMode('list', gridBtn, listBtn)
    toggle.appendChild(gridBtn)
    toggle.appendChild(listBtn)
    toolbar.appendChild(toggle)

    const scanBtn = el('button', 'btn', '扫描文件夹')
    scanBtn.id = 'btn-scan'
    scanBtn.onclick = () => void this.scanFolder()
    const importBtn = el('button', 'btn btn-primary', '导入')
    importBtn.id = 'btn-import'
    importBtn.onclick = () => void this.importFiles()
    toolbar.appendChild(scanBtn)
    toolbar.appendChild(importBtn)

    return toolbar
  }

  private setViewMode(mode: 'grid' | 'list', gridBtn: HTMLElement, listBtn: HTMLElement): void {
    this.state.viewMode = mode
    localStorage.setItem('scriptra.viewMode', mode)
    gridBtn.classList.toggle('active', mode === 'grid')
    listBtn.classList.toggle('active', mode === 'list')
    const container = document.getElementById('book-container')
    if (container) {
      container.classList.toggle('book-grid', mode === 'grid')
      container.classList.toggle('book-list', mode === 'list')
    }
  }

  /* ------------------------------ 侧栏 ------------------------------ */

  private renderSidebar(): void {
    const sidebar = document.getElementById('lib-sidebar')
    if (!sidebar) return
    sidebar.innerHTML = ''

    const brand = el('div', 'brand')
    brand.appendChild(el('span', 'brand-logo', '笺'))
    const brandText = el('div', 'brand-text')
    brandText.appendChild(el('h1', '', 'Scriptra'))
    brandText.appendChild(el('p', '', '观笺 · 电子书管理'))
    brand.appendChild(brandText)
    sidebar.appendChild(brand)

    const s = this.stats
    const continueBtn = el('button', 'btn continue-btn', '继续阅读')
    continueBtn.onclick = async () => {
      const last = await window.scriptra.continueReading()
      if (last) this.onOpenBook(last)
      else toast('还没有阅读记录，先挑一本开始吧', 'info')
    }
    sidebar.appendChild(continueBtn)

    const statusGroup = el('div', 'filter-group')
    statusGroup.appendChild(el('div', 'filter-title', '阅读状态'))
    const statusItems: [ReadingStatus | 'all', string, number][] = [
      ['all', '全部', s?.total ?? 0],
      ['unread', '未读', s?.unread ?? 0],
      ['reading', '在读', s?.reading ?? 0],
      ['finished', '已读', s?.finished ?? 0],
    ]
    for (const [value, label, count] of statusItems) {
      const item = el('button', 'filter-item' + (this.state.status === value && !this.state.favorite ? ' active' : ''))
      item.innerHTML = `<span>${label}</span><em>${count}</em>`
      item.onclick = () => {
        this.state.status = value
        this.state.favorite = false
        void this.refresh()
      }
      statusGroup.appendChild(item)
    }
    const favItem = el('button', 'filter-item' + (this.state.favorite ? ' active' : ''))
    favItem.innerHTML = `<span>我的收藏</span><em>${s?.favorite ?? 0}</em>`
    favItem.onclick = () => {
      this.state.favorite = !this.state.favorite
      void this.refresh()
    }
    statusGroup.appendChild(favItem)
    sidebar.appendChild(statusGroup)

    const catGroup = el('div', 'filter-group')
    catGroup.appendChild(el('div', 'filter-title', '分类'))
    if (s?.categories.length) {
      for (const c of s.categories) {
        const item = el('button', 'filter-item' + (this.state.category === c.name ? ' active' : ''))
        item.innerHTML = `<span>${escape_(c.name)}</span><em>${c.count}</em>`
        item.onclick = () => {
          this.state.category = this.state.category === c.name ? '' : c.name
          void this.refresh()
        }
        catGroup.appendChild(item)
      }
    } else {
      catGroup.appendChild(el('div', 'filter-empty', '暂无分类'))
    }
    sidebar.appendChild(catGroup)

    const authorGroup = el('div', 'filter-group')
    authorGroup.appendChild(el('div', 'filter-title', '作者'))
    if (s?.authors.length) {
      for (const a of s.authors.slice(0, 12)) {
        const item = el('button', 'filter-item' + (this.state.author === a.name ? ' active' : ''))
        item.innerHTML = `<span>${escape_(a.name)}</span><em>${a.count}</em>`
        item.onclick = () => {
          this.state.author = this.state.author === a.name ? '' : a.name
          void this.refresh()
        }
        authorGroup.appendChild(item)
      }
    } else {
      authorGroup.appendChild(el('div', 'filter-empty', '暂无作者'))
    }
    sidebar.appendChild(authorGroup)
  }

  /* ------------------------------ 数据 ------------------------------ */

  async refresh(): Promise<void> {
    const seq = ++this.loadSeq
    const [books, stats] = await Promise.all([
      window.scriptra.listBooks({
        q: this.state.q || undefined,
        status: this.state.status,
        favorite: this.state.favorite || undefined,
        category: this.state.category || undefined,
        author: this.state.author || undefined,
        sort: this.state.sort,
        limit: 120,
      }),
      window.scriptra.stats(),
    ])
    if (seq !== this.loadSeq) return
    this.books = books
    this.stats = stats
    this.loadedCount = books.length
    this.renderSidebar()
    this.renderBooks()
  }

  async loadMore(): Promise<void> {
    const seq = ++this.loadSeq
    const more = await window.scriptra.listBooks({
      q: this.state.q || undefined,
      status: this.state.status,
      favorite: this.state.favorite || undefined,
      category: this.state.category || undefined,
      author: this.state.author || undefined,
      sort: this.state.sort,
      limit: 120,
      offset: this.loadedCount,
    })
    if (seq !== this.loadSeq || !more.length) return
    this.books.push(...more)
    this.loadedCount += more.length
    this.renderBooks()
  }

  /* ------------------------------ 渲染 ------------------------------ */

  private renderBooks(): void {
    const container = document.getElementById('book-container')
    const empty = document.getElementById('empty-state')
    if (!container || !empty) return

    container.classList.toggle('book-grid', this.state.viewMode === 'grid')
    container.classList.toggle('book-list', this.state.viewMode === 'list')
    container.innerHTML = ''
    this.coverObserver?.disconnect()

    empty.classList.toggle('hidden', this.books.length > 0)
    if (!this.books.length) {
      empty.innerHTML = this.state.q || this.state.category || this.state.author || this.state.favorite
        ? '<h3>没有匹配的书籍</h3><p>试试调整筛选或搜索关键词</p>'
        : '<h3>书架空空如也</h3><p>点击右上角「导入」添加电子书，<br>或「扫描文件夹」批量入库</p>'
      return
    }

    this.coverObserver = new IntersectionObserver((entries) => {
      for (const ent of entries) {
        if (!ent.isIntersecting) continue
        const card = ent.target as HTMLElement
        this.coverObserver?.unobserve(card)
        const id = card.dataset.id
        const coverEl = card.querySelector('.cover-img') as HTMLImageElement | null
        if (!id || !coverEl) continue
        void this.loadCover(id).then((url) => {
          coverEl.src = url
        })
      }
    }, { rootMargin: '300px' })

    for (const book of this.books) {
      container.appendChild(this.buildCard(book))
    }
  }

  private async loadCover(id: string): Promise<string> {
    if (this.coverCache.has(id)) return this.coverCache.get(id)!
    const book = this.books.find((b) => b.id === id)
    const dataUrl = await window.scriptra.cover(id)
    const url = dataUrl || placeholderCover(book?.title ?? '', book?.author ?? '')
    this.coverCache.set(id, url)
    return url
  }

  private buildCard(book: Book): HTMLElement {
    const card = el('div', `book-card${this.selectedId === book.id ? ' selected' : ''}`)
    card.dataset.id = book.id

    const coverWrap = el('div', 'cover-wrap')
    const img = el('img', 'cover-img') as HTMLImageElement
    img.loading = 'lazy'
    img.alt = book.title
    img.src = placeholderCover(book.title, book.author)
    coverWrap.appendChild(img)

    const formatBadge = el('span', 'badge format', FORMAT_LABEL[book.format] ?? book.format.toUpperCase())
    coverWrap.appendChild(formatBadge)

    if (book.progress > 0) {
      const bar = el('div', 'progress-bar')
      const fill = el('div', 'progress-fill')
      fill.style.width = `${Math.round(book.progress * 100)}%`
      bar.appendChild(fill)
      coverWrap.appendChild(bar)
    }
    card.appendChild(coverWrap)

    const info = el('div', 'book-info')
    const title = el('div', 'book-title', book.title)
    title.title = `${book.title}（${book.author || '佚名'}）`
    info.appendChild(title)
    info.appendChild(el('div', 'book-author', book.author || '佚名'))
    const metaRow = el('div', 'book-meta')
    const statusDot = el('span', `status-dot status-${book.status}`)
    metaRow.appendChild(statusDot)
    metaRow.appendChild(el('span', '', STATUS_LABEL[book.status]))
    metaRow.appendChild(el('span', 'meta-dot', '·'))
    metaRow.appendChild(el('span', '', book.favorite ? '已收藏' : formatTime(book.lastReadAt)))
    info.appendChild(metaRow)
    card.appendChild(info)

    // 列表视图额外信息
    const listMeta = el('div', 'list-meta',
      `${book.category} · ${formatSize(book.size)} · 阅读进度 ${Math.round(book.progress * 100)}%`)
    card.appendChild(listMeta)

    card.onclick = () => {
      this.selectedId = book.id
      document.querySelectorAll('.book-card.selected').forEach((c) => c.classList.remove('selected'))
      card.classList.add('selected')
    }
    card.ondblclick = () => this.onOpenBook(book)
    card.oncontextmenu = (e) => {
      e.preventDefault()
      this.selectedId = book.id
      this.showContextMenu(e.clientX, e.clientY, book)
    }

    this.coverObserver?.observe(card)
    return card
  }

  private showContextMenu(x: number, y: number, book: Book): void {
    const items: MenuItem[] = [
      { label: '打开 / 继续阅读', action: () => this.onOpenBook(book) },
      { label: '编辑信息…', action: () => void this.editBook(book) },
      {
        label: book.favorite ? '取消收藏' : '加入收藏',
        action: () => void withToast('收藏', async () => {
          await window.scriptra.updateBook(book.id, { favorite: !book.favorite })
          await this.refresh()
        }),
      },
      { label: '标记状态', separatorBefore: true, action: () => undefined },
      ...(['unread', 'reading', 'finished'] as const).map((st) => ({
        label: `标记为「${STATUS_LABEL[st]}」${book.status === st ? ' ✓' : ''}`,
        disabled: book.status === st,
        action: () => void withToast('更新状态', async () => {
          await window.scriptra.updateBook(book.id, { status: st })
          await this.refresh()
        }),
      })),
      { label: '删除书籍…', separatorBefore: true, danger: true, action: () => void this.removeBook(book) },
    ]
    openContextMenu(x, y, items)
  }

  /* ------------------------------ 操作 ------------------------------ */

  async importFiles(): Promise<void> {
    const paths = await window.scriptra.pickFiles()
    if (!paths?.length) return
    await this.runImport(() => window.scriptra.importFiles(paths), paths.length)
  }

  async scanFolder(): Promise<void> {
    const folder = await window.scriptra.pickFolder()
    if (!folder) return
    await this.runImport(() => window.scriptra.scanFolder(folder), 0)
  }

  private async runImport(
    fn: () => Promise<{ imported: number; skipped: number; failed: { path: string; reason: string }[] }>,
    totalHint: number,
  ): Promise<void> {
    const bar = document.getElementById('import-progress')
    const off = window.scriptra.onImportProgress((p) => {
      if (!bar) return
      bar.classList.remove('hidden')
      const total = p.total || totalHint
      bar.textContent = total
        ? `正在导入 ${p.current} / ${total}：${p.path.split(/[\\/]/).pop()}`
        : `正在导入：${p.path.split(/[\\/]/).pop()}`
    })
    try {
      const r = await fn()
      const msg = `导入完成：成功 ${r.imported}，跳过 ${r.skipped}（重复），失败 ${r.failed.length}`
      if (r.failed.length) {
        toast(`${msg}，首个失败原因：${r.failed[0].reason}`, 'warn', 5000)
      } else {
        toast(msg, 'success')
      }
      await this.refresh()
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      off()
      bar?.classList.add('hidden')
    }
  }

  private async editBook(book: Book): Promise<void> {
    const result = await editMetadataDialog(book, this.stats?.categories.map((c) => c.name) ?? [])
    if (!result) return
    await withToast('保存', async () => {
      await window.scriptra.updateBook(book.id, result)
      this.coverCache.delete(book.id)
      await this.refresh()
    }, () => '书籍信息已更新')
  }

  private async removeBook(book: Book): Promise<void> {
    const ok = await confirmDialog(`确定删除《${book.title}》吗？\n相关的书签、笔记和文件副本将一并移除。`)
    if (!ok) return
    await withToast('删除', async () => {
      this.coverCache.delete(book.id)
      await window.scriptra.removeBooks([book.id])
      await this.refresh()
    }, () => '已删除')
  }

  openSelected(): void {
    const book = this.books.find((b) => b.id === this.selectedId)
    if (book) this.onOpenBook(book)
    else toast('先用鼠标选中一本书', 'info')
  }

  removeSelected(): void {
    const book = this.books.find((b) => b.id === this.selectedId)
    if (book) void this.removeBook(book)
  }

  focusSearch(): void {
    ;(document.getElementById('search-input') as HTMLInputElement | null)?.focus()
  }
}

function escape_(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
