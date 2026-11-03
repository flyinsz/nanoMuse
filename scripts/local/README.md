# 我们的 fork：怎么维护

`flyinsz/nanoMuse` 是 <https://github.com/nano-muse/nanoMuse> 的 fork，GPL-3.0-or-later。
这个目录只放**我们自己的**维护脚本，不属于上游，不会被 `git subtree pull` 碰到。

## 三个 remote

```
origin     https://github.com/flyinsz/nanoMuse.git      ← 唯一能推的
upstream   https://github.com/nano-muse/nanoMuse.git    ← 只读（push URL 已设为 no-push-upstream）
openminis  https://github.com/OpenMinis/OpenMinis.git   ← 只读，只在合并 android/ 子树时用
```

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

## 每月一次：合并 OpenMinis 子树

`android/` 是 OpenMinis 的 `git subtree`，对方 squash 后月度发布。
当前基线是 **1.13**（2026-09-02），上游已发 1.14（09-29）、1.15（10-25）。

```bash
bash scripts/local/nm-fork.sh release 1.15
```

它会：切分支 → `git subtree pull --prefix=android openminis 1.15` → 图标冲突取我们的，
然后停下来告诉你下一步（解标记冲突 → 跑 `scripts/rebrand.py` → 跑图标脚本）。
**`rebrand.py` 第二次运行必须打印 `clean`。**

## 提交与 PR

- `git commit -s`（DCO 签名，上游 CI 会查）
- Conventional Commits：`feat(android): …` / `fix(hub): …`
- rebase 或 merge commit，**绝不 squash**——每条 `Signed-off-by` 都是记录

## fork 侧已做的设置

| 项 | 值 | 为什么 |
|---|---|---|
| Actions | **已禁用** | fork 默认会跑上游的全量 CI（Ubuntu+macOS+Windows 矩阵、Android APK、Docker），纯浪费配额。我们推 PR 到上游时它们会在上游仓库跑 |
| Issues | 关闭 | issue 走上游 |
| `upstream` / `openminis` 的 push URL | `no-push-…` | 手滑推不上去 |
| `pull.ff` | `only` | 防止意外的 merge |
| 克隆方式 | 完整克隆（**不是** `--filter=blob:none`） | 部分克隆会让 `git subtree pull` 在缺 blob 时挂住 |