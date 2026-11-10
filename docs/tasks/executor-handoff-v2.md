# 执行终端自动切换（第二版二开方案）

> 基线 `upstream/main @ f86708ac4`，分支 `feat/executor-handoff-v2`，
> 工作区 `/Users/donny/nanoMuse-handoff`（与老一辈二开 `feat/session-handoff-base`
> 物理隔离，见 §三）。**P0 中继已完成**（见 §六）。

## 一、目标

**主会话**与**旁聊（side chat）**都按同一套规则走：谁跑这一轮由**上下文的属主**
决定，不需要人写 `@`：

| 场景 | 期望行为 |
|---|---|
| 上下文是本机的 | 执行人是本机，本地跑 |
| 上下文是飞牛深圳同步过来的 | 最新属主判为飞牛深圳，这句自动交给它跑 |
| 任何情况 | 上下文接续，不新开对话、不复制历史 |
| 输入框 | 占位符由「消息」改为 `@<最新执行终端>`，如 `@飞牛深圳`；属主是本机则 `@本机` |
| 同步已开 | 那一轮的逐字输出、推理、工具过程都流式到达每台在线设备，渲染方式与本机执行一致 |
| 需要换人 | `@<设备名>` 或 `@本机` 显式切换，且黏住 |

**旁聊同等对待**（2026-11-10 增补）：旁聊与主会话共用同一套机制——
`@` 切换属主、完整流式输出、上下文接续，三项都要。差别只在会话键与同步开关：

| | 主会话 | 旁聊 |
|---|---|---|
| 会话键 | `main` | 各自的 `cid` |
| 归属 | 一个账号只有一条 main | 每条旁聊各有一个 owner |
| 同步开关 | 总开关 | 还要 `side_chats` 开关（C9，逐设备，默认关）|
| 属主持久化 | 同一列 `owner_device` | 同一列，同一套 |
| 流式 | 同一帧、同一扇出 | 同一帧、同一扇出 |

即：**旁聊没有第二套实现**，只是 `_eligible()` 里那条 `side_chats or thread.id == MAIN_THREAD`
的门槛要过。范围：**先 Android + Web**，确认后再做 Mac。

## 二、与老一辈二开（C13）的关系

> ⚠️ **重要提醒（用户 2026-11-10 明确指出）：不要完全依赖第一版二开的开发。**
> 第一版**有很多 bug**，且**代码不一定满足我们的原则要求**（低侵入、高 PR 通过率）。
> 它只是一份**设计参考与踩坑记录**，不是可直接照抄的实现。
> 采用它的东西时必须逐条复核：① 是否真有 bug；② 是否违反低侵入；③ 是否超出本版需求。
> **宁可按本方案重写，也不要为省事而沿用一段没验过的旧代码。**

老一辈二开已实现同一套底层机制（`docs/session-handoff.md`），但它把
**交互层做重了**，这正是「改动量太大」的来源。本版逐条取舍：

| 能力 | 老一辈二开 | 本版 | 理由 |
|---|---|---|---|
| 会话归属存 `owner_device` | 有 | **借鉴思路，接口重新冻结**（列名相同仅为重叠） | 地基方向对，**实现需复核** |
| 代跑既有线程（`thread` + `handoff`） | 有 | **借鉴思路，重新实现** | 上下文不搬家的前提 |
| 流式上行（`POST /v1/sync/stream`） | 有 | **借鉴思路，重新实现** | 需求四直接命中 |
| 流式帧 `stream` + `notify_stream` | 有 | **借鉴思路，重新实现** | 同上 |
| 单 `mid` 直通 | 有 | **按需**，确认无 bug 再用 | 防双气泡 |
| `handoff_from` 与 `remote_from` 解耦 | 有 | **复用该原则**，实现自写 | 否则停同步 |
| **设备条**（`DeviceStrip`/`DeviceFaces`/`device-row`） | 做了 | **不做** | 需求未要求；是本版最大的改动面 |
| **设备专属会话镜像**（`deviceChats`） | 做了 | **不做** | 需求要的是主会话接续，不是专属会话 |
| **独立「由 X 执行」行** | 做了 | **不做**，改占位符 | 需求明确要占位符 |
| **显式 `@` 路由 + 黏住** | 做了 | **做**（含 `@本机`） | 需求：`@` 切换执行人 |
| `@本机` 特例 | 做了 | **完整保留** | 需求明确要求可 `@本机` |

