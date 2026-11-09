/**
 * 规则：文档里的"计划日期"已经过期，或文档本身长期未改动。
 *
 * 两种信号都刻意做成 warn/info 而不是 error：
 * 日期可能是在描述"过去发生过的事"（公告、变更记录），这类命中属正常，
 * 由人一眼扫过即可；工具的价值是把它们排到台面上。
 */

import { matchesAny } from '../walk.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 规划语义：这些词后面跟日期，几乎一定是"待办/承诺"。 */
const PLAN_KEYWORDS = /(计划|预计|预期|排期|上线|截止|deadline|target|due|eta|milestone|里程碑)/i;

/**
 * "发布"是歧义词：既可能是"计划 2025-06 发布"，也可能是"已于 2025-03 发布"。
 * 只有当前面 12 个字符内出现计划类词时，才把它当成规划语境。
 */
function hasPlanContext(line) {
  if (PLAN_KEYWORDS.test(line)) return true;
  const releaseRe = /(计划|预计|预期|将|拟|目标)[^。；;\n]{0,12}(发布|上线|推出)|release[^.\n]{0,12}(planned|target)/gi;
  return releaseRe.test(line);
}

/** 中文/英文的"年月"与"年月日"，以及英文月份名。 */
const DATE_PATTERNS = [
  // 2026-11-06 / 2026/11/6 / 2026.11.6
  { re: /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/g, kind: 'ymd' },
  // 2026年11月6日
  { re: /(20\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?/g, kind: 'cn' },
  // 2026-11 / 2026/11（仅当年月用）
  { re: /(20\d{2})[-/.](\d{1,2})(?![-/.\d])/g, kind: 'ym' },
  // November 2026 / Oct 2026
  {
    re: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(20\d{2})\b/gi,
    kind: 'en'
  }
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthIndex(name) {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i === -1 ? 0 : i;
}

/** 从文本中抽出所有可识别日期，返回 {line, year, month, day, raw, hasPlanKeyword} */
export function extractDates(text) {
  const lines = text.split('\n');
  const out = [];

  for (const [i, line] of lines.entries()) {
    const plan = hasPlanContext(line);
    for (const { re, kind } of DATE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        let year;
        let month;
        let day;
        if (kind === 'ymd' || kind === 'ym' || kind === 'cn') {
          year = Number(m[1]);
          month = Number(m[2]);
          day = m[3] ? Number(m[3]) : 1;
        } else {
          year = Number(m[2]);
          month = monthIndex(m[1]) + 1;
          day = 1;
        }
        if (!Number.isFinite(year) || year < 2000 || year > 2100) continue;
        if (month < 1 || month > 12) continue;
        if (day < 1 || day > 31) continue;
        out.push({ line: i + 1, year, month, day, raw: m[0].trim(), hasPlanKeyword: plan });
      }
    }
  }
  return out;
}

export default {
  id: 'hygiene/stale-date',
  description: '文档中的计划日期已过期，或文档超过阈值未改动',
  defaultSeverity: 'warn',

  run(context) {
    const cfg = context.config.rules['hygiene/stale-date'];
    const findings = [];
    const now = new Date(context.now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    for (const f of context.files) {
      if (!/\.(md|markdown|mdx)$/i.test(f.rel)) continue;
      if (context.isFixture(f.rel)) continue;
      if (matchesAny(f.rel, cfg.excludeGlobs)) continue;
      const text = context.readText(f.rel);
      if (!text) continue;

      // 1) 规划日期已过：只有当日期明确处于"规划语境"才报，避免误伤变更记录。
      for (const d of extractDates(text)) {
        if (!d.hasPlanKeyword) continue;
        const date = new Date(d.year, d.month - 1, d.day);
        if (date >= today) continue;
        findings.push({
          rule: this.id,
          severity: cfg.severity,
          path: f.rel,
          line: d.line,
          message: `规划日期 ${d.raw} 已过去，但文档仍在描述它`,
          evidence: `今天 ${today.toISOString().slice(0, 10)}`,
          suggestion: '更新为实际完成情况，或删掉这段已失效的计划'
        });
      }

      // 2) 文档本身长期未动：只作为线索，不推断内容对错。
      const days = cfg.untouchedDays ?? 0;
      if (days > 0) {
        const t = context.times[f.rel] ?? f.mtimeMs;
        const age = Math.floor((context.now - t) / MS_PER_DAY);
        if (age >= days) {
          findings.push({
            rule: this.id,
            severity: 'info',
            path: f.rel,
            message: `文档已 ${age} 天未改动（阈值 ${days} 天）`,
            evidence: `${context.precision[f.rel] ?? 'mtime'}：${new Date(t).toISOString().slice(0, 10)}`,
            suggestion: '确认仍然准确；不准确则更新，已废弃则删除'
          });
        }
      }
    }
    return findings;
  }
};
