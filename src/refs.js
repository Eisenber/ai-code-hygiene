/**
 * 从文档里抽"引用"：路径引用与符号引用。
 *
 * 这是"文档与代码脱节"检测的唯一入口，所以刻意保守：
 * 只认三类明确形态，避免把普通中文句子里的词当成路径。
 *   1. 反引号里的路径/符号： `src/api.js`、`fetchUser`
 *   2. markdown 链接：       [说明](../api/user.md)
 *   3. 裸路径：             src/api/user.js（仅当带扩展名且形似路径）
 */

import { extOf, isDoc, isCode, lineOf } from './indexer.js';

const URL_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const ANCHOR_RE = /^#/;

/** 首段即为"命令/语言"的常见词，避免把 `npm run build` 当路径。 */
const COMMAND_WORDS = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'python', 'pip', 'git', 'cargo', 'go',
  'docker', 'make', 'bash', 'sh', 'pwsh', 'powershell', 'curl', 'deno', 'bun'
]);

/** 常见编程语言名，出现在反引号里几乎总是"语言标签"而非符号。 */
const LANGUAGE_TAGS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'rb', 'php', 'java', 'kt', 'swift',
  'c', 'cpp', 'cs', 'sh', 'bash', 'zsh', 'pwsh', 'powershell', 'sql', 'json',
  'yaml', 'yml', 'toml', 'html', 'css', 'scss', 'md', 'markdown', 'text', 'txt'
]);

