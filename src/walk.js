/**
 * 文件发现。
 *
 * 目标不是"列出所有文件"，而是列出一份**稳定、可复现**的清单：
 * 同一份仓库在任何机器上必须产出同样顺序的结果，否则账本与 diff 都无法比较。
 * 因此这里所有排序都显式使用代码点比较（不依赖 locale）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SKIP_DIRS, TEXT_EXTENSIONS } from './config.js';

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** 代码点排序，跨平台稳定。 */
export function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 极简 glob → 正则：只支持 ** / * / ? 与结尾通配，够用且无依赖。 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 匹配零或多级目录；`**` 结尾匹配任意后缀。
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(relPosix, globs) {
  return (globs ?? []).some((g) => globToRegExp(g).test(relPosix));
}

function isIgnoredByGlobs(relPosix, globs) {
  for (const g of globs ?? []) if (globToRegExp(g).test(relPosix)) return true;
  return false;
}

/**
 * 读取仓库根目录下 .gitignore 的**简单**子集：注释、否定无关，仅支持目录尾斜杠与通配。
 * 读不到就当没有——这不是 git 实现，只是避免把构建产物扫进来。
 */
export function readGitignore(rootDir) {
  const file = path.join(rootDir, '.gitignore');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => {
      const n = l.replace(/^\/+/, '');
      if (n.endsWith('/')) return `${n}**`;
      if (n.includes('/')) return n;
      return `**/${n}`;
    });
}

/**
 * 遍历根目录，产出排序后的文件清单。只做 stat，不读内容。
 * @returns {Array<{rel:string, abs:string, size:number, mtimeMs:number, ext:string}>}
 */
export function walk(rootDir, config) {
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.extraSkipDirs ?? [])]);
  const fixtureDirs = config.fixtureDirs ?? [];
  const gitignore = config.respectGitignore ? readGitignore(rootDir) : [];
  const ignore = [...(config.ignore ?? []), ...gitignore];
  const files = [];
  const unreadable = [];

  const visit = (dirAbs) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ path: toPosix(path.relative(rootDir, dirAbs)), error: err.code ?? 'EUNKNOWN' });
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = toPosix(path.relative(rootDir, abs));
      if (entry.isSymbolicLink()) continue; // 不追符号链接：避免环与逃逸出仓库

      /**
       * 夹具目录整棵跳过：那里的"脏"是故意构造的测试数据。
       * 只在**非 root** 时才跳过，否则 `--root test/samples/messy` 这种显式扫描会得到空结果。
       */
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (fixtureDirs.includes(entry.name)) continue;
        if (isIgnoredByGlobs(rel, ignore)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredByGlobs(rel, ignore)) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        unreadable.push({ path: rel, error: 'ESTAT' });
        continue;
      }
      if (st.size > config.maxFileBytes) continue;
      files.push({
        rel,
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ext: path.extname(entry.name).toLowerCase()
      });
    }
  };

  visit(rootDir);
  files.sort((a, b) => byCodePoint(a.rel, b.rel));
  return { files, unreadable };
}

export function isTextFile(ext) {
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * 该路径是否落在"夹具目录"里。
 * 只匹配**中途**名为 fixtures/samples/testdata 的目录段；
 * 若 root 本身就是一个夹具目录（显式 `--root test/samples/messy`），
 * 它不在 rel 里出现，所以不会被误跳过。
 */
export function isFixturePath(relPosix, fixtureDirs) {
  const segs = relPosix.split('/');
  segs.pop(); // 去掉文件名，只看目录段
  return segs.some((seg) => (fixtureDirs ?? []).includes(seg));
}
