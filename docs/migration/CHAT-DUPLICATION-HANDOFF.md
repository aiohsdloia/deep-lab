# 交接:助手文本重复(一个问题 → 回答出现 2~3 次相同内容)

> 给接手模型。现象、证据、假设、代码指向都在这;先复现再改,别盲改。

## 已解决（2026-09-07）
- 已从真实会话 `session-f10b68a1-f55d-4afc-a068-ba1ecf32b90c` 确认根因：同一回答先以 `assistant/chunk`（`turn=1, step=1, index=0`）发送流式文本，随后以 `assistant/message`（`seq=20`）发送完整文本；SDK 曾分别生成 `text:1:1:0` 和 `20:final:0` 两个 partId，前端因此正确但错误地渲染成两个独立块。
- 修复位于 `packages/sdk/src/dsh/DshRuntime.ts`：最终消息按 dsh 的 `(turn, step, content-array index)` 复用流式 partId，让最终规范文本替换流式累积文本，而不是按内容做脆弱的字符串去重。
- 使用 content-array index 是必要的：推理块和工具块也占据 dsh 的 block index；若改用“第几个文本块”，混合回答仍会错位。
- 回归覆盖纯文本和“推理 + 工具 + 文本”两种事件序列；前端原有 `foldEvent` 测试已证明相同 partId 会幂等替换为一个块。
- 验证通过：聚焦测试 11/11、完整测试 921 通过/4 跳过、typecheck、lint、Vite build、Tauri GNU release build；两个实际安装位置均已替换为 SHA256 `8BDD8A041E5A63A5AD0CEA1B89F6F29365C9F96FD208346EB18AC9A4A1E01829` 的新程序。
- 安装版 UI 实测：DSH 原始历史仍包含流式 `3` 与最终 `3`（符合协议），DeepLab 页面只显示一个回答 `3`。测试 provider 为 `custom-mock-lab`，其固定回复内容以及页面的 `done` 状态行与重复渲染无关。

## 位置与环境
- 仓库:`C:\Users\10840\Documents\ChatGPT\deeplab`(分支 `codex/week-1-dsh-foundation`)
- 运行实例:沙箱 `AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\DeepLab\deeplab-workbench.exe`(部署需重编译拷入并重启)
- 前端文本折叠核心:`apps/desktop/src/lib/runtime.ts`(~4690 行)
- SDK 事件产生:`packages/sdk/src/dsh/DshRuntime.ts`

## 现象
- 会话线程里:**用户问题只出现 1 次**,但一条简单回答(如 `3`)被渲染成 **2 次,偶见 3 次**。
- **所有 provider 都这样**(DeepSeek-V4-Flash 与本地 mock 端点都复现)→ 不是模型/provider/网络问题,是应用内“流式文本 vs 最终文本”重复渲染。
- 长文本也会重复(浏览器调试会话里同一句被多轮重复,但那属工具重试;短回答 1→2/3 是纯渲染重复)。

## 证据
- 一个 `1 + 2 等于几?` → 回答显示两个 `3`(有次三个)。
- 非新增 provider 特有;mock 端点流式(SSE,finish_reason=stop)正常,排除解码。

## 假设(最可能)
SDK 同一次 assistant 回复产生**两条文本 part**,前端都渲染了:
1. 流式增量路径:partId 形如 `${turn}:${step}:${index}`(`DshRuntime.ts` stream chunk 分支累积 `streamText`);
2. 完成消息路径:partId 形如 `${event.seq}:final:${textParts}`(`assistant/message` 分支,整段文本)。

两者若落入同一 assistant 消息块的不同 part 且都被渲染 → 同文重复。请先确认前端把这两种 partId 映射成“同一气泡内不同段落”还是“两个气泡”,据此去重(例如:final 文本与同块最后一条流式文本相同则跳过/替换,而非追加)。

## 代码指向
- `packages/sdk/src/dsh/DshRuntime.ts`:`stream` chunk 分支(约 430-465)与 `case "assistant/message"`(约 467-500)分别 emit `text.updated` 的两种 partId。
- `apps/desktop/src/lib/runtime.ts`:文本/推理的实时折叠(搜 `text.updated` / `partId` / `:final:` / `streamText`),以及把这些 part 转成 thread 块、在 `session.idle` 收尾处的逻辑(约 2900-3070、4380-4470)。
- SDK 另新增了 `usage.updated` emit(若引入回归可先临时注释确认与重复无关)。

## 建议步骤
1. 最小复现:本地 mock 端点或 DeepSeek,一句话短回答;
2. 在 `text.updated` 折叠处打印 partId → 确认是否同时出现流式与 `:final:` 两条同文;
3. 修去重(替换而非追加同文 part;或统一 partId),补一条 store 级回归测试;
4. 复测:短/长文本、DeepSeek 与 mock、新会话首轮。

## 注意
- Windows;本机跑不了 Rust 测试(`STATUS_ENTRYPOINT_NOT_FOUND`),前端改动用 `pnpm --filter @deeplab/desktop test` + `typecheck` 验证。
- `tauri build` 会改 Cargo.toml 的 `macos-private-api`,记得还原。
