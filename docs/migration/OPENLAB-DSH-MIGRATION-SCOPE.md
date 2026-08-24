# OpenLab 到 DeepLab 功能迁移范围报告

日期：2026-08-24

## 1. 核心问题

DeepLab 的目标不是单独做一个 BCI 工具，也不是只做几个新的科研 demo。

更准确的目标是：

> 以 OpenLab 的主要功能为基线，把它迁移到 DeepLab 上；同时把底层 agent harness 从 OpenCode / ACP 旧逻辑迁移到 DeepSeek Harness，也就是 dsh。

这里最容易误解的一点是：迁移不是简单复制 UI，也不是把底层名字从 OpenCode 改成 dsh。因为 dsh 比 OpenCode 管得更宽，它不只是帮 agent 执行任务，还接管了 session、Goal、模型、权限、credentials、skills、事件流和一部分状态恢复。

所以这次迁移要解决的是两个问题：

1. OpenLab 哪些产品功能必须保留到 DeepLab；
2. 这些功能里，哪些底层能力应该交给 dsh 接管，以及 DeepLab 需要怎么改 dsh 接入层，让它符合 OpenLab 原来的产品要求。

## 2. 总体判断

DeepLab 应该采用“三层分工”：

| 层级 | 负责什么 | 迁移原则 |
| --- | --- | --- |
| OpenLab 产品层 | 项目、文件、工作区、报告、产物、运行记录、科研流程 | 尽量保留，因为这是 OpenLab 的核心价值 |
| dsh runtime 层 | session、Goal、Plan、模型、权限、credentials、skills、事件流 | 尽量交给 dsh 接管，但要做适配 |
| DeepLab 适配层 | 把 OpenLab 的产品要求翻译到 dsh 的真实协议上 | 不能伪造状态，不能保留双重事实来源 |

这意味着后续开发的重点不是“照抄 OpenLab”，也不是“完全相信 dsh 默认行为”。正确做法是：

> 产品体验以 OpenLab 为基线，运行时状态以 dsh 为事实来源，中间由 DeepLab 的 adapter / profile / plugin composition 负责对齐。

## 3. 什么叫“被 dsh 接管”

这里的“接管”不是说 DeepLab 不管这个功能了，而是说这个功能的底层事实来源不应该再由 DeepLab 自己保存一份。

比如：

- session 历史应该来自 dsh session log；
- Goal 状态应该来自 dsh goal projection；
- 当前模型应该来自 dsh `session.models.current`；
- provider 列表应该来自 dsh `llm.*`；
- API key 应该走 dsh `credentials.*`；
- 权限应该走 dsh permission preset；
- skills 应该由 dsh 发现和加载；
- tool call / result 应该来自 dsh event stream。

DeepLab 还要做 UI、索引、展示、校验、provenance，但不能再自己维护另一套“看起来像 runtime 状态”的东西。否则会出现两套状态不一致的问题。

## 4. 迁移功能清单

下面按 OpenLab 的主要功能域来拆。

### 4.1 项目和工作区

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| 项目创建 | 保留 DeepLab 产品层 | 否 | 保证新项目目录和 dsh session cwd 一致 |
| 项目打开 / 切换 | 保留 DeepLab 产品层 | 否 | 切换工作区时同步 SDK runtime directory |
| 项目导入 | 保留 DeepLab 产品层 | 否 | imported 项目只建索引，不随意改用户原目录 |
| 项目 pin / color | 保留 DeepLab 产品层 | 否 | 保存在 `.deeplab/project.json` |
| workspace metadata | 从 `.openlab` 迁移到 `.deeplab` | 否 | 保持旧项目可读，新项目写新路径 |
| 新 session workspace seed | 保留 `runtime/harness` | 部分 | `runtime/harness` 只是规则模板，不是 dsh 本体 |

判断：

项目和工作区是 OpenLab 的产品层核心，不能交给 dsh。dsh 只需要知道当前 cwd，在这个工作区里运行 agent。DeepLab 要保证项目路径、session cwd、文件预览、provenance 都指向同一个真实目录。

优先级：P0。

