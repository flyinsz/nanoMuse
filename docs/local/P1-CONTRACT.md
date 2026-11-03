# P1 契约：`@<设备>` 直发（三端）

这份文件是三端实现的**唯一共同依据**。改动前先读完；任何与本文件冲突的实现都算错。

## 一、要解决的问题

现状：三端在 `@<设备>` 命中后都是**中转**，把任务交给本端模型，由模型再调派单工具。

| 端 | 现状路径 | 位置 |
|---|---|---|
| Android | `DeviceMention.apply` 注入 `SessionAddenda`（1 轮）→ 本地 Muse 跑完整 agent loop → 它调 `nanomuse-pc task` | `io.github.nanomuse.sync.DeviceMention.kt:58` |
| Web | runtime 的 `parse_mention` → agent 拿到 system note → 它调 `delegate` | `nanomuse/server/service.py:1213` |
| Mac | 无 `@设备` 概念 | — |

多一次 LLM 往返，且提示词是**软约束**（纯文本注入，无硬闸门），模型可能改写任务、漏调工具、或干脆自己做。

**目标**：命中在线设备时**跳过本端模型**，直接发 hub `task`。

## 二、共同行为（三端必须一致）

1. **只在消息以 `@` 开头时判定**（与上游 `parse_mention` 一致：`text.lstrip().startswith("@")`）
2. **只在设备在线时直发**；离线设备走原路径（上游行为：`mentionable` 含离线，但 `Hub.others().filter { it.online }` 才直发）
3. **匹配规则完全照抄上游 `nanomuse/sync/mention.py`**：
   - 先试**整名匹配**，多命中取**最长**
   - 整名后必须是边界（`\s,:;，：；` 或结束）
   - 否则取 `@` 后第一个词，作为**唯一**设备名的前缀（多个命中时，若恰好一个在线则用它，否则放弃）
   - **本端自己永不是目标**
4. **摘掉 mention 后的文本为空时不直发**（上游：`if mention is not None and (mention.text or attachments)`）
5. **`language` 要传**：当前 UI 的 BCP-47 tag，远端用它作答
6. **`conversation` 要传**：用设备 id，保证同一设备同一会话（上游 `_task` 缺省用发送者 id）
7. **失败处理（上游 #718 的教训）**：`result.text` 为空**不算成功**，要显示失败原因，**绝不显示「完成」**
8. **超时**：与目标侧对齐用 **15 分钟**（`TASK_TIMEOUT_S`）；不要用 10 分钟
   - 背景：上游 issue #805 —— 调用方上限短于目标侧时，用户已被告知失败而目标仍在跑，答案回来时 relay 已 `unknown_call`，工作与答案双失
9. **停止要传导**：用户按停止 → 发 `stop {conversation}` 到目标设备
   - 上游范式：`nanomuse/hub/service.py:1228`（`CancelledError` 分支）；不要只中断本地

## 三、三端各自的落点

### 3.1 Android

**新包** `android/src/android/app/src/main/java/io/github/nanomuse/terminal/`

| 文件 | 职责 |
|---|---|
| `DeviceTargetMention.kt` | 匹配（照抄 `DeviceMention.parse` 规则），返回「直发」判定 + 目标 + 剩余文本 |
| `RemoteTaskController.kt` | `Hub.call(deviceId, "task", args, timeoutMs, onEvent)` 封装；事件流 → 状态；`stop` |
| `RemoteTaskBubbles.kt` | 事件（`tool`/`tool_result`/`text`/`approval`/`approval_result`）→ UI 状态 |

- hub 通道：`Hub.call(to, action, args, timeoutMs, onEvent)`（`io.github.nanomuse.hub.Hub:170`）
- 事件处理模板：`io.github.nanomuse.reach.ReachOffloadHandler:105-140`（已写好全部 stage，直接抄）
- 审批复用一个已有组件：`io.github.nanomuse.reach.RemoteApprovalKey.target(ev)` + `Computers.approve`
- **上游文件改动：仅 1 处** — `com/openminis/app/ui/chat/ChatViewModel.kt:6283`，加 `// nanoMuse:` 标记
  - 现有那行是 `val nmText = io.github.nanomuse.sync.DeviceMention.apply(...)`
  - 改为：先问直发，命中则直接发 task 并 return；否则退回现有 `apply`
