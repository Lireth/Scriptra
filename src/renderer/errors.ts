/**
 * 渲染进程全局错误处理与日志上报
 */

export function setupErrorReporting(): void {
  window.addEventListener('error', (e) => {
    window.scriptra.log('error', `未捕获错误: ${e.message} @ ${e.filename}:${e.lineno}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason.stack : String(e.reason)
    window.scriptra.log('error', `未处理的 Promise 拒绝: ${reason}`)
  })
}
