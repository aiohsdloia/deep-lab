# DeepLab Harness 检查报告

## 1. 这份报告要回答什么

这次检查主要是为了把 DeepLab 里面几个容易混在一起的概念分清楚：

- `runtime/harness/` 到底是不是 DeepSeek Harness；
- 真正的 dsh 在项目里由哪些文件负责；
- DeepLab 之前遗留的 Open Lab / OpenCode / ACP 运行时假设，和现在 dsh 的真实机制有什么冲突；
- 后续应该推倒重来，还是在老师已有 DeepLab 方向上继续推进。

检查后的核心结论是：

DeepLab 不应该推倒重来。更合理的路线是保留 Open Lab 的科研工作台功能思路，保留老师已经确定的 dsh 方向，然后继续把旧 OpenCode/ACP 的运行时假设替换成真正 dsh-native 的接入层。

简单说，不是“重写一个新项目”，而是“把底层运行时关系理顺”。

## 2. 我实际检查了哪些文件

这次不是只按概念判断，而是直接看了项目里的这些文件：

- `runtime/harness/README.md`
- `runtime/harness/AGENTS.md`
- `runtime/harness/KNOWLEDGE.md`
- `apps/desktop/src-tauri/src/harness.rs`
- `runtime/dsh/package.json`
- `runtime/dsh/launcher.mjs`
- `runtime/dsh-profile/README.md`
- `runtime/dsh-profile/agent/reviewer.md`
- `runtime/dsh-profile/command/science-review.md`
- `apps/desktop/src-tauri/src/runtime.rs`
- `packages/sdk/src/dsh/DshRuntime.ts`
- `packages/sdk/src/dsh/DshApiClient.ts`
- `packages/sdk/src/dsh/rpc-contract.ts`
- `packages/sdk/src/dsh/DshGoalAdapter.ts`
- `packages/sdk/src/dsh/DshModelAdapter.ts`
- `packages/sdk/src/dsh/DshSettingsAdapter.ts`
- `PROGRESS.md`
- `docs/migration/WEEK-1-BASELINE.md`
- `docs/migration/OPENLAB-FEATURE-MATRIX.md`
- `docs/migration/DSH-ADAPTER-ARCHITECTURE.md`

这些文件基本覆盖了当前 DeepLab 里“工作区 harness”“真正 dsh sidecar”“前端 SDK 适配层”“旧 OpenCode/ACP 迁移痕迹”这几部分。

## 3. 第一个关键发现：`runtime/harness` 不是 DeepSeek Harness 本体

一开始最容易误解的地方，就是仓库里确实有一个目录叫 `runtime/harness/`，但它并不是 DeepSeek Harness 本体。

我打开它的 README 后发现，它自己写的是 `evolve-agent`，也就是一个“自我进化的单 agent 工作区模板”。它里面主要包含：

- `AGENTS.md`
- `KNOWLEDGE.md`
- `knowledge/`
- `notes/`

这些文件的作用是告诉 agent：

- 每次开始工作先读哪些规则；
- 当前知识和状态记录在哪里；
- 每天的工作日志放在哪里；
- 如果总结出稳定经验，怎么写回规则文件；
- 什么时候可以用远程服务器，什么时候默认只在当前 workspace 里工作。

也就是说，`runtime/harness/` 更像是“给每个新科研工作区复制一份 agent 行为说明书和记忆结构”。它解决的是 agent 进入一个 workspace 后“应该怎么工作”的问题。

它本身不负责：

- 启动模型；
- 调用 DeepSeek；
- 管理 session；
- 处理 WebSocket 事件流；
- 管理权限；
- 保存 API key；
- 提供模型列表；
- 执行 dsh 的工具调用。

这个判断在 `apps/desktop/src-tauri/src/harness.rs` 里也能对应上。这个 Rust 文件的注释说得很清楚：这个 harness 是一个 `how to run` scaffold，会被复制到新建的 dated session folder 里，而且复制时不会覆盖用户已有文件。

所以这里要先纠正一个认知：

`runtime/harness` 不是 dsh。它只是 DeepLab 给 agent 准备的 workspace 启动模板。

## 4. 第二个关键发现：真正的 DeepSeek Harness 是 dsh sidecar

真正的 DeepSeek Harness 集成，主要在这几块：

- `runtime/dsh/`
- `runtime/dsh-profile/`
- `apps/desktop/src-tauri/src/runtime.rs`
- `packages/sdk/src/dsh/`

