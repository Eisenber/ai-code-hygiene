/**
 * 规则：AI 生成痕迹。
 *
 * 命中不代表该删——只说明"这份文件是某次对话的产物，值得问一句还有没有用"。
 * 因此默认级别是 info：它的价值是帮人定位"哪些东西是对话副产物"，
 * 而不是替人做决定。
 */

export default {
  id: 'hygiene/ai-artifact',
  description: '文件头部有 AI 生成/一次性说明的痕迹',
  defaultSeverity: 'info',

  run(context) {
    const cfg = context.config.rules['hygiene/ai-artifact'];
    const markers = (cfg.markers ?? []).map((m) => m.toLowerCase());
    if (markers.length === 0) return [];
    const findings = [];

    for (const f of context.files) {
      if (context.isFixture(f.rel)) continue;
      const text = context.readText(f.rel);
      if (!text) continue;
      const head = text.split('\n', cfg.headLines ?? 15).slice(0, cfg.headLines ?? 15).join('\n').toLowerCase();
      const hit = markers.find((m) => head.includes(m));
      if (!hit) continue;
      findings.push({
        rule: this.id,
        severity: cfg.severity,
        path: f.rel,
        line: 1,
        message: `文件头部出现 AI 生成痕迹："${hit}"`,
        evidence: '头部前若干行',
        suggestion: '若这是某次对话的临时产出，合并进正式文档后删除；若确有长期价值，去掉"生成说明"保留内容'
      });
    }
    return findings;
  }
};
