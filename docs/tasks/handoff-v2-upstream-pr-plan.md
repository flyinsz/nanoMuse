# 提上游 PR 清单（executor handoff v2）

> 基线 `upstream/main @ f86708ac4`（= `nano-muse/nanoMuse`），分支 `feat/executor-handoff-v2 @ 83d675aaa`。
> 本文是 **`handoff-v2-change-classification.md` 的重算版**：那份写于 11:24（HEAD 还是 `25e6562b9`），
> 之后又落了 3 个提交（方案 C 接线 + 文档），文件数从 15 涨到 20，故重算。
> 判定工具 `scripts/classify-changes.py` 只扫**工作区**；工作区已干净，故用同规则对 `upstream/main..HEAD` 重跑。

## 一、先纠正一个前提（影响怎么提 PR）

`upstream` 是 **`nano-muse/nanoMuse`**，它**本身就是**「原版 + nanoMuse 二开」的那个仓库 ——
`io.github.nanomuse.*` 里有 **239 个文件**、`com.openminis.*` 有 **478 个**，`AGENTS.md` 的
"two trees" 规则也是**它自己写的**。

所以 fork 的三层是：

```
OpenMinis/OpenMinis      ← 最上游（openminis remote）
  └─ nano-muse/nanoMuse  ← upstream：加了 nanoMuse 那一层（io.github.nanomuse.* + nm_strings.xml）
       └─ flyinsz/nanoMuse ← origin：我们的 fork（本次改动在这）
```

**含义**：`io.github.nanomuse.*` 不是"我们的私货"，是**上游的公共命名空间**。上次分类文档把
它整个划进 "OURS / 不提"，**过低估计了能提上去的量**。判据应该是：

- **上游没有的新文件** → 可以提（只要它没绑 fork 专有配置）
- **上游已有的文件被改** → 可以提，但要看改的是功能还是 fork 行为
- **fork 专有的东西**（部署地址、构建开关、内部计划文档）→ 不能提

## 二、重算后的四类（`upstream/main..HEAD`，132 文件；已排除 45 个构建产物）

```
PROPOSABLE   26   ← relay 5 + runtime 10 + console 6 + Android 5（可提）
OVERLAY       5   ← 客户端上游文件，改了且带标记（视改法可提）
OURS         63   ← fork 专有 / 内部文档 / 工具脚本
构建产物      45   ← nanomuse/server/static/（须随 web/src 同一次提交）
```

### 2.1 ✅ 可以直接提（第一批：地基，低争议）

**中继（5）** —— 全上游风格、无 fork 依赖：

| 文件 | 改了什么 |
|---|---|
| `cloud/nanomuse_cloud/sync.py` | `clean_stream_frame`、`owner_device` 读写、`stream()` |
| `cloud/nanomuse_cloud/api.py` | `POST /v1/sync/stream` 端点 |
| `cloud/nanomuse_cloud/db.py` | `owner_device` 列 + 迁移 |
| `cloud/nanomuse_cloud/hub.py` | `stream_sync` feature 位、`stream` 扇出 |
| `cloud/nanomuse_cloud/service.py` | `BLOB_MIMES` 扩为 5 类前缀（附件全类型）|

**运行时（10）**：

| 文件 | 改了什么 |
|---|---|
| `nanomuse/sync/engine.py` | 属主、路由、stream 上行、`_adopt_owner` |
| `nanomuse/sync/client.py` | `stream()` 请求 |
| `nanomuse/hub/client.py` | stream 发送 |
| `nanomuse/hub/service.py` | 中转 stream 帧、`handoff_to` |
| `nanomuse/server/service.py` | `handoff_from`、`mid` 参数、路由分支、附件传递 |
| `nanomuse/sync/__init__.py` | 导出 `Where` 等 |
| `nanomuse/sync/mention.py` | `@` 解析（含 `本机`/`this device`）|
| `nanomuse/cloud.py` | `get_blob()` |
| `nanomuse/config.py` | `SyncSettings.owner_routing` + 环境变量 |
| `nanomuse/sync/**` 新文件 | `owner.py`、`stream.py`、`files.py` |

