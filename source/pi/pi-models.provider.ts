import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderModelOption,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel, getPiAgentDir } from '@/shared/utils.js';

/**
 * Fallback catalog used only when `pi --list-models` cannot be read.
 *
 * The live catalog comes from the CLI (see `readInstalledPiModels`), which is
 * what makes a machine's own `models.json` providers — a local gateway, for
 * example — show up in the picker at all. This static list is the last resort
 * for an uninstalled or broken CLI; it deliberately stays small, because every
 * entry here is a model the machine may not have credentials for.
 */
export const PI_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-haiku-3-5', label: 'Claude Haiku 3.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', description: 'Anthropic', effort: { values: [] } },
    { value: 'anthropic/claude-opus-4-1', label: 'Claude Opus 4.1', description: 'Anthropic', effort: { values: [] } },
    { value: 'zai-coding-cn/glm-5.3', label: 'GLM 5.3', description: 'Z.ai Coding CN', effort: { values: [] } },
    { value: 'zai-coding-cn/glm-5.3-flash', label: 'GLM 5.3 Flash', description: 'Z.ai Coding CN', effort: { values: [] } },
    { value: 'zai-coding-cn/glm-5.2', label: 'GLM 5.2', description: 'Z.ai Coding CN', effort: { values: [] } },
    // pi's catalog has no bare `gpt-5.6` — the 5.6 generation ships as
    // luna/sol/terra tiers (sol is the flagship), so only concrete ids are
    // listed. Verified against the pi 0.85.1 model catalog.
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI', effort: { values: [] } },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', description: 'OpenAI', effort: { values: [] } },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI', effort: { values: [] } },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4',
};

/** How long a successful `pi --list-models` reading stays fresh. */
const PI_MODELS_CACHE_TTL_MS = 5 * 60_000;

/** A failed reading is retried sooner, so a just-installed CLI shows up quickly. */
const PI_MODELS_EMPTY_CACHE_TTL_MS = 30_000;

/** `pi --list-models` shells out; a hung one must not hold a picker load open. */
const PI_MODELS_TIMEOUT_MS = 20_000;

/**
 * Reads the models the local pi can actually address, by running its own
 * `pi --list-models`.
 *
 * The output is a fixed-width table whose first column is the provider id and
 * second the model id; this returns their `provider/model` references. The
 * output is treated as untrusted: a line counts only when both columns are
 * present and the header row is skipped, so a warning or a partial write
 * cannot become a phantom model.
 *
 * Writing to a temp file rather than a pipe follows the OpenCode adapter: a
 * pipe is a socket that buffers only a few small writes, and a listing longer
 * than that arrives truncated on a busy host.
 */
export const readInstalledPiModels = async (): Promise<string[]> => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'cloudcli-pi-models-'));
  try {
    const outputPath = path.join(outputDir, 'models.txt');
    const output = openSync(outputPath, 'w');
    let child: ChildProcess;
    try {
      child = spawn('pi', ['--list-models'], { stdio: ['ignore', output, 'ignore'], shell: false });
    } finally {
      // The child holds its own handle on the file.
      closeSync(output);
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve(null);
      }, PI_MODELS_TIMEOUT_MS);
      let settled = false;
      const finish = (code: number | null): void => {
        // The timeout kills the child, whose own `close` follows; only the
        // first outcome is the run's.
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(code);
      };
      child.on('error', () => finish(null));
      child.on('close', finish);
    });

    // A killed or failed run may have written part of a listing, which must not
    // be cached as a complete one.
    if (exitCode !== 0) {
      return [];
    }

    return parsePiModelListing(readFileSync(outputPath, 'utf8'));
  } catch {
    return [];
  } finally {
    removeTempDir(outputDir);
  }
};

/**
 * Shape of a model id in pi's listing.
 *
 * Model ids are identifiers and may contain `/`: pi's own catalog names models
 * as `provider/family-model` (`~anthropic/claude-sonnet-latest`,
 * `deepseek/deepseek-v4-flash`), and a gateway adds `:` (workbuddy's
 * `cn:deepseek-v4.1-flash`). A leading `~` marks pi's alias entries, so it is
 * allowed too. They never contain whitespace, which is what separates columns.
 */
const PI_MODEL_ID_PATTERN = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]*$/;

