import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake machine: four CLIs that answer like the real ones, no network, and
// a state folder of its own.
const root = mkdtempSync(join(tmpdir(), 'agent-scout-scan-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, 'bin');
const homes = {
  claude: join(root, 'claude'), codex: join(root, 'codex'),
  opencode: join(root, 'config'), antigravity: join(root, 'gemini'),
};
for (const d of [bin, ...Object.values(homes)]) mkdirSync(d, { recursive: true });
const codexRows = join(root, 'codex-rows.json');

const script = (name, body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
script('claude', `case "$1" in
  --version) echo "2.1.327 (Claude Code)";;
  auth) echo '{"loggedIn":true}';;
esac`);
script('codex', `case "$1" in
  --version) echo "codex-cli 0.170.0";;
  login) echo "Logged in using ChatGPT";;
  debug) cat '${codexRows}';;
  *) exit 1;;
esac`);
script('opencode', `case "$1" in
  --version) echo "2.3.2";;
  auth) echo '[]';;
  models) printf 'opencode/beam-free\\nopencode/big-pickle\\n';;
esac`);
script('agy', `case "$1" in
  --version) echo "1.5.11";;
  models) printf 'Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n';;
esac`);
writeFileSync(join(homes.claude, '.claude.json'), JSON.stringify({ model: 'claude-opus-5-5' }));
writeFileSync(join(homes.codex, 'config.toml'), 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n');
const rows = (...slugs) => JSON.stringify({ models: slugs.map((slug) => ({
  slug, display_name: slug.toUpperCase(), default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
})) });
writeFileSync(codexRows, rows('gpt-6-sol', 'gpt-6-luna', 'codex-auto-review'));

const options = (extra = {}) => ({
  path: bin, env: { PATH: `${bin}:/usr/bin:/bin` }, homes, offline: true,
  stateDir: join(root, 'state'), antigravityAcpDir: join(root, 'no-acp'), ...extra,
});

test('scan lists every CLI with its models in the documented shape', async () => {
  const { scan } = await import('../src/index.js');
  const result = await scan(options());
  assert.ok(!Number.isNaN(Date.parse(result.scannedAt)));
  assert.deepEqual(result.newModels, [], 'the first look only records what is there');
  const by = Object.fromEntries(result.clis.map((c) => [c.id, c]));
  for (const id of ['claude', 'codex', 'opencode', 'antigravity', 'gemini', 'devin', 'grok', 'cursor', 'pi', 'kimi']) {
    assert.ok(by[id], `${id} is listed`);
  }
  for (const c of result.clis) {
    for (const key of ['id', 'label', 'installed', 'path', 'version', 'signedIn', 'defaultModel', 'models', 'modelSource', 'error']) {
      assert.ok(Object.hasOwn(c, key), `${c.id}.${key}`);
    }
  }
  assert.deepEqual(
    [by.codex.installed, by.codex.path, by.codex.version, by.codex.signedIn, by.codex.defaultModel, by.codex.modelSource, by.codex.error],
    [true, join(bin, 'codex'), '0.170.0', true, 'gpt-6-sol', 'codex debug models', null],
  );
  assert.deepEqual(by.codex.models, [
    { id: 'gpt-6-sol', label: 'GPT-6-SOL', default: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'high', images: true, new: false },
    { id: 'gpt-6-luna', label: 'GPT-6-LUNA', default: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'high', images: true, new: false },
  ], 'hidden review models are left out');

  assert.equal(by.claude.signedIn, true);
  assert.equal(by.claude.defaultModel, 'claude-opus-5-5');
  assert.ok(by.claude.models.some((m) => m.id === 'claude-opus-5-5' && m.default));
  assert.match(by.claude.modelSource, /Claude config/);

  assert.deepEqual(by.opencode.models.map((m) => m.id), ['opencode/beam-free', 'opencode/big-pickle']);
  assert.equal(by.opencode.signedIn, null, 'opencode cannot say');

  assert.equal(by.antigravity.label, 'Antigravity CLI');
  assert.deepEqual(by.antigravity.aliases, ['agy']);
  assert.equal(by.antigravity.signedIn, true);
  assert.deepEqual(by.antigravity.models.map((m) => [m.id, m.label, m.efforts]), [['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', ['low', 'medium', 'high', 'max']]]);

  assert.deepEqual([by.gemini.installed, by.gemini.path, by.gemini.models, by.gemini.signedIn, by.gemini.error], [false, null, [], null, null]);
});

test('a model released after the last scan is marked new, listed once, and then known', async () => {
  const { scan, newModels } = await import('../src/index.js');
  writeFileSync(codexRows, rows('gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol'));
  const result = await scan(options({ clis: 'codex,agy', refresh: true }));
  assert.deepEqual(result.clis.map((c) => c.id), ['codex', 'antigravity']);
  assert.deepEqual(result.newModels, [{ cli: 'codex', id: 'gpt-6.1-sol', label: 'GPT-6.1-SOL', successor: true }]);
  const codex = result.clis.find((c) => c.id === 'codex');
  assert.deepEqual(codex.models.filter((m) => m.new).map((m) => m.id), ['gpt-6.1-sol']);

  assert.deepEqual(await newModels(options({ clis: 'codex', refresh: true })), [], 'seen now');
  writeFileSync(codexRows, rows('gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5-sol'));
  assert.deepEqual(await newModels(options({ clis: 'codex', refresh: true })),
    [{ cli: 'codex', id: 'gpt-5-sol', label: 'GPT-5-SOL', successor: false }], 'new to this machine, but not a newer release');
});

test('listModels answers for one CLI by id or alias', async () => {
  const { listModels } = await import('../src/index.js');
  const list = await listModels('agy', { home: homes.antigravity, bin: join(bin, 'agy'), offline: true, stateDir: join(root, 'state') });
  assert.equal(list.cli, 'antigravity');
  assert.deepEqual(list.models.map((m) => m.id), ['gemini-3.8-flash-high']);
  assert.equal(list.modelSource, 'agy models');
  await assert.rejects(listModels('nope'), /unknown CLI/);
});

// ------------------------------------------------------------ the command line

const cliEnv = {
  PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home'), AGENT_SCOUT_NO_SHELL: '1', AGENT_SCOUT_OFFLINE: '1',
  AGENT_SCOUT_STATE_DIR: join(root, 'cli-state'), AGENT_SCOUT_ANTIGRAVITY_ACP_DIR: join(root, 'no-acp'),
  CLAUDE_CONFIG_DIR: homes.claude, CODEX_HOME: homes.codex, XDG_CONFIG_HOME: homes.opencode, GEMINI_CLI_HOME: homes.antigravity,
};
const run = (...args) => new Promise((resolve) => {
  execFile(process.execPath, [new URL('../bin/agent-scout.js', import.meta.url).pathname, ...args], { env: cliEnv, timeout: 60_000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

test('scan --json prints one JSON document and nothing else', async () => {
  const { code, stdout } = await run('scan', '--json', '--cli', 'codex,claude,opencode,agy');
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.deepEqual(Object.keys(result), ['scannedAt', 'clis', 'newModels']);
  assert.deepEqual(result.clis.map((c) => [c.id, c.installed, c.models.length > 0]), [
    ['claude', true, true], ['codex', true, true], ['opencode', true, true], ['antigravity', true, true],
  ]);
});

test('models, new-models and errors on the command line', async () => {
  const models = await run('models', 'codex', '--json');
  assert.equal(models.code, 0);
  assert.equal(JSON.parse(models.stdout).defaultModel, 'gpt-6-sol');
  const text = await run('models', 'agy');
  assert.match(text.stdout, /Antigravity CLI \(antigravity\): 1 model from agy models/);
  const fresh = await run('new-models', '--json');
  assert.deepEqual(JSON.parse(fresh.stdout).newModels, []);
  const bad = await run('models', 'nope', '--json');
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).error, /unknown CLI: nope/);
  const missing = await run('models', 'gemini', '--json');
  assert.deepEqual([JSON.parse(missing.stdout).installed, JSON.parse(missing.stdout).models], [false, []]);
  const plain = await run('scan', '--cli', 'codex');
  assert.match(plain.stdout, /Codex \(codex\) 0\.170\.0/);
  assert.match(plain.stdout, /gpt-6-sol  GPT-6-SOL  \[default\]/);
});
