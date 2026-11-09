/**
 * 规则：失效引用（文档指向的东西已经不存在）。
 *
 * 这是本工具里唯一默认 error 的规则：路径存在与否是客观事实，不需要猜测。
 * 因此实现上也必须守住"零误报"：
 *   - 路径在仓库内解析失败 → 报
 *   - 路径解析成功但被忽略规则跳过 → 单独提示，不当作错误
 *   - 符号在全仓库符号表里找不到 → 报（可通过 checkSymbols=false 关闭）
 */

import { isDoc } from '../indexer.js';
import { extractReferences, resolveReference, normalizeRel, isOutsideRoot } from '../refs.js';
import { matchesAny } from '../walk.js';

/**
 * "尚不存在的名词"是设计文档的正常内容，不是断链。
 * 命中这些词的句子里的符号一律跳过——宁可漏报，也不制造"设计文档永远报错"的噪音。
 */
const PLANNED_CONTEXT = /(尚未|还没|待实现|待迁移|待补|计划|即将|后续|未来|规划|预期|TODO|roadmap|planned|not yet|to be implemented|will be added)/i;

/**
 * 反引号里的一个词，什么时候算"代码引用"而不是"术语"？
 * 这两个信号足够强，且不需要语义模型：
 *   1. 函数调用形态：`foo(` / `fetchUser(id)`
 *   2. 前面紧跟代码类词：函数 `foo`、方法 `bar`、class `Baz`
 * 只有这类符号才值得检查"是否还存在"；`error`、`warn`、`description` 只是词。
 */
const CODE_CUE = /(函数|方法|接口|类|类型|常量|导出|参数|属性|字段|指令|命令|工具|function|method|class|interface|type|const|export|param|prop|field|option|flag)\s*$/i;

function looksLikeCodeReference(symbol, lineText) {
  const idx = lineText.indexOf(symbol.raw);
  if (idx >= 0 && /^\s*\(/.test(lineText.slice(idx + symbol.raw.length))) return true;
  const before = idx >= 0 ? lineText.slice(0, idx) : '';
  return CODE_CUE.test(before);
}

export default {
  id: 'hygiene/broken-reference',
  description: '文档里引用的文件路径或代码符号已不存在',
  defaultSeverity: 'error',

  run(context) {
    const cfg = context.config.rules['hygiene/broken-reference'];
    const findings = [];

    for (const f of context.files) {
      if (!isDoc(f.rel)) continue;
      if (context.isFixture(f.rel)) continue;
      if (matchesAny(f.rel, cfg.excludeGlobs)) continue;
      const text = context.readText(f.rel);
      if (!text) continue;

      const { paths, symbols } = extractReferences(f.rel, text);
      const reported = new Set();
      /** 文档解析到、且确实存在于本仓库的代码文件：符号检查的作用域。 */
      const linkedCodeFiles = new Set();

      for (const p of paths) {
        const { resolved } = resolveReference(p.raw, f.rel);
        if (!resolved) continue; // 越出仓库根的引用不判断
        if (resolved === f.rel) continue;

        /**
         * 一个引用有两种合理解释，都必须试：
         *   1. 相对当前文档所在目录（markdown 链接的语义）
         *   2. 相对仓库根（README/索引类文档里常见的写法）
         * 只试第一种会把 `src/legacy/post.js` 误判成 broken。
         */
        const candidates = [resolved, normalizeRel(p.raw.replace(/^\/+/, ''))];

        // 指向仓库之外的引用（../../xxx）：本工具只对仓库内文件负责，不做判断。
        if (isOutsideRoot(resolved) || candidates.every((c) => isOutsideRoot(c))) continue;

        const existingCode = candidates.find((c) => context.symbols.has(c));
        if (existingCode) linkedCodeFiles.add(existingCode);
        if (candidates.some((c) => context.fileSet.has(c))) continue;

        const key = `p:${p.line}:${resolved}`;
        if (reported.has(key)) continue;
        reported.add(key);

        /**
         * 严重度取决于"作者意图有多明确"：
         *   link → 它就是个链接，点不开就是坏的（error）
         *   code/bare → 可能只是举例说明，缺失只作提示（默认为 info）
         */
        const isLink = p.kind === 'link';
        // 反引号里以 / 开头的写法（如 README 里的 `/docs/x.md`）也明确指向仓库根，
        // 表达的是"这个文件应该存在"，因此同样按链接处理。
        const isRootRef = p.kind === 'code' && p.raw.startsWith('/');

        /**
         * 单段文件名（没有目录分隔符）且不是链接：几乎都是文档在举例（`notes.md`、`config.yml`）。
         * 只有名字本身就带"临时产物"特征时才算线索，否则直接跳过——
         * 这类"疑似路径"的假阳性最容易让人关掉整条规则。
         * 链接与根相对写法不受此限：它们即使只写文件名，也表达"这个文件应该存在"。
         */
        if (!isLink && !isRootRef) {
          const target = candidates.find((c) => !isOutsideRoot(c)) ?? resolved;
          const singleSegment = !target.includes('/');
          const looksTemporal = /(tmp|temp|bak|old|copy|副本|summary|draft|scratch|note)/i.test(target);
          if (singleSegment && !looksTemporal) continue;
        }

        const severity = isLink || isRootRef ? cfg.severity : (cfg.nonLinkSeverity ?? 'info');

        findings.push({
          rule: this.id,
          severity,
          path: f.rel,
          line: p.line,
          message: `引用的路径不存在：${p.raw}（尝试过 ${[...new Set(candidates)].join(' 与 ')}）`,
          evidence: isLink || isRootRef ? '链接目标不存在' : '扫描清单中没有该路径（可能只是示例）',
          suggestion: '改为仍然存在的路径；目标已删除则移除这段描述'
        });
      }

      if (!cfg.checkSymbols) continue;
      /**
       * 符号检查必须以"该文档确实在描述本仓库的代码"为前提。
       * 判据：它引用了至少一个仓库内真实存在的代码文件（路径解析成功且是代码扩展名）。
       * 否则教程、说明、配置手册里的 `read`、`description` 之类词会被当成"已删除的符号"。
       *
       * 引用来源包含反引号路径与 markdown 链接（两者都会进入 paths）。
       */
      if (linkedCodeFiles.size === 0) continue;
      const minLen = cfg.minSymbolLength ?? 4;

      const codeSymbols = new Set();
      for (const rel of linkedCodeFiles) {
        for (const name of context.symbols.get(rel) ?? []) codeSymbols.add(name);
      }

      for (const s of symbols) {
        const name = s.raw.includes('.') ? s.raw.split('.')[0] : s.raw;
        if (name.length < minLen) continue;
        // 先判断"这到底是不是在引用代码"，再判断符号是否存在。
        if (!looksLikeCodeReference(s, s.context ?? '')) continue;
        if (context.symbolIndex.has(name)) continue;
        // 只在该文档所描述的那些代码文件里找：跨模块误判比漏报更伤。
        if (codeSymbols.has(name)) continue;
        // 描述"尚不存在"的符号不是断链：设计文档天然会提到还没实现的东西。
        if (PLANNED_CONTEXT.test(s.context ?? '')) continue;
        const key = `s:${s.line}:${name}`;
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({
          rule: this.id,
          severity: 'warn', // 符号抽取是启发式的，降一级避免误报被当事实
          path: f.rel,
          line: s.line,
          message: `引用的代码符号不存在：${name}`,
          evidence: '全仓库未找到声明',
          suggestion: '符号已重命名/删除时同步更新文档；仍存在则确认是否漏扫了代码目录'
        });
      }
    }
    return findings;
  }
};
