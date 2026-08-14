# 更改总结（Change Summary）

> 日期：2026-08-02
> 范围：Open Science Desktop（`apps/desktop` 前端 + `src-tauri` Rust 后端 + `packages/sdk` 相关类型）
> 说明：本文档总结本次会话所做的全部更改、更改的文件与方式、以及验证结果。

---

## 目录

1. [Bug 修复：会话切换不再新开屏幕](#1-会话切换不再新开屏幕)
2. [Bug 修复：问题弹窗始终提供文字输入框](#2-问题弹窗始终提供文字输入框)
3. [新功能：会话提示队列（Prompt Queue）](#3-会话提示队列)
4. [新功能：运行中回车直接入队](#4-运行中回车直接入队)
5. [新功能：在终端 / VS Code 中打开会话文件夹](#5-在终端--vs-code-中打开会话文件夹)
6. [UI 调整：加粗与品牌名](#6-ui-调整加粗与品牌名)
7. [i18n 多语言](#7-i18n-多语言)
8. [验证](#8-验证)

---

## 1. 会话切换不再新开屏幕

### 问题
在屏幕 1（Screen 1）使用时，点击左侧边栏的会话会**新开一个屏幕**（预览屏），而用户期望在当前屏幕中打开该会话。

### 根因
`useLayoutStore.openSessionEphemeral()` 在不存在"预览屏"时会**新建一个 Screen** 来承载点击的会话（浏览器"预览标签页"式的设计），导致每次切换会话都多出一个屏幕。

### 修改方式
- **`apps/desktop/src/lib/layout.ts`**
  - 修改 `openSessionEphemeral()` 的"无预览屏"分支：不再新建 Screen，而是**在当前活动屏幕中打开**：
    1. 会话已在当前屏幕 → 仅聚焦对应面板；
    2. 当前屏幕为空 → 填充它；
    3. 否则 → 用 `setLeafSession()` 把聚焦面板绑定到该会话（原地切换）。
  - 更新相关注释，说明侧边栏点击=切换视图、不再生成新屏幕。

### 配套改动
- `apps/desktop/src/components/sidebar/Sidebar.tsx`：更新点击行为的注释。
- `apps/desktop/src/lib/layout.test.ts`：新增 3 个测试（当前屏切换、聚焦已存在会话、填充空屏）。
- `apps/desktop/src/components/sidebar/Sidebar.sessions.test.tsx`：更新旧断言（不再产生第二个 Screen）。

---

## 2. 问题弹窗始终提供文字输入框

### 问题
会话请求输入时：
- **纯自由文本问题**没有输入框（已修复）；
- **带选项的问题**点击选项后**直接提交**，用户没有机会输入自定义文字——体验上"没有出现输入框"。

### 根因
`InteractionPrompt.tsx` 的 `QuestionCard` 只根据 SDK 的 `custom` 标志决定是否渲染文字框；且存在"点选即答"（`isQuickPick`）快捷路径——单选项问题点一下选项就立即提交，隐藏了底部"提交"按钮。

### 修改方式
- **`apps/desktop/src/components/thread/InteractionPrompt.tsx`**
  - **每个问题项始终渲染自由文字输入框**（去掉 `it.custom &&` 条件）。
  - **移除 `isQuickPick` 点选即答逻辑**：点击选项只做"选中"，不再立即提交；底部"提交"按钮始终显示。
  - 选项按钮 `onClick` 一律调用 `toggle()`；`ready` 判定保持"每项至少一个答案（选项或文字）"。
  - 移除标题栏中与底部重复的"跳过"按钮（底部始终显示后标题栏不再需要）。
  - 更新相关注释。

### 配套改动
- `apps/desktop/src/components/thread/InteractionPrompt.test.tsx`：
  - 更新"点选即答"测试为"选中 + 提交"；
  - 新增"无选项时通过文字框提交"、"选项 + 自定义文字"、"带 custom 的问题不做点选即答"等测试。

---

## 3. 会话提示队列

### 需求
- 对话窗口新增"提交到队列"按钮（纸飞机图标），每个会话有一个队列；
- 会话完成后按顺序自动执行队列（执行一条删除一条）；
- 新增"查看队列"按钮（图标），在当前窗口内打开子页面查看/编辑队列文字。

### 后端状态与逻辑（`apps/desktop/src/lib/runtime.ts`）
新增 per-session 队列状态与动作：

- 状态：`queues: Record<string, string[]>`（按会话 id 键控，内存态，不持久化）。
- 动作：
  - `enqueuePrompt(sessionId, text)`：入队（去空白），并尝试立即 `drainQueue`（会话空闲则立刻开始）；
  - `removeQueuedPrompt(sessionId, index)`：删除一条；
  - `appendQueuedPrompt(sessionId, text)`：追加（编辑器"添加"用，允许空白占位行）；
  - `updateQueuedPrompt(sessionId, index, text)`：就地编辑一条；
  - `setQueue(sessionId, items)`：整体替换（编辑保存）；
  - `clearQueue(sessionId)`：清空；
  - `drainQueue(sid)`：FIFO 执行一条、删除一条。守卫：队列为空 / 会话正在运行或发送中 / 有未答的 question 或 permission 时跳过；跳过并丢弃空白占位行。
- **自动执行**：在 `session.idle` 事件处理里调用 `get().drainQueue(sid)`（被打断的轮次在其早退分支之前返回，因此不会在中断后续跑队列）。

### 队列自动执行的健壮性修复
- **同步轮次（`!` shell / `/` 命令）**：`session.idle` 到达时发送锁（`sendingSessions`）尚未释放，`drainQueue` 会提前返回导致队列卡住。在 `performTurn` 的 `finally`（发送锁释放后）追加 `if (!failed) get().drainQueue(lockKey)`——异步普通轮次因运行锁仍在而自然跳过，同步轮次在此得到第二次机会；失败的轮次不续跑。
- **漏掉 `session.idle`（SSE 重连窗口）**：在 `reconcileRunning` 清理遗漏运行锁后追加 `get().drainQueue(sid)`。

### 前端 UI
- **`apps/desktop/src/components/thread/Composer.tsx`**
  - 新增 props：`queueCount`、`onEnqueue`、`onOpenQueue`。
  - 左侧新增"查看队列"图标按钮（`ListChecks`，带数量角标，>0 时显示）。
  - 发送按钮旁新增"提交到队列"纸飞机按钮（`Send`），把当前输入入队并清空输入框；`!` shell 与 `/` 命令模式不可入队。
  - 运行中（`working`）也能入队（这正是排队场景）。
- **`apps/desktop/src/components/session/SessionView.tsx`**
  - 从 store 取队列数与 `enqueuePrompt`，把三个 props 传给 Composer（仅真实会话 `eid` 存在时）。
  - 本地状态 `queueOpen` 控制队列子页面的开关；新增 `QueuePanel` 渲染。
- **`apps/desktop/src/components/thread/QueuePanel.tsx`（新增）**
  - 会话队列编辑器子页面（`role="dialog"`，Esc 关闭，且阻断面板的 Esc 打断逻辑）。
  - 每条队列提示是一个可编辑 textarea（自动增高），支持添加、逐条删除、清空；编辑实时写回 store，队列在打开状态下也会实时随自动执行消失。

### 配套改动
- `apps/desktop/src/lib/runtime.store.test.ts`：新增队列测试（运行中入队+idle 后自动执行、空闲入队立即执行、同步 shell 轮次后自动执行、被 question 阻塞时不执行、编辑动作）。
- `apps/desktop/src/components/thread/Composer.test.tsx`：新增纸飞机入队、`!` 模式禁用、数量角标与打开按钮测试。
- `apps/desktop/src/components/thread/QueuePanel.test.tsx`（新增）：编辑/添加/删除/清空、空态、Esc 关闭。

---

## 4. 运行中回车直接入队

### 需求
会话运行中，在输入框按回车（消息非空）应**直接进入队列**（此时发送按钮已变成 Stop，回车原本是无效操作）。

### 修改方式（`apps/desktop/src/components/thread/Composer.tsx`）
- 回车处理逻辑改为：
  - `working` 为真时 → 调用 `enqueue()`（入队并清空输入框）；
  - 否则保持原行为 → `submit()` 直接发送。
- 受既有限制：`!` shell / `/` 命令仍不可入队。

### 配套改动
- `Composer.test.tsx`：新增"运行中回车入队"测试。

---

## 5. 在终端 / VS Code 中打开会话文件夹

### 需求
会话右上角文件夹按钮的左侧新增"打开"图标，可把当前文件夹在**终端（默认）或 VS Code** 中打开，并按不同系统适配。

### 后端（Rust）
- **`apps/desktop/src-tauri/src/artifact_file.rs`（新增 `open_folder_in`）**
  - 命令：`open_folder_in(path, target)`，`target ∈ {"terminal", "vscode"}`。
  - 校验路径必须是**已存在的目录**并 `canonicalize` 解析符号链接，非法路径直接拒绝。
  - **跨平台适配**：
    - **macOS**：终端 → `open -a Terminal <dir>`；VS Code → 先 `code` CLI，回退 `open -a "Visual Studio Code"`。
    - **Windows**：终端 → `cmd /C start "" cmd /K "cd /d <dir>"`（空标题避免被当作窗口标题、`start` 分离新窗口）；VS Code → `code` CLI。
    - **Linux**：终端按优先级尝试 `gnome-terminal`/`konsole`/`xfce4-terminal`（`--working-directory`）与 `x-terminal-emulator`/`xterm`（`-e sh -c 'cd … && exec $SHELL'`）；VS Code → `code` → `codium` → Flatpak。
- **`apps/desktop/src-tauri/src/lib.rs`**：将 `artifact_file::open_folder_in` 注册进 `invoke_handler`。

### 前端
- **`apps/desktop/src/lib/tauri.ts`**：新增 `openFolderIn(path, target = "terminal")`（桌面端专用，`invoke("open_folder_in", …)`）。
- **`apps/desktop/src/components/session/SessionView.tsx`**
  - 在右上角文件夹（Files）按钮**左侧**新增一个 `SquareTerminal` 图标按钮（Radix `DropdownMenu`）。
  - 菜单含两项："在终端中打开"（默认项）与"在 VS Code 中打开"。
  - 仅桌面端（`isTauri`）且会话有目录（`sessionDir`）时显示；交互时 `pinEphemeral()` 固定预览屏。

---

## 6. UI 调整：加粗与品牌名

### 修改内容
- **左侧菜单标题全部加粗**（`apps/desktop/src/components/sidebar/Sidebar.tsx`）：
  - 主菜单项（新建 / Notebooks / 文件 / 运行 / 技能）：`NavRow` 按钮加 `font-semibold`；
  - "项目"（Projects）分区标题：`font-medium` → `font-semibold`；
  - "会话"（Sessions）分区标题：`font-medium` → `font-semibold`。
- **左上角品牌名**（`Sidebar.tsx`）：`Open Science` → `Open Science (YY)`。
- **屏幕标签"屏幕 x"加粗**（`apps/desktop/src/components/session/GroupTabs.tsx`）：标签 `span` 加 `font-semibold`。

### 修改方式
均为 Tailwind class 层面的样式调整，未改动任何逻辑；品牌名按产品品牌处理（保留 eslint 的 i18n 豁免注释）。

---

## 7. i18n 多语言

所有新文案均已同步到 7 种语言（`en / zh-Hans / de / es / fr / ja / ko`），保证 `parity.test.ts` 的键集合完全一致：

- `interaction.question.customAria`（问题输入框的可访问标签）。
- `composer.queue.*`（enqueueAria / enqueueTitle / viewAria / viewTitle）。
- 顶层 `queue.*`（title / count / clear / add / empty / hint / itemPlaceholder / removeAria / removeTitle / closeAria / closeTitle）。
- `live.openFolder.*`（title / terminal / vscode）。

`resources.d.ts` 通过导入 `en/session.json` 自动获得类型，无需手改。

---

## 8. 验证

- **前端**：`tsc --noEmit` ✅；`eslint` ✅（对 `"terminal"`/`"vscode"` 等枚举字面量加了 i18n 豁免注释）。
- **Rust**：`cargo check`（dev profile）✅，无编译错误。
- **测试**：
  - 全量 vitest 套件：**779 项全部通过**（105 个测试文件）；
  - 新增/更新测试覆盖：布局切换、问题输入框、队列（含同步轮次与漏 idle 场景）、Composer 队列按钮与回车入队、QueuePanel 子页面。
  - i18n parity 测试通过。

---

## 附：改动文件清单

### 前端（`apps/desktop/src`）
| 文件 | 改动 |
| --- | --- |
| `lib/layout.ts` | 会话点击在当前屏打开 |
| `lib/layout.test.ts` | 布局新行为测试 |
| `lib/runtime.ts` | 队列状态/动作 + idle 自动执行 + performTurn finally/reconcileRunning 兜底 |
| `lib/runtime.store.test.ts` | 队列测试 |
| `lib/tauri.ts` | `openFolderIn` |
| `components/sidebar/Sidebar.tsx` | 注释、品牌名、菜单加粗 |
| `components/sidebar/Sidebar.sessions.test.tsx` | 行为断言更新 |
| `components/thread/InteractionPrompt.tsx` | 始终文字框、移除点选即答 |
| `components/thread/InteractionPrompt.test.tsx` | 输入框相关测试 |
| `components/thread/Composer.tsx` | 队列按钮、回车入队 |
| `components/thread/Composer.test.tsx` | 队列按钮测试 |
| `components/thread/QueuePanel.tsx` | 新增：队列编辑器子页面 |
| `components/thread/QueuePanel.test.tsx` | 新增：队列编辑器测试 |
| `components/session/SessionView.tsx` | 队列接入 + 打开文件夹按钮 |
| `components/session/GroupTabs.tsx` | 屏幕标签加粗 |
| `i18n/locales/*/session.json`（7 个） | 新文案键 |

### 后端（`apps/desktop/src-tauri/src`）
| 文件 | 改动 |
| --- | --- |
| `artifact_file.rs` | 新增 `open_folder_in`（跨平台终端/VS Code） |
| `lib.rs` | 注册命令 |
