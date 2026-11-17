# 踩过的坑

每个 bug 按「现象 → 根因 → 修法 → 如何验证修复有效」记录。这些坑大多**不会被单元测试发现**，
因为测试的夹具通常比真实环境"干净"。

---

## 一、进程表按 key 无脑删除，导致新 run 不可 abort

**现象**：点停止后立刻发下一条消息，新消息能发出但**停不下来**，pi 进程继续输出、继续烧 token。

**根因**：`abortPiSession` 立刻 `activePiProcesses.delete(sessionId)`，下一条消息随即
`activePiProcesses.set(同 key, 新进程)`。此时**旧进程的 `close` 事件才异步到达**，
它执行 `delete(finalSessionId)` —— 删掉的是**新进程**的条目。

之后 `abortPiSession(sessionId)` 返回 false，新进程成为孤儿。

**修法**：按**实例身份**删除，不按 key。

```ts
function releasePiProcess(key: string, handle: PiProcessHandle): void {
  if (activePiProcesses.get(key) === handle) {
    activePiProcesses.delete(key);
  }
}
```

abort 时遍历所有 key 删掉属于该 handle 的条目（一个 run 可能注册在两个 key 上：
app session id 和 pi 原生 id）。

**如何验证修复有效**：把 `releasePiProcess` 改回无条件删除，测试
`a finishing run releases only the process-table entries it still owns` 会失败
（断言信息 `the replacement must survive the old close`）。

> ⚠️ 这个测试第一次写成了端到端时序测试，**把修复还原后它仍然通过**——说明测试没构造出
> 真实时序。改成直接验证不变式后才有效。写并发相关的测试时，优先测不变式而不是测时序。

---

## 二、abort 被上报成"运行失败"

**现象**：每次手动停止都推送一条 `run failed: Pi CLI exited with code null`；偶尔（pi 把
SIGTERM 转成 0 退出）反而报"已完成"。

**根因**：`notifyTerminalState` 只看退出码。SIGTERM 杀掉进程时 `code === null`，
于是走失败分支。

**修法**：先看 abort 标记，再看退出码。

```ts
if (piProcess?.aborted || pendingEntry.aborted) {
  notifyRunStopped({ ..., stopReason: 'aborted' });
  return;
}
```

与 claude / cursor 的实现对齐（`claude-runtime.provider.ts:1800`）。

---

## 三、error 消息排在 complete 之后

**现象**：pi 未安装时，客户端先收到"本轮结束"，再收到"未安装"的错误行。UI 可能丢弃后者。

**根因**：`close` 处理里先发 `complete`，再 `await isProviderInstalled()` 决定是否发
错误消息。`complete` 之后的任何消息都是"结束后的迟到事件"。

**修法**：把安装判定整个前移，先发 error 再发 complete。

---

## 四、历史读取忽略树形结构，重复回答

**现象**：重试过的会话在 UI 里出现**两份回答**，其中一份是失败的（带幽灵报错）。

**根因**：`pi-sessions.provider.ts` 里 **`parentId` 一次都没用**，纯按文件顺序读。
pi 是树形会话，重试/回退留下的废弃分支也在同一文件里。

**修法**：从最后一条有 id 的条目出发，沿 `parentId` 回溯到根，只返回这条链。

**如何验证**：本机 5 个真实会话文件，逐条比对后消息数与顺序读取**完全一致**
（只少无 id 的 session header）。这说明对线性会话无损失。

---

## 五、幽灵模型 `No/models`

**现象**：无凭据的机器上，模型下拉只有一个叫 `cn:auto` 之外的奇怪模型，选中后报
`Model "No/models" not found`。

**根因**：pi 在无凭据时以 **exit 0** 输出：

```
No models available. Use /login to log into a provider via OAuth or API key. See:
```

前两个词 `No` / `models` 都符合标识符正则，被解析成 provider=`No`、model=`models`。
结果非空 → 走成功缓存路径（5 分钟）→ 成为 DEFAULT。

**修法**：要求行内至少有一个数值尺寸列（`1M` / `204.8K` / `128K`）。

```ts
if (!rest.some((cell) => /^\d+(?:\.\d+)?[KMG]?$/i.test(cell))) continue;
```

