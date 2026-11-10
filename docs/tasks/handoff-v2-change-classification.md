# 二开改动分类与上游 PR 清单（executor handoff v2）

> 基线 `upstream/main @ f86708ac4`，分支 `feat/executor-handoff-v2`。
> 目标：把改动分成「上游能直接收的」与「只能是 fork 的」，提高 PR 通过率。
> 判定工具：`scripts/classify-changes.py`（可复跑）、`scripts/mark-user-edits.py`（补标记）。

## 一、四类改动

上游的规矩写在 `AGENTS.md`（*Two trees, two sets of rules*）：我们的代码放新文件
（`io.github.nanomuse.*` / `NanoMuse/`），改**客户端**上游文件必须带 `// nanoMuse:` 注释。

handoff v2 的方案（`executor-handoff-v2.md` §八第 4 条）加了第二条规矩，它决定了 relay /
runtime / console 那一批属于哪一类：**「中继/运行时地基先合，客户端各自独立 PR」**
—— 那批代码是**按上游自己的风格写的，准备提回上游**，所以**刻意不打 `nanoMuse:` 标记**
（打了反而把代码标成 fork 专有，与目的相反）。

| 类 | 判据 | 对上游 PR |
|---|---|---|
| **OURS** 我们的新文件 | 新文件，或在 `io.github.nanomuse.*` 下 | 不提：一个 PR 会带上整个 fork |
| **PROPOSABLE** 拟上游 | relay `cloud/nanomuse_cloud/`、runtime `nanomuse/`、console `web/src/`，**上游风格、不打标记** | ✅ **可以提**：地基先合，客户端各自独立 |
| **OVERLAY** 客户端 fork | 客户端树（`openminis/`、`Minis/`）的上游文件，每处带 `// nanoMuse:` | ❌ 是 fork 行为 |
| **UPSTREAM-FIX** 修上游自身的 bug | 标记写成 `// nanoMuse(fix):` | ✅ **单独提**：一个 PR 一件事，与 fork 无关 |

**`(fix)` 的判据**：修的是**上游每个用户都会撞上的**行为，不是我们的功能。写成
`nanoMuse(fix):` 是作者的一个声明，脚本核不了 —— 它只分类，判断留给人。

## 二、当前状态（2026-11-10）

```
UPSTREAM-FIX   0
PROPOSABLE    15   ← relay 4 + runtime 7 + console 4（拟上游，不打标记）
OVERLAY        3   ← 客户端，全部有 // nanoMuse: 标记 ✅
OURS          54
```

**零未标记** —— `python3 scripts/classify-changes.py --require-clean` 退出 0。

### 2.1 PROPOSABLE（15）—— 可以提回上游的地基

| 文件 | 树 | 改了什么 |
|---|---|---|
| `cloud/nanomuse_cloud/sync.py` | relay | `clean_stream_frame`、`owner_device` 列读写、`stream()` |
| `cloud/nanomuse_cloud/api.py` | relay | `POST /v1/sync/stream`、端点头部注释 |
| `cloud/nanomuse_cloud/db.py` | relay | `owner_device` 列 + 迁移（`0.32:` 风格的注释已在） |
| `cloud/nanomuse_cloud/hub.py` | relay | `stream_sync` feature 位、`stream` 扇出 |
| `nanomuse/hub/client.py` | runtime | `stream` 发送 |
| `nanomuse/hub/service.py` | runtime | 中转 `stream` 帧 |
| `nanomuse/server/service.py` | runtime | `handoff_from`、`mid` 参数、`route_line` 分支 |
| `nanomuse/sync/__init__.py` | runtime | 导出 `Where` 等 |
| `nanomuse/sync/client.py` | runtime | `stream()` 请求 |
| `nanomuse/sync/engine.py` | runtime | 属主、路由、`stream` 上行 |
| `nanomuse/sync/mention.py` | runtime | `@` 解析（含 `本机`/`this device` 词表） |
| `web/src/store.tsx` | console | 流分桶、`@` 占位符状态 |
| `web/src/screens/ChatScreen.tsx` | console | 占位符渲染 |
| `web/src/types.ts` | console | `StreamFrame`、`ownerDevice` 类型 |
| `web/src/i18n/zh-CN.ts` | console | `@本机` 等文案 |

