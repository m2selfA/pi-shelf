# pi-shelf：同类项目调研与借鉴设计

日期：2026-11-15
范围：pi-shelf（`E:/inter/Documents/Repos/pi-shelf`），Pi 1.2.0 扩展
证据分级：static-confirmed（源码/类型定义）、locally-verified（本机运行测试与探针）、web-confirmed（官方文档/仓库 README）、live-blocked（未注入真实 TUI 按键）

## 1. 结论

1. pi-shelf 的核心竞争力是"上下文感知的输入框补全 + 仓库/全局分层 + 会话收割"，这些在同类项目里没有等价物，应保留并加深。
2. 最该借的是**交互形态**（fzf 式单屏实时筛选与预览）和**内容生态**（导入导出、URL 富化、动态槽位、组合插入），不是再写一套存储或展开引擎。
3. 顺着"合并优先"的原则：能用 Pi 自带的就用 Pi 自带的——`@earendil-works/pi-tui` 已有 `visibleWidth/truncateToWidth`、`SelectList`、`ScrollView`、`fuzzyMatch/fuzzyFilter`；Pi 已有 prompt 模板的 `$1/${1:-}/$@` 展开、项目信任、agent 目录。pi-shelf 只补它没有的那一层。

## 2. 同类项目（web-confirmed，除注明外）

| 项目 | 关键做法 | 可借鉴 | 不借鉴 |
| --- | --- | --- | --- |
| knqyf263/pet（5.4k★） | 参数 `<name=default>`、多候选默认值、`pet new --multiline`、fzf 选择、Gist 同步按 mtime 比较 | 多行录入；参数默认值/候选语义；显式 `sync` 而非后台服务 | 只按 mtime 判新旧会丢编辑，改用内容哈希+三方合并 |
| denisidoro/navi（17.8k★） | `.cheat` 文件：`% tags`、`# 描述`、`$ var: command` 动态候选、变量依赖、`---` 透传 fzf 参数 | **动态槽位**：模板变量由受信命令提供候选，而不是让用户手打 | 运行时执行模板里的任意 shell（安全边界不同） |
| out-of-cheese-error/the-way | JSON import/export、标签/语言过滤、语法高亮、Gist 同步 | 版本化导出/导入；预览区语法高亮 | 全量 DB 迁移式升级 |
| junegunn/fzf（60k★+） | V2 打分：词边界/驼峰/连续匹配加成、gap 惩罚（`algo.go`）；扩展搜索 `'exact`、`^prefix`、`suffix$`、`!neg` | 排序质量；搜索语法 | 自研 matcher（Pi 已带 `fuzzyMatch`） |
| ajeetdsouza/zoxide / atuinsh/atuin | frecency：使用次数按时间衰减；atuin 另有过滤语法与统计 | 用 `uses × 衰减` 排序；`lastUsed` 与 `updated` 分离 | 加密同步（超出单机范围） |
| jarun/buku | 从 URL 抓标题/标签、死链检查（Wayback）、正则/深度搜索、导入导出 | `add <url>` 自动富化；`shelf check` 死链巡检 | 浏览器集成 |
| espanso/espanso（14.8k★） | 变量（date/clipboard/shell/script）、表单字段可由命令输出填充、包管理、同步 | 表单字段的"候选来自命令"；内置变量 `{{date}}` | 系统级键盘钩子 |
| berezovyy/murmo | `;shortcut` 行内展开（退格可撤销）、模板字段 Tab 跳转、`doctor`、项目文件改动需重新批准、插件权限清单 | `doctor`；**项目文件哈希变更后重新确认**；触发式展开 | 多 agent 单一 TOML（会把配置源分叉） |
| IvanNovR/pi-prompt-snippets | prepend/append 分区、`order` 排序、预览、常驻/临时选择、会话首个消息自动应用 | 组合插入与顺序；预览；选择态可见 | 与 pi-shelf 的"架子"模型重复的存储 |
| pedritojr1209/pi-expanded-prompt-snippets | 目录树选择器、`p` 组合预览、文件夹 `main: true` 批量开关、热重载 | 组合预览；目录树（对应 @category 层级） | 过度嵌套的文件夹语义 |
| JosXa/pi-snippets（Pi 生态） | `#tag` 任意位置展开、别名、递归包含（上限 15 次防环）、`<append>/<prepend>/<inject>`、`!`command`` 注入并回显命令 | 递归组合的上限与"回显命令+输出"的可审计性 | `#` 前缀（pi-shelf 已用 `#` 表示标签过滤，冲突） |
| fitchmultz/pi-stash（本机已装） | `mkdir` 原子锁、`randomUUID` 临时文件、读不回就拒绝覆盖、状态栏计数 | 写入串行化与 fail-closed | 重复实现"草稿救援"（已由 pi-stash 负责） |
| indoorvivants/sniper、gethopp/gister、PromptBranch/promptbranch | 片段/提示词库以 MCP 暴露给任意 agent；本地优先 + 版本/历史 | 跨 agent 只读入口（按需 stdio，不常驻） | 再起一个本地 HTTP 服务 |