### 4.2 Session、历史记录和搜索

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| 新建 session | 重接 dsh | 是 | 使用 `session.create`，cwd 必须正确 |
| session 历史 | 重接 dsh | 是 | 从 `session.history` 和 event stream 折叠 UI |
| session 搜索 | 重接 dsh | 是 | 使用 dsh `session.search`，不足处由 DeepLab 做展示层分页 |
| 归档 / 删除 | 部分重接 | 部分 | dsh `session.list` 不过滤 archived，需要 DeepLab 过滤 |
| 恢复归档 | 后移 | 取决于 dsh | dsh v1 暂无完整恢复语义，不能假装已支持 |
| fork | 保留并重接 dsh | 是 | 用 dsh `session.fork`，UI 只展示真实可用行为 |
| 编辑历史消息 / revert | 不照搬 | 否 | dsh v1 无 revert RPC，UI 应隐藏或改为 fork |

判断：

Session 是 dsh 接管最明显的地方。DeepLab 不应该自己保存另一套聊天历史。DeepLab 的工作是把 dsh 的 log/event/projection 转成 OpenLab 原来那种好用的会话界面。

优先级：P0。

### 4.3 Prompt queue、steer 和后台续跑

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| prompt queue | 重接 dsh | 部分 | UI 可保留，但底层应读 dsh queue/projection |
| steer 当前任务 | 重接 dsh | 是 | 使用 dsh `session.prompt` 的 steer / queue 语义 |
| queue edit/remove | 重接 dsh | 取决于 dsh 能力 | 如果 dsh 没有完整能力，UI 必须明确降级 |
| crash 后恢复队列 | 重接 dsh | 应交给 dsh | 本地缓存只能作为 UI 恢复辅助，不能是事实来源 |

判断：

OpenLab 原来有比较完整的 queue 体验，这是很重要的产品功能。但 dsh 已经接管 session 运行和 prompt 进入方式，所以 DeepLab 不能继续只靠 localStorage 维护真正队列状态。下一步要查清 dsh queue projection 的完整能力。

优先级：P1。

### 4.4 Goal、Plan、Todo 和长期任务

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| Goal 创建 | 已开始重接 dsh | 是 | 使用 `goal.create` |
| Goal pause/resume/complete/clear | 已开始重接 dsh | 是 | 必须带 `{ id, revision }` |
| Goal 重启恢复 | 重接 dsh | 是 | 从 projection 恢复，不从 UI 状态猜 |
| Plan | 重接 dsh | 是 | 接 dsh plan projection，而不是旧 UI 自己推断 |
| Todo | 重接 dsh | 可能 | 确认 dsh 是否有 todo projection / event |
| 长期自动续跑 | 重接 dsh | 是 | 由 dsh goal loop 管，DeepLab 做控制和展示 |

判断：

这部分是 dsh 相比 OpenCode 更“管得宽”的典型例子。OpenCode 更像执行任务，dsh 把长期目标本身也纳入状态管理。DeepLab 要做的是把 OpenLab 想要的长期任务体验，接到 dsh 的 Goal / Plan / projection 上。

已完成基础：`DshGoalAdapter` 已处理 Goal CAS 和 projection 恢复。

优先级：P1。

### 4.5 模型、Provider 和实验室服务器

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| 模型列表 | 重接 dsh | 是 | 使用 dsh `llm.models` |
| 当前模型 | 重接 dsh | 是 | 使用 `session.models.current` |
| 每 session 模型选择 | 重接 dsh | 是 | 使用 `session.selectModel` |
| reasoning effort | 重接 dsh | 是 | 补完整 UI 与 dsh 字段映射 |
| DeepSeek 官方 API key | 已开始重接 dsh | 是 | 走 `credentials.set` |
| 自定义 provider | 重接 dsh | 是 | 通过 dsh settings namespace，而不是旧 runtime API |
| OpenAI-compatible 本地/实验室端点 | 重接 dsh | 是 | 实验室服务器作为 dsh provider 接入 |
| `/models` 自动发现 | 重接 dsh | 是 | 使用 `llm.discoverModels` |
| context / modality / max tokens | 重接 dsh | 是 | 需要把 OpenLab UI 映射到 dsh provider 配置 |

判断：

模型能力必须由 dsh 接管。DeepLab 不应该直接调用模型，也不应该自己做推理服务。实验室服务器的 DeepSeek V4 Flash / Pro 应该作为 dsh provider 接入。

但 OpenLab 原有的模型配置体验不能丢。要做的是让 dsh 的 provider / credentials / settings 符合 OpenLab 的使用要求，比如能配置 base URL、API key、模型发现、context window、reasoning effort、本地成本显示。

优先级：P0。

