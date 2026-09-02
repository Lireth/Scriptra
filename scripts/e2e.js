/**
 * 端到端验证脚本（通过 CDP 驱动真实运行的应用）
 *
 * 前置：应用以 --remote-debugging-port=9222 启动
 * 运行：$env:ELECTRON_RUN_AS_NODE="1"; npx electron scripts/e2e.js
 *
 * 覆盖：导入（EPUB/PDF/MOBI/TXT）→ 书库查询 / 全文搜索 → 打开书籍 →
 *       四种阅读引擎真实渲染 → 注释 API
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const BASE = 'http://127.0.0.1:9222'
let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  [PASS] ${name}`) }
  else { failed++; console.error(`  [FAIL] ${name} ${extra}`) }
}

/* ------------------------------ CDP 客户端 ------------------------------ */

async function findPageTarget() {
  const res = await fetch(`${BASE}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url))
    ?? targets.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到应用页面目标')
  return page
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    }
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pending.set(mid, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close: () => ws.close(),
    })
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text
    throw new Error(`页面执行出错: ${desc}`)
  }
  return r.result?.value
}

/* ------------------------------ 样例文件合成 ------------------------------ */

function makeEpub(dir) {
  const JSZip = require('jszip')
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  zip.file('OEBPS/cover.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
  zip.file('OEBPS/ch1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head><body><h1>第一章 启程</h1><p>少年推开柴门，走向雾气弥漫的群山。</p></body></html>`)
  zip.file('OEBPS/ch2.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c2</title></head><body><h1>第二章 山谷</h1><p>山谷深处传来溪水声。</p></body></html>`)
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>t</text></docTitle><navMap><navPoint id="n1"><navLabel><text>第一章 启程</text></navLabel><content src="ch1.xhtml"/></navPoint><navPoint id="n2"><navLabel><text>第二章 山谷</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>山海纪事</dc:title><dc:creator>李文山</dc:creator><dc:language>zh</dc:language><meta name="cover" content="cover-img"/></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover-img" href="cover.png" media-type="image/png"/></manifest><spine toc="ncx"><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`)
  const p = path.join(dir, 'e2e.epub')
  return zip.generateAsync({ type: 'nodebuffer' }).then((buf) => { fs.writeFileSync(p, buf); return p })
}

function makeMobi(dir) {
  const title = '星辰之下'
  const titleBytes = Buffer.from(title, 'utf-8')
  const text = '<html><body><p>夜空中最亮的星，照亮了旅人的归途。</p><mbp:pagebreak/><p>第二日的黎明悄然而至。</p></body></html>'
  const textBytes = Buffer.from(text, 'utf-8')
  const r0 = Buffer.alloc(16 + 228 + titleBytes.length)
  r0.writeUInt16BE(1, 0)
  r0.writeUInt32BE(textBytes.length, 4)
  r0.writeUInt16BE(1, 8)
  r0.writeUInt16BE(4096, 10)
  r0.write('MOBI', 16, 'latin1')
  r0.writeUInt32BE(228, 20)
  r0.writeUInt32BE(2, 24)
  r0.writeUInt32BE(65001, 28)
  r0.writeUInt32BE(42, 32)
  r0.writeUInt32BE(6, 36)
  r0.writeUInt32BE(0xffffffff, 72)
  r0.writeUInt32BE(0xffffffff, 76)
  r0.writeUInt32BE(244, 84)
  r0.writeUInt32BE(titleBytes.length, 88)
  r0.writeUInt32BE(2, 108)
  r0.writeUInt32BE(0xffffffff, 112)
  r0.writeUInt32BE(0, 128)
  r0.writeUInt32BE(0, 240)
  titleBytes.copy(r0, 244)
  const numRecords = 3
  const header = Buffer.alloc(78 + numRecords * 8)
  header.write('TESTBOOK'.padEnd(32, '\0'), 0, 'latin1')
  header.write('BOOK', 60, 'latin1')
  header.write('MOBI', 64, 'latin1')
  header.writeUInt16BE(numRecords, 76)
  const rec0Off = 78 + numRecords * 8
  const rec1Off = rec0Off + r0.length
  const rec2Off = rec1Off + textBytes.length
  header.writeUInt32BE(rec0Off, 78)
  header.writeUInt32BE(rec1Off, 86)
  header.writeUInt32BE(rec2Off, 94)
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])
  const p = path.join(dir, 'e2e.mobi')
  fs.writeFileSync(p, Buffer.concat([header, r0, textBytes, fakePng]))
  return p
}

