/**
 * 规则注册表。顺序即报告顺序；enabled=false 的规则不会被实例化。
 * 加一条规则只需：新建 rules/xxx.js + 在这里登记 + 在 config.js 给默认值。
 */

import temporaryArtifacts from './temporary-artifacts.js';
import aiArtifact from './ai-artifact.js';
import orphanDoc from './orphan-doc.js';
import duplicateContent from './duplicate-content.js';
import brokenReference from './broken-reference.js';
import staleDate from './stale-date.js';
import staleVsCode from './stale-vs-code.js';

export const ALL_RULES = [
  temporaryArtifacts,
  aiArtifact,
  orphanDoc,
  duplicateContent,
  brokenReference,
  staleDate,
  staleVsCode
];

export function enabledRules(config) {
  const out = [];
  for (const rule of ALL_RULES) {
    const cfg = config.rules?.[rule.id];
    if (cfg === undefined) {
      out.push({ rule, cfg: {} });
      continue;
    }
    if (cfg === false || cfg.enabled === false) continue;
    out.push({ rule, cfg });
  }
  return out;
}