## 3. 与 pi-shelf 的差距（static-confirmed + locally-verified）

| 层 | 现状（文件:行） | 差距 |
| --- | --- | --- |
| 数据 | `index.ts:66` 写死 `~/.pi/agent`；`store.ts:8-19` 只有类型；`index.ts:181-196` 直接强转 JSON | 目录不可迁移；无校验；坏文件被当空架子并可能被覆盖 |
| 写入 | `index.ts:152-157` 固定 `.tmp`；无锁 | 两个 Pi 窗口并发会互相覆盖 |
| 检索 | `match.ts:38-47` 四级 `fuzzy()`；`match.ts:182-193` 各字段取 min，无字段权重 | 标题命中与正文命中同分；无词边界/连续加成 |
| 展示 | `match.ts:198-227` 用 `String.length` 截断 | 中文按 1 列算，74 字符实际 108 列，选择器换行 |
| 交互 | `index.ts:612-646`：先 `ui.input` 再 `ui.select` | 两段式、无实时筛选、无预览 |
| 模板 | `index.ts:406-408` 对所有插入调用 `applyPositionals` | 普通命令里的 `$1/$@` 被改写（已修） |
| 使用统计 | `index.ts:638-640` 把 `updated` 当"最近使用" | 编辑时间被覆盖 |
| 录入 | `index.ts:651-657` 值用单行 `ui.input` | 多行模板无法录入（已修） |
| 安全 | `index.ts:382-388` 只判断 `isProjectTrusted` | 仓库受信后 `.pi/shelf.json` 变更不再复核 |
| 生态 | 无导出/导入/自检 | 换机、备份、排障都靠手改 JSON（已补） |

## 4. 本轮已落地（locally-verified）

1. **位置参数不再污染普通条目**（`src/template.ts` + `index.ts`）
   - 之前：`awk '{print $1}'` → `awk '{print {{$1}}}'`；`"$@"` → `""`。
   - 现在：默认原样插入；只有 `Prompt`、`prompt-file:`、含 `{{}}` 的模板才展开 `$1/$@`；`$@/$ARGUMENTS` 在无参数时不删除。
   - 探针：`probe5/probe6` 12 组用例；`test/template.test.ts` 新增 1 组；`npm test` 28/28。
2. **跟随 Pi 的 agent 目录**（`index.ts:66`、`promptFileRows`、`promptContextText`）
   - `PI_CODING_AGENT_DIR` 生效；harness 在临时目录验证 store/prompts/sessions 都落在新目录。
3. **原子写 + 跨窗口锁 + 唯一临时名**（`index.ts:152-214`）
   - 固定 `.tmp` 改为 `${path}.${randomUUID()}.tmp`；`withStoreLock` 用 `mkdir` 锁、30s 视为陈旧、4s 超时后放行（不阻塞输入）。
4. **坏文件 fail-closed**（`index.ts:225-260`、`save*`）
   - 解析失败只读为空并记录；写入前 `refuseOverwrite` 抛错；`/shelf doctor` 报 `ERR 损坏文件`。harness 验证：坏 JSON 原样保留，`add` 被拒绝。
5. **CJK 列宽**（`src/match.ts`）
   - `label()` 改为按终端列宽截断；测试用 `visibleWidth` 断言 ≤74 列（此前 74 字符 = 108 列）。
6. **`lastUsed` 与 `updated` 分离**（`src/match.ts` Item + `index.ts` pick）
   - 插入只更新 `lastUsed`，编辑时间保留。
7. **多行模板录入**（`index.ts addFlow`）
   - `Prompt` 类别走 `ui.editor`。
8. **`/shelf export | import | doctor`**（`index.ts`）
   - 导出带 `scope` 字段的 JSON；导入按 value 合并；doctor 列文件、JSON 有效性、信任、remote、条目数、agent 目录。

