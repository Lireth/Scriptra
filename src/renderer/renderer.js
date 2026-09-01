/**
 * 渲染进程脚本
 *
 * 仅通过 preload 暴露的 window.scriptra 与主进程通信，
 * 不直接访问 Node.js API。
 */

(function () {
  'use strict';

  async function fillRuntimeInfo() {
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    try {
      const version = await window.scriptra.getVersion();
      setText('app-version', `v${version}`);
    } catch {
      setText('app-version', '未知版本');
    }

    try {
      const platform = await window.scriptra.getPlatform();
      setText('info-platform', platform);
    } catch {
      setText('info-platform', '未知');
    }

    // 通过 preload 暴露的 API 读取运行时版本
    try {
      const versions = window.scriptra.getVersions();
      setText('info-electron', versions.electron || '-');
      setText('info-chromium', versions.chrome || '-');
      setText('info-node', versions.node || '-');
    } catch {
      setText('info-electron', '-');
      setText('info-chromium', '-');
      setText('info-node', '-');
    }
  }

  document.addEventListener('DOMContentLoaded', fillRuntimeInfo);
})();
