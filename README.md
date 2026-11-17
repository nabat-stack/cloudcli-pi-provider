# CloudCLI pi Provider

把 [pi](https://pi.dev)（`@earendil-works/pi-coding-agent`）接成 CloudCLI 的第五个 agent provider。
本目录是这次改动的**完整存档**：补丁 + 源码 + 文档，目标是只看这里就能复现、维护和继续开发。

- 归档日期：2026-11-18
- 基线：`siteboon/claudecodeui` v1.37.9（commit `f86543fa`）
- 产出：77 个文件，+6599 / −449 行，7 个本地提交
- 本机验证环境：Windows 11、Node 24.22.3、pi 1.5.2、Vivaldi（Chromium 156）

> **License**：本仓库是 [CloudCLI UI](https://github.com/siteboon/claudecodeui) 的衍生作品，
> 整体以 **AGPL-3.0** 授权，见 [`LICENSE`](LICENSE)。衍生关系与再分发要求见 [`NOTICE.md`](NOTICE.md)。
> 其中的补丁与 `source/` 快照包含上游代码，不只是本仓库作者的原创部分。

---

## 目录结构

```
cloudcli-pi-provider/
├── README.md                       ← 本文件：总览与复现步骤
├── docs/
│   ├── 01-architecture.md          架构：7 个 facet 与数据流
│   ├── 02-pitfalls.md              踩过的坑：每个 bug 的现象、根因、修法
│   ├── 03-development.md           继续开发：怎么改、怎么测、怎么构建
│   └── 04-environment.md           环境相关：Windows/编码/路径/执行策略
├── patches/
│   ├── pi-provider-full.patch      ← 一次性完整补丁（推荐）
│   └── 01..11-*.patch              按主题拆分，便于阅读
└── source/
    └── pi/                         pi provider 的全部源文件（11 个，约 3600 行）
```

---

## 快速复现

### 方式 A：打完整补丁（推荐）

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
git checkout f86543fa          # v1.37.9，补丁的基线

git apply /path/to/cloudcli-pi-provider/patches/pi-provider-full.patch
```

补丁已验证可在该基线上干净应用（`git apply --check` 退出码 0）。

### 方式 B：按主题逐个应用

11 个拆分补丁可独立应用，适合只关心某一部分的场景：

| 补丁 | 内容 | 行数 |
|---|---|---|
| `01-pi-provider-core.patch` | pi 的 7 个 facet 实现 | 3827 |
| `02-provider-services.patch` | provider 服务层改动 | 306 |
| `03-provider-registry.patch` | 注册表与路由 | 98 |
| `04-server-wiring.patch` | 服务端接线（agent/websocket/index） | 160 |
| `05-database-migration.patch` | provider_models 表的 CHECK 约束迁移 | 297 |
| `06-server-shared.patch` | shared 类型与工具 | 81 |
| `07-frontend-core.patch` | 前端 provider 状态与常量 | 866 |
| `08-frontend-ui.patch` | 设置页/技能页/登录弹窗/图标 | 671 |
| `09-misc.patch` | 零散文件 | 48 |
| `10-provider-tests.patch` | provider 测试 | 1674 |
| `11-misc.patch` | package.json / API 文档 | 1022 |

拆分补丁的改动行数合计 **6370**，与完整补丁一致（已校验）。

### 安装依赖与构建

```bash
# Electron 二进制在部分网络下会失败，但它只用于桌面壳，服务与网页不需要
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install

# npm 11 会拦截原生模块的 install script，需要放行后再编译
npm install-scripts approve better-sqlite3 node-pty sharp esbuild @vscode/ripgrep bcrypt
npm rebuild better-sqlite3 node-pty

npm run build       # 前端 dist/ + 服务端 dist-server/
npm run server      # 或 npm run server:dev 走 tsx 热重载
```

访问 `http://localhost:3001`。

### 验证

```bash
# 服务端与前端类型检查
npx tsc --noEmit -p server/tsconfig.json
npx tsc --noEmit -p tsconfig.json

# pi 相关测试（约 56 个）
npx tsx --tsconfig server/tsconfig.json --test \
  "server/modules/providers/list/pi/*.test.ts" \
  server/modules/providers/tests/provider-models.service.test.ts \
  server/modules/providers/tests/provider-capabilities.service.test.ts \
  server/modules/providers/tests/skills.test.ts
```

---

## 改了什么

### 1. 接入 pi 作为第五个 provider

上游已有一个未合并的 PR（[siteboon/claudecodeui#1324](https://github.com/siteboon/claudecodeui/pull/1324)），
本归档以它为起点，合并到 v1.37.9（该 PR 基线落后 main 106 个提交），并修掉契约漂移。

**5 个文件冲突**在合并时解决：

| 文件 | 处理 |
|---|---|
| `.gitignore`、`server/shared/utils.ts` | 双方新增内容全部保留 |
| `src/shared/types.ts` | `ProviderAuthStatus` 同时保留 `installed` 与 `installedVersion` |
| `AccountContent.tsx` | pi 分支并入 main 新增的订阅覆盖提示与 CLI 版本组件 |
| `agent.routes.ts`、`shell-websocket.service.ts` | 跟随 main 改成 `AGENT_RUN_PROVIDERS` 白名单、统一 catalog 读取、`ShellLaunch` 返回类型 |

**适配 main 演进后的契约**：

- `checkInstalled()` 改为同步返回 `CliVersionProbe`（原 PR 是私有异步版）
- capabilities 补齐 `effortLevels` / `supportsSideQuestions` / `supportsSteering` / `supportsContextClearing`
- provider-cli 显示名、各处测试夹具补 `pi` 键

### 2. 把写死的模型目录改成动态发现

**原实现**：`PI_PREDEFINED_MODELS` 写死 anthropic / openai / zai-coding-cn 三家，
凭据探测也写死问这三家。

**实际机器**：`auth.json` 为空，真正能用的是 `models.json` 里自配的网关（local-gateway）。
于是界面显示"未链接"、模型列表全是用不了的、默认模型落到没有凭据的 anthropic 上，
发第一条消息就 `No API key found`。

**改法**：跑 `pi --list-models` 读本机真实可用的模型，缓存 5 分钟，CLI 读不到才回退静态目录。

### 3. 修复续跑 403

同一会话发第二条消息报 `403 forbidden`。逐行读会话 JSONL 才看清真相：
第一条走 `local-gateway/chat` 成功，后续被换成 `anthropic/claude-sonnet-4-6` 并 403。
pi 自身只有一次 `model_change` —— 是 CloudCLI 每次发送时额外传了 `--model` 覆盖。

两个漏洞叠加：前端让会话行记录的模型无条件压过当前目录；后端把"目录里没有"
一律当成 custom-only 隐藏而放行。

### 4. 换 pi 官方三色标志

原先是自绘的终端提示符（`>_`）。改用 `https://pi.dev/logo-auto.svg` 的三个交错方块。

### 5. 两轮静态审阅发现并修复的 13 个缺陷

详见 [`docs/02-pitfalls.md`](docs/02-pitfalls.md)。其中影响最大的四个：

- **进程表按 key 无脑删除** → 停止后立刻发消息，新 pi 进程被旧 run 的 close 误删，不可停止、继续烧 token
- **历史忽略 `parentId` 树** → 重试/回退产生的分支全被读进来，用户看到重复回答和幽灵报错
- **幽灵模型 `No/models`** → 无凭据时 pi 以 exit 0 输出 `No models available...`，其前两个词被当成模型
- **探测瞬时失败改写会话模型** → 网络抖一下，会话记录的模型被永久改成别的 provider

### 6. 技能页缺 12 个、重复 3 个

pi 除 `.pi/skills` 外还扫描 `.agents/skills`（agentskills.io 兼容布局），CloudCLI 只扫了前者。
重复有三层原因：基类不按文件去重、`path.resolve` 识别不了链接目录、全局请求把服务端 cwd 当项目。

---

## 验证结果

| 项目 | 结果 |
|---|---|
| 前后端 `tsc --noEmit` | 通过 |
| pi + provider 测试 | 56 个通过 |
| 补丁在基线应用 | `git apply --check` 退出码 0 |
| 真实对话 | `只回答两个字：收到` → `收到`，同会话续发无 403 |
| 模型目录 | 20 个 local-gateway 模型，默认 `local-gateway/chat` |
| 技能发现 | 16 个（与 pi 自身清单一致），零重复 |
| 图标 | 三色，与网页 SVG 一致 |

**已知失败的测试**（与本次改动无关，在未修改的基线上同样失败）：

- `server/modules/providers/tests/pi-facets.test.ts` 中 3 个 auth 用例 —— 其假 `pi` 是
  `#!/bin/sh` 脚本，测试文件自身注明"不在 Windows 运行"
- `agent-run-registration.test.ts` 与 `agent.routes.test.ts` 共 3 个 —— Windows 路径分隔符
  （`\home\test\project` vs `D:\home\test\project`）

---

## 未做的事

1. **pi 的 MCP 支持**。实测 `pi mcp list --json` 正常工作，说明 pi 支持 MCP，
   但 facet 被整体标为 `NOT_SUPPORTED`。这是**功能缺失而非 bug**，要做需补完整 adapter。
   相关事实：用户级 `~/.pi/agent/mcp.json`、项目级 `.pi/mcp.json`，格式与其他 MCP 客户端一致。
2. **可用性探测只试每个 provider 的第一个模型**。若它是 image/classifier 类，
   整个 provider 会被误判不可达。
3. **会话同步器每次全树 `readdirSync`**，pi 会话多了会拖慢 `/api/projects`。
4. **prompt template 未支持**。pi 的 `.pi/prompts/*.md` 是独立于 skill 的资源（`/命令` 展开），
   CloudCLI 完全没有处理代码。

---

## 继续阅读

- 想理解实现 → [`docs/01-architecture.md`](docs/01-architecture.md)
- 想知道哪些坑不能再踩 → [`docs/02-pitfalls.md`](docs/02-pitfalls.md)
- 想继续开发 → [`docs/03-development.md`](docs/03-development.md)
- 遇到环境问题 → [`docs/04-environment.md`](docs/04-environment.md)
