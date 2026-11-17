# 架构：pi provider 如何接入 CloudCLI

## 一、CloudCLI 的 provider 契约

CloudCLI 把每种 agent CLI 抽象成 **7 个 facet**（`server/modules/providers/README.md` 有原始规范）：

| facet | 职责 | 消费方 |
|---|---|---|
| `runtime` | 跑一次会话、abort | `providerRuntimeService` |
| `models` | 模型目录与默认值 | `providerModelsService` |
| `auth` | 安装状态、凭据状态、CLI 版本 | `providerAuthService` |
| `mcp` | 读写 provider 原生 MCP 配置 | `providerMcpService` |
| `skills` | 发现 SKILL.md | `providerSkillsService` |
| `sessions` | 事件归一化 + 历史读取 | `sessionsService` |
| `sessionSynchronizer` | 扫描磁盘会话入库 | `sessionSynchronizerService` |

这 7 个 facet 必须齐全，否则 registry 缺项、UI 会崩。

pi 的实现全在 `server/modules/providers/list/pi/`：

```
pi.provider.ts                    入口，组装 7 个 facet
pi-runtime.provider.ts    (714 行) 核心：spawn pi、解析事件流
pi-sessions.provider.ts   (583 行) 历史读取 + 事件映射
pi-models.provider.ts     (542 行) 动态模型发现 + 可用性探测
pi-session-synchronizer.provider.ts (302 行) 扫描 ~/.pi/agent/sessions
pi-auth.provider.ts       (230 行) 安装/凭据探测
pi-skills.provider.ts     (110 行) 扫描技能目录
pi-mcp.provider.ts         (54 行) 全部 NOT_SUPPORTED（见 README「未做的事」）
```

---

## 二、运行时：一次对话怎么跑起来

pi 没有长驻 server 模式可用（RPC 模式需要改造整个 runtime 契约），所以**每轮对话 spawn 一个进程**：

```
CloudCLI 收到 chat.send
  → providerRuntimeService.getRunner('pi')
  → piRuntime.run(command, options, writer, context)
  → spawn('pi', ['-p', '--mode', 'json', '--session', <id>, '--model', <model>, '--', <prompt>])
  → 读 stdout 的 JSONL 事件流
  → mapPiEventToMessages(每个事件) → writer.send(...)
  → 进程退出 → 发一次 complete
```

### 事件流

pi 的 `--mode json` 输出这些事件（每行一个 JSON）：

| 事件 | 含义 | 映射为 |
|---|---|---|
| `session` | 会话头（含 provider 原生 id） | `session_created` |
| `agent_start` / `turn_start` | 生命周期 | 忽略 |
| `message_start` / `message_end` | 消息边界 | 视角色而定 |
| `message_update` + `assistantMessageEvent.text_delta` | 流式文本 | `stream_delta` |
| `message_update` + `assistantMessageEvent.thinking_delta` | 流式思考 | 聚合后发一条 `thinking` |
| `message_end`（role=assistant, stopReason=error） | 模型错误 | `error` |
| `turn_end` | 一轮结束 | 忽略 |
| `agent_end` / `agent_settled` | run 结束 | 触发收尾 |

**关键约束**：`complete` 必须在整轮里**恰好发一次**。这比看起来难，因为有六条退出路径
（成功、非 0 退出、abort、spawn 失败、超时、模型错误但 exit 0），而且 `error` 和 `close`
事件都会触发。实现用 `completeSent` 标志 + `spawnFailed` 标志 + `releasePiProcess` 三重守卫。

### 为什么每轮一个进程

替代方案是 `pi --mode rpc`（长驻，JSONL 双向）+ 复用会话。没走这条路的原因：

- CloudCLI 的 runtime 契约就是「一次 `run()` 一次 turn」，长驻需要改契约
- 每轮 spawn 的启动开销约 1 秒，可接受
- 每轮进程天然隔离，不会互相污染状态

代价：不支持 `steer`（往进行中的 turn 注入消息），所以 capabilities 里
`supportsSteering: false`。

---

## 三、模型目录：动态发现 + 可用性过滤

这是与上游 PR **差异最大**的部分。上游是静态列表，本归档改成运行时发现。

### 三层结构

```
第 1 层：pi --list-models          → 配置了什么（含用不了的）
第 2 层：parsePiModelListing()     → 把表格解析成 provider/model 列表
第 3 层：filterReachableReferences() → 探测谁真能回答（过滤掉不可达的）
```

### 第 1 层：为什么不能信 `--list-models` 的输出

它的输出是给人看的表格，而且**会夹带非数据行**：

```
provider    model                     context  max-out  thinking  images
anthropic   claude-sonnet-4-5         200K     64K      yes       yes
local-gateway   cn:deepseek-v4.1-flash    1.0M     393.2K   yes       yes
```

无凭据时的输出（**exit 0**）：

```
No models available. Use /login to log into a provider via OAuth or API key. See:
  C:\...\docs\providers.md
```

`No` 和 `models` 两个词都符合"标识符"形状，早期版本把它解析成了模型 `No/models`。

### 第 2 层：解析器的三条判据

```ts
PI_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
PI_MODEL_ID_PATTERN    = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]*$/   // 允许 / 和 ~

// 1. 两列都必须是标识符形状
// 2. provider 不能是表头 "provider"，也不能以 : 结尾（挡 "pi: warning: ..."）
// 3. 后面必须至少有一个数值列（挡 "No models available..."）
if (!rest.some((cell) => /^\d+(?:\.\d+)?[KMG]?$/i.test(cell))) continue
```

