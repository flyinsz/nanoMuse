# nanoMuse 二开开发计划（三端：Android + Web + Mac）

> 目标：把「向另一台设备下达指令」从「模型中转」升级为一等公民体验，
> 三端行为一致；技能在设备之间可共享。
> 硬约束：**复用上游已有组件，改动落在新文件里；绝不触碰 `android/` 子树的合并史。**

- 上游：<https://github.com/nano-muse/nanoMuse>（v1.0.9 Tiller，GPL-3.0-or-later，`main` = `91f49429`，2026-11-03 00:32）
- 我们的 fork：<https://github.com/flyinsz/nanoMuse>（`main` 与上游同点 + 1 个本地提交）
- 三端覆盖：Android（`android/src/android`）、Web（`web/`）、Mac（`harness/dsh-nanomuse/`）
- 基线核对日期：2026-11-03

---

## 零、已确认的三个决定

| # | 决定 | 状态 |
|---|---|---|
| 1 | 先合并 OpenMinis 1.14/1.15 | **撤回**，见 §1.4（合并是上游的动作，不是我们的） |
| 2 | 不做远端记忆视图 | 采纳 |
| 3 | P1 按「可提 PR」标准写 | 采纳 |

---

## 一、版本与基线（已逐字节核实）

### 1.1 两个「版本」不要混

| | 是什么 | 状态 |
|---|---|---|
| **nanoMuse 仓库** | 我们 fork 的对象 | ✅ 最新，`main` = 上游 `91f49429` |
| **`android/` 目录** | nanoMuse 用 `git subtree` 引入的 OpenMinis 快照 | ⏸ 停在 **1.13** |

验证方式（逐文件比对 git blob 哈希，不是看文档）：

```
OpenMinis 1.13 ：同名文件 398 个，内容完全一致 398 个   ← 基线
OpenMinis 1.12 ：396/398
OpenMinis 1.14 ：395/398
OpenMinis 1.15 ：385/392
```

有差异文件逐个判定也全部落在 1.13。

### 1.2 上游自己也没合并 1.14 / 1.15

- `upstream/main:android/BUILDING.md` 与我们的哈希**完全相同**（都是 1.13）
- 上游 `CONTRIBUTING.md:44` 的示例仍是 `git subtree pull --prefix=android openminis 1.14`（说明 1.14 还没进去）
- 上游无相关 branch / PR

### 1.3 改动量（这就是为什么不能自己合）

| 区间 | 文件 | 行数 |
|---|---|---|
| 1.13 → 1.14 | 1102 | +359,222 / −46,505 |
| 1.14 → 1.15 | 2173 | +376,384 / −64,029 |
| 1.13 → 1.15 | 2805 | +721,020 / −95,948 |

而 `android/` 子树里**已有 112 个上游 Kotlin 文件、620 处 `// nanoMuse:` 标记**（既存债务）。

### 1.4 为什么撤回「先合并」（重要）

`git subtree pull` 会写入一条**把 OpenMinis 历史接进本仓的 merge commit**。

- 上游做这件事时，它掌握节奏，也有完整测试
- **我们抢先做**，就在 fork 里造出一段「上游没有的 subtree merge 史」。此后 `git rebase upstream/main` 会因为两边都对 `android/` 有独立的 subtree 合并而反复冲突——**这恰好制造了最初要避免的「跟进上游的麻烦」**
- 而且 72 万行改动 × 620 处标记的冲突，是一次高风险、且**上游并不需要**的合并

**结论：`android/` 保持 1.13 不动。等上游合并时，我们跟着 rebase。**
`scripts/local/nm-fork.sh release` 保留（上游合并后可能有用），但**不主动执行**。

### 1.5 上游节奏（决定我们该往哪放精力）

| 指标 | 数值 |
|---|---|
| 近 7 天总提交 | 356 |
| 近 7 天触碰 `android/` 的提交 | 34（其中改 `.kt` 的 18） |
| 近 30 天总提交 | 1731 |

