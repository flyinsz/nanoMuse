# nanoMuse 二开开发计划

> 目标：以 Android 手机为主控端，把「向 Mac / Linux 下达指令」从隐蔽的 @mention 升级为
> 一等公民体验；技能 / 记忆 / 连接器跨端可见可拉取。
> 硬约束：**复用上游已有组件，改动落在新文件里，保持 `git subtree pull` 与 `git rebase upstream/main` 可走。**

- 上游：<https://github.com/nano-muse/nanoMuse>（v1.0.9 Tiller，GPL-3.0-or-later，`main` = `91f49429`，2026-11-03 00:32）
- 我们的 fork：<https://github.com/flyinsz/nanoMuse>（已建，`main` 与上游同点）
- 基线核对日期：2026-11-03（**上游近 30 天 1731 次提交、近 7 天 361 次**）
- 主要场景：Android 手机 → Mac / Linux（runtime `nanomuse serve` 或 nanoMuse Desktop）

---

## 零、本次修订（相对上一稿）

上一稿（同日早些时候）有若干与上游实际的偏差，会导致返工与合并冲突。逐条修正：

| 上一稿的说法 | 上游实情 | 修订 |
|---|---|---|
| 「roadmap / issues 中无会话级设备直选计划，需自研」 | **runtime 已有 `thread.device`、`/api/hub/ask`、`ask_device()`、`run_remote`/`stop_remote`**；web 端 Devices 页与 chat 侧栏已有 *Ask* → 打开一个「发往该设备的会话」 | P2 从「自研终端模式」降级为「把上游已有的设备会话补到 Android」。**runtime 侧零代码** |
| 新 action `sessions.list` / `session.messages` / `session.send`（6 个 action，≈250 行） | 上游 hub 只暴露设备级 action（`info`/`shell`/`files`/…）与 `task`；会话读取走 runtime 自己的 REST（`/api/threads`、`/api/threads/{id}/events`）。**跨端读远端会话列表在协议上没有位置，也不在设计里**（C7/C8 已把「同一份对话」交给同步层，不是 hub） | 删掉这一层自造协议。远端会话读写改走**浏览器捷径**（REST 就在那里），或只做「发往设备的会话」 |
| `skills.list` / `skills.get` / `skills.put` 三个 hub action | runtime 已有 `GET/PUT/DELETE /api/skills`、`/api/skills/{n}/enabled`、`/api/skills/import`；roadmap 明确在推进 **Shareable skills** | 删掉 hub action 方案。技能获取用现有 REST / import URL；不上自造 action |
| 「连接器跨端同步零开发」 | 正确，但文中的契约编号 **C3 写错了**（C3 是桌面端的 connectors-on-profile，手机端同一件事没有编号）；连接器上限 64 是**账号级 profile** 的，不是「账号 64 + 设备 32」两套 | 编号与措辞更正 |
| 「C9 契约：主会话优先，侧聊默认留在创建设备」 | **C9 是「侧聊与在场」**（`Also sync side chats` 每设备开关，默认关），**C7 才是对话同步**，C8 是「一条主线对话」 | 编号更正：C7 = 对话同步，C8 = 一条主线，C9 = 侧聊开关，C10 = 会话归属账号，C12 = 登出留下什么 |
| `SessionListScreen` 行组件「import 复用」 | 行组件 `SessionItemContent` / `SessionRow` 是 **`private`**，无法 import；`UserMessageBubble` 是 `internal` | 复用改为「同包内可见的 `internal` 组件 + 自绘」，或把行组件改成 `internal`（带 `// nanoMuse:` 标记，1 处） |
| 「隐藏风险：上游每日发版」 | 更准确：**runtime / desktop / relay 每日多次**（7 天 361 次），**`android/` 子树约每月一次**（1.13 2026-09-02、1.14 09-29、1.15 10-25，当前基线是 **1.13**，已落后两个版本） | 风险分级：上游每日发版只影响 Python/TS 侧（我们**零改动**）；Android 侧真正的痛点是**月度 subtree 合并**，而子树里已经有 **112 个上游 Kotlin 文件带 620 处 `// nanoMuse:` 标记**，这是既存债务，不是我们新增的 |
| 「捷径：浏览器访问 `http://<Mac IP>:8787`」 | 端口对，但 `nanomuse serve` **默认只绑 127.0.0.1 且带访问 token**（`--host 0.0.0.0` 才可从手机访问，`--no-auth` 仅限本地开发） | 捷径命令补全 |
| 「M0：真机必需，模拟器跑不了 arm64」 | 正确 | 保留 |