一句话：**只借它的设计结论，不借它的代码**。客户端那一层（Android 的设备条、
Web 的 `DeviceFaces`、Mac 的 `DeviceRowSlot`）整块不采纳；运行时与中继那部分
按本方案 §四/§五 的接口**重写**，并在写之前复核第一版是否有已知 bug。

## 三、环境隔离

```
/Users/donny/nanoMuse          feat/session-handoff-base   老一辈二开（不动）
/Users/donny/nanoMuse-handoff  feat/executor-handoff-v2    本版（新建）
```

- 已执行 `git worktree add -b feat/executor-handoff-v2 … upstream/main`。
- 两个工作区各自独立的 `HEAD` 与工作目录，**互不干扰**；老一辈二开里正在改的
  `ChatViewModel.kt` / `Hub.kt` 不受影响。
- 本版**不 merge、不 rebase 老一辈二开的分支**，只选择性参考它的实现（读代码，
  不迁提交）。这样将来各自对上游提 PR 时互不牵连。

## 四、机制

### 4.1 属主从哪来

每台设备本地都有一条主会话（`nanomuse/server/events.py` 的 `MAIN_THREAD = "main"`），
中继把同一账号的 main 归到**一个 cid**。同步只带纯文本，**完整上下文
（工具轨迹、推理、图片）只在跑过它的那台设备本地**
（`{data_dir}/threads/{id}.session.json`）。所以上下文接续的唯一办法是
**让有上下文的那台接着跑**。

属主 = **最近一次在这条会话上跑完一轮的设备**。它必须持久化，不能靠内存的
presence（`WORKING_TTL_S` 十分钟、重启即丢）：

- 中继 `sync_conversations` 增列 `owner_device`；
- 谁跑完一轮，就把 `owner_device` 报成自己（随会话行 push）；
- 别的设备 pull 到 `owner_device != 本机` 时，就把它当执行人。

### 4.2 一句话的路由

```
读消息 → 解析开头 @
  ├─ 有 @<某台设备>        → 给那台，并把 owner_device 改成它
  ├─ 有 @本机 / @<本机设备名> → 本机跑，并把 owner_device 改回本机
  └─ 无 @（默认）          → 给当前 owner_device = 最近属主
       ├─ 属主是本机 → 本地跑，行为与今天一致
       └─ 属主是别的设备（如飞牛深圳）→ 交给它跑（在它自己的 main 上）
```

三条硬规则：

1. **默认执行人是「最近属主」，不是本机。** 上游今天默认永远本机
   （`parse_mention` 的 `self_id` 排除自己），本版改为属主 —— 这是相对上游
   **唯一的行为变更点**，也是需求一的落点。
2. **`@` 优先且黏住。** 写了 `@<设备>` 就去那台，之后不写 `@` 也继续发给它
   （属主已改）。与上游 C13 的粘性规则一致。
3. **`@本机` 必须可用。** 本机名与「本机」都命中，把属主切回本机。需要开两个
   特例：`nanomuse/sync/mention.py` 的 `self_id` 排除要放行本机；
   中继 `cloud/nanomuse_cloud/hub.py` 的 `self_call` 硬拒要放行「本机跑本机」。

**切属主 = 换记忆。** `@本机` 之后本机用自己那份上下文，**没有原属主的工具轨迹**；
切换时在会话里落一条说明（谁从谁手里接手），让模型知道上下文有断层。

### 4.3 代跑一轮

发起端把这一句交给 owner，owner **在自己那条既有 main 线程**上跑
（不是新建 `From <name>`），要点全部沿用 C13 的结论：

