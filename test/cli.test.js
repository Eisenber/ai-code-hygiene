/**
 * CLI 行为测试：全部通过 import run() 完成，不起子进程。
 * 覆盖退出码、输出格式、ack 的账本语义，以及"先固化基线再逐条裁决"这条推荐流程。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/cli.js';
import { loadLedger } from '../src/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'samples', 'messy');
const NOW = '2026-11-06T12:00:00Z';

/** 造一个隔离工作目录，把样例复制进去，避免污染仓库。 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicg-cli-'));
  fs.cpSync(SAMPLE, path.join(dir, 'repo'), { recursive: true });
  return dir;
}

function capture(argv, opts = {}) {
  let out = '';
  let err = '';
  const code = run(argv, {
    version: '0.1.0',
    io: {
      stdout: { write: (s) => { out += s; return true; }, isTTY: false },
      stderr: { write: (s) => { err += s; return true; } },
      color: false
    },
    ...opts
  });
  return { code, out, err };
}

/**
 * 所有相对路径（--root、--ledger、--out、配置自动发现）都相对 `cwd` 解析。
 * 测试里把 cwd 指到沙箱仓库，才能保证读到的是沙箱自己的配置，而不是本项目的配置。
 */
const scanArgs = (dir, extra = []) => [
  'scan', '--root', path.join(dir, 'repo'), '--now', NOW, '--no-color', ...extra
];

test('scan：有错误级问题时退出码为 1', () => {
  const dir = sandbox();
  const { code, out } = capture(scanArgs(dir), { cwd: dir });
  assert.equal(code, 1);
  assert.match(out, /ERROR/);
  assert.match(out, /ai-code-hygiene v0\.1\.0/);
});

test('scan：--fail-on none 时永远 0；--fail-on warn 时警告也算失败', () => {
  const dir = sandbox();
  assert.equal(capture(scanArgs(dir, ['--fail-on', 'none']), { cwd: dir }).code, 0);
  assert.equal(capture(scanArgs(dir, ['--fail-on', 'warn']), { cwd: dir }).code, 1);
});

test('配置跟随 --root：被扫描仓库自己的配置生效，调用者的 cwd 不生效', () => {
  const dir = sandbox();
  // 沙箱仓库根放一份"把 temp-file 关掉"的配置
  fs.writeFileSync(
    path.join(dir, 'repo', 'ai-hygiene.config.json'),
    JSON.stringify({ rules: { 'hygiene/temp-file': false } })
  );

  const reportFile = 'r.json';
  capture(scanArgs(dir, ['--format', 'json', '--out', reportFile]), { cwd: dir });
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, reportFile), 'utf8'));
  assert.ok(parsed.findings.length > 0, '其它规则仍应生效');
  assert.ok(
    !parsed.findings.some((f) => f.rule === 'hygiene/temp-file'),
    '沙箱仓库自己的配置应生效（调用者 cwd 里的项目配置不应干扰）'
  );
});

test('--root 指向夹具目录时，不能被"夹具跳过"吞掉', () => {
  const dir = sandbox();
  // 沙箱根目录本身就叫 samples：默认 fixtureDirs 含 samples，但它就是扫描目标
  const nested = path.join(dir, 'samples', 'repo');
  fs.cpSync(SAMPLE, nested, { recursive: true });
  const { out } = capture(['scan', '--root', nested, '--now', NOW, '--no-color', '--fail-on', 'none'], { cwd: dir });
  assert.match(out, /12 个文件/, '应扫描到全部 12 个文件');
  assert.match(out, /ERROR \(2\)/, '验收样例会故意保留两条断链');
});