**结论：P2 的 runtime 侧工作量从「~250 行 / 0.5-1 天」变为 0；真正的工作全部落在 Android 一个端上。**

---

## 一、上游现状（已逐条核实）

### 1.1 上游已经做掉的（不要重做）

| 能力 | 上游实现 | 位置 |
|---|---|---|
| 手机 → 电脑的会话级寻址 | `thread.device` / `ask_device()` / `run_remote()` / `stop_remote()` | `nanomuse/hub/service.py:1082-1240`，`nanomuse/server/service.py:336,1057,1187` |
| 「发往某设备的会话」REST | `POST /api/hub/ask {device, text}` → 建会话（或复用）+ 首发消息 | `nanomuse/server/api.py:1593` |
| web 端 *Ask* 入口 | Devices 页 + chat 侧栏「设备 chips → Ask」 | `web/src/screens/DevicesScreen.tsx:50`、`web/src/screens/ChatScreen.tsx:1106` |
| 远端执行的事件回传（tool / approval / text / result） | `_run_remote` 的 `on_event`：`tool`→chips、`approval`→审批卡（带设备名）、`approval_result`→关卡 | `nanomuse/hub/service.py:1100-1240` |
| 远端会话的停止 | `stop_thread` 识别 `thread.device` → `hub.stop_remote` | `nanomuse/server/service.py:1055-1060` |
| 技能 CRUD + 导入 | `GET /api/skills`、`GET/PUT/DELETE /api/skills/{name}`、`POST /api/skills/{name}/enabled`、`POST /api/skills/import {url}` | `nanomuse/server/api.py:1706-1745` |
| 连接器跨端可见 | profile 的 `connectors` 列表（契约 C3），四端都读，显示 *Connected on &lt;device&gt;* | `nanomuse/hub/profile.py`、`docs/desktop-muse.md:670` |
| Android 的「Ask 设备」入口 | Devices 页 *Ask* → 只是把 `@<name> ` 预填进输入框 | `AppNavigation.kt:707`、`ui/cloud/DevicesSection.kt` |
| Android `@设备` 已能派单 | `DeviceMention.apply` → `SessionAddenda` 一轮提示 → 本地 Muse 跑一轮 → 调 `nanomuse-pc task` | `io.github.nanomuse.sync.DeviceMention.kt` |

### 1.2 上游明确不做、或做不到的（这才是我们的空间）

1. **Android 没有「会话级」的设备切换**。`Ask` 只预填 `@name `；一次「问」之后会话仍在本地，多轮追问会重复走「本地 Muse → nanomuse-pc」的中转。web 端有真正的 `thread.device` 会话，Android 没有。
2. **iOS 的 `@device` 直发（`NanoMuseDeviceMention.swift`）**：直发 hub task，不经本地 Muse。Android 仍是中转路径。**这是最大的不对称。**
3. **远端资源视图**（技能 / 记忆）在手机上不存在。上游 roadmap 的 *Shareable skills* 说的是「能分享的文件夹」，**不是**「手机上浏览远端技能列表」，所以那部分仍是空白。
4. **跨端记忆同步**在 roadmap 上明确是「还缺的」：*"the same memory on every device rather than per device"*（`docs/roadmap.md:15,19`）。但注意：**上游在做的方向是「同步同一份记忆」**（relay 侧），不是「手机上查看远端记忆」。**不要做后者**——会被上游的同步方案直接作废。

### 1.3 上游合并规则（CONTRIBUTING / AGENTS.md，必须遵守）