- 同一份上下文，不复制；
- 一句话一个 `mid`，owner 复用发起端的 `mid`；
- 「谁问的」走侧信道（`Thread.purposes`），**不准拼进用户消息正文**；
- 代跑标记用**新字段** `handoff_from`，`_eligible()` 不因它排除（否则停同步）；
- 跨端互斥：同会话已有 run 在进行时明确 `fail("busy")`；
- owner 离线不发，直接提示「<设备> 离线」；
- 阶段一不带附件（发不出去并说明）。

### 4.4 流式

owner 跑的每一轮，把逐字、推理、工具过程推给中继，中继扇出给同账号其它在线
设备。关键约束（沿用 C13）：

- 帧量必须合批，**200-250ms 一批**（一条帧一个字会撞 `FRAMES_PER_S=60`）；
- 只推**本机正在跑**且 `_eligible(thread)` 的会话；
- 帧带 `round` 做分桶（Web 现在按会话键存流，两股会互相覆盖）；
- 旧客户端不认识新帧时静默忽略，三端可逐个升级；
- 断线不重放，最终文本由 sync 兜底。

## 五、接口冻结

以本文为准，不要自行改名。

### A. 归属：存储

```sql
-- cloud/nanomuse_cloud/db.py 的 SCHEMA，sync_conversations 增列
owner_device TEXT NOT NULL DEFAULT ''
```

迁移走已有的 `_migrate()` + `add(table, col, ddl)` 助手（`api_keys` 是范例）。
写入点：`sync.push()` 的会话 INSERT / UPDATE。值取客户端上报的 `device`。

### B. 会话行输出

`_conversation_row()` 增两个字段（旧字段全保留）：

```json
{"owner_device": "<device id>", "owner_device_name": "<显示名>"}
```

### C. 流式广播：帧

中继 → 设备（服务端构造，仿 `working` 帧的扇出）：

```json
{"type":"stream","cid":"…","from":"<device id>","round":"<本轮流 id>",
 "seq":1,"delta":"…","reasoning":"…","tool":{"name":"…","stage":"call|result"},
 "done":false}
```

- `delta`/`reasoning`/`tool` 至少一个非空；`done:true` 收尾。
- `FEATURES`（`cloud/nanomuse_cloud/hub.py`）追加 `"stream_sync"`。

### D. 流式广播：上行端点

```
POST /v1/sync/stream
body: {"cid":"…","device":"…","round":"…","seq":1,
       "delta":"…","reasoning":"…","tool":{…},"done":false}
→ {"ok": true}
```

服务端校验账号与会话存在（仿 `POST /v1/sync/working`），再调
`hub.notify_stream(account_id, frame)` 遍历 `online[account_id]` 逐个 send，
**排除发起设备**。

### E. 代跑：hub task 参数

在既有 `task` 的 args 上加两个字段（旧端忽略未知字段，向后兼容）：

```json
{"text":"…","from":"…","conversation":"…",
 "thread":"<owner 侧既有线程 id>",
 "handoff":true}
```

`thread` 缺省时行为不变（新建 `From <name>`）。

### F. 代跑标记

`Thread.handoff_from: dict | None`，与 `remote_from` 并列；
`nanomuse/sync/engine.py` 的 `_eligible()` **不因它排除**。

## 六、分阶段

| 阶段 | 内容 | 端 | 验收 | 状态 |
|---|---|---|---|---|
| **P0** | 中继：`owner_device` 列 + 迁移 + 往返；`/v1/sync/stream` + `notify_stream` + `FEATURES` | cloud | `cd cloud && ruff check . && pytest` | ✅ **337 passed** |
| **P1** | 运行时：`_task` 认 `thread`/`handoff`；`_relay_run` 转发 delta；busy 拒绝；`_watch_status` 合批上行；`on_frame` 收 `stream`；`client.stream()`；`hub/client.py` 并入 `stream` | nanomuse | `ruff` + `python -m pytest -q -m "not live"` | ✅ **1453 passed**（基线 1446，+7）|
| **P2** | Web：`streams` 按 round 分桶；远端流渲染；占位符改 `@<owner>`；`types.ts` 加 `owner_device` | web | `cd web && npm run check`（**不跑 build**） | ✅ **199 passed**（子代理，我亲验）|
| **P3** | Android：占位符；owner 读取与路由；远端流渲染（新文件优先） | android | kotlinc + JUnit（本机无 Android SDK，`compileDebugKotlin` 跑不了） | ✅ **54 tests**（我独立复现 34 项）|
| **确认点** | Android + Web 双机联调：飞牛跑一轮，本机看着流式到达；本机发一句，飞牛接着跑 | — | 手工 | ⏳ |
| **P4** | Mac：`harness/dsh-nanomuse` 对应实现 | mac | `npm run build && npm run typecheck && npm test` | 等确认点 |

