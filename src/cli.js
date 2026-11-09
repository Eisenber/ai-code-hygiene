/**
 * 命令实现（可测试）：接收 argv，返回退出码，不直接读写 process。
 *
 * bin/aicg.js 只负责把结果接上 process.exitCode；
 * 需要校验命令行为时直接 import 这里，不必起子进程。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { mergeConfig, DEFAULT_CONFIG } from './config.js';
import { scan, SEVERITY_RANK, writeJson } from './runner.js';
import { render } from './report.js';
import {
  loadLedger,
  saveLedger,
  emptyLedger,
  baselineFrom,
  diffAgainstBaseline,
  normalizeDate,
  addDays,
  LedgerError,
  DISPOSITIONS
} from './ledger.js';
import { ALL_RULES } from './rules/index.js';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function helpText(version) {
  return `ai-code-hygiene v${version} — 清理 AI 写完后遗留的冗余代码与文档

用法：
  aicg <command> [options]

命令：
  scan       扫描并输出报告（默认命令）
  baseline   把当前问题固化为账本条目（keep，90 天后复核）
  ack        人工裁决某条问题：keep / snooze / remove
  prune      清理账本中已失效的条目
  rules      列出规则与当前生效配置
  help       显示本帮助

scan 选项：
  -r, --root <dir>        扫描根目录（默认 .）
  -c, --config <file>     配置文件（默认自动查找 ai-hygiene.config.json）
  -f, --format <fmt>      text | json | markdown（默认 text）
  -o, --out <file>        同时把结果写入文件
  -s, --severity <min>    只显示 >= 该级别：error | warn | info
  -b, --baseline <file>   与基线对比，只报告新增/变严重的问题
      --fail-on <level>   退出码 1 的阈值：none | error | warn | info | any（默认 error）
      --ledger <file>     账本路径（默认 hygiene-baseline.json）
      --no-git            不读取 git 历史，一律用 mtime
      --now <iso>         注入当前时间（仅用于复现与自检）
      --no-color          禁用颜色

ack 选项：
      --path <rel>        必填，仓库相对路径
      --rule <id>         可选，只裁决这一条规则
      --disposition <d>   keep | snooze | remove（默认 snooze）
      --until <YYYY-MM-DD> snooze 的到期日
      --review-after <date> keep 的复核日
      --reason <text>     必填，为什么这么裁决
      --ledger <file>     账本路径

退出码：0 无达到阈值的问题；1 有问题；2 运行错误。
`;
}

function makeIO(io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  return {
    out: (s) => stdout.write(s),
    log: (s) => stderr.write(`${s}\n`),
    // 让 "是否输出颜色" 在测试里可控
    color: io.color ?? Boolean(stdout.isTTY)
  };
}

function readConfigFile(explicit, baseDir = process.cwd()) {
  const candidates = explicit ? [explicit] : ['ai-hygiene.config.json', '.ai-hygiene.json'];
  for (const c of candidates) {
    const abs = path.isAbsolute(c) ? c : path.resolve(baseDir, c);
    if (!fs.existsSync(abs)) {
      if (explicit) throw new UsageError(`配置文件不存在：${c}`);
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      throw new UsageError(`配置文件不是合法 JSON（${c}）：${err.message}`);
    }
  }
  return {};
}

function parseNow(value) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new UsageError(`--now 不是合法时间：${value}`);
  return t;
}

function resolveFailOn(value) {
  if (value === undefined) return 'error';
  if (value === 'none') return 'none';
  if (value === 'any') return 'info';
  if (!(value in SEVERITY_RANK)) {
    throw new UsageError(`--fail-on 只能是 none|error|warn|info|any，收到 ${value}`);
  }
  return value;
}

function filterBySeverity(findings, minSeverity) {
  if (!minSeverity) return findings;
  if (!(minSeverity in SEVERITY_RANK)) {
    throw new UsageError(`--severity 只能是 error|warn|info，收到 ${minSeverity}`);
  }
  const floor = SEVERITY_RANK[minSeverity];
  return findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= floor);
}

/** 各子命令共用的"真正做一次扫描"逻辑。 */
export function runScan(values, extra = {}, version = '0.0.0', cwd = process.cwd()) {
  const now = values.now ? parseNow(values.now) : Date.now();
  const resolve = (p) => path.resolve(cwd, p);
  const scanRoot = resolve(values.root ?? '.');
  // 配置属于"被扫描的仓库"，不是"调用者的 cwd"：同一份 repo 无论从哪调用结果都应一致。
  const config = mergeConfig(DEFAULT_CONFIG, readConfigFile(values.config, scanRoot));

  let ledger = emptyLedger();
  if (extra.emptyLedger) {
    ledger = emptyLedger();
  } else if (values.ledger) {
    ledger = loadLedger(resolve(values.ledger));
  } else if (!values['no-ledger']) {
    const auto = resolve('hygiene-baseline.json');
    if (fs.existsSync(auto)) ledger = loadLedger(auto);
  }

  const { report } = scan({
    root: scanRoot,
    config,
    ledger,
    now,
    useGit: values['no-git'] ? false : undefined,
    version,
    includeSuppressed: extra.includeSuppressed ?? false
  });
  return { report, ledger, now };
}