`android/` **确实在天天变**（7 天 34 次），但那是上游在 `android/` 里自己改（`io.github.nanomuse.*` 与新文件），**不是 subtree 合并**。subtree 合并约**每月一次**。

⇒ 我们的策略不变：**新代码进新文件、上游文件改动极少且集中**，就能让「每日 356 次提交」几乎无感。

---

## 二、三端现状（已逐端核实）

> ⚠️ **本节已于 2026-11-05 重写**。原表停在合并上游 92 个提交**之前**，其中「Android 中转」
> 「Web 中转」两条已被上游自己的实现取代（上游在 `sync/` 里做了 `@设备` 直发），照原表做决策会走错方向。

| 能力 | Android | iOS | Web | Mac (dsh) |
|---|---|---|---|---|
| `@设备` 发送 | ✅ **直发** hub `task`（上游 `sync/RemoteDeviceRoute` + `RemoteChatBridge`） | ✅ 直发 hub `task`（上游 `NanoMuseDeviceMention`） | ✅ 直发（runtime `parse_mention` → `delegate`，或 `device-send.ts` 的 `POST /api/hub/ask`） | ✅ `device-mention.ts` + `device-task.ts` |
| `@` 补全 UI | ✅ 设备优先（上游 `sync/DeviceMentionMenu`，在文件之前） | ✅ 设备优先（`AIChatViewModel+MentionMenu.swift`） | ✅ 有建议 + 目标提示（`web/src/mention.ts`） | ❌ 仅 DevicesPanel 一行 `@name` 文字 |
| **设备条（一行头像）** | ✅ **fork 独有**（`terminal/DeviceStrip` + `ui/chat/DeviceFacesRow`） | ❌ | ✅ **fork 独有**（`device-strip.ts` + `components/DeviceFaces.tsx`） | ✅ **fork 独有**（`device-row.ts` + `DeviceRowSlot.tsx`，2026-11-05 补） |
| 未读绿点 | ✅ fork（`DeviceNews` + `DeviceInbox`） | ❌ | ✅ fork（`hasNews` + `newestUnreadIncoming`） | ◐ fork：只覆盖「有设备在等本机回答」（`newsIds`，来自 `hub.asks`） |
| 设备会话（`thread.device`） | ✅ fork（`terminal/DeviceChat`） | ❌ | ✅ `Ask` → `POST /api/hub/ask` | ❌（本机无设备专属会话，见下） |
| 设备会话进会话列表 | ✅ fork（`DeviceChat` 建会话 + `From <设备>` 命名） | ❌ | ✅ 图标 + 路由（`ChatScreen.tsx:1155`） | ❌ |
| 派单工具 | `nanomuse-pc`（sandbox shell） | 无（所以直发） | `delegate` | `delegate` + `device_*` |

### 2.0 合并后新增的两处欠账（2026-11-05）

**① 上游路径与我方路径落点不一致（未修，用户决定暂不动）。**
`ChatViewModel.sendMessage` 里两条路径并存：上游 `nmRemoteBridge.send`（`@设备`）把消息**留在当前会话**，
我方 `nmSendToDevice`（点脸 aim-only）把消息**跳进设备专属会话**。同一件事两种落点，
削弱了 `DeviceChat`「一个设备的全部对话只在一处」的意义。

**② Mac 端没有设备专属会话。**
`harness/dsh-nanomuse` 是 DSH 插件，聊天用宿主 DSH 的，`device-task.ts` 在**当前会话**里跑完一次设备任务。
所以 Mac 端设备条的 dot 只表达「有设备在等本机回答」（`hub.asks`），不是「设备会话有未读」。
`hub.asks` 在补设备条**之前从未被任何 UI 使用**——它一直是被声明但没人读的数据。

### 2.1 三处关键发现

**① 直发在上游是「例外」不是「方向」。**
`docs/parity.md:274`：*"on iOS the mention goes to the hub directly (no `delegate` tool there)"*。
iOS 直发是因为**它没有 `delegate` 工具**。Android / Web / Mac 都有，所以走中转。