**Web 控制台（6）**：`store.tsx`、`screens/ChatScreen.tsx`、`types.ts`、`i18n/zh-CN.ts`、`mention.ts`、`mention.test.ts`
**Web 新文件**：`device-executor.ts`、`stream-buckets.ts`（+各自测试）

**Android 新文件（5 个源 + 5 个测试）** —— 放 `io.github.nanomuse.*`，本身就是上游规矩里的"新代码放新文件"：

`sync/DeviceOwner.kt`、`sync/ExecutorPlaceholder.kt`、`sync/StreamBatch.kt`、
`hub/HubAttachments.kt`、`hub/HubAttachmentFetcher.kt` + 各测试。

### 2.2 ⚠️ 有条件可提（第二批：客户端接线）

上游已有的 Android 文件，我们改了且**带了标记**（标记本身对上游是噪音，要按改动性质取舍）：

| 文件 | 标记数 | 性质 |
|---|---|---|
| `com/openminis/app/ui/chat/ChatViewModel.kt` | 6 | 上游文件，接线（可提，标记要清）|
| `com/openminis/app/ui/chat/ChatScreen.kt` | 2 | 同上 |
| `com/openminis/app/ui/chat/ComposerPlaceholderUi.kt` | 1 | 同上 |
| `com/openminis/app/data/FileMentionIndex.kt` | 1 | 同上 |
| `io/github/nanomuse/hub/Hub.kt` | 1 | 上游文件（nanoMuse 层），接线 |
| `io/github/nanomuse/hub/HubActions.kt` | 3 | 同上 |
| `io/github/nanomuse/hub/HubClient.kt` | 2 | 同上 |
| `io/github/nanomuse/sync/ConversationSync.kt` | 14 | 同上 |
| `io/github/nanomuse/sync/SyncEngine.kt` | 11 | 同上 |
| `io/github/nanomuse/sync/SyncApi.kt` | 2 | 同上 |
| `io/github/nanomuse/sync/SyncModel.kt` | 3 | 同上 |
| `io/github/nanomuse/sync/SyncEntities.kt` | — | 同上 |
| `io/github/nanomuse/sync/RemoteChatBridge.kt` | — | 同上 |
| `io/github/nanomuse/sync/RemoteTaskChat.kt` | 2 | 同上 |
| `io/github/nanomuse/sync/DeviceMentionMenu.kt` | **0** ⚠️ | **改了没打标记** —— 见 §四 |
| `res/values*/nm_strings.xml`（17 个） | — | 上游自己的约定文件（`nm_` 键），合规 |
| `android/app/build.gradle.kts` | — | ⚠️ 见 §四 |
| `tests/*`、`docs/*.md`、`CHANGELOG.md` | — | 上游文件，改动是配套的，可随同提交 |

### 2.3 ❌ 不提（fork 专有）

| 类别 | 文件 |
|---|---|
| 内部计划 | `docs/tasks/executor-handoff-v2.md`、`docs/tasks/handoff-v2-change-classification.md`、`docs/tasks/handoff-v2-upstream-pr-plan.md` |
| fork 工具 | `scripts/classify-changes.py`、`scripts/mark-user-edits.py` |
| 构建产物 | `nanomuse/server/static/`（45 文件）—— **但要随 `web/src` 同提交**，上游规矩如此 |

## 三、提 PR 前必做的 5 项清理

| # | 事项 | 量 | 怎么查 |
|---|---|---|---|
| 1 | **清 `# nanoMuse:` 标记** | **60 处**，散在 13 文件 | `git diff upstream/main..HEAD -- nanomuse/ \| grep -c "^+.*nanoMuse:"` |
| 2 | **清内部文档引用** | **16 处**（`docs/tasks/…`、`§九`）| 见 §五 命令 |
| 3 | 清 profile 构建开关 | `build.gradle.kts` 的 `nm.appId`/`nm.appName` | `git diff upstream/main..HEAD -- android/src/android/app/build.gradle.kts` |
| 4 | 补 `DeviceMentionMenu.kt` 的标记 | 1 处（或确认该文件整体提走）| 见 §四 |
| 5 | 同步 `CHANGELOG.md` | — | 上游规矩：改了用户可见行为要在 *Unreleased* 加一行 |