/** Provider ids are the same shape minus the model-segment characters. */
const PI_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Turns `pi --list-models` output into `provider/model` references.
 *
 * Rows are whitespace-separated with the provider and model in the first two
 * columns. The output is deliberately treated as untrusted — pi prints prose on
 * this stream too:
 *
 * - With no usable credentials pi exits 0 with `No models available. Use
 *   /login …`, whose first two words are shaped like an id pair. Accepting it
 *   would make the picker offer a model called `No/models` and default a new
 *   chat to it.
 * - Warnings arrive as `pi: warning: …`.
 *
 * Requiring the first cell to be a provider id, the second a model id, and at
 * least one numeric sizing column (`context` / `max-out`) rejects both: prose
 * rows carry neither a size nor a two-token id pair.
 */
export const parsePiModelListing = (output: string): string[] => {
  const references: string[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 2) {
      continue;
    }

    const [providerId, modelId, ...rest] = cells;
    if (!PI_PROVIDER_ID_PATTERN.test(providerId) || !PI_MODEL_ID_PATTERN.test(modelId)) {
      continue;
    }
    // The header row is literally `provider model …`; a diagnostic prefixes the
    // provider with a colon (`pi: warning: …`) rather than being one.
    if (providerId === 'provider' || providerId.endsWith(':')) {
      continue;
    }
    // A real row carries numeric sizing columns after the id pair
    // (`1M`, `204.8K`, `128K`). Prose such as the "no models" notice does not.
    if (!rest.some((cell) => /^\d+(?:\.\d+)?[KMG]?$/i.test(cell))) {
      continue;
    }

    const value = `${providerId}/${modelId}`;
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    references.push(value);
  }

  return references;
};

/**
 * Removes a probe's temp directory without ever throwing.
 *
 * On Windows `child.kill()` stops only the `pi.cmd` shim; the node child behind
 * it can still hold the files, so removal races the OS. This runs inside timer
 * and event callbacks, where a throw becomes an uncaught exception and — worse
 * — leaves the promise below unsettled, which would make every later catalog
 * read reuse a promise that never completes.
 */
const removeTempDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leaked temp directory is preferable to a stuck catalog.
  }
};

/** How long a successful verdict stays fresh. */
const PI_REACHABILITY_CACHE_TTL_MS = 10 * 60_000;

/**
 * A failing verdict is retried far sooner than a passing one.
 *
 * The probe can fail for reasons that have nothing to do with the provider —
 * the machine was briefly offline, the gateway was still starting, pi was busy
 * with another run — and caching that failure for the full window would make
 * the provider's models vanish from the picker with no way to bring them back
 * except waiting. A passing verdict is the stable case, so only it earns the
 * long TTL.
 */
const PI_REACHABILITY_FAILURE_TTL_MS = 60_000;

/** One probe sends a trivial prompt; a slow gateway must not hold a load open. */
const PI_REACHABILITY_TIMEOUT_MS = 30_000;

/**
 * What a provider that answered leaves in the probe's event stream.
 *
 * pi finishes a turn with `stopReason: "stop"`; a refused or unknown model
 * finishes it with `"error"` instead. Requiring the positive marker is what
 * separates "answered" from "started up and immediately failed", which the
 * absence of an error marker cannot do — a failed startup writes no
 * `stopReason` line at all.
 */
const PI_REACHABILITY_SUCCESS_MARKER = '"stopReason":"stop"';

/**
 * Whether one provider can actually answer right now, keyed by provider id.
 *
 * `pi --list-models` lists what is *configured*, not what is *reachable*: with
 * an `ANTHROPIC_AUTH_TOKEN` exported, all eighteen anthropic models appear
 * while every request is refused with 403. Probing costs one tiny run per
 * provider (not per model), so the verdict is cached per provider and the
 * picker only ever offers providers proven to answer.
 */
const reachableProviders = new Map<string, { reachable: boolean; expiresAt: number }>();

/** In-flight probes, so concurrent picker loads share one run per provider. */
const pendingReachability = new Map<string, Promise<boolean>>();

