/**
 * 索引层：把文件变成规则可用的只读事实。
 *
 * 只有两类数据会被"贵"地处理：文档引用（需要解析）与代码符号（需要按语法族抽取）。
 * 其余都保持惰性：文本按需读取并缓存，避免为大仓库付全量 I/O。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CODE_LANGUAGE_BY_EXT, DOC_EXTENSIONS } from './config.js';
import { isTextFile } from './walk.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

export function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function isDoc(rel) {
  return DOC_EXTENSIONS.has(extOf(rel));
}

export function isCode(rel) {
  return Boolean(CODE_LANGUAGE_BY_EXT[extOf(rel)]);
}

/** 内容归一化：用于判重（忽略空白与换行风格差异），不用于展示。 */
export function normalizeContent(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

export function hashContent(normalized) {
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

// --- 代码符号抽取 -------------------------------------------------------
// 刻意只覆盖常见声明形态，不做 AST。目标是"被删掉的名字能被发现"，
// 因此宁可漏，不可妄：多收一个名字只会让断链少报，误报则会让整条规则不可信。
//
// 除顶层声明外，还收"函数型成员"（对象属性、类方法）。原因很实际：
// 文档里会写 `isFixture(rel)` 这类 context 方法，若只索引顶层声明，
// 这些真实存在的成员会被判成"符号不存在"——本项目自己的 CONTRIBUTING.md 就撞上过。

/** 函数型成员：`name: (args) =>`、`name: function`、`name: arg =>`、类/对象里的简写方法 `name(args) {`。 */
const MEMBER_FN_PATTERNS = [
  /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g,
  /(?:^|\n)\s*(?:static\s+|async\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*\{/g
];

const SYMBOL_PATTERNS = {
  js: [
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    ...MEMBER_FN_PATTERNS
  ],
  ts: [
    /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    ...MEMBER_FN_PATTERNS
  ],
  py: [
    /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)class\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/g
  ],
  go: [
    /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
    /(?:^|\n)\s*type\s+([A-Za-z_]\w*)/g
  ],
  rs: [
    /(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)\s*(?:pub\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/g
  ],
  jvm: [
    /(?:^|\n)\s*(?:public|private|protected|internal|static|final|abstract|sealed|data|open|suspend|\s)*\s*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)\s*(?:public|private|protected|internal|static|final|synchronized|abstract|override|\s)+[\w<>[\],.*\s]+\s+([A-Za-z_]\w*)\s*\(/g
  ],
  rb: [
    /(?:^|\n)\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/g,
    /(?:^|\n)\s*(?:class|module)\s+([A-Z]\w*)/g
  ],
  php: [
    /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/g,
    /(?:^|\n)\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/g
  ]
};

export function extractSymbols(rel, text) {
  const lang = CODE_LANGUAGE_BY_EXT[extOf(rel)];
  if (!lang) return [];
  const patterns = SYMBOL_PATTERNS[lang] ?? [];
  const found = new Set();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found].sort();
}

// --- 时间证据 ------------------------------------------------------------

/** 仓库是否有 git 可用：一次探测，失败即永久降级。 */
export function detectGit(rootDir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * 每个文件的"最后有意义变更时间"。
 * 有 git 用 commit 时间（不受 checkout 影响）；否则退回 mtime，并标记精度。
 *
 * `readGitTime` 可注入：子进程在某些受限环境里不可用，测试也需要确定性。
 */
export function resolveTimes(rootDir, files, useGit, readGitTime = readGitCommitTime) {
  const times = Object.create(null);
  const precision = Object.create(null);
  for (const f of files) {
    times[f.rel] = f.mtimeMs;
    precision[f.rel] = 'mtime';
  }
  if (!useGit) return { times, precision, git: false };

  for (const f of files) {
    let ms;
    try {
      ms = readGitTime(rootDir, f.rel);
    } catch {
      ms = null; // 单文件失败不应让整次扫描失败：保留 mtime。
    }
    if (Number.isFinite(ms) && ms > 0) {
      times[f.rel] = ms;
      precision[f.rel] = 'git';
    }
  }
  return { times, precision, git: true };
}

/** 默认实现：调用 git 取该路径最后一次提交的提交时间。 */
export function readGitCommitTime(rootDir, rel) {
  const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000
  }).trim();
  const secs = Number.parseInt(out, 10);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

// --- 索引构建 ------------------------------------------------------------

/**
 * @param {string} rootDir 绝对路径
 * @param {Array} files walk() 的输出
 * @param {{now:number}} opts
 */
export function buildIndex(rootDir, files, opts = {}) {
  const texts = new Map();
  const symbols = new Map();
  const dupKeys = new Map();
  const readErrors = [];

  const readText = (rel) => {
    if (texts.has(rel)) return texts.get(rel);
    const f = files.find((x) => x.rel === rel);
    if (!f || !isTextFile(f.ext)) {
      texts.set(rel, null);
      return null;
    }
    let raw;
    try {
      raw = fs.readFileSync(f.abs, 'utf8');
    } catch (err) {
      readErrors.push({ path: rel, error: err.code ?? 'EREAD' });
      texts.set(rel, null);
      return null;
    }
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    texts.set(rel, text);
    return text;
  };

  const useGit = opts.useGit ?? detectGit(rootDir);
  const { times, precision, git } = resolveTimes(rootDir, files, useGit, opts.readGitTime);

  for (const f of files) {
    if (!isCode(f.rel)) continue;
    const text = readText(f.rel);
    if (text === null) continue;
    symbols.set(f.rel, extractSymbols(f.rel, text));
  }

  /** 全仓库符号并集 + 每个符号出现在哪些文件（用于报"符号已不存在"时给线索）。 */
  const symbolIndex = new Map();
  for (const [rel, names] of symbols) {
    for (const name of names) {
      if (!symbolIndex.has(name)) symbolIndex.set(name, []);
      symbolIndex.get(name).push(rel);
    }
  }

  return {
    rootDir,
    now: opts.now ?? Date.now(),
    files,
    fileSet: new Set(files.map((f) => f.rel)),
    byExt: files.reduce((acc, f) => {
      acc[f.ext] = (acc[f.ext] ?? 0) + 1;
      return acc;
    }, {}),
    readText,
    texts,
    symbols,
    symbolIndex,
    dupKeys,
    times,
    precision,
    git,
    readErrors
  };
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

export { path };
