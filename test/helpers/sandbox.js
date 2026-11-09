/**
 * 测试专用的临时目录工厂。
 *
 * 每条用例都会建临时仓库；如果不管，跑几次测试就会在系统临时目录里堆出成百上千个目录
 * （本项目第一次推送前就踩过这个坑）。这里用 two 层清理：
 *   1. 用例内用 `t.after()` 删掉自己的沙箱，单条用例失败也不影响
 *   2. 文件级兜底：整次运行结束后再统一清一次
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 为当前测试文件创建一个沙箱工厂。
 * @param {(fn: () => void) => void} fileAfter 测试文件的 after 钩子（`after` from node:test）
 */
export function createSandboxFactory(fileAfter) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicg-test-'));
  let seq = 0;

  fileAfter(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {
      /* 系统临时目录迟早会回收，清理失败不该影响测试结论 */
    }
  });

  /**
   * @param {object} t 测试上下文（`test('...', (t) => ...)` 的 t），用于注册用例级清理
   * @param {string} [label] 可读前缀，便于人工排查
   */
  return function makeSandbox(t, label = 'repo') {
    seq += 1;
    const dir = fs.mkdtempSync(path.join(rootDir, `${label}-${seq}-`));
    if (t && typeof t.after === 'function') {
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    return dir;
  };
}