1. 不改 Kotlin 包名 `com.openminis.app`、不改 Gradle `namespace`。只有 `applicationId`（`io.github.nanomuse.app`）是我们的
2. 不改沙箱路径与 CLI 名（`/var/minis`、`minis-global`、`minis-open`、`minis-mcp-cli`、`android-*`）
3. **新代码进新文件**（`io.github.nanomuse.*` 或上游文件旁的新文件）；必须改上游文件时加 `// nanoMuse:` 注释，**一处改动一个标记**
4. 改名 / 品牌用脚本（`scripts/rebrand.py` + `gen-{android,ios}-icons.py`），幂等，**改脚本不手改**
5. 提交带 DCO 签名（`git commit -s`），Conventional Commits，**rebase 或 merge commit，绝不 squash**
6. 用户可见字符串：**英文 → 简体中文 → 该文件已有的每个 locale**（Android  `res/values-*/nm_strings.xml`，已有 16 个 locale）
7. 文档随代码：改了行为就同步改 `docs/`，并在 `CHANGELOG.md` 的 *Unreleased* 下加一行
8. 新文本无 em/en dash（`—`/`–`）；中文文案用中文写，不用 颠覆 / 王炸 / 保姆级 / 一键 / 赋能
9. `android/` 是 OpenMinis 的 subtree：**对方 squash 后月度发布，不收 PR**

---

## 二、修订后的方案

```
P1  @ 直发         —— Android 补齐 @设备 直发（对齐 iOS），不经本地 Muse        [1 天]
P2  设备会话        —— Android 补上 web 已有的「发往设备的会话」              [1-2 天]
P3  远端资源视图    —— 技能列表 / 记忆：只读展示 + 就地导入                  [1 天]
捷径 浏览器直访     —— 第 0 步，零开发的对照物                                [0 天]
```

执行顺序：捷径 → P1 → P2 → P3。每条独立可用、独立可停。

### 2.0 捷径（第 0 步，先验证再开发）

runtime 的 web UI 就是远端最完整的界面，`nanomuse serve` 自带：

```bash
# 在 Mac 上（runtime 默认只绑 127.0.0.1 且带访问 token）
nanomuse serve --host 0.0.0.0        # 手机同 Wi-Fi 才能访问；token 与二维码照常
```

手机浏览器开 `http://<Mac 的 IP>:8787`，拿到远端的会话列表 / 配置 / 记忆 / MCP / 技能。
`--no-auth` 只用于本地开发，**不要在局域网用**。

- 用途：花 10 分钟确认「手机上操作远端」是否真有价值
- 缺点：需同网段、无推送、无审批卡集成、无对话同步（是浏览器的，不是 App 的）
- **判定**：若浏览器已满足 80% 需求 → 只做 P1，P2/P3 降级搁置

### 2.1 P1：@ 直发（对齐 iOS）

**现状**（`io.github.nanomuse.sync.DeviceMention.apply`，调用点 `ChatViewModel.kt:6283`）：
`@Mac 任务` → 设备名摘出 → `SessionAddenda` 注入一轮提示 → **本地 Muse 跑一轮** →
它调 `nanomuse-pc task --on "Mac"` → hub task。多一次 LLM 往返，且本地模型的判断会引入偏差。

**目标**：命中在线设备时**跳过本地 Muse**，直接 `Hub.call(task)`，把 event / result 画成气泡。
交互模型照抄 iOS（`NanoMuseDeviceMention.swift` / `NanoMuseDeviceReply.swift`）。

**落点**（全部新文件，包 `io.github.nanomuse.terminal`）：

| 文件 | 内容 |
|---|---|
| `DeviceTargetMention.kt` | 复刻 `DeviceMention.parse` 的匹配逻辑（同一套 separators 与最长名优先），但返回「直发」而非「注入 addenda」 |
| `RemoteTaskController.kt` | `Hub.call(deviceId, "task", {text, conversation, language}, onEvent)` → 状态流；`stop {call}` |
| `RemoteTaskBubbles.kt` | 把手 `tool` / `tool_result` / `text` / `approval` 事件画成聊天气泡与步骤条 |

