# Respire for Codex

[English](README.md) | 简体中文

**npm 包：[@rsrsai/codex](https://www.npmjs.com/package/@rsrsai/codex)**

## 让 AI 安装：复制这段提示词

将下面整段发送给**本地 Codex 对话中的助手**：

```text
请为我的本地 Codex 安装 Respire 记忆插件 @rsrsai/codex。
先阅读并遵循 https://github.com/risense-ai/respire-codex/blob/main/README.zh-CN.md，
然后实际执行安装，不要只解释步骤。

检查 Node.js 24+、npm、Git 和 Codex plugins/hooks 支持。复用现有 rsrs 环境；
仅在未安装 rsrs 时运行 npm install -g @rsrsai/cli@latest。
Windows 使用 npm/pnpm rsrs 包装器时检查 PowerShell 7.3+，或将 RESPIRE_RSRS_PATH
配置为已有的原生 rsrs.exe。运行 rsrs --version 和 rsrs --client-only status --json。
若需要登录、解锁记忆库、配置模型或处理宿主 runtime，请指出具体待办，让我在 rsrs 中完成；
不要在聊天中索取秘密，也不要自行管理 runtime。

先检查已有插件和 marketplace 注册，避免重复。尚未添加 marketplace 时执行：
codex plugin marketplace add risense-ai/respire-codex --ref main
尚未安装插件时执行：
codex plugin add respire@rsrsai
插件本体使用 npm 包，不使用 Git 包依赖。保留现有记忆库、账号配置、AGENTS.md 和其他 hooks。

确认 Respire 已安装且启用。告诉我何时重启 Codex，并打开 /hooks 亲自审核和信任
SessionStart、UserPromptSubmit、Stop，不得绕过 hooks 信任审核。
插件 setup 技能可用时运行检查。重启和审核后，在新对话中验证召回；
先向我要一条无敏感内容的测试事实，再验证存储及其实际记录。
在另一个召回成功且未显式存储成功的回合验证后台 Stop，核对状态和实际记忆回执。
最后报告安装版本、实际执行的检查和仍需我完成的操作。未经检查，不要声称 hooks 或完整链路已可用。
```

Codex 原生记忆插件：用户发言时召回、显式请求时存储、Stop 时在后台检查并整理新结论。
继续使用 Respire `rsrs` 的检索、加密、存储、账号和同步能力。

## 安装

需要 Node.js **24+**、npm、Git、支持 plugins/hooks 的本地 Codex，以及已安装的 `rsrs`。
Windows 使用 npm/pnpm 的 rsrs 命令包装器时还需 **PowerShell 7.3+**（`pwsh`），
以保留双引号等参数；或设置 `RESPIRE_RSRS_PATH` 指向真实的 `rsrs.exe`，直接执行原生程序。
已通过 Codex CLI **0.163.0** 和桌面内置运行时 **0.164.0-alpha.11.1** 的原生 hooks 验收。
独立 GUI 画面、Work Cloud、网页端、其他版本和企业禁用 hooks 的环境不在本版验证范围。

插件使用 `.codex-plugin/plugin.json` 兼容 Codex 0.163.0。该版本会跳过根目录
Agent Plugins `plugin.json` 格式的 hooks，即使插件已经启用。不要同时添加根清单。
`hooks/hooks.json` 随插件安装到缓存目录，不会另行创建 `~/.codex/hooks.json`。
hooks 审核信任后，由 `SessionStart` 注入记忆规则，无需单独保留 AGENTS.md 记忆提示词。

### 1. 准备 rsrs

已有可用环境可跳过安装：

```sh
npm install -g @rsrsai/cli@latest
rsrs --version
rsrs --client-only status --json
```

使用 rsrs 自身的交互界面登录、解锁记忆库并配置模型。宿主 runtime 须已运行。
插件仅调用 `rsrs --client-only`，不会启动、停止或升级服务，不接收密码。

### 2. 从 npm 安装 Codex 插件

在终端添加本仓库的 marketplace，再安装其中的 `respire`：

```sh
codex plugin marketplace add risense-ai/respire-codex --ref main
codex plugin add respire@rsrsai
```

仓库只提供 marketplace 清单；**插件本体从 npm 下载 `@rsrsai/codex`**，
不是 Git 包依赖。清单使用 `latest`；需要固定版本时，可在自己的 marketplace 中使用：

```json
{
  "name": "respire",
  "source": {
    "source": "npm",
    "package": "@rsrsai/codex",
    "version": "0.2.5",
    "registry": "https://registry.npmjs.org"
  },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Productivity"
}
```

上面的对象放入 marketplace 的 `plugins` 数组。普通的 `npm install -g @rsrsai/codex`
不会自动注册 Codex 插件。包内直接包含运行文件，无运行时依赖，也无需安装脚本。

### 3. 审核 hooks 并启用

重启 Codex，在插件界面确认 Respire 已启用。打开 hooks 管理（CLI 使用 `/hooks`），
审核并信任本插件的 `SessionStart`、`UserPromptSubmit`、`Stop`。
插件安装或升级后，新增或变更的 hooks 仍需用户审核，不能跳过。
运行 setup 技能可检查环境。用新对话测试已知项目的召回；用明确允许保存的事实测试存储。

已有 `rsrs inject` 写入的 AGENTS.md 或其他记忆 hooks 不会被插件自动删除。
若启用了多个自动召回/收尾来源，先核对其作用，再由用户决定保留哪一个，避免重复提示。

## 使用与行为

安装并审核 hooks 后，打开**新对话**即可使用，无需另加系统提示词或 AGENTS.md 记忆块。例如：

```text
项目发布流程之前有哪些约定？
记住：发布检查清单必须包含新会话召回验证。
/nomem 解释这段小代码，跳过自动记忆召回。
```

普通问题由 hook 注入匹配标题，模型再读取相关正文。只保存你希望长期保留的事实。
存储回执带有实际记录 ID 才表示写入成功；只有 `pending` 不算成功。

### 升级

更新 marketplace，然后安装其中当前的 npm 版本：

```sh
codex plugin marketplace upgrade rsrsai
codex plugin add respire@rsrsai
```

重启 Codex，在插件详情确认版本，并在 `/hooks` 审核变更过的 hooks。
若还安装了 `rsrsai-local` 等开发来源，只启用本次要使用的 Respire 安装，避免重复触发。

刚发版时若安装结果仍是旧版本，可能是 npm 元数据缓存。先等官方仓库能查到新版本，
再为这一次命令请求新元数据。PowerShell 示例：

```powershell
$env:npm_config_prefer_online = 'true'
codex plugin add respire@rsrsai --json
Remove-Item Env:npm_config_prefer_online
```

若该环境变量原本已有值，应恢复原值而非删除。以命令返回的版本号为准；装回旧版本不算升级。
无需卸载插件或删除插件状态。

### 用新会话验收

1. 在 `/hooks` 确认 Respire 三个 hooks 均已列出并信任。
2. 新建对话，询问已有记忆中的事实，查看 SessionStart 和 UserPromptSubmit 活动。
   仅安装成功或手动运行 `rsrs recall` 不能证明这条链路可用。
3. 保存一条明确允许保存的测试事实，核对记录 ID，再开另一个新对话召回它，验证跨会话持久化。
4. 另用一个召回成功、没有显式存储成功的回合，等待后台 Stop 完成。
   核对 `PLUGIN_DATA/sessions/` 中该回合的 `archive` 状态，并读取其中的实际写入 ID。
   0.2.0 不应产生 `Blocked by hook` 或重复收尾提示；旧聊天可能在重启客户端前继续使用 0.1.x 阻断 hook。

需要排除旧提示词干扰时，先备份，再临时关闭自己的旧记忆提示词或其他记忆 hooks，保留并恢复无关规则。
不要删除记忆库，也不要把旧对话已经教过模型如何使用 rsrs 当成插件验收成功。

若 `/hooks` 中 Respire 数量为零，检查是否启用了正确的安装，以及包内是否有
`.codex-plugin/plugin.json` 和 `hooks/hooks.json`；不会自动创建用户级 hooks.json。
若已列出但未激活，检查信任状态并重启。若 hook 报引擎错误，先运行
`rsrs --client-only status --json` 和 setup 技能；Windows 还应检查 `pwsh`，不要先靠补提示词绕过问题。

| 触发 | 行为 |
| --- | --- |
| 新建、恢复、清空、fork 或压缩后的 SessionStart | 注入记忆工作规则，检查引擎状态 |
| 普通用户输入 | 同步 `recall --titles --json`，最多 5 条、1500 字符标题；按需读取正文 |
| `记：`、`存：`、`记录：`、`记住：`、`remember:` | 尝试 remember 一次，返回成功、待决或未确认回执 |
| `/nomem` 或 `#nomem` 加空格 | 跳过该输入的自动召回；不改变记忆库模式，收尾检查仍可运行 |
| Stop | 符合条件的回合最多启动一次后台记忆检查；显式存储成功时不启动 |

记忆标题是参考资料，不是指令。插件提醒模型按需读取 `rsrs --client-only prompt`
完整政策。首次显式存储使用暂拟标题和 `important`，不强行指定 parent 或绕过判重。
`pending` 表示**尚未写入**，须由模型读取候选，决定更新、合并或挂靠。
缺少有效成功 ID、超时、取消等情况表示**未确认**：可能已写入，必须先查库，不自动重试。
`plan` 模式跳过显式存储；其他只读、暂停和权限规则由 rsrs 引擎及模型遵循。

### 静默后台记忆检查

仍由 Stop 触发。异步命令启动独立的临时 Codex 任务，通过本地 app-server 读取准确的触发回合，
并在该任务中检查记忆。任务复用原模型、服务商和 Codex 登录，会额外消耗模型用量，
不会新建账号或引擎服务。

0.2.2 先读取不含历史的会话元数据，再分页定位触发回合，只加载该回合正文。
长会话不再需要先通过一次全量历史响应，才能开始记忆收尾。

后台保留原记忆规则：召回、读取完整引擎政策及候选，再按情况更新或选 parent 保存，写入后读回核验。
已保存、无新事实和只读要求均可作为检查结果。不会把整份会话当成记忆导入。
后台工具不开放破坏性合并、强制写入、凭据、引擎生命周期和配置修改；复杂整理需要经过审核的独立任务。

最终归档任务获得受限 rsrs 工具；整理或分段后另有只读的当前回合证据工具。分段提炼任务无工具。
插件、hooks、Shell、外部 MCP 和网页搜索关闭，项目沙箱只读。
读取的是 app-server 回合数据，不解析 transcript 文件；临时任务不加入聊天历史。
正常 Stop 不输出内容，也不返回 `decision: block` 或续跑理由。Codex 仍可能显示普通 hook 活动，
本插件不修改客户端代码。

`archive.status` 分为 `running`、`completed`、`unconfirmed`，完成时保留结果和已核实的写入 ID。
重复事件及失败后重放均不自动重启同一任务。失败时在 `archive.request` 和警告中保留
可用的请求方法与 JSON-RPC 错误码；原始上游错误保留在进程内错误的 `cause`，
不把原始错误正文或数据写入持久状态。失败不假装已保存；
未确认写入须先查库再决定是否重试。父会话结束时 Codex 会取消未完成的后台 hooks，
因此请保持会话打开，直到后台任务完成。

### 大回合与分段归档（0.2.3）

- 成功但零命中的召回（`skip/count=0`）也会触发后台检查；暂停、错误和未知跳过状态不放行。
- 保留原来 256,000 字符的直接归档预算。普通回合完整保留文字和工具证据，不提前裁剪。
- 超预算后才整理工具预览：长输出保留首尾各不超过 6,000 字符，并标记 `PARTIAL`。
  原始工具片段保留在本次后台任务内存中，可按来源编号回读，包括预览省略的中段；不持久保存正文。
- 用户和助手文字不裁剪。整理后仍超预算时，按最多 48,000 字符分段，最多 12 段。
  每段由无工具的临时任务提炼为最多 6,000 字符的候选；全部提炼成功后，才由一个最终任务统一查重、归档和回读。
- 最终任务必须收到或回读全部用户原文，才能写库或成功结束，包括“已保存”“无需保存”和只读结果。
  提炼候选不是独立验证，建议不能当成用户决定；关键工具证据按需回读。
- 分段后的最终输入不超过 128,000 字符；后台总时限仍为 280 秒。超过限额、取消或证据未读均报告未确认，禁止自动重放未确认写入。
  取消会传给正在执行的 rsrs 命令，但不能撤销引擎已经接受的写入，须先查库。
- `archive.progress/context` 只记录阶段、段数、覆盖范围和字符计数；`records` 是已知写入 ID，`checkedRecords` 是成功回执核实的 ID。
  预览为 `partial` 不代表原始中段不可回读，失败时存在 `records` 也不等于验收成功。
- 分段增加模型调用和耗时。非文字附件只保留省略标记，不推断附件内容。

感谢 [aaaaaadi/respire-codex 的修复](https://github.com/aaaaaadi/respire-codex/commit/70f4d726c1c97160dd2e0f3afca4c9beb2bc21c1)，本版吸纳并补充了证据保留及成功出口校验。

### 简短状态提示（0.2.5）

默认显示 `Memory:`、`Used:` 和上次保存结果。若不需要，在启动 Codex 的环境中设置 `RESPIRE_MEMORY_STATUS=0` 关闭。PowerShell 示例：

```powershell
$env:RESPIRE_MEMORY_STATUS = '0'
codex
```

移除该设置或改为 `1` 并新建会话即可重新开启；若变量原本已有值，应恢复原值。桌面客户端须从继承此变量的环境启动；插件不修改系统环境。

- `Memory: N found` 只统计实际注入的安全候选；有候选不等于已采用。
- `Used: 短ID [用途]（简短标题）` 默认显示最多24个Unicode字符（英文、数字、空格和标点也计数）的简短标题，便于识别实际采用的记忆；无标题或标题敏感时使用相应占位提示。它是模型读取正文并实际采用后的说明，不是插件独立测量的采用证明。
- 仅有写入回执显示 `unverified`；全部已知写入都实际回读后才显示 `verified`。无上轮回执时省略标签。
- 后台迟到结果可在后续回合用 `Earlier save` 补报。相同结果最多注入一次；不保证模型已显示或用户已看到。
- 用户要求严格 JSON、固定格式或只输出指定内容时，提示要求省略所有标签。不会为报告状态增加 Stop 续跑。
- 开启提示时为状态预留 hook 上下文空间，标题预算为 1,200 字符；关闭提示时为 1,500。

0.2.4 保留 0.2.3 的大回合原文保护与存储流程。`archive-timeout` 表示后台自身时限到达，`cancelled` 表示父会话取消；模型任务失败的 `archive.failure` 只保留状态、错误类别和可用的 HTTP 状态码，完整上游原因仅留在进程内 `cause`。响应流断连不等于存储成功，未确认结果仍须先查库，不自动重试。

此功能整合自 [PR #1](https://github.com/risense-ai/respire-codex/pull/1)；0.2.5 按用户要求默认显示简短状态，后台 Stop 仍静默执行。

### 日记片段与资料依据（0.2.5）

日记片段要求 **rsrs CLI 1.0.17-dev.9 或具备同等命令的后续版本**，宿主 Runtime 也须支持。旧版受支持引擎仍可使用基础召回和存储。npm `latest` 可能仍是稳定版，测试新接口时须明确选择 dev 版本；新 CLI 的 help 出现命令，不代表正在运行的宿主已更新。

已知引擎限制：dev.9 在多端日记同步冲突后可能将当前正文换回旧版本，原追加内容仍保留在冲突历史中。[CLI #152](https://github.com/risense-ai/respire-cli/pull/152) 已修复该路径，但本插件发布时配套修复 Runtime 尚未公开，本机跨同步持久化复验未完成。写后回读不代表后续同步已收敛；升级修复版后仍须复验，已有冲突需审阅双方正文后单独处理，不自动恢复或重放旧写入。

```sh
rsrs --version
rsrs --client-only --json diary-search "项目历史" --mode hybrid --limit 5 --max-chars 4000
```

- 先查主记忆，仅在追溯历史、主记忆不足或冲突时查日记，不在每轮额外扫描。混合检索的语义准备未完成时使用已有词面结果，不循环等待重建。
- Runtime 首次准备派生语义索引时，可能显示 `embedder` / `diary-fragments` 进度；这不会改写原记忆。限制返回量不等于消除本地全文扫描成本。
- 查询最多 500 个 Unicode 标量；插件最多返回 5 条，`details` 序列化预算最多 4000 字符，包含元数据及 JSON 转义，不是 token 数。片段前后各最多一个邻段；空结果且被截断可能是预算不足。
- 完整保留 `source_id`、`fragment_id`、`source_version`；位置按 Unicode 标量计数，不用 JavaScript UTF-16 下标切片。来源更新后旧定位失效，只读重搜一次再读；能力不支持时不重复调用，也不退回全量日记。
- 日记保持参考状态；版本指纹、高分及存储回读成功均不认证事实。状态提示默认开启，设置 `RESPIRE_MEMORY_STATUS=0` 可关闭；实际采用的资料逐条标为 `[basis]`、`[ref]`、`[history]`，默认参考；只有过期、被替代或冲突的资料才标历史。
- 保留原 Stop 流程：召回、完整政策、候选正文、更新或选择 parent、写后回读。仅日记提炼进入主记忆时要求有来源的长期结论；过程仍存 `trivial` 日记，无标题时遵循引擎按日合并规则。
- CLI 失败只暴露安全类别，如 `diary-unsupported`、`diary-stale`、`runtime-unavailable`。pending 或未确认写入仍须先查库，不自动重试。成功的后台 Stop 保持静默，严格输出格式继续省略状态标签。

本版整合 [PR #2](https://github.com/risense-ai/respire-codex/pull/2)，并适配 [CLI 日记接口约定](https://github.com/risense-ai/respire-cli/blob/main/docs/diary-fragments.md)。

## 配置、状态与隐私

- `RESPIRE_RSRS_PATH`：可选，rsrs 可执行文件路径或命令名，不是 shell 命令。默认 `rsrs`。
- `RESPIRE_CODEX_PATH`：可选，原生 Codex 可执行文件路径。默认先用桌面端提供的
  `CODEX_APP_RUNTIME_CLI_PATH`，再找 PATH 中的 `codex`。Windows 包装器只接收固定启动参数，用户正文通过 JSON stdin 传递。
- `PLUGIN_ROOT`、`PLUGIN_DATA`：由 Codex 提供。插件不向安装目录写状态。
- 每次引擎调用最多 20 秒、stdout 最多 1 MiB；hooks 超时分别为 30/30/300 秒，后台模型任务限时 280 秒。
- Windows 参数通过常量 PowerShell 适配器的 JSON stdin 传递；用户输入不拼接进脚本。
- `PLUGIN_DATA/sessions/` 仅保存哈希标识、处理阶段、去重标志、已核实的写入 ID 及安全的请求诊断（方法/错误码），不保存用户正文、召回标题或密码。
  每会话保留最近 32 回合。较早回合重放不保证去重；不要重放历史存储事件。
- 状态更新使用锁和原子替换。崩溃留下 `.lock` 时，当前会话后续查存会报告失败并跳过，
  不会绕过锁重试。确认该会话 hooks 已停止后，可移除其锁文件或开启新会话；清除状态会失去去重记录。
- 常见凭据模式会被跳过，但这不是完整的秘密扫描器。用户仍应先去除敏感内容。
- 注入的标题与存储回执会进入 Codex 上下文，可能发送给配置的模型服务；本地加密不改变这一点。
- 后台任务还会把触发回合的消息、工具结果和相关记忆交给该模型；回合过大时报告未确认，不静默截断证据。
- 不记录原始引擎 stderr，错误只暴露类别。失败时保留用户原任务继续执行。

## 开发与验证

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run verify:package
```

测试包含真实子进程参数传递、超时与取消、并发存储去重、待决回执、隔离状态和 Stop 防循环。
业务测试使用模拟引擎，不写开发者真实记忆库。
本地开发可将插件目录放进一个本地 marketplace，安装到隔离的 Codex 配置后审核 hooks。
生产桌面完整对话验收需要在目标客户端中单独进行，不能用单元测试代替。

## CI/CD 与 npm 发布

GitHub Actions 在 Windows、Linux、macOS 检查语法、执行测试并核验 npm 包内容。
推送 `v*` 标签会先运行同样的验证，再通过 OIDC 发布 npm（含 provenance），
并创建含 `.tgz` 和 `SHA256SUMS` 的 GitHub Release。预发布标签使用 npm `next`，正式版使用 `latest`。
标签版本必须与 `package.json`、`.codex-plugin/plugin.json` 一致。

新包第一次发布须由 npm 组织维护者登录完成。随后在 npm 包 Settings 添加 Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `risense-ai` |
| Repository | `respire-codex` |
| Workflow filename | `release.yml` |
| Environment | 留空 |
| Allowed actions | 允许 `npm publish` |

无需给仓库配置 `NPM_TOKEN`。只有仓库 workflow 文件不会自动建立 npm 侧信任，须完成上述配置并实际发版验证。
包含 hooks 的插件当前不适用于 OpenAI 公共插件目录，采用手动安装的 marketplace 分发。

接口依据：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、
[Codex hooks](https://learn.chatgpt.com/docs/hooks)。