验证：`npx tsc --noEmit` 通过；`npm test` 28 passed；两个 harness（doctor/选择器/损坏文件）通过。live-blocked：未在真实 TUI 里按键验证视觉换行与选择器交互。

## 5. 下一阶段路线

### P1（收益最大，风险可控）

**P1-1 单屏实时筛选 + 预览（借鉴 fzf / pi-prompt-snippets）—— 已落地 2026-11-15**
- 现状：`askDefault` → `ui.select`（`index.ts:612-646`），标签只有 74 列。
- 实现：`src/picker.ts`：`Input` 实时过滤，`rankRows` 评分，`SelectList` 负责滚动/鼠标/键位（每次键入重建，因为它的 `setFilter` 只做前缀匹配），右侧 `previewText` 展示全文/标签/来源/变量/使用次数。窄于 76 列只显示列表；`ctx.mode !== "tui"` 或 `ui.custom` 抛错时回退两段式。
- 验证：`test/picker.test.ts` 断言 120/100/90/80/70/60/50/30 列都不溢出（右栏固定 44 列，左栏上限 100 列）；harness 驱动 `handleInput` 验证过滤、Enter 插入、Esc 取消、uses/lastUsed 落盘、RPC 回退不调用 `custom`，以及方向键必须触发 requestRender。
- 未验证（live-blocked）：真实终端里的光标位置与按键手感；120 列以上布局只在渲染层验证。

**P1-2 复用 Pi 的模糊匹配（借鉴 fzf V2）—— 已落地 2026-11-15**
- 现状（改前）：`fuzzy()` 只有 4 档，title 与 value 命中同分。
- 实现：`fieldQuality` = `fuzzyMatch` 分数归一到 [-1,1]；字段层 `title 0 / tags 3 / value 6 / category 9`，层距 3 大于质量跨度 2，所以正文里碰巧出现的词永远压不过标题命中；多 token 必须全部命中；`rankRows` 统一排序（分数 → uses → lastUsed → 标题）。
- 数据：探针 `relion` 顺序 `exact(-1.00) → prefix(-0.57) → value(5.43)`；旧实现三者同为 1/2。
- 验收：`test/match.test.ts` 新增两组排序用例；全套 36/36 通过。

**P1-3 扩展搜索语法（借鉴 fzf）—— 已落地 2026-11-15**
- 实现：`parseQuery` 新增 `exact`/`not` 两个集合；`'term`、`^term`、`term$` 进 `exact`，`!term` 进 `not`；`@类`/`#标签` 优先解析，`#!x` 仍是标签。匹配按字段逐条做（不是拼接后的整串），所以 `blurry$` 不会被后面的 category 干扰。
- 语义差异：多个裸词现在是严格的"每个词都要命中"，旧实现按整串模糊匹配；这符合 README 一直宣称的 AND 语义。
- 验收：`test/match.test.ts` 新增 1 组（6 个断言）；全套 36/36 通过。

**P1-4 动态槽位（借鉴 navi / espanso）—— 已落地 2026-11-15**
- 实现：`Rules.values` / `ProjectShelf.values`（`{id, command}`）；`parseSlot` 把 `{{name=@id}}` 解析为 provider 引用；`runProvider` 走 `shellPlan`，4s 超时、stdout 每行一个候选、10s 成功缓存 / 20s 失败缓存；`/shelf value` 增删改查；模板不写内联 shell。
- 门禁：项目 provider 只在 `isProjectTrusted` 且哈希批准时可见（与 sources 同一开关）；provider 找不到或失败时警告并退回手动输入。
- 验证：`test/template.test.ts` 解析用例；harness6 用 `cmd: echo main` 验证候选 `["main","自己输入"]` 与插入 `Deploy main now.`；失败 provider 走手动输入。

**P1-5 多选与组合（借鉴 pi-prompt-snippets / pi-expanded）—— 已落地 2026-11-15**
- 实现：`Item.placement`/`order`；picker `Tab` 标记（✓）、`Enter` 返回全部标记；`composeParts` 按 prepend(0) → 普通(1) → append(2) 排序，order 次之，空行分隔；多条时先开 `ui.editor` 组合预览，用户可改。
- 验证：`test/compose.test.ts` 3 组；`test/picker.test.ts` 的 Tab 用例（含"标记后光标不跳回顶部"回归）；harness7 三条不同 placement 组合成 `style → review → tests`。

