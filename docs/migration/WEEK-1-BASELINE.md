# DeepLab 第一周基线

日期：2026-08-23

## 本周目标

第一周不追求一次性恢复 OpenLab 的全部功能，而是建立可持续迁移的工程基线：

1. 固定 DeepLab、OpenLab 和 DeepSeek Harness 三方参照版本。
2. 将产品功能与 Harness 运行时能力分层，停止继续扩张单体 `DshRuntime`。
3. 修复 dsh 预览版升级已经产生的 RPC 漂移。
4. 建立功能迁移矩阵和后续验收门槛。

## 固定版本

| 对象 | 基线 |
| --- | --- |
| DeepLab | `cd232e5`，`Rebrand DeepLab as an independent product; refresh technical docs` |
| 开发分支 | `codex/week-1-dsh-foundation` |
| DeepSeek Harness | `0.1.1-rc.2` |
| OpenLab 参照 | Gitee `master`，分析时 HEAD `cfa3acf` |
| Node.js | `^22.19.0 || >=24.0.0` |
| pnpm | `9.4.0` |
| Rust | `1.97.1` |

DeepLab 的 dsh 版本必须同时出现在 SDK 常量、sidecar manifest 和抓取脚本中，并由自动化测试检查一致性。

## 架构决策

采用“保留产品层，重建 Harness 接入层”，不采用整仓推倒重来。

```text
DeepLab UI / research workflows
              |
       AgentRuntime facade
              |
  +-----------+------------+-------------+
  |           |            |             |
Session    Model        Goal         Settings
adapter    adapter      adapter      adapter
  |           |            |             |
  +-----------+------------+-------------+
              |
       typed dsh RPC client
              |
   dsh / Cordis / event log
              |
   cloud or local inference endpoint
```

边界规则：

- DeepLab 只支持一个智能体运行时：dsh。
- UI 不直接拼 RPC payload，也不读取 `settings.yaml`。
- dsh session event log 和 projection 是运行状态的事实来源。
- DeepLab 自己保存项目布局、视图和研究产物索引，不复制 dsh 的会话状态。
- 云模型和本地模型都通过 dsh Provider 接入，DeepLab 不承载推理引擎。
- dsh 尚未提供的能力必须显式标记 unsupported，不能返回空列表伪装成功。

## 本周发现并修复的协议漂移

### Goal CAS

dsh `0.1.1-rc.2` 的 `goal.pause`、`goal.resume`、`goal.complete` 和 `goal.clear` 必须携带当前 `{ id, revision }`。旧 DeepLab 只发送 `sessionId`，新版 sidecar 会拒绝请求。

新适配器会：

- 缓存每次 Goal mutation 返回的新 revision；
- 监听 `session/projection` 的 `goal` 投影；
- 应用重启后从 `session.history.projections.values.goal` 恢复 CAS ref；
- 每次 mutation 使用最新 ref。

### Model directory

dsh 模型目录的 provider key 已从旧实现假定的 `group.provider` 变为 `group.id`。默认模型也不能取 `llm.models` 的第一项；真实选择来自 `session.models.current`。

新适配器会：

- 从 `llm.models.groups[].id` 构建 Provider 列表；
- 从 `session.models.current` 读取真实默认选择；
- 通过一次 `session.selectModel` 保存新会话默认模型；
- 不批量改写其他已有会话的模型选择。

### Settings and credentials

权限使用 dsh 的 `permission.defaultPreset`；密钥只经过 `credentials.set` / `credentials.unset`，不写入 DeepLab JSON、日志或 session event。

## 已知未完成项

以下项目明确进入后续周，不计入第一周“基础层完成”：

- 自定义 OpenAI-compatible Provider 的完整编辑界面；
- `/models` 发现与本地模型健康检查；
- MCP 的 Cordis/profile 管理；
- Subagent、Workflow、Plan、Jobs 的 UI 投影；
- OpenLab 缺失科学技能的迁移；
- `runtime/tools` 两个 OpenCode 兼容工具改造成 dsh Cordis 插件；
- Rust `dsh_config.rs` 中遗留 JSON 配置命令的移除。

## 验收命令

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 本周验收结果

| 验收项 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| dsh 契约与版本测试 | 17 项通过 |
| 全量 Vitest（4 workers） | 116 个文件、875 项全部通过 |
| 真实 dsh sidecar smoke | 通过：连接、Provider、Skill、Session、History、Model |
| `pnpm build` | 通过；同时清除了已删除 ACP server 和 goal plugin 的失效构建引用 |
| Rust source check | GNU Windows target 通过，现有 24 条 dead-code warning |
| 正式 Windows bundle | 未执行；当前机器缺少发布用 `uv` / `agent-browser` sidecar 和 MSVC Build Tools |

默认并发的首轮全量测试中，既有 `FilePreviewInspector` 用例曾因高负载超过
5 秒；该文件单独复跑 12/12 通过，限制为 4 workers 后全量 875/875 通过。
本周新增 dsh 用例全部稳定通过。

真实 sidecar 冒烟使用临时 `DSH_HOME`，未写入个人 dsh 配置。由于该环境没有
DeepSeek 凭据，本周未执行真实模型 prompt；不能把无模型 smoke 记为推理链路验收。

## 第二周入口

第二周只推进 M2 的 P0 主链：实现 OpenAI-compatible Provider 配置、`/models`
发现、手工模型补录和健康检查，并以局域网本地推理服务完成一次流式文本、工具调用、
长上下文和断线恢复验收。Subagent、Workflow、科研技能迁移继续排在本地主链之后。
