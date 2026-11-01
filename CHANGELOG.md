# Changelog

## 0.2.14 — 复审整改（第二轮）：回读 show 由真实可中断子信号约束（PR #7 review round 2）

### Fixed

- **race→abort signal（复审 P2）**：`Promise.race`+guard 定时器只限制 `handleHook` 的等待，不终止真实子进程——show 子进程＋执行器 20s 定时器＋pipe 会把 hook 进程拖到宿主 30s 之外（复审复现：慢 remember 18s＋挂起 show 时旧码 hook 进程存活 ~38.9s）。现在回读改为 `execute(['show', id], { signal: AbortSignal.timeout(remaining - 500) })`：信号触发时 rsrs 执行器终止整棵子进程树（Windows `taskkill /PID <pid> /T /F`，失败回退 `child.kill()`；POSIX `kill(-pid, SIGKILL)` 回退 `child.kill()`），close 处理清理 20s 定时器与 abort 监听器并 reject `cancelled`，hook 归为 `Read-back unavailable` 回执后在预算内自然退出（同场景新码 ~27.6s/预算 30s；测试场景 8s 预算 ~5.5s 退出），Saved 回执不被吞；宿主取消传播（SIGINT/SIGTERM→main 的 AbortController→remember 路径）保持不变；`AbortSignal.timeout` 的内部定时器不保持事件循环。
- **集成测试（真实子进程，经实际打包入口）**：临时 stub engine（Windows 经 `.ps1` wrapper 包 node 慢脚本、POSIX 直接 shebang 脚本：remember ~1s 成功、show ~15s 挂起），`RESPIRE_HOOK_BUDGET_MS=8000`，执行 `hooks/hooks.json` 里 UserPromptSubmit 的真实 command（含带空格的 PLUGIN_ROOT）：断言 hook 进程 <10s 退出、exit code 0、stdout 回执含 Saved 与 Read-back unavailable、show 子进程 PID 已终止（Windows `tasklist`／POSIX `kill(pid,0)` ESRCH）、同 turn 重放 remember 仅调用一次（duplicate event 回执）。
- 单元测试同步改用尊重 `options.signal` 的桩（abort 时 reject，模拟真实 runRsrs 子进程），不再注入永不 settle 的裸 Promise。

## 0.2.13 — 复审整改：回读共享宿主预算＋全文核验（PR #7 review）

### Fixed

- **回读共享宿主时间预算（复审#1）**：快存 `remember`→`show` 共用 UserPromptSubmit 的 30 秒宿主预算（环境变量 `RESPIRE_HOOK_BUDGET_MS` 可覆盖，默认 30000）——预留 2.5s 输出/清理余量后剩余 <1.5s 时直接 `unavailable`，不再发起 show；show 以 `Promise.race` 包裹剩余时间（再留 500ms），race 超时按 `unavailable` 立即回执，不等待子进程（由 rsrs 执行器自身 20s 超时/宿主清理兜底），不再出现 remember+show 顺序执行超掉宿主 30s 上限。
- **verified 升级为全文核验（复审#2）**：verified 必须同时满足 `summary.id === id`（完整 id 相等）、`entry.title === sentTitle`（标题相等）、`entry.content === content`（仅剥离首尾空白的规范化后全文相等）——不再只查标题＋前 40 字包含；畸形信封（summary/entry 非对象）降级 `unavailable` 并保留 Saved 回执；id 不匹配或正文不同走 DIFFERENT 分支，文案明示可能是错误 id。
- **测试**：契约测试补反例——show 返回错误 id、前 40 字相同尾部 `TAMPERED`、正文缺失（entry.content undefined）、慢 remember＋挂起 show＋紧预算（预算内回执 unavailable；另补 race 生效场景，均断言总耗时 <6s）。
- 复审#3（双 manifest 版本不一致）已由 0e5985f 先行修复（plugin.json bump 至 0.2.12，CI 已绿），本版本同步 bump 两处 manifest 至 0.2.13。

## 0.2.12 — 审计整改：warn 写入契约＋写后回读＋agent-config 硬前置（CX-01/CX-02）

### Fixed

- **warn=已写入（CX-01/§7.1）**：`rsrs.js` 不再把 remember 的 `warn`（rc=2，已提交带警告如 parent 未解析）当错误拒绝——warn 信封携带真实 id 上送回执层；`storeText` 新增 warn 分支（`stored:true`、附错误摘要、明示不得重发），快存与后台 worker（`memoryTools`）都按已写入处理。
- **写后回读（CX-01/R11）**：快存 ok/warn 后自动 `show <id>` 核验——verified / mismatch / unavailable 如实进回执，读回失败不阻塞回执。
- **pending 转达建议动作（§7.2）**：pending 回执保留引擎 `actions` 全量（merge > attach > new），不再缩成 parent/force 两项。
- **agent-config 硬前置（CX-02）**：后台 worker 的写路径在执行器层强制要求先成功读取 `agent-config`（`mode-unconfirmed` 拒绝）——不再是仅靠提示词的软要求；plan 只读与引擎拒绝保持兜底。

### Changed

- 测试：新增「warn 写入/pending 动作/回读三态」契约测试与「写前必须 agent-config」闸门测试；既有夹具按新契约补 `agent-config` 步骤（49 → 51 全绿）。

## 0.2.11
- Archive worker prompts translated to English.