⇒ 我们若把直发推广到三端，是**超出上游设计**的改动。好处是三端行为一致、省一次 LLM 往返；
代价是提 PR 时上游可能不认（它会说「你有 `delegate`，为什么不用」）。
**这决定了 PR 策略：P1 先做成我们自用，同时准备一份「为什么直发更好」的说服材料；被拒也不影响自用。**

**② 设备会话（`thread.device`）只有 runtime + web 有，Android/iOS/Mac 全缺。**
这是真正的功能空白，且**上游已有完整的服务端语义**（`ask_device` / `run_remote` / `stop_remote` / `/api/hub/ask`），
三端只是没接。**这条最值得做，也最容易提 PR 被收编**（纯补齐，不改变设计）。

**③ Mac 端（dsh）完全空白。** 它有 `delegate` 工具，但**没有** `@设备` 的 UI，也没有设备会话。

### 2.2 上游已做掉的（不要重做）

| 能力 | 位置 |
|---|---|
| 会话级设备寻址的服务端 | `thread.device` / `ask_device()` / `run_remote()` / `stop_remote()` — `nanomuse/hub/service.py:1082+` |
| 「发往设备的会话」REST | `POST /api/hub/ask {device, text}` — `nanomuse/server/api.py:1593` |
| `@设备` 解析（runtime 权威实现） | `nanomuse/sync/mention.py` `parse_mention()`，接线于 `nanomuse/server/service.py:1213` |
| 远端执行事件回传 | `_run_remote` 的 `on_event`：`tool` / `tool_result` / `approval` / `approval_result` / `text` |
| 技能 CRUD + 导入 | `GET/PUT/DELETE /api/skills`、`/api/skills/{n}/enabled`、`/api/skills/import {url}` — `api.py:1706+` |
| 连接器跨端可见 | profile 的 `connectors`（契约 C3），四端都读 |
| Android `Ask` 入口 | Devices 页 *Ask* → 预填 `@name `（`AppNavigation.kt:707`） |
| Mac 派单工具 | `delegate` + `device_*` — `harness/dsh-nanomuse/src/reach.ts` |
| Web `@` 建议 + 设备 chips | `web/src/mention.ts`、`ChatScreen.tsx:1211` |

### 2.3 上游明确不做 / 不能做

1. **跨端「读远端会话列表」没有协议位置**。C7/C8 把「同一份对话」交给同步层（`/v1/sync/*`），不是 hub。
   ⇒ **不要**发明远端会话枚举 action（上一稿的 `sessions.list` 已删除，这是对的）。
2. **跨端记忆同步**已在 roadmap 的 *Now* 段。⇒ 不做「看远端记忆」视图（已确认）。
3. **技能共享**在 roadmap 的 *Next*（*Shareable skills*）。⇒ 可做，且做对了能反哺。

### 2.4 上游合并规则（CONTRIBUTING + AGENTS.md）

1. 不改 Kotlin 包名 `com.openminis.app`、不改 Gradle `namespace`
2. 不改沙箱路径与 CLI 名（`/var/minis`、`minis-global`、`minis-open`、`minis-mcp-cli`、`android-*`）
3. **新代码进新文件**；改上游文件必须加 `// nanoMuse:`（及 TS/Swift 的等价写法），**一处改动一个标记**
4. 改名 / 品牌用脚本（`scripts/rebrand.py`、`gen-{android,ios}-icons.py`），幂等，**改脚本不手改**
5. DCO 签名（`git commit -s`）、Conventional Commits、**rebase 或 merge commit，绝不 squash**
6. 用户可见字符串：**英文 → 简体中文 → 该文件已有的每个 locale**
   - Android：`res/values-*/nm_strings.xml`（**16 个** locale，`nm_` 前缀）
   - iOS：`Localizable.xcstrings`
   - Mac / Web：`locales.ts` 的 `en` 与 `zh`（同一文件两个块）
