# 继续开发指南

## 一、环境准备

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
git checkout f86543fa
git apply /path/to/cloudcli-pi-provider/patches/pi-provider-full.patch

# Electron 只用于桌面壳，服务与网页不需要它；它的大二进制在部分网络下会下载失败
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install

# npm 11 默认拦截原生模块的 install script
npm install-scripts approve better-sqlite3 node-pty sharp esbuild @vscode/ripgrep bcrypt
npm rebuild better-sqlite3 node-pty

npm run build
```

验证原生模块可用：

```bash
node -e "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('ok')"
node -e "console.log(typeof require('node-pty').spawn)"
```

---

## 二、开发循环

| 场景 | 命令 |
|---|---|
| 只改服务端 + 已有前端产物 | `npm run server` |
| 服务端热重载 | `npm run server:dev` |
| 改了 `src/` | `npm run build:client` 后刷新页面 |
| 全量构建 | `npm run build` |
| 单独类型检查 | `npx tsc --noEmit -p server/tsconfig.json` / `-p tsconfig.json` |

**注意**：`npm run build` 会先跑 `prebuild:server` 删除 `dist-server.next`，
再 `tsc` + `tsc-alias`，最后 `postbuild:server` 提升到 `dist-server`。不要手动改 `dist-server`。

---

## 三、跑测试

```bash
# pi 自己的测试（约 33 个）
npx tsx --tsconfig server/tsconfig.json --test "server/modules/providers/list/pi/*.test.ts"

# provider 服务层与跨 provider 测试
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/providers/tests/provider-models.service.test.ts \
  server/modules/providers/tests/provider-capabilities.service.test.ts \
  server/modules/providers/tests/skills.test.ts \
  server/modules/providers/tests/mcp.test.ts
```

### 已知在 Windows 上失败的测试

| 测试文件 | 失败数 | 原因 |
|---|---|---|
| `pi-facets.test.ts` 的 auth 用例 | 3 | 假 `pi` 是 `#!/bin/sh` 脚本，Windows 无法执行。测试文件自身注明"不在 Windows 运行" |
| `agent-run-registration.test.ts` | 2 | Windows 路径分隔符（`\home\test\project` vs `D:\home\test\project`） |
| `agent.routes.test.ts` | 1 | 同上 |

**这三组在未修改的 v1.37.9 基线上同样失败**，与 pi 无关。要验证这一点：

```bash
git stash push -m tmp -- server/
npx tsx --tsconfig server/tsconfig.json --test <那个测试文件>
git stash pop
```

---

## 四、改模型目录（`pi-models.provider.ts`）

这是最常需要改的文件。三个关键函数：

```
readInstalledPiModels()      执行 pi --list-models，写临时文件后读回
parsePiModelListing(output)  解析表格 → ['provider/model', ...]
filterReachableReferences()  按 provider 探测可用性，返回 { references, unreachableProviders }
```

### 必须遵守的约束

1. **解析器要拒绝非数据行**。真实 pi 会输出 `No models available...` 和 `pi: warning: ...`。
   现有判据：两列都是标识符形状 + provider 不是表头/不以 `:` 结尾 + 至少一个数值列。
2. **模型 id 允许 `/` 和 `~`**。pi 的命名是 `provider/family-model`，别名带前导 `~`。
3. **探测要正面信号**。`"stopReason":"stop"` 才代表可用；"没有 error 标记"不代表成功。
4. **临时目录清理不能抛错**（Windows 文件锁会 `EBUSY`）。
5. **成功/失败缓存 TTL 不同**（10 分钟 / 60 秒）。

### 改完怎么验证

```bash
# 用真实输出核对
OPENROUTER_API_KEY=sk-or-dummy pi --list-models > /tmp/or.txt
# 用解析器跑一遍，确认含 / 的模型没丢

# 空环境（无任何凭据）必须解析出 []，不能是 ['No/models']
```

---

## 五、改运行时（`pi-runtime.provider.ts`）

### 契约

- **恰好一次 `complete`**：六条退出路径都要覆盖
- **abort 不得误删新 run 的进程表条目**：用 `releasePiProcess(key, handle)`
- **`close` 之外要有 `exit` 兜底**：pi 起的后台进程会占着 stdio 管道
- **async 监听器必须包 try/catch**：`EventEmitter` 不观察返回的 Promise