function cmdScan(values, io, version, cwd) {
  const resolve = (p) => path.resolve(cwd, p);
  const { report } = runScan(values, {}, version, cwd);
  const failOn = resolveFailOn(values['fail-on']);

  let findings = report.findings;

  if (values.baseline) {
    const file = resolve(values.baseline);
    if (!fs.existsSync(file)) throw new UsageError(`基线文件不存在：${values.baseline}`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new UsageError(`基线不是合法 JSON：${err.message}`);
    }
    findings = diffAgainstBaseline(findings, parsed);
  }

  findings = filterBySeverity(findings, values.severity);

  const filtered = {
    ...report,
    findings,
    stats: {
      ...report.stats,
      bySeverity: {
        error: findings.filter((f) => f.severity === 'error').length,
        warn: findings.filter((f) => f.severity === 'warn').length,
        info: findings.filter((f) => f.severity === 'info').length
      },
      byRule: findings.reduce((acc, f) => {
        acc[f.rule] = (acc[f.rule] ?? 0) + 1;
        return acc;
      }, {})
    }
  };
  delete filtered.rawFindings;

  const format = values.format ?? 'text';
  const output = render(filtered, format, { color: !values['no-color'] && io.color });
  io.out(`${output}\n`);

  if (values.out) {
    const dest = resolve(values.out);
    const looksJson = dest.toLowerCase().endsWith('.json') && format === 'text';
    if (looksJson) writeJson(dest, filtered);
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `${output}\n`, 'utf8');
    }
    io.log(`报告已写入 ${dest}`);
  }

  if (failOn === 'none') return 0;
  const floor = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.error;
  const failing = findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= floor).length;
  return failing > 0 ? 1 : 0;
}

function cmdBaseline(values, io, version, cwd) {
  const resolve = (p) => path.resolve(cwd, p);
  const dest = resolve(values.out ?? values.ledger ?? 'hygiene-baseline.json');

  if (values.from) {
    const file = resolve(values.from);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new UsageError(`无法读取 --from 指定的报告：${err.message}`);
    }
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const now = Date.parse(parsed.generatedAt ?? '') || Date.now();
    const ledger = baselineFrom(findings, now, `来自 ${values.from}`);
    saveLedger(dest, ledger);
    io.log(`已从报告固化 ${ledger.entries.length} 条到 ${dest}`);
    return 0;
  }

  const { report, now } = runScan(values, {}, version, cwd);
  const ledger = baselineFrom(report.findings, now, '首次基线：把已知问题一次性登记，之后只关注新增');
  saveLedger(dest, ledger);
  io.log(`已固化 ${ledger.entries.length} 条已知问题到 ${dest}（${report.stats.files} 个文件）`);
  io.log('之后请用：aicg scan --baseline hygiene-baseline.json 只看新增问题');
  return 0;
}

