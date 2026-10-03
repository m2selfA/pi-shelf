# pi-shelf

Pi 扩展：一类一层架子。筛选后把选中条目的 `value` 贴进当前输入框，不覆盖已有文字，也不发送。

## 安装

```bash
pi install /path/to/pi-shelf
```

或开发时：

```bash
pi --extension ./index.ts
```

收藏和规则分开：

| 文件 | 内容 |
| --- | --- |
| `~/.pi/agent/pi-shelf/store.json` | 全局收藏和归档 |
| `~/.pi/agent/pi-shelf/config.json` | 全局 topic 与动态源，可以单独拷贝 |
| `<repo>/.pi/shelf.json` | 当前仓库的收藏、归档和规则，可以提交 |

仓库按 `git remote` 认，不按盘符。`git@github.com:owner/repo.git` 和 `https://github.com/owner/repo` 是同一份。文件里的 remote 对不上当前仓库时不读、也不覆盖。同一个 `value`，仓库条目盖住全局条目。写入先写临时文件再替换。旧的单文件 `store.json` 会在下次打开时把规则拆到 `config.json`。

## 用法

| 动作 | 入口 |
| --- | --- |
| 打到一半时插入收藏 | `ctrl+shift+k` 或 `/shelf` |
| 打到一半时模糊插入目录 | `ctrl+shift+o` 或 `/shelf dir` |
| 模糊插入文件 | `/shelf file` |
| 新增 | `/shelf add` |
| 改 / 归档 / 恢复 | `/shelf edit`、`/shelf rm`、`/shelf restore` |
| 从本会话按 topic 收集 | `/shelf harvest`，或 `/shelf harvest doi` |
| 自定义 topic | `/shelf topic`：新增、编辑、删除、列出 |
| 动态源 | `/shelf source`：新增、编辑、删除、列出 |
| 把动态结果钉住 | `/shelf pin` |
| 选择提示词，先填变量再插入 | `/shelf prompt` |
| 把输入框里的变量展开 | `/shelf fill` |

`ctrl+shift+k` 会把光标前的词带进筛选框，`/add-dir rel` 再按热键时初始关键字是 `rel`。热键不会清掉已经打的字。`/add-dir ` 后按 `ctrl+shift+o`，模糊选中目录，路径插在光标处。如果光标前已经是 `./src` 这种半截路径，会替掉这一截，不会动 `/add-dir`。

输入框里直接补全，不再弹一层窗口。`alt+/` 和 Tab 都打开同一个补全框，键位对齐 Emacs 的 `M-/`：

- 本地路径用 Pi 自带的补全。`/add-dir ` 后面输入 `./`、`~/` 或带 `/` 的路径，或者按 Tab。`@` 仍然是模糊文件。这块不重写，只是把结果交回原来的补全。
- 收藏也在输入框里补全。光标前的词至少两个字，或以 `@`、`#` 开头，下拉出现标题，选中后替掉这一截并写入收藏的值。路径仍走原来的补全。
- 远程路径用系统 `ssh`。主机要在 `~/.ssh/config` 或 `known_hosts` 里。输入 `cap00:/data/` 或 `user@cap00:rel`，下拉出现在输入框，Tab 或回车写入。目录保留末尾的 `/`，可以继续下一层。连接用 `BatchMode`，不会在输入框里问密码。

筛选是 AND：`@GitHub #cryo-em relion` 表示类别模糊匹配 GitHub、必须带 `cryo-em`、再模糊匹配 `relion`。选中后调用 `pasteToEditor`。

## Agent

工具名 `shelf`。写入都会让用户确认。搜索只返回候选，不代替插入。

提示词模板是普通条目，类别用 `Prompt`。`{{name}}` 展开时输入，`{{name:甲|乙}}` 展开时选择，`{{name=默认}}` 带默认值。同名变量只问一次。另外认 Pi 自带的 `$1`、`${1:-默认}`、`$@`。`/shelf prompt review security` 会把 `security` 填进 `$1`，带引号的一整段算一个参数。没有默认值的 `$1` 和 `{{名字}}` 才弹出来填。`~/.pi/agent/prompts/*.md` 和项目 `.pi/prompts/*.md` 会出现在选择和补全里，不写进收藏；要留下用 `/shelf pin`。

用自然语言让 agent 写模板时，它会调 `add` 并等确认。要从当前对话和这个项目的过往对话总结，它先调 `prompt_context`，再把变化的部分收成变量。

`/shelf harvest` 先按 topic 分组：内置 `github`、`doi`、`arxiv`、`url`，再加上 `/shelf topic` 存的正则。确认方式是并入全部、只收出现≥2 次、或逐条确认（出现≥2 次默认勾选）。没确认不写入。

## 动态源

`/shelf source` 存一条 shell，打开选择器时现算。每行 `标题<TAB>值`。Windows 上先跑 PowerShell，失败再跑 cmd；命令前加 `powershell:`、`cmd:` 或 `bash:` 可以指定。其他系统仍用 bash。结果带 `·dyn`，选中仍然插入；要变成永久记录用 `/shelf pin`。本机绝对路径即使选了仓库，也会改存到全局，不进 `.pi/shelf.json`。

动态命令按你的用户权限跑，不要把不可信字符串存成 source。
