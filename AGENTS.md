# pi-shelf

Pi 的 TypeScript 扩展：搜索收藏、提示词、工具和模型，把选择结果插入输入框；补全不提交消息。

## 开发与检查

- 从仓库根运行 `npm ci`、`npm test`、`npm run typecheck`。
- `npm run test:models` 驱动真实 Pi Editor；宿主 loader 与子代理 handler 检查见 `docs/model-completion-verification.md`。
- 开发加载：`pi --extension ./index.ts`；更新已安装 checkout 后需 `/reload` 或重启 Pi。
- 保持 ESM、显式 `.ts` import、strict 与 noUncheckedIndexedAccess，不新增编译产物。
- 宿主包只放 wildcard `peerDependencies`，开发版本放 `devDependencies`，不复制运行时依赖。

## 目录与边界

- `index.ts` 注册命令、工具和补全；纯数据与匹配逻辑放 `src/`，测试放 `test/`。
- `src/model-completion.ts` 包装已有 provider；原生候选必须保留原始 item、prefix 和 apply 归属。
- 模型候选来自 `ctx.modelRegistry`；保留 provider/model ID 原值与 Unicode，按元数据筛选强度。
- `^provider/model[:thinking]` 是普通提示词标签；`/run` 使用 `agent[model=provider/model:thinking]`。
- 角色限制未知时不得视为允许；安装版 pi-subagents 的公开查询不含完整 modelScope/maxThinking。
- 全局数据位于 `PI_CODING_AGENT_DIR/pi-shelf`；项目数据为 `.pi/shelf.json`。遵守确认、项目信任与文件哈希批准。
- 测试使用临时 agent 目录；不要改写用户配置或安装包，不为补全发起 provider 请求。
- `.planning/` 是忽略的本地调查与原始日志，不作为克隆后必需文件；保留失败记录，不批量删除。

## 文档

- 当前操作以 `README.md` 为入口；实现边界与验证命令在 `docs/`。
- `docs/borrowed-features.md` 是历史调研，不能把其中旧行号或测试数当作现状。
- 模块加载、真实 Editor、交互式会话重载和真实模型请求属于不同验证层，不互相代替。
