# 我们的 fork：怎么维护

`flyinsz/nanoMuse` 是 <https://github.com/nano-muse/nanoMuse> 的 fork，GPL-3.0-or-later。
这个目录只放**我们自己的**维护脚本，不属于上游，不会被 `git subtree pull` 碰到。

## 三个 remote

```
origin     https://github.com/flyinsz/nanoMuse.git      ← 唯一能推的
upstream   https://github.com/nano-muse/nanoMuse.git    ← 只读（push URL 已设为 no-push-upstream）
openminis  https://github.com/OpenMinis/OpenMinis.git   ← 只读，*只在需要时*用（见下）
```

## 两个「版本」不要混

| | 是什么 | 状态（2026-11-03） |
|---|---|---|
| **nanoMuse 仓库** | 我们 fork 的对象 | ✅ 最新，`main` = 上游 `91f49429` |
| **`android/` 目录** | nanoMuse 用 `git subtree` 引入的 OpenMinis 快照 | ⏸ 停在 **1.13** |

`android/` 是 subtree 快照，不跟着上游走。逐文件比对 git blob 哈希的结果：

```
OpenMinis 1.13 ：398/398 文件与 android/ 完全一致   ← 基线
OpenMinis 1.14 ：395/398
OpenMinis 1.15 ：385/392
```

## ⚠️ 不要主动合并 OpenMinis 子树

上游 nanoMuse **自己也没合并** 1.14 / 1.15：

- `upstream/main:android/BUILDING.md` 与我们的 blob 哈希完全相同
- 上游 `CONTRIBUTING.md:44` 的示例仍是 `subtree pull … 1.14`
- 上游无相关 branch / PR

`git subtree pull` 会写入一条**把 OpenMinis 历史接进本仓的 merge commit**。
我们抢先做，就在 fork 里造出一段「上游没有的 subtree merge 史」，
此后 `git rebase upstream/main` 会反复冲突——**反而制造了要避免的麻烦**。
而这一合并是 2805 个文件 / 72 万行（1.13→1.15），对上 620 处 `// nanoMuse:` 标记。

**做法：`android/` 保持 1.13，等上游合并时我们 rebase 跟随。**
`nm-fork.sh release` 保留备用（上游合并后若需重建本地子树可参考），**默认不执行**。

## 网络

沙箱里 GitHub 直连不通，必须走本机代理 `127.0.0.1:7890`。
git 的代理是**每命令传**的，没有写进全局配置（换机器上不用改回来）：

```bash
export NM_PROXY=http://127.0.0.1:7890     # 脚本默认就用这个
```

`gh` 走的是自己的 keyring token，不走 git 代理。

## 日常：跟上上游

上游每天 300 次以上的提交（近 7 天 361 次）。但**我们只改 `android/`**，其余目录零改动，
所以跟上上游基本是免费的：

```bash
bash scripts/local/nm-fork.sh sync
```

它做四件事：检查工作区干净 → `fetch upstream --tags` → `rebase upstream/main` → 推 `origin/main`，
然后列出「我们自己的文件」与「被我们改过的上游文件」。

## 每次同步后：确认标记没丢

CONTRIBUTING 的规则 3：改上游文件必须加 `// nanoMuse:` 标记，一处改动一个标记。
rebase 之后跑一遍，确认没有**未标记**的上游改动：

```bash
bash scripts/local/nm-fork.sh marks
```

输出两种行：

- `N marks  <file>`  这个上游文件有 N 处标记（正常）
- `UNMARKED <file>`  改了上游文件但没标记（**必须修**）

当前基线（2026-11-03）的既存量：**112 个上游 Kotlin 文件、620 处标记**，
`ChatViewModel.kt` 一个文件 114 处。这是上游自己的债务，我们的目标是**不再增加**。

## 上游发新版之后：跟随，不要抢先

`android/` 是 OpenMinis 的 `git subtree`，对方 squash 后月度发布。**合并是上游的动作。**

上游合并后我们只需：

```bash
bash scripts/local/nm-fork.sh sync      # rebase 到新的 upstream/main
bash scripts/local/nm-fork.sh marks     # 确认我们的标记还在
```

如果确实需要在本机试一次子树合并（例如想评估冲突规模），用它，**但不要推到 `main`**：

```bash
bash scripts/local/nm-fork.sh release 1.15
```

它会：切分支 → `git subtree pull --prefix=android openminis 1.15` → 图标冲突取我们的，
然后停下来告诉你下一步（解标记冲突 → `scripts/rebrand.py` → 图标脚本）。
**`rebrand.py` 第二次运行必须打印 `clean`。**

## 提交与 PR

- `git commit -s`（DCO 签名，上游 CI 会查）
- Conventional Commits：`feat(android): …` / `fix(hub): …`
- rebase 或 merge commit，**绝不 squash**——每条 `Signed-off-by` 都是记录
- 改 `web/` 必须 `cd web && npm run check && npm run build`，并把 `nanomuse/server/static/` 一起提交（那是入库的构建产物）
- 改 `harness/dsh-nanomuse/` 必须 `pnpm build && pnpm typecheck && pnpm test`

## fork 侧已做的设置

| 项 | 值 | 为什么 |
|---|---|---|
| Actions | **已禁用** | fork 默认会跑上游的全量 CI（Ubuntu+macOS+Windows 矩阵、Android APK、Docker），纯浪费配额。我们推 PR 到上游时它们会在上游仓库跑 |
| Issues | **已启用** | 本地跟进度用；对上游的问题仍走上游 issue |
| `upstream` / `openminis` 的 push URL | `no-push-…` | 手滑推不上去 |
| `pull.ff` | `only` | 防止意外的 merge |
| 克隆方式 | 完整克隆（**不是** `--filter=blob:none`） | 部分克隆会让 `git subtree pull` 在缺 blob 时挂住 |