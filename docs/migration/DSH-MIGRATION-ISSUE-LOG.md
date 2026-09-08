# DeepLab × dsh 迁移全程问题汇总(报告用)

> 目的:按时间线汇总「把 OpenLab 迁到 dsh(DeepSeek Harness)」过程中遇到并处理的问题,
> 供复盘/汇报使用。事实来自仓库 `PROGRESS.md`、迁移文档与我们实测记录;日期范围 2026-08 起。
> 每一类都给出:现象 / 根因 / 处理。

## 报告摘要

- **统计范围**:2026-08-14 项目启动至 2026-09-08 首个可安装、可实际调用 dsh 与科研工具的 Windows 版本。
- **问题规模**:26 项编号工程问题,另有 3 项贯穿全程的方向与项目管理问题。
- **总体状态**:核心 dsh 连接、会话、模型、审批、MCP、科研管线、用量、Windows 发布均已形成可验证闭环;当前遗留主要集中在 OpenLab 功能继续补齐、跨机器发布验证、第三方连接器检索质量和本机 Rust 测试环境。
- **最主要结论**:迁移的难点不是把模型接口从 OpenCode 换成 DeepSeek,而是重新确定状态所有权,逐项适配 dsh 的协议和生命周期,再把 OpenLab 的产品功能接回新的运行时。

| 阶段 | 主要问题 | 状态 | 对迁移的影响 |
|---|---|---|---|
| 方向与边界 | 将 harness、agent、OpenLab 产品功能混为一谈;“代码存在”被误当成“功能可用” | 已纠正,需持续遵守 | 决定项目是否会变成另一个简化聊天壳 |
| dsh 基础接入 | WebView 同源限制、事件结构差异、系统消息污染、归档语义不同 | 已解决 | 建立了 DeepLab 与 dsh 的真实通信和会话基础 |
| 状态与权限 | OpenCode 旧操作在 dsh 中不存在;审批、模型、agent preset 的所有权不同 | 已适配/显式降级 | 避免 UI 显示 dsh 实际不支持的假功能 |
| MCP 与外部工具 | Cordis 配置方式不同;浏览器进程链复杂;科学连接器依赖漂移 | 核心链路已解决 | 使 browser、paper-search 等工具能由 dsh 真正调用 |
| 科研记录 | Windows 工具名、tool/result、时间戳、输出目录和 `.openlab` 路径不一致 | 已解决 | 让运行记录、产物和 provenance 从“看起来有”变成真实产生 |
| 桌面发布 | Rust 工具链、深路径、sidecar 完整性、双安装目录和进程占用 | 已形成可安装版本,仍需跨机器验证 | 决定成果能否脱离开发目录正常使用 |
| 交互质量 | 流式/最终文本重复、挂件窗口行为、usage 展示 | 已解决主要问题 | 决定日常使用是否稳定、可信 |

## 问题分类表

| 类型 | 代表问题 | 处理原则 |
|---|---|---|
| 协议适配 | `tool/result` 嵌套、事件 partId、时间戳单位、WebSocket 网关 | 以真实 dsh 事件为准,不用 OpenCode 结构猜测 |
| 状态所有权 | 会话归档、模型选择、permission preset、agent preset、goal | dsh 接管运行状态;DeepLab 只保存产品层状态 |
| 能力差异 | revert、OAuth、jobs、动态配置等 API 缺口 | 支持则原生接入;不支持则隐藏或明确降级,不伪造 |
| 进程与配置 | sidecar、MCP wrapper、浏览器 daemon、陈旧凭据、依赖版本 | 明确进程所有权,固定版本,重启后重新验收 |
| 跨平台发布 | Windows linker、MAX_PATH、首启解压、安装副本漂移 | 构建产物、安装产物、实际快捷方式分别校验 |
| 验证方法 | mock 与真实 provider 差异、源码测试与安装版差异 | 单测、构建、真实 dsh、安装版 UI 四层验证 |

## 0. 方向与范围问题(迁移的“元问题”)

- **目标一度被误读**:前期被当作“修一个半成品/装一个安装包/鲸鱼能否显示”等单点问题;
  后明确为「以 OpenLab 功能为基线迁到 dsh,dsh 是运行状态唯一事实来源,不许伪造状态」。
- **验收口径不统一**:“代码里有”≠“能用”。大量功能(notebook、连接器、远程、lab 端点)当时只有
  UI/代码,**从未在真实环境跑通过**;导致“已实现”的说法多次被高估。
