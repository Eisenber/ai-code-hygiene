/**
 * 规则：文档描述的代码比文档新。
 *
 * 判定纯靠时间戳，因此只能给 info：
 * "代码比文档新"不一定意味着文档错了，但值得在清退时先看这一屏。
 *
 * 无 git 时用的是 mtime，一次全量 checkout 会让所有文件同时变"新"，
 * 所以这里把精度一并写进证据，让人知道该不该信。
 */

import { isCode, isDoc } from '../indexer.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export default {
  id: 'hygiene/stale-vs-code',
  description: '文档所描述的代码文件，比文档本身更新得更晚',
  defaultSeverity: 'info',

  run(context) {
    const cfg = context.config.rules['hygiene/stale-vs-code'];
    const minLag = cfg.minLagDays ?? 30;
    const projectLag = cfg.minProjectLagDays ?? 90;
    const findings = [];
    const codeFiles = context.files.filter((f) => isCode(f.rel));

    /** 文档提到的代码文件：引用边 + 正文里出现的路径，两种都算。 */
    const mentionedCode = (docRel, text) => {
      const hits = new Set();
      for (const edge of context.graph.edges) {
        if (edge.from === docRel && isCode(edge.to) && context.fileSet.has(edge.to)) hits.add(edge.to);
      }
      for (const cf of codeFiles) {
        if (text.includes(cf.rel)) hits.add(cf.rel);
      }
      return [...hits];
    };

    // 项目级参照：全仓库最近改动的代码文件（只看时间，不做语义关联）
    let newestProject = null;
    for (const cf of codeFiles) {
      const t = context.times[cf.rel] ?? 0;
      if (!newestProject || t > newestProject.t) newestProject = { rel: cf.rel, t };
    }

    for (const f of context.files) {
      if (!isDoc(f.rel)) continue;
      if (context.isFixture(f.rel)) continue;
      const text = context.readText(f.rel);
      if (!text) continue;

      const docTime = context.times[f.rel] ?? f.mtimeMs;
      let newest = null;
      for (const rel of mentionedCode(f.rel, text)) {
        const t = context.times[rel] ?? 0;
        if (t > docTime && (!newest || t > newest.t)) newest = { rel, t };
      }

      // 情况 A：文档明确提到某个代码文件，且那个文件后改 → 阈值 minLagDays
      if (newest) {
        const lagDays = Math.floor((newest.t - docTime) / MS_PER_DAY);
        if (lagDays >= minLag) {
          findings.push({
            rule: this.id,
            severity: cfg.severity,
            path: f.rel,
            message: `文档比它提到的 ${newest.rel} 落后 ${lagDays} 天，可能已过时`,
            evidence: `doc ${new Date(docTime).toISOString().slice(0, 10)}（${context.precision[f.rel]}）< code ${new Date(newest.t).toISOString().slice(0, 10)}（${context.precision[newest.rel]}）`,
            suggestion: '对照代码确认文档是否仍成立；不成立则更新或删除'
          });
          continue;
        }
      }

      // 情况 B：文档没写死路径，但整个仓库的代码都比它新很多 → 阈值更高，只给线索
      if (!cfg.projectWide || !newestProject) continue;
      const projectLagDays = Math.floor((newestProject.t - docTime) / MS_PER_DAY);
      if (projectLagDays < projectLag) continue;
      findings.push({
        rule: this.id,
        severity: 'info',
        path: f.rel,
        message: `文档未提及具体代码文件，但仓库代码整体比它新 ${projectLagDays} 天`,
        evidence: `最新代码 ${newestProject.rel} @ ${new Date(newestProject.t).toISOString().slice(0, 10)}（${context.precision[newestProject.rel]}）`,
        suggestion: '确认文档是否还在描述当前系统；不确定就补上它描述的模块路径，让下次判定更精确'
      });
    }
    return findings;
  }
};
