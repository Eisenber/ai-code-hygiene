# 设计说明

这份文档回答三个问题：为什么要做成"扫描器 + 账本"而不是一个清理脚本；一条 finding 是怎么被判定的；加一条新规则要动哪里。

## 1. 为什么不是"一键清理"

如果目标是"把 AI 留下的垃圾删掉"，最直接的做法是写个脚本按文件名删。它的失败方式是可预测的：

- **误删无法撤回**：AI 生成的 `notes.md` 有可能是唯一的需求记录。
- **删了还会长回来**：只要 AI 继续被允许写 `-summary.md`，下周同一批文件会重新出现。
- **没有共同记忆**：三个人各自决定"这个能删/不能删"，同一份文档被反复讨论。

所以本项目把"删除"拆成三步，工具只承担前两步：

1. **识别**：按规则产出 finding，每条带证据（文件、行号、时间、引用关系）。
2. **裁决**：人确认"保留 / 清理 / 延期"，结果写入账本，成为团队共同记忆。
3. **执行**：清理本身由人、PR 或 `git rm` 完成；工具在下一轮扫描里检查**应该消失的东西是否真的消失了**（`revived`、`snooze-expired`）。

## 2. finding 的判定链

一次扫描是固定顺序的流水线，每一步只做一件事：

```
walk（发现文件）
  → index（读文本、抽符号、取时间）
  → rules（独立、无副作用的判定函数）
  → ledger（叠加人工裁决）
  → filter（severity / baseline / 配置开关）
  → render（text / json / markdown）
```

关键约束：**规则之间不互相调用**。规则输入是同一个只读的 `context`，输出是扁平数组。这样一条规则的误报不会污染另一条，也允许任意规则单独关闭。

### context 里有什么

| 字段 | 来源 | 用途 |
|---|---|---|
| `files` | `walk.js` | 全部纳入扫描的文件（已排序、已忽略过滤） |
| `texts` | `index.js`，按扩展名白名单惰性读取 | 内容类规则 |
| `symbols` | `index.js`，代码文件里的声明名 | 断链检测 |
| `refs` | `refs.js`，从 markdown 里抽出的路径与符号 | 断链、孤儿文档 |
| `times` | `index.js`，git commit 时间或 mtime | 时效类规则 |
| `config` | 默认值 + 仓库配置文件 | 阈值与开关 |
| `ledger` | `ledger.js` | 人工裁决，只读视图 |
| `now` | 运行时注入 | **可测试性**：所有时间判断走同一个 now |

`now` 单独注入是本项目唯一的"测试钩子"：没有它，所有时效类规则都只能靠改系统时钟来测。

## 3. 证据的强弱分级

每条 finding 带 `severity`，含义是"我有多确定这是问题"，而不是"它有多重要"：

- `error`：几乎不可能是误报。例：文档链接指向的路径确实不存在。
- `warn`：高概率是问题，需要人扫一眼。例：无人引用的 `*-summary.md`。
- `info`：线索，不是结论。例：文件 180 天未改动。

规则实现时先问"这条结论需要假设什么"。需要假设越多，级别越低。宁可让 `warn` 多几条，也不要让 `error` 里出现误报——一旦 `error` 不可信，整个工具就会被绕过。

## 4. 账本（hygiene-baseline.json）

账本是**唯一有写入语义的产物**，结构刻意扁平，便于 code review 时肉眼 diff：

```json
{
  "version": 1,
  "entries": [
    { "path": "docs/api.md", "rule": "hygiene/stale-vs-code",
      "disposition": "snooze", "until": "2026-12-31", "reason": "等 V2 合并" },
    { "path": "labs/old-demo.md", "rule": "hygiene/orphan-doc",
      "disposition": "remove", "since": "2026-11-01", "reason": "功能已下线" }
  ]
}
```

三种 disposition：

| disposition | 含义 | 到期后的行为 |
|---|---|---|
| `keep` | 已知问题，明确接受 | 不再报告；`reviewAfter` 到期后重新提示复核 |
| `snooze` | 先不管，但设了期限 | 到期后重新报告（`hygiene/snooze-expired`） |
| `remove` | 决定要删，尚未删 | 下一次扫描检查文件是否还在；不在了则提示"可移除账本条目" |

`remove` 这一项是整个工具的核心闭环：它把"记得删"从人的脑内负担变成账本里的一个待办，并且能检测"以为删了其实没删"。

## 5. 扩展一条规则要改哪里

1. 在 `src/rules/` 新建 `your-rule.js`，导出：

```js
export default {
  id: 'hygiene/your-rule',   // 必须带 hygiene/ 前缀，账本靠它匹配
  description: '一句话说明这条规则认定的"问题"是什么',
  defaultSeverity: 'warn',
  run(context) { return [ /* finding */ ]; }
};
```

2. 在 `src/rules/index.js` 的数组里登记（顺序即报告顺序，不敏感）。
3. finding 字段固定为：

```js
{
  rule: 'hygiene/your-rule',
  severity: 'warn',
  path: '相对仓库根的路径',      // 必填，账本用它匹配
  line: 12,                      // 可选，1 起
  message: '对人有意义的一句话',
  evidence: '指向证据的短字符串',  // 可选：另一路径、哈希、时间
  suggestion: '建议动作'          // 可选
}
```

4. 若规则依赖时间，**必须用 `context.now`**，不要直接 `Date.now()`，否则自检 fixture 会随真实时间腐烂。

## 6. 刻意不做的事

- **不自动修复**：自动改文档会引入更难发现的错误。
- **不内置模型**：规则是确定性的；需要语义判断的部分留给"人看 finding"这个环节。
- **不做全文搜索索引**：仓库规模在工具能秒扫的量级；上规模应该交给 ripgrep/git grep，而不是自己造。
