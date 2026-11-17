# CloudCLI pi Provider

English · [简体中文](README.md)

Lets [CloudCLI UI](https://github.com/siteboon/claudecodeui) drive [pi](https://pi.dev) — a fifth
coding agent alongside Claude Code, Codex, Cursor and OpenCode, in the same web UI.

---

## Why this exists

CloudCLI ships four agents. Getting pi in there runs into two hard blockers:

1. **The plugin system cannot add a provider.** Plugins can add tabs and custom backend
   routes; the provider list is a union type hardcoded on both server and client.
2. **The existing implementation does not work on a real machine.** The upstream
   [PR #1324](https://github.com/siteboon/claudecodeui/pull/1324) hardcodes three
   providers (anthropic / openai / zai). If your models come from a self-hosted gateway
   or a third-party relay — any OpenAI-compatible endpoint that pi's `models.json`
   supports — you get three symptoms:
   - pi shows as **not linked** in settings
   - the model picker lists models this machine cannot use
   - the first message of a new chat fails with `No API key found`

This repository is the version that works:

| Capability | What it does |
|---|---|
| Dynamic model discovery | Runs `pi --list-models` and uses what the machine actually offers, instead of a hardcoded list |
| Reachability filtering | Probes which providers really answer, dropping those that report `ready` from `auth check` but return 403 |
| Sensible default model | Prefers the provider you configured in `models.json`, never defaults to one without credentials |
| Correct lifecycle | Stop, resume and error reporting all behave (the original leaves orphaned processes after a Stop) |
| Tree-aware history | pi sessions are trees; abandoned retry/retreat branches are no longer replayed |
| Skill discovery | Scans both `.pi/skills` and `.agents/skills`, without duplicates or omissions |

It also fixes 13 defects in the upstream implementation, each documented in
[`docs/02-pitfalls.md`](docs/02-pitfalls.md).

---

## Usage

### Requirements

- CloudCLI **v1.37.9** (commit `f86543fa`)
- pi installed and working: `pi --version` and `pi -p --mode json "hi"` both succeed
- Node 22+, npm 11

### Install in three minutes

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
git checkout f86543fa

git apply /path/to/cloudcli-pi-provider.patch   # see "Get the patch" below

ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm install-scripts approve better-sqlite3 node-pty sharp esbuild @vscode/ripgrep bcrypt
npm rebuild better-sqlite3 node-pty

npm run build
npm run server
```

Open `http://localhost:3001`. pi appears in the provider list for a new chat.

### Get the patch

```bash
# One-shot full patch
curl -LO https://github.com/nabat-stack/cloudcli-pi-provider/raw/main/patches/pi-provider-full.patch

# Or grab only the parts you care about (11 topic patches, each applies independently)
git clone https://github.com/nabat-stack/cloudcli-pi-provider.git
ls cloudcli-pi-provider/patches/
```

### Verify the install

```bash
# Type checks
npx tsc --noEmit -p server/tsconfig.json
npx tsc --noEmit -p tsconfig.json

# Tests (56)
npx tsx --tsconfig server/tsconfig.json --test \
  "server/modules/providers/list/pi/*.test.ts" \
  server/modules/providers/tests/provider-models.service.test.ts
```

In the UI you should see pi **connected**, a model picker listing **models this machine can
actually reach**, and a first message that gets a reply.

---

## What is in the repository

```
patches/          Patches: full version plus 11 topic splits
source/pi/        Source snapshot of the pi provider (11 files)
docs/             Four documents, read as needed
```

| Document | Read it when |
|---|---|
| [`docs/01-architecture.md`](docs/01-architecture.md) | You want to understand the implementation (7 facets, three-layer model discovery, tree history) |
| [`docs/02-pitfalls.md`](docs/02-pitfalls.md) | Something behaves oddly, or you want to avoid re-stepping on the same traps (16 entries, with repro steps) |
| [`docs/03-development.md`](docs/03-development.md) | You are going to change code (dev loop, tests, what to build next) |
| [`docs/04-environment.md`](docs/04-environment.md) | Windows environment problems (encoding, paths, execution policy, proxy) |

The documents are written in Chinese; the code and commit messages are in English.

---

## Known limitations

- **No MCP support.** pi does support MCP (`pi mcp list` works), but this provider marks the
  MCP facet unsupported. A missing feature, not a bug.
- **Only the `default` permission mode.** pi has no permission prompt mechanism.
- **No steering.** You cannot inject a message into a running turn; each turn is its own process.
- **No prompt template support.** pi's `.pi/prompts/*.md` is a separate resource type that
  CloudCLI has no code for.

---

## License

This repository is a derivative work of [CloudCLI UI](https://github.com/siteboon/claudecodeui)
(AGPL-3.0). `patches/` and `source/` contain upstream code, not only original work by this
repository's author.

The whole repository is licensed under **AGPL-3.0** — see [`LICENSE`](LICENSE). The derivative
relationship and redistribution requirements are in [`NOTICE.md`](NOTICE.md).