`runtime/dsh/package.json` 里固定了 dsh 版本：

```json
"@deepseek-ai/dsh": "0.1.1-rc.2"
```

这说明 DeepLab 不是随便调用一个系统里已有的 dsh，而是把一个固定版本的 dsh 打包进项目里。这样做的好处是：上游 dsh 如果更新协议，DeepLab 不会突然跟着坏掉。

DeepLab 启动 dsh 的方式大致是：

```text
dsh --profile web --host 127.0.0.1 --port <port>
```

也就是说，dsh 会作为一个 sidecar 进程在本机或运行环境里启动，然后 DeepLab 通过它的 `/api` 接口通信。

这里要注意：前端不是直接随便访问 dsh。桌面端还有一个 internal gateway，因为 dsh 对浏览器来源有安全限制。DeepLab 的 WebView 不能直接跨 origin 访问 loopback sidecar，所以需要由内部 gateway 转发 HTTP 和 WebSocket。

DeepLab 和 dsh 的通信方式主要是：

- HTTP POST：`/api/<method>`
- WebSocket：`/api/events.mux`
- WebSocket：`/api/events.host`

这才是真正的运行时边界。

## 5. 第三个关键发现：`DSH_HOME` 很重要，但它不是“必须跑在我的电脑上”的意思

之前我们讨论“本地”时容易有歧义。这里检查代码后可以说清楚：

DeepLab 启动 dsh 时会设置一个 app-private 的 `DSH_HOME`。

在 `apps/desktop/src-tauri/src/runtime.rs` 里，启动 dsh sidecar 时设置了：

