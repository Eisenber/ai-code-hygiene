/**
 * 自检：node test/all.js（或 test/scan.test.js 单跑）
 *
 * 这里验证的不是"代码能跑"，而是三件更容易腐坏的事：
 *   1. 样例仓库里每类问题都被命中，且没有命中不该命中的东西（精确率）
 *   2. 账本三种 disposition 的语义（压制、到期复报、待执行漂移）
 *   3. 有 git 时时间证据真的来自 commit 而不是 mtime
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scan } from '../src/runner.js';
import { loadLedger, saveLedger, emptyLedger, addDays, normalizeDate } from '../src/ledger.js';
import { detectGit } from '../src/indexer.js';
import { extractDates } from '../src/rules/stale-date.js';
import { extractReferences, maskFencedBlocks } from '../src/refs.js';
import { globToRegExp, matchesAny } from '../src/walk.js';
import { createSandboxFactory } from './helpers/sandbox.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'samples', 'messy');
const NOW = Date.parse('2026-11-06T12:00:00Z');
/** 所有临时仓库都建在同一根下，测试结束统一清理。 */
const sandboxIn = createSandboxFactory(after);

/**
 * 能否真的起 git 子进程并读回输出。
 * 受限沙箱会拦掉管道（EPERM），此时端到端用例应跳过而非失败：
 * 语义部分已由注入假读取器的用例覆盖。
 */
const GIT_USABLE = (() => {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
})();

function scanSample(extra = {}) {
  return scan({ root: SAMPLE, now: NOW, useGit: false, ...extra });
}

function rulesOf(report) {
  return new Set(report.findings.map((f) => f.rule));
}

test('样例：六类问题都能被命中', () => {
  const { report } = scanSample();
  const rules = rulesOf(report);
  for (const rule of [
    'hygiene/broken-reference',
    'hygiene/orphan-doc',
    'hygiene/duplicate-content',
    'hygiene/temp-file',
    'hygiene/stale-date',
    'hygiene/ai-artifact'
  ]) {
    assert.ok(rules.has(rule), `缺少规则命中：${rule}`);
  }
});

test('样例：重复内容合并成一条，并列出全部副本', () => {
  const { report } = scanSample();
  const dups = report.findings.filter((f) => f.rule === 'hygiene/duplicate-content');
  assert.equal(dups.length, 1, '三份相同内容应合并为一条 finding');
  const all = [dups[0].path, ...dups[0].duplicates].sort();
  assert.deepEqual(all, [
    'archive/design-v2.md',
    'docs/design-v2.md',
    'notes/design-v2-copy.md'
  ]);
});

test('样例：根相对路径引用不再误报（src/api.js 存在）', () => {
  const { report } = scanSample();
  const broken = report.findings.filter((f) => f.rule === 'hygiene/broken-reference');
  assert.ok(
    !broken.some((f) => f.message.includes('src/api.js')),
    '`src/api.js` 按仓库根解析存在，不应报断链'
  );
  assert.ok(broken.some((f) => f.path === 'README.md' && f.message.includes('docs/setup-old.md')));
  assert.ok(broken.some((f) => f.path === 'docs/api.md' && f.message.includes('src/legacy/post.js')));
  assert.ok(
    broken.some((f) => f.path === 'README.md' && f.message.includes('/docs/install.md')),
    '根相对路径（以 / 开头）应解析为仓库根'
  );
});

test('样例：只有"明确指向文件"的引用缺失才是 error', () => {
  const { report } = scanSample();
  const broken = report.findings.filter((f) => f.rule === 'hygiene/broken-reference');
  const link = broken.find((f) => f.message.includes('docs/setup-old.md'));
  const rootRef = broken.find((f) => f.message.includes('/docs/install.md'));
  const code = broken.find((f) => f.message.includes('src/legacy/post.js'));
  assert.equal(link.severity, 'error', 'markdown 链接点不开就是坏的');
  assert.equal(rootRef.severity, 'error', '以 / 开头的写法明确指向仓库根，应算链接');
  assert.equal(code.severity, 'info', '反引号里的相对路径可能只是说明，不该判 error');
});