**上游文件改动：1 处。** `ChatViewModel.kt:6283` 现在是一行：
```kotlin
val nmText = io.github.nanomuse.sync.DeviceMention.apply(context, realSessionId.ifEmpty { sessionId }, text)
```
改为先问直发、未命中再退回现有路径（`// nanoMuse:` 标记，1 处）。

**零开发的复用**：
- 审批卡：`event{stage:"approval"}` → 现有 `RiskGate` 卡片自动弹（`RemoteApprovalKey.target(ev)` 已经在用），答完 `Computers.approve(c, id, allow)` 回传
- 取消：`Hub.call` 的 `stop {call}`
- 语言：`task.language` 传当前 UI 的 BCP-47，远端用它作答（`HubTasks.prompt` 已实现）
- 事件流逐个 stage 的处理模板：`ReachOffloadHandler.kt:105-140` 已经写好了（`tool`/`tool_result`/`approval`/`approval_result`/`text`），直接抄

**已知坑（上游 #718，已修，但要知道）**：委派目标会话被归档后，后续投递会被归档闸门拒绝、模型零调用，而手机端只显示「完成」。
上游在 `698c5c89`（`fix(hub): a task from another device works after its chat was archived`）修了，并在 `ReachOffloadHandler` 里补了「空答案不许报 ok」。
**P1 自绘气泡时同样要遵守这条**：`result.text` 为空就不是成功，要显示失败原因。

### 2.2 P2：Android 的设备会话（补 web 已有、Android 缺的）

web 端已经能用：Devices 页 *Ask* → `POST /api/hub/ask` → 得到一个 `thread.device = <id>` 的会话，
在侧栏会话列表里与普通会话并列，发消息直接 `run_remote`，approval 卡片带设备名回来。

**Android 要做的不是发明终端模式，而是把这个已有形态搬到手机上**：

```
会话列表页顶部设备条（在线状态实时）：
[ ● 本机 ]  [ 💻 Mac ]  [ 🐧 Linux ]
      │ 点 Mac → 打开 / 新建「发往 Mac 的会话」
      ▼
该会话的输入直达 Mac：气泡里是 Mac 的回复、步骤、审批卡；
顶栏显示设备名；切回本机会话一切如常。
```

**关键实现约束（已核实）**：
1. **没有跨端读远端会话列表的协议**。C7/C8 把「同一份对话」交给**同步层**（`/v1/sync/*`），不是 hub。所以：
   - 手机上**只能**显示「本机发起的、发往设备的会话」，其标题就是设备名（与 web 的 `→ Mac` 一致）
   - **不要**去列远端的会话列表——上游的立场是会话本来就跨端同步，另开一条读取通道与 C8 冲突
2. **`session.send` 不需要新 action**：`task` 就是它。`thread.device` 语义 = 「这条会话的每条消息都发往该设备」。
3. **busy 语义**：`_task` 里 `thread.busy` 时返回 `busy`（`service.py:910`）；设备会话在本机 busy 时 UI 要禁用发送。
4. **审批卡归属**：`approve` 只受理「自己发起的 run 的卡」（`service.py:720-728`）。设备会话在**本机**注册审批，所以卡片显示在本机聊天里是对的。

**落点**（新包 `io.github.nanomuse.terminal`）：

| 文件 | 内容 |
|---|---|
| `TerminalBar.kt` | 会话列表顶部的设备 chips（数据源 `Hub.others(context)`，与 `Computers.kt` 同源） |
| `RemoteChat.kt` | 设备会话的聊天屏：发送走 `RemoteTaskController`，气泡复用 |
| `RemoteThreadStore.kt` | 本机的设备会话索引（设备 id → 本地 session id + 最后浏览位置） |

**上游文件改动：2 处。**
- 会话列表页面塞入 chips 条（1 处，`// nanoMuse:`）
- 发送路径：设备会话命中时改走直发（与 P1 共用同一处钩子，**不新增第 2 处**）
> 如果 P1 已做完，P2 的「发送」几乎不需要新的上游改动——同一行钩子按「当前会话是否设备会话」分流即可。