**P1-6 URL 富化与死链（借鉴 buku）—— 已落地 2026-11-15**
- 实现：`src/enrich.ts` 的 `enrichTarget`/`enrichUrl`（GitHub JSON、DOI CSL-JSON、arXiv Atom、页面 og:title，HTML 实体解码）与 `checkUrl`（HEAD→GET，5s 超时，401/403/429 记"未判定"）；`/shelf enrich` 写回标题与标签；`/shelf check` 并发 4 路，报告写全局 `diagnostics.json`，`/shelf doctor` 显示摘要。
- 验证：`test/enrich.test.ts` 7 组（全部用注入的 fake fetch，不联网）；harness8 起本机 HTTP 服务做真实请求：`/ok` 200 抓到 `Local & Page`，`/dead` 404 进报告，doctor 显示"失败 1 条"。
- 实测（2026-11-15，本机出网）：`api.github.com/repos/3dem/relion` 200 且抓到 `3dem/relion` + topics；DOI CSL-JSON 返回标题；arXiv Atom 返回 `Attention Is All You Need`；`checkUrl` 对存在的仓库 200、对不存在的仓库 404。`github.com` 的 HTML 在本机被代理挡住（HEAD/GET 皆 10s 超时），所以死链检查对 GitHub 走 API；普通站点超时归类为"未判定"，不误报死链。

**P1-7 项目文件改动复核（借鉴 murmo trust）—— 已落地 2026-11-15**
- 实现：`trust.json` 按**文件绝对路径**记录 `{hash, approvedAt}`（不同 checkout 不互相继承）；TOFU 首次自动记录，之后哈希不一致则 `sources`/`values` 置空并提示一次；`/shelf trust` 列出将被执行的命令，确认后写入新哈希；pi-shelf 自己写文件后同步批准；`/shelf doctor` 显示批准状态。
- 验证：`test/store.test.ts` 的 `trustState` 用例；harness5 在临时 git 仓库里跑通"首次 OK → 改文件 WARN → /shelf trust 后 OK"，trust.json 写入 64 位哈希。

### P2（结构性）

- **P2-1 事务化合并 —— 已落地**：`saveCollection/saveRules/saveProject` 在锁内重读磁盘并 `mergeCollection/mergeProject`（按 id 合并，memory 中归档的条目不复活）；`test/store.test.ts` 4 组用例；harness9 两个并发 `add` 都保留。
- **P2-2 跨 agent 只读入口 —— CLI 已落地，MCP 未做**：`cli.ts` 提供 `list/search/get [--json]`，读同一 `PI_CODING_AGENT_DIR`；写入仍只走扩展。按需 stdio MCP 暂缓（避免新增常驻服务形态）。
- **P2-3 触发式展开 —— 已落地**：`pi.on("input")` + `expandShortcuts`（`;name` / `；name`，标题唯一才展开，行首 slash 命令与 extension 注入跳过，先做 `;` 快速闸门避免每条消息跑 git）；`test/shortcut.test.ts` 5 组；harness10 验证 transform/continue 分支。
- **P2-4 统计与 frecency —— 已落地**：`frecency(uses, lastUsed)` = `uses × exp(-age/30)` 参与排序；`/shelf stats` 输出条目数、归档、用过/没用过、Top 5、死链摘要；`test/match.test.ts` 新增 frecency 用例（旧 10 次 vs 近 2 次）。

## 6. 明确不借鉴

- 不重复实现草稿救援：`pi-stash` 已在本机安装并负责 editor draft。
- 不重写 Pi 的 prompt 模板展开器：Pi 已在输入进入 agent 前展开 `$1/${1:-}/$@`；pi-shelf 只做选择与 `{{}}` 交互填充。
- 不做自定义 editor 组件：维护成本高，且 Murmo 的 Tab 字段跳转收益可用"插入后选中占位符"近似。
- 不引入第二种配置格式（Murmo TOML）：会与 `store.json/config.json/.pi/shelf.json` 形成双源。
- 不常驻本地 HTTP 服务：与"能用现有进程解决就不新增服务"冲突。

## 7. 验收与回滚

每步都要求：`npx tsc --noEmit`、`npm test`、针对改动的最小探针、`git diff --check`。写入类改动先在临时 `PI_CODING_AGENT_DIR` 跑 harness，再在真实目录验证；任何一步失败先回滚到上一提交，不保留半成品。

## 8. 证据清单

