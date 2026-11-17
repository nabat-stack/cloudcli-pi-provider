# CloudCLI pi Provider

[English](README.en.md) · 简体中文

让 [CloudCLI UI](https://github.com/siteboon/claudecodeui) 能驱动 [pi](https://pi.dev) —— 在同一个网页界面里，
和 Claude Code、Codex、Cursor、OpenCode 并列的第五个 coding agent。

---

## 为什么需要它

CloudCLI 原生只支持 4 个 agent。想让 pi 出现在里面，有两个硬门槛：

1. **CloudCLI 的插件系统加不了 provider**。插件只能挂标签页和自定义后端路由，
   provider 列表是前后端硬编码的联合类型。
2. **上游的实现会让你的机器用不了**。已有的 [PR #1324](https://github.com/siteboon/claudecodeui/pull/1324)
   把模型写死成 anthropic / openai / zai 三家。如果你的模型来自自建网关或第三方中转
   （pi 的 `models.json` 支持的任意 OpenAI 兼容端点），会得到三个症状：
   - 设置页显示 pi「未链接」
   - 模型下拉全是本机用不了的
   - 新会话第一条消息就报 `No API key found`

这个仓库提供的是**能用的版本**：

| 能力 | 说明 |
|---|---|
| 动态模型发现 | 跑 `pi --list-models` 读本机真实可用的模型，不是写死的清单 |
| 可用性过滤 | 探测哪些 provider 真能回答，把 `auth check` 报 ready 但实际 403 的剔除 |
| 默认模型智能选择 | 优先用你 `models.json` 里自配的 provider，不会默认落到没凭据的那家 |
| 完整生命周期 | 停止、续跑、错误上报都正确（原实现停止后新进程会变孤儿） |
| 树形历史 | pi 的会话是树，重试/回退产生的废弃分支不会重复显示 |
| 技能发现 | 同时扫描 `.pi/skills` 和 `.agents/skills`，不重复不遗漏 |

另外修了 13 个上游实现里的缺陷，逐个记录在 [`docs/02-pitfalls.md`](docs/02-pitfalls.md)。

---

## 怎么用

### 前提

- CloudCLI **v1.37.9**（提交 `f86543fa`）
- pi 已安装且能正常对话：`pi --version` 和 `pi -p --mode json "hi"` 都能跑通
- Node 22+、npm 11

### 三分钟安装

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
git checkout f86543fa

git apply /path/to/cloudcli-pi-provider.patch   # 见下方下载方式

ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm install-scripts approve better-sqlite3 node-pty sharp esbuild @vscode/ripgrep bcrypt
npm rebuild better-sqlite3 node-pty

npm run build
npm run server
```

打开 `http://localhost:3001`。pi 会出现在新建会话的 provider 列表里。

### 拿到补丁

```bash
# 一次性完整补丁
curl -LO https://github.com/nabat-stack/cloudcli-pi-provider/raw/main/patches/pi-provider-full.patch

# 或只取你关心的部分（共 11 个主题补丁，可独立应用）
git clone https://github.com/nabat-stack/cloudcli-pi-provider.git
ls cloudcli-pi-provider/patches/
```

### 验证装好了

```bash
# 类型检查
npx tsc --noEmit -p server/tsconfig.json
npx tsc --noEmit -p tsconfig.json

# 测试（56 个）
npx tsx --tsconfig server/tsconfig.json --test \
  "server/modules/providers/list/pi/*.test.ts" \
  server/modules/providers/tests/provider-models.service.test.ts
```

网页里应该看到：pi 显示**已连接**、模型下拉是**你机器上真实可用的那些**、
第一条消息能正常得到回复。

---

## 仓库里有什么

```
patches/          补丁：完整版 + 11 个主题拆分
source/pi/        pi provider 的源码快照（11 个文件）
docs/             四篇文档，按需取用
```

| 文档 | 什么时候看 |
|---|---|
| [`docs/01-architecture.md`](docs/01-architecture.md) | 想理解实现（7 个 facet、三层模型发现、树形历史） |
| [`docs/02-pitfalls.md`](docs/02-pitfalls.md) | 遇到怪问题，或想避免重踩（16 个坑，含复现方法） |
| [`docs/03-development.md`](docs/03-development.md) | 要改代码（开发循环、测试、下一步能做什么） |
| [`docs/04-environment.md`](docs/04-environment.md) | Windows 环境问题（编码、路径、执行策略、代理） |

---

## 已知限制

- **MCP 不支持**。pi 其实支持 MCP（`pi mcp list` 可用），但这个 provider 把 MCP facet
  标为不支持。属于功能缺失，不是 bug。
- **只有 `default` 一种权限模式**。pi 没有权限确认机制。
- **不支持往进行中的对话插话**（steering）。每轮对话是独立进程。
- **prompt template 未支持**。pi 的 `.pi/prompts/*.md` 是独立资源，CloudCLI 没有处理代码。

---

## 许可

本仓库是 [CloudCLI UI](https://github.com/siteboon/claudecodeui) 的衍生作品（AGPL-3.0）。
`patches/` 与 `source/` 包含上游代码，不只是本仓库作者的原创部分。

整体以 **AGPL-3.0** 授权，见 [`LICENSE`](LICENSE)；衍生关系与再分发要求见 [`NOTICE.md`](NOTICE.md)。
