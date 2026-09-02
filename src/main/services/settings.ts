/**
 * 应用级设置（JSON 文件持久化）
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface AppSettings {
  /** 最近扫描的目录 */
  scanFolders: string[]
}

const DEFAULTS: AppSettings = { scanFolders: [] }

let cache: AppSettings | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache
  let loaded: AppSettings
  try {
    loaded = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf-8')) }
  } catch {
    loaded = { ...DEFAULTS }
  }
  cache = loaded
  return loaded
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  cache = { ...getSettings(), ...patch }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch { /* 写入失败不影响运行 */ }
  return cache
}
