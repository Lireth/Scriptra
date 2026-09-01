/**
 * 主进程极简日志工具
 *
 * 开发环境输出到控制台；生产环境写入 userData/logs/main.log。
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let logDir = null;

function getLogDir() {
  if (!logDir) {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

function write(level, args) {
  const message = args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;

  // 控制台始终输出，便于开发调试
  if (level === 'ERROR') console.error(line.trim());
  else if (level === 'WARN') console.warn(line.trim());
  else console.log(line.trim());

  try {
    fs.appendFileSync(path.join(getLogDir(), 'main.log'), line, 'utf8');
  } catch {
    // 日志写入失败不应影响主流程
  }
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
};