### 加新事件类型

1. 在 `mapPiEventToMessages`（在 `pi-sessions.provider.ts`）里加分支
2. 补测试到 `pi-sessions.provider.test.ts`
3. 确认 `complete` 时序没被破坏

---

## 六、加新 facet 或改契约

CloudCLI 的 provider 契约在 `server/modules/providers/README.md`。
**凡是 `Record<LLMProvider, X>` 的地方都要加 `pi` 键** —— TypeScript 会把它们全部报出来，
这是最可靠的漏改检测器。

已知需要同步的位置：

```
server/shared/types.ts                    LLMProvider
src/shared/types.ts                       LLMProvider
src/shared/constants.ts                   MCP_PROVIDER_NAMES / SCOPES / TRANSPORTS / 权限键
src/shared/selectedProvider.ts            PROVIDERS 数组
src/modules/chat/hooks/useChatProviderState.ts  PROVIDERS / FALLBACK_*
server/modules/providers/provider.registry.ts   注册
server/modules/providers/provider.routes.ts     parseProvider
server/modules/providers/services/provider-cli.service.ts  显示名
server/modules/agent/agent.routes.ts     AGENT_RUN_PROVIDERS
```

---

## 七、接下来可以做的

按价值排序：

### 1. pi 的 MCP 支持（功能缺失，非 bug）

pi 支持 MCP（`pi mcp list --json` 验证过），但 facet 全是 `NOT_SUPPORTED`。

需要：
- 用户级 `~/.pi/agent/mcp.json`、项目级 `.pi/mcp.json` 的读写
- 格式与其他 MCP 客户端一致（`{"mcpServers": {...}}`）
- 改 `pi-mcp.provider.ts`、`src/shared/constants.ts` 的 `MCP_SUPPORTED_SCOPES/TRANSPORTS`

### 2. 探测改用更合适的模型

现在只拿每个 provider 的**第一个**模型探测。若它是 image/classifier 类，整个 provider
会被误判不可达。改进方向：优先选带 `thinking` 或已知是 chat 类型的模型。

### 3. 会话同步器性能

`listSessionTranscripts` 每次 `synchronize` 都 `readdirSync` + `statSync` 整棵树，
`upsertSession` 再 `readFileSync` 整个 transcript —— 全部同步执行在事件循环上。
pi 会话多了会拖慢 `/api/projects`。改进方向：目录级剪枝、按 mtime 提前过滤。

### 4. prompt template 支持

pi 的 `.pi/prompts/*.md` 是独立于 skill 的资源（`/命令` 展开成提示词），
CloudCLI 完全没有处理代码。要做需要：后端加 facet 读 frontmatter、前端加入口、
确认 `/` 命令能正确透传给 pi。

### 5. JSONL 历史读取的 `limit` 收益

`fetchHistory` 每次读整个文件再分页，`limit=20` 没有性能收益。可以改成只读文件尾部。

---

## 八、提交约定

仓库用 commitlint，格式 `type(scope): subject`。scope 用 `pi`。

```
feat(pi): 接入 pi 作为第五个 agent provider
fix(pi): 修正续跑时把失效模型发给 provider 导致 403
```

`lint-staged` 会在 commit 时跑 oxlint，格式不合规会被拦。

---

## 九、调试技巧

### 看 pi 的真实事件流

```bash
pi -p --mode json --no-session --model local-gateway/chat "hi" 2>&1 | head -30
```

### 看会话的树形结构

```bash
python -X utf8 -c "
import json, io
for line in io.open(r'C:/Users/User/.pi/agent/sessions/--D--workspace--/xxx.jsonl', encoding='utf-8'):
    e = json.loads(line)
    print(e.get('type'), e.get('id'), '<-', e.get('parentId'))
"
```

### 看服务进程的环境变量

CloudCLI 终端会全量透传服务进程的 `process.env`。若发现 pi 莫名多出模型，
先查启动服务的那个 shell 里有没有 `ANTHROPIC_*` 之类的变量。
