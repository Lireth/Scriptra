/**
 * Scriptra 构建脚本（esbuild）
 *
 * - 主进程 / 预加载：TS -> CJS 单文件捆绑（Node 平台，external electron）
 * - 渲染进程核心与阅读引擎：TS -> IIFE 单文件捆绑（浏览器平台）
 *   引擎脚本按需加载，加快启动速度
 * - 静态资源与 pdf.js 运行时（worker / cmaps / standard_fonts）复制到 out/renderer
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outMain = join(root, 'out/main');
const outRenderer = join(root, 'out/renderer');
const pdfDist = join(root, 'node_modules/pdfjs-dist');

mkdirSync(outMain, { recursive: true });
mkdirSync(outRenderer, { recursive: true });

/* ------------------------------ 主进程 & 预加载 ------------------------------ */

await build({
  entryPoints: [
    join(root, 'src/main/main.ts'),
    join(root, 'src/main/preload.ts'),
  ],
  outdir: outMain,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'canvas'],
  sourcemap: false,
  logLevel: 'info',
});

/* ------------------------------ 渲染进程 ------------------------------ */

await build({
  entryPoints: [
    { in: join(root, 'src/renderer/main.ts'), out: 'renderer' },
    { in: join(root, 'src/renderer/engines/epub.ts'), out: 'engine-epub' },
    { in: join(root, 'src/renderer/engines/pdf.ts'), out: 'engine-pdf' },
    { in: join(root, 'src/renderer/engines/mobi.ts'), out: 'engine-mobi' },
    { in: join(root, 'src/renderer/engines/txt.ts'), out: 'engine-txt' },
  ],
  outdir: outRenderer,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  sourcemap: false,
  logLevel: 'info',
});

/* ------------------------------ 静态资源 ------------------------------ */

copyFileSync(join(root, 'src/renderer/index.html'), join(outRenderer, 'index.html'));
copyFileSync(join(root, 'src/renderer/styles.css'), join(outRenderer, 'styles.css'));

// pdf.js 运行时资源
const workerSrc = join(pdfDist, 'build/pdf.worker.min.js');
if (existsSync(workerSrc)) copyFileSync(workerSrc, join(outRenderer, 'pdf.worker.min.js'));
for (const dir of ['cmaps', 'standard_fonts']) {
  const src = join(pdfDist, dir);
  if (existsSync(src)) cpSync(src, join(outRenderer, dir), { recursive: true });
}

// 主进程 pdf.js（Node 环境 fake worker）所需的 worker 模块
const legacyWorker = join(pdfDist, 'legacy/build/pdf.worker.js');
if (existsSync(legacyWorker)) copyFileSync(legacyWorker, join(outMain, 'pdf.worker.js'));

console.log('[build] 构建完成 -> out/');