P0/P1 已完成（地基，与端无关）；P2/P3 文件集不重叠，**并行**完成；
P4 **必须**等确认点（实机联调）过后才启动。

### Android 验证环境（本机真相，2026-11-10 实测）

「本机无 JDK」是**错的**，后续验证都走这条路：

- JDK 11：`/Users/donny/android-tools/openjdk@11/11.0.32.1/libexec/openjdk.jdk/Contents/Home`
- kotlinc：`~/.gradle/wrapper/dists/gradle-8.11.1-bin/*/gradle-8.11.1/lib/kotlin-compiler-embeddable-2.0.20.jar`
- junit 4.13.2 + hamcrest-core 1.3：Maven Central 下载（gradle 缓存里没有）
- 跑法：`K2JVMCompiler -cp <libs> -d out <纯函数> <桩> <测试>` → `JUnitCore`
- ⚠️ **`./gradlew :app:compileDebugKotlin` 跑不了**：AGP 8.7.3 要 JDK 17，本机只有 11，且无 Android SDK
- ⚠️ Compose/ViewModel 三处接线（`ChatScreen`/`ChatViewModel`/`ExecutorPlaceholder`）
  **无法真实编译**，只过了 parse 级检查 —— 这是唯一未验证面

### 修过的真实缺陷（联审发现，非子代理误报）

| # | 缺陷 | 修法 |
|---|---|---|
| 1 | **非中文占位符打不出来**：`nm_executor_self` 在 17 个 locale 有译文（英文 `@This device`），但 `addressesSelf` 只认 `本机` → 英文用户照占位符打 `@This device`，属主**不收回**（承诺落空） | Android `SELF_WORDS = listOf("本机", "this device")`（大小写不敏感 + 词尾边界）；运行时同步收敛为同样两个词 |
| 2 | 运行时曾认 4 个词（`本机`/`this device`/`this one`/`自己`），三端不一致 | 收敛为 2 个，三端同一张表 |

两个词表一致后：`tests/test_owner_routing.py::test_the_two_self_words_the_clients_show_both_work`
与 Android `DeviceOwnerTest` 的英文用例**双向**钉住「三端同义」。

### P1 实际落点（与分工表的差异）

| 流 | 实际文件 | 内容 |
|---|---|---|
| P1a 代跑与转发 | `nanomuse/hub/service.py`、`nanomuse/hub/client.py` | `_task` 认 `thread`（thread id 或 cid）/`handoff`；`_relay_run` 加 `stream_start`/`delta`/`reasoning_delta`/`stream_end` 分支 + 新 `_forward_stream()`；`handoff_to()` / `_handoff()`；`client.py` 并入 `stream` 帧 |
| P1b 流式上下行 | `nanomuse/sync/engine.py`、`nanomuse/sync/client.py`、**新 `nanomuse/sync/stream.py`** | `_watch_status` 一个循环两件事（status→presence，流帧→新 `StreamSender`）；`on_frame` + `_apply_stream`；`client.stream()`。上行合批独立成 `StreamSender`（不再塞进 engine） |
| P1c 归属模型 | `nanomuse/server/service.py`（`Thread.handoff_from` + `send(mid=)` + 路由）、`nanomuse/sync/mention.py`、**新 `nanomuse/sync/owner.py`** | `parse_mention` 的 `self_id` 可为目标（`self=True`）；`resolve()` 是路由唯一真理；`mark_owner`/`owner_device` 持久化在 `sync.json` |

