# 参与贡献

这个项目的规则是**确定性**的：每条规则只回答一个问题，且必须能指出证据。所以"加一条规则"的门槛不高，但对精度要求很严——一条误报的规则会被用户直接关掉，连带让整个工具失去信任。

本文件给出加规则的完整流程与验收标准。第一次贡献建议从标有 `good first issue` 的 issue 开始。

## 先跑起来

```bash
node --version        # 需要 >= 18
node test/all.js      # 40 条用例，单进程执行，约 1.5 秒
node bin/aicg.js rules
```

零依赖，不需要 `npm install`。

## 加一条规则：五步

以"检测 `TODO(临时)` 这类带过期前缀的注释"为例（仅为示例，实际可换任何问题）。

### 1. 新建 `src/rules/<name>.js`

规则是一个对象，`run(context)` 是纯函数：只读 `context`，返回 finding 数组，不写文件、不联网。

```js
/**
 * 规则：带日期前缀的临时注释（如 TODO(临时) 2025-06）。
 * 只看已经过期的注释：未来的计划不是问题。
 */

export default {
  id: 'hygiene/temporary-todo', // 必须带 hygiene/ 前缀：账本按它匹配
  description: '代码里带过期日期的临时 TODO 注释',
  defaultSeverity: 'info',

  run(context) {
    const cfg = context.config.rules['hygiene/temporary-todo'];
    const findings = [];

    for (const f of context.files) {
      if (context.isFixture(f.rel)) continue; // 夹具目录整体跳过
      const text = context.readText(f.rel);   // 非文本文件返回 null
      if (!text) continue;

      text.split('\n').forEach((line, i) => {
        const m = /TODO\([^)]*\)\s*(\d{4}-\d{2}-\d{2})/.exec(line);
        if (!m) return;
        if (Date.parse(m[1]) >= context.now) return; // 必须用 context.now，不要 Date.now()
        findings.push({
          rule: this.id,
          severity: cfg.severity,
          path: f.rel,
          line: i + 1,
          message: `临时 TODO 的截止日 ${m[1]} 已过`,
          evidence: line.trim().slice(0, 80),
          suggestion: '处理掉这条 TODO，或改成正式 issue 并删除注释'
        });
      });
    }
    return findings;
  }
};
```

### 2. 在 `src/rules/index.js` 注册

```js
import temporaryTodo from './temporary-todo.js';

export const ALL_RULES = [
  // ...
  temporaryTodo
];
```

顺序即报告顺序；不注册的规则不会执行。

### 3. 在 `src/config.js` 的 `DEFAULT_CONFIG.rules` 里给默认值

```js
'hygiene/temporary-todo': {
  enabled: true,
  severity: 'info'
}
```

规则名就是这个配置键；`"hygiene/temporary-todo": false` 可以整体关闭它。

### 4. 加用例

在 `test/scan.test.js` 里用固定的 `now` 和临时沙箱断言"该报的报了、不该报的没报"：

```js
test('临时 TODO：只报已过期的', (t) => {
  const dir = sandboxIn(t, 'todo');           // 测试结束自动清理
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), [
    '// TODO(临时) 2025-01-01 迁移旧接口',
    '// TODO(临时) 2099-01-01 还没到期',
    '// TODO 没有日期的普通待办'
  ].join('\n'));

  const { report } = scan({ root: dir, now: NOW, useGit: false });
  const hits = report.findings.filter((f) => f.rule === 'hygiene/temporary-todo');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});
```

### 5. 更新文档

- `README.md` 的"它解决的具体问题"表格加一行；
- 如果规则有取舍（比如"宁可漏报也不误报"），在 `docs/design.md` 里说明。

## finding 契约

| 字段 | 必填 | 说明 |
|---|---|---|
| `rule` | 是 | 规则 id，账本与报告都靠它 |
| `severity` | 是 | `error` / `warn` / `info`，见下方语义 |
| `path` | 是 | 仓库相对路径（正斜杠） |
| `message` | 是 | 对人有意义的一句话，不要只复述匹配到的正则 |
| `line` | 否 | 1 起 |
| `evidence` | 否 | 另一路径、哈希、时间、原文片段——让人能自己复核 |
| `suggestion` | 否 | 建议动作 |
| `duplicates` | 否 | 重复内容规则专用的"其余副本"列表 |

## severity 语义

`error` 只留给**客观事实**（路径不存在、文件确实重复）。任何需要假设的判断最高到 `warn`，启发式线索用 `info`。

这不是保守，是可持续性的前提：`error` 一旦出现误报，用户就会把整条规则关掉，连带让 `--fail-on error` 的 CI 集成失效。

## context 里能拿到什么

| 字段 | 说明 |
|---|---|
| `files` | 已排序、已过滤的文件列表 `{rel, abs, size, mtimeMs, ext}` |
| `readText(rel)` | 读取文本（带缓存）；非文本/读失败返回 `null` |
| `fileSet` | 全部文件路径的 Set，用于判断"引用的东西在不在" |
| `times` / `precision` | 每个文件的"最后有意义变更时间"与来源（`git` / `mtime`） |
| `symbols` / `symbolIndex` | 代码文件 → 符号名；符号名 → 出现它的文件 |
| `graph` | 引用图 `{ edges, byTarget, inbound(rel) }` |
| `isFixture(rel)` | 该路径是否位于夹具目录（`fixtures`/`samples`/`testdata`），规则应整体跳过 |
| `config` | 合并后的配置（含用户覆盖） |
| `now` | 注入的当前时间（毫秒）。**禁止在规则里直接 `Date.now()`**，否则用例会随真实时间腐烂 |

## 提交前检查清单

- [ ] `node test/all.js` 全绿
- [ ] 新规则在 `node bin/aicg.js rules` 里可见，级别符合预期
- [ ] 对样例仓库跑一遍：`node bin/aicg.js scan --root test/samples/messy --now 2026-11-06T12:00:00Z`
- [ ] 找一份**真实**文档/代码试过，确认没有明显误报（这条比用例更重要）
- [ ] 规则里没有 `Date.now()`、没有写文件、没有网络请求
- [ ] 跳过了 `context.isFixture(f.rel)` 的文件
- [ ] 消息是中文、能让人立刻知道该做什么

## 提 issue

用 `.github/ISSUE_TEMPLATE/rule-proposal.yml` 模板，说清四件事：它认定的"问题"是什么、证据从哪来、什么情况下会误报、有没有真实例子。
没有真实例子的规则提案，通常会在实现时发现"其实抓不到"。