test('样例：围栏代码块里的"路径"不算引用', () => {
  const text = ['示例：', '```bash', 'node src/not-exist.js --flag', '```', '真实引用 `docs/api.md`。'].join('\n');
  const { paths } = extractReferences('x.md', text);
  assert.ok(!paths.some((p) => p.raw.includes('src/not-exist.js')), '围栏内路径应被忽略');
  assert.ok(paths.some((p) => p.raw === 'docs/api.md'), '围栏外引用仍要抽取');
  assert.equal(maskFencedBlocks(text).split('\n').length, text.split('\n').length, '行号不能变');
});

test('样例：设计文档里"待实现"的符号不报断链', () => {
  const { report } = scanSample();
  const broken = report.findings.filter((f) => f.rule === 'hygiene/broken-reference');
  assert.ok(!broken.some((f) => f.message.includes('fetchUserV2')), '待实现符号不应算断链');
  assert.ok(!broken.some((f) => f.message.includes('fetchUserV3')), '待迁移符号不应算断链');
});

test('样例：临时产物命中且证据带真实大小', () => {
  const { report } = scanSample();
  const temps = report.findings.filter((f) => f.rule === 'hygiene/temp-file');
  const paths = temps.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'notes.tmp',
    'notes/design-v2-copy.md',
    'scratch-check.js',
    'src/api-old.js',
    'src/api.js.bak'
  ]);
  assert.ok(temps.every((f) => /^\d+ B$|^\d+ KB$/.test(f.evidence.split('，')[0])), '证据应带可读大小');
});

test('样例：过期计划日期被报出，未来计划不报', () => {
  const { report } = scanSample();
  const stale = report.findings.filter((f) => f.rule === 'hygiene/stale-date');
  assert.ok(stale.some((f) => f.path === 'docs/plan.md' && f.message.includes('2025-06')));
  assert.ok(!stale.some((f) => f.message.includes('2026-12')), '未到期的计划不应报');
});

test('输出顺序稳定：按严重度、路径、行号排序', () => {
  const a = scanSample().report.findings.map((f) => `${f.severity}|${f.path}|${f.line ?? 0}`);
  const b = scanSample().report.findings.map((f) => `${f.severity}|${f.path}|${f.line ?? 0}`);
  assert.deepEqual(a, b, '同一输入两次扫描的排序必须一致');
  const rank = { error: 3, warn: 2, info: 1 };
  for (let i = 1; i < a.length; i += 1) {
    const [prevSev] = a[i - 1].split('|');
    const [curSev] = a[i].split('|');
    assert.ok(rank[prevSev] >= rank[curSev], '严重度必须降序');
  }
});

test('符号检查：只在"看起来像代码引用"时触发', (t) => {
  const dir = sandboxIn(t, 'symbol');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), [
    'export function fetchUser(id) { return id; }',
    'export function updateProfile(id) { return id; }'
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), [
    '# 接口说明',
    '',
    '实现见 `src/api.js`。',
    '',
    '- 调用 `fetchUser(id)` 获取用户',
    '- 调用 `deleteUser(id)` 删除用户（该函数已不存在）',
    '- 严重级别有 `error`、`warn` 两种',
    '- 函数 `updateProfile` 负责更新'
  ].join('\n'));

  const { report } = scan({ root: dir, now: NOW, useGit: false });
  const missing = report.findings
    .filter((f) => f.rule === 'hygiene/broken-reference')
    .map((f) => f.message);

  assert.ok(missing.some((m) => m.includes('deleteUser')), '函数调用形态且不存在 → 应报');
  assert.ok(!missing.some((m) => m.includes('fetchUser')), '已存在的函数不应报');
  assert.ok(!missing.some((m) => m.includes('updateProfile')), '已存在的函数不应报');
  assert.ok(!missing.some((m) => m.includes('`error`') || m.includes('：error')), '术语 `error` 不应当成代码符号');
});

