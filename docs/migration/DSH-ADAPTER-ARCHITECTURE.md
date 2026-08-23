# dsh 适配层架构

## 目的

DeepLab 的产品代码不应感知 dsh 的 HTTP envelope、RPC revision 或 Cordis 配置结构。适配层负责把 dsh 原生能力翻译为稳定的 DeepLab `AgentRuntime`，但不模拟 dsh 没有的能力。

## 模块职责

| 模块 | 责任 | 不负责 |
| --- | --- | --- |
| `DshApiClient` | HTTP/WS、鉴权、rpcId、错误 envelope | session 状态、重试策略、UI event |
| `rpc-contract` | 当前固定 dsh 版本中 DeepLab 使用的 payload/value | 复制上游全部 API |
| `DshGoalAdapter` | Goal CAS ref、projection 恢复、mutation | Goal UI、自动续行策略 |
| `DshModelAdapter` | 目录、当前选择、保存默认选择 | 启动 vLLM、保存密钥 |
| `DshSettingsAdapter` | settings namespace、credentials、permission preset | DeepLab 项目偏好 |
| `DshRuntime` | 生命周期、session、event folding、领域适配器编排 | dsh 配置文件直写 |

## 状态所有权

| 状态 | 所有者 | 恢复方式 |
| --- | --- | --- |
| 消息、工具、Goal、Plan、队列、Jobs | dsh session log | history + projections + mux |
| 模型目录、Provider 配置、凭据、权限 | dsh settings/credentials | dsh RPC |
| 项目列表、pane/layout、artifact UI 索引 | DeepLab | DeepLab store / SQLite |
| 科研运行记录、provenance | DeepLab workspace | append-only files + index |

任何同时出现在两列中的状态都必须指定唯一写入方。缓存只能作为 projection，不能成为第二写入源。

## 升级规则

DeepSeek Harness 仍处于 developer preview。每次升级必须：

1. 单独提交版本 pin 和 Node engine 变更。
2. 对照上游 `RpcMethodMap` 与 zod schema 更新 `rpc-contract`。
3. 运行 Goal CAS、model directory、history projection、approval/question 契约测试。
4. 启动真实 sidecar 执行无模型 smoke。
5. 至少执行一次真实 prompt，验证流式文本、reasoning、tool call/result 和 turn end。
6. 升级失败时回退版本 pin，不在运行时加入多版本猜测分支。

## Capability policy

功能状态只有三种：

- `available`：RPC/plugin 存在且通过验证；
- `unavailable`：当前 composition 未提供，应隐藏或禁用入口并说明原因；
- `experimental`：上游契约未稳定，默认不进入主流程。

禁止用 `[]`、`null` 或 no-op 把 unavailable 伪装成“成功但没有数据”。第二周起应给 `AgentRuntime` 增加 capability discovery，并逐步清理当前兼容 no-op。