- `DSH_HOME`
- `DSH_AGENTS_HOME`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`
- `XDG_CACHE_HOME`
- `XDG_STATE_HOME`

这些目录都在 DeepLab 自己的 app-private runtime root 下面。

它的作用不是说模型必须部署在用户自己的电脑上，而是说 DeepLab 使用的 dsh 运行环境要和用户系统里的全局 dsh 隔离开。

这样做有几个实际好处：

1. 不会污染用户自己的 `~/.dsh`。
2. 不会误读旧 Open Lab 留下来的全局 skills。
3. DeepLab 可以自己打包、部署、管理 dsh profile、skills、memory 和配置。
4. 不同机器上的全局环境差异不会轻易影响 DeepLab。

`PROGRESS.md` 里已经记录过一个真实问题：旧 Open Lab 的中文 skills 曾经泄漏进 DeepLab sessions。后来通过设置 app-private `DSH_AGENTS_HOME`，让 dsh 不再扫描用户全局 `~/.agents/skills`，这个问题才解决。

所以后面说“本地模型”时，更准确的理解应该是：

模型可以部署在实验室服务器上，DeepLab 通过服务器密钥或内网 endpoint 调用；但 DeepLab 自己的 dsh 运行环境要保持隔离、可控、可复现。

换句话说，DeepLab 不应该变成推理服务器。实验室服务器提供模型服务，DeepLab 把它作为 dsh provider 接进来。

## 6. 第四个关键发现：旧 runtime 假设和 dsh 的真实协议不完全兼容

这周做的很多工作，表面看是 SDK 修改，实际是在修正旧假设和 dsh 真实机制之间的冲突。

### 6.1 Goal 不是只传 `sessionId`

旧逻辑容易把 Goal 理解成某个 session 上的一个简单状态，所以 pause、resume、complete 只传 `sessionId` 好像就够了。

但 dsh 真实协议不是这样。dsh 的 Goal 操作需要带：

```ts
{ id: string; revision: number }
```

这个结构说明 dsh 对 Goal 做了版本控制。也就是说，当前 Goal 不只是“有或没有”，还要知道它是哪一个版本。这样可以避免多个客户端、重连、历史恢复时改错状态。

现在 `DshGoalAdapter` 做的事情就是：

- 从 dsh projection 里读取当前 Goal；
- 缓存 Goal 的 `{ id, revision }`；
- pause / resume / complete / clear 时带上正确 ref；
- 如果缓存没有，就从 `session.history` 里恢复。

这说明第一周不是简单写包装代码，而是把 Goal 接到 dsh 的真实状态模型上。

### 6.2 模型列表不能按旧 provider 假设读

旧代码里有一些对 provider 字段的假设，但 dsh 当前模型目录是按 `groups[].id` 来组织的，当前模型选择来自 `session.models.current`。

现在 `DshModelAdapter` 做的是：

- 通过 `llm.models` 读取 dsh 的实时模型目录；
- 通过 `session.models` 读取当前 session 的模型；
- 通过 `session.selectModel` 选择模型；
- 并利用 dsh 的行为，把成功选择过的模型作为之后 session 的默认模型。

这个变化说明：DeepLab 后续不应该自己维护一套独立的“假模型列表”，而应该跟随 dsh provider catalog。

实验室服务器模型也应该走这个方向：把实验室 DeepSeek V4 Flash / Pro 作为 dsh provider，而不是在 DeepLab 里另写一套模型调用逻辑。

### 6.3 权限和 API key 应该走 dsh 的 settings / credentials

`DshSettingsAdapter` 现在负责两类事情：

- permission preset；
- provider API key。

权限方面，它把 DeepLab 的 restricted / unlimited 映射到 dsh 的：

- `workspace-write`
- `danger-full-access`

API key 方面，它通过 dsh 的 `credentials.set` 写入，而不是写到项目文件、日志、报告、provenance 或 git 里。

这个点对科研项目很重要。因为 DeepLab 后面会产生大量实验记录和导出文件，如果 key 混进这些文件，风险很高。

### 6.4 session history 也要按 dsh 事件来折叠

`DshRuntime` 里做了很多事件折叠工作。比如：

- dsh 的文本流是 delta，前端需要的是累计文本；
- dsh 的 tool result 可能在嵌套 content 里；
- dsh 会把系统注入的上下文也记成 `user/message`，但 UI 不能把这些都当成用户发言；
- dsh 的 session title 有时在 projection 里，而不是顶层字段；
- dsh 的 `session.list` 不能完全满足 DeepLab 归档会话逻辑，所以 DeepLab 需要从 workspace state 过滤 archived session。

这些都说明 dsh 是事实来源，但 DeepLab 需要做一层适配，把 dsh 的事件流转换成 UI 能稳定使用的结构。

## 7. 第五个关键发现：旧 OpenCode / ACP 痕迹还没有完全清干净

从 `PROGRESS.md` 和迁移文档看，项目已经做过一轮比较大的清理：

- 删除 `OpenCodeClient`；
- 删除 ACP runtime；
- 删除 ACP settings UI；
- `opencode_config.rs` 改成 `dsh_config.rs`；
- `runtime/opencode-profile` 改成 `runtime/dsh-profile`；
- Open Lab / OpenScience / OpenCode 的很多名字已经改成 DeepLab / dsh。

但是还不是完全干净。

`PROGRESS.md` 里明确写了一个遗留问题：`runtime/tools/` 里还有工具使用 `@opencode-ai/plugin`。它们现在可能还能运行，因为 dsh 兼容或能加载一部分旧形式，但这不是长期应该保留的状态。

所以我对当前项目状态的判断是：

DeepLab 不是从零开始，也不是完全混乱；它已经走到 dsh-only 的方向上了。但中间层还有一些旧运行时残留，需要继续收束。

## 8. dsh 和之前 harness / runtime 的具体区别

| 对比项 | 之前的 workspace harness / OpenCode / ACP 思路 | 现在 dsh 思路 |
| --- | --- | --- |
| 本质 | 工作区规则、记忆模板、旧 runtime 适配混在一起 | dsh 作为唯一 agent runtime |
| 启动方式 | DeepLab 自己承担更多运行时逻辑 | DeepLab 启动 dsh sidecar |
| 通信方式 | 旧 OpenCode/ACP 或自定义接口假设 | dsh `/api` HTTP + WebSocket |
| 状态来源 | DeepLab 自己保存和解释较多状态 | dsh session log + projection 是事实来源 |
| Goal | 容易按 sessionId 简单操作 | dsh 使用 `{ id, revision }` 版本引用 |
| 模型 | 旧 provider/model UI 假设较多 | dsh `llm.*` 和 `session.models` |
| 权限 | DeepLab 自己承担更多策略 | dsh permission preset |
| API key | 容易扩散到 app 配置 | dsh credentials domain |
| Skills | 有旧 OpenCode plugin 痕迹 | 应迁移到 dsh skills / native tool schema |
| 工作区规则 | `runtime/harness` 复制规则和记忆 | 仍然有用，但不是 runtime |

## 9. 接入 dsh 的优势

### 9.1 更符合 DeepSeek agent 的原生能力

如果 DeepLab 的目标是围绕 DeepSeek agent 做科研工作区，那么 dsh 比旧 OpenCode/ACP 更合适。DeepSeek 不应该只是“一个模型选项”，而应该通过 dsh 成为 agent runtime 的中心。

### 9.2 更适合做科研过程追踪

科研工作不是只要最后回答。它需要知道：

- 输入是什么；
- agent 做了哪些步骤；
- 调用了哪些工具；
- 改了哪些文件；
- 生成了哪些图表和报告；
- 哪个模型参与了；
- reviewer 发现了什么问题。

dsh 的 session log、event stream、projection 比较适合做这个基础。DeepLab 应该在它上面做 provenance，而不是另造一套重复状态。

### 9.3 更方便切换实验室服务器模型

后面如果用实验室的 96G 或 8x4090 服务器部署 DeepSeek V4 Flash / Pro，DeepLab 不应该自己写推理服务。

更合理的是：

实验室服务器提供 OpenAI-compatible 或 dsh-compatible endpoint，DeepLab 把它配置成 dsh provider，然后通过 dsh 选择模型、调用模型、记录模型信息。

这样架构更清楚，也更容易维护。

### 9.4 更安全、更可复现

app-private `DSH_HOME` 和 `DSH_AGENTS_HOME` 能避免用户全局环境污染 DeepLab。这对实验室项目很重要，因为不同机器上装过什么、配置过什么、有什么旧 skill，都不应该影响实验结果。

### 9.5 reviewer agent 已经有雏形

`runtime/dsh-profile/agent/reviewer.md` 已经定义了一个只读 reviewer agent。它不是普通聊天，而是专门检查科研工作：

- traceability；
- statistics；
- units；
- provenance；
- reproducibility。

这个方向非常适合 DeepLab。后面可以把 reviewer 做成科研 workflow 的固定一环。

## 10. dsh 的劣势和风险

### 10.1 dsh 版本还在变

当前固定的是 `0.1.1-rc.2`，说明它还不是特别稳定的成熟接口。

这周已经遇到真实协议差异：

- Goal 需要 CAS ref；
- model group 字段和旧假设不同；
- 当前模型要从 `session.models.current` 读；
- `session.list` 不完全满足 DeepLab UI 归档逻辑。

所以 dsh 方向是对的，但不能裸接。必须保留明确的 adapter 层和 contract test。

### 10.2 Open Lab 的一些功能 dsh v1 还没有原生支持

目前已知 dsh v1 缺口包括：

- `revert` / `unrevert`；
- synthetic `appendTextPart`；
- runtime `addCustomProvider`；
- runtime `addMcpServer`；
- OAuth authorize/callback；
- 完整分页的 `session.list`。

这意味着 DeepLab 不能假装这些功能都已经有了。没有 dsh 原生能力的地方，要么隐藏，要么明确降级，要么重新设计。

### 10.3 gateway 复杂度是真的

dsh 有浏览器来源安全限制，DeepLab WebView 不能直接访问 loopback sidecar，所以桌面端需要 internal gateway 转发 HTTP 和 WebSocket。

这部分已经能工作，但它是一个需要持续测试的基础设施点。

### 10.4 旧 OpenCode plugin 残留会影响长期架构清晰度

如果 `@opencode-ai/plugin` 这类遗留工具不清理，项目后面会变成一部分 dsh、一部分 OpenCode、一部分 DeepLab 自定义逻辑。短期能跑，长期会越来越难维护。

## 11. 第一周实际完成了什么

第一周的主要成果不是做完一个完整产品功能，而是把方向和底层接入方式变得可验证。

已经完成的工作包括：

- 明确区分 `runtime/harness` 和真正 dsh runtime；
- 确认 DeepLab 不应该推倒重来；
- 确认 Open Lab 的科研工作台功能要保留；
- 确认 dsh 应该作为唯一 agent runtime；
- 固定 dsh 版本；
- 新增 dsh RPC contract；
- 新增 `DshGoalAdapter`；
- 新增 `DshModelAdapter`；
- 新增 `DshSettingsAdapter`；
- 修复 Goal CAS 协议；
- 修复模型目录和当前模型读取方式；
- Settings 页面改为接 dsh live provider catalog；
- 清理一部分旧 ACP / OpenCode 构建引用；
- 增加 dsh contract 测试；
- 新增 BCI literature trends demo starter，作为后续能展示的科研闭环入口；
- 完成 typecheck、lint、测试、构建和 Rust source check。

所以第一周可以这样概括：

我们不是随便写了一个新壳子，而是把 DeepLab 从“名义上接 dsh”推进到“开始按 dsh 的真实协议接入”。

## 12. 我对 DeepLab 后续推进的判断

我建议 DeepLab 接下来按三层推进。

### 12.1 第一层：保留 Open Lab 的科研产品能力

Open Lab 的价值不能丢。DeepLab 后面仍然要保留和迁移这些能力：

- 项目工作区；
- 文件和 artifact；
- 实验记录；
- 报告生成；
- provenance；
- workflow starter；
- reviewer；
- 本地或实验室私有数据处理。

这些是 DeepLab 区别于普通 AI chat app 的地方。

### 12.2 第二层：让 dsh 成为唯一 runtime 事实来源

以后和 agent 运行有关的状态，应该尽量来自 dsh：

- session 来自 dsh session log；
- Goal 来自 dsh goal projection；
- 模型来自 dsh `llm.*` 和 `session.models`；
- 权限来自 dsh permission preset；
- API key 来自 dsh credentials；
- skills 来自 app-private dsh home 和 workspace `.dsh/skills`。

DeepLab 的 UI 不应该直接知道 dsh 的所有底层细节，而是通过 `packages/sdk/src/dsh/` 这一层适配。

### 12.3 第三层：先做能展示的科研 demo，再做实验室模型迁移

我不建议下一步先卡在“必须先部署实验室模型”。实验室模型当然重要，但它应该是 provider 切换问题，不应该成为 DeepLab 证明自己价值的前置条件。

更好的顺序是先做一个 dsh-backed 科研 demo，证明 DeepLab 能完成一个闭环：

1. 打开一个准备好的科研 workspace；
2. agent 读取本地 seed data；
3. agent 编写分析脚本；
4. agent 生成 processed data；
5. agent 生成 figure；
6. agent 写出 report；
7. provenance 记录过程；
8. reviewer agent 检查结果；
9. UI 能清楚展示这些产物。

BCI trends starter 正好适合作为第一个 demo，因为它不依赖远程论文抓取，也不依赖先部署大模型服务器，但能展示科研流程。

## 13. 建议的下一步里程碑

### Milestone A：完成 BCI trends demo 闭环

验收标准：

- 一键 starter 能打开 BCI workspace；
- agent 能生成 `scripts/analyze.py`；
- agent 能生成 processed CSV；
- agent 能生成 figure；
- agent 能生成 `reports/report.md`；
- provenance 能记录关键过程；
- reviewer 能审查结果；
- UI 能展示报告、图表和检查结果。

这是最应该优先做的，因为它能给老师一个可见成果。

### Milestone B：清理旧 OpenCode plugin 残留

验收标准：

- 找出所有 `@opencode-ai/plugin` 使用点；
- 判断每个工具是删除、改写，还是暂时保留；
- 高价值工具改成 dsh-native schema；
- 给工具调用和结果展示补测试。

这个任务能让项目架构更干净，避免以后越迁越乱。

### Milestone C：接入实验室模型服务器

验收标准：

- 明确实验室服务器的模型服务协议；
- 如果是 OpenAI-compatible endpoint，就作为 dsh provider 接入；
- key 和 base URL 不进入项目文件；
- 能完成一次真实对话；
- provenance 能记录使用的 provider 和 model。

这个应该作为 demo 之后的 provider milestone，而不是第一步。

### Milestone D：把 reviewer 做成正式科研 workflow

验收标准：

- agent 生成报告后可以触发 reviewer；
- reviewer 保持只读；
- reviewer 输出结构化 findings；
- UI 能把 findings 展示出来；
- reviewer 只说检查了什么、发现了什么，不承诺结果一定正确。

这个会成为 DeepLab 和普通 agent 工具的明显区别。

## 14. 最终判断

DeepLab 不应该推倒重来。

更准确的推进路线是：

> 保留 Open Lab 的科研工作台能力，保留老师确定的 dsh 方向，继续把中间运行时接入层做实，把旧 OpenCode/ACP 假设逐步替换为 dsh-native 的实现。

也可以换一种更口语化的说法：

> Open Lab 给的是科研工作流的形状，dsh 给的是 DeepSeek agent 的运行能力，DeepLab 要做的是把这两件事接好，而不是简单复制 Open Lab，也不是另起炉灶重写。

近期最应该优先拿出的成果，是一个能跑通的科研 demo，而不是先把全部精力放在实验室模型部署上。模型服务器后面一定要接，但它应该作为 provider 接入，而不是 DeepLab 的核心风险点。

