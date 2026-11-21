# pi-shelf 0.10.1 模型补全验证

本页记录 0.10.1 的本地验证范围和复现入口。安装或更新 checkout 后，当前 Pi 会话仍需 `/reload` 或重启才能使用新代码。

## 已验证范围

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm test` | 113 tests / 113 pass / 0 fail / 0 skipped / 0 cancelled | 模型、输入上下文、角色桥、标签与原有功能的单元测试 |
| `npm run typecheck` | 通过 | strict + noUncheckedIndexedAccess |
| 开发依赖 Pi TUI 1.2.0 | 36 个断言通过 | 真实 Shelf wrapper 与 Editor，合成模型/角色 |
| Pi TUI 1.6.0 + pi-subagents 0.89.1 handler | 39 个断言通过 | 增加 3 个完整 `/run` handler 回读断言，派发事件被截获 |
| Pi 1.6.0 官方 loader + Editor | 21 个断言通过 | 加载当前扩展、4 个自然语言标签插入示例、6 个源码文件运行前后 SHA-256 一致 |

测试数与 harness 断言数分别统计。标签测试覆盖自然输入 `^`、provider → model → thinking 导航、仅模型与中文 provider、多标签、光标后的内容、`&` 触发字符传递与原始 MCP 候选插入。MCP 使用模拟的下层 provider，模型使用合成注册表。

## 从仓库根复现

依赖已安装后运行：

```sh
npm test
npm run typecheck
npm run test:models
node --experimental-strip-types test/harness/tool-completion.mjs
node --experimental-strip-types test/harness/alias-completion.mjs
```

使用另外安装的 Pi 验证 Editor 与官方加载器时，将占位路径替换为实际包目录：

```sh
node --experimental-strip-types test/harness/model-completion.mjs /path/to/pi-tui
node --experimental-strip-types test/harness/model-loader.mjs /path/to/pi-coding-agent
```

要增加安装版 pi-subagents 的完整 `/run` handler 回读，在运行模型 harness 的进程中设置以下变量。PowerShell 示例：

```powershell
$env:PI_SHELF_SUBAGENTS_ROOT = '/path/to/pi-subagents'
$env:PI_SHELF_HOST_ROOT = '/path/to/pi-coding-agent'
node --experimental-strip-types test/harness/model-completion.mjs "$env:PI_SHELF_HOST_ROOT/node_modules/@earendil-works/pi-tui"
```

harness 只在独立测试进程映射宿主 peer，不向插件目录安装额外依赖。回执包含包版本、Editor 来源、断言数和生成的标签；官方 loader 回执还包含加载路径与源码哈希。

## 验证边界

已核对源码：Pi 的模型目录、触发字符机制，以及固定到 0.89.1 的 pi-subagents 后缀协议与角色查询 projection，详见 [子代理说明](subagent-model-completion.md)。

本地执行：上述测试、真实 Editor 按键、完整 handler 回读与官方 loader 加载。测试使用临时 agent 目录，不读写用户配置，不启动子代理或发送 provider 请求。

未由这些测试证明：当前交互式 Pi 已重载、真实终端显示、真实 MCP 服务可用，以及 provider 最终收到的 reasoning/effort。`^provider/model[:thinking]` 是普通提示词标签，不会自行切换模型或派发子代理。

角色查询不公开完整 modelScope / maxThinking；`/run` 候选标明「角色限制启动时校验」，启动时仍由 pi-subagents 执行策略。外部 CLI 的模型命名空间不在 Pi 模型补全范围内。

原始调查、成功与失败日志保留在本地 `.planning/`，该目录被 Git 忽略，不是运行或复现测试的依赖。历史结果与当前版本分开保存，避免把旧回执当作当前源码的证明。
