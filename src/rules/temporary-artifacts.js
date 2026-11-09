/**
 * 规则：临时/一次性产物（temporary artifacts）。
 *
 * 只看文件名——这是最便宜、误报也最容易解释的一类信号。
 * 判定分两个方向，因为"像临时产物"的标记出现在名字不同位置，含义并不一样：
 *   - 前缀（scratch-xxx、tmp_xxx、副本-xxx）：几乎不会是正式文件
 *   - 后缀（xxx-old、xxx.bak、xxx 副本）：需要紧跟分隔符，避免 xxx-temp.js 这类正常源文件被误伤
 */

export default {
  id: 'hygiene/temp-file',
  description: '命名上就是一次性产物的文件（tmp/bak/old/copy/fixed 等）',
  defaultSeverity: 'warn',

  run(context) {
    const cfg = context.config.rules['hygiene/temp-file'];
    const findings = [];

    let prefixPatterns;
    let suffixPatterns;
    let exactPatterns;
    try {
      prefixPatterns = (cfg.prefixPatterns ?? []).map((p) => new RegExp(p, 'i'));
      suffixPatterns = (cfg.suffixPatterns ?? []).map((p) => new RegExp(p, 'i'));
      exactPatterns = (cfg.exactPatterns ?? []).map((p) => new RegExp(p, 'i'));
    } catch (err) {
      throw new Error(`hygiene/temp-file 的 prefix/suffix/exactPatterns 不是合法正则：${err.message}`);
    }

    for (const f of context.files) {
      if (context.isFixture(f.rel)) continue;
      // 只匹配 basename：`**/old/**` 这种"目录本身叫 old"的情况留给用户配置，
      // 以免把 `src/legacy/` 下的正常文件整片判成临时产物。
      const base = f.rel.slice(f.rel.lastIndexOf('/') + 1);
      const hit =
        prefixPatterns.find((re) => re.test(base)) ??
        exactPatterns.find((re) => re.test(base)) ??
        suffixPatterns.find((re) => re.test(base));
      if (!hit) continue;

      findings.push({
        rule: this.id,
        severity: cfg.severity,
        path: f.rel,
        message: `文件名符合一次性产物模式：${hit.source}`,
        evidence: `${f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}，改动于 ${new Date(f.mtimeMs).toISOString().slice(0, 10)}`,
        suggestion: '确认不再需要内容后删除；若内容仍有价值，合并进正式文档再把原文件删掉'
      });
    }
    return findings;
  }
};
