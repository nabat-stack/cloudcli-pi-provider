# 环境相关

本次开发全部在 Windows 上进行，很多问题只在 Windows 复现。这份文档记录环境层面的坑。

## 一、开发环境

| 项 | 值 |
|---|---|
| OS | Windows 11 Pro 10.0.26300 |
| Node | 24.22.3 |
| npm | 11.19.1 |
| pi | 1.5.2 |
| 浏览器 | Vivaldi（Chromium 156）—— 扩展上报为 `chrome` |
| 全局包安装位置 | `C:\Program Files\node-v24.22.3-win-x64\node_modules` |

---

## 二、Electron 二进制下载失败

`npm install` 会在 electron 的 `postinstall` 阶段下载 ~100MB 二进制，网络不佳时：

```
npm error RequestError: read ECONNRESET
npm error path .../node_modules/electron
```

**解决**：跳过它。Electron 只用于桌面壳，服务端与网页都不需要。

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
```

---

## 三、npm 11 拦截原生模块的 install script

```
npm warn install-scripts 10 packages have install scripts not yet covered by allowScripts
```

**解决**：

```bash
npm install-scripts approve better-sqlite3 node-pty sharp esbuild @vscode/ripgrep bcrypt
npm rebuild better-sqlite3 node-pty
```

验证：

```bash
node -e "const D=require('better-sqlite3'); console.log(new D(':memory:').prepare('select 1 as x').get())"
node -e "console.log('pty ok', typeof require('node-pty').spawn)"
```

---

## 四、PowerShell 执行策略阻止 `.ps1`

**现象**：

```
pi : 无法加载文件 ...\pi.ps1，因为在此系统上禁止运行脚本
CategoryInfo : SecurityError
```

**根因**：Windows 客户端版的 `ExecutionPolicy` 出厂默认是 `Restricted`。
npm 全局包会同时生成 `pi`（sh）、`pi.cmd`（cmd）、`pi.ps1`（PowerShell）三份包装，
PowerShell 按 `PATHEXT` 优先匹配 `.ps1`。

**这不是安全检查** —— 执行策略在**读取脚本内容之前**就拒绝，与内容无关。
同一个文件加 `-ExecutionPolicy Bypass` 就能跑。

**解决**：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
```

只写 `HKCU`，不需要管理员权限。`RemoteSigned` = 本地脚本放行、下载的未签名脚本仍拦截。

验证：`powershell -NoProfile -Command "pi --version"` 应输出 `1.5.2`。

**注意**：这不只影响 pi。`cloudcli`、`openspec` 等所有 npm 全局包的 `.ps1` 同样被拦。

---

## 五、CloudCLI 终端只用 PowerShell

`server/modules/websocket/services/shell-websocket.service.ts:650`：

```ts
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
```

写死 PowerShell。所以终端里的 `pi` 一定命中 `.ps1`。

---

## 六、终端继承服务进程的全部环境变量

`shell-websocket.service.ts:662`：

```ts
env: { ...process.env, TERM: 'xterm-256color', ... }
```

**后果**：如果服务是从一个带 `ANTHROPIC_AUTH_TOKEN` 的 shell 启动的，
终端里的 pi 会认为 anthropic 可用，`--list-models` 会列出 18 个实际请求都 403 的模型。

**排查方法**：

```bash
# 干净环境
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL pi --list-models | awk 'NR>1{print $1}' | sort | uniq -c
```

**解决**：从干净环境启动 CloudCLI（普通 CMD/PowerShell 窗口，不是从某个注入了变量的 IDE 终端）。

---

## 七、路径与文件系统

| 陷阱 | 说明 |
|---|---|
| `/tmp` 不存在 | Windows 上没有 `/tmp`。脚本里用项目内路径或 `%TEMP%` |
| `du -sh node_modules` 超时 | 30 万文件遍历太慢。用 Python `os.walk` 累加 |
| `cat -A` 吞 `\r` | Git Bash 的 cat 会隐藏 CR，误判换行符。用 Python 读 bytes |
| 文件锁 `EBUSY` | 刚 kill 的子进程仍持有临时目录，`rmSync` 会失败。加重试或吞掉错误 |
| `path.resolve` 不解链接 | 识别同一文件要用 `realpath` |

---

## 八、编码

| 场景 | 规则 |
|---|---|
| Python 读写文件 | **必须显式 `encoding='utf-8'`**。省略则用 cp936，中文丢字或抛异常 |
| Python 脚本 | 首行 `# -*- coding: utf-8 -*-`，用 `python -X utf8 script.py` |
| `.bat` 文件 | **输出用英文**。`chcp 65001` + 中文 echo 会让 cmd 错位切分命令 |
| `.bat` 换行 | 必须 CRLF。用 Python 转换：`data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')` |
| TS/JS 源码 | UTF-8，注释可以用中文 |

---

## 九、pi 的目录结构（本机实测）

```
~/.pi/agent/
├── auth.json          凭据（本机为空 {}，靠 models.json + 环境变量）
├── settings.json      packages / lastChangelogVersion / 可选 skills 数组
├── models.json        用户自配的 provider（本机的 local-gateway 网关在此）
├── skills/            用户级技能
├── sessions/          会话 JSONL，按 --<cwd 编码>-- 分组
└── mcp.json           MCP 配置（本机不存在，但 pi 支持）

<workspace>/
├── .pi/skills/        项目级技能
├── .pi/prompts/       项目级 prompt template（CloudCLI 未支持）
├── .pi/mcp.json       项目级 MCP
└── .agents/skills/    agentskills.io 兼容目录（pi 也扫描！）
```

**`PI_CODING_AGENT_DIR`** 可以覆盖 `~/.pi/agent`。CloudCLI 已通过
`getPiAgentDir()` 统一识别，改动涉及 models.json、skills、sessions 三处。

---

## 十、pi 的 CLI 速查

```bash
pi --version                          # 1.5.2
pi --list-models [search]             # 列出可用模型（人类可读表格）
pi auth check --provider X --json     # 凭据状态（只验存在性，不验可用性！）
pi auth print-api-key --provider X    # 打印解析后的 key
pi mcp list --json                    # MCP 服务器列表
pi -p --mode json "prompt"            # 一次性执行，输出 JSONL 事件流
pi --mode rpc                         # 长驻，双向 JSONL（CloudCLI 未使用）
pi --help                             # 完整参数

# 关键约束
pi -p 和 --mode json 不展开 /prompt-template
--no-tools 会禁用技能加载（技能段不会出现在 system prompt 里）
```

---

## 十一、验证环境是否正常

```bash
# 1. pi 可用
pi --version

# 2. PowerShell 也能跑
powershell -NoProfile -Command "pi --version"

# 3. 模型列表能出来
pi --list-models | head -5

# 4. 真实对话能跑
pi -p --mode json --no-session "回答两个字：收到" 2>&1 | grep -o '"stopReason":"[a-z]*"' | head -3
# 期望看到 "stopReason":"stop"

# 5. CloudCLI 能启动
npm run server
```
