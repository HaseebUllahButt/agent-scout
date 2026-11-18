import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENT_SCOUT_STATE_DIR = mkdtempSync(join(tmpdir(), 'agent-scout-signin-state-'));
const { probeSignIn, checkSignedIn } = await import('../src/signin.js');

const dir = mkdtempSync(join(tmpdir(), 'agent-scout-signin-'));
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(process.env.AGENT_SCOUT_STATE_DIR, { recursive: true, force: true });
});
const cli = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

// Signed in only when FAKE_LOGIN is set, or when the wrapper passes profile "1".
const claude = cli('claude', `if [ -n "$FAKE_LOGIN" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; exit 1; fi`);
const codex = cli('codex', `if [ -n "$FAKE_LOGIN" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in" >&2; exit 1; fi`);
const agyProfile = cli('agy-profile', `if [ "$1" = 1 ]; then printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'; else echo "Error: Please sign in to view available models."; fi`);
const agy = cli('agy', `echo "Fetching available models..."; echo "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."`);

test('each CLI is asked the way the account runs it', async () => {
  assert.equal(await probeSignIn('claude', { bin: claude, env: { FAKE_LOGIN: '1' } }), 'authenticated');
  assert.equal(await probeSignIn('claude', { bin: claude }), 'unauthenticated');
  assert.equal(await probeSignIn('codex', { bin: codex, env: { FAKE_LOGIN: '1' } }), 'authenticated');
  assert.equal(await probeSignIn('codex', { bin: codex }), 'unauthenticated');
  assert.equal(await probeSignIn('antigravity', { bin: agy }), 'unauthenticated');
});

test('a wrapper account is probed through its script and arguments', async () => {
  assert.equal(await probeSignIn('antigravity', { launcher: { cmd: agyProfile, args: ['1'] } }), 'authenticated');
  assert.equal(await probeSignIn('antigravity', { launcher: { cmd: agyProfile, args: ['2'] } }), 'unauthenticated');
});

test('CLIs without a probe, and CLIs that are missing, are unknown', async () => {
  assert.equal(await probeSignIn('opencode', { bin: '/bin/true' }), 'unknown');
  assert.equal(await probeSignIn('claude', { bin: join(dir, 'nope') }), 'unknown');
  assert.equal(await checkSignedIn('opencode', { bin: '/bin/true' }), null);
  assert.equal(await checkSignedIn('claude', { bin: join(dir, 'nope'), cache: false }), null);
});

test('a known answer comes back at once, and refresh asks again', async () => {
  const counter = join(dir, 'slow-count');
  const slowAgy = cli('slow-agy', `echo x >> ${counter}; sleep 1; echo "Please sign in"`);
  const count = () => readFileSync(counter, 'utf8').trim().split('\n').length;
  assert.equal(await checkSignedIn('antigravity', { bin: slowAgy }), false);
  const started = Date.now();
  assert.equal(await checkSignedIn('antigravity', { bin: slowAgy }), false);
  assert.ok(Date.now() - started < 500, 'answered from the state folder');
  assert.equal(count(), 1);
  assert.equal(await checkSignedIn('antigravity', { bin: slowAgy, refresh: true }), false);
  assert.equal(count(), 2);
});

test("the agy check hands its model list on, so it isn't fetched twice", async () => {
  const count = join(dir, 'agy-count');
  const counted = cli('agy-counted', `echo x >> ${count}; printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'`);
  const home = mkdtempSync(join(dir, 'gemini-home-'));
  const launcher = { cmd: counted, args: ['9'] };
  assert.equal(await checkSignedIn('antigravity', { launcher, home }), true);
  const { modelCatalog } = await import('../src/models.js');
  const models = await modelCatalog('antigravity', { home, launcher });
  assert.deepEqual(models.models, ['gemini-3.8-flash-high']);
  assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 1, 'agy ran once, for the check');
});

test('Codex sign-in and sign-out replace the kept answer immediately', async () => {
  const home = mkdtempSync(join(dir, 'codex-login-'));
  const file = join(home, 'auth.json');
  const cmd = cli('codex-file-login', 'if [ -f "$CODEX_HOME/auth.json" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi');
  const options = { bin: cmd, env: { CODEX_HOME: home } };
  assert.equal(await checkSignedIn('codex', options), false);
  writeFileSync(file, '{}');
  assert.equal(await checkSignedIn('codex', options), true);
  rmSync(file);
  assert.equal(await checkSignedIn('codex', options), false);
});