function cmdAck(values, io, version, cwd) {
  const resolve = (p) => path.resolve(cwd, p);
  if (!values.path) throw new UsageError('ack 需要 --path');
  if (!values.reason) {
    throw new UsageError('ack 需要 --reason：说明为什么保留或延期，这是账本的价值所在');
  }

  const disposition = values.disposition ?? 'snooze';
  if (!DISPOSITIONS.includes(disposition)) {
    throw new UsageError(`--disposition 只能是 ${DISPOSITIONS.join(' | ')}，收到 ${disposition}`);
  }

  // 在"未应用账本"的结果里找：已固化的基线问题同样需要能被重新裁决。
  const { report } = runScan(values, { includeSuppressed: true, emptyLedger: true }, version, cwd);
  const target = values.path.replace(/\\/g, '/');

  const pool = new Map();
  for (const f of [...(report.rawFindings ?? []), ...(report.findings ?? [])]) {
    pool.set(`${f.rule}\u0000${f.path}\u0000${f.line ?? ''}`, f);
  }
  const atPath = [...pool.values()].filter((f) => f.path === target);
  const matches = atPath.filter((f) => !values.rule || f.rule === values.rule);

  if (matches.length === 0) {
    const hint = atPath.length > 0
      ? `该路径有问题，但不是 --rule 指定的规则；可选：${[...new Set(atPath.map((f) => f.rule))].join(', ')}`
      : '该路径当前没有可裁决的问题；路径是仓库相对路径吗？';
    throw new UsageError(`没有找到 ${target} 的待裁决问题。${hint}`);
  }
  if (matches.length > 1 && !values.rule) {
    const rules = [...new Set(matches.map((f) => f.rule))].join(', ');
    throw new UsageError(`该路径有 ${matches.length} 条不同规则的问题，请用 --rule 指定其一：${rules}`);
  }

  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const ledgerFile = resolve(values.ledger ?? 'hygiene-baseline.json');
  const ledger = loadLedger(ledgerFile);

  const entry = {
    path: target,
    rule: values.rule ?? matches[0].rule,
    disposition,
    since: today,
    reason: values.reason
  };

  if (disposition === 'snooze') {
    if (values.until && !normalizeDate(values.until)) {
      throw new UsageError(`--until 不是合法日期：${values.until}`);
    }
    const until = normalizeDate(values.until) ?? addDays(today, 30);
    entry.until = until;
    if (!values.until) entry.reason = `${values.reason}（默认 30 天，可用 --until 调整）`;
    io.log(`豁免至 ${until}`);
  }
  if (disposition === 'keep') {
    if (values['review-after'] && !normalizeDate(values['review-after'])) {
      throw new UsageError(`--review-after 不是合法日期：${values['review-after']}`);
    }
    entry.reviewAfter = normalizeDate(values['review-after']) ?? addDays(today, 90);
  }

  ledger.entries = ledger.entries.filter((e) => !(e.path === entry.path && e.rule === entry.rule));
  ledger.entries.push(entry);
  saveLedger(ledgerFile, ledger);
  io.log(`已记录：${target} → ${disposition}（${ledgerFile}）`);
  return 0;
}

