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

开发时先装依赖再跑检查：

```bash
npm install        # typescript、@types/node、typebox、pi-coding-agent、pi-tui
npm test           # 单元测试
npm run typecheck  # tsc --noEmit，strict + noUncheckedIndexedAccess
```

已有 Pi 会话安装或更新后，执行 `/reload`，或重启 Pi，扩展才会进入当前会话。

打包约定：Pi 宿主自己提供的包（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox` 等）只能写在 `peerDependencies` 里、范围用 `"*"`，不能写进 `dependencies`。写进 `dependencies` 会被扩展加载器判定为重复运行时模块，启动时打印 `Host-provided extension packages must be declared in peerDependencies` 警告，并且可能在安装树里生成一份和宿主版本不一致的副本。本地开发用的具体版本放在 `devDependencies`。

输入框补全只显示已经保存的收藏和提示词文件，不会因为安装插件自动生成条目；先用 `/shelf add` 保存一条，再输入标题的至少两个字符并按 Tab 或 `alt+/`。

| 文件 | 内容 |
| --- | --- |
| `$PI_CODING_AGENT_DIR/pi-shelf/store.json`（默认 `~/.pi/agent`） | 全局收藏和归档 |
| `$PI_CODING_AGENT_DIR/pi-shelf/config.json` | 全局 topic、动态源与变量 provider，可以单独拷贝 |
| `$PI_CODING_AGENT_DIR/pi-shelf/trust.json` | 项目文件的批准哈希（一个 checkout 一条） |
| `$PI_CODING_AGENT_DIR/pi-shelf/diagnostics.json` | 最近一次 `/shelf check` 的死链报告 |
| `<repo>/.pi/shelf.json` | 当前仓库的收藏、归档和规则，可以提交 |

路径跟随 Pi 的 agent 目录（`PI_CODING_AGENT_DIR`），不是写死的 `~/.pi/agent`；换了 agent 目录仍然是同一个架子。仓库按 `git remote` 认，不按盘符。`git@github.com:owner/repo.git` 和 `https://github.com/owner/repo` 是同一份。文件里的 remote 对不上当前仓库时不读、也不覆盖。同一个 `value`，仓库条目盖住全局条目。写入先写临时文件再替换。旧的单文件 `store.json` 会在下次打开时把规则拆到 `config.json`。

## 用法

| 动作 | 入口 |
| --- | --- |
| 打到一半时插入收藏 | `ctrl+shift+k` 或 `/shelf`（TUI 里是单屏：实时筛选 + 右侧全文预览） |
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
| 变量候选来自命令 | `/shelf value`：模板写 `{{branch=@branches}}` |
| 抓取链接标题/标签 | `/shelf enrich` |
| 检查失效链接 | `/shelf check`，报告写 `diagnostics.json` |
| 批准项目文件 | `/shelf trust`：文件哈希变了以后恢复项目命令 |
| 使用统计 | `/shelf stats`：条目数、从没用过、最常用、死链数 |
| 导出 / 并入条目 | `/shelf export [global\|project] [文件]`、`/shelf import <文件> [global\|project]` |
| 自检 | `/shelf doctor`：文件、JSON、信任、remote、条目数、agent 目录 |

`ctrl+shift+k` 会把光标前的词带进筛选框，直接回车就用它当筛选词，`/add-dir rel` 再按热键时初始关键字是 `rel`。热键不会清掉已经打的字。`/add-dir ` 后按 `ctrl+shift+o`，模糊选中目录，路径插在光标处。如果光标前已经是 `./src` 这种半截路径，会替掉这一截，不会动 `/add-dir`。这两个热键需要终端上报带修饰键的字母（Kitty 键盘协议或 modifyOtherKeys）；老式终端收不到时改用 `/shelf` 和 `/shelf dir`。

选择器里每行仍是单行显示：标签按**终端列宽**截断（中文按两列算），不是按字符数。

输入框里直接补全，不再弹一层窗口。`alt+/` 和 Tab 都打开同一个补全框，键位对齐 Emacs 的 `M-/`：

