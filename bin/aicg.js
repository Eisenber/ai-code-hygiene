#!/usr/bin/env node
/**
 * 唯一入口：只做两件事——读版本号、把退出码交给 Node。
 * 所有命令逻辑在 src/cli.js（可被测试直接 import，不必起子进程）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

process.exitCode = run(process.argv.slice(2), { version: PKG.version });