function cmdPrune(values, io, version, cwd) {
  const resolve = (p) => path.resolve(cwd, p);
  const ledgerFile = resolve(values.ledger ?? 'hygiene-baseline.json');
  const ledger = loadLedger(ledgerFile);
  const scanRoot = resolve(values.root ?? '.');
  const { index } = scan({
    root: scanRoot,
    config: mergeConfig(DEFAULT_CONFIG, readConfigFile(values.config, scanRoot)),
    now: Date.now(),
    useGit: false,
    version
  });
  const before = ledger.entries.length;
  const dropped = [];
  const today = new Date().toISOString().slice(0, 10);
  ledger.entries = ledger.entries.filter((e) => {
    const gone = !index.fileSet.has(e.path);
    // 文件已不存在 → 条目已完成使命（包括"待清理"条目：删掉后它就没有存在意义了）
    if (gone) {
      dropped.push(e);
      return false;
    }
    // 豁免已过期而文件仍在：该条已不产生任何效果，留着只会遮蔽下一次报告
    if (e.disposition === 'snooze' && e.until && e.until < today) {
      dropped.push(e);
      return false;
    }
    return true;
  });
  saveLedger(ledgerFile, ledger);
  io.log(`账本 ${before} 条 → ${ledger.entries.length} 条（清理 ${dropped.length} 条失效条目）`);
  for (const e of dropped.slice(0, 20)) io.log(`  - ${e.path}（${e.disposition}）`);
  return 0;
}

function cmdRules(values, io, version, cwd) {
  const resolve = (p) => path.resolve(cwd, p);
  const scanRoot = resolve(values.root ?? '.');
  // 配置属于"被扫描的仓库"，不是"调用者的 cwd"：同一份 repo 无论从哪调用结果都应一致。
  const config = mergeConfig(DEFAULT_CONFIG, readConfigFile(values.config, scanRoot));
  const rows = ALL_RULES.map((r) => {
    const cfg = config.rules[r.id];
    const enabled = cfg === false || cfg?.enabled === false ? '关闭' : '启用';
    const severity = cfg?.severity ?? r.defaultSeverity;
    return { id: r.id, enabled, severity, description: r.description };
  });
  const width = Math.max(...rows.map((r) => r.id.length)) + 2;
  for (const r of rows) {
    io.out(`${r.id.padEnd(width)} ${r.enabled}  ${r.severity.padEnd(6)} ${r.description}\n`);
  }
  return 0;
}

const OPTIONS = {
  root: { type: 'string', short: 'r' },
  config: { type: 'string', short: 'c' },
  format: { type: 'string', short: 'f' },
  out: { type: 'string', short: 'o' },
  severity: { type: 'string', short: 's' },
  baseline: { type: 'string', short: 'b' },
  ledger: { type: 'string' },
  'fail-on': { type: 'string' },
  'no-git': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  'no-ledger': { type: 'boolean' },
  now: { type: 'string' },
  path: { type: 'string' },
  rule: { type: 'string' },
  disposition: { type: 'string' },
  until: { type: 'string' },
  'review-after': { type: 'string' },
  reason: { type: 'string' },
  from: { type: 'string' },
  help: { type: 'boolean', short: 'h' }
};

const COMMANDS = {
  scan: cmdScan,
  baseline: cmdBaseline,
  ack: cmdAck,
  prune: cmdPrune,
  rules: cmdRules
};

/**
 * 执行一条命令，返回退出码（不抛异常）。
 * @param {string[]} argv 不含 node 与脚本名
 */
export function run(argv, opts = {}) {
  const io = makeIO(opts.io);
  const version = opts.version ?? '0.0.0';
  const cwd = opts.cwd ?? process.cwd();

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS }));
  } catch (err) {
    io.log(`参数错误：${err.message}`);
    io.log('运行 aicg help 查看用法。');
    return 2;
  }

  const command = positionals[0] ?? 'scan';
  if (values.help || command === 'help') {
    io.out(helpText(version));
    return 0;
  }

  const impl = COMMANDS[command];
  if (!impl) {
    io.log(`用法错误：未知命令 "${command}"。可用：scan / baseline / ack / prune / rules / help`);
    return 2;
  }

  try {
    return impl(values, io, version, cwd);
  } catch (err) {
    if (err instanceof UsageError) {
      io.log(`用法错误：${err.message}`);
      io.log('运行 aicg help 查看用法。');
      return 2;
    }
    if (err instanceof LedgerError) {
      io.log(`账本错误：${err.message}`);
      return 2;
    }
    io.log(`运行失败：${err.stack ?? err.message}`);
    return 2;
  }
}