**关于复用上游行组件**：`SessionItemContent` / `SessionRow` 都是 `private`（`SessionListScreen.kt:1826,2564`），
`UserMessageBubble` 是 `internal`（`ChatUserMessageUI.kt:281`）。所以：
- 气泡：可直接 import（`internal` 同 module 可见）
- 会话行：要么自绘一个轻量行（推荐，视觉差异本来就该有），要么把 `SessionItemContent` 改成 `internal`（+1 处标记）

### 2.3 P3：远端资源视图（只做不冲突的部分）

| 资源 | 做法 | 与上游冲突 |
|---|---|---|
| 技能 | 只读列表 + **按 URL 导入**（`POST /api/skills/import {url}`）。这正好是上游 roadmap 的 *Shareable skills* 方向，**做对了可以提 PR 反哺** | 低 |
| 记忆 | **不做**。上游 roadmap 明确在做「同一份记忆跨设备」（`docs/roadmap.md:15,19`）；我们现在做一个「看远端记忆」的视图会被直接作废。且 runtime 的记忆是 **SQLite**（`<data_dir>/memory.db`），**不是** Markdown 文件——上一稿「MEMORY.md 用 file.get 读」是错的 | **高，规避** |
| 连接器 | 上游现成（C3 profile 同步），Devices 页已显示 *Connected on X* | 0 |
| 模型 / API key | 不同步（凭据不离设备是上游安全契约）；执行端自带。UI 一行文案说明即可 | 0 |

**记忆这一项的正确姿势**：等上游的跨端同步落地（它在 roadmap 的 *Now* 段），或者只做「在手机上**看**本机记忆」——
本机记忆在 Android 上是 `io.github.nanomuse.sysfiles` 管的，与远端无关。

---

## 三、文件清单

### Runtime（Python）

**零改动。** 上一稿的 `nanomuse/hub/actions_sessions.py`（6 个自造 action）**取消**——
上游已有 `thread.device` + `/api/hub/ask` + `/api/skills`，自造 action 会和上游的会话模型（C7/C8）打架。

### Android（Kotlin，新包 `io.github.nanomuse.terminal`）

| 文件 | 阶段 | 内容 |
|---|---|---|
| `DeviceTargetMention.kt` | P1 | @ 直发判定（复用 `DeviceMention.parse` 的匹配规则） |
| `RemoteTaskController.kt` | P1 | `Hub.call(task)` 封装 + 事件流 → UI 状态 + stop |
| `RemoteTaskBubbles.kt` | P1 | 步骤 / 文本 / 审批事件的气泡渲染 |
| `TerminalBar.kt` | P2 | 会话列表顶部设备 chips |
| `RemoteChat.kt` | P2 | 设备会话聊天屏 |
| `RemoteThreadStore.kt` | P2 | 本机设备会话索引 |
| `SkillImportSheet.kt` | P3 | 远端技能只读列表 + URL 导入 |

**上游文件改动：至多 3 处**
1. `ChatViewModel.kt` 发送路径钩子（1 处；P1 + P2 共用）
2. 会话列表页插入 chips 条（1 处，P2）
3. （可选）`SessionItemContent` 改 `internal`（1 处，P2；自绘则不需要）

**locale**：任何新增的用户可见字符串，要写进 **16 个** `res/values-*/nm_strings.xml`（`nm_` 前缀）。

### 不动

- `cloud/`（relay）、`nanomuse/`（runtime）、`harness/`（desktop）、`web/`：**全部零改动**
- 我们只碰 `android/`——碰得越少，上游每日发版对我们的影响越小

---