### 4.6 Credentials 和安全

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| API key 保存 | 重接 dsh | 是 | 使用 dsh credentials domain |
| key 是否已设置 | 重接 dsh | 是 | 只能显示状态，不回读明文 |
| provider 删除 key | 重接 dsh | 是 | 使用 `credentials.unset` |
| OAuth | 后移 / 明确不支持 | 取决于 dsh | dsh v1 无 OAuth RPC，不能保留假入口 |
| 导出设置 | DeepLab 保留 | 部分 | 不导出 secret |
| provenance / log 安全 | DeepLab 保留 | 否 | 严禁写入 key |

判断：

这部分产品要求来自 OpenLab，但底层必须走 dsh。OpenLab 的核心要求是安全和可复现，dsh 的 credentials domain 是更合适的落点。

优先级：P0。

### 4.7 权限和审批

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| restricted / unlimited 模式 | 重接 dsh | 是 | 映射到 dsh permission preset |
| command approval | 重接 dsh | 是 | 接 dsh approval event |
| file deletion approval | 重接 dsh | 是 | 需要 dsh 工具权限正确表达 |
| dependency install approval | 重接 dsh | 是 | 需要审批事件可恢复 |
| remote connection approval | 混合 | 部分 | DeepLab 管 SSH 配置，dsh 管 agent 调用审批 |
| approval UI | DeepLab 保留 | 否 | UI 要展示 dsh approval 请求并回写结果 |

判断：

权限是 dsh 接管，但 DeepLab 负责产品表达。也就是说，谁来判断权限、发 approval request，应尽量交给 dsh；但用户看到的弹窗、解释、确认流程，是 DeepLab 的 UI 工作。

优先级：P0。

### 4.8 Skills 和工具

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| skill 发现 | 重接 dsh | 是 | 使用 dsh `skill.list` |
| core science skills | 迁移 | 是 | 部署到 app-private `<dsh-home>/skills` |
| workspace skills | 保留并重接 | 是 | 使用 workspace `.dsh/skills` |
| skill 启停 / 健康检查 | 重接 dsh | 部分 | dsh 能力不足时需要补 plugin composition |
| OpenCode plugin 工具 | 迁移 / 清理 | 否 | `@opencode-ai/plugin` 残留要改 dsh-native |
| 工具结果展示 | DeepLab 保留 | 否 | 从 dsh tool event 提取 artifact |

判断：

OpenLab 的 skill 生态是重要资产，但在 DeepLab 里不能继续长期依赖 OpenCode plugin 形态。短期可以兼容，长期要迁到 dsh 的 skills / native tool schema。

优先级：P1。

### 4.9 MCP、浏览器和外部连接器

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| MCP server 配置 | 重接 dsh | 是 | dsh 通过 Cordis 配置，不是 runtime `addMcpServer` |
| Jupyter MCP | 重接 dsh + DeepLab kernel | 部分 | agent 工具走 dsh，notebook UI 由 DeepLab 保留 |
| browser connector | 重接 dsh | 部分 | 浏览器工具要通过 dsh tool / MCP 接入 |
| papers / literature connector | 迁移 | 部分 | 检索结果必须进入 run/provenance |
| connector health check | DeepLab 保留 | 部分 | UI 做检查，底层连接由 dsh/Cordis 管 |

判断：

MCP 是一个很典型的“OpenLab 想要产品能力，dsh 接管底层连接方式”的区域。DeepLab 不应该继续调用旧 `addMcpServer`，因为 dsh v1 是通过 Cordis 配置 MCP。我们要改的是配置生成、启停、健康检查和 UI 状态，而不是保留旧 runtime API。

优先级：P1。

### 4.10 Notebook、Kernel 和代码执行

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| `.ipynb` 编辑 | DeepLab 保留 | 否 | notebook UI 和文件读写保留 |
| Python/R kernel | DeepLab 保留 | 否 | 本地 kernel 管理仍由 DeepLab/Tauri 管 |
| agent 操作 notebook | 重接 dsh | 部分 | 通过 dsh tool / MCP 操作 notebook |
| notebook artifact 展示 | DeepLab 保留 | 否 | inspector 继续保留 |
| notebook run 记录 | DeepLab 保留 | 否 | 写入 Run / provenance |

判断：

Notebook 是 OpenLab 产品层，不应该交给 dsh 完全接管。dsh 可以让 agent 操作 notebook，但 DeepLab 必须保留 notebook UI、kernel 状态、产物预览和 run/provenance。

