/**
 * 规则：孤儿文档。
 *
 * "没有任何其他文档链接到它"本身不是罪，所以范围收得很紧：
 *   - 位于 docs 目录内，或
 *   - 名字像 AI 对话副产物（summary/notes/draft/plan/report...）
 * 入口类文档（README/AGENTS/SKILL...）与 fixture 明确豁免。
 */

import { isDoc } from '../indexer.js';
import { matchesAny, globToRegExp } from '../walk.js';

function nameMatches(rel, patterns) {
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  return (patterns ?? []).some((p) => base.includes(p.toLowerCase()));
}

/** rel 是否位于某个"平铺入口目录"的直接子文件中（如 .dsh/skills/todo-triage.md）。 */
function isFlatEntry(rel, dirs) {
  return (dirs ?? []).some((dir) => {
    const prefix = dir.replace(/\/+$/, '');
    return rel.startsWith(`${prefix}/`) && !rel.slice(prefix.length + 1).includes('/');
  });
}

export default {
  id: 'hygiene/orphan-doc',
  description: '位于文档目录或名字像对话副产物，且没有任何其他文档引用它',
  defaultSeverity: 'warn',

  run(context) {
    const cfg = context.config.rules['hygiene/orphan-doc'];
    const findings = [];

    for (const f of context.files) {
      if (!isDoc(f.rel)) continue;
      if (context.isFixture(f.rel)) continue;
      if (matchesAny(f.rel, cfg.excludeGlobs)) continue;

      const inDocsDir = /(^|\/)docs?\//i.test(f.rel);
      const riskyName = nameMatches(f.rel, cfg.namePatterns);
      if (!inDocsDir && !riskyName) continue;

      const inbound = context.graph.inbound(f.rel);
      if (inbound.length > 0) continue;

      const isEntry = (cfg.entryGlobs ?? []).some((g) => globToRegExp(g).test(f.rel));
      if (isEntry) continue;
      // 平铺形态的技能/命令文件（.dsh/skills/foo.md）本身就是入口，不靠别的文档链接。
      if (isFlatEntry(f.rel, cfg.flatEntryGlobs ?? [])) continue;

      findings.push({
        rule: this.id,
        severity: cfg.severity,
        path: f.rel,
        message: '没有任何文档引用它：既不是入口，也不是被链接的章节',
        evidence: inDocsDir ? '位于 docs 目录' : `文件名含 ${cfg.namePatterns.find((p) => f.rel.toLowerCase().includes(p.toLowerCase()))}`,
        suggestion: '从某个入口文档链接过去；内容已过时则删除；内容仍有价值则合并进相邻文档'
      });
    }
    return findings;
  }
};