7. 文档随代码改 `docs/` + `docs/zh/`，并在 `CHANGELOG.md` 的 *Unreleased* 下加一行
8. **新文本无 em/en dash**（`—`/`–`）；中文用中文写，避开 颠覆 / 王炸 / 保姆级 / 一键 / 赋能
9. `web/` 改完要 `npm run build` 并把 `nanomuse/server/static/` **一起提交**（它是入库的）
10. Mac 端改完跑 `pnpm build && pnpm typecheck && pnpm test`；catalogue 类文件用脚本生成，不手改

---

## 三、方案：三端一致的设备寻址

```
P1  @设备 直发    三端跳过模型中转，直接 hub task          [Android 1 天 / Web 0.5 天 / Mac 1 天]
P2  设备会话      三端补上 thread.device 形态（上游已有服务端）  [Android 1-2 天 / Web 已完成 / Mac 1-2 天]
P3  技能共享      只读列表 + URL 导入（对齐上游 roadmap）   [1 天]
```

### 3.1 P1：`@设备` 直发（三端）

**共同设计**：命中在线设备时，把消息直接作为 hub `task` 发出，不再交给本地模型判断。

| 端 | 现状 | 改法 | 上游文件改动 |
|---|---|---|---|
| **Android** | `DeviceMention.apply` 注入 `SessionAddenda` | 新文件 `DeviceTargetMention.kt`（复刻 `parse` 规则）→ 命中即 `Hub.call(task)` | `ChatViewModel.kt:6283` 一行钩子 |
| **Web** | runtime `parse_mention` → agent `delegate` | 在 `Composer` 的 `target` 分支直接调 `api.askDevice` + 发首条消息 | `ChatScreen.tsx` 的 `Composer` 内，`// nanoMuse:` |
| **Mac** | 无 | 新文件 `client/device-mention.ts`（复用 `mention` 逻辑）→ 新文件 `device-task.ts` 调 hub | `AvatarChat.tsx` 或 composer 挂载点 1 处 |

**Web 端最省事**：`POST /api/hub/ask {device, text}` 一步到位（建会话 + 首发消息）。
**Mac 端最麻烦**：dsh 的 composer 是 `contenteditable`（`composer.ts`），需要拦 send。

**复用（零开发）**：
- 审批卡：`event{stage:"approval"}` → 各端现有审批 UI（Android 走 `RiskGate`，Mac 走 harness 卡，Web 走 relayed card）
- 取消：`stop {call}`
- 语言：`task.language` 传当前 UI 的 BCP-47
- Android 事件处理模板：`ReachOffloadHandler.kt:105-140` 已写好全部 stage

**必须遵守（上游 #718 的教训）**：委派目标会话被归档会导致投递静默失败、模型零调用。
上游已修（`698c5c89`），并在 `ReachOffloadHandler` 补了「**空答案不许报 ok**」。
⇒ 我们自绘结果时同样：`result.text` 为空 = 失败，要显示原因，**不能显示「完成」**。

### 3.2 P2：设备会话（三端）

**上游服务端已完整**：`thread.device` 的语义 = 「这条会话的每条消息都发往该设备」。
Web 端已经做完（`Ask` → `ChatScreen.tsx:1211` 的 chips）。Android / Mac 补齐。

| 端 | 落点 | 要点 |
|---|---|---|
| Android | 新包 `io.github.nanomuse.terminal`：`TerminalBar.kt`（设备条）、`RemoteChat.kt`、`RemoteThreadStore.kt` | 会话列表页插入 chips（1 处标记） |
| Mac | 新文件 `client/DeviceChats.ts` + `DevicesPanel` 加 *Ask* 按钮 | 会话列显示设备图标（对齐 web） |