**注意**：`nanomuse/sync/engine.py`、`mention.py`、`server/service.py` 里**夹着少量
`# nanoMuse:` 标记**（更早的改动留下的），但整文件仍归 PROPOSABLE —— 脚本按**树**判定，
因为「整批交付回上游」是这一批的意图。提 PR 时把这些标记去掉即可。

### 2.2 OVERLAY（3）—— 客户端 fork，已合规

| 文件 | 改了什么 |
|---|---|
| `openminis/app/ui/chat/ChatScreen.kt` | 占位符交给 executor |
| `openminis/app/ui/chat/ChatViewModel.kt` | `uiMessages` 合入远端流；`tookOwnerThere` |
| `openminis/app/ui/chat/ComposerPlaceholderUi.kt` | 回退 `executor` 参数（默认行改由 caller 给） |

三处都有 `// nanoMuse:` 标记，符合上游规矩。

## 三、可以单独提给上游的候选

按「上游每个用户都会撞上」这条线找，目前 **0 个**（`UPSTREAM-FIX` 为空）。
下面这些**看起来像**但**不是**，记下来免得反复评估：

| 现象 | 为什么不是 upstream-fix |
|---|---|
| HANDOFF 分支漏 `sync.message_sent()` | 整个 HANDOFF 分支是**我们新加的**（`git diff` 全为 `+`），上游没有这段代码，也就没有这个 bug |
| `owners()` 按 `sessionId` 查而会话已重建 | `owners()` 及其消费方都是我们新增的 `io.github.nanomuse.sync.*` |
| `MainChat.persisted` 指向死会话 | 这个**是**上游行为 —— 但 `MainChat.resolve()`（`home/MainChat.kt:40`）**已经**处理了回落（persisted 无效 → 首个会话 → 最近更新的会话 → 草稿）。它只是**没修 sync 侧的映射**，而映射是我们的。所以不改上游，在我们侧自愈即可（已做：`SyncEngine.reconcileOrphanMain`） |

**判定法（别凭直觉）**：`git diff HEAD -- <file>` 全是 `+` → 我们新加的；有上下文
`-`/`+` 混杂 → 改的上游。

**真正该找 upstream-fix 的方向**：等我们把功能跑通后，回头单独看「上游在没有我们这套
handoff 时，自己有没有前后矛盾的地方」。目前不动。

## 四、提交节奏建议

1. **一次提交只做一类**。`feat(android): executor handoff` 与 `fix(relay): ...` 分开，
   将来要摘出 upstream-fix 时不用拆。
2. **submit 前跑** `python3 scripts/classify-changes.py --require-clean`：客户端的 overlay
   有未标记就退出 1。建议接进本地 pre-commit（不进上游 CI，那是人家的仓库）。
3. **`nanomuse/server/static/` 是生成物**（`cd web && npm run build` 写出），
   与 `web/src` 同一次提交带上，别单独改。
4. **标记语言**：Kotlin / TypeScript / Swift 用 `// nanoMuse:`，Python 用 `# nanoMuse:`。
   两者脚本都认。Swift 的 `NanoMuse/*.swift` 本就是我们自己的目录，不需要标记。
5. **PROPOSABLE 那一批提 PR 时删掉零星的 `# nanoMuse:` 标记** —— 那批的意图是交回上游。

## 五、自检命令

```sh
# 四类各有多少、客户端 overlay 有没有漏标记
python3 scripts/classify-changes.py

# 只在客户端 overlay 有未标记时失败（提交前跑）
python3 scripts/classify-changes.py --require-clean

# 看某客户端文件有哪些块缺标记（不改动）
python3 scripts/mark-user-edits.py --why "handoff v2" --check android/src/.../ChatScreen.kt

# 给整块新函数补标记（跑完必须 git diff 复核）
python3 scripts/mark-user-edits.py --why "the executor line" android/src/.../ChatScreen.kt
```