`_eligible()` **未改**（`handoff_from` 天然不被排除，无需改动）——比分工表更省。

### P2/P3 实际分工（子代理并行）

| 流 | 实际文件 |
|---|---|
| P2 Web（子代理 `web-p2`） | 新 `web/src/stream-buckets.ts` + `device-executor.ts`（各带测试）；`store.tsx` 在既有 `stream_start`/`delta`/`reasoning_delta`/`tool_delta`/`stream_end` 分支加 `remote` 分流；`ChatScreen.tsx` 占位符；`types.ts`；`i18n/zh-CN.ts` |
| P3 Android（子代理 `android-p3`） | 新 `sync/DeviceOwner.kt` + `sync/StreamBatch.kt`（各带测试）；`ConversationSync.kt` 接 `owners: StateFlow`；`SyncApi/SyncEngine/SyncEntities/SyncModel/HubClient/Hub` 最小改动；`nm_strings.xml` 全 locale 加 `nm_executor_self`/`nm_executor_device` |

## 七、文件清单（预计改动面）

### 中继（P0）✅ 已完成

| 文件 | 改动 |
|---|---|
| `cloud/nanomuse_cloud/db.py` | SCHEMA 加 `owner_device` + `_migrate()` |
| `cloud/nanomuse_cloud/sync.py` | `_conversation_row` 加 `owner_device`/`owner_device_name`；INSERT/UPDATE 写 owner；`clean_stream_frame()` + `Sync.stream()` |
| `cloud/nanomuse_cloud/hub.py` | `notify_stream()` + `FEATURES` 加 `stream_sync` |
| `cloud/nanomuse_cloud/api.py` | `POST /v1/sync/stream` |
| `cloud/tests/test_sync.py` | +4 条（owner 往返、stream 扇出、stream 校验、FEATURES） |
| `cloud/tests/test_hub.py` | 1 条断言同步（FEATURES 增项） |

### 运行时（P1）

| 文件 | 改动 | 量级 | 归 |
|---|---|---|---|
| `nanomuse/hub/service.py` | `_task()` 加 `thread` 命中分支 + `handoff`；`_relay_run()` 加 delta 分支 | 中 | P1a |
| `nanomuse/hub/client.py` | `elif kind in (\"sync\",\"working\",\"stream\")` | 极小 | P1a |
| `nanomuse/sync/engine.py` | `_watch_status` 收流帧并合批上行；`on_frame` + `_apply_stream` | 大（本轮核心）| P1b |
| `nanomuse/sync/client.py` | 加 `stream()` | 小 | P1b |
| `nanomuse/sync/model.py` | `Thread.handoff_from` | 极小 | P1c |
| `nanomuse/sync/mention.py` | `self_id` 放行本机 | 小 | P1c |
| `nanomuse/sync/model.py`（或 `Thread` 定义处） | 加 `handoff_from` | 极小 |
| `tests/test_hub.py`、`test_sync.py` | 代跑、delta 转发、busy、合批 | 中 |

### Web（P2）

| 文件 | 改动 | 量级 |
|---|---|---|
| `web/src/store.tsx` | `streams` 按 round 分桶；收 `stream` 帧；记 owner | 中 |
| `web/src/screens/ChatScreen.tsx` | 占位符 `@<owner>` | 小 |
| `web/src/types.ts` | 会话行加 `owner_device` | 极小 |
| `web/src/i18n/zh-CN.ts` | 文案（`@{device}` 形式） | 极小 |
| `web/src/*.test.ts` | 分桶单测 | 小 |

### Android（P3）

| 文件 | 改动 | 量级 |
|---|---|---|
| `res/values*/nm_strings.xml` | 占位符文案（`nm_` 键，全 locale） | 小 |
| `io/github/nanomuse/sync/ConversationSync.kt` | 读 `owner_device`；流按 round 分桶 | 中 |
| `io/github/nanomuse/sync/SyncEngine.kt` | 收 `stream` 帧 | 中 |
| `io/github/nanomuse/sync/RemoteTaskController.kt` | `mid` + handoff 参数 | 小 |
| `io/github/nanomuse/sync/DeviceRoute.kt`（**新文件**） | 属主推断纯函数 | 小 |
| `com/openminis/.../ChatViewModel.kt` | 路由接上（**最小改动 + `// nanoMuse:` 注释**） | 中 |