- pet：https://github.com/knqyf263/pet
- navi：https://github.com/denisidoro/navi ，语法 https://github.com/denisidoro/navi/blob/master/docs/cheatsheet/syntax/README.md
- the-way：https://github.com/out-of-cheese-error/the-way
- fzf：https://github.com/junegunn/fzf ，算法注释 `src/algo/algo.go`，搜索语法 README「Search syntax」
- zoxide：https://github.com/ajeetdsouza/zoxide
- buku：https://github.com/jarun/buku
- espanso：https://espanso.org/docs/matches/extensions/ 、/forms/ 、/variables/
- murmo：https://github.com/berezovyy/murmo
- pi-prompt-snippets：https://github.com/IvanNovR/pi-prompt-snippets
- pi-expanded-prompt-snippets：https://github.com/pedritojr1209/pi-expanded-prompt-snippets
- pi-snippets：https://github.com/JosXa/pi-snippets
- pi-stash：https://github.com/fitchmultz/pi-stash
- sniper：https://github.com/indoorvivants/sniper ；gister：https://github.com/gethopp/gister ；promptbranch：https://github.com/PromptBranch/promptbranch
- Pi 扩展 API：本机 `node_modules/@earendil-works/pi-coding-agent/docs/{extensions,tui,prompt-templates}.md`；类型 `dist/core/extensions/types.d.ts`


## 9. 工具名补全（2026-11-15）

- 来源：Pi 文档 `packages/coding-agent/docs/extensions.md` 的 `pi.getAllTools()` / `pi.getActiveTools()` 与 Autocomplete Providers 一节；示例 `examples/extensions/github-issue-autocomplete.ts` 的 provider 结构。`ToolInfo` 带 `name`、`description`、`exposure`、`namespace`、`sourceInfo`，所以来源和启用状态都能显示。
- 动态性：每次补全调用 `pi.getAllTools()`，不缓存静态名单；MCP 服务器在会话中途连上后，工具立即进入候选。旧版 Pi 没有该方法时静默退回原行为。
- 插件名：`ToolInfo` 没有包名字段，所以从 `sourceInfo` 推导——`npm:@scope/pkg` 直接解析；本地包读最近的 `package.json`；单文件扩展（source `auto`）退回入口文件名（`search-boost.js` → `search-boost`），避免把所有工具归到 `extensions`。每个工具同时按包名（含 scoped 全名）建别名，因此 `pi-ssh`、`pi-runs`、`pi-codex`、`search-boost` 都能找到对应工具。包名行单独列出（`插件 · N 个工具 · 示例`），选中插入包名；工具行插入工具名。
- 触发：带 `_` / `-` 的 token（`web_`、`mcp__github__`、`web-`）或 `pi-` 开头的插件名自动弹出；其他 token 需要 Tab / `alt+/`。`-` 与 `_` 在匹配时等价（连续分隔符也折叠），所以 `web-` 命中 `web_search`、`pi_ssh` 命中 `pi-ssh-tools`。这样普通句子的 `read`、`write` 不会打断输入。
- 排序：完全相等 → 前缀 → 名字分段前缀（`sear` 命中 `web_search`）→ 子串 → 子序列；同分时启用中的工具优先，再按名字长度和字典序。
- 合并：工具、插件行与收藏是三套候选。token 本身就是某个工具名前缀时工具排前面；token 是插件名前缀时插件行排前面、其工具随后；这两种强命中会独占列表（不再混入正文里碰巧提到这个词的收藏）。弱命中时收藏保持原来的优先级，Pi 原生候选最后。
- 插入：替换 token 并补一个空格，复用 `applyRemoteCompletion`。
- 验证：`test/tools.test.ts` 9 组（token 触发、`pi-` 自动、排除 `/@#`、排序、隐藏工具、包名推导、插件别名、描述）；`test/harness/tool-completion.mjs` 用假 registry 驱动真实 provider，覆盖自动弹出、Tab、插件名/工具名、apply 与 delegate 分支。另用本机真实 `pi.getAllTools()` 导出的 71 个工具做过查询探针：`ssh_` → 10 个 `ssh_*`，`pi-ssh` → `pi-ssh-tools` + 10 个工具，`pi-runs` → 8 个，`pi-fff` → 2 个，`pi-codex` → 2 个，`search-boost` → 5 个。顺带修掉一个旧问题：短 token（≤4 字符）不再对长 prompt 正文做子序列匹配，避免 `zzz` 命中 `summarizer/analyzes/zero`。
