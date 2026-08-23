<div align="center">

# DeepLab

**本地优先、模型无关的 macOS、Windows & Linux AI 科研工作台 —— 由 DeepSeek Harness (dsh) 智能体运行时驱动。**

DeepLab 是 Claude Science 及同类 AI-for-science 工作台的开源桌面替代，是一个自包含的
科研环境：项目、会话、溯源、运行记录、审查技能、查看器、笔记本、远程计算与网关，
全部由 **DeepSeek Harness** 作为唯一智能体运行时驱动。应用将 `dsh --profile web`
作为内置 sidecar 启动，并通过 dsh 的 `/api` HTTP+WebSocket 网关（dsh 客户端框架）与之通信。

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

## 架构

DeepLab 的智能体运行时是 DeepSeek Harness —— 一个开源的插件化智能体框架。
应用捆绑固定版本的 dsh sidecar，并端到端使用 dsh 客户端框架的原生线协议：

| 层 | 技术 |
| --- | --- |
| Sidecar | `dsh --profile web`（Node CLI，经 `runtime/dsh/launcher.mjs`），由应用以应用私有 `DSH_HOME` 启动 |
| 传输 | dsh `/api` HTTP POST 一元调用 + `/api/events.mux` `/api/events.host` WebSocket 下行流 |
| SDK | `DshRuntime`（`AgentRuntime` 缝） |
| 会话 | dsh `session.*` RPC + 会话日志事件折叠 |
| 技能 | `<dsh-home>/skills/` + 工作区 `.dsh/skills/` |
| Provider/MCP | dsh `llm.*` / `credentials.*` / `settings.*`（MCP 在 cordis.yml 中配置） |
| 权限 | dsh 权限预设 —— 默认 workspace-write；"无限模式"= danger-full-access 完整文件系统访问 |

其余一切 —— 线程、溯源、运行、项目、审查、查看器、笔记本、远程计算与网关 ——
都位于这一运行时缝之上，与运行时无关。

## 从源码构建

前置：Node.js ^22.19.0 或 >=24.0.0、pnpm、Rust 工具链、Tauri 系统依赖。

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
| `docs/` | 产品、技术、运维、连接器与研究笔记。 |
| `scripts/dev/` | sidecar、`uv`、技能拉取脚本。 |

## 状态

DeepLab 是一个运行在 DeepSeek Harness 运行时上的桌面应用。
最可靠的实现日志是 [`PROGRESS.md`](./PROGRESS.md)，其中也列出了 dsh v1 API 缺口与
dsh 架构迁移待办。

## 许可

[MIT](./LICENSE)。捆绑的第三方技能与连接器保留各自的许可。

> DeepLab 是测试性研究工具。输出请视为草稿：在发表或决策前核对数字、引用、代码与结论。
