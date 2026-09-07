# 浏览器控制修复记录(Browser Control / open-science-browser)

> **RESOLVED 2026-09-07.** The deployed Windows build now passes real-browser
> open, inventory, follow-up title read, and close acceptance. The remaining
> causes crossed both wrapper and proxy boundaries: an older persisted MCP row
> referenced three browser runtime parameters that were absent from dsh's
> credential document, so the wrapper exited before registering any tools; the
> fallback lease was checked but not forwarded; agent-browser 0.32.1's first
> Windows daemon inherited MCP capture handles and prevented EOF; session-list
> represented daemon state rather than browser state; and a stalled backend had
> no bounded response/reap path.
> `browser_mcp_proxy.rs` now assigns the lease before every tool call, performs
> first-open bootstrap outside MCP pipes on Windows, probes `session info`, and
> returns a correlated error within 30 seconds while killing the failed child.
> The credential wrapper also recovers the three app-owned, non-secret browser
> parameters when upgrading a stale row; secrets and user-specific values remain
> fail-closed.
> Regression coverage lives in `scripts/dev/test-browser-proxy.ps1` and its
> source/failure/real-browser fixtures. The historical investigation below is
> retained as evidence, not as current status.

> 给接手的模型/工程师。目标:修复「agent_browser_* MCP 工具在 DeepLab 会话里能用,
> 但调用报错/超时」的最后一段。下面给足位置、现象、已修根因、证据与调试路径。

## 1. 项目位置与环境

