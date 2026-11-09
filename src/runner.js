/**
 * 编排层：发现 → 索引 → 规则 → 账本 → 输出。
 *
 * 这里只做流程与归一化，不含任何判定逻辑；规则永远是纯函数。
 */

import path from 'node:path';
import fs from 'node:fs';

import { mergeConfig, DEFAULT_CONFIG } from './config.js';
import { walk, isFixturePath } from './walk.js';
import { buildIndex, detectGit } from './indexer.js';
import { buildReferenceGraph } from './refs.js';
import { enabledRules } from './rules/index.js';
import {
  applyLedger,
  ledgerDrift,
  emptyLedger
} from './ledger.js';

export const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };
export const SEVERITIES = ['error', 'warn', 'info'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 归一化一条 finding：补齐字段、校验必需项，错误信息带规则名便于定位。 */
function normalizeFinding(raw, ruleId, fallbackSeverity) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`规则 ${ruleId} 返回了非对象 finding`);
  }
  if (typeof raw.path !== 'string' || !raw.path) {
    throw new Error(`规则 ${ruleId} 返回的 finding 缺少 path`);
  }
  if (typeof raw.message !== 'string' || !raw.message) {
    throw new Error(`规则 ${ruleId} 返回的 finding 缺少 message（path=${raw.path}）`);
  }
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : (fallbackSeverity ?? 'warn');
  return {
    rule: raw.rule ?? ruleId,
    severity,
    path: raw.path.replace(/\\/g, '/'),
    line: Number.isInteger(raw.line) && raw.line > 0 ? raw.line : undefined,
    message: raw.message,
    evidence: raw.evidence,
    suggestion: raw.suggestion,
    duplicates: raw.duplicates,
    source: 'rule'
  };
}

function findingKey(f) {
  return `${f.rule}\u0000${f.path}\u0000${f.line ?? ''}\u0000${f.message}`;
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const sev = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sev !== 0) return sev;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
  });
}

/**
 * 执行一次扫描。不做 IO 输出，只返回结果对象，方便复用与测试。
 *
 * @param {object} opts
 * @param {string} opts.root   仓库根（相对或绝对，内部会 resolve）
 * @param {object} [opts.config] 用户配置覆盖
 * @param {object} [opts.ledger] 账本对象（默认空账本）
 * @param {number} [opts.now]  注入时钟，便于自检 fixture 稳定
 * @param {boolean} [opts.useGit] 覆盖 git 探测
 * @param {(rootDir:string, rel:string)=>number|null} [opts.readGitTime] 注入 git 时间读取器
 * @param {boolean} [opts.includeSuppressed] 额外返回未应用账本的原始 findings
 */
export function scan(opts) {
  const rootDir = path.resolve(opts.root ?? '.');
  const config = mergeConfig(DEFAULT_CONFIG, opts.config ?? {});
  const ledger = opts.ledger ?? emptyLedger();
  const now = opts.now ?? Date.now();
  const includeSuppressed = opts.includeSuppressed ?? false;

  const { files, unreadable } = walk(rootDir, config);
  /**
   * 若 --root 自己就是一个夹具目录（如 test/samples/messy），说明用户是显式要扫它，
   * 此时不能再按"夹具"跳过它的内容，否则规则会集体失效。
   */
  const rootIsFixture = (config.fixtureDirs ?? []).includes(path.basename(rootDir));
  const useGit = opts.useGit ?? detectGit(rootDir);
  const index = buildIndex(rootDir, files, { now, useGit, readGitTime: opts.readGitTime });
  const graph = buildReferenceGraph(index);

  const context = {
    config,
    files,
    readText: index.readText,
    fileSet: index.fileSet,
    symbolIndex: index.symbolIndex,
    symbols: index.symbols,
    times: index.times,
    precision: index.precision,
    /** 该路径是否位于夹具目录：规则应整体跳过这类文件（root 自己就是夹具时除外）。 */
    isFixture: (rel) => !rootIsFixture && isFixturePath(rel, config.fixtureDirs),
    dupKeys: index.dupKeys,
    graph,
    now,
    index
  };
  const raw = [];
  for (const { rule, cfg } of enabledRules(config)) {
    let produced;
    try {
      produced = rule.run(context);
    } catch (err) {
      throw new Error(`规则 ${rule.id} 执行失败：${err.message}`);
    }
    if (!Array.isArray(produced)) throw new Error(`规则 ${rule.id} 必须返回数组`);
    for (const f of produced) {
      // 配置里的 severity 是该规则的"上限级"：规则可自行降级（例如启发式部分）。
      const configured = cfg?.severity;
      const normalized = normalizeFinding(f, rule.id, rule.defaultSeverity);
      if (configured && SEVERITY_RANK[configured] < SEVERITY_RANK[normalized.severity]) {
        normalized.severity = configured;
      }
      raw.push(normalized);
    }
  }

  // 去重：同一规则在同一位置对同一件事只报一次。
  const seen = new Set();
  const deduped = [];
  for (const f of raw) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  // 账本：既有 finding 可能被"已接受/豁免/待清理"覆盖；账本自身也会漂移。
  const findings = [];
  const suppressed = [];
  for (const f of deduped) {
    const { finding, suppressed: isSuppressed, note } = applyLedger(f, ledger, now);
    if (isSuppressed) {
      suppressed.push({ ...finding, note });
      continue;
    }
    findings.push(note ? { ...finding, note } : finding);
  }

  for (const drift of ledgerDrift(ledger, index.fileSet, now)) {
    findings.push({ ...drift, source: 'ledger' });
  }

  /**
   * 同一路径同时出现"待执行漂移（removal-pending）"和"原规则的待执行提示"时只留前者：
   * 信息完全重复，多一条只会让报告更难读。
   */
  const pendingPaths = new Set(
    findings.filter((f) => f.rule === 'hygiene/removal-pending').map((f) => f.path)
  );
  for (let i = findings.length - 1; i >= 0; i -= 1) {
    const f = findings[i];
    if (f.source === 'rule' && pendingPaths.has(f.path) && f.note === 'remove 待执行') {
      findings.splice(i, 1);
    }
  }

  const sorted = sortFindings(findings);
  const bySeverity = { error: 0, warn: 0, info: 0 };
  const byRule = {};
  for (const f of sorted) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }

  return {
    report: {
      tool: 'aicg',
      version: opts.version ?? '0.0.0',
      generatedAt: new Date(now).toISOString(),
      root: rootDir,
      git: useGit,
      stats: {
        files: files.length,
        scannedBytes: files.reduce((sum, f) => sum + f.size, 0),
        bySeverity,
        byRule,
        suppressed: suppressed.length
      },
      findings: sorted,
      suppressed,
      // 未经账本过滤的原始结果：供 ack 这类"需要在压制项里查找"的命令使用。
      ...(includeSuppressed ? { rawFindings: sortFindings(deduped) } : {}),
      errors: [...unreadable, ...index.readErrors]
    },
    index,
    config,
    ledger
  };
}

/** 供 stale-date 之类规则复用的常量导出，避免各规则各写一份。 */
export { MS_PER_DAY };

/** 逐条应用账本之后仍未消解的数量（用于 CLI 摘要）。 */
export function countActionable(findings, minSeverity = 'info') {
  const floor = SEVERITY_RANK[minSeverity] ?? 0;
  return findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= floor).length;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