- 本地路径优先用 Pi 自带的补全。`/add-dir ` 后面输入 `./`、`~/` 或 POSIX 路径，或者按 Tab；Windows 盘符路径（如 `E:/in`）由 pi-shelf 兼容补全并保留目录末尾的 `/`。`/add-dir` 只显示目录，普通路径按大小写不敏感的自然序排列；显式按 Tab 时还支持当前目录内的模糊路径匹配（`/add-dir sr` + Tab 得到 `src/`），点文件需显式输入 `.`。裸词只在按 Tab 时才由 pi-shelf 接管，直接输入时仍交给 Pi。
- 工具名也在输入框里补全，候选来自 Pi 的运行中注册表（`pi.getAllTools()`），不是写死的名单：内置工具、扩展注册的工具、当前已连接的 MCP 工具（如 `web_search`、`web_fetch`）都会出现。只有带 `_` 的片段（`web_`、`mcp__github__`）会自动弹出；`web-`、`pi-ssh` 这类带 `-` 的词和普通单词（`web`、`ssh`）一样，按 Tab/`alt+/` 才查。`-` 和 `_` 在匹配时等价：按补全键后，`web-` 能补出 `web_search`，`pi_ssh` 能找到 `pi-ssh-tools`。
- 插件提供的工具按插件名聚合：工具本身没有包名，pi-shelf 从扩展的来源推导（`npm:@scope/pkg`、本地 checkout 的 `package.json`、单文件扩展的入口文件名），所以按 Tab 输入 `pi-ssh` 时会先给出插件行 `pi-ssh-tools`（10 个工具），下面直接列出 `ssh_upload`、`ssh_bash` 等；输入 `ssh_` 则直接按工具名前缀列出。`search-boost` 这类不是 `pi-` 开头的插件名按 Tab 也能查到。每行显示来源（内置 / MCP 服务器 / 插件名）和是否启用，选中后补全名字并加一个空格。会话中途连上的 MCP 工具也会立即出现，因为候选是每次按键时现查的。
- 收藏也在输入框里补全。`@`、`#` 查询可在输入时触发；普通文本只有按 `Tab`/`Alt+/` 明确请求时才触发 Shelf 查询，避免写普通句子时被候选打断。光标前的词至少两个字，下拉出现标题，选中后替掉这一截并写入收藏的值；同分时优先使用次数多、最近更新的条目。
- 收藏候选排在 Pi 自己的候选前面，不会顶掉它们：`@` 是 Pi 的文件附件前缀，Tab 也是 Pi 的强制文件补全，所以同一截文本里 Pi 的文件/目录候选会接在 Shelf 候选之后一起显示。路径仍走原来的补全。
- 多行收藏值（例如多行提示词模板）插入时按行拆开，光标落在最后一行末尾，编辑器行号、光标上下移动和渲染都保持正常。选择器里每行只占一行：值里的换行折成空格、超长部分截断并加 `…`，多行值另外标 `·4行` 这类行数，长值不会把列表撑开。
- `/shelf` 后按 Tab 可补全动作；`/shelf harvest ` 可补全内置/自定义 topic；`/shelf prompt ` 可补全已发现的提示词名称。
- 行首的其它 slash command（例如 `/remove-dir pi-fabric`）不会触发 Shelf 候选；参数补全交回 Pi 原生 provider。`/shelf` 和 `/add-dir <路径>` 仍由 pi-shelf 提供情景化补全。
- 远程路径用系统 `ssh`。主机要在 `~/.ssh/config` 或 `known_hosts` 里。输入 `cap00:/data/` 或 `user@cap00:rel`，下拉出现在输入框，Tab 或回车写入。目录保留末尾的 `/`，可以继续下一层。连接用 `BatchMode`，不会在输入框里问密码。`主机:数字`（如 `localhost:8080`）按端口处理，不会去连 ssh；确实要补全数字目录时按 Tab。列目录结果缓存 10 秒，失败缓存 20 秒，避免每敲一个字都重连。

筛选是 AND：`@GitHub #cryo-em relion` 表示类别模糊匹配 GitHub、必须带 `cryo-em`、再模糊匹配 `relion`。多个词要求每个词都命中。还认 fzf 的写法：`'精确`、`^开头`、`结尾$`、`!排除`；`@类` 和 `#标签` 优先于这些符号，所以 `#!x` 仍是一个标签。排序先看字段（标题 > 标签 > 正文 > 类别），同一层里用 Pi 自带的 `fuzzyMatch` 算词边界、连续匹配和完全相等，再按 frecency（使用次数 × 30 天衰减）和上次使用时间打破平局。选中后调用 `pasteToEditor`。

TUI 里 `/shelf` 和 `ctrl+shift+k` 打开单屏选择器：顶部输入框实时过滤，左边结果，右边完整条目（全文、标签、来源、变量名、使用次数）。`↑/↓` 选择、`Enter` 插入、`Esc` 取消；终端窄于 76 列时只显示列表。RPC 或没有自定义 UI 的环境自动退回原来的两段式对话框。

`Tab` 可以标记多条，`Enter` 把它们按 `placement`（`prepend` / `append`）和 `order` 排好，中间空一行拼起来，先在编辑器里给一份可改的组合预览，再插入。没有 `order` 的条目按 0 排。

### 变量 provider