**如何验证**：用真实空环境跑 `pi --list-models`，解析结果必须是 `[]`（修复前是 `['No/models']`）。

---

## 六、含 `/` 的模型 id 被整行丢弃

**现象**：配了 OpenRouter 的用户，模型下拉只有 `openrouter/auto` 一个。

**根因**：`PI_MODEL_ID_PATTERN` 不含 `/`，而 pi 的模型 id 是
`openrouter/~anthropic/claude-sonnet-latest` 这种形式。

实测 OpenRouter 有 **442 行，其中 402 行含 `/`** —— 等于丢掉了 401 个模型。

**修法**：正则允许 `/`，并允许前导 `~`（pi 的别名标记）。

```ts
const PI_MODEL_ID_PATTERN = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]*$/;
```

**注意**：所有切分逻辑都用**第一个** `/`（`indexOf('/')`），模型段保留其余部分，
所以不需要改动其他代码。

---

## 七、探测判据错误：把"启动即崩"当成"可用"

**现象**：某个 provider 配置损坏（凭据缺失、模型不存在），它的模型却一直显示为可用，
选中后必然失败。

**根因**：判据是「stdout 不含 `"stopReason":"error"`」。而凭据缺失、模型不存在这两种情况
都是 exit 非 0 且**根本不含** `stopReason` 行，于是被判为"没有错误" = 可用。

**修法**：要求**正面信号**。

```ts
const PI_REACHABILITY_SUCCESS_MARKER = '"stopReason":"stop"';
if (code !== 0) return false;
return output.includes(PI_REACHABILITY_SUCCESS_MARKER);
```

实测：成功 → `stop`；403 → `error`；未知模型 → 无 JSON。

---

## 八、探测瞬时失败导致会话模型被永久改写

**现象**（最隐蔽的一个）：某次续跑后，会话的模型从 `anthropic/claude-opus-4-5`
变成了 `local-gateway/chat`，且**持久化到数据库**，网络恢复后也不回滚。

**根因**：模型目录经过**可用性过滤**。provider 探测失败（60 秒失败缓存期内）→
它的所有模型从 `OPTIONS` 消失 → `readCatalogModel` 判 `absent` →
`resolveResumeModel` 换成目录默认并 `sessions.setSessionModel(...)` 写回。

把「探测失败」当成了「模型已下线」的永久事实。

**修法**：在目录上暴露 `UNREACHABLE_PROVIDERS`，其成员一律判 `hidden` 而非 `absent`。

```ts
const modelProvider = model.slice(0, model.indexOf('/'));
if (modelProvider && catalog.UNREACHABLE_PROVIDERS?.includes(modelProvider)) {
  return 'hidden';
}
```

**关键点**：`mergeProviderModels` 必须透传这个字段，否则合并层会丢掉它——这个陷阱很容易漏。

---

## 九、`CUSTOM_MODELS_ONLY` 下放行一切未知 id

**现象**：开启"只用我的模型"后，已被 CLI 删除的旧模型 id 会一直被 replay，run 直接失败。

**根因**：原判定是「custom-only 模式下，不在 `OPTIONS` 里 = 可能被隐藏 = 放行」。
但对运行时发现的目录（pi/opencode）来说，隐藏的是"CLI 现存集合"，
不代表老 id 仍可解析。

**修法**：目录暴露 `HIDDEN_BUILT_IN_MODELS`（mergo 时从 `predefined.OPTIONS` 算），
只有在这个集合里的才判 `hidden`。

---

## 十、每个 stderr chunk 都触发一次阻塞式探测

**现象**：pi 往 stderr 写几条警告后，整个 Node 服务**卡顿**，CPU 飙高。

**根因**：`stderr.on('data')` 里调 `context.isProviderInstalled()`，而它内部是：

```
probeCliVersion → spawn.sync（阻塞事件循环 5 秒超时）
  + 逐 provider 的 pi auth check（每次 15 秒）
```

pi 写 N 个 chunk 就并发发起 N 次完整探测。

**修法**：每次 run 只探一次并复用结果。