function makeTxt(dir) {
  const p = path.join(dir, 'e2e.txt')
  fs.writeFileSync(p, [
    '第一章 出发', '清晨的雾气弥漫在山谷之间，少年背起行囊，踏上了西行的道路。', '',
    '第二章 遇险', '夜幕降临，狼嚎声在林间回荡。他握紧了手中的木棍。',
  ].join('\r\n'), 'utf-8')
  return p
}

function makePdf(dir) {
  // 程序化构建带正确 xref 的最小 PDF
  const chunks = []
  const offsets = [0]
  const push = (s) => {
    const buf = Buffer.from(s, 'latin1')
    offsets.push(offsets[offsets.length - 1] + buf.length)
    chunks.push(buf)
  }
  push('%PDF-1.4\n')
  push('1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n')
  push('2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n')
  push('3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj\n')
  const stream = 'BT /F1 24 Tf 100 700 Td (Hello Scriptra PDF) Tj ET'
  push(`4 0 obj <</Length ${stream.length}>> stream\n${stream}\nendstream endobj\n`)
  push('5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj\n')
  const xrefOff = offsets[offsets.length - 1]
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  push(xref)
  push(`trailer <</Size 6 /Root 1 0 R>>\nstartxref\n${xrefOff}\n%%EOF\n`)
  const p = path.join(dir, 'e2e.pdf')
  fs.writeFileSync(p, Buffer.concat(chunks))
  return p
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const target = await findPageTarget()
  const client = await connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptra-e2e-'))
  const epubPath = await makeEpub(dir)
  const mobiPath = makeMobi(dir)
  const txtPath = makeTxt(dir)
  const pdfPath = makePdf(dir)

  try {
    /* 0. 清空书库，保证可重复运行 */
    const existing = await evaluate(client, 'window.scriptra.listBooks({ limit: 500 })')
    if (existing.length) {
      await evaluate(client, `window.scriptra.removeBooks(${JSON.stringify(existing.map((b) => b.id))})`)
    }

    /* 1. 应用就绪 */
    console.log('\n== 应用就绪 ==')
    const ver = await evaluate(client, 'window.scriptra.getInfo()')
    check('preload API 可用', !!ver && ver.version === '0.2.0', JSON.stringify(ver))

    /* 2. 导入 */
    console.log('\n== 导入 ==')
    const outcome = await evaluate(client,
      `window.scriptra.importFiles(${JSON.stringify([epubPath, mobiPath, txtPath, pdfPath])})`)
    check('四本书全部导入成功', outcome.imported === 4 && outcome.failed.length === 0,
      JSON.stringify(outcome))

    /* 3. 书库与搜索 */
    console.log('\n== 书库 / 搜索 ==')
    const all = await evaluate(client, 'window.scriptra.listBooks({})')
    check('书库列表 4 本', all.length === 4, `实际 ${all.length}`)
    const epubBook = all.find((b) => b.format === 'epub')
    const mobiBook = all.find((b) => b.format === 'mobi')
    const txtBook = all.find((b) => b.format === 'txt')
    const pdfBook = all.find((b) => b.format === 'pdf')
    check('EPUB 元数据', epubBook.title === '山海纪事' && epubBook.author === '李文山')
    check('MOBI 元数据', mobiBook.title === '星辰之下')
    check('TXT 元数据', txtBook.title === 'e2e')

    const hitContent = await evaluate(client,
      `window.scriptra.listBooks({ q: '西行' })`)
    check('正文搜索命中 TXT（中文短语）', hitContent.some((b) => b.id === txtBook.id),
      JSON.stringify(hitContent.map((b) => b.title)))
    const hitTitle = await evaluate(client,
      `window.scriptra.listBooks({ q: '山海' })`)
    check('书名搜索命中 EPUB', hitTitle.some((b) => b.id === epubBook.id))
    const stats = await evaluate(client, 'window.scriptra.stats()')
    check('统计信息', stats.total === 4)

    /* 4. 封面 */
    const cover = await evaluate(client, `window.scriptra.cover('${epubBook.id}')`)
    check('EPUB 封面 data URL', cover.startsWith('data:image/png;base64,'))

    /* 5. 引擎渲染 */
    console.log('\n== 阅读引擎 ==')

    // EPUB
    const epubPayload = await evaluate(client, `window.scriptra.openBook('${epubBook.id}')`)
    check('EPUB manifest（2 章）', epubPayload.manifest && epubPayload.manifest.spine.length === 2
      && epubPayload.manifest.toc.length === 2)
    const epubResult = await evaluate(client, `(async () => {
      const payload = await window.scriptra.openBook('${epubBook.id}')
      await new Promise((r) => { const s = document.createElement('script'); s.src = './engine-epub.js'; s.onload = r; s.onerror = () => r(); document.head.appendChild(s) })
      const eng = window.__scriptraEngines.epub()
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'
      document.body.appendChild(root)
      let tocLen = -1
      await eng.open(root, { ...payload, annotations: [] }, {
        fontFamily: 'serif', fontSize: 18, lineHeight: 1.8, theme: 'light', pageWidth: 760,
      }, {
        onProgress(){}, onSelection(){}, onMarkClick(){},
        onTocReady(items){ tocLen = items.length },
        onChapterChange(){},
      })
      await new Promise((r) => setTimeout(r, 500))
      const f = root.querySelector('iframe')
      const text = f && f.contentDocument ? f.contentDocument.body.innerText : ''
      root.remove()
      return { ok: text.includes('雾气弥漫的群山'), toc: tocLen, sample: text.slice(0, 60) }
    })()`)
    check('EPUB 引擎渲染章节内容', epubResult.ok === true, JSON.stringify(epubResult))
    check('EPUB 目录回调', epubResult.toc === 2)

    // TXT
    const txtResult = await evaluate(client, `(async () => {
      const payload = await window.scriptra.openBook('${txtBook.id}')
      await new Promise((r) => { const s = document.createElement('script'); s.src = './engine-txt.js'; s.onload = r; s.onerror = () => r(); document.head.appendChild(s) })
      const eng = window.__scriptraEngines.txt()
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'
      document.body.appendChild(root)
      let progress = null
      await eng.open(root, { ...payload, annotations: [] }, {
        fontFamily: 'serif', fontSize: 18, lineHeight: 1.8, theme: 'light', pageWidth: 760,
      }, {
        onProgress(p){ progress = p }, onSelection(){}, onMarkClick(){}, onTocReady(){}, onChapterChange(){},
      })
      await new Promise((r) => setTimeout(r, 300))
      const text = root.innerText
      root.remove()
      return { ok: text.includes('西行的道路'), hasProgress: !!progress }
    })()`)
    check('TXT 引擎渲染章节', txtResult.ok === true, JSON.stringify(txtResult))
    check('TXT 进度回调', txtResult.hasProgress === true)

    // MOBI
    const mobiResult = await evaluate(client, `(async () => {
      const payload = await window.scriptra.openBook('${mobiBook.id}')
      await new Promise((r) => { const s = document.createElement('script'); s.src = './engine-mobi.js'; s.onload = r; s.onerror = () => r(); document.head.appendChild(s) })
      const eng = window.__scriptraEngines.mobi()
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'
      document.body.appendChild(root)
      let tocLen = -1
      await eng.open(root, { ...payload, annotations: [] }, {
        fontFamily: 'serif', fontSize: 18, lineHeight: 1.8, theme: 'light', pageWidth: 760,
      }, {
        onProgress(){}, onSelection(){}, onMarkClick(){},
        onTocReady(items){ tocLen = items.length }, onChapterChange(){},
      })
      await new Promise((r) => setTimeout(r, 600))
      const f = root.querySelector('iframe')
      const text = f && f.contentDocument ? f.contentDocument.body.innerText : ''
      root.remove()
      return { ok: text.includes('照亮了旅人的归途'), toc: tocLen }
    })()`)
    check('MOBI 引擎渲染（foliate）', mobiResult.ok === true, JSON.stringify(mobiResult))
    check('MOBI 目录解析', mobiResult.toc > 0)

    // PDF
    const pdfResult = await evaluate(client, `(async () => {
      const payload = await window.scriptra.openBook('${pdfBook.id}')
      await new Promise((r) => { const s = document.createElement('script'); s.src = './engine-pdf.js'; s.onload = r; s.onerror = () => r(); document.head.appendChild(s) })
      const eng = window.__scriptraEngines.pdf()
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'
      document.body.appendChild(root)
      let progress = null
      await eng.open(root, { ...payload, annotations: [] }, {
        fontFamily: 'serif', fontSize: 18, lineHeight: 1.8, theme: 'light', pageWidth: 760,
      }, {
        onProgress(p){ progress = p }, onSelection(){}, onMarkClick(){}, onTocReady(){}, onChapterChange(){},
      })
      await new Promise((r) => setTimeout(r, 1500))
      const canvas = root.querySelector('canvas')
      const pages = root.querySelectorAll('.pdf-page').length
      root.remove()
      return { hasCanvas: !!canvas && canvas.width > 0, pages, hasProgress: !!progress }
    })()`)
    check('PDF 引擎渲染（pdf.js + worker）', pdfResult.hasCanvas === true && pdfResult.pages === 1,
      JSON.stringify(pdfResult))
    check('PDF 进度回调', pdfResult.hasProgress === true)

    /* 6. 注释 API */
    console.log('\n== 注释 ==')
    const ann = await evaluate(client, `window.scriptra.addAnnotation({
      bookId: '${txtBook.id}', type: 'highlight', color: '#ffd54d',
      text: '狼嚎声在林间回荡', note: '',
      locator: { kind: 'text', chapter: 1, start: 5, end: 15 },
    })`)
    check('添加高亮', !!ann.id)
    const updated = await evaluate(client,
      `window.scriptra.updateAnnotation('${ann.id}', { note: '写得不错' })`)
    check('更新笔记', updated && updated.note === '写得不错')
    const bookmark = await evaluate(client, `window.scriptra.addAnnotation({
      bookId: '${txtBook.id}', type: 'bookmark', color: '', text: '', note: '',
      locator: { kind: 'doc', chapter: 0, ratio: 0.5 },
    })`)
    const anns = await evaluate(client, `window.scriptra.listAnnotations('${txtBook.id}')`)
    check('书签与注释列表', anns.length === 2)

    /* 7. 进度 */
    await evaluate(client, `window.scriptra.setProgress('${txtBook.id}', 0.42, { kind: 'doc', chapter: 1, ratio: 0.3 })`)
    const after = await evaluate(client, `window.scriptra.getBook('${txtBook.id}')`)
    check('进度保存 + 状态自动流转', Math.abs(after.progress - 0.42) < 0.01 && after.status === 'reading',
      JSON.stringify({ p: after.progress, s: after.status }))

    /* 清理注释，避免污染用户数据 */
    await evaluate(client, `window.scriptra.removeAnnotation('${ann.id}')`)
    await evaluate(client, `window.scriptra.removeAnnotation('${bookmark.id}')`)
    await evaluate(client, `window.scriptra.setProgress('${txtBook.id}', 0, null)`)
    await evaluate(client, `window.scriptra.updateBook('${txtBook.id}', { status: 'unread' })`)

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
    client.close()
    if (failed > 0) process.exit(1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('E2E 失败:', e)
  process.exit(1)
})