- 源码仓库(主要,在本机):`C:\Users\10840\Documents\ChatGPT\deeplab`
  - 分支 `codex/week-1-dsh-foundation`;近期相关提交(按时间倒序):
    - `deb28b7` docs: browser control partial result
    - `1aa39a3` fix: strip `\\?\` verbatim prefix from MCP wrapper args (dsh_mcp.rs)
    - `24eee27` fix: default conversation lease when the dsh MCP bridge injects none (browser_mcp_proxy.rs)
    - `f8b77fd` fix: treat AGENT_BROWSER_EXECUTABLE_PATH as optional MCP credential
- 运行中的 App(沙箱实例,用户实际在用的、也常被替换 exe 的那份):
  `C:\Users\10840\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\DeepLab\deeplab-workbench.exe`
  - 其旁 `dsh\`、`agent-browser.exe`、`dsh\mcp-credential-wrapper.mjs` 都是**已部署副本**;
    源码改动后需重编译 exe 拷过去并重启 App 才会生效(历史上因 exe 被占用,常需先 `Rename` 再拷)。
  - 真安装:`C:\Users\10840\AppData\Local\Programs\DeepLab\`(也同步改过 wrapper)。
- App 私有运行时/日志:`C:\Users\10840\AppData\Roaming\com.sculab.deeplab\runtime\`
  - `debug.log`(前端+sidecar stderr 都进这里)
  - `dsh-home\.credentials.yaml`(凭据)
  - `dsh-home\sessions\...\session-*\session.jsonl.zstd`(会话转录,zstd 压缩)
  - `dsh-mcp.json`(MCP 服务器库存)、`dsh-mcp.patch.yml`(启动时喂给 dsh 的补丁)

## 2. 功能背景

DeepLab(=OpenLab 迁移到 dsh)的“浏览器控制”:设置里启用后,把版本匹配的
`open-science-browser` MCP 服务器注入 dsh 会话,会话里的模型通过 `agent_browser_*`
工具驱动 `agent-browser`(Vercel)控制 Chrome。技能文件:
`<dsh-home>\skills\open-science-browser\SKILL.md`,规则:工具不可用/出错时不得回退 CLI。

架构链路:
`模型工具调用 → dsh mcp-client → deeplab-workbench.exe --browser-mcp <agent-browser.exe> mcp [--tools all]`
即:DeepLab 的 exe 充当**代理**(`src/browser_mcp_proxy.rs`),套一个凭据 wrapper
(`runtime/dsh/mcp-credential-wrapper.mjs`)按需解析凭据。

## 3. 现象时间线(今天修到什么程度)

| 阶段 | 现象 | 根因(已修) |
|---|---|---|
| 1 | 会话里完全没有 `agent_browser_*` 工具 | wrapper 把 `AGENT_BROWSER_EXECUTABLE_PATH` 当必需而私密模式不设它 → 可选化(`f8b77fd`) |
| 2 | 工具还是没有 / dsh 反复 `EISDIR lstat 'C:'` | 补丁里 wrapper 脚本参数带 `\\?\` verbatim 前缀,node 解析成卷 `C:` → 去前缀(`1aa39a3`) |
| 3 | 工具出现,调用返回 `trusted conversation lease was not supplied` | 代理要求每个工具调用带 `osd-` 会话租约,而 dsh 链路没人注入 → 进程级缺省租约(`24eee27`) |
| 4(当前) | 浏览器窗口**能弹出**,但 inventory 仍报错、多数调用超时/`wait_ms` 超时;换 baidu.com 也一样,inventory 报 “trusted conversation lease was not supplied” | **未解决**;见下 |

## 4. 当前问题(交给你的核心)

现象:会话里工具已出现、`deeplab-workbench.exe --browser-mcp ...` 代理进程确实在跑
(每会话/每 dsh 一个,进程列表可见,命令行带 `--browser-mcp ... mcp --tools all`),
浏览器窗口也能弹出来;但:
- `agent_browser_inventory` 返回 “trusted conversation lease was not supplied”
  (注意:按代码该工具应被特殊处理、**不该**查租约 —— 见下 6.1)
- 其它调用超时(包括 `wait_ms`),疑似代理/agent-browser 后端不同步、或一个会话被多个/旧代理进程服务。

怀疑点(按优先级,需验证):
1. **旧代理进程/旧 dsh sidecar 残留仍在服务会话**:我们只杀过 `deeplab-workbench.exe`,
   没杀过其子 `node`(dsh sidecar)与 `--browser-mcp` 代理;多次升级 exe 后,残留的旧代理(不含 24eee27 缺省租约)会继续被旧会话/dsh 复用 → 表现与“已部署新 exe 却仍报旧错误”吻合。
2. inventory 命中 `INVENTORY_TOOL` 特判的前提是请求 `params.name == "agent_browser_inventory"`
   且由**我们的代理**收到;若该会话实际连的是 agent-browser 直连(非代理)或旧代理,则会漏过特判返回其自身租约错误。
3. 多 `--browser-mcp` 代理共享同一 `AGENT_BROWSER_NAMESPACE=open-science-desktop` 时互相竞争/会话锁,可能造成超时;应确认每会话代理唯一与隔离。

已排除:外网/网络/VPN(本机 curl example.com、baidu.com 均 200、<1s)。

## 5. 复现与调试建议

1. 确保无残留:结束所有 `deeplab-workbench`、所有以 `--browser-mcp` 运行的子进程,
   以及孤立 `node`(dsh sidecar)后,再启动一个 App 实例;用 `Get-CimInstance Win32_Process` 核对
   主进程 + 代理进程的**命令行与父进程**,确认代理都由当前 dsh 派生且为新 exe。
2. 确认运行 exe 是含 24eee27 的版本(可对 `mcp-probe` 验证 tools/list 含 inventory)。
3. 给代理加 stdio 请求/响应日志(或先手动以 mcp-probe 的方式,对它发一个
   `tools/call` `agent_browser_inventory` 看返回),确认“特判是否命中、返回什么”。
4. 检查 dsh 为何对同一会话启动多个代理、旧会话是否仍挂旧进程。
5. 修好后在**新建会话**用一条指令复测:
   “使用 open-science-browser 技能打开 https://www.baidu.com 并回报 <title>”。
   验收=能弹出浏览器并读到真实标题、无租约错误/超时。

## 6. 关键代码/文件

1. `apps/desktop/src-tauri/src/browser_mcp_proxy.rs` — 代理主逻辑;
   `INVENTORY_TOOL` 特判(约 line 95-101)、租约检查(约 line 109-…,现已加进程级缺省 `process_lease()`)、
   `valid_lease`/`process_lease`。
2. `apps/desktop/src-tauri/src/dsh_mcp.rs` — `render_patch` 生成 dsh 补丁(`plain_arg` 已加)。
3. `runtime/dsh/mcp-credential-wrapper.mjs` — 凭据 wrapper(已支持 `AGENT_BROWSER_EXECUTABLE_PATH` 可选)。
4. 运行时定义文件:见上文 §1 路径(`dsh-mcp.json`、`dsh-mcp.patch.yml`、`.credentials.yaml`、`debug.log`)。
5. 相关文档:`docs/migration/FEATURE-VERIFICATION.md`、`docs/migration/MASTER-PLAN.md`。

## 7. 其它注意
- 平台:Windows,PowerShell;本机 Rust 测试可执行文件跑不了(`STATUS_ENTRYPOINT_NOT_FOUND`),
  改 Rust 后用 `tauri build --no-bundle` 编译、再把 exe 拷到运行实例(先停进程/必要时先 Rename 旧 exe)。
- `tauri build` 会顺手把 Cargo.toml 的 `macos-private-api` 特性改掉,记得 `git checkout` 还原。
- wrapper 的改动要同时同步到沙箱与 Programs 两处部署副本。