- **locale**：任何新字符串写进 `res/values-*/nm_strings.xml`，`nm_` 前缀，**16 个** locale 都要

### 3.2 Web

**落点**：`web/src/screens/ChatScreen.tsx`
- 浏览器**没有** hub socket（无 WebSocket），只能走 runtime 的 REST
- 直发 = `POST /api/hub/ask {device, text}`（runtime 已实现：建会话 + 首发消息，`nanomuse/server/api.py:1593`）
- 复用已有：`web/src/mention.ts` 的 `mentionTarget()`（**不要重写匹配逻辑**）
- 现有挂点：`Composer` 的 `onSend`、`ChatScreen.tsx:892` 已有 `target` 计算
- **上游文件改动**：`ChatScreen.tsx` 的 `Composer` 内，加 `// nanoMuse:` 标记
- 改完必跑：`cd web && npm run check && npm run build`，**并提交 `nanomuse/server/static/`**（入库的构建产物）
- i18n：`web/src/i18n/zh-CN.ts` 补中文（en 是 key 本身）

### 3.3 Mac (dsh)

**新文件** `harness/dsh-nanomuse/src/client/`
| 文件 | 职责 |
|---|---|
| `device-mention.ts` | 匹配（规则同 §2.3），**在 client 侧**（纯函数，可单测） |
| `device-task.ts` | `hub.call(deviceId, "task", ...)` + 事件流 |

- hub 通道：`ctx.nanomuseCloud.hub`（见 `src/reach.ts:46`、`src/cloud.ts:72`）
- **拦截点**：`AvatarChat.tsx` 的 `interceptComposer()` → `take(event)`（`AvatarChat.tsx:149`）
  - 它已经在做「捕获阶段监听 keydown/click → 命中就 preventDefault + stopPropagation」
  - 在 `take` 里、`parseAvatarRequest` 判定**之前或之后**插入 device mention 判定
  - 范式照抄 `avatarChat.words(text)` / `avatarChat.begin(...)` 那两行
- 设备数据：`client/live.ts` 的 `useLive()` → `LiveHub.devices`（`LiveDevice`，含 `id/name/kind/online`）
- **上游文件改动**：`AvatarChat.tsx` 的 `take()` 内，加 `// nanoMuse:` 标记
- i18n：`client/locales.ts` 的 `en` 与 `zh` **两块都要**
- 改完必跑：`cd harness/dsh-nanomuse && pnpm build && pnpm typecheck && pnpm test`

## 四、上游硬约束（违反即不可合并）

1. 不改 Kotlin 包名 `com.openminis.app`、不改 Gradle `namespace`、不改沙箱路径与 CLI 名
2. **新代码进新文件**；改上游文件必须加 `// nanoMuse:`（TS/Swift 用等价注释），**一处改动一个标记**
3. 用户可见字符串：**英文 → 简体中文 → 该文件已有的每个 locale**
4. 新文本**无 em/en dash**（`—`/`–`）；中文用中文写，避开 颠覆／王炸／保姆级／一键／赋能
5. 文档随代码：改行为就改 `docs/`，并在 `CHANGELOG.md` 的 *Unreleased* 下加一行
6. DCO 签名（`git commit -s`）、Conventional Commits；**不要**自己提交，交给主线统一收口

## 五、明确不做

- **不发明 hub action**（上游已有 `task` / `stop` / `approve` / `/api/hub/ask`）
- **不做远端会话枚举**（C7/C8 把「同一份对话」交给同步层，不是 hub）
- **不改 runtime `/ nanomuse/` 的 Python**（P1 三端都在客户端完成）
- 不碰 `android/` 的 subtree 合并史