test('scan：--severity 过滤后，标题里的分组计数同步（不能只过滤明细）', () => {
  const dir = sandbox();
  const onlyError = capture(scanArgs(dir, ['--severity', 'error', '--fail-on', 'none']), { cwd: dir }).out;
  assert.match(onlyError, /ERROR \(2\)/);
  assert.doesNotMatch(onlyError, /WARN \(/);
  assert.doesNotMatch(onlyError, /INFO \(/);

  const noInfo = capture(scanArgs(dir, ['--severity', 'warn', '--fail-on', 'none']), { cwd: dir }).out;
  assert.match(noInfo, /WARN \(10\)/);
  assert.doesNotMatch(noInfo, /INFO \(/);
});

test('scan：非法参数返回 2 而不是抛异常', () => {
  assert.equal(capture(['scan', '--nonsense']).code, 2);
  assert.equal(capture(['scan', '--severity', 'fatal']).code, 2);
  assert.equal(capture(['scan', '--fail-on', 'maybe']).code, 2);
  assert.equal(capture(['nope']).code, 2);
  assert.equal(capture(['scan', '--baseline', 'missing.json']).code, 2);
});

test('scan：json 与 markdown 两种格式都可用', () => {
  const dir = sandbox();
  const json = capture(scanArgs(dir, ['--format', 'json']), { cwd: dir });
  const parsed = JSON.parse(json.out);
  assert.ok(Array.isArray(parsed.findings));
  assert.ok(parsed.findings.length > 0);
  assert.equal(parsed.tool, 'aicg');
  assert.equal(parsed.rawFindings, undefined, 'CLI 输出不应暴露内部原始结果');

  const md = capture(scanArgs(dir, ['--format', 'markdown']), { cwd: dir });
  assert.match(md.out, /^# AI 产物清退报告/);
  assert.match(md.out, /\| 位置 \| 规则 \|/);
});

test('scan：--out 落盘，文件名 .json 时即使默认 text 格式也写 JSON', () => {
  const dir = sandbox();
  const dest = path.join(dir, 'reports', 'hygiene.json');
  const { code } = capture(scanArgs(dir, ['--out', dest]), { cwd: dir });
  assert.equal(code, 1);
  const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.ok(parsed.findings.length > 0);
});

test('推荐流程：baseline 固化 → 扫描变干净 → ack 重开 → prune 清理', () => {
  const dir = sandbox();
  const ledger = path.join(dir, 'hygiene-baseline.json');

  // 1) 固化基线
  const base = capture([
    'baseline', '--root', path.join(dir, 'repo'), '--now', NOW, '--ledger', 'hygiene-baseline.json'
  ], { cwd: dir });
  assert.equal(base.code, 0, base.err);
  const saved = loadLedger(ledger);
  assert.ok(saved.entries.length >= 10, '样例的问题应全部进基线');
  assert.ok(saved.entries.every((e) => e.disposition === 'keep' && e.reviewAfter));

  // 2) 基线后：所有问题被压制，退出码 0
  const clean = capture(scanArgs(dir, ['--ledger', ledger]), { cwd: dir });
  assert.equal(clean.code, 0);
  assert.match(clean.out, /没有发现问题/);
  assert.match(clean.out, /已由账本处置/);

  // 3) 基线之后仍能对某条问题重新裁决（这是 ack 最容易坏的地方）
  const ack = capture([
    'ack', '--root', path.join(dir, 'repo'), '--now', NOW,
    '--path', 'docs/api-summary.md', '--rule', 'hygiene/orphan-doc',
    '--disposition', 'remove', '--reason', '内容已并入 api.md',
    '--ledger', 'hygiene-baseline.json'
  ], { cwd: dir });
  assert.equal(ack.code, 0, ack.err);
  const updated = loadLedger(ledger).entries.find(
    (e) => e.path === 'docs/api-summary.md' && e.rule === 'hygiene/orphan-doc'
  );
  assert.equal(updated.disposition, 'remove');

  // 4) 下一轮扫描应报"判定清理但文件仍在"
  const after = capture(scanArgs(dir, ['--ledger', ledger, '--fail-on', 'warn']), { cwd: dir });
  assert.equal(after.code, 1);
  assert.match(after.out, /hygiene\/removal-pending/);
  assert.match(after.out, /内容已并入 api\.md/);

  // 5) 真的删掉文件后，removal-pending 消失，条目可被 prune 清掉
  fs.rmSync(path.join(dir, 'repo', 'docs', 'api-summary.md'));
  const gone = capture(scanArgs(dir, ['--ledger', ledger]), { cwd: dir });
  assert.doesNotMatch(gone.out, /removal-pending/);

  const prune = capture(['prune', '--root', path.join(dir, 'repo'), '--ledger', 'hygiene-baseline.json'], { cwd: dir });
  assert.equal(prune.code, 0);
  const pruned = loadLedger(ledger);
  assert.ok(!pruned.entries.some((e) => e.path === 'docs/api-summary.md'));
});

test('ack：缺少 --reason 时不写入账本（理由是这个工具的核心资产）', () => {
  const dir = sandbox();
  const ledger = path.join(dir, 'hygiene-baseline.json');
  const { code, err } = capture([
    'ack', '--root', path.join(dir, 'repo'), '--path', 'notes.tmp', '--ledger', 'hygiene-baseline.json'
  ], { cwd: dir });
  assert.equal(code, 2);
  assert.match(err, /--reason/);
  assert.ok(!fs.existsSync(ledger));
});

test('ack：未知路径报错并给出可选项', () => {
  const dir = sandbox();
  const ledger = path.join(dir, 'hygiene-baseline.json');
  const { code, err } = capture([
    'ack', '--root', path.join(dir, 'repo'), '--path', 'does/not/exist.md',
    '--reason', 'x', '--ledger', 'hygiene-baseline.json'
  ], { cwd: dir });
  assert.equal(code, 2);
  assert.match(err, /没有找到/);

  const wrongRule = capture([
    'ack', '--root', path.join(dir, 'repo'), '--path', 'notes.tmp',
    '--rule', 'hygiene/broken-reference', '--reason', 'x', '--ledger', 'hygiene-baseline.json'
  ], { cwd: dir });
  assert.equal(wrongRule.code, 2);
  assert.match(wrongRule.err, /hygiene\/temp-file/);
});

test('ack：snooze 默认 30 天，且明确写入 until', () => {
  const dir = sandbox();
  const ledger = path.join(dir, 'hygiene-baseline.json');
  const { code, err } = capture([
    'ack', '--root', path.join(dir, 'repo'), '--path', 'notes.tmp',
    '--reason', '先放着', '--ledger', 'hygiene-baseline.json'
  ], { cwd: dir });
  assert.equal(code, 0, err);
  const entry = loadLedger(ledger).entries.find((e) => e.path === 'notes.tmp');
  assert.equal(entry.disposition, 'snooze');
  assert.match(entry.until, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(err, /豁免至/);
});

test('baseline --from：可从已有报告固化，不必重扫', () => {
  const dir = sandbox();
  const reportFile = path.join(dir, 'r.json');
  capture(scanArgs(dir, ['--format', 'json', '--out', reportFile]), { cwd: dir });
  const ledger = path.join(dir, 'from-report.json');
  const { code } = capture(['baseline', '--from', reportFile, '--out', ledger]);
  assert.equal(code, 0);
  assert.ok(loadLedger(ledger).entries.length > 0);
});

test('baseline --from：文件不存在时返回 2', () => {
  const dir = sandbox();
  assert.equal(capture(['baseline', '--from', 'nope.json'], { cwd: dir }).code, 2);
});

test('rules：列出全部规则及当前生效级别', () => {
  const { code, out } = capture(['rules']);
  assert.equal(code, 0);
  assert.match(out, /hygiene\/temp-file\s+启用\s+warn/);
  assert.match(out, /hygiene\/broken-reference\s+启用\s+error/);
  assert.match(out, /hygiene\/stale-vs-code\s+启用\s+info/);
});

test('help：输出用法且退出码 0', () => {
  const { code, out } = capture(['help']);
  assert.equal(code, 0);
  assert.match(out, /aicg <command> \[options\]/);
  assert.match(out, /退出码/);
});