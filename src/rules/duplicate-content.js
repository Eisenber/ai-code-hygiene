/**
 * 规则：内容重复。
 *
 * 判重只认"归一化后完全一致"（忽略空白与换行风格），不做相似度——
 * 相似度会把同一模板产出的两份不同文档判成重复，误报代价高。
 * 多个副本合并成一条 finding，避免同一内容刷屏。
 */

import { hashContent, normalizeContent } from '../indexer.js';

export default {
  id: 'hygiene/duplicate-content',
  description: '归一化后内容完全相同的文件（通常是一次对话被复制到多处）',
  defaultSeverity: 'warn',

  run(context) {
    const cfg = context.config.rules['hygiene/duplicate-content'];
    const minChars = cfg.minChars ?? 100;
    const groups = new Map();

    for (const f of context.files) {
      if (context.isFixture(f.rel)) continue;
      if (f.size < minChars) continue; // 字节数作为廉价预筛，真正的门槛在归一化长度
      const text = context.readText(f.rel);
      if (!text) continue;
      const normalized = normalizeContent(text);
      if (normalized.length < minChars) continue;
      const key = hashContent(normalized);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f.rel);
    }

    const findings = [];
    for (const [hash, rels] of groups) {
      if (rels.length < 2) continue;
      const [keep, ...rest] = rels; // rels 已按路径排序，keep 是最靠前的一份
      findings.push({
        rule: this.id,
        severity: cfg.severity,
        path: keep,
        message: `与其他 ${rest.length} 个文件内容完全相同（应只保留一份）`,
        evidence: `duplicates: ${rest.join(', ')}`,
        suggestion: '选定权威副本，删除其余；若都不权威，合并后保留一处并交叉链接',
        duplicates: rest
      });
    }
    return findings;
  }
};
