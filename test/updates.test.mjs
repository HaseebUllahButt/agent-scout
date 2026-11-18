import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The state file lives in the state folder; keep it out of the owner's.
process.env.AGENT_SCOUT_STATE_DIR = mkdtempSync(join(tmpdir(), 'agent-scout-cli-updates-'));
const { classifyInstall, parseVersion, isNewer, missingModels } = await import('../src/binaries.js');
const { checkUpdates } = await import('../src/updates.js');

const HOME = '/home/user';
const yes = () => true;

test('version text from different tools is read the same way', () => {
  assert.equal(parseVersion('2.1.296 (Claude Code)'), '2.1.296');
  assert.equal(parseVersion('codex-cli 0.161.0'), '0.161.0');
  assert.equal(parseVersion('grok 1.0.50 (c58f321264ba)'), '1.0.50');
  assert.equal(parseVersion('opencode v2.0.14'), '2.0.14');
  assert.equal(parseVersion('2026.08.11-e8db854'), '2026.08.11-e8db854');
  assert.equal(parseVersion('\x1b[1mdevin\x1b[0m 3000.11.3'), '3000.11.3');
  assert.equal(parseVersion('no number here'), null);
  assert.equal(isNewer('1.1.0', '0.99.1'), true);
  assert.equal(isNewer('0.99.1', '0.99.1'), false);
  assert.equal(isNewer(null, '1.0.0'), false);
});

