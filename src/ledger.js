/**
 * 账本：把"人做过的裁决"持久化，是本项目唯一的写入语义。
 *
 * 它解决的不是"发现问题"，而是"同一个问题不要每周重新吵一遍"，以及
 * "以为删了、其实没删"和"申请了豁免、从此没人记得"这两种腐烂形态。
 *
 * 条目结构（刻意扁平，便于 code review 时肉眼 diff）：
 *   { path, rule?, disposition, until?, reviewAfter?, since?, reason? }
 *   - rule 省略表示对"该路径的所有规则"生效
 *   - until       仅 snooze：到期后重新报告
 *   - reviewAfter 仅 keep：到期后提示复核
 *   - since       仅 remove：标记要删的起始日
 */

import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_VERSION = 1;
export const DISPOSITIONS = ['keep', 'snooze', 'remove'];

export function emptyLedger() {
  return { version: LEDGER_VERSION, entries: [] };
}

export class LedgerError extends Error {}

export function loadLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyLedger();
    throw new LedgerError(`无法读取账本 ${file}：${err.code ?? err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LedgerError(`账本不是合法 JSON（${file}）：${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerError(`账本顶层必须是对象（${file}）`);
  }
  if (parsed.version !== LEDGER_VERSION) {
    throw new LedgerError(`账本版本 ${parsed.version} 不受支持（期望 ${LEDGER_VERSION}）：${file}`);
  }
  if (!Array.isArray(parsed.entries)) throw new LedgerError(`账本缺少 entries 数组：${file}`);
  for (const [i, e] of parsed.entries.entries()) {
    if (!e || typeof e.path !== 'string' || !e.path) {
      throw new LedgerError(`账本第 ${i + 1} 条缺少 path`);
    }
    if (!DISPOSITIONS.includes(e.disposition)) {
      throw new LedgerError(
        `账本第 ${i + 1} 条 disposition="${e.disposition}" 非法，只能是 ${DISPOSITIONS.join(' / ')}`
      );
    }
  }
  return { version: parsed.version, entries: parsed.entries.map((e) => ({ ...e })) };
}