const probeProviderReachable = (provider: string, model: string): Promise<boolean> => {
  const cached = reachableProviders.get(provider);
  if (cached && Date.now() < cached.expiresAt) {
    return Promise.resolve(cached.reachable);
  }

  const pending = pendingReachability.get(provider);
  if (pending) {
    return pending;
  }

  const probe = new Promise<boolean>((resolve) => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'cloudcli-pi-reach-'));
    const outputPath = path.join(outputDir, 'probe.jsonl');
    let child: ChildProcess;
    try {
      const output = openSync(outputPath, 'w');
      try {
        child = spawn(
          'pi',
          ['-p', '--mode', 'json', '--no-session', '--no-tools', '--model', `${provider}/${model}`, 'hi'],
          { stdio: ['ignore', output, 'ignore'], shell: false },
        );
      } finally {
        closeSync(output);
      }
    } catch {
      removeTempDir(outputDir);
      resolve(false);
      return;
    }

    // Declared before `finish` because the timeout callback and the child's
    // events both call it, and `finish` clears the timer.
    let timeout: NodeJS.Timeout;
    // A probe can settle more than once — the timeout kills the child and the
    // kill's own `close` event follows — so only the first verdict counts.
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reachableProviders.set(provider, {
        reachable,
        expiresAt: Date.now() + (reachable ? PI_REACHABILITY_CACHE_TTL_MS : PI_REACHABILITY_FAILURE_TTL_MS),
      });
      removeTempDir(outputDir);
      resolve(reachable);
    };

    timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, PI_REACHABILITY_TIMEOUT_MS);

    child.on('error', () => finish(false));
    child.on('close', (code) => {
      // Reachable means "the provider answered", which is a positive signal:
      // the model produced a stopped assistant turn. Absence of an error marker
      // is not enough — a missing credential or an unknown model makes pi exit
      // non-zero having written only a session header (or nothing at all), and
      // both cases contain no `stopReason` line to notice.
      if (code !== 0) {
        finish(false);
        return;
      }
      try {
        const output = readFileSync(outputPath, 'utf8');
        finish(output.includes(PI_REACHABILITY_SUCCESS_MARKER));
      } catch {
        finish(false);
      }
    });
  }).finally(() => {
    pendingReachability.delete(provider);
  });

  pendingReachability.set(provider, probe);
  return probe;
};

/**
 * Drops providers that cannot answer, probing each one at most once per TTL.
 *
 * Keep-alive: a machine where nothing answers keeps the full listing rather
 * than emptying the picker, so the failure is visible and inspectable instead
 * of looking like an unconfigured provider.
 */
const filterReachableReferences = async (
  references: string[],
): Promise<{ references: string[]; unreachableProviders: string[] }> => {
  const byProvider = new Map<string, string[]>();
  for (const reference of references) {
    const provider = reference.slice(0, reference.indexOf('/'));
    const list = byProvider.get(provider);
    if (list) {
      list.push(reference);
    } else {
      byProvider.set(provider, [reference]);
    }
  }

  const verdicts = await Promise.all(
    [...byProvider.entries()].map(async ([provider, providerReferences]) => {
      const firstModel = providerReferences[0].slice(providerReferences[0].indexOf('/') + 1);
      return [provider, await probeProviderReachable(provider, firstModel)] as const;
    }),
  );

  const reachable = new Set(verdicts.filter(([, ok]) => ok).map(([provider]) => provider));
  const unreachableProviders = verdicts.filter(([, ok]) => !ok).map(([provider]) => provider);
  if (reachable.size === 0) {
    // Keep-alive: a machine where nothing answers shows the full list rather
    // than an empty picker, so the failure is inspectable. Every provider is
    // reported unreachable so callers do not treat the withheld list as final.
    return { references, unreachableProviders };
  }

  return {
    references: references.filter((reference) => reachable.has(reference.slice(0, reference.indexOf('/')))),
    unreachableProviders,
  };
};

/**
 * Builds the picker catalog from live model references.
 *
 * Labels keep the model id and the description names the provider, so a
 * machine with several gateways can tell `cn:glm-5.3` (workbuddy) from a
 * same-named model elsewhere. Predefined entries keep their friendlier label.
 */
const createDiscoveredPiModels = (modelReferences: string[]): ProviderModelsDefinition | null => {
  const predefinedByValue = new Map(
    PI_PREDEFINED_MODELS.OPTIONS.map((option) => [option.value, option]),
  );

  const options: ProviderModelOption[] = [];
  for (const value of modelReferences) {
    const predefined = predefinedByValue.get(value);
    if (predefined) {
      options.push(predefined);
      continue;
    }

    const separator = value.indexOf('/');
    const providerId = value.slice(0, separator);
    const modelId = value.slice(separator + 1);
    const predefinedProvider = PREDEFINED_PROVIDER_LABELS.get(providerId);
    options.push({
      value,
      label: modelId,
      description: predefinedProvider ?? providerId,
    });
  }

  return options.length > 0
    ? { OPTIONS: options, DEFAULT: options[0].value }
    : null;
};

/** Display names for the providers the static catalog already knows. */
const PREDEFINED_PROVIDER_LABELS = new Map<string, string>([
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['zai-coding-cn', 'Z.ai Coding CN'],
]);

/**
 * Provider ids the user declared in pi's own `models.json`, which is where a
 * local gateway such as a `workbuddy` entry lives. Those entries carry their
 * own `baseUrl` and `apiKey`, so they are the best default-model candidates.
 *
 * An unreadable or malformed file simply contributes nothing.
 */