**关键约束**：
1. **不做远端会话枚举**——只显示「本机发起的、发往设备的会话」，标题即设备名（与 web 的 `→ Mac` 一致）
2. **`task` 就是 `session.send`**，不需要新 action
3. **busy**：`_task` 里 `thread.busy` 返回 `busy`（`service.py:910`），UI 要禁用发送
4. **审批卡归属**：`approve` 只受理自己发起的 run（`service.py:720`），设备会话在本机注册，所以卡显示在本机是对的
5. **Android 组件可见性**：`SessionItemContent` / `SessionRow` 是 `private`（不可 import）；`UserMessageBubble` 是 `internal`（可用）
   ⇒ 会话行**自绘**（视觉差异本来就该有），气泡直接 import

### 3.3 P3：技能共享（三端只读 + 导入）

上游 `POST /api/skills/import {url}` 已存在，roadmap 的 *Shareable skills* 就是这个方向。

| 端 | 落点 |
|---|---|
| Web | `SkillsScreen.tsx` 已有列表，加「从 URL 导入」入口 |
| Mac | `client/` 加技能列表 + 导入 |
| Android | 新文件 `SkillImportSheet.kt` |

**记忆视图：不做**（已确认）。理由：上游 roadmap 的 *Now* 段正在做跨设备记忆；
且 runtime 记忆是 **SQLite**（`<data_dir>/memory.db`），**不是 Markdown**——上一稿写错。

---

## 四、文件清单

### Runtime（Python）：零改动

上一稿的 `nanomuse/hub/actions_sessions.py`（6 个自造 action）**已取消**。
上游已有 `thread.device` + `/api/hub/ask` + `/api/skills`，自造 action 会与 C7/C8 的会话模型打架。

### Web（`web/`）

| 文件 | 阶段 | 说明 |
|---|---|---|
| `src/screens/ChatScreen.tsx` | P1 | `Composer` 的 mention 命中时改直发（1 处标记） |
| `src/screens/SkillsScreen.tsx` | P3 | 导入入口 |

> `web/src/mention.ts` 已存在且已接线，**不需要改**。
> 改完 `npm run build`，把 `nanomuse/server/static/` 一起提交。

### Mac（`harness/dsh-nanomuse/`）

| 文件 | 阶段 | 说明 |
|---|---|---|
| `src/client/device-mention.ts` | P1 | 新文件：`@设备` 匹配（对齐 `nanomuse/sync/mention.py` 的规则） |
| `src/client/device-task.ts` | P1 | 新文件：hub `task` 调用 + 事件流 → UI 状态 |
| `src/client/DeviceChats.ts` | P2 | 新文件：设备会话 |
| `src/client/DeviceSkills.ts` | P3 | 新文件：技能列表 + 导入 |
| `src/client/locales.ts` | 全部 | 字符串（`en` + `zh` 两块） |
| `src/client/AvatarChat.tsx` | P1 | 发送钩子（1 处标记） |

### Android（`android/src/android`）

| 文件 | 阶段 | 说明 |
|---|---|---|
| `io/github/nanomuse/terminal/DeviceTargetMention.kt` | P1 | 新包新文件 |
| `io/github/nanomuse/terminal/RemoteTaskController.kt` | P1 | hub task 封装 |
| `io/github/nanomuse/terminal/RemoteTaskBubbles.kt` | P1 | 事件 → 气泡 |
| `io/github/nanomuse/terminal/TerminalBar.kt` | P2 | 设备条 |
| `io/github/nanomuse/terminal/RemoteChat.kt` | P2 | 设备会话屏 |
| `io/github/nanomuse/terminal/RemoteThreadStore.kt` | P2 | 设备会话索引 |
| `io/github/nanomuse/terminal/SkillImportSheet.kt` | P3 | 技能导入 |
| `res/values-*/nm_strings.xml` | 全部 | **16 个** locale |

**上游文件改动：至多 3 处**（`ChatViewModel.kt` 发送钩子、会话列表插 chips、可选 `SessionItemContent` 改 `internal`）

### 不动

- `cloud/`（relay）、`nanomuse/`（runtime）、`android/` 的子树合并史：**零改动**

