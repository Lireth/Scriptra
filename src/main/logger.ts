/**
 * 日志工具（主进程）
 *
 * 开发环境输出到控制台；始终写入 userData/logs/。
 * 渲染进程日志通过 IPC 汇聚到 renderer.log。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let logDir: string | null = null

export function getLogDir(): string {
  if (!logDir) {
    logDir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(logDir, { recursive: true })
  }
  return logDir
}

function write(file: string, level: string, args: unknown[]): void {
  const message = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'object') {
        try { return JSON.stringify(a) } catch { return String(a) }
      }
      return String(a)
    })
    .join(' ')
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`

  if (level === 'ERROR') console.error(line.trim())
  else if (level === 'WARN') console.warn(line.trim())
  else console.log(line.trim())

  try {
    fs.appendFileSync(path.join(getLogDir(), file), line, 'utf8')
  } catch {
    // 日志写入失败不应影响主流程
  }
}

export const log = {
  info: (...args: unknown[]) => write('main.log', 'INFO', args),
  warn: (...args: unknown[]) => write('main.log', 'WARN', args),
  error: (...args: unknown[]) => write('main.log', 'ERROR', args),
  renderer: {
    info: (...args: unknown[]) => write('renderer.log', 'INFO', args),
    warn: (...args: unknown[]) => write('renderer.log', 'WARN', args),
    error: (...args: unknown[]) => write('renderer.log', 'ERROR', args),
  },
}
