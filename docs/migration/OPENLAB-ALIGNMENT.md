# OpenLab ↔ DeepLab 精确功能核对

> 依据:gitee.com/sculab/open-lab 浅克隆(`%TEMP%/openlab-upstream`,仅只读)
> 的 README「Station equipment / Platform」+ 文件级比较(路由页、核心技能目录),
> 对 DeepLab 当前 HEAD。日期:2026-09-06。

## 文件级差异(硬证据)

- **路由页**:OpenLab 仅多 `SettingsPage.modelBrowser.test`(已删的模型浏览器之测试)。
  DeepLab 无缺失的功能路由。
- **核心技能目录**(repo 内 `runtime/skills/core/`,与“随安装发布的目录”不同源):
  - 上游独有(DeepLab repo 目录无):`academic-translation`、`paper-review`(**刻意移除**,
    旧中文/OpenCode 遗留)、`grillme`、`research-talk`、`plant-recognize`、`self-restart`(疑似实验室私有);
    `integrity-auditor`、`mindmap-render` 在 DeepLab **安装目录的 22 技能清单里存在**(由外部 ai4s 技能包提供)。
  - DeepLab 独有:`image-tools`(OpenLab 用外部视觉服务,DeepLab 走 dsh 技能识图)。

## 逐模块核对(按上游 README Platform/能力)

| 模块 | OpenLab | DeepLab | 状态 |
|---|---|---|---|
| 桌面壳 / 多平台 | Tauri2·OpenCode | Tauri2·dsh | 对等(运行时=迁移核心) |
| 科研五技能 + ai4s | 内置 | 内置+dsh 化(应用内实证跑通) | 对等/已超越 |
| domain-check(8 学科)/phylo/traceability/stats/large-file/pub-fig/remote/modal | 有 | 有(22 技能目录含) | 对等 |
| 项目/工作区/导入徽章 | 有 | 有(写 `.deeplab`,兼容读 `.openlab`) | 对等(命名迁移) |
| 会话历史/队列/搜索/`/`命令/清理模式 | 有 | 有(dsh 语义;queue=本地草稿箱) | 基本对等 |
| 会话 archive/**restore/export** | 有 | archive+export 在;restore 无(dsh v1)→ 显式降级 | **差距(刻意)** |
| 消息 revert/编辑 | 有 | 无 → 引导 fork | **差距(刻意)** |
| /plan、/goal、subagent 状态、Stop | 有 | /goal+预设+steps;无 dsh plan 域 | 部分 |
| 布局:N 叉分屏/Screens/每窗格模型 | 有 | 已保留(PaneTree/Screens) | 对等(待回归) |
| Memory(全局/项目)+compaction | 有 | 每层单文件核实;随 dsh | 对等(压力待验) |
| 主题/缩放(含 E-ink) | 有 | ThemeProvider 保留 | 对等(待回归) |
| 文件浏览/检查器/artifact 溯源 | 有 | 有(B1 验证记录链) | 对等 |
| Remote access(只读/全量) | 有 | 有(token/read-only) | 对等(手机回归待做) |
| Browser control(自有 Chrome/私有) | 有 | browser-plugin+open-science-browser 技能在 | 待实证 |
| Notebooks(.ipynb/Py/R/kernels/uv Jupyter) | 有 | UI 在;**真 kernel 未实证** | **差距(待实证)** |
| Runs(reproduce 提示) | 有 | 有(reproduceRunPrompt) | 对等 |
| Provenance `.openlab/…jsonl` | 有 | `.deeplab/…jsonl`(B1 通过) | 对等(改名) |
| Viewers(含 DOS/EIGENVAL/qcode/anomaly/phase 等) | 有 | 组件保留 | 对等(待回归) |
| 科学 MCP connectors(arXiv/PubMed/Materials/weather…) | 一键 | 桥+UI 在,具体连接器目录需逐一对齐 | **部分/待实证** |
| Usage/成本 | —(OpenCode 侧较少) | 新增每会话 pill | 超越/视图待补 |
| 实验室本地模型/视觉服务 | 有 | lab provider 可配,端到端未验 | 待实证 |
| i18n 中英 | 有 | 有 | 对等 |
| 发布安装包 | 有(未签名 DMG/EXE/MSI/deb/rpm) | 可移植目录;**NSIS 未通(深路径)** | **差距(待修)** |
| 领域定位 | 演化生物学/系统发育为主 | 通用科研(仍含 phylo 能力) | 定位宽化(产品选择) |

## 结论
真正“缺”的仍是三类:**刻意降级**(restore、revert、plan→预设)、**未实证**(notebook、
browser/MCP connectors、实验室端点、手机端回归)、**发布/打磨**(NSIS、usage 聚合视图、
E-ink/主题与分屏回归)。核心能力面与上游基本对齐,无功能路由缺失。