- **文档漂移**:功能迁移矩阵/scope 写成后不再同步实现,出现“文档说缺失、代码已实现”的反向失真;
  PROGRESS 是相对可靠的事实源,但也要人工维护。

## A. 初代桌面打通(2026-08-14 ~ 08-15)

1. **WebView 连不上 sidecar(dsh 的同源安全篱笆)**
   - 现象:界面与本地 dsh 之间无法直连。
   - 根因:WebView origin(`tauri://localhost`)跨源,触发 dsh browser-trust 限制。
   - 处理:起一个**同源内部网关**统一中转;HTTP 走代理,事件走自写 WebSocket 升级代理
     (不能直接用 `tungstenite::accept`,因握手已被自读 BufReader 消费,需手写 101)。
2. **工具结果取不到(dsh `tool/result` 形状特殊)**
   - 现象:bash/工具输出在 UI 全空。
   - 根因:dsh 把 callId 放在 `message.source.callId`、内容嵌在**嵌套 content** 里,SDK 两处都没读到。
   - 处理:SDK 同时解析三个来源,并递归取文本。
3. **删除/归档的会话又冒出来**
   - 根因:dsh `session.list` 不过滤 archived、也不带标题;标题在 projection。
   - 处理:读 workspace 的 `archivedSessionIds` 过滤;标题从 `projections.values.title` 与 `session/title` 事件恢复。
4. **会话历史被系统行污染**
   - 根因:dsh 把 SYSTEM 注入行(运行时上下文、技能目录)当 `user/message` 写入。
   - 处理:SDK 只折叠 `source.kind === "user"` 的行。
5. **用户自带技能泄漏进会话**
   - 根因:sidecar 会扫用户的 `~/.agents/skills`(含旧 OpenLab 中文技能)。
   - 处理:给 sidecar 设 app 私有 `DSH_AGENTS_HOME`,只加载自捆绑技能。

## B. Week-1 dsh 地基(2026-08-23 ~ 08-24)

6. **能力发现缺失 → “假按钮”**
   - 现象:dsh v1 没有 revert/编辑历史/OAuth/jobs 等,但旧 UI 仍展示入口,点击无效果。
   - 处理:引入 capability 契约,把不支持操作**隐藏或显式拒绝**,不假装成功。
7. **MCP 不能走旧 runtime API**
   - dsh 用 Cordis 组合管理 MCP;旧 `addMcpServer` 语义要迁到桌面宿主桥的 Cordis 配置。
8. **命名/品牌遗留**
   - “Open Lab”、OpenCode 相关注释与标题残留;定调:兼容路径保留、新写走 DeepLab/`.deeplab`。

## C. Windows 发布与稳定性打磨(2026-08-30 ~ 09-02)

9. **构建工具链残缺**
   - 现象:本机只有 MSYS `link.exe`,无 MSVC Build Tools;Rust 测试链接失败;GNU 目标能编应用,
     但部分 Rust 测试可执行文件一运行就 `STATUS_ENTRYPOINT_NOT_FOUND`(WebView 符号)。
   - 影响:大量逻辑只能靠 TS 测试 + 编译 + 真机手动验收,无法在本机跑 Rust 单测。
10. **`tauri build` 静默改 Cargo.toml**
    - 每次打包把 `macos-private-api` 特性剥掉(macOS 透明窗口所需);需反复 `git checkout` 还原,还曾被误提交。
11. **NSIS 路径长度(MAX_PATH)**
    - vendored dsh 树最深路径 ~493 字符,修剪后仍数千文件 >250 → makensis 无法内嵌;
      最终改为**把 dsh 打成单个 zip 嵌入安装包、首启解压到 app 私有目录**(bsdtar 约 71s)才打通。
12. **安装目录/沙箱双份混乱**
    - 用户实际跑的是 Codex 虚拟化出的“沙箱副本”,与真实 Programs 安装并存且会漂移;
      曾因副本 dsh 半拷(37k/54k 文件)导致 sidecar 起不来、鲸鱼空白。
13. **exe 被占用 / 多进程残留**
    - 升级部署常被运行实例锁死;反复 Start 后残留多个主进程与 `--browser-mcp` 子进程;处理靠先停进程、必要时先 Rename 再拷。
