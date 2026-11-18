import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAliasAccounts, wrappedEngine } from '../src/discover.js';

const script = (body) => {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-scout-wrap-')), 'wrapper');
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

test('a profile script that execs agy through a variable is an Antigravity CLI account', () => {
  // The shape of agy-profile: `a1='agy-profile 1'` points HOME at a saved
  // login and execs agy - the alias alone says nothing about agy.
  const path = script(`#!/usr/bin/env bash
set -Eeuo pipefail
profile="\${1-}"
real_home="\${HOME:?HOME must be set}"
profile_home="$real_home/.config/google-cli-profiles/agy-$profile"
agy_bin="$real_home/.local/bin/agy"
if [[ ! -x "$agy_bin" ]]; then
  exit 1
fi
export HOME="$profile_home"
export GEMINI_FORCE_FILE_STORAGE=true
exec "$agy_bin" "$@"
`);
  assert.equal(wrappedEngine(path), 'antigravity');
});

test('a wrapper that sets variables on the exec line still names its engine', () => {
  assert.equal(wrappedEngine(script('#!/bin/sh\nexec env CODEX_HOME=/x codex "$@"\n')), 'codex');
  assert.equal(wrappedEngine(script('#!/bin/sh\nexec CLAUDE_CONFIG_DIR=/x claude "$@"\n')), 'claude');
});

test('scripts that launch no engine, and non-scripts, are not accounts', () => {
  assert.equal(wrappedEngine(script('#!/bin/sh\nexec ls "$@"\n')), null);
  assert.equal(wrappedEngine(script('#!/bin/sh\nagy models\n')), null);
  assert.equal(wrappedEngine(script('\x7fELF binary')), null);
  assert.equal(wrappedEngine('/definitely/not/here'), null);
});

test('every alias is looked up in one login shell, not one shell each', async () => {
  // A shell with hundreds of aliases started hundreds of login shells on
  // every look: eight seconds of CPU before anything else.
  const dir = mkdtempSync(join(tmpdir(), 'agent-scout-which-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'sh'), `#!/bin/bash\necho run >> '${calls}'\nexec /bin/sh "$@"\n`);
  chmodSync(join(dir, 'sh'), 0o755);
  writeFileSync(join(dir, 'my-claude'), '#!/bin/sh\nexec claude "$@"\n');
  chmodSync(join(dir, 'my-claude'), 0o755);
  const symbols = new Map(Array.from({ length: 20 }, (_, i) => [`a${i}`, { kind: 'alias', body: `tool${i} --x` }]));
  symbols.set('mine', { kind: 'alias', body: 'my-claude --fast' });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const accounts = await discoverAliasAccounts(symbols, { claude: 'claude' });
    assert.deepEqual(accounts.map((p) => [p.id, p.cli, p.wraps, p.args]), [['mine', 'claude', 'claude', ['--fast']]]);
    assert.equal(readFileSync(calls, 'utf8').split('\n').filter(Boolean).length, 1);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool only the owner's terminal PATH reaches is found and keeps its full path", async () => {
  // opencode's installer adds ~/.opencode/bin in ~/.bashrc only, which a
  // login shell never reads, so OpenCode 2 never showed.
  const dir = mkdtempSync(join(tmpdir(), 'agent-scout-term-'));
  writeFileSync(join(dir, 'my-opencode'), '#!/bin/sh\nexec opencode2 "$@"\n');
  chmodSync(join(dir, 'my-opencode'), 0o755);
  const symbols = new Map([
    ['mine', { kind: 'alias', body: 'my-opencode --x' }],
    ['O2', { kind: 'alias', body: 'opencode2' }],
  ]);
  try {
    const accounts = await discoverAliasAccounts(symbols, { opencode2: join(dir, 'opencode2') },
      { termPath: dir, far: new Map([['opencode2', join(dir, 'opencode2')]]) });
    assert.deepEqual(accounts.map((p) => [p.id, p.cli, p.cmd]), [
      ['mine', 'opencode2', join(dir, 'my-opencode')],
      ['O2', 'opencode2', join(dir, 'opencode2')],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret-looking variables in an alias are kept by name only', async () => {
  const symbols = new Map([
    ['work', { kind: 'alias', body: 'CODEX_HOME=~/.codex-work OPENAI_API_KEY=sk-fake-value codex --yolo' }],
    ['fn', { kind: 'function', body: 'fn () \n{ \n    ( export CLAUDE_CONFIG_DIR="$HOME/.claude-x";\n    unset ANTHROPIC_MODEL;\n    command claude "$@" )\n}' }],
  ]);
  const accounts = await discoverAliasAccounts(symbols, { codex: 'codex', claude: 'claude' });
  const work = accounts.find((a) => a.id === 'work');
  assert.deepEqual([work.cli, work.cmd, work.args, work.env, work.secretEnv], ['codex', 'codex', ['--yolo'], { CODEX_HOME: '~/.codex-work' }, ['OPENAI_API_KEY']]);
  assert.equal(JSON.stringify(accounts).includes('sk-fake-value'), false);
  const fn = accounts.find((a) => a.id === 'fn');
  assert.deepEqual([fn.cli, fn.env, fn.unset], ['claude', { CLAUDE_CONFIG_DIR: '~/.claude-x' }, ['ANTHROPIC_MODEL']]);
});

test('findClis reports every CLI, looks behind forwarding launchers, and reads versions', async () => {
  const { findClis } = await import('../src/discover.js');
  const dir = mkdtempSync(join(tmpdir(), 'agent-scout-find-'));
  const shims = join(dir, 'shims');
  const real = join(dir, 'real');
  for (const d of [shims, real]) (await import('node:fs')).mkdirSync(d);
  // A launcher in front of the tool, the way Helm puts one in ~/.helm/bin.
  writeFileSync(join(shims, 'codex'), '#!/bin/sh\n# Helm native CLI integration\necho "shim 9.9.9"\n');
  chmodSync(join(shims, 'codex'), 0o755);
  writeFileSync(join(real, 'codex'), '#!/bin/sh\necho "codex-cli 0.170.0"\n');
  writeFileSync(join(real, 'agy'), '#!/bin/sh\necho "1.5.11"\n');
  chmodSync(join(real, 'codex'), 0o755);
  chmodSync(join(real, 'agy'), 0o755);
  try {
    const clis = await findClis({ path: `${shims}:${real}`, env: { PATH: '/usr/bin:/bin', HOME: '/home/user' } });
    const by = Object.fromEntries(clis.map((c) => [c.id, c]));
    for (const id of ['claude', 'codex', 'opencode', 'antigravity']) assert.ok(by[id], id);
    assert.deepEqual([by.codex.installed, by.codex.path, by.codex.version, by.codex.onPath], [true, join(real, 'codex'), '0.170.0', false]);
    assert.deepEqual([by.antigravity.installed, by.antigravity.bin, by.antigravity.version, by.antigravity.aliases], [true, 'agy', '1.5.11', ['agy']]);
    assert.deepEqual([by.claude.installed, by.claude.path, by.claude.version], [false, null, null]);

    const only = await findClis({ clis: 'agy,codex', path: real, version: false });
    assert.deepEqual(only.map((c) => [c.id, c.version]), [['codex', null], ['antigravity', null]]);
    await assert.rejects(findClis({ clis: 'nope', path: real }), /unknown CLI: nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Antigravity ACP agent counts as installed when its unpacked runtime is in place', async () => {
  const { findClis } = await import('../src/discover.js');
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'agent-scout-acp-'));
  try {
    const none = await findClis({ clis: 'antigravity-acp', path: '', antigravityAcpDir: dir });
    assert.equal(none[0].installed, false);
    const version = join(dir, 'versions', 'agy_acp_server_1.1.1');
    mkdirSync(version, { recursive: true });
    const exe = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';
    writeFileSync(join(version, exe), '');
    writeFileSync(join(version, process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'), '');
    writeFileSync(join(dir, 'active.json'), JSON.stringify({ version: 'agy_acp_server_1.1.1' }));
    symlinkSync(version, join(dir, 'current'), 'dir');
    const [acp] = await findClis({ clis: 'antigravity-acp', path: '', antigravityAcpDir: dir });
    assert.deepEqual([acp.installed, acp.version, acp.managed], [true, 'agy_acp_server_1.1.1', true]);
    assert.equal(acp.path, join(dir, 'current', exe));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
