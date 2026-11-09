/**
 * 一次跑完全部用例：node test/all.js
 *
 * 为什么不用 `node --test`：DSH 沙箱下 --test 会用带管道的子进程逐个跑测试文件，
 * 被拦截成 EPERM。直接 import 两个测试文件即可在同一进程内注册全部用例。
 * 在没有该限制的环境里，`node --test test/` 也可以工作。
 */

import './scan.test.js';
import './cli.test.js';