const readUserConfiguredPiProviders = async (): Promise<string[]> => {
  const providersPath = path.join(getPiAgentDir(), 'models.json');
  try {
    const parsed = JSON.parse(await readFile(providersPath, 'utf8')) as {
      providers?: Record<string, unknown>;
    };
    return Object.keys(parsed.providers ?? {});
  } catch {
    return [];
  }
};

/** Provider registry model adapter for pi: live CLI catalog, static fallback. */
export class PiProviderModels implements IProviderModels {
  /** Last `pi --list-models` listing and when it stops being fresh. */
  private cachedModelReferences: { references: string[]; expiresAt: number } | null = null;

  /** In-flight CLI read, shared so concurrent picker loads spawn one process. */
  private pendingModelReferences: Promise<string[]> | null = null;

  constructor(
    private readonly readModels = readInstalledPiModels,
    private readonly now: () => number = Date.now,
    private readonly filterReachable = filterReachableReferences,
  ) {}

  private refreshModelReferences(): Promise<string[]> {
    this.pendingModelReferences ??= this.readModels()
      // The picker stays available when the CLI invocation fails.
      .catch(() => [] as string[])
      .then((listed) => {
        // A failed refresh keeps the last good listing, retried on the short
        // schedule, instead of putting the static catalog back in the picker.
        const references = listed.length > 0
          ? listed
          : this.cachedModelReferences?.references ?? [];
        const ttl = listed.length > 0
          ? PI_MODELS_CACHE_TTL_MS
          : PI_MODELS_EMPTY_CACHE_TTL_MS;
        this.cachedModelReferences = { references, expiresAt: this.now() + ttl };
        return references;
      })
      .finally(() => {
        this.pendingModelReferences = null;
      });
    return this.pendingModelReferences;
  }

  /**
   * Serves the cached CLI listing, refreshing it in the background once stale.
   *
   * `pi --list-models` takes a moment and every picker load asks for the
   * catalog, so only the first read after startup waits on the CLI.
   */
  private async readModelReferences(): Promise<string[]> {
    if (!this.cachedModelReferences) {
      return this.refreshModelReferences();
    }
    if (this.now() >= this.cachedModelReferences.expiresAt) {
      void this.refreshModelReferences();
    }
    return this.cachedModelReferences.references;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const filtered = await this.filterReachable(await this.readModelReferences());
    const references = filtered.references;
    const discovered = createDiscoveredPiModels(references);
    // Report the withheld providers so a consumer never reads a missing model as
    // "gone" while its provider merely failed a probe (see the type's comment).
    const unreachable = filtered.unreachableProviders.length > 0
      ? { UNREACHABLE_PROVIDERS: filtered.unreachableProviders }
      : {};
    if (!discovered) {
      return { ...PI_PREDEFINED_MODELS, ...unreachable };
    }

    // The listing is alphabetical by provider, so its first entry can be one
    // this machine cannot actually use (anthropic on a gateway-only setup).
    // A brand-new chat would then fail its first message, so prefer a model
    // from a provider the user configured themselves.
    const preferredProvider = await this.findPreferredProvider(references);
    const defaultModel = preferredProvider
      ? discovered.OPTIONS.find((option) => option.value.startsWith(`${preferredProvider}/`))?.value
      : undefined;

    return {
      ...(defaultModel ? { ...discovered, DEFAULT: defaultModel } : discovered),
      ...unreachable,
    };
  }

  /**
   * The provider a new chat should default to: the first one the user declared
   * in `models.json`, otherwise the first one listed.
   *
   * `pi auth check` is deliberately not consulted here. It answers "is a
   * credential present", not "does it work": an `ANTHROPIC_AUTH_TOKEN` in the
   * server's environment makes anthropic report `ready` while its requests are
   * refused with 403. A provider the user configured in `models.json` is the
   * only signal that is both explicit and backed by a real base URL and key.
   */
  private async findPreferredProvider(references: string[]): Promise<string | null> {
    const listed = [...new Set(references.map((reference) => reference.split('/')[0]))]
      .filter(Boolean);
    if (listed.length === 0) {
      return null;
    }

    const configured = await readUserConfiguredPiProviders().catch(() => [] as string[]);
    const configuredListed = listed.find((provider) => configured.includes(provider));
    return configuredListed ?? listed[0];
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // Phase 1: pi's per-session model lives in the JSONL transcript, which the
    // sessions facet already surfaces; the registry keeps answering with the
    // curated default instead of reading runtime state.
    return buildDefaultProviderCurrentActiveModel(PI_PREDEFINED_MODELS);
  }
}