**标记分布**（60 处）：`server/service.py` 16、`engine.py` 11、`files.py` 10、`mention.py` 6、
`hub/service.py` 5、`mention.ts` 3、`config.py` 2、`stream.py` 2、`cloud.py` 1、
`owner.py` 1、`cloud/service.py` 1、静态产物 2。

## 四、两处需要判断的（不是明显错，但要定）

**① `DeviceMentionMenu.kt` 改了没标记**
它是上游文件（`io/github/nanomuse.sync`），我们加了 `selfName` 参数与"本机"行。分类器因
`io.g*` 前缀把它划走，**漏掉了这条**。它属于「上游文件被改」，要么补标记（保持 fork 可合并），
要么整体提走（改动是通用能力）。

**② `build.gradle.kts` 的 `nm.appId` / `nm.appName`**
这是**为了同机装两个版本**的 fork 构建开关，上游不需要。改动本身**向后兼容**
（不传 `-P` 时与原样逐字节一致），但**动机是 fork 的**。建议**不随 PR 提**，留在 fork。

## 五、自检命令

```sh
cd /Users/donny/nanoMuse-handoff

# 四类各有多少（工作区；已提交时恒为 0，用下面的重算版看）
/Users/donny/nanoMuse/.venv/bin/python scripts/classify-changes.py

# 当前 HEAD 相对上游的改动清单
git diff --name-status upstream/main..HEAD | grep -v "nanomuse/server/static/"

# PR 前要清的两类噪音
git diff upstream/main..HEAD -- nanomuse/ cloud/nanomuse_cloud/ web/src/ | grep "^+" | grep -c "nanoMuse:"
git diff upstream/main..HEAD -- nanomuse/ cloud/nanomuse_cloud/ web/src/ | grep "^+" | grep -cE "docs/tasks/|§[一二三四五六七八九十]"

# 改过的上游文件里，哪些还没打标记（客户端树）
git diff --name-status upstream/main..HEAD | grep "^M" | awk '{print $2}' \
  | grep -E "^(android/src/android/app/src/main/java/com/openminis|android/src/android/app/src/main/java/io/github/nanomuse)" \
  | while read f; do [ "$(git diff upstream/main..HEAD -- "$f" | grep -c '^+.*nanoMuse:')" = 0 ] && echo "⚠ $f"; done
```

## 六、建议的 PR 拆分（3 个，按依赖顺序）

上游规矩「一次提交只做一类」+「地基先合」：

| PR | 范围 | 依据 |
|---|---|---|
| **① relay + runtime** | `cloud/nanomuse_cloud/*` + `nanomuse/*`（除 `server/static/`）+ 各自测试 + `docs/cloud.md`/`docs/hub.md` | 协议层先合：`owner_device` 列、`/v1/sync/stream`、`get_blob`、路由。**不含任何客户端** |
| **② Web 控制台** | `web/src/*` + 重建的 `nanomuse/server/static/` | 依赖 ①的协议 |
| **③ Android** | `io.github.nanomuse.*` 新文件 + 上游文件接线（清标记后）+ `nm_strings.xml` | 依赖 ①② |

**理由**：①是纯协议/服务端，争议最小、Reviewer 最容易判断；②③各自独立，且都能单独回退。

## 七、已知的 PR 风险（提之前要认下来）

1. **功能面很大** —— 2600+ 行、跨 relay/runtime/console/Android 四层。上游可能要求拆得更细，
   或先只收 ①。
2. **没有 issue 编号** —— 上游规矩要求 `For #N`。先开 issue 说明设计，再提 PR。
3. **`UPSTREAM-FIX` = 0** —— 本次没有"修上游自身 bug"的独立项可摘，全是新功能。
4. **`docs/tasks/` 必须排除** —— `AGENTS.md` 明写 *internal planning* 不入库。
