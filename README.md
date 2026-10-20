# dsh-branch-cleaner

> 清理 **已经落地到主线** 的 git 分支：默认只报告，删前自动备份。
> A DeepSeek Harness plugin that finds branches whose work already landed in the mainline — merged, squash-merged, patch-equivalent (rebase/cherry-pick), upstream-gone, or PR-merged — then deletes them safely.

[![npm](https://img.shields.io/npm/v/dsh-branch-cleaner)](https://www.npmjs.com/package/dsh-branch-cleaner)
[![license](https://img.shields.io/github/license/ramwin/dsh-branch-cleaner)](./LICENSE)

## 为什么需要它

`git branch --merged` 只认**祖先合并**。用 squash merge 或者 rebase 落地的分支，它永远认不出来，
于是本地几十个、远程上百个分支越积越多。这个插件把几种「其实已经落地」的情况都判出来：

| 落地方式 | `--merged` 认得出吗 | 插件用的判定 |
| --- | --- | --- |
| merge / fast-forward | 认 | `git merge-base --is-ancestor` |
| squash merge | 不认 | `git merge-tree --write-tree`：把分支合回主线，主线内容一点不变 → 已落地 |
| rebase / cherry-pick | 不认 | `git cherry`：没有 `+` 开头的行 → 补丁全在主线 |
| PR 已合并 | 看落地方式 | `gh pr list --head <branch> --state merged`（可选） |
| 上游分支已删 | 不认 | `%(upstream:track)` 里的 `[gone]` |

## 安装

```sh
# npm
dsh plugin --profile web add dsh-branch-cleaner

# 或者从 GitHub 装（含 beta 分支）
dsh plugin --profile web add github:ramwin/dsh-branch-cleaner

# 本地开发
dsh plugin --profile web add /path/to/dsh-branch-cleaner
```

装完重开 `dsh web`（或刷新页面），模型就多了 `git_clean_branches` 工具。

## 用法

直接在对话里说：

> 看看这个仓有哪些分支已经合过了，能删的列出来

> 把已经合并的分支删掉，保留 develop 和 release/*

模型会先 `mode=report` 列一遍，你确认后才用 `mode=delete`。也可以明确要求一步到位。

### 工具参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | `report` / `delete` | **默认 report，只列出不删除**；只有 `delete` 才真删 |
| `repo` | string | 仓库路径，默认当前会话工作目录，相对路径按它解析 |
| `base` | string | 对比基线，默认 `origin/HEAD` → main/master → 当前分支 |
| `squash` | boolean | 识别 squash 合并 |
| `patches` | boolean | 识别 rebase / cherry-pick 落地 |
| `gone` | boolean | 识别上游已删除的分支 |
| `pr` | boolean | 用 `gh` 识别已合并的 PR |
| `all` | boolean | = `squash` + `patches` + `gone` + `prune` + `remote` |
| `remote` | boolean | 连 origin 上的已合并远程分支一起清 |
| `prune` | boolean | 先 `git fetch --prune` 刷新 `[gone]` |
| `age` | integer | 只处理 tip 提交早于 N 天的分支 |
| `keep` | string[] | 额外保护的 glob，如 `wip/*`（默认已保护 main/master/develop/release/* 等） |
| `recurseSubmodules` | boolean | 对每个已初始化子模块各跑一遍 |
| `timeoutMs` | integer | 协作式超时，默认 180000 |

### 安全性

- **默认只报告**：`mode=report` 一个分支都不动，连 `git checkout` 都不执行。
- **绝不 rebase、绝不切分支、绝不碰工作区**：只跑只读的判定命令 + `git branch -d/-D`。
- **永不动的分支**：基线本身、当前检出的、任何 worktree 里检出的、命中保留规则（`main master develop trunk release/* hotfix/* gh-pages backup/* dependabot/*`）的。
- **删前备份**：每个被删分支的 SHA 记到 `refs/backup/branch-cleaner/<时间戳>/<分支名>`，恢复：

  ```sh
  git for-each-ref refs/backup/branch-cleaner/     # 看备份
  git branch feat/x $(git rev-parse refs/backup/branch-cleaner/20260101-120000/feat/x)
  ```
- **squash 判定不会误杀**：它问的是「把这个分支合回去，主线会不会变」——会变就不删。

## 和脚本的关系

插件的 `assets/delete_redundant_branch.sh` 是
[linux-reference](https://github.com/ramwin/linux-reference) 里同一份脚本的副本（唯一事实来源在那边，
判定逻辑、回归测试都在那儿）。插件只负责：把参数翻译成 argv → 在会话工作目录跑脚本 → 解析 JSON → 渲染给模型。

同步：

```sh
scripts/sync-from-linux-reference.sh
```

## 开发

```sh
node --test test/        # 10 个用例：参数翻译 / JSON 解析 / 真实仓库 report 与 delete
```

## License

MIT © Xiang Wang