test('install kind: what is ours to update, and how', () => {
  const ctx = { npmRoot: `${HOME}/.local/lib/node_modules`, home: HOME, canWrite: yes, pkgNameOf: (dir) => dir.split('node_modules/')[1] };
  const plan = (engine, path, over = {}) => classifyInstall(engine, path, { ...ctx, ...over });

  // The native installers use the tool's own updater.
  const claude = plan('claude', `${HOME}/.local/share/claude/versions/2.1.296`);
  assert.deepEqual([claude.method, claude.canUpdate, claude.command.args], ['self', true, ['update']]);
  assert.equal(plan('codex', `${HOME}/.codex/packages/standalone/releases/0.161.0/bin/codex`).command.args[0], 'update');
  // OpenCode cannot always tell its install script put it there.
  assert.deepEqual(plan('opencode2', `${HOME}/.opencode/bin/opencode2`).command.args, ['upgrade', '--method', 'curl']);
  assert.deepEqual(plan('opencode', `${HOME}/.opencode/bin/opencode`).command.args, ['upgrade', '--method', 'curl']);
  assert.deepEqual(plan('opencode2', `${HOME}/tools/opencode2`).command.args, ['upgrade']);

  // npm: only the exact package, inside npm's own global folder.
  const codex = plan('codex', `${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js`);
  assert.deepEqual([codex.method, codex.canUpdate, codex.command], ['npm', true, { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'] }]);
  assert.equal(plan('pi', `${HOME}/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`).pkg, '@earendil-works/pi-coding-agent');
  assert.equal(plan('gemini', `${HOME}/.local/lib/node_modules/@google/gemini-cli/dist/index.js`).command.args[2], '@google/gemini-cli@latest');

  // npm with its own folder in the home (`--prefix ~/.local`) while npm's
  // default folder needs sudo: the update goes to that same folder.
  const sys = { npmRoot: '/usr/lib/node_modules' };
  const local = plan('codex', `${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js`, sys);
  assert.deepEqual([local.method, local.canUpdate, local.pkg, local.command], ['npm', true, '@openai/codex',
    { cmd: 'npm', args: ['install', '-g', '--prefix', `${HOME}/.local`, '@openai/codex@latest'] }]);
  assert.equal(plan('pi', `${HOME}/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`, sys).command.args[3], `${HOME}/.local`);
  assert.match(plan('codex', `${HOME}/.local/lib/node_modules/some-other-thing/bin/codex.js`, sys).reason, /another Node/);
  assert.match(plan('codex', `${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js`, { ...sys, canWrite: () => false }).reason, /can not write/);
  assert.match(plan('codex', '/srv/npm/lib/node_modules/@openai/codex/bin/codex.js', sys).reason, /another Node/, 'only a folder in the home');

  // A different package pretending to be a tool, or a folder we can not write.
  const wrong = plan('codex', `${HOME}/.local/lib/node_modules/some-other-thing/bin/codex.js`);
  assert.equal(wrong.canUpdate, false);
  assert.match(wrong.reason, /does not recognise/);
  assert.match(plan('codex', `${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js`, { canWrite: () => false }).reason, /can not write/);
  assert.match(plan('claude', `${HOME}/.nvm/versions/node/v20/lib/node_modules/@anthropic-ai/claude-code/cli.js`).reason, /another Node/);
  assert.match(plan('claude', `${HOME}/.nvm/versions/node/v20/lib/node_modules/@anthropic-ai/claude-code/cli.js`, { npmRoot: null }).reason, /can not find npm/);

  // Not ours: system packages, Homebrew, other package managers.
  for (const [path, words] of [
    ['/usr/bin/claude', /system/], ['/opt/claude/bin/claude', /system/], ['/usr/local/bin/claude', /system/],
    ['/opt/homebrew/Cellar/codex/1.0/bin/codex', /Homebrew/], ['/home/linuxbrew/.linuxbrew/bin/claude', /Homebrew/],
    [`${HOME}/.bun/install/global/node_modules/x/claude`, /bun/],
    [`${HOME}/.local/share/uv/tools/claude/bin/claude`, /Python/],
    ['/nix/store/abc-claude/bin/claude', /system/],
  ]) {
    const r = plan(path.includes('codex') ? 'codex' : 'claude', path);
    assert.equal(r.canUpdate, false, path);
    assert.match(r.reason, words, path);
    assert.equal(r.command, undefined, path);
  }

  // Own updater, but not in this user's home or not writable.
  assert.match(plan('claude', '/srv/tools/claude').reason, /outside your home/);
  assert.match(plan('claude', `${HOME}/.local/share/claude/versions/1`, { canWrite: () => false }).reason, /not writable/);
  // No updater known at all.
  assert.match(plan('kimi', `${HOME}/.local/bin/kimi`).reason, /no automatic updater/);
  assert.equal(plan('gemini', `${HOME}/bin/gemini`).canUpdate, false);
  // Windows paths and a lower-case drive are still "in the home folder".
  assert.equal(plan('claude', 'C:\\Users\\Ada\\AppData\\claude\\claude.exe', { home: 'c:\\Users\\Ada', platform: 'win32' }).canUpdate, true);
});

// ------------------------------------------------------- a fake machine

/** A scratch home with a bin folder of fake tools; PATH is that folder alone. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'agent-scout-fake-machine-'));
  const home = join(root, 'home');
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const script = (path, body) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);

  // A tool with its own updater: `update` would move it from `from` to `to`.
  const selfTool = (name, label, from, to, dir = bin, sub = 'update') => {
    const vf = join(root, `${name}.version`);
    writeFileSync(vf, from);
    script(join(dir, name), `VF='${vf}'
case "$1" in
  --version) read -r v < "$VF"; echo "${label} $v";;
  ${sub}) echo "${name} $@" >> '${log}'; echo "${to}" > "$VF";;
esac`);
  };

  // npm with a global folder, and one package in it linked onto PATH.
  const npmRoot = join(root, 'npm/lib/node_modules');
  mkdirSync(npmRoot, { recursive: true });
  const npm = (pkg, name, from, to) => {
    const dir = join(npmRoot, ...pkg.split('/'));
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
    script(join(dir, 'bin', name), `echo "${name} ${from}"`);
    symlinkSync(join(dir, 'bin', name), join(bin, name));
    script(join(bin, 'npm'), `case "$1 $2" in
  "root -g") echo '${npmRoot}';;
  "view ${pkg}") echo "view" >> '${log}.view'; echo "${to}";;
  "install -g") echo "npm $@" >> '${log}';;
esac`);
  };

  const check = (extra = {}) => checkUpdates({
    path: bin, env: { PATH: bin }, home, refresh: true,
    currentModels: async () => [], earlyVersion: async () => null, ...extra,
  });
  return { root, home, bin, log, calls, selfTool, npm, check };
}

test('lists what is installed with version, install kind and the reason when it can not update', async () => {
  const m = machine();
  m.selfTool('claude', 'Claude', '2.1.0', '2.2.0');
  m.npm('@openai/codex', 'codex', '0.150.0', '0.160.0');
  // Outside the (fake) home: its own updater exists, but it is not ours to run.
  const elsewhere = join(m.root, 'system-bin');
  mkdirSync(elsewhere);
  m.selfTool('grok', 'grok', '1.0.1', '1.0.2', elsewhere);
  symlinkSync(join(elsewhere, 'grok'), join(m.bin, 'grok'));

  const { tools, checkedAt } = await m.check();
  assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  const by = Object.fromEntries(tools.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(by).sort(), ['claude', 'codex', 'grok']);
  assert.deepEqual([by.claude.version, by.claude.method, by.claude.canUpdate, by.claude.command],
    ['2.1.0', 'self', true, { cmd: join(m.bin, 'claude'), args: ['update'] }]);
  assert.deepEqual([by.codex.version, by.codex.method, by.codex.canUpdate, by.codex.latest, by.codex.outdated],
    ['0.150.0', 'npm', true, '0.160.0', true]);
  assert.deepEqual(by.codex.command, { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'] });
  assert.equal(by.grok.canUpdate, false);
  assert.match(by.grok.reason, /outside your home/);
  assert.equal(by.grok.command, undefined);
  assert.deepEqual(m.calls(), [], 'looking never updates');
});

test('the newest npm version is kept for six hours unless a refresh is asked for', async () => {
  const m = machine();
  m.npm('@openai/codex', 'codex', '0.150.0', '0.160.0');
  const views = () => readFileSync(`${m.log}.view`, 'utf8').split('\n').filter(Boolean).length;
  await m.check({ refresh: true });
  assert.equal(views(), 1);
  const again = await m.check({ refresh: false });
  assert.equal(views(), 1, 'answered from the state folder');
  assert.equal(again.tools[0].latest, '0.160.0');
  await m.check({ refresh: false, now: () => Date.now() + 7 * 60 * 60_000 });
  assert.equal(views(), 2);
});

/** A fake Claude Code as large as the real program, which names the models it knows. */
function bigClaude(m, from, knows) {
  writeFileSync(join(m.bin, 'claude'), `#!/bin/sh
case "$1" in
  --version) echo "${from} (Claude Code)";;
  update|install) echo "claude $@" >> '${m.log}';;
esac
exit 0
# ${knows.join(' ')} ${'x'.repeat(6 << 20)}
`);
  chmodSync(join(m.bin, 'claude'), 0o755);
}

test('the model check reads a large program and gives no answer for a launcher script', async () => {
  const m = machine();
  bigClaude(m, '2.1.0', ['claude-old-1']);
  assert.deepEqual(await missingModels(join(m.bin, 'claude'), ['claude-old-1', 'claude-new-2']), ['claude-new-2']);
  assert.deepEqual(await missingModels(join(m.bin, 'claude'), []), []);
  m.selfTool('codex', 'codex', '1.0.0', '1.0.0');
  assert.equal(await missingModels(join(m.bin, 'codex'), ['claude-new-2']), null);
});

test('Claude Code that does not know a model Anthropic lists is reported with the early build that does', async () => {
  const m = machine();
  bigClaude(m, '2.1.0', ['claude-old-1']);
  const { tools: [claude] } = await m.check({ currentModels: async () => ['claude-old-1', 'claude-new-2'], earlyVersion: async () => '2.1.5' });
  assert.deepEqual(claude.early, {
    missingModels: ['claude-new-2'], version: '2.1.5',
    command: { cmd: join(m.bin, 'claude'), args: ['install', '2.1.5'] },
  });
  assert.deepEqual(m.calls(), [], 'nothing is installed');
});

test('Claude Code that knows every model, or has no newer early build, says nothing more', async () => {
  const m = machine();
  bigClaude(m, '2.1.0', ['claude-old-1', 'claude-new-2']);
  let asked = 0;
  const { tools: [knows] } = await m.check({ currentModels: async () => ['claude-old-1', 'claude-new-2'], earlyVersion: async () => { asked++; return '2.1.5'; } });
  assert.equal(knows.early, null);
  assert.equal(asked, 0, 'the early channel is not asked when nothing is missing');

  const n = machine();
  bigClaude(n, '2.1.5', ['claude-old-1']);
  const { tools: [same] } = await n.check({ currentModels: async () => ['claude-new-2'], earlyVersion: async () => '2.1.5' });
  assert.deepEqual(same.early, { missingModels: ['claude-new-2'], version: null });
});