export function saveLedger(file, ledger) {
  const sorted = {
    version: LEDGER_VERSION,
    entries: [...ledger.entries].sort((a, b) => cmp(a.path, b.path) || cmp(a.rule ?? '', b.rule ?? ''))
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  return sorted;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 日期归一化为 'YYYY-MM-DD'；非法返回 null（由调用方决定是否报错）。 */
export function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : s;
  }
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function todayStr(nowMs) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isPast(dateStr, nowMs) {
  if (!dateStr) return false;
  return dateStr < todayStr(nowMs);
}

/** 找到与 (path, rule) 匹配的条目：路径精确匹配，rule 省略视为通配。 */
export function findEntries(ledger, filePath, rule) {
  return ledger.entries.filter(
    (e) => e.path === filePath && (e.rule === undefined || e.rule === null || e.rule === rule)
  );
}

/**
 * 根据账本，把一条 finding 标记为 suppressed / resurfaced / 原样。
 * 返回 { finding, suppressed: boolean, note?: string }
 */
export function applyLedger(finding, ledger, nowMs) {
  const entries = findEntries(ledger, finding.path, finding.rule);
  if (entries.length === 0) return { finding, suppressed: false };

  // 多条同时命中时取"最宽松"的裁决，但把矛盾暴露给用户。
  const conflicts = entries.length > 1;
  let chosen = null;
  for (const e of entries) {
    if (!chosen) chosen = e;
    else if (e.disposition === 'keep') chosen = e;
    else if (e.disposition === 'snooze' && chosen.disposition !== 'keep') chosen = e;
  }

  const noteParts = [];
  if (conflicts) noteParts.push(`账本有 ${entries.length} 条匹配记录，已按 "${chosen.disposition}" 处理`);

  if (chosen.disposition === 'keep') {
    if (chosen.reviewAfter && isPast(chosen.reviewAfter, nowMs)) {
      return {
        finding: { ...finding, message: `${finding.message}（复核期 ${chosen.reviewAfter} 已到）` },
        suppressed: false,
        note: '复核到期，重新提示'
      };
    }
    return { finding, suppressed: true, note: [...noteParts, `已接受（${chosen.reason ?? '无说明'}）`].join('；') };
  }

  if (chosen.disposition === 'snooze') {
    if (!chosen.until) {
      // 没有到期时间的豁免 = 永久遗忘，这正是我们要防的事。
      return {
        finding: {
          ...finding,
          message: `${finding.message}（豁免缺少 until，已按到期处理）`
        },
        suppressed: false,
        note: 'snooze 缺少到期时间'
      };
    }
    if (isPast(chosen.until, nowMs)) {
      return {
        finding: { ...finding, message: `${finding.message}（豁免已于 ${chosen.until} 到期）` },
        suppressed: false,
        note: '豁免到期'
      };
    }
    return { finding, suppressed: true, note: [...noteParts, `豁免至 ${chosen.until}`].join('；') };
  }

  // remove：文件还在 = 问题仍在。去掉首尾空格，避免出现 "自 2026-11-06 ），" 这种别扭输出。
  const since = chosen.since ? `自 ${chosen.since} ` : '';
  return {
    finding: {
      ...finding,
      severity: 'warn',
      message: `${finding.message}（账本已判定清理，但文件仍在${since ? `，${since.trimEnd()}` : ''}）`.replace(/\s+）/g, '）'),
      suggestion: finding.suggestion ?? '执行删除，或把账本 disposition 改回 keep/snooze'
    },
    suppressed: false,
    note: 'remove 待执行'
  };
}

/**
 * 账本漂移检查：账本认为"该没了"的东西是否真的没了；条目是否已经失效可清理。
 * @returns {Array<Finding>}
 */
export function ledgerDrift(ledger, fileSet, nowMs) {
  const findings = [];

  for (const e of ledger.entries) {
    if (e.disposition === 'remove' && fileSet.has(e.path)) {
      const since = e.since ? `自 ${e.since} ` : '';
      findings.push({
        rule: 'hygiene/removal-pending',
        severity: 'warn',
        path: e.path,
        message: `账本标记为待清理（${since}），但文件仍然存在${e.reason ? `：${e.reason}` : ''}`,
        evidence: 'hygiene-baseline.json',
        suggestion: '删除该文件；若决定保留，把 disposition 改回 keep 或 snooze'
      });
    }

    if (e.disposition === 'snooze' && e.until && isPast(e.until, nowMs) && fileSet.has(e.path)) {
      findings.push({
        rule: 'hygiene/snooze-expired',
        severity: 'info',
        path: e.path,
        message: `豁免已于 ${e.until} 到期，需要重新裁决（保留则把 until 往后延）`,
        evidence: 'hygiene-baseline.json',
        suggestion: '重新评估：改为 remove、续期 snooze，或改 keep 并设置 reviewAfter'
      });
    }

    if (e.disposition === 'keep' && e.reviewAfter && isPast(e.reviewAfter, nowMs)) {
      findings.push({
        rule: 'hygiene/review-due',
        severity: 'info',
        path: e.path,
        message: `"已接受"记录的复核期 ${e.reviewAfter} 已过`,
        evidence: 'hygiene-baseline.json',
        suggestion: '确认是否仍有必要保留，必要时更新 reviewAfter'
      });
    }

    if (!fileSet.has(e.path) && e.disposition !== 'remove') {
      findings.push({
        rule: 'hygiene/ledger-stale',
        severity: 'info',
        path: e.path,
        message: '账本条目指向的路径已不存在，可删除该条目',
        evidence: 'hygiene-baseline.json',
        suggestion: '运行 aicg prune 清理已失效条目'
      });
    }
  }

  return findings;
}

/** 从一次扫描结果生成基线：只记录"当前全部 finding"，不含历史。 */
export function baselineFrom(findings, nowMs, note) {
  return {
    version: LEDGER_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    note,
    entries: findings.map((f) => ({
      path: f.path,
      rule: f.rule,
      severity: f.severity,
      disposition: 'keep',
      reviewAfter: addDays(todayStr(nowMs), 90),
      reason: '基线固化：纳入已知问题，避免新问题被淹没'
    }))
  };
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 对比基线：只保留"新增的"或"严重度变高的"，便于增量治理。
 * 基线文件可以是 ledger 格式，也可以是 scan --format json 的输出（用 findings 数组）。
 */
export function diffAgainstBaseline(findings, baseline) {
  const known = new Map();
  const entries = Array.isArray(baseline.entries)
    ? baseline.entries.map((e) => ({ path: e.path, rule: e.rule, severity: e.severity ?? 'info' }))
    : Array.isArray(baseline.findings)
      ? baseline.findings.map((f) => ({ path: f.path, rule: f.rule, severity: f.severity }))
      : [];
  for (const e of entries) known.set(`${e.path}\u0000${e.rule}`, e.severity ?? 'info');

  const rank = { info: 0, warn: 1, error: 2 };
  const fresh = [];
  for (const f of findings) {
    const prev = known.get(`${f.path}\u0000${f.rule}`);
    if (prev === undefined) fresh.push({ ...f, baseline: 'new' });
    else if ((rank[f.severity] ?? 0) > (rank[prev] ?? 0)) fresh.push({ ...f, baseline: 'worsened' });
  }
  return fresh;
}
