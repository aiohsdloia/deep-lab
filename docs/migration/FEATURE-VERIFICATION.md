# 功能实测记录(notebook / browser / MCP / lab endpoint / mobile)

> 结论先行:这些“实证类”功能都依赖真实运行环境;无头克隆整套 app 家目录
> (含大符号链接树)+ 真浏览器的方案在本机不可行(超时)。统一改用 **应用内短验收**
> (与 B1 同法:你在真实 App 里发一条短指令,我核对磁盘产物/日志)。日期:2026-09-07。

## 各功能状态与实测方式

| 功能 | 现状 | 验证方式(应用内,~1-3 分钟/条) | 状态 |
|---|---|---|---|
| Notebook 本地执行 | UI/代码在,真 kernel 未实证 | 建/开一个 `.ipynb`,跑一个 Python cell(如 `2+2`),看输出与内核状态 | ✅ 2026-09-07 应用内:输出 4、无报错(基础执行通过;重连/长会话后续可选) |
| 浏览器控制 | skill/browser-plugin 在 | 发一条“用 open-science-browser 打开 example.com 并把标题告诉我” | 待应用内 |
| 科学 MCP 连接器 | 7 个连接器 UI 在 | 在设置启用某连接器后,让 agent“用 arxiv 搜 xxx” | 待应用内(+需连接器可用) |
| 实验室端点 | 可配 provider | 配一个 OpenAI-compatible 端点后跑一条对话 | 需真实 lab 端点(或本地 mock) |
| 手机/网关回归 | 能力保留 | (可选)手机宽度浏览器打开网关 URL | 可选,暂缓 |

## 已排除的自动化方案(记录,避免重走)
- 无头 dsh + 复制 app `dsh-home` 再跑 browser skill:home 内含 `profiles/node_modules` 大符号链接树,
  dereference 复制巨慢(>15 分钟仍无结果);且需真浏览器,超时不稳定。→ 弃用,改应用内验收。
- 完整 `cargo test`:本机 Rust 测试可执行文件无法启动(已知 STATUS_ENTRYPOINT_NOT_FOUND)。
