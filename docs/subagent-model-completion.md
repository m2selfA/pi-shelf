# 子代理 provider / model / thinking 联动补全

pi-shelf 0.10.1 已实现行内联动补全与 `^provider/modelId[:level]` 模型标签。使用现有 Tab / Alt+/ 与下拉列表，生成本次调用的 `provider/modelId:level`；不改 agent 的默认设置。

## 现在如何操作

```text
/run rev
```

按 Tab，原生 `reviewer` 候选仍在；选择额外的 `reviewer · 配置本次模型`，输入变成：

```text
/run reviewer[model=
```

按 Tab 选择 provider 浏览行，例如 `sub2api/`。再按 Tab 选择模型的 `:…` 行，再按 Tab 选择强度。也可在每一阶段继续输入来过滤。最终形如：

```text
/run reviewer[model=provider/modelId:high] 检查当前改动
```

这里 provider/modelId 是格式占位；实际候选来自你的运行中注册表。选择过程中不自动提交命令。只有写完任务并正常提交后，pi-subagents 才会执行。

也可手动输入 `/run reviewer[model=` 从 provider 阶段开始。已有 `model=…` 时只替换它的值，保留 `,output=…`、闭括号和后面的任务。`model=` 内不能加空格，这是安装版 `/run` parser 的约束。

不带后缀的模型行表示“沿用角色有效默认”；明确关闭思考选择 `:off`。完整组合被接受后，后续会在明确模型入口显示最近使用组合；失效模型或不再支持的强度不会作为快捷组合插入。

普通文本可直接输入 `^` 或 `^gpt` 自动打开模型标签候选，逐步选 provider、模型与强度；最终例如 `请让 reviewer 使用 ^provider/modelId:high 检查代码`。`^` 在最终文本中保留；它是精确提示词引用，不自动执行模型切换或子代理调度。普通文本也可使用 `:model:`，生成不带 `^` 的完整模型标识。`:provider:` 只插入 provider 名，`:id:` 只插入模型 ID。`/run` 语法不接受 `--provider` / `--thinking` 作为执行选项，Shelf 不会生成那些 flag。

## 实现与兼容性

`src/model-completion.ts` 是现有 Shelf 补全之外的一层 wrapper。它在模型语境中生成候选，其它位置保留原生及 Shelf 原有补全。每个原生候选保存原始 item / prefix，不把整参数候选按模型 token 的替换范围错误插入。

`src/model-context.ts` 识别实际由 pi-subagents 拥有的 `/run` 命令。`pi.getCommands()` 的 sourceInfo 用于确认命令来源，支持数字 invocation 后缀；不因其它扩展恰好也叫 `/run` 就强套语法。当前对接 npm 安装的 `pi-subagents`。

`src/models.ts` 保留原始 provider/model ID。中文、`@`、多层 `/`、`:free`、`:latest` 不会被误拆。精确目录身份优先于强度解析，最后一个已知模型身份之后的冒号才进入强度选择。

强度按宿主 `reasoning` / `thinkingLevelMap` 筛选，与当前子代理词汇相交。不推理的模型只提供 `off`；`xhigh` / `max` 需要映射显式声明，避免用户选择后宿主默默 clamp。模型 map 可以把规范强度映射成 provider 侧值，候选说明会显示该映射。元数据允许不等于线上请求已验证。

## 复用已安装 pi-subagents 的只读查询

实现没有修改 pi-subagents 安装包。`src/subagent-context.ts` 复用其现有事件桥，发送的唯一动作是：

```ts
{ action: "list", agentScope: "both", options: { capabilities: true } }
```

结果包含角色名称、别名、runner、可执行状态与配置中的模型/强度。查询在同一个 Pi 进程完成，3 秒缓存，共享并发请求；1 秒超时；取消输入请求会立即退出等待；扩展关闭时清理订阅与在途查询。没有子进程、provider 请求、UI 对话或配置写入。

已识别的 external-cli / external-job 与不可执行角色不提供 Pi 模型导航，原生 agent 候选仍保留。外部 CLI 模型命名空间没有纳入本次功能。

**该公开查询不返回完整 modelScope / maxThinking。** 候选明确标「角色限制启动时校验」。底层支持未来的 authoritative `allowedModels` / `maxThinking` 投影，但当前适配器不伪造这些信息。最终 modelScope、强度 ceiling、项目信任与启动权限由 pi-subagents 原有校验决定；策略未知不表示 unrestricted。

## 已核对的子代理协议

通过 GitHub MCP 查看了安装版 `pi-subagents@0.89.1` 对应标签，提交为 `0a23937979e842ac949457d17bfd3a7eab254bb4`。

- [`slash-commands.ts:64`](https://github.com/nicobailon/pi-subagents/blob/0a23937979e842ac949457d17bfd3a7eab254bb4/src/slash/slash-commands.ts#L64) 解析 inline `model`。
- [`slash-commands.ts:657`](https://github.com/nicobailon/pi-subagents/blob/0a23937979e842ac949457d17bfd3a7eab254bb4/src/slash/slash-commands.ts#L657) 注册 `/run` 并把 inline.model 传给 child。
- [`schemas.ts:196`](https://github.com/nicobailon/pi-subagents/blob/0a23937979e842ac949457d17bfd3a7eab254bb4/src/extension/schemas.ts#L196) 表明普通 subagent 调度忽略独立 `thinking` 字段，应使用 model 后缀。
- [`model-info.ts:119`](https://github.com/nicobailon/pi-subagents/blob/0a23937979e842ac949457d17bfd3a7eab254bb4/src/shared/model-info.ts#L119) 解释子代理 admin 的强度列表；无 map 时与 host 的 xhigh 规则不同，因此补全使用更保守的宿主交集。

## 验证范围

[验证说明](model-completion-verification.md) 是测试结果和复现命令的统一入口。它分别记录真实 Editor、安装版完整 `/run` handler 与官方 loader 的验证；不把合成模型测试称为模型请求端到端验证。

## 验证入口

```powershell
npm test
npm run typecheck
npm run test:models
node test/harness/model-completion.mjs '<installed pi-tui root>'
node test/harness/model-loader.mjs '<installed Pi root>'
```

默认测试包含三阶段选择、中文与嵌套模型 ID、模型能力、策略投影单元测试、原生命令范围、quoted flag、取消、TTL 与并发元数据请求。

生产 harness 使用真实 Shelf wrapper 和 Editor，验证 Tab、Enter、Esc、不会自动提交、保留任务和其它 inline 字段。设置 `PI_SHELF_SUBAGENTS_ROOT` 与 `PI_SHELF_HOST_ROOT` 后，还可通过安装包的完整 `/run` handler 回读输出，拦截 bridge dispatch，不启动子代理。独立 Node 运行测试时会按 Pi 的规则映射 host peers，不往插件目录安装重复依赖。

官方 loader harness 验证模块确实由安装版 Pi loader 加载，使用临时 agent 目录和合成 registry。当前交互式 Pi 是否已重载、真实终端显示和模型端最终 reasoning/effort 不由这个测试证明。更新本地 checkout 后仍需 `/reload`。

前期设计探针、原始失败与本轮每次运行日志保留在 `.planning/subagent-completion/`。本地证据目录被 Git 忽略，正式测试脚本在 `test/` 下，随仓库维护。
