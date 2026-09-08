# DeepLab × dsh 迁移全程问题汇总(报告用)

> 目的:按时间线汇总「把 OpenLab 迁到 dsh(DeepSeek Harness)」过程中遇到并处理的问题,
> 供复盘/汇报使用。事实来自仓库 `PROGRESS.md`、迁移文档与我们实测记录;日期范围 2026-08 起。
> 每一类都给出:现象 / 根因 / 处理。

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
24. **科学连接器首启“启用失败”**
    - 现象:点击启用 paper-search 报 setup failed,无日志、Toast 不可复制。
    - 复现:用同款 uv 在应用同一 env 目录手动建环境+安装**成功**;重试后连接器正常 → 判断为首次下载建环境的偶发/时序问题,依赖就位后自愈。
25. **本地 lab mock 起初只回非流式**
    - dsh 走 SSE,期望 finish_reason;mock 补流式后通过(证明自定义/实验室端点链路可通)。
26. **助手文本重复**
    - dsh 对同一回答发“流式+最终”两次事件;DeepLab 各配标识 → 显示 2–3 份;
      改为“最终替换流式”后去重(提交 `0261ee7`)。

## G. 贯穿性工程教训(非一次性 bug)

- 验证深水区:多数“实证类”功能离真环境才有意义;建议凡“已实现”都注明验证深度。
- dsh v1 能力缺口要用“显式降级/隐藏”,不要伪造(restore、revert、plan、OAuth、jobs 等已定案)。
- 安全落差:key 明文在 `.credentials.yaml`;至少一把 key 曾在对话中暴露,公开前需轮换。
- 工具链限制(无 MSVC、Rust 测试跑不了)与 PowerShell/文件编码、tauri 自动改配置等,都要写进开发备忘。
- 维护纪律:每完成一个单元就提交;PROGRESS 最新在上、编码 UTF-8;文档与实现同步。

## 仍开放/后续
- 科学 MCP 连接器与浏览器控制的**真实检索/页面验收**(进行中)。
- notebook 深层重连、远程计算/实验室真机、手机端回归(可选)。
- 若干打磨:`.openlab` 兼容清理、usage 视图细节、README/文档同步、凭据轮换、干净机安装复验。
