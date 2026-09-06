# OpenLab → dsh 迁移总体规划(板块版)

> 原则:OpenLab 产品层保留;dsh 是运行状态唯一事实来源;DeepLab 适配层翻译真实协议,不伪造状态、不留双份事实。
> 推进方式:一次一个板块,做完全演示+勾选+记 PROGRESS 再取下一块;不按天排期。
> 默认顺序:B1→B2→B3→B4→B5→B6。B6 打包自动化可与主线并行早铺。
> 卡上游 dsh 能力 → 当场定“等待上游/降级语义/暂缓”,先跳下一块,回头补。

## 基线(P0,已完成)
- 桌面壳 / dsh sidecar 生命周期与隔离 / SDK `DshRuntime` adapter / session·model·credentials·permission·skills 接入
- 研究五技能 + `/research` 命令部署并被 dsh 发现
- 科研管线无头端到端 + 子代理分派保真(2026-09-02)
- dsh 捆绑完整性护栏(启动预检 + fetch 自检 + CLI 检查)

## 板块与勾选

### B1 研究管线产品化 ✅(2026-09-05 应用内 PASS 4/4)
- [x] 修复 shell 工具命名导致的 run 不记录(pwsh/bash/sh…) + 回归测试
- [x] 修复根因:SDK `tool/result` 完成事件丢失 tool 名与 input —— 现按 callId 回填 name+input+startedAt(被动录制此前从未触发)
- [x] 验收脚本化:无头驱动(`run-research-pipeline.mjs`) + 证据收集器(`check-research-recordings.mjs`,authored=4、生成物归 runs)
- [x] 应用内 `/research` 一次验收:PASS 4/4(runs 7 条含 analysis.py、provenance 4/4、logs 6 份、六产物齐全),重启可查
- [ ] 后续打磨(B2):run `outputs` 归属为空(疑似 startedAt 单位) ;`record_run.py` 仍写 `.openlab/` 需迁 `.deeplab/`

### B2 状态域保真(进行中)
- [x] 现状审计(证据版):`docs/migration/B2-STATE-DOMAIN-AUDIT.md`
- [x] 修复:SDK 完成事件丢 tool/input(run/provenance 被动录制从没触发)+ 时间戳×1000 膨胀(outputs 归属失效)
- [x] 修复:技能 `record_run.py` `.openlab`→`.deeplab`(远程 run 并入 Runs 视图)
- [x] Q1/J1 决策:dsh v1 lib 无 `session/queue`/`session/jobs` 帧 → 队列保持 DeepLab 本地草稿箱语义(显式降级,不冒充 dsh 状态);无 jobs 幻影 UI
- [x] R1 结论:dsh 会话持久化依赖应用侧 workspace 注册(projcache),裸 RPC 无法无头复现重启找回;真实场景(B1 0136 会话重启可查)已间接验证 → **重启找回验证并入应用内验收**(与 B1 同法),headless 契约测试不可行已移除
- [x] P1 决策:`build/plan` 角色串是旧历史兼容(导入 OpenCode 会话),非伪状态 → 保留(不 broad-replace)
- [x] M1 结论:全局 memory 唯一文件 = `dsh-home/MEMORY.md`(UI 读写/instructions 注入/种子同一绝对路径;`/profile/MEMORY.md` 仅测试示例),项目=工作区 `AGENTS.md` → 每层单写入方,无第二源
- [x] T1 remote-runs 合并:改好的 `record_run.py` 已真实写入 `.deeplab/remote-runs.jsonl`,Rust `read_runs` 合并两文件(真 SSH 运行仍属环境门控)

### B3 科研资产链(usage 聚合完成)
- [x] 就绪度审计:`docs/migration/B3-ASSETS-AUDIT.md`(usage 缺通用聚合;notebook 环境门控;reviewer/domain-check 已可用)
- [x] usage 通用聚合:`lib/usage.ts` 核心 + SDK `usage.updated` 上浮 + store 累加 + Composer UsagePill(全量 918 通过)
- [ ] notebook 真 kernel 闭环(实证,环境)
- [ ] reviewer↔artifact 关联演示

### B4 连接器实环境
- [ ] MCP / Jupyter / browser connector 实环境闭环
- [ ] remote compute(SSH / Slurm / Modal)实环境闭环
- [ ] legacy `.openlab` 导入兼容(新写一律 `.deeplab`)
- [ ] note:compute.json 仍全链 `.openlab`(刻意兼容,迁移时机另定;`record_run.py` 已迁 `.deeplab`)

### B5 外围与清理(部分)
- [x] 可见品牌残留:webview title / model-probe UA / gateway health tag → DeepLab(2026-09-06)
- [x] 死脚手架:移除 src 下 26 个空占位 `.gitkeep`(features/占位组件/lib 空层)
- [ ] gateway 手机端回归
- [ ] i18n:新功能无硬编码用户文本
- [ ] 技能管理 UI;实验室 OpenAI-compatible provider 端到端(model-agnostic)
- [ ] 品牌/死代码/ACP 残留清理(兼容路径除外,持续)

### B6 发布成熟
- [ ] 打包可复现(自动化 NSIS/短路径,无手工 subst)
- [ ] 干净机全自动安装验收脚本
- [ ] macOS / Linux 装后验收;CI 骨架
- [ ] 凭据轮换与安全检查(历史暴露 key)