优先级：P1。

### 4.11 Runs 和实验记录

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| append-only run log | DeepLab 保留 | 否 | 继续写 DeepLab run records |
| SQLite run index | DeepLab 保留 | 否 | 保证跨 workspace 查询 |
| local run | DeepLab 保留 | 部分 | dsh 触发工具，DeepLab 记录 run |
| SSH / Slurm run | DeepLab 保留 | 部分 | remote 工具要和 dsh approval 对齐 |
| run reproduce | DeepLab 保留 | 部分 | 复现 prompt 可发给 dsh，但 run schema 归 DeepLab |
| run compare / search | DeepLab 保留 | 否 | 这是产品层查询 |

判断：

Runs 是 OpenLab 的核心科研资产，不能被 dsh 完全接管。dsh 记录 agent 事件，但 DeepLab 的 run records 记录实验视角：命令、环境、输入、输出、指标、产物。

优先级：P1。

### 4.12 Provenance 和 artifact

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| provenance JSONL | DeepLab 保留 | 否 | 新项目写 `.deeplab/provenance.jsonl` |
| 旧 `.openlab` 兼容 | DeepLab 保留 | 否 | 旧项目可读，不强行破坏 |
| artifact 提取 | DeepLab 保留 | 部分 | 从 dsh tool result 和文件变化里提取 |
| artifact preview | DeepLab 保留 | 否 | PDF、图片、表格、Office、代码等预览保留 |
| artifact inspector | DeepLab 保留 | 否 | 展示来源、脚本、输入、生成记录 |
| report traceability | DeepLab 保留 | 部分 | reviewer/skills 可由 dsh 调用 |

判断：

dsh 可以告诉我们 agent 做了什么，但 OpenLab 的 provenance 需要从科研产品角度组织证据链。这里 DeepLab 必须保留主导权。

优先级：P1。

### 4.13 文件、预览和多 pane 布局

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| 文件树 / 文件读取 | DeepLab 保留 | 否 | 继续由 Tauri 命令控制 |
| 文件外部打开 / reveal | DeepLab 保留 | 否 | web mode 隐藏 native-only 能力 |
| PDF / image / video / HTML preview | DeepLab 保留 | 否 | 继续保留 |
| CSV / TSV / chart | DeepLab 保留 | 否 | 继续保留 |
| Office preview | DeepLab 保留 | 否 | 继续保留 |
| molecule / genome / FITS / bands 等科学 viewer | DeepLab 保留 | 否 | 继续保留 |
| 多 pane / screen layout | DeepLab 保留 | 否 | 继续由前端 layout store 管 |

判断：

这些是 OpenLab 的桌面工作台价值，不应该交给 dsh。dsh 只负责产出文件和事件，DeepLab 负责把文件变成可用的工作台界面。

优先级：P1 / P2。

### 4.14 Review、检查和科研质量控制

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| reviewer agent | 重接 dsh | 是 | 使用 dsh profile 里的 reviewer agent |
| traceability review | 迁移到 dsh skill | 是 | skill 输出结构要适配 DeepLab ReviewerCard |
| stats integrity | 迁移到 dsh skill | 是 | 保持 deterministic finding 格式 |
| domain check | DeepLab skill + dsh 调用 | 部分 | 工具逻辑保留，调用走 dsh |
| review card UI | DeepLab 保留 | 否 | 继续由 DeepLab 渲染 |
| auto-review workflow | 混合 | 部分 | dsh 负责 reviewer session，DeepLab 负责触发和展示 |

判断：

Review 是两边共同完成：dsh 适合运行 reviewer agent，DeepLab 适合展示检查结果，并把结果和 artifact/provenance 关联起来。

优先级：P1。

### 4.15 Memory 和上下文压缩

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| 全局 memory | 重接 dsh | 是 | 使用 dsh memory/plugin 作为事实来源 |
| 项目 memory | 混合 | 部分 | workspace `AGENTS.md` 可保留，写入规则要统一 |
| `runtime/harness` seed | 保留 | 否 | 作为新 workspace 初始规则 |
| context compaction | 重接 dsh | 是 | 验证长会话，不重复注入系统消息 |
| memory UI | DeepLab 保留 | 否 | UI 展示和编辑要写到 dsh 接受的位置 |

判断：