`/shelf value` 存一条命令，模板里写 `{{branch=@branches}}`。展开时先跑命令，stdout 每行一个候选，用选择框挑一个；命令失败或没有输出时提示一次并退回手动输入。结果缓存 10 秒，失败缓存 20 秒。仓库里的 provider 和动态源一样，只在 Pi 信任该仓库、且 `.pi/shelf.json` 的哈希与 `trust.json` 一致时执行。

### 项目文件批准

第一次见到 `.pi/shelf.json` 会记下 SHA-256（TOFU）。之后文件内容变了（例如 `git pull` 带来新的动态源），项目里的动态源和 provider 会暂停，并在打开架子时提示一次；`/shelf trust` 会列出将被执行的命令，确认后才恢复。pi-shelf 自己写这个文件时会同步更新批准哈希，不会自己触发警报。

### 链接与死链

`/shelf enrich` 抓 GitHub API、DOI content negotiation、arXiv Atom 或页面的 `og:title`，把标题和标签写回条目；抓不到就保持原样。`/shelf check` 并发 4 路检查所有 http(s) 条目：GitHub/DOI/arXiv 走各自 API（404 才算死链），其余用 HEAD（被拒时 GET）；401/403/429 和超时记为「未判定」而不是死链。报告写进 `diagnostics.json`，不写进仓库文件。

## Agent

工具名 `shelf`。写入都会让用户确认：并入这类新增操作是 Yes/No 且默认 Yes；归档、删除这类破坏性操作把「取消」放在第一项，回车和 Esc 都不会动数据。搜索只返回候选，不代替插入。

普通条目插入时不改一个字节：`awk '{print $1}'`、`for f in "$@"; do …; done` 这类命令里的 `$1`、`$@` 原样保留。只有类别是 `Prompt`、来自 `prompts/` 文件、或含 `{{变量}}` 的模板才按下面的规则展开。写文件前如果 `store.json` / `config.json` / `.pi/shelf.json` 不是有效 JSON，会拒绝覆盖并提示，而不是当成空架子重建；`/shelf doctor` 会把问题列出来。

提示词模板是普通条目，类别用 `Prompt`。`{{name}}` 展开时输入，`{{name:甲|乙}}` 展开时选择，`{{name=默认}}` 带默认值。同名变量只问一次。另外认 Pi 自带的 `$1`、`${1:-默认}`、`$@`。`/shelf prompt review security` 会把 `security` 填进 `$1`，带引号的一整段算一个参数。没有默认值的 `$1` 和 `{{名字}}` 才弹出来填。`~/.pi/agent/prompts/*.md` 和项目 `.pi/prompts/*.md` 会出现在选择和补全里，不写进收藏；要留下用 `/shelf pin`。项目 `.pi/prompts` 只在 Pi 信任当前仓库时读取。

用自然语言让 agent 写模板时，它会调 `add` 并等确认。要从当前对话和这个项目的过往对话总结，它先调 `prompt_context`，再把变化的部分收成变量。

消息里写 `;review` 或 `；review`（全角分号）会在发送前替换成同名条目的 `value`；标题必须唯一，否则原样不动，行首的 slash command 不替换。

只读 CLI（给脚本或其他 agent 用，不写入）：

```bash
node --experimental-strip-types cli.ts list
node --experimental-strip-types cli.ts search relion
node --experimental-strip-types cli.ts get <id|value> --json
```

它读同一个 `PI_CODING_AGENT_DIR`，写入仍然只走扩展里的确认流程。

`/shelf harvest` 先按 topic 分组：内置 `github`、`doi`、`arxiv`、`url`，再加上 `/shelf topic` 存的正则。确认方式是并入全部、只收出现≥2 次、或逐条确认（逐条确认里回车即并入，Esc 或选 No 跳过）。没确认不写入。`topic` 也可以写 `all`，等价于不限定。

## 动态源

`/shelf source` 存一条 shell，打开选择器时现算。每行 `标题<TAB>值`。Windows 上先跑 PowerShell，失败再跑 cmd；命令前加 `powershell:`、`cmd:` 或 `bash:` 可以指定。其他系统仍用 bash。结果带 `·dyn`，选中仍然插入；要变成永久记录用 `/shelf pin`。本机绝对路径即使选了仓库，也会改存到全局，不进 `.pi/shelf.json`。

动态命令按你的用户权限跑，不要把不可信字符串存成 source。仓库自带的 `.pi/shelf.json` 里的 source 只在 Pi 信任当前仓库时执行：未信任时会跳过并提示一次，避免 clone 一个仓库、让 agent 搜一次 shelf 就跑起它自带的命令。`bash:` 走登录 shell，执行前会先 `cd` 回当前工作目录，相对路径按仓库根解析。
