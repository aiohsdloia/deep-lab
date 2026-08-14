<div align="center">

# DeepLab

**本地优先、模型无关的 macOS、Windows & Linux AI 科研工作台 —— 由 DeepSeek Harness (dsh) 智能体运行时驱动。**

DeepLab 是 Claude Science 及同类 AI-for-science 工作台的开源桌面替代。它在功能上完整复现
[Open Lab](https://gitee.com/sculab/openscience)（项目、会话、溯源、运行记录、审查技能、
查看器、笔记本、远程计算与网关），但把智能体运行时替换为 **DeepSeek Harness**：
应用将 `dsh --profile web` 作为内置 sidecar 启动，并通过 dsh 的 `/api`
HTTP+WebSocket 网关（dsh 客户端框架）与之通信，而不是 OpenCode sidecar。

<p>
  <a href="./README.md">English</a> ·
  <b>简体中文</b>
</p>

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20React-24C8DB" alt="Built with Tauri + React">
  <img src="https://img.shields.io/badge/runtime-DeepSeek%20Harness-success" alt="dsh runtime">
</p>

</div>

---

## 它能做什么

**跑完整个科研闭环** —— 从一个宽泛方向到一份成稿报告：探索、文献综述、实验代码、
分析、图表与撰写，在一条连续、可审计的会话中完成。

- **一切皆可溯源** —— 图表、表格、报告、笔记本与运行输出都链接到产生它们的代码、
  输入、环境、模型输出与会话。`domain-check` 门禁在结果呈现前审计各学科的典型错误类。
- **本地优先、数据自有** —— 会话、数据、溯源、笔记本与运行记录都保存在本机
  `~/Documents/DeepLab`，默认不离开本机；应用本身**无后台网络请求**。
- **模型无关运行时** —— UI 通过 `packages/sdk` 与内置、固定版本的 dsh sidecar 通信。
  自带模型即可；provider、技能与 MCP 服务器均可插拔。
- **可复现** —— 本地、SSH/Slurm、Modal 与 notebook 批量运行都被记录为可复现的运行记录。
- **随处可达** —— 内置、令牌鉴权的网关可把*真实*桌面 UI 提供给局域网浏览器或手机。

## 运行时替换：OpenCode → DeepSeek Harness

与 Open Lab 的决定性差异是智能体运行时：

| | Open Lab | DeepLab |
| --- | --- | --- |
| Sidecar | `opencode serve` 二进制 | `dsh --profile web`（Node CLI，经 `runtime/dsh/launcher.mjs`） |
| 传输 | OpenCode HTTP + SSE | dsh `/api` HTTP POST 一元调用 + `/api/events.mux` `/api/events.host` WebSocket 下行流 |
| SDK | `OpenCodeClient` | `DshRuntime`（同一 `AgentRuntime` 缝；`OpenCodeClient` 保留作参考） |
| 会话 | OpenCode session/message | dsh `session.*` RPC + 会话日志事件折叠 |
| 技能 | `<xdg>/opencode/skills/` | `<dsh-home>/skills/` + 工作区 `.dsh/skills/` |
| Provider/MCP | OpenCode 配置 API | dsh `llm.*` / `credentials.*` / `settings.*`（MCP 在 cordis.yml 中配置） |

其余一切 —— 线程、溯源、运行、项目、审查、查看器、笔记本、远程计算与网关 ——
都是运行时无关的，保持不变。

## 从源码构建

前置：Node.js >= 22、pnpm、Rust 工具链、Tauri 系统依赖。

```bash
git clone <本仓库> DeepLab
cd DeepLab
pnpm install

# 拉取固定版本 sidecar 与捆绑技能（git-ignored）。
bash scripts/dev/fetch-dsh.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh

# 开发运行或构建安装包。
pnpm --filter @deeplab/desktop tauri dev
pnpm --filter @deeplab/desktop tauri build
```

常用检查：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

`apps/desktop/src/test/dsh-live.smoke.test.ts` 会连接一个正在运行的 dsh 服务器对
`DshRuntime` 做端到端冒烟；无服务器时自动跳过。

## 安全与隐私

- 工作区文件、原始数据、会话历史、溯源、笔记本与运行记录默认全部留在本地；
  应用本身**无出站网络请求**。
- 命令执行、文件删除、依赖安装与远程连接都是桌面应用中的需人工批准流程
  （批准模式永不关闭）。
- Provider 凭据写入应用私有运行时配置，绝不进入工作区、溯源、git、导出或全局 dsh 配置。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/` | Tauri + React 桌面应用。 |
| `packages/sdk/` | `AgentRuntime` 缝 + `DshRuntime`（dsh 客户端框架）。 |
| `packages/shared/` | 共享领域类型与图表调色板。 |
| `runtime/skills/core/` | 一方科学技能。 |
| `runtime/dsh/` | 捆绑的 dsh sidecar（launcher + 固定版本 CLI）。 |
| `runtime/dsh-acp/` | 捆绑的 DeepSeek Harness ACP 智能体。 |
| `docs/` | 产品、技术、运维、连接器与研究笔记。 |
| `scripts/dev/` | sidecar、`uv`、技能拉取脚本。 |

## 状态

DeepLab 是一个工作中的桌面 MVP，由 Open Lab 派生并把运行时替换为 DeepSeek Harness。
最可靠的实现日志是 [`PROGRESS.md`](./PROGRESS.md)；与 Open Lab 的已知差异（dsh v1
API 缺口）列于其中。

## 许可

[MIT](./LICENSE)。捆绑的第三方技能与连接器保留各自的许可。

> DeepLab 是测试性研究工具。输出请视为草稿：在发表或决策前核对数字、引用、代码与结论。
