# B1 应用内 `/research` 验收手册

> 目的:证明“研究管线产物自动进入 DeepLab 的 run / provenance / artifact”,且重启后可查。
> 时间:约 3 分钟(一次真模型跑,消耗约 ¥1-3)。
> 前置:已安装的 DeepLab(或 `pnpm --filter @deeplab/desktop tauri dev`),已配置可用模型 key。

## 步骤

1. 启动 DeepLab,在侧栏新建一个项目,名字建议 `research-accept`(会自动建到
   `~/Documents/DeepLab/research-accept`,并把一个会话指到它)。
2. 往该项目的数据目录放一份数据:复制
   `examples/climate-trends/data/gistemp_global_means.csv`
   到 `research-accept/data/`(也可用任何小 CSV)。
3. 在该项目的新会话里点击 **“启动完整科研流程”** starter —— 实测它会真的启动
   ai4s-agent,并**在界面内向你澄清三件事**(实测 2026-09-03):
   - 方向:选 **Specific topic**,并在回答里给出主题(如 “GISTEMP 全球年平均温度异常的线性趋势 1880–2025”);
   - 约束:选 **Resource limits**(要求纯标准库/轻量);
   - 实测数据:选 **Yes — I have real data/results**,并给出 `data/gistemp_global_means.csv`
     (这样实验产出的数字标为真实、非 simulated)。
   - 然后点 **提交**。若选项未弹出详情框,直接用下方输入框以自然语言把以上答案说全再发送。
4. 等模型跑完(约 5-15 分钟,子代理分派会久一些;途中若有提问就答“按你的最佳判断继续,不要问”)。不要中途关闭。
5. 跑证据收集器:

   ```powershell
   node scripts/dev/check-research-recordings.mjs "$HOME\Documents\DeepLab\research-accept"
   ```

   期望输出 `RESULT: PASS`,并显示 1 条含 python 的 local run + provenance 覆盖 6 个文件。
6. 重启 DeepLab,再次运行第 5 步 —— 行数不变且仍 PASS,即“重启可查”。

## 若 FAIL

- `runs.jsonl has a local python run` 为 FAIL → 说明该次执行没被判定为 run:
  可能是模型用 `pwsh`/其它 shell 执行但命令文本不像可执行(python/./run.sh 等)。
  把 `RESULT` 输出与消息原文发回,附上 `~/.deeplab/<project>/.deeplab/runs.jsonl` 行数。
- provenance FAIL 但 runs PASS → 文件写入事件没进溯源,发回输出。
- 截图或导出会话可作额外证据。

## 说明

- 无头等价验证见 `scripts/dev/run-research-pipeline.mjs`(`--smoke`/`--fidelity`);
  它绕过了应用层,因此**不会**写 `.deeplab` 记录 —— 本手册覆盖的正是它补不上的那一段。
- 已探明:WebView2 可用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
  暴露 CDP(`http://127.0.0.1:9222/json/version` 可达),未来可做真正无人工的 GUI 自动化验收。