---

## 五、里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 环境 | Android：JDK 21 / SDK CMake 3.22.1 / NDK r27c / Go 1.25+ / gomobile / proot 子模块<br>Web：`cd web && npm ci && npm run check && npm run build`<br>Mac：`cd harness/dsh-nanomuse && pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test` | Android 出 arm64 debug APK（**真机必需**，模拟器是 x86_64）；Web 与 Mac 构建通过 |
| M0.5 捷径 | `nanomuse serve --host 0.0.0.0`，手机浏览器开 `http://<Mac IP>:8787` | 确认价值，决定投入 |
| M1 P1 | 三端 `@Mac 编译项目` 均直发 | 抓日志确认各端**本地 LLM 零调用**；审批卡正常；`stop` 有效 |
| M2 P2 | 三端设备会话 | 切回本机无损；卡显示设备名；busy 时禁用发送 |
| M3 P3 | 三端技能列表 + URL 导入 | 导入的技能出现在本机技能列表 |
| M4 收尾 | DCO 提交、CHANGELOG、locale 齐全、文档双语 | Android 单测通过；Web `npm run check` 通过；Mac `pnpm test` 通过 |

---

## 六、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **自己合并 subtree 会破坏 rebase** | **高（已规避）** | 不合并。`android/` 停在 1.13，等上游合并后跟随 |
| **P1 与上游设计意图相反**（上游是「有 `delegate` 就用 `delegate`」） | **高** | P1 自用为主；提 PR 前先开 issue 沟通设计意图，别直接提 PR 被打回。P2 纯补齐、风险低，优先提 P2 |
| 上游每天 356 次提交 | 中 | 我们只碰 `android/`、`web/`、`harness/dsh-nanomuse/`，且**新文件为主**。每日 `nm-fork.sh sync` |
| 月度 subtree 合并的 620 处标记 | 中 | 不新增上游文件改动（至多 3 处 + Web/Mac 各 1 处） |
| Android 组件 `private` 不可复用 | 低 | 自绘会话行；气泡用 `internal` 的 `UserMessageBubble` |
| **Web 构建产物必须入库** | 中 | 每次改 `web/` 都 `npm run build` 并提交 `nanomuse/server/static/`，否则 CI 会红 |
| #718 类问题：目标会话归档 → 静默失败 | 中 | 遵守「空答案 = 失败」，不显示「完成」 |
| 三端行为不一致（改一端忘另一端） | 中 | 每条改动在三端同时落地；`docs/parity.md` 就是上游的三端对照表，做完要更新它 |
| 记忆视图做错方向 | 已规避 | 不做 |

---

## 七、工作量

| 部分 | 量级 |
|---|---|
| 环境搭建（Android + Web + Mac） | 1-1.5 天（一次性） |
| 捷径验证 | 0.5 小时 |
| P1 三端 | Android 1 天 + Web 0.5 天 + Mac 1 天 |
| P2 三端 | Android 1-2 天 + Mac 1-2 天（Web 已完成） |
| P3 三端 | 1 天 |
| **合计** | **~6-8 天** |

---

## 八、PR 策略

| 内容 | 提 PR 把握 | 策略 |
|---|---|---|
| P2 设备会话补到 Android / Mac | **高** | 纯补齐上游已有设计（web 已做），先开 issue 说明，再提 PR |
| P3 技能共享 | **中高** | 对齐 roadmap 的 *Next*，但上游可能已有安排，先开 issue |
| P1 `@` 直发推广到三端 | **低** | 上游 parity 明确说 iOS 直发是因为「没有 `delegate`」，其余端故意走中转。**先开 issue 讨论设计意图**，别直接提 PR |
| 子树合并 | 不适用 | 上游自己的活 |

> 被收编是**最优结局**：免除后续维护。所以每项都按「能提 PR」的标准写
> （新文件、有单测、locale 齐全、文档双语、CHANGELOG）。
