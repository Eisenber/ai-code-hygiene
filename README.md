# ai-code-hygiene

[![CI](https://github.com/Eisenber/ai-code-hygiene/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Eisenber/ai-code-hygiene/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

> 一个零依赖、可离线运行的"AI 产物清退"扫描器。
> 它不替 AI 写代码，专管 AI 写完之后**留下的东西**：临时文件、重复文档、失效引用、过期说明、被删功能的残留。

## 一句话

AI 擅长生成，不擅长回收。仓库里真正难管的不是"缺什么"，而是"多了什么还在冒充有效"。
`ai-code-hygiene` 把这些"多出来的东西"变成两类东西：

1. **finding**（发现）：一条可复核、可定位、带证据的记录；
2. **状态**（state）：一条写进账本的去向记录，让同一个问题**不会每周重新吵一遍**，也不会在"标记已修"之后悄悄复发。

## 它解决的具体问题

| 现象 | 对应规则 | 证据 |
|---|---|---|
| `xxx.tmp`、`scratch-*.js`、`*-old.js`、`*-v2-final.md` 这类一次性产物 | `hygiene/temp-file` | 文件名模式（前缀/后缀/精确三套口径） |
| 文件头部写着"由 AI 生成""一次性脚本" | `hygiene/ai-artifact` | 头部若干行 |
| `---summary.md`、`---notes.md` 没人链接，也没并入任何文档 | `hygiene/orphan-doc` | 引用图里没有入链 |
| 同一份内容出现在 3 个目录 | `hygiene/duplicate-content` | 归一化内容哈希 |
| 文档里的链接/`路径` 指向已删除的文件或符号 | `hygiene/broken-reference` | 路径解析 + 符号索引 |
| 文档写着"计划 2025-Q3 上线"，而现在是 2026 | `hygiene/stale-date` | 文档内日期 vs 当前时间 |
| 文档所描述的代码比文档新很多 | `hygiene/stale-vs-code` | git commit 时间，无 git 时退化为 mtime |
| 账本标记"已删除"，文件又出现了 | `hygiene/removal-pending` | 账本 `disposition: remove` |

设计取舍、规则扩展方式、以及"为什么不做自动删除"，见 [docs/design.md](docs/design.md)。

## 三条设计原则

1. **只报告，不自动删除。** 误删的代价远高于多条 finding。删除永远是人的决定，工具只负责把候选和证据排好序。
2. **证据优先于猜测。** 每条 finding 都必须能指出"我看的是哪一行/哪个文件/哪个时间"。因此 `error` 只留给客观事实（例如 markdown 链接指向的文件确实不存在），启发式判断最高只到 `warn`。
3. **状态要能过期。** 豁免、忽略、待清理都必须带到期时间或预期条件；没有到期时间的豁免等于永久遗忘，这正是旧文档腐烂的成因。

## 用法

需要 Node ≥ 18（在本机用捆绑的 Node 24 验证）。零第三方依赖，无需 `npm install`。

```bash
# 在仓库根扫描，输出人读报告
node bin/aicg.js scan --root .

# 机器可读结果（给 CI 或二次处理）
node bin/aicg.js scan --root . --format json --out reports/hygiene.json

# 只看错误级
node bin/aicg.js scan --root . --severity error

# 把当前结果固化为基线（推荐第一步：先把历史问题全部登记）
node bin/aicg.js baseline --root .

# 在基线上逐条裁决：接受 / 延期 / 决定清理
node bin/aicg.js ack --path docs/api.md --rule hygiene/stale-vs-code --until 2026-12-31 --reason "等 V2 合并后重写"
node bin/aicg.js ack --path notes.tmp --disposition remove --reason "内容已并入 README"

# 对比基线：只输出"新增或恶化"的问题，适合 cron / CI
node bin/aicg.js scan --root . --baseline hygiene-baseline.json --fail-on error

# 清理账本里已经失效的条目
node bin/aicg.js prune --root .
```

退出码：

| 码 | 含义 |
|---|---|
| `0` | 无达到 `--fail-on` 阈值的问题（默认阈值是 `error`） |
| `1` | 存在达到阈值的问题（CI 用） |
| `2` | 运行错误（参数、账本格式、规则配置等），与 finding 无关 |

`--fail-on` 默认是 `error` 而不是 `warn`：`error` 承诺"零误报"，可以放心让它挂 CI；`warn` 里有启发式判断，挂 CI 会很快被绕过。

## 一条建议的上手路径

直接跑全量报告通常会被几百条历史问题劝退。推荐顺序：

1. `aicg baseline`：把**现有**问题一次性登记为 `keep`（90 天后复核），此时扫描结果归零。
2. 把 `aicg scan --baseline hygiene-baseline.json` 接进 CI，从此**只拦新增问题**。
3. 每周挑几条账本里的 `keep` / `snooze`，用 `ack` 改成 `remove`，逐步还债；`prune` 负责收尾。
4. 90 天后 `reviewAfter` 到期，工具会把"当年接受过、现在是否还成立"重新提出来——这是防止豁免变成永久遗忘的关键。

## 配置文件

在仓库根放 `ai-hygiene.config.json` 即可覆盖默认值；`--config <file>` 可指定其他路径。
规则名既是配置键，也是关闭规则的方式（`"hygiene/xxx": false`）。

```json
{
  "fixtureDirs": ["fixtures", "__fixtures__", "samples", "testdata", "test-data"],
  "maxFileBytes": 524288,
  "rules": {
    "hygiene/broken-reference": {
      "severity": "error",
      "nonLinkSeverity": "info",
      "excludeGlobs": ["**/reference/**", "**/vendor/**"],
      "checkSymbols": true
    },
    "hygiene/stale-date": { "untouchedDays": 180 },
    "hygiene/stale-vs-code": { "minLagDays": 30, "projectWide": true, "minProjectLagDays": 90 },
    "hygiene/duplicate-content": { "minChars": 100 }
  }
}
```

`fixtureDirs` 里是**刻意构造的测试数据**（默认含 `fixtures`、`__fixtures__`、`samples`、`testdata`），
整个目录直接跳过——那里的"问题"不代表仓库的真实状态。它和 `ignore` 的区别：`ignore` 按文件 glob 忽略，
`fixtureDirs` 按目录名跳过。

两个容易踩的细节，都在用例里钉住了：

- **配置跟随 `--root`，不是跟随调用者的 cwd。** 同一份仓库无论从哪个目录调用，读到的都是它自己的配置。
- **`--root` 自己就是夹具目录时不生效。** 显式 `--root test/samples/messy` 会正常扫描全部规则；否则验收样例会变成"永远干净"。

完整默认值见 `src/config.js` 的 `DEFAULT_CONFIG`；运行 `node bin/aicg.js rules` 可看每条规则当前的开关与级别。

## 文件布局

```
ai-code-hygiene/
├── bin/aicg.js                 # 入口，只读版本号 + 设置退出码（约 15 行）
├── src/
│   ├── cli.js                  # 命令实现：参数解析、ack/baseline/prune、IO 注入（可测试）
│   ├── config.js               # 默认配置 + 合并 + 忽略规则
│   ├── walk.js                 # 文件发现（稳定排序、glob、gitignore 子集）
│   ├── indexer.js              # 内容读取、符号索引、时间戳（git 读取器可注入）
│   ├── refs.js                 # 引用抽取（含围栏代码块屏蔽、路径类型标记）
│   ├── rules/                  # 每条规则一个文件，统一签名，互不调用
│   ├── ledger.js               # 账本：读取、过期判断、压制、漂移检测
│   ├── report.js               # text / json / markdown 三种渲染
│   └── runner.js               # 串联：发现 → 索引 → 规则 → 账本 → 排序
├── ai-hygiene.config.json      # 本项目自己的配置（排除自检样例）
├── docs/design.md              # 为什么这么设计
└── test/
    ├── all.js                  # node test/all.js：单进程跑完全部用例
    ├── scan.test.js            # 规则语义 + 账本 + git 时间证据
    ├── cli.test.js             # 退出码、输出格式、推荐流程
    └── samples/messy/          # 故意做脏的样例仓库（验收基准）
```

## 自检

```bash
node test/all.js          # 41 条用例，单进程执行
node bin/aicg.js scan --root test/samples/messy --now 2026-11-06T12:00:00Z
```

`test/samples/messy/` 是一个"AI 参与开发数月后"的迷你仓库：断链、重复、临时文件、过期计划、
对话残留各一处，用来同时验证"该报的报了"和"不该报的没报"。它故意保留了两条真实的断链，
所以扫描它会**返回 2 个 error** —— 这是验收基准，不是缺陷。

用例里有一条真实 git 端到端测试：**在受限沙箱下会被跳过**（子进程管道受限，`EPERM`），
此时由注入假读取器的用例覆盖同样语义；在没有该限制的环境里会真正执行。

`run(argv, { cwd })` 的相对路径全部相对 `cwd` 解析（`--root`、`--ledger`、`--out`、配置自动发现）。
命令行下 `cwd` 就是进程工作目录；测试里把它指到沙箱仓库，才能读到沙箱自己的配置。

## 已知边界

- **无 git 时"文档是否过时"只能用 mtime**，一次全量 checkout 会让所有文件同时变"新"；报告里会明确标出时间证据来源。
- **符号索引是启发式的**，只覆盖常见声明形态（`function`/`class`/`const`/`def`/`interface` 等），不做完整 AST。因此符号相关判定最高只到 `warn`，且只在文档确实引用了本仓库代码文件时才启用。
- **只有"明确指向文件"的引用缺失才算 error**：markdown 链接、以 `/` 开头的根相对写法；反引号里的相对路径按提示处理，因为教程与示例会大量举例。
- **不识别中文分词级别的语义**：日期、版本号都是模式匹配，宁可漏报也不误报。
- **不做自动修复**：改文档比删文件更容易引入隐性错误，这一步留给人。
- **夹具目录整体跳过**：`fixtures`/`samples`/`testdata` 这类目录里的"脏"是测试数据，不是待治理对象；确需扫描时把这些名字从 `fixtureDirs` 里去掉。

## 参与贡献

- 想加一条规则？[CONTRIBUTING.md](CONTRIBUTING.md) 给了五步流程、finding 契约、severity 语义和提交前检查清单。
- 想提规则提案（或指出误报）？用 [`规则提案`](.github/ISSUE_TEMPLATE/rule-proposal.yml) 模板。
- 第一次贡献？从 [`good first issue`](https://github.com/Eisenber/ai-code-hygiene/issues/1) 开始，按 issue 里的步骤可以走通整条链路。

一条规则的成败主要看**误报率**，而不是覆盖多少场景。找一份真实仓库试跑，比写十条用例更有说服力。

## 放进别的仓库

整个目录只依赖 Node 标准库。复制到目标仓库的 `tools/ai-code-hygiene/` 后：

```bash
node tools/ai-code-hygiene/bin/aicg.js baseline --root .
```

删除 `test/` 与本项目专用的 `ai-hygiene.config.json` 条目即可。