模型 id 允许 `/` 很重要：pi 自己的命名是 `openrouter/~anthropic/claude-sonnet-latest`
这种形式。实测 OpenRouter 有 **402 个含 `/` 的模型**，不允许就只剩 1 个。

### 第 3 层：可用性探测

`pi auth check` **不能**用来判断可用性——它只验凭据存在性。实测：

```bash
$ pi auth check --provider anthropic --json
{"status":"ready",...}          # 报 ready

$ pi -p --mode json --model anthropic/claude-opus-5-5 "hi"
"stopReason":"error"            # 但真实请求 403
```

所以改成发一次真实请求，判据是**正面信号**：

```ts
const PI_REACHABILITY_SUCCESS_MARKER = '"stopReason":"stop"';
// exit 0 + 出现该标记 = 可达
```

实测三种情况：成功 → `"stopReason":"stop"`；403 → `"stopReason":"error"`；未知模型 → 无 JSON。

缓存策略：成功 10 分钟，失败 60 秒（失败可能只是网络抖动，不该锁死 10 分钟）。

### 默认模型怎么选

不按字母序取第一个（通常是没凭据的 anthropic），而是：

```
优先：models.json 里用户自配的 provider 的第一个模型
兜底：列表第一个
```

`models.json` 是用户显式配置的，带 baseUrl 和 apiKey，必然是他们想用的。

---

## 四、会话历史：树形分支

pi 的会话文件是**树**，不是线性日志：

```json
{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"hi"}}
{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","stopReason":"error"}}
{"type":"message","id":"a2","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
```

`a1` 和 `a2` 是 `u1` 的两个孩子——重试或 `/tree` 回退会产生这种分叉。

**必须只读活跃分支**，否则失败尝试和成功的重试会同时显示。实现：

```
1. 取文件中最后一条有 id 的条目作为叶子
2. 沿 parentId 往回走到根
3. 按文件中的原始顺序返回这条链
4. 没有 id 的文件（v1 格式）→ 保持文件顺序
5. 遇到环 → 停止（防死循环）
```

实测本机 5 个会话文件：逐条比对后消息数与顺序读取**完全一致**，只少了无 id 的
session header（本就不算消息）。

---

## 五、模型校验的完整决策表

`readCatalogModel()` 是三处共用的判定函数，返回 `listed` / `hidden` / `absent`：

| 情况 | 返回 | 调用方行为 |
|---|---|---|
| 在 `OPTIONS` 里 | `listed` | 用原值 |
| provider 在 `UNREACHABLE_PROVIDERS` 里 | `hidden` | 用原值（探测失败≠模型没了） |
| `CUSTOM_MODELS_ONLY` 且该 id 在 `HIDDEN_BUILT_IN_MODELS` 里 | `hidden` | 用原值（用户主动隐藏的） |
| `CUSTOM_MODELS_ONLY` 但不在隐藏集里 | `absent` | 替换为目录默认 |
| 其他目录缺失 | `absent` | 替换为目录默认 |
| 目录读取抛异常 | `hidden` | 用原值（不阻塞） |

三个调用点：`resolveSessionModel`（显示）、`resolveResumeModel`（续跑）、
`settleRequestedModel`（composer 传来的值）。

**为什么 `UNREACHABLE_PROVIDERS` 是必须的**：目录经过可用性过滤，provider 探测失败时
它的所有模型会从 `OPTIONS` 消失。若不区分，一次网络抖动就会把会话记录的模型永久改写成
别的 provider。

**为什么 `HIDDEN_BUILT_IN_MODELS` 是必须的**：custom-only 模式隐藏内置模型，
但"隐藏"和"删除"在 `OPTIONS` 里看起来一样。没有这个集合，已被 CLI 删除的旧 id
会被当成"用户隐藏的"而一直 replay。

---

## 六、技能发现

pi 扫描四个位置，**优先级按加入顺序**（先加入的赢）：

| 顺序 | 目录 | scope |
|---|---|---|
| 1 | `<agent dir>/skills` | user |
| 2 | `settings.json` 的 `skills` 数组里每个目录 | user |
| 3 | `<workspace>/.pi/skills` | project |
| 4 | `<workspace>/.agents/skills` | project |

`<agent dir>` = `process.env.PI_CODING_AGENT_DIR || ~/.pi/agent`。

**去重按 `realpath`**，不是 `path.resolve`——两个 root 可能链接到同一目录。

**全局请求（不带 workspacePath）不扫任何项目目录**，否则会把服务端仓库自身的
`.agents/skills` 当成用户技能。

---

## 七、前端改动

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `LLMProvider` 加 `'pi'` |
| `src/shared/constants.ts` | MCP/权限/提供者名等 5 个 Record 加 pi 键 |
| `src/shared/selectedProvider.ts` | provider 数组加 pi |
| `src/modules/chat/hooks/useChatProviderState.ts` | pi 的 fallback 模型留空（等后端 DEFAULT） |
| `src/modules/skills/ProviderSkills.tsx` | pi 只读（不支持托管安装） |
| `src/modules/provider-auth/ProviderLoginModal.tsx` | pi 的"登录"改成"设置指引" |
| `src/shared/ui/PiLogo.tsx` | 官方三色标志 |
| `src/modules/chat/hooks/useChatProviderState.ts` | 会话记录模型按目录校验 |

**幂等性要点**：凡是 `Record<LLMProvider, X>` 的地方都必须加 `pi` 键，
否则 TypeScript 会报缺项（这也是最可靠的"漏改检测器"）。
