/**
 * 预加载脚本（Preload）
 *
 * 通过 contextBridge 向渲染进程暴露最小、安全的 API。
 * 渲染进程无法直接访问 Node.js 与 Electron 内部能力，
 * 所有跨进程调用都必须经过此白名单。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 允许渲染进程调用的 IPC 通道白名单
const INVOKE_CHANNELS = ['app:get-version', 'app:get-platform'];
const RECEIVE_CHANNELS = ['app:update-status'];

contextBridge.exposeInMainWorld('scriptra', {
  /** 读取应用版本号 */
  getVersion: () => ipcRenderer.invoke('app:get-version'),

  /** 读取当前运行平台 */
  getPlatform: () => ipcRenderer.invoke('app:get-platform'),

  /** 读取运行时版本信息（Electron / Chromium / Node 等） */
  getVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),

  /**
   * 通用 invoke：仅允许白名单通道
   * @param {string} channel IPC 通道名
   * @param  {...any} args 参数
   */
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.includes(channel)) {
      throw new Error(`未授权的 IPC 通道: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /**
   * 监听主进程事件，返回取消监听的函数
   * @param {string} channel 事件通道名
   * @param {(payload: any) => void} handler 回调
   */
  on: (channel, handler) => {
    if (!RECEIVE_CHANNELS.includes(channel)) {
      throw new Error(`未授权的事件通道: ${channel}`);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
