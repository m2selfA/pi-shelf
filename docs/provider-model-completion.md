# Provider / model 输入框补全

pi-shelf 0.10.1 已接入运行时模型补全与自然语言中的 `^` 模型标签。主入口仍是 Tab / Alt+/；模型候选不需要存入 Shelf。当前已配置本地 checkout 的用户更新后执行 `/reload`。

## 用法

| 输入 | 操作与效果 |
| --- | --- |
| `^`、`^gpt`、`^provider/` | 自动查询模型标签；可继续选模型与强度，保留 `^` |
| `用 gpt` | Tab 查询模型；插入精确 `provider/modelId` |
| `:model:` 或 `:model:gpt` | 明确查询完整模型；`:…` 行可以继续选择强度 |
| `:provider:智` | 查询 provider，插入原始 provider 名 |
| `:id:gpt` | 插入裸模型 ID，候选仍显示 provider |
| `provider/` | Tab 只列该 provider 的模型 |
| `provider/modelId:` | Tab 列该模型支持的思考强度 |
| `--provider=…` / `--model=…` | 保留参数名，支持引号与光标后的内容 |

`:model:` / `:provider:` / `:id:` 从 token 开头生效，接受时被移除；`^` 是可见模型标签，接受和逐步导航时保留。标签作为提示词文字发送，不自动改变主会话模型或派发子代理。普通单词仅在主动 Tab / Alt+/ 时查询。模型导航行接受后需再次按 Tab，未承诺自动打开下一阶段。

`/model`、`/login` 和目录命令保留原有语义。其它 slash 参数可在主动补全时获得强模型前缀候选；原生参数候选照常保留，选中时仍用原始 provider / item / prefix 执行插入。

## 实现

- `src/models.ts`：精确身份、Unicode、去重、匹配、思考能力。唯一身份为 `(provider, modelId)`，不能按裸 ID 跨 provider 合并。
- `src/model-context.ts`：命令上下文和 token 的精确替换范围。
- `src/model-completion.ts`：补全 wrapper、候选导航、原生归属、编辑器快照与目录变更检查。
- `index.ts`：接入实时 `ctx.modelRegistry.getAvailable()`、独立频率命名空间、角色上下文查询。

候选读取同步目录快照，不读取密钥、不执行凭据命令、不刷新网络目录。目录可用性不等于本次模型请求已成功。当前实现只补聊天模型；不补 image/classifier，也不把任意 JSON 或任意命令解析为模型协议。

思考规则采用 Pi 1.2 / 1.6 的宿主能力：`reasoning` 为 false 或缺失时只列 `off`；映射为 null 的级别排除；`xhigh` / `max` 需要显式非 null 映射。选择后目录或能力发生改变，会拒绝过期候选并提示重新补全。不会静默降低已选强度。

最近完整组合与 provider 次数使用 `completions.json` 中的 `model-spec:model` / `model-spec:provider` 组，与工具和缩写隔离；仅在最终接受时计数。

## 验证与边界

默认 `npm test` 包含模型身份、能力、三阶段导航、替换范围、原生候选归属、过期候选、quoted flag、取消与角色查询测试。`npm run test:models` 驱动真实 Shelf extension 和 Pi Editor。

`test/harness/model-loader.mjs <Pi package root>` 使用安装版官方 loader 确认新模块可加载。它在临时 agent 目录使用合成注册表，不等于当前交互式进程已经 `/reload`。

[子代理联动说明](subagent-model-completion.md) 记录 `/run` 的格式、role bridge 与未预检策略。前期调查与失败日志保留在 Git 忽略的 `.planning/` 下；历史探针不能替代当前生产实现测试。