14. **鲸鱼(可选挂件)相关**
    - 独立透明窗口要“点击穿透/无原生菜单/无 dsh 控制台”;透明区域命中区用指针轮询上报。
    - “余额不对”最终是**充错账号**(key 属于另一账号),属配置/账号问题而非代码。

## D. 科研管线产品化(B1,2026-09-02 ~ 09-05)

15. **Windows shell 工具名不是 `bash` 而是 `pwsh`**
    - 被动 run 记录只认 `bash` → Windows 上跑 python 永远不记录。
16. **(深层根因)SDK 完成事件丢 tool 名和 input**
    - `tool/result` 完成后 SDK 发的 `tool.updated` 里 `tool:""` 且无 `input.command`;
      而录制逻辑只在“完成 + 工具名 + 命令”成立时才触发 → **被动录制此前从未真正触发过**。
    - 处理:SDK 按 callId 记忆 name/input/startedAt,完成时回填。
17. **时间戳被 ×1000**
    - dsh `event.time` 是 epoch 毫秒,SDK 又乘 1000 → run `wallMs` 虚高、outputs 归属窗口失效。
18. **run outputs 归属为空 / 收集器语义错误**
    - 生成物(results.json/figure.svg)本属 run 输出而非“authored 溯源”,收集器初版把它当溯源误报 FAIL。
19. **应用内验收目录找错**
    - 会话产物在 `Documents/DeepLab/sessions/<id>/`,收集器指向工作区根 → 假 FAIL。
20. **技能写入路径不一致**
    - `record_run.py` 写 `.openlab/`,应用读 `.deeplab/` → 远程 run 永不并入 Runs 视图。
21. **交互式 / 真机验证的试错成本高**
    - 多次让用户在真实 App 里跑;期间试过 CDP 驱动 WebView(不稳定),试过“整份家目录克隆+真浏览器”(超时不可行),最终确立“应用内短验收”为可靠方式。

## E. Usage 通用聚合(B3,2026-09-06)

22. **缺通用用量**:仅 DeepSeek 鲸鱼有 provider 专用路径;
    - 加了 SDK `usage.updated` 上浮 → 纯函数聚合/定价(本地·lab 记 0)→ store + UI → localStorage 持久聚合。

## F. 实证与近期 bug(2026-09-07)

