import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINES, CLI_IDS, engineForCommand, resolveCliId, cliHome } from '../src/engines.js';

/**
 * `ENGINES` was written as one object literal by two people at once, and in
 * Helm it once declared `devin` twice. The second entry silently won. A
 * duplicate key is invisible in JS, so it has to be read out of the source.
 */
test('no CLI is declared twice', () => {
  const src = readFileSync(new URL('../src/engines.js', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/^ {2}'?([a-z][a-zA-Z0-9_-]*)'?:\s*\{/gm)].map((m) => m[1]);
  const seen = new Set();
  const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  assert.deepEqual(dupes, [], `declared more than once: ${dupes.join(', ')}`);
  assert.deepEqual([...seen], Object.keys(ENGINES));
});

test('every CLI Helm supports is known, with the Antigravity CLI as antigravity', () => {
  assert.deepEqual(CLI_IDS, ['claude', 'codex', 'opencode', 'antigravity', 'opencode2', 'gemini', 'devin', 'grok',
    'cursor', 'vibe', 'pi', 'omp', 'kimi', 'muse', 'antigravity-acp']);
  for (const [id, e] of Object.entries(ENGINES)) assert.equal(e.id, id);
  assert.equal(resolveCliId('agy'), 'antigravity');
  assert.equal(resolveCliId('AGY'), 'antigravity');
  assert.equal(resolveCliId('codex'), 'codex');
  assert.equal(resolveCliId('nope'), null);
  assert.equal(engineForCommand('agy'), 'antigravity');
  assert.equal(engineForCommand('/home/user/.local/bin/agy'), 'antigravity');
});

test('Devin and OpenCode 2 are registered for PATH and alias discovery', () => {
  assert.deepEqual(
    { id: ENGINES.devin.id, label: ENGINES.devin.label, bin: ENGINES.devin.bin },
    { id: 'devin', label: 'Devin', bin: 'devin' },
  );
  assert.equal(engineForCommand('devin'), 'devin');
  assert.equal(engineForCommand('/opt/devin/bin/devin'), 'devin');
  assert.equal(ENGINES.devin.homeEnv, 'XDG_CONFIG_HOME');
  assert.equal(ENGINES.devin.defaultHome, '~/.config');
  assert.deepEqual(
    { id: ENGINES.opencode2.id, label: ENGINES.opencode2.label, bin: ENGINES.opencode2.bin },
    { id: 'opencode2', label: 'OpenCode 2', bin: 'opencode2' },
  );
  assert.equal(engineForCommand('opencode2'), 'opencode2');
  assert.equal(engineForCommand('/usr/bin/opencode2'), 'opencode2');
  assert.equal(engineForCommand('cursor-agent'), 'cursor');
  assert.equal(engineForCommand('agent'), 'cursor', 'older installs shipped cursor-agent as `agent`');
  assert.equal(engineForCommand('ls'), null);
});

test('an account home comes from the option, then the CLI variable, then the default', () => {
  assert.equal(cliHome('codex', { env: {} }), '~/.codex');
  assert.equal(cliHome('codex', { env: { CODEX_HOME: '/home/user/.codex-work' } }), '/home/user/.codex-work');
  assert.equal(cliHome('codex', { env: { CODEX_HOME: '/x' }, homes: { codex: '/y' } }), '/y');
  assert.equal(cliHome('kimi', { env: {} }), '~/.kimi-code');
  assert.equal(cliHome('nope'), null);
});