```ts
let installVerdict: Promise<boolean> | null = null;
const isInstalledOnce = () => (installVerdict ??= context.isProviderInstalled().catch(() => true));
```

---

## 十一、探测的 `rmSync` 抛错让 promise 永挂

**现象**：偶发地，模型下拉一直转圈，**所有后续目录加载都卡死**，只能重启服务。

**根因**：`finish()` 在定时器回调里调 `rmSync`（不在 Promise executor 内）。
Windows 上 `child.kill()` 只终止 `pi.cmd` 垫片，其子进程仍持有文件 → `EBUSY` →
抛出即是未捕获异常，且 `resolve()` 执行不到 → `pendingReachability` 里的这个
promise **永不完成**，后续所有调用复用它。

**修法**：清理改为永不抛错的 best effort。

```ts
const removeTempDir = (dir: string): void => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 泄漏目录好过卡死 */ }
};
```

---

## 十二、技能页缺 12 个、重复 3 个

**现象**：pi 自己发现 16 个技能，页面只显示 4 个，其中 3 个各有两份。

**根因三层**：

1. **缺 `.agents/skills`**：pi 除 `.pi/skills` 外还扫这个兼容目录（agentskills.io 布局），
   用户的 openspec 技能全在那
2. **基类不按文件去重**：两个 root 指向同一批文件时，同一 SKILL.md 被列多次
3. **`path.resolve` 识别不了链接目录**：两个 root 链接到同一目录时路径字符串不同

**修法**：

- 补 `.agents/skills` root
- 基类 `listSkills` 加 `seenSkillPaths` 去重
- 去重键用 `realpath` 而非 `path.resolve`

**如何验证**：做一个指向同一目录的 junction，测试
`listSkills lists a skill once even when two roots reach the same file`。
用 `path.resolve` 版本会失败。

---

## 十三、全局请求把服务端仓库当成项目

**现象**：技能页出现 `backend-module-standards`、`frontend-module-standards` ——
这是 CloudCLI 仓库自己的开发规范。

**根因**：前端先发一次**不带 workspacePath** 的请求（全局视图），后端
`resolveWorkspacePath(undefined)` 回落到 `process.cwd()`，也就是 CloudCLI 的安装目录。

**修法**：区分「调用方指定了工作区」与「回落到 cwd」，只有前者才追加项目 root。

```ts
const requestedWorkspace = options?.workspacePath;
const sources = await this.getSkillSources(workspacePath, Boolean(requestedWorkspace));
```

---

## 十四、跑 Python/Shell 时的 Windows 陷阱

这些不是代码 bug，但会浪费大量时间：

| 陷阱 | 后果 | 正确做法 |
|---|---|---|
| `/tmp/x` 路径 | Windows 上不存在，脚本静默失败 | 用项目内的临时路径 |
| 省略 `encoding='utf-8'` | 中文变 cp936 乱码或直接抛异常 | 显式指定 |
| Python 里写 `'\\n'` 生成 JS 源码 | 产生真实换行，TS 报 Unterminated string | 用 `'\\\\n'` 或改用 Edit 工具 |
| `cat -A` 看 CRLF | Git Bash 吞掉 `\r`，误判为 LF | 用 Python 读 bytes 数 `\r\n` |
| `du -sh node_modules` | 30 万文件遍历超时 | 用 Python `os.walk` 累加 |

---

## 十五、`.bat` 里的中文输出会破坏命令解析

**现象**：脚本打印 `'l' is not recognized as an internal or external command`。

**根因**：`chcp 65001` + 中文 `echo`。cmd 在 UTF-8 代码页下解析多字节字符时，
全角逗号 `，` 被错位切分成命令边界，后半句被当成独立命令执行。

**修法**：**去掉 `chcp 65001`，所有 `echo` 输出改英文**。中文注释可以保留（注释不参与解析）。

---

## 十六、测试通过 ≠ 测试有效

这轮审阅里有一条测试**把修复还原后仍然通过**（第 1 节的进程表测试）。教训：

1. 写完测试后，**故意把修复改回错误版本**，确认测试失败
2. 时序类问题优先测**不变式**而不是测时序
3. 夹具的目录/模型列表要包含被测的值，否则测试会退化成在测别的东西
