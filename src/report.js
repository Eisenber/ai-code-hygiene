/**
 * 渲染层：同一份 report 对象 → 三种人/机可读形态。
 * 渲染不改变语义，因此三种输出里的 finding 顺序与数量必须一致。
 */

const SEV_ORDER = ['error', 'warn', 'info'];
const SEV_LABEL = { error: '错误', warn: '警告', info: '线索' };

function makeColors(enabled) {
  const wrap = (code) => (s) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
  return {
    red: wrap('31'),
    yellow: wrap('33'),
    blue: wrap('36'),
    gray: wrap('90'),
    bold: wrap('1')
  };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderText(report, opts = {}) {
  const c = makeColors(opts.color ?? false);
  const lines = [];
  const sevCount = SEV_ORDER.map((s) => `${s === 'error' ? c.red('错误') : s === 'warn' ? c.yellow('警告') : c.blue('线索')} ${report.stats.bySeverity[s] ?? 0}`).join(c.gray(' · '));
  // 只渲染当前展示出来的 findings：按严重度过滤后，标题里的分组计数也必须跟着变
  const shown = report.findings;

  lines.push(`${c.bold('ai-code-hygiene')} v${report.version}  ${c.gray(new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 19))}`);
  lines.push(`root  ${report.root}`);
  lines.push(
    `扫描  ${report.stats.files} 个文件 / ${formatBytes(report.stats.scannedBytes)}  ${c.gray('·')}  ${sevCount}`
  );
  if (report.stats.suppressed) {
    lines.push(c.gray(`另有 ${report.stats.suppressed} 条已由账本处置（keep/snooze），未计入上方统计`));
  }
  lines.push(`时间证据  ${report.git ? 'git commit 时间' : c.yellow('mtime（仓库无 git，时间判断精度较低）')}`);
  lines.push('');

  if (shown.length === 0) {
    lines.push(`没有发现问题。${report.stats.suppressed ? '（现有问题已全部登记在账本中）' : ''}`);
    return lines.join('\n');
  }

  for (const severity of SEV_ORDER) {
    const group = shown.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const tag =
      severity === 'error' ? c.red('ERROR') : severity === 'warn' ? c.yellow('WARN') : c.blue('INFO');
    lines.push(`${tag} ${c.gray(`(${group.length})`)}`);

    let lastRule = null;
    for (const f of group) {
      if (f.rule !== lastRule) {
        lines.push(`  ${c.gray(`── ${f.rule} ────────────────────────────`)}`);
        lastRule = f.rule;
      }
      const loc = f.line ? `${f.path}:${f.line}` : f.path;
      lines.push(`  ${c.bold(loc)}`);
      lines.push(`    ${f.message}`);
      if (f.evidence) lines.push(`    ${c.gray(`证据：${f.evidence}`)}`);
      if (f.note) lines.push(`    ${c.gray(`账本：${f.note}`)}`);
      if (f.suggestion) lines.push(`    ${c.gray(`建议：${f.suggestion}`)}`);
    }
    lines.push('');
  }

  const ruleSummary = Object.entries(report.stats.byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => `${rule}=${n}`)
    .join('  ');
  if (ruleSummary) lines.push(c.gray(`按规则：${ruleSummary}`));

  if (report.errors?.length) {
    lines.push('');
    lines.push(c.yellow(`有 ${report.errors.length} 个文件读取失败（结果可能不完整）：`));
    for (const e of report.errors.slice(0, 10)) lines.push(`  ${e.path}  ${c.gray(e.error)}`);
  }

  lines.push('');
  lines.push(c.gray('处理方式：'));
  lines.push(c.gray('  确认可以删  → 直接删除文件（工具不会替你删）'));
  lines.push(c.gray('  暂不处理    → aicg ack --path <路径> --rule <规则> --until YYYY-MM-DD --reason "原因"'));
  lines.push(c.gray('  明确接受    → aicg ack --path <路径> --disposition keep --reason "原因"'));
  lines.push(c.gray('  决定要删    → aicg ack --path <路径> --disposition remove（下次扫描会检查是否真删了）'));
  return lines.join('\n');
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# AI 产物清退报告`);
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 扫描根目录：\`${report.root}\``);
  lines.push(`- 文件数：${report.stats.files}`);
  lines.push(`- 时间证据：${report.git ? 'git commit 时间' : 'mtime（无 git，精度较低）'}`);
  lines.push(
    `- 统计：错误 ${report.stats.bySeverity.error ?? 0} / 警告 ${report.stats.bySeverity.warn ?? 0} / 线索 ${report.stats.bySeverity.info ?? 0}` +
      (report.stats.suppressed ? ` / 已压制 ${report.stats.suppressed}` : '')
  );
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('没有发现问题。');
    return lines.join('\n');
  }

  for (const severity of SEV_ORDER) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${SEV_LABEL[severity]}（${group.length}）`);
    lines.push('');
    lines.push('| 位置 | 规则 | 说明 | 证据 | 建议 |');
    lines.push('|---|---|---|---|---|');
    for (const f of group) {
      const loc = f.line ? `\`${f.path}:${f.line}\`` : `\`${f.path}\``;
      const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${loc} | ${f.rule} | ${cell(f.message)} | ${cell(f.evidence)} | ${cell(f.suggestion)} |`);
    }
    lines.push('');
  }

  lines.push('## 按规则统计');
  lines.push('');
  for (const [rule, n] of Object.entries(report.stats.byRule).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${rule}\`：${n}`);
  }
  return lines.join('\n');
}

export function renderJson(report) {
  return JSON.stringify(report, null, 2);
}

export function render(report, format, opts = {}) {
  switch (format) {
    case 'json':
      return renderJson(report);
    case 'markdown':
    case 'md':
      return renderMarkdown(report);
    case 'text':
    case undefined:
    case null:
      return renderText(report, opts);
    default:
      throw new Error(`未知输出格式 "${format}"，可选：text / json / markdown`);
  }
}
