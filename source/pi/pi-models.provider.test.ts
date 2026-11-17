import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PiProviderModels,
  PI_PREDEFINED_MODELS,
  parsePiModelListing,
} from './pi-models.provider.js';

test('parsePiModelListing keeps provider/model references and drops the header', () => {
  const output = [
    'provider   model                   context  max-out  thinking  images',
    'anthropic  claude-sonnet-4-5       200K     64K      yes       yes   ',
    'workbuddy  cn:deepseek-v4.1-flash  1.0M     393.2K   yes       yes   ',
    '',
    'pi: warning: something went wrong',
    '   truncated',
  ].join('\r\n');

  assert.deepEqual(parsePiModelListing(output), [
    'anthropic/claude-sonnet-4-5',
    // A gateway model id keeps its colon and dot verbatim.
    'workbuddy/cn:deepseek-v4.1-flash',
  ]);
});

test('parsePiModelListing deduplicates repeated references', () => {
  const output = 'workbuddy  cn:auto  1M\nworkbuddy  cn:auto  1M\n';
  assert.deepEqual(parsePiModelListing(output), ['workbuddy/cn:auto']);
});

test('parsePiModelListing returns nothing for empty or malformed output', () => {
  assert.deepEqual(parsePiModelListing(''), []);
  assert.deepEqual(parsePiModelListing('onlyonecolumn\n'), []);
  assert.deepEqual(parsePiModelListing('provider  model  context\n'), []);
});

/** A catalog adapter over a fixed listing, so no CLI is spawned. */
const createModels = (references: string[], unreachableProviders: string[] = []) => new PiProviderModels(
  async () => references,
  () => Date.now(),
  // Reachability is a real CLI run; these tests cover catalog assembly, so
  // they pass references through untouched.
  async (listed) => ({ references: listed, unreachableProviders }),
);

test('getSupportedModels builds the catalog from the live listing', async () => {
  const models = createModels([
    'workbuddy/cn:auto',
    'workbuddy/cn:glm-5.3',
  ]);

  const catalog = await models.getSupportedModels();
  assert.equal(catalog.OPTIONS.length, 2);
  assert.deepEqual(catalog.OPTIONS[0], {
    value: 'workbuddy/cn:auto',
    label: 'cn:auto',
    description: 'workbuddy',
  });
  // A gateway-only machine defaults to its own first model.
  assert.equal(catalog.DEFAULT, 'workbuddy/cn:auto');
});

test('getSupportedModels keeps predefined labels for known models', async () => {
  const models = createModels([
    'anthropic/claude-sonnet-4',
    'workbuddy/cn:auto',
  ]);

  const catalog = await models.getSupportedModels();
  const predefined = PI_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'anthropic/claude-sonnet-4');
  assert.deepEqual(catalog.OPTIONS[0], predefined);
});

test('getSupportedModels prefers the provider the user configured in models.json', async () => {
  // `pi auth check` cannot be trusted here: it reports anthropic ready whenever
  // an ANTHROPIC_AUTH_TOKEN is in the environment, even when its requests are
  // refused. The user's own models.json provider is the reliable signal.
  const models = createModels([
    'anthropic/claude-sonnet-4',
    'workbuddy/cn:auto',
    'workbuddy/cn:glm-5.3',
  ]);

  const catalog = await models.getSupportedModels();
  assert.match(catalog.DEFAULT, /^workbuddy\//);
});

test('getSupportedModels falls back to the static catalog when the CLI cannot be read', async () => {
  const models = createModels([]);

  const catalog = await models.getSupportedModels();
  assert.deepEqual(catalog, PI_PREDEFINED_MODELS);
});

test('parsePiModelListing rejects diagnostic lines that look like two columns', () => {
  // pi prints warnings to the same stream; `pi: warning: …` would otherwise
  // read as provider `pi:` with model `warning:`.
  assert.deepEqual(parsePiModelListing('pi: warning: no config\n'), []);
});

test('parsePiModelListing rejects the "no models available" notice', () => {
  // pi exits 0 and prints this when no provider has usable credentials. Its
  // first two words look like an id pair, so it must be rejected explicitly.
  const output = [
    'No models available. Use /login to log into a provider via OAuth or API key. See:',
    '  C:/pi/docs/providers.md',
    '  C:/pi/docs/models.md',
  ].join('\n');

  assert.deepEqual(parsePiModelListing(output), []);
});

test('parsePiModelListing keeps model ids that contain a slash', () => {
  // pi's own catalog names models `provider/family-model`; dropping them would
  // hide almost every OpenRouter/HuggingFace entry from the picker.
  const output = [
    'provider    model                                 context  max-out  thinking  images',
    'openrouter  ~anthropic/claude-sonnet-latest       1M       128K     yes       yes',
    'openrouter  deepseek/deepseek-v4-flash            1.0M     943.7K   yes       yes',
  ].join('\n');

  assert.deepEqual(parsePiModelListing(output), [
    'openrouter/~anthropic/claude-sonnet-latest',
    'openrouter/deepseek/deepseek-v4-flash',
  ]);
});

test('parsePiModelListing keeps gateway ids that use a colon', () => {
  const output = 'workbuddy  cn:deepseek-v4.1-flash  1.0M  393.2K  yes  yes';
  assert.deepEqual(parsePiModelListing(output), ['workbuddy/cn:deepseek-v4.1-flash']);
});