23. **浏览器控制(Browser Control)长链条问题**(最终由更强模型收尾,`53f0478`)
    - wrapper 把 `AGENT_BROWSER_EXECUTABLE_PATH` 当必需(私密模式不配它)→ 可选化;
    - 补丁 wrapper 参数带 `\\?\` verbatim 前缀 → node 报 `EISDIR lstat 'C:'`;
    - dsh 桥无人注入会话租约 → “trusted conversation lease was not supplied”;
    - **真实根因(更正我早前判断)**:陈旧 MCP 行引用缺失的 3 个运行时参数致 wrapper 注册前退出;
      缺省租约未转发;agent-browser 0.32.1 首启 daemon 继承 MCP 句柄致 EOF 卡死;
      `session-list` 反映 daemon 非浏览器状态;缺有界回收。→ 修复后应用内真机通过。
24. **科学连接器已启用,但模型看不到 `paper-search` 工具**
    - 现象:文献检索任务只看到 browser MCP,随后浏览器和 PowerShell 访问 arXiv 超时,最终显示 `Interrupted`。
    - 真正根因:`paper-search-mcp 0.1.4` 仍导入 `mcp.server.fastmcp`,但其依赖没有声明上限,共享环境解析到 `mcp 2.1.1`;该 API 在 2.x 已移除,所以 MCP 进程启动即退出,工具从未注册到 dsh。
    - 处理:科学连接器环境写入持久约束 `mcp<2`,当前环境降级到 `mcp 1.30.0`;以后安装其他连接器也必须遵守该约束,冲突时明确失败而不是静默破坏已有工具。
    - 验证:修复前后均读取同一真实会话事件;修复后 dsh 拉起 `paper_search_mcp.server`,DeepSeek 连续两次调用 `mcp__paper-search__search_arxiv` 成功并以 `turn/end: completed` 收尾。截图中的旧 `Interrupted` 经事件确认是用户主动停止(`reason.kind=user`),不是应用崩溃。
25. **本地 lab mock 起初只回非流式**
    - dsh 走 SSE,期望 finish_reason;mock 补流式后通过(证明自定义/实验室端点链路可通)。
26. **助手文本重复**
    - dsh 对同一回答发“流式+最终”两次事件;DeepLab 各配标识 → 显示 2–3 份;
      改为“最终替换流式”后去重(提交 `0261ee7`)。

## dsh 迁移中的核心判断

1. **这不是一次普通的后端替换。** OpenLab 原来依赖的运行时语义分散在 UI、SDK 和 OpenCode 行为里;换成 dsh 后,会话、模型、审批、agent preset、工具和事件流都要重新确认所有权。
2. **dsh 应当成为运行状态的唯一事实来源。** DeepLab 不应自己伪造“已审批、已运行、已恢复”等状态;否则界面看似兼容 OpenLab,实际与 harness 脱节。
3. **OpenLab 的产品层仍然是迁移基线。** 项目、文件、Notebook、科研流程、实验记录、报告、provenance 等能力不能因为 dsh 接管底层而删除;需要通过 SDK 和桌面宿主重新接入。
4. **MCP 是本次迁移最典型的混合层。** dsh/Cordis 负责加载和调用 MCP,DeepLab 仍负责连接器目录、安装、凭据、启停、健康状态和用户入口。两边任何一侧只“配置存在”都不代表功能可用。
5. **安装版实测是最终标准。** 许多关键问题只在 WebView origin、Windows 进程继承、安装路径、真实 provider、真实 MCP 或 sidecar 重启时出现,无法由静态阅读和普通单测替代。

## 当前风险报表

| 风险 | 当前状态 | 影响 | 下一步 |
|---|---|---|---|
| dsh v1 缺少 OpenCode 的部分 RPC | 已显式降级 | revert、OAuth、jobs 等不能按旧方式迁移 | 随 dsh 升级重新审计 capability,不在 UI 伪造 |
| 科学连接器依赖漂移 | paper-search 已修复 | 第三方包升级可能导致 MCP 启动失败 | 固定兼容约束,逐个连接器做真实调用 |
| arXiv 多词检索相关性偏低 | 未解决 | 工具能返回数据,但结果可能偏题 | 评估查询规范化、上游补丁或替代连接器 |
| Rust 测试二进制无法在本机运行 | 未解决 | Rust 逻辑缺少本机运行期单测 | 在具备完整 MSVC/WebView2 工具链的机器补跑 |
| 两个 Windows 安装位置可能漂移 | 已用哈希校验缓解 | 用户可能启动旧 exe | 发布流程统一安装来源并保留安装后哈希验收 |
| 干净机与其他用户环境 | 部分验证 | 首启解压、权限、代理仍有环境差异 | 使用独立 Windows 账户/机器重复 NSIS 首启验收 |
| OpenLab 功能尚未完全迁完 | 持续推进 | 当前是可用 beta,不是功能完全等价版 | 按功能矩阵继续补齐 notebook、远程和科学连接器实证 |

## G. 贯穿性工程教训(非一次性 bug)

- 验证深水区:多数“实证类”功能离真环境才有意义;建议凡“已实现”都注明验证深度。
- dsh v1 能力缺口要用“显式降级/隐藏”,不要伪造(restore、revert、plan、OAuth、jobs 等已定案)。
- 安全落差:key 明文在 `.credentials.yaml`;至少一把 key 曾在对话中暴露,公开前需轮换。
- 工具链限制(无 MSVC、Rust 测试跑不了)与 PowerShell/文件编码、tauri 自动改配置等,都要写进开发备忘。
- 维护纪律:每完成一个单元就提交;PROGRESS 最新在上、编码 UTF-8;文档与实现同步。

## 仍开放/后续
- `paper-search` 已真实调用成功,但上游 arXiv 多词查询使用宽松的 `all:<query>` 拼接,相关性排序可能偏离主题;需要单独评估查询规范化或上游修复,不能把“返回了数据”当成“检索质量合格”。
- 其余科学 MCP 连接器仍需逐个做真实数据源调用,不能只以安装或 `tools/list` 作为验收。
- notebook 深层重连、远程计算/实验室真机、手机端回归(可选)。
- 本机 Rust 测试程序仍因 `STATUS_ENTRYPOINT_NOT_FOUND` 无法运行;当前依赖生产编译、TypeScript 测试和安装版实测补足。
- 若干打磨:`.openlab` 兼容清理、usage 视图细节、README/文档同步、凭据轮换、干净机/其他用户安装复验。