Memory 是目前容易混乱的地方。OpenLab 需要 memory 体验，但 dsh 也有自己的 memory 和 compaction。DeepLab 不能同时写两套 memory。下一步要明确唯一写入方。

优先级：P1。

### 4.16 Usage、成本和本地模型标识

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| token usage | 重接 dsh | 是 | 从 dsh event / metadata 读取 |
| cost | DeepLab 计算 | 部分 | 本地/实验室 provider 成本应为 0 或自定义 |
| provider/model 聚合 | DeepLab 保留 | 部分 | dsh 提供模型信息，DeepLab 做聚合展示 |
| 本地模型标识 | DeepLab 保留 | 部分 | lab provider 要明确标成 lab/local |

判断：

dsh 接管底层模型调用，DeepLab 保留 usage 和成本展示。特别是实验室服务器模型，不能按云 API 费用理解。

优先级：P1。

### 4.17 Gateway、远程访问和手机端

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| LAN gateway | DeepLab 保留 | 否 | token 鉴权继续保留 |
| phone-width web UI | DeepLab 保留 | 否 | native-only 功能隐藏 |
| dsh sidecar proxy | DeepLab 保留 | 部分 | 因 dsh browser-trust fence，需要 internal gateway |
| WebSocket reconnect | DeepLab 保留 | 部分 | 转发 dsh events 并恢复 UI 状态 |

判断：

Gateway 是 DeepLab 桌面壳能力，不是 dsh 接管。但 dsh 的安全限制决定了 DeepLab 必须有 internal gateway 来代理 `/api` 和 WebSocket。

优先级：P2。

### 4.18 i18n、设置和桌面体验

| OpenLab 功能 | DeepLab 迁移方式 | dsh 是否接管 | 需要改什么 |
| --- | --- | --- | --- |
| 中英文界面 | DeepLab 保留 | 否 | 新功能必须同步 i18n |
| 设置页 | 混合 | 部分 | UI 保留，底层模型/权限/key 写 dsh |
| 主题 / zoom / layout | DeepLab 保留 | 否 | 与 dsh 无关 |
| app updater | 后移 | 否 | 核心迁移稳定后再考虑 |

判断：

这些是应用层体验，dsh 不接管。设置页比较特殊：页面是 DeepLab 的，但很多设置项的事实来源要改成 dsh。

优先级：P2 / P3。

## 5. 功能归属总表

### 5.1 DeepLab 应该保留主导权的功能

这些是 OpenLab 的产品层能力，不能交给 dsh 完全接管：

- 项目管理；
- 工作区目录结构；
- 文件树；
- artifact 预览；
- notebook UI；
- run records；
- provenance；
- report / figure / table inspector；
- 多 pane / screen layout；
- gateway；
- i18n；
- 桌面 native 能力；
- OpenLab 旧项目兼容。

这类功能的迁移重点是：保留 OpenLab 体验，同时把底层 runtime 事件从 OpenCode 改成 dsh。

### 5.2 应该由 dsh 接管事实来源的功能

这些不应该由 DeepLab 自己再维护一套状态：

- session 创建和历史；
- session event stream；
- Goal；
- Plan；
- prompt queue / steer；
- tool call / result；
- model provider catalog；
- current model；
- credentials；
- permission preset；
- skills discovery；
- agent profiles；
- memory / compaction 中 dsh 已经提供的部分。

这类功能的迁移重点是：DeepLab adapter 要按 dsh 的真实协议接，不要模拟旧 OpenCode 行为。

### 5.3 需要混合处理的功能

这些功能既有 OpenLab 产品层，又有 dsh runtime 层：

- reviewer；
- skill 工具结果展示；
- Jupyter / notebook agent 操作；
- browser connector；
- remote compute；
- usage / cost；
- MCP；
- auto-review；
- workflow starter；
- provenance 和 dsh event 的关联。

这类功能最容易出问题，因为它们有两个来源。必须提前规定：

- 哪个状态由 dsh 负责；
- 哪个状态由 DeepLab 负责；
- 数据从哪里恢复；
- UI 展示失败时是否允许降级；
- 是否会造成重复写入。

## 6. 后续改造重点

### 6.1 不优先改 dsh 源码，优先改 DeepLab 的 dsh 接入层

这里说“修改 dsh 接管的功能”，不一定是直接改 dsh 源码。更稳妥的顺序是：

