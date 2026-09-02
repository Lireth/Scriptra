/**
 * 解析器冒烟测试（独立于 GUI 运行）
 *
 * 运行方式：
 *   npx esbuild scripts/smoke.ts --bundle --platform=node --format=cjs --outfile=out/smoke.js
 *   $env:ELECTRON_RUN_AS_NODE="1"; npx electron out/smoke.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import JSZip from 'jszip'
import { parseEpubFile } from '../src/main/parsers/epub'
import { parseMobiFile } from '../src/main/parsers/mobimeta'
import { parseTxtFile } from '../src/main/parsers/txt'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name} ${extra}`)
  }
}

/* ------------------------------ TXT ------------------------------ */

function testTxt(dir: string): void {
  console.log('\n== TXT 解析 ==')
  const p = path.join(dir, '测试小说.txt')
  const content = [
    '张三',
    '',
    '第一章 出发',
    '清晨的雾气弥漫在山谷之间，少年背起行囊，踏上了西行的道路。',
    '风声呼啸而过，远方的山峦若隐若现。',
    '',
    '第二章 遇险',
    '夜幕降临，狼嚎声在林间回荡。他握紧了手中的木棍。',
    '这是一场考验，也是一段成长的开始。',
  ].join('\n')
  fs.writeFileSync(p, content, 'utf-8')

  const r = parseTxtFile(p)
  check('标题取自文件名', r.meta.title === '测试小说')
  check('章节切分为 2 章', r.chapterStarts.length === 2, `实际 ${r.chapterStarts.length}`)
  check('章节标题正确', r.chapterTitles[0].includes('第一章') && r.chapterTitles[1].includes('第二章'))
  check('正文索引包含关键内容', r.contentText.includes('狼嚎声'))
}

/* ------------------------------ EPUB ------------------------------ */

async function testEpub(dir: string): Promise<void> {
  console.log('\n== EPUB 解析 ==')
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)

  const coverPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  zip.file('OEBPS/cover.png', coverPng)
  zip.file('OEBPS/ch1.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body><h1>第一章 启程</h1><p>少年推开柴门，走向雾气弥漫的群山。</p></body></html>`)
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head/><docTitle><text>测试书</text></docTitle>
  <navMap><navPoint id="n1"><navLabel><text>第一章 启程</text></navLabel>
    <content src="ch1.xhtml"/></navPoint></navMap>
</ncx>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>山海纪事</dc:title>
    <dc:creator>李文山</dc:creator>
    <dc:language>zh</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`)

  const p = path.join(dir, 'sample.epub')
  fs.writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }))

  const r = await parseEpubFile(p)
  check('标题解析', r.meta.title === '山海纪事', `实际 "${r.meta.title}"`)
  check('作者解析', r.meta.author === '李文山')
  check('封面提取', r.cover !== null && r.cover.mime === 'image/png')
  check('正文索引', r.contentText.includes('雾气弥漫的群山'))
  check('spine 长度', r.manifest.spine.length === 1)
  check('目录解析', r.manifest.toc.length === 1 && r.manifest.toc[0].title.includes('启程'))
  check('spine 标题回填', r.manifest.spine[0].title.includes('启程'))
}

/* ------------------------------ MOBI ------------------------------ */

function testMobi(dir: string): void {
  console.log('\n== MOBI 解析 ==')
  const title = '星辰之下'
  const titleBytes = Buffer.from(title, 'utf-8')

  const text = '<html><body><p>夜空中最亮的星，照亮了旅人的归途。</p><mbp:pagebreak/><p>第二日的黎明悄然而至。</p></body></html>'
  const textBytes = Buffer.from(text, 'utf-8')

  // record0 = PalmDOC 头(16) + MOBI 头(228) + 全名
  const r0 = Buffer.alloc(16 + 228 + titleBytes.length)
  // PalmDOC 头
  r0.writeUInt16BE(1, 0)          // compression = 1（不压缩）
  r0.writeUInt16BE(0, 2)
  r0.writeUInt32BE(textBytes.length, 4)
  r0.writeUInt16BE(1, 8)          // numTextRecords
  r0.writeUInt16BE(4096, 10)      // recordSize
  r0.writeUInt16BE(0, 12)         // encryption
  // MOBI 头
  r0.write('MOBI', 16, 'latin1')
  r0.writeUInt32BE(228, 20)       // headerLength
  r0.writeUInt32BE(2, 24)         // mobiType
  r0.writeUInt32BE(65001, 28)     // textEncoding UTF-8
  r0.writeUInt32BE(42, 32)        // uid
  r0.writeUInt32BE(6, 36)         // fileVersion
  r0.writeUInt32BE(0xffffffff, 72)  // firstNonBook
  r0.writeUInt32BE(0xffffffff, 76)
  r0.writeUInt32BE(244, 84)       // fullNameOffset（相对 record0）
  r0.writeUInt32BE(titleBytes.length, 88)
  r0.writeUInt32BE(2, 108)        // resourceStart（第 2 号记录为封面）
  r0.writeUInt32BE(0xffffffff, 112) // huffcdic
  r0.writeUInt32BE(0, 116)
  r0.writeUInt32BE(0, 128)        // exthFlag：无 EXTH
  r0.writeUInt32BE(0, 240)        // trailingFlags
  titleBytes.copy(r0, 244)

  // 记录表
  const numRecords = 3
  const header = Buffer.alloc(78 + numRecords * 8)
  header.write('TESTBOOK'.padEnd(32, '\0'), 0, 'latin1')
  header.write('BOOK', 60, 'latin1')
  header.write('MOBI', 64, 'latin1')
  header.writeUInt16BE(numRecords, 76)

  const rec0Off = 78 + numRecords * 8
  const rec1Off = rec0Off + r0.length
  const rec2Off = rec1Off + textBytes.length
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])

  header.writeUInt32BE(rec0Off, 78)
  header.writeUInt32BE(rec1Off, 86)
  header.writeUInt32BE(rec2Off, 94)

  const p = path.join(dir, 'sample.mobi')
  fs.writeFileSync(p, Buffer.concat([header, r0, textBytes, fakePng]))

  const r = parseMobiFile(p)
  check('标题解析', r.meta.title === title, `实际 "${r.meta.title}"`)
  check('封面提取', r.cover !== null && r.cover.mime === 'image/png')
  check('正文解压与索引', r.contentText.includes('照亮了旅人的归途'))
  check('非 KF8', !r.isKf8)
}

/* ------------------------------ main ------------------------------ */

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptra-smoke-'))
  try {
    testTxt(dir)
    await testEpub(dir)
    testMobi(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

void main()
