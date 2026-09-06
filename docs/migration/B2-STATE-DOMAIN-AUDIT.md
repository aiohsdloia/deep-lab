# B2 状态域保真 — 现状审计(证据版)

> 目的:逐域判定 DeepLab 的状态是来自 dsh(事件/projection/RPC)还是旧模拟/遗留,
> 列出需要“接 dsh 或显式降级/删除”的项。证据=文件:行。日期:2026-09-05。

判定口径:
- **dsh**:事实来源是 dsh 域(session event / projection / RPC)。
- **DeepLab**:产品层自有(布局、项目、UI 状态)。
- **遗留**:来自 OpenCode/早期模拟,无 dsh 对应,需接 dsh 或显式降级/删除。

## 矩阵

| 域 | 判定 | 证据 | 备注 |
| --- | --- | --- | --- |
| 会话 history/list/archive | dsh | DshRuntime `session.history/list`,`workspace.archiveSession`(rpc-contract.ts) | P0 已完成;归档过滤在 DeepLab |
| Goal | dsh | `DshGoalAdapter`(goal.* + `session/projection` key=goal,DshRuntime.ts:357) | CAS/暂停/恢复/清除;重启从 projection 恢复 |
| approvals / questions | dsh | approval·question requested/resolved + `/api/respond`(types.ts) | 收据、跨客户端解析已实现 |
| subagent | dsh | task 工具派生子会话 + 父映射(runtime.ts:2824、1148) | 面板/打断/归并到顶层会话 |
| compaction | dsh | `session.compacted`(runtime.ts:4445) + history 重放保留 marker(4588) | marker 重开可见 |
| workflow(五技能) | dsh | ai4s skill + `step/start`、`step.updated`(runtime.ts:1036、DshRuntime.ts step/start) | 进度由 dsh 步骤事件驱动 |
| run / provenance | dsh+DeepLab | 应用被动录制 tool 事件→`record_run`/`record_provenance`(runs.ts/provenance.ts) | 本日修复完成事件丢 name/input 与时间戳×1000 两 bug |
| queue | 半:dsh frame 存在但 SDK 未见消费 | types.ts 声明 `session/queue`;DshRuntime 未在 session/event 处理中列出;QueuePanel 主要本地 | **审计项**:确认 dsh 是否真发 queue projection;是则接线,否则 UI 显式标注降级 |
| jobs | 疑似未接 | types.ts 声明 `session/jobs`;SDK 未处理 | **审计项**:dsh v1 是否支持 jobs;不支持则隐藏/移除相关 UI |
| plan | 遗留命名 | runtime.ts:4508 `agent === "build"/"plan"` 仅作旧标签/角色名 | 无 dsh plan 域;DeepLab 用 agentPreset + steps 表达计划行为;**清理或标注** |
| memory | 混合未定 | 全局 MEMORY.md(dsh-home)+ workspace AGENTS/KNOWLEDGE 脚手架;写入方未唯一化 | **审计项**:定唯一写入方(workspace AGENTS/`~` 层 dsh memory?);memory UI 指向哪 |
| todo | 半 | ai4s 用 `todo_write` 工具 + `todo/` 事件;DeepLab 是否渲染待核 | 轻量;随 workflow 面板 |
| remote-runs 合并 | 修复 | 技能 `record_run.py` 由 `.openlab`→`.deeplab`(应用只读 `.deeplab/remote-runs.jsonl`) | 已完成编码迁移(py×2+SKILL×2),待真实 SSH run 验收 |

## 本阶段已完成的修复
1. **SDK 完成事件丢 tool/input**(DshRuntime.ts)——被动录制此前从不触发;回归测试(8 tests)。
2. **SDK 时间戳 ×1000 膨胀**(DshRuntime.ts)——dsh 时间是 epoch-ms;乘 1000 使 wallMs×1000、outputs 归属窗口失效;回归测试。
3. **record_run.py `.openlab`→`.deeplab`**(skills core remote/modal + SKILL session.txt 引用)——否则远程 run 永不并入 Runs 视图。

## 判定补充(2026-09-05)
- **plan/build 角色串(runtime.ts `lastAgentMode`)**:注释与代码表明这是**为兼容导入的旧 OpenCode 历史**读取消息上盖的 agent 戳;dsh 会话的预设来自 `session.list` 作为 fallback。**决策:保留**(非伪运行状态,遵循“不 broad-replace 兼容路径”),不删。
- **memory**:真实写入方 = DeepLab 指令文件(`dsh_config.rs` instructions 数组):项目=工作区 `AGENTS.md`,全局=`/profile/MEMORY.md`;`ensure_global_memory` 另在 dsh-home 根种一份非破坏 `MEMORY.md`(harness 种子)。**残余**:根 MEMORY.md 与 profile MEMORY.md 的定位未统一;是否与 dsh 自有 memory 域冲突待定 → M1 下个微切片:确认/统一全局 memory 单文件,并把 memory UI 指向同一路径。

## 下一批 B2 切片(建议序)
- Q1 队列:验证 dsh 是否发出 `session/queue`;发→接线 QueuePanel,不发→UI 标注“本地草稿队列,非 dsh 权威”。
- J1 jobs:验证 dsh jobs 支持;不支持→隐藏入口(避免假功能)。
- P1 plan 遗留:`build/plan` 角色字符串清理或加注释为仅外观。
- M1 memory:定唯一写入方并把 memory UI 指向它。
- R1 重启恢复契约:加一个无头“跑→杀 dsh→重启→读 projection/history 恢复 goal/队列/marker”契约测试(可基于 run-research-pipeline 的 spawn 模式)。
- T1 远程合并验收:真 SSH 或模拟 remote-runs.jsonl→确认 Runs 视图并入。