const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const BARE_PATH_RE = /(?:^|[\s(（"'>])((?:[\w.@-]+\/)+[\w.@-]+\.[a-z0-9]{1,6})(?=[\s)）"'`,，。；;]|$)/g;

function looksLikePath(token) {
  const t = token.replace(/^["'<(`]+|["'>`)]+$/g, '').trim();
  if (!t) return null;
  if (URL_RE.test(t) || ANCHOR_RE.test(t)) return null;
  if (t.includes('\n')) return null;
  const first = t.split(/[\s/\\]/)[0].toLowerCase();
  if (COMMAND_WORDS.has(first)) return null;
  if (LANGUAGE_TAGS.has(t.toLowerCase())) return null;
  if (/[<>{}*|]/.test(t)) return null;
  if (/\s/.test(t)) return null; // 带空格的 token 一律不当作路径
  const ext = extOf(t);
  if (!ext) return null;
  if (ext.length > 8) return null;
  return t;
}

/**
 * 抽取前先抹掉围栏代码块。
 *
 * 围栏里的内容是"样例"，不是"本仓库的真实路径"：教程里写 `src/index.ts`
 * 是在举例，不代表仓库里一定有它。把围栏去掉再抽取，是这条边界最精确的表达。
 * 用空格替换而非删除，保持行号不变。
 */
export function maskFencedBlocks(text) {
  const lines = text.split('\n');
  let inFence = false;
  let fenceChar = '';
  const out = lines.map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceChar = m[1][0];
        return ' '.repeat(line.length); // 开围栏那一行本身也视为示例
      }
      if (m[1][0] === fenceChar) {
        inFence = false;
        return ' '.repeat(line.length);
      }
    }
    return inFence ? ' '.repeat(line.length) : line;
  });
  return out.join('\n');
}

/**
 * @returns {{paths: Array<{raw:string,line:number}>, symbols: Array<{raw:string,line:number}>}}
 */
export function extractReferences(rel, text) {
  const scannable = maskFencedBlocks(text);
  const paths = [];
  const symbols = [];
  const seenPath = new Set();
  const seenSymbol = new Set();

  const pushPath = (raw, line, kind) => {
    const clean = raw.replace(/^["'<(`]+|["'>`)]+$/g, '').trim();
    if (!clean) return;
    const key = `${line}:${clean}`;
    if (seenPath.has(key)) return;
    seenPath.add(key);
    paths.push({ raw: clean, line, kind });
  };

  const pushMaybeSymbol = (raw, line) => {
    // 先只去掉包裹用的引号/反引号；括号属于"调用形态"，交给下面单独判断。
    let clean = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!clean) return;
    // 调用形态 `fetchUser(id)` / `obj.method(a, b)`：只留被调用的名字。
    const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\([^)]*\)\s*;?$/.exec(clean);
    if (call) clean = call[1];
    if (!SYMBOL_RE.test(clean)) return;
    if (clean.length < 4) return;
    const lower = clean.toLowerCase();
    if (LANGUAGE_TAGS.has(lower) || COMMAND_WORDS.has(lower)) return;
    if (/^[\d._-]+$/.test(clean)) return;
    const key = `${line}:${clean}`;
    if (seenSymbol.has(key)) return;
    seenSymbol.add(key);
    const context = text.split('\n')[line - 1] ?? '';
    symbols.push({ raw: clean, line, context });
  };

  // 1. 反引号：一次扫描即可拿到内容与偏移，避免二次搜索同名词。
  const codeRe = /`([^`\n]+)`/g;
  let m;
  while ((m = codeRe.exec(scannable)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    const line = lineOf(scannable, m.index);
    const asPath = looksLikePath(body);
    if (asPath) {
      pushPath(asPath, line, 'code');
      continue;
    }
    pushMaybeSymbol(body, line);
  }

  // 2. markdown 链接：只取本地相对/绝对路径，跳过 URL 与纯锚点。
  const linkRe = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  while ((m = linkRe.exec(scannable)) !== null) {
    const target = m[1].replace(/^<|>$/g, '');
    if (URL_RE.test(target) || ANCHOR_RE.test(target)) continue;
    const clean = target.replace(/[?#].*$/, '');
    if (!clean) continue;
    pushPath(clean, lineOf(scannable, m.index), 'link');
  }

  // 3. 裸路径：必须带分隔符与扩展名，且前后是边界字符。
  BARE_PATH_RE.lastIndex = 0;
  while ((m = BARE_PATH_RE.exec(scannable)) !== null) {
    const candidate = m[1];
    if (looksLikePath(candidate)) pushPath(candidate, lineOf(scannable, m.index + m[0].indexOf(candidate)), 'bare');
  }

  return { paths, symbols };
}

/**
 * 把引用解析成候选绝对相对路径（相对文档目录优先，其次仓库根）。
 * 返回 [{ resolved, exists }]，resolved 为已规范化的仓库相对路径。
 */
export function resolveReference(refPath, docRel) {
  const normalized = refPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/')) {
    const fromRoot = normalized.replace(/^\/+/, '');
    return { resolved: fromRoot, exists: null };
  }
  const docDir = docRel.includes('/') ? docRel.slice(0, docRel.lastIndexOf('/')) : '';
  const joined = docDir ? `${docDir}/${normalized}` : normalized;
  return { resolved: normalizeRel(joined), exists: null };
}

/**
 * 折叠 `a/../b`、`./`、重复斜杠；不触盘，纯字符串。
 *
 * 默认保留"越出仓库根"的 `..` 段（`allowEscape`）：
 * 若把 `../../../docs/x.md` 直接折叠成 `docs/x.md`，就等于把它当成仓库内路径，
 * 会凭空制造"文件不存在"的误报。越界引用应当被识别为"不归本仓库管"，而不是坏链。
 */
export function normalizeRel(p, { allowEscape = true } = {}) {
  const out = [];
  let escapes = 0;
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      else if (allowEscape) escapes += 1;
      continue;
    }
    out.push(seg);
  }
  return `${'../'.repeat(escapes)}${out.join('/')}`;
}

/** 该路径是否越出了仓库根。 */
export function isOutsideRoot(p) {
  return p === '..' || p.startsWith('../');
}

/**
 * 收集全仓库的引用关系：谁引用了谁。
 * 返回值同时供 orphan-doc（有没有入链）与 broken-reference（链指向是否存在）使用。
 */
export function buildReferenceGraph(index) {
  const edges = [];       // { from, to, line, raw }
  const byTarget = new Map();

  for (const f of index.files) {
    if (!isDoc(f.rel)) continue;
    const text = index.readText(f.rel);
    if (!text) continue;
    const { paths } = extractReferences(f.rel, text);
    for (const p of paths) {
      const { resolved } = resolveReference(p.raw, f.rel);
      if (!resolved) continue;
      const edge = { from: f.rel, to: resolved, line: p.line, raw: p.raw };
      edges.push(edge);
      if (!byTarget.has(resolved)) byTarget.set(resolved, []);
      byTarget.get(resolved).push(edge);
    }
  }

  /** 某个仓库相对路径被哪些文档引用（精确匹配，不做目录展开）。 */
  const inbound = (rel) => byTarget.get(rel) ?? [];

  return { edges, byTarget, inbound };
}

export { isDoc, isCode };