1. 先改 `packages/sdk/src/dsh/` adapter；
2. 再改 `runtime/dsh-profile/` agent preset 和 command；
3. 再改 DeepLab 如何部署 skills / MCP / Cordis 配置；
4. 如果 dsh 本身缺能力，再考虑 patch、fork 或向上游提需求。

原因是 dsh 还在 preview，直接改 dsh 源码会增加维护成本。DeepLab 先通过 adapter 把产品需求表达清楚，风险更小。

### 6.2 建立 capability discovery

现在一个问题是：有些 OpenLab 功能 UI 还在，但 dsh v1 没有对应能力。

后面应该给 runtime 增加 capability discovery：

- available：当前 dsh composition 已支持；
- unavailable：不支持，UI 隐藏或禁用；
- experimental：能跑但不稳定，不进主流程。

这样可以避免假功能，比如按钮还在但点击后其实 no-op。

### 6.3 清理 OpenCode / ACP 残留

需要系统检查：

- `@opencode-ai/plugin`；
- ACP 相关脚手架；
- 旧 runtime selection；
- 旧 provider/model 假设；
- 旧 config 文件语义；
- 旧 event type 命名。

清理原则：

- 如果只是旧 runtime 兼容，删除；
- 如果功能有价值，迁到 dsh-native；
- 如果 dsh 暂时没有能力，标记为 unavailable 或后移。

### 6.4 先迁主功能，再用 demo 验证

BCI demo 不是最终目标，但可以作为迁移验证场景。

正确用法是：

- 迁移项目/工作区后，用 BCI 验证 workspace；
- 迁移 session/queue 后，用 BCI 验证 agent 流程；
- 迁移 artifact/provenance 后，用 BCI 验证文件产物；
- 迁移 reviewer 后，用 BCI 验证检查结果；
- 迁移 provider 后，用 BCI 验证实验室模型。

这样 BCI 只是验收工具，不会喧宾夺主。

## 7. 建议迁移优先级

### P0：必须先稳定

- dsh sidecar 启动和 gateway；
- session create/history/event folding；
- model provider catalog；
- credentials；
- permission preset；
- workspace cwd；
- project/workspace 切换；
- dsh adapter contract test。

### P1：OpenLab 核心功能迁移

- Goal / Plan / queue；
- skills discovery 和核心 science skills；
- MCP / Jupyter connector；
- notebook UI + agent 操作；
- artifact extraction；
- provenance；
- run records；
- reviewer；
- remote compute；
- usage / cost。

### P2：增强体验

- 多 pane / screen 恢复；
- gateway 手机端体验；
- 高级 preview；
- skill 管理 UI；
- session 恢复和归档恢复；
- 更完整的 workflow pipeline。

### P3：后移

- 自动更新；
- 多 runtime 选择；
- ACP server 作为外部编辑器入口；
- agent team 大规模多智能体；
- 上游 dsh experimental 能力。

## 8. 第一阶段建议任务

下一阶段不应该只做 BCI，也不应该只做模型服务器。建议按下面顺序推进：

1. 把 OpenLab 功能清单转成 issue / checklist，标注 DeepLab-owned、dsh-owned、mixed。
2. 完成 runtime capability discovery，避免旧 OpenLab UI 显示 dsh 不支持的功能。
3. 完成 session / Goal / model / credentials / permission 的 P0 稳定化。
4. 迁移 artifact、run、provenance、reviewer 这几个 OpenLab 核心科研工作台能力。
5. 用 BCI starter 验证第一条完整路径。
6. 清理 OpenCode plugin 残留。
7. 接入实验室 DeepSeek server provider。

## 9. 可以向老师汇报的简洁说法

现在对 DeepLab 的规划不是单独做某个科研 demo，而是以 OpenLab 的主要功能为基线做迁移。区别在于，底层 harness 不再沿用 OpenCode / ACP，而是改成 dsh。

因为 dsh 比 OpenCode 管得更宽，它会接管 session、Goal、模型、权限、credentials、skills 和事件流，所以我们不能简单照搬 OpenLab 代码。我们要先判断每个功能的事实来源：项目、文件、产物、run、provenance 这些继续由 DeepLab 保留；agent 运行状态、模型、权限、credentials 这些交给 dsh；中间混合的功能通过 adapter 和 profile 去对齐。

所以后续工作的主线是：保留 OpenLab 的产品能力，重做 dsh 接入层，让 dsh 接管的功能符合 OpenLab 原来的使用要求。BCI demo 只是后续验证迁移效果的一个样例，不是最终目标。

