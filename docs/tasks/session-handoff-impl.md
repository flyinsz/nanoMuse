# C13 落地分工与接口冻结

给并行工作的代理看的。设计在 [session-handoff.md](../session-handoff.md)，这里只放
**谁改哪些文件、接口长什么样**。四条工作流的文件集互不重叠，可以同时进行。

> 硬约束：**先读 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md)。**
> 改动以**追加**为主，新逻辑尽量落在新文件；不重构既有结构；不动版本号；`android/`
> 树不碰。每个工作流自己跑自己那块的检查。

## 工作流与文件所有权

| 流 | 范围（只准改这些） | 检查命令 |
|---|---|---|
| **W1 中继** | `cloud/nanomuse_cloud/**`、`cloud/tests/**` | `cd cloud && ruff check . && pytest` |
| **W2 运行时** | `nanomuse/**`、`tests/**` | `ruff check nanomuse tests && python -m pytest -q -m "not live"` |
| **W3 Mac 客户端** | `harness/dsh-nanomuse/**` | `cd harness/dsh-nanomuse && pnpm build && pnpm typecheck && pnpm test` |
| **W4 Web 客户端** | `web/**`（**不要**跑 `npm run build`，它会写 `nanomuse/server/static/`） | `cd web && npm run check` |

共用文件（`CHANGELOG.md`、`docs/**`）**本轮不动**，合并时由维护者统一处理。

## 接口冻结（以这里为准，不要自行改名）

### A. 归属：存储

```sql
-- cloud/nanomuse_cloud/db.py 的 SCHEMA，sync_conversations 增列
owner_device TEXT NOT NULL DEFAULT ''
```

迁移走已有的 `_migrate()` + `add(table, col, ddl)` 助手（`db.py` 里 `api_keys` 是
现成范例）。写入点：`sync.push()` 的会话 INSERT。值取客户端上报的 `device`。

### B. 流式广播：帧

中继 → 设备（服务端构造，仿 `working` 帧的扇出写法）：

```json
{"type":"stream","cid":"<会话 id>","from":"<device id>","round":"<本轮流 id>",
 "seq":1,"delta":"…","reasoning":"…","tool":{"name":"…","stage":"call|result"},
 "done":false}
```

- `round` 区分同一会话里的多股流（Web 现在按会话存流会互相覆盖，靠它分桶）。
- `delta` / `reasoning` / `tool` 三者至少有一个非空。
- `done:true` 表示这一轮结束，接收端收尾。
- **加入** `FEATURES`（`hub.py`）：`FEATURES = ["event_push", "stream_sync"]`。

### C. 流式广播：上行端点

```
POST /v1/sync/stream
body: {"cid":"…","device":"…","round":"…","seq":1,
       "delta":"…","reasoning":"…","tool":{…},"done":false}
→ {"ok": true}
```

服务端校验账号与会话存在（仿 `POST /v1/sync/working` 的写法），然后调
`hub.notify_stream(account_id, frame)`，后者遍历 `online[account_id]` 逐个 send，
**排除发起设备**（与 `notify_working` 一致）。

### D. 代跑：hub task 参数

发起端 → owner。在既有 `task` 的 args 上加两个字段（旧端忽略未知字段，向后兼容）：

```json
{"text":"…","from":"…","conversation":"…",
 "thread":"<owner 侧既有线程 id>",      // 新增：在这一条上跑，而不是新建
 "handoff":true}                        // 新增：这一轮是别处发起的
```

`thread` 缺省时行为不变（新建 `From <name>`），保证旧调用方不受影响。

### E. 「谁问的」侧信道

**禁止**把发起者信息拼进用户消息正文。Python runtime 用 `Thread.purposes`
（`nanomuse/server/service.py` 的 `purposes[text] = label`）那样的并行通道；DSH /
Android / iOS 若也要做，同样走侧信道，不得改用户消息文本。

### F. 代跑标记（与同步解耦）

`nanomuse/sync/engine.py` 的 `_eligible()` 排除 `thread.device` / `thread.remote_from` /
`thread.main_of`。**不得**用 `remote_from` 承载「这一轮被别的设备代跑」——那会让会话
停止同步。用**线程上的新字段**（建议 `Thread.handoff_from: dict | None`，与
`remote_from` 并列），且 `_eligible()` **不因它排除**。

## 各流的第一批任务（本轮）

### W1 中继
1. `db.py`：`sync_conversations` 增 `owner_device` 列 + 迁移。
2. `sync.py`：`push()` 的会话体接收并写入 `owner_device`；`changes()` 的
   `_conversation_row` 输出它（旧字段全保留）。
3. `hub.py`：`notify_stream()`（仿 `notify_working` 写）+ `FEATURES` 追加。
4. `api.py`：`POST /v1/sync/stream` + 帧类型文档注释。
5. 测试：`cloud/tests/` 里加 owner_device 往返、`/v1/sync/stream` 广播（含排除发起端）。

### W2 运行时
1. `hub/service.py` 的 `_task()`：支持 `thread` 参数命中**既有线程**（新增分支，不
   改旧路径）；`handoff` 为真时打 `handoff_from`（**不是** `remote_from`）。
2. `_relay_run()`：新增 `delta` / `reasoning_delta` / `stream_start` / `stream_end`
   分支，转发给调用方（现有只处理 `event`/`update`/`thread`）。
3. `_forward_event()`：新增逐字 stage（`partial:true`），与既有 `text` 区分。
4. 跨端互斥：同会话已有 run 在进行时，新的代跑请求**明确 fail("busy")**。
5. 测试：`tests/` 加「既有线程被代跑」「delta 被转发」「busy 拒绝」。

### W3 Mac 客户端
1. 归属路由：会话有 owner 时不写 `@` 也发往 owner（`client/device-mention.ts` 与
   `client/AvatarChat.tsx` 现有 `boundDeviceFor` 路由旁边加分支）。
2. `@本机` 特例：本机名匹配时切回本机执行（现有规则排除 `self_id`）。
3. 执行者提示行：输入框上方固定显示当前 owner（`conversation.input.dock` 里加一个
   slot，仿 `DeviceRowSlot` 的注册写法）。
4. 流式渲染：`client/RemoteBubbles.ts` 能在会话内画一股进行中的流（按 `round` 分桶）。
5. 测试：`tests/` 加归属路由与 `@本机` 的纯函数单测。

### W4 Web 客户端
1. 流式按 `round` 分桶渲染（`web/src/store.tsx` 的 `state.streams` 现在是按会话键，
   两股流会互相覆盖）。
2. 会话内显示当前 owner。
3. 测试：`web/src` 现有测试风格加一条分桶单测。

## 交付要求

- 每个流**只提交自己的文件**，不要 `git commit`（维护者统一提交）；改完把
  「改了哪些文件 + 检查命令的输出」报回来。
- 遇到接口与本文不符：**以本文为准**；确实需要改接口时先说明，不要自己另起一套。
- 不确定的地方**宁可少改**：低侵入优先，提 PR 通过率优先。
