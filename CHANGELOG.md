# Changelog

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