> Android 树是 OpenMinis 子树：新代码放新文件（`io.github.nanomuse.*`），
> 既有文件里只做最小改动，每处带 `// nanoMuse:` 注释，不重排结构。

### 文档债（已改 / 刻意不改）

| 文档 | 处理 | 理由 |
|---|---|---|
| `CHANGELOG.md` | ✅ 已加 *Unreleased → Added* 两条 | 仓库规范要求 |
| `docs/hub.md` | ✅ 帧表加 `stream`；正文加 owner 与流式两段 | 仓库规范要求 |
| `docs/cloud.md` | ✅ 端点表 / 字段表 / 正文三处 | 仓库规范要求 |
| `docs/parity.md` | ⛔ **刻意不改** | 它是**跨客户端台账**，写一行就要给 iOS / Desktop 也标 ✓ —— 而 iOS 从未实现、Mac 待 P4。写了违反「事实来自仓库」，还给上游 PR 添堵 |
| `docs/zh/hub.md`、`docs/zh/cloud.md` | ✅ 已同步 | 英文改了 zh 不改会造成中英不一致（上游规范 + CI dead-link check）；只译正文，代码块/表格保英文（对齐上游 zh 的既有做法） |
| 十份 README | ⛔ **刻意不改** | 只在 milestone release 时改；本版未发布 |

## 八、低侵入与 PR 通过率

原则（也是本版与老一辈二开的分野）：

1. **新逻辑落在新文件**，既有文件只做挂接，每处一处改动。
2. **不改既有函数语义**：`_eligible()` 不放宽，`remote_from` 不复用，`working`
   presence 行为不动。
3. **向后兼容**：帧与 args 只加字段，旧端忽略未知字段；`FEATURES` 只追加。
4. **分端独立**：中继/运行时地基先合，客户端各自独立 PR，互不阻塞。
5. **不碰**：版本号、`CHANGELOG.md`、`android/` 的 OpenMinis 结构、
   `nanomuse/server/static/`（构建产物，最后统一 regenerate）。
6. **每阶段留一个可跑的检查**（见 §六表格）。

## 九、风险

| 风险 | 处置 |
|---|---|
| 默认路由从「本机」改为「属主」是行为变更 | 用环境变量开关，默认**开**（需求本身即此行为），置 0 回退上游行为 |
| Web `streams` 按 thread 存，两股流覆盖 | 按 `round` 分桶，P2 必须先做 |
| 合批频率撞中继限流 | 250ms/批 = 4 帧/秒，对 `FRAMES_PER_S=60` 留 15 倍余量 |
| owner 判定抖动（两台同时跑） | 跨端互斥已 `fail("busy")`；`owner_device` 以「跑完一轮」为准，不取中间态 |
| Android 本机无 JDK | 用 `singapore-tencent-server` 编译（见项目记忆），**不伪造结果** |
| 旁聊默认关（`side_chats` 逐设备） | 属主与流式在旁聊上同样成立，只是要过 `_eligible()` 的门；文档写明「先开同步开关 + 旁聊开关」 |

## 十、已确认的决定（2026-11-10）

1. **P0 中继改动保留**（已完成并跑通 337 条测试）。
2. 占位符格式：**`@飞牛深圳`**，无前缀。
3. 属主是本机时占位符显示 **`@本机`**。
4. **Mac 端必须等 Android + Web 实机联调确认后**再动。
5. **旁聊与主会话同等对待**：`@` 切换属主、完整流式、上下文接续，三项都要。
6. 默认执行人 = **最近属主**，非本机。
7. `@<设备>` 与 `@本机` 都可用，`@` 优先于默认且黏住。
8. 属主用 `device_id` 持久化，不用内存 presence。
