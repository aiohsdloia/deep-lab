# OpenLab 到 DeepLab 功能迁移矩阵

日期：2026-08-23

## 判定标准

- **保留**：产品层可直接沿用，只替换底层数据源。
- **重接 dsh**：界面或流程有价值，但必须改用 dsh 原生 domain、projection 或 Cordis plugin。
- **后移**：有价值但不阻塞本地模型和基础研究闭环。
- **删除**：只服务旧 OpenCode/多运行时结构，继续保留会制造双重事实来源。

优先级：P0 为本地模型和基础会话必需，P1 为研究闭环必需，P2 为增强能力，P3 为实验能力。

## 功能矩阵

| 领域 | OpenLab 能力 | DeepLab 当前状态 | 决策 | 优先级 | 验收条件 |
| --- | --- | --- | --- | --- | --- |
| 桌面壳 | Tauri 跨平台桌面应用 | 已保留 | 保留 | P0 | Windows/macOS/Linux 构建通过 |
| 项目 | 项目创建、打开、切换 | 已保留 | 保留 | P0 | 项目目录与 dsh session cwd 一致 |
| 会话 | 新建、历史、搜索、归档 | 基本可用 | 重接 dsh | P0 | event log 重放后 UI 一致，归档不复现 |
| 会话 | 删除、恢复归档 | 仅以归档模拟删除，无恢复 | 后移 | P2 | dsh 提供原生能力或产品明确降级语义 |
| 会话 | fork / 编辑历史消息 | fork 可用，revert 不支持 | 保留 fork，删除伪 revert | P1 | UI 只显示真实可用命令 |
| 队列 | 持久化 prompt queue、steer/edit/remove | UI 有旧逻辑，dsh 投影未接全 | 重接 dsh | P1 | `session/queue` 可重放、编辑、删除、steer |
| 模型 | 每会话模型和 reasoning effort | 基础选择可用，effort 未完整接入 | 重接 dsh | P0 | `session.models.current` 与 UI 一致 |
| 模型 | DeepSeek 官方 API | 已有 key 和模型选择 | 保留 | P0 | key 写入 credentials，真实对话通过 |
| 模型 | 自定义 Provider | UI/旧接口存在，dsh runtime 方法 unsupported | 重接 dsh | P0 | settings namespace 可新增、编辑、删除 |
| 模型 | OpenAI-compatible 本地端点 | 未完成 | 重接 dsh | P0 | LAN 无云请求完成流式工具对话 |
| 模型 | `/models` 自动发现 | 未完成 | 重接 dsh | P0 | 可发现、勾选并保存模型 |
| 模型 | modality/context/compat | 未完成 | 重接 dsh | P0 | 可配置 image、context、token、compat flags |
| 凭据 | API key、云厂商凭据 | DeepSeek key 可用，其他旧 UI 不完整 | 重接 dsh | P0 | 只使用 credentials domain，值不回读 |
| 权限 | restricted/unlimited、逐工具批准 | 基础 preset 可用 | 重接 dsh | P0 | preset 持久化，approval 可响应和恢复 |
| 交互 | ask-user question | 基础事件映射可用 | 保留 | P0 | 多问题、多选、自定义答案契约测试 |
| Goal | 长期目标和自动续行 | RPC 存在但旧版 payload 错误 | 重接 dsh | P1 | CAS、projection、重启恢复均通过 |
| Plan | 计划模式、计划投影 | 旧 UI 存在，dsh projection 未接 | 重接 dsh | P1 | 计划状态完全来自 projection |
| Todo | 任务清单 | 上层 UI 有遗留能力 | 重接 dsh | P1 | 日志重放和实时事件结果一致 |
| Subagent | 子会话、并行、继续、打断 | 仅有旧活动 UI，语义不完整 | 重接 dsh | P1 | list/history/prompt/interrupt 全链路 |
| Workflow | 阶段、并行 pipeline、进度 | 有 starter UI，未接 dsh domain | 重接 dsh | P1 | lifecycle/progress/error 都可恢复 |
| Agent Team | 多智能体团队 | 未接入，上游仍实验 | 后移 | P3 | 上游契约稳定后再设计 UI |
| Jobs | 后台任务和状态 | 未完整接入 | 重接 dsh | P2 | `session/jobs` 实时与重放一致 |
| Compaction | 长上下文压缩 | OpenLab 已修过多次，DeepLab 未验证新版 | 重接 dsh | P0 | 长历史不超时、不重复系统消息 |
| Usage | token、费用、本地零成本 | OpenLab 完整，DeepLab 缺失 | 重接 dsh | P1 | 按 provider/model/session 聚合且本地成本为零 |
| Skills | 技能发现、启停、依赖 | 10 个核心技能，功能不足 | 重接 dsh | P1 | dsh 可发现且依赖检查可执行 |
| Skills | ai4s-agent | 缺失 | 迁移 | P1 | 可驱动完整研究闭环 |
| Skills | research-explorer | 缺失 | 迁移 | P1 | 检索结果进入 Run/Provenance |
| Skills | literature-survey | 缺失 | 迁移 | P1 | 可复现检索、去重、引用 |
| Skills | experiment-suite | 缺失 | 迁移 | P1 | 实验命令、指标和产物可追踪 |
| Skills | paper-writer | 缺失 | 迁移 | P1 | 从证据和实验产物生成草稿 |
| Skills | review/translation/mindmap/integrity | 多项缺失 | 迁移 | P2 | 逐技能真实样例验收 |
| MCP | Jupyter、papers、browser connectors | 设置流程调用 unsupported 方法 | 重接 Cordis | P1 | 插件可安装、启停、健康检查 |
| Notebook | Python/R notebook | OpenLab 完整，DeepLab 保留大部分 UI | 保留 | P1 | 本地 kernel 执行、重连、产物预览 |
| Browser | 浏览器控制 | 上层与代理仍在，配置路径不原生 | 重接 Cordis | P1 | 浏览、下载、截图、引用可追踪 |
| Compute | SSH、Slurm、Modal | 大部分产品层保留 | 保留并重接工具 | P1 | 登录、上传、运行、拉取结果闭环 |
| Artifact | 文件、图片、表格、PDF、Office 预览 | 大部分保留 | 保留 | P1 | tool result 到 inline/panel 稳定 |
| Run | append-only run 记录、SQLite 索引 | 产品层保留 | 保留 | P1 | 每次实验可查询、复现、比较 |
| Provenance | `.openlab/provenance.jsonl` | 仍有旧命名和兼容逻辑 | 保留后迁移命名 | P1 | 旧项目可读，新项目写 `.deeplab` |
| Memory | 全局/项目记忆 | Rust JSON 仍是旧配置语义 | 重接 dsh | P1 | dsh memory/plugin 为唯一写入方 |
| Screen | 多 screen、多 pane、布局 | 产品层保留 | 保留 | P2 | 会话与产物布局可恢复 |
| Gateway | LAN/手机访问 | OpenLab 完整，DeepLab 保留 gateway 基础 | 保留 | P2 | token 鉴权、WS 重连、安全边界通过 |
| i18n | 中英文 | 大部分保留 | 保留 | P2 | 新功能无硬编码用户文本 |
| 更新 | 应用自更新 | DeepLab 当前不应优先 | 后移 | P3 | 核心稳定后再恢复 |
| 多运行时 | OpenCode/ACP runtime 选择 | 已大幅删除 | 删除 | 不适用 | 产品只启动 dsh sidecar |
| ACP server | 外部编辑器驱动 DeepLab | 旧 SDK server 已移除，仅余 dsh-acp 实验脚手架 | 后移 | P2 | 以 dsh adapter 单向接入，并明确它不是第二 runtime |

## 第一批里程碑

### M1：dsh 基础层

- 固定版本和 Node 要求；
- 类型化 RPC 契约；
- Session、Model、Goal、Settings 领域边界；
- 单元测试和构建门槛。

### M2：全本地模型

- 自定义 OpenAI-compatible Provider；
- `/models` 发现与手工模型；
- 无 key LAN 服务；
- 健康检查、首 token、工具调用和长上下文测试。

### M3：原生 Harness 能力

- Plan、Goal、Subagent、Workflow、Queue、Jobs；
- 所有状态从 event/projection 恢复；
- 删除对应的旧运行时模拟逻辑。

### M4：科研闭环

- 五个 P1 科研技能；
- Notebook、Compute、Run、Artifact、Provenance 串联；
- 真实研究任务端到端验收。
