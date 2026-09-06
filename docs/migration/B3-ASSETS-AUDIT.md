# B3 科研资产链 — 就绪度审计(证据版)

> 判定:已有(dsh/产品)/缺口(需实现或实证)。日期:2026-09-05。

## 1. Usage / 成本(通用聚合)

- 现状:仅有 **DeepSeek 专用**的鲸鱼路径(宿主插件按 provider 定价结算),产品层无按
  provider/model/session 的通用用量聚合(迁移矩阵 §4.16 缺口仍成立)。
- 证据:前端 `lib/runtime.ts` 无 `assistant/message` 或 `usage` 事件的用量处理;
  SDK(`packages/sdk`)未把会话消息的 token usage 上浮(stream chunk 类型有 `usage`,但未被消费);
  组件/状态里无通用 usage 面。
- **缺口/下一微切片**:SDK 把 `assistant/message`(或 stream `usage`)里的 token usage 以
  归一化事件上浮;前端用纯函数 `usage.ts`(累加 + 定价换算 + 本地/实验室 provider 记 0)聚合到
  每会话状态;UI 展示。核心可无头单测。

## 2. Notebook / Kernel

- 现状:UI 与 `kernel.ts`/`jupyter.rs` 保留(notebook 编辑器、kernel 连接、产物预览代码在);
  实际 Python/R kernel 执行与重连依赖本机工具/connector,尚未在本机实证。
- 证据:编辑器/测试覆盖 UI 与文件;执行链路属“环境门控”。
- **缺口**:本机(或远端)真 kernel 一条执行→重连→产物预览闭环;属实证类。

## 3. Reviewer / domain-check 接 dsh

- 现状:已有 dsh reviewer preset(只读)、`autoReview.ts`、`domain-check` 技能已部署且被模型
  真实调用(B1/B2 实录:模型运行前后各跑一次 domain-check);traceability/stats 等技能随 22 技能目录发现。
- 证据:B1 会话里 agent 实际调用 `domain-check` 两次;reviewer 为独立只读 preset。
- **缺口**:把 reviewer 结果与 artifact/provenance 关联的端到端演示仍未做(可选)。

## 4. 建议推进序
1. usage 通用聚合:SDK 上浮 usage → `lib/usage.ts`(累加/定价/本地记 0)→ 每会话状态 → UI。
2. notebook 实证(环境)。
3. reviewer↔artifact 关联演示。