## 四、里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 环境 | 见 `scripts/local/README.md`：JDK 21 / SDK CMake 3.22.1 / NDK r27c / Go 1.25+ / gomobile / proot 子模块 | `./gradlew :app:assembleDebug` 出 arm64 debug APK；**真机必需**（模拟器是 x86_64，跑不了 arm64） |
| M0.5 捷径 | `nanomuse serve --host 0.0.0.0`，手机浏览器开 `http://<Mac IP>:8787` | 确认价值，决定 P2/P3 是否投入 |
| M1 P1 | `@Mac 编译项目` → 本地 Muse **零参与**，结果进气泡 | 抓 Android logcat 确认无本地 LLM 调用；审批卡正常弹；`stop` 有效 |
| M2 P2 | 设备 chips 切到 Mac，新建会话落 Mac，追问流式回显 | 切回本机会话无损；设备会话的审批卡显示设备名 |
| M3 P3 | 技能列表可读、URL 可导入 | 导入后的技能出现在本机 `nm_` 技能列表 |
| M4 收尾 | DCO 签名提交、（可选）向上游提 PR | `./gradlew :app:testDebugUnitTest --tests 'io.github.nanomuse.*'` 通过；`ruff`/`mypy`/`pytest` 不受影响（我们没改 Python） |

---

## 五、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **上游每天 300+ 次提交**（7 天 361 次） | 中 | 我们**只碰 `android/`**，而 `android/` 是月度 squash 的子树。Python / TS 侧零改动 ⇒ 每日发版对我们几乎无感。`scripts/local/nm-fork.sh sync` 一条命令 rebase |
| **月度 OpenMinis subtree 合并** | **高** | 子树里已有 **112 个上游 Kotlin 文件、620 处 `// nanoMuse:` 标记**（既存债务，`ChatViewModel.kt` 一个文件就 114 处）。对策：① 我们的新代码**全部**在新文件；② 改动集中到**同一行钩子**；③ 每次合并后先跑 `nm-fork.sh marks`，按标记逐处解冲突 |
| 基线落后：`android/` 是 **OpenMinis 1.13**，上游已到 1.15（10-25） | 中 | 合并 1.14 / 1.15 是**独立任务**，优先于二开——否则我们的改动要解两次冲突。用 `nm-fork.sh release 1.15`，先做这个 |
| 上游自己补齐 Android 直发 / 设备会话（iOS 已直发，概率高） | **中偏高** | 这其实是**最优结局**：P1 做扎实后提 PR 反哺，被收编即免除维护。所以 P1 的设计要按「能提 PR」的标准写（新文件、有单测、locale 齐全、文档齐） |
| 自造协议与上游会话模型打架（C7/C8/C10） | **高（已规避）** | 上一稿的 `sessions.*` action 已删除。远端会话读取只走**上游已有的** `thread.device` / `/api/hub/ask` |
| #718 类问题：委派目标会话被归档后投递静默失败 | 中 | 上游已修（`698c5c89`）。我们自绘结果时**必须**遵守「`result.text` 为空 = 失败」，不能显示「完成」 |
| `session.send` 与远端本地使用冲突（busy） | 低 | 复用上游 `busy` 语义（`service.py:910`）；UI 在 busy 时禁用发送 |
| 手机后台 hub socket 断开 | 低 | 调用只发生在前台；`HubService` 前台服务已存在 |
| 记忆视图做错方向 | **中（已规避）** | 上游 roadmap *Now* 段就在做跨设备记忆。**不做**「看远端记忆」；且 runtime 记忆是 SQLite，不是 Markdown |

---

## 六、工作量

| 部分 | 量级 |
|---|---|
| 捷径验证 | 0.5 小时 |
| **合并 OpenMinis 1.14 + 1.15**（前置，独立任务） | 1-2 天（视冲突） |
| 环境搭建 + 真机联调 | 1 天（一次性） |
| P1 @ 直发 | 1 天 |
| P2 设备会话 | 1-2 天 |
| P3 技能视图 | 1 天（记忆部分不做） |
| **合计（不含子树合并）** | **~3-4 天**（比上一稿少，因为 runtime 侧归零） |

---

## 七、决策点（需要你确认）

1. **先合并 OpenMinis 1.14/1.15 再二开，还是先二开再合并？**
   建议先合并：合并会触及大量上游 Kotlin 文件，我们的改动越少越省事。但合并本身可能踩坑（620 处标记）。
2. **P3 的记忆视图：确认不做？**（建议不做，理由见 2.3）
3. **P1 是否按「可提 PR」的标准写？**（多约 20% 工作量：单测 + 16 个 locale + 英文文档 + CHANGELOG）
