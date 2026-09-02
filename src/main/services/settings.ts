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

/** 记录最近扫描的目录：去重置顶，上限 10 条（工具栏"最近扫描"菜单用） */
export function recordScanFolder(folder: string): void {
  const s = getSettings()
  const folders = [folder, ...s.scanFolders.filter((f) => f !== folder)].slice(0, 10)
  setSettings({ scanFolders: folders })
}