test('默认忽略 fixtures 目录：样板数据不该被当成待治理对象', (t) => {
  const dir = sandboxIn(t, 'ignore');
  fs.mkdirSync(path.join(dir, 'test', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'a.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'b.tmp'), 'x');
  const { report } = scan({ root: dir, now: NOW, useGit: false });
  assert.equal(report.stats.files, 0, 'fixtures 下的文件应被忽略');
  assert.equal(report.findings.length, 0);
});

test('账本：snooze 未到期时压制，到期后复报', () => {
  const first = scanSample().report.findings.find(
    (f) => f.path === 'docs/plan.md' && f.rule === 'hygiene/stale-date'
  );
  assert.ok(first, '前置：样例里应有 plan.md 的过期日期');

  const ledger = emptyLedger();
  ledger.entries.push({
    path: 'docs/plan.md',
    rule: 'hygiene/stale-date',
    disposition: 'snooze',
    until: '2026-12-31',
    reason: '测试'
  });

  const alive = scanSample({ ledger }).report;
  assert.ok(!alive.findings.some((f) => f.path === 'docs/plan.md' && f.rule === 'hygiene/stale-date'));
  assert.ok(alive.suppressed.some((f) => f.path === 'docs/plan.md'));

  ledger.entries[0].until = '2026-01-01';
  const expired = scanSample({ ledger }).report;
  assert.ok(
    expired.findings.some((f) => f.path === 'docs/plan.md' && f.message.includes('豁免已于 2026-01-01 到期')),
    '到期后应带着到期信息重新出现'
  );
});

test('账本：keep 压制，reviewAfter 到期后提示复核', () => {
  const ledger = emptyLedger();
  ledger.entries.push({
    path: 'notes.tmp',
    rule: 'hygiene/temp-file',
    disposition: 'keep',
    reviewAfter: '2027-01-01',
    reason: '测试'
  });
  assert.ok(!scanSample({ ledger }).report.findings.some((f) => f.path === 'notes.tmp'));

  ledger.entries[0].reviewAfter = '2026-01-01';
  const report = scanSample({ ledger }).report;
  assert.ok(
    report.findings.some((f) => f.path === 'notes.tmp' && f.message.includes('复核期 2026-01-01 已到'))
  );
});

test('账本：remove 但文件仍在 → 报"待执行"漂移，且不重复报原规则', () => {
  const ledger = emptyLedger();
  ledger.entries.push({
    path: 'notes.tmp',
    rule: 'hygiene/temp-file',
    disposition: 'remove',
    since: '2026-10-01',
    reason: '测试'
  });
  const report = scanSample({ ledger }).report;
  const drift = report.findings.find((f) => f.rule === 'hygiene/removal-pending' && f.path === 'notes.tmp');
  assert.ok(drift, '应报 removal-pending');
  assert.ok(drift.message.includes('2026-10-01'));
  assert.ok(!report.findings.some((f) => f.rule === 'hygiene/temp-file' && f.path === 'notes.tmp'));
  assert.equal(report.findings.filter((f) => f.path === 'notes.tmp').length, 1);
});

test('账本：路径已不存在的条目被报告为可清理', () => {
  const ledger = emptyLedger();
  ledger.entries.push({ path: 'already/gone.md', disposition: 'keep', reason: '测试' });
  const report = scanSample({ ledger }).report;
  const stale = report.findings.find((f) => f.rule === 'hygiene/ledger-stale');
  assert.ok(stale, '应报 ledger-stale');
  assert.equal(stale.path, 'already/gone.md');
});

test('账本读写：排序稳定、非法输入明确报错', (t) => {
  const dir = sandboxIn(t, 'ledger');
  const file = path.join(dir, 'hygiene-baseline.json');
  const ledger = emptyLedger();
  ledger.entries.push({ path: 'b.md', disposition: 'keep', reason: 'x' });
  ledger.entries.push({ path: 'a.md', disposition: 'keep', reason: 'x' });
  saveLedger(file, ledger);
  const loaded = loadLedger(file);
  assert.deepEqual(loaded.entries.map((e) => e.path), ['a.md', 'b.md']);

  fs.writeFileSync(file, '{"version":1,"entries":[{"path":"a.md","disposition":"banana"}]}');
  assert.throws(() => loadLedger(file), /disposition/);

  fs.writeFileSync(file, '{"version":9,"entries":[]}');
  assert.throws(() => loadLedger(file), /版本/);
});

test('日期工具：归一化与加天数', () => {
  assert.equal(normalizeDate('2026-1-5'), '2026-01-05');
  assert.equal(normalizeDate('2026/01/05'), '2026-01-05');
  assert.equal(normalizeDate('2026.01.05'), '2026-01-05');
  assert.equal(normalizeDate('not-a-date'), null);
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});

test('引用抽取：反引号路径、链接、裸路径三类都能取到，并带类型', () => {
  const text = [
    '见 `docs/api.md` 与 [说明](../readme.md#top)。',
    '配置写在 src/config.js 里。',
    '不应当被当成路径：`npm run build`、`fetchUser`、https://example.com/x.md'
  ].join('\n');
  const { paths, symbols } = extractReferences('docs/x.md', text);
  const raw = paths.map((p) => p.raw);
  assert.ok(raw.includes('docs/api.md'));
  assert.ok(raw.includes('../readme.md'));
  assert.ok(raw.includes('src/config.js'));
  assert.ok(!raw.includes('npm run build'));
  assert.ok(!paths.some((p) => p.raw.startsWith('http')));
  assert.equal(paths.find((p) => p.raw === '../readme.md').kind, 'link');
  assert.equal(paths.find((p) => p.raw === 'docs/api.md').kind, 'code');
  assert.ok(symbols.some((s) => s.raw === 'fetchUser'));
});

test('日期抽取：规划语境与非规划语境可区分', () => {
  const text = [
    '- 计划 2025-06 完成数据隔离',
    '- 2025 年 3 月发布了 v1.2',
    '截止日期：2026/12/31',
    '- 计划于 2025-09 发布首个版本'
  ].join('\n');
  const dates = extractDates(text);
  const june = dates.find((d) => d.year === 2025 && d.month === 6);
  assert.ok(june?.hasPlanKeyword, '“计划 2025-06”应识别为规划日期');
  const march = dates.find((d) => d.year === 2025 && d.month === 3);
  assert.equal(march?.hasPlanKeyword, false, '已发生的发布记录不是规划日期');
  const december = dates.find((d) => d.year === 2026 && d.month === 12);
  assert.ok(december?.hasPlanKeyword, '“截止日期”应识别为规划日期');
  const september = dates.find((d) => d.year === 2025 && d.month === 9);
  assert.ok(september?.hasPlanKeyword, '“计划于 ... 发布”应识别为规划日期');
});

test('glob：**/x 与 */y 语义符合预期', () => {
  assert.ok(globToRegExp('docs/**').test('docs/a/b/c.md'));
  assert.ok(globToRegExp('**/SKILL.md').test('SKILL.md'));
  assert.ok(globToRegExp('**/SKILL.md').test('a/b/SKILL.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(matchesAny('docs/a.md', ['**/docs/**', 'README.md']));
});

const GIT_DOC_DATE = '2026-01-01T00:00:00Z';
const GIT_CODE_60D = '2026-03-02T00:00:00Z'; // 落后 60 天：只够触发文件级判定
const GIT_CODE_150D = '2026-05-31T00:00:00Z'; // 落后 150 天：也够触发项目级回退

function makeGitFixture(t, label) {
  const dir = sandboxIn(t, label);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n调用 `handler`。\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export function handler() { return 1; }\n');
  return dir;
}

test('git：文档没写代码路径时，用项目级回退信号（阈值 90 天）', (t) => {
  const dir = makeGitFixture(t, 'gitfake');
  const fakeTimes = {
    'docs/guide.md': Date.parse(GIT_DOC_DATE),
    'src/app.js': Date.parse(GIT_CODE_150D)
  };
  const { report } = scan({
    root: dir,
    now: NOW,
    useGit: true,
    readGitTime: (_root, rel) => fakeTimes[rel] ?? null
  });
  assert.equal(report.git, true);
  const lag = report.findings.find((f) => f.rule === 'hygiene/stale-vs-code');
  assert.ok(lag, '文档落后于代码时应报 stale-vs-code');
  assert.ok(lag.message.includes('比它新 150 天'), `项目级判定应算出 150 天，实际：${lag.message}`);
  assert.ok(lag.evidence.includes('git'), '证据应标明时间来自 git');
});

test('git：项目级回退有独立阈值，60 天差距不该触发', (t) => {
  const dir = makeGitFixture(t, 'gitfake-short');
  const fakeTimes = {
    'docs/guide.md': Date.parse(GIT_DOC_DATE),
    'src/app.js': Date.parse(GIT_CODE_60D)
  };
  const { report } = scan({
    root: dir,
    now: NOW,
    useGit: true,
    readGitTime: (_root, rel) => fakeTimes[rel] ?? null
  });
  assert.ok(
    !report.findings.some((f) => f.rule === 'hygiene/stale-vs-code'),
    '项目级判定阈值 90 天，60 天差距不应报，否则会把正常迭代也报成过时'
  );
});

test('git：文档明确提到代码文件时按文件级差异判定', (t) => {
  const dir = makeGitFixture(t, 'gitfake-files');
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n实现见 `src/app.js`。\n');

  const fakeTimes = {
    'docs/guide.md': Date.parse(GIT_DOC_DATE),
    'src/app.js': Date.parse(GIT_CODE_60D)
  };
  const { report } = scan({
    root: dir,
    now: NOW,
    useGit: true,
    readGitTime: (_root, rel) => fakeTimes[rel] ?? null
  });
  const lag = report.findings.find((f) => f.rule === 'hygiene/stale-vs-code');
  assert.ok(lag, '文档落后于代码时应报 stale-vs-code');
  assert.ok(lag.message.includes('src/app.js'), `应按文件级判定，实际：${lag.message}`);
  assert.ok(lag.message.includes('60 天'), `应算出 60 天，实际：${lag.message}`);
  assert.ok(lag.evidence.includes('git'), '证据应标明时间来自 git');
});

test('git：真实仓库端到端（环境不允许起子进程时跳过）', async (t) => {
  if (!GIT_USABLE) {
    t.skip('当前环境无法通过管道调用 git（沙箱限制），语义已由注入式用例覆盖');
    return;
  }
  const dir = sandboxIn(t, 'git');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1'
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });

  git('init', '-q', '-b', 'main');

  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n调用 `handler`。\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export function handler() {}\n');

  const commit = (msg, date) => {
    execFileSync('git', ['add', '.'], { cwd: dir, env, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', msg], {
      cwd: dir,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: 'ignore'
    });
  };

  commit('doc', '2026-01-01T00:00:00Z');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export function handler() { return 1; }\n');
  commit('feat', '2026-05-31T00:00:00Z');

  assert.equal(detectGit(dir), true);
  const { report } = scan({
    root: dir,
    now: NOW,
    config: { rules: { 'hygiene/stale-date': { untouchedDays: 0 } } }
  });
  assert.equal(report.git, true);
  const lag = report.findings.find((f) => f.rule === 'hygiene/stale-vs-code');
  assert.ok(lag, '文档落后于代码时应报 stale-vs-code');
  assert.ok(lag.message.includes('150 天'), `git 提交时间应算出 150 天，实际：${lag.message}`);
  assert.ok(lag.evidence.includes('git'));
});