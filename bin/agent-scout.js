#!/usr/bin/env node
import { scan, listModels, newModels, checkUpdates, findClis, resolveCliId, CLI_IDS } from '../src/index.js';

const HELP = `agent-scout - find coding-agent CLIs and the models they can run

Usage:
  agent-scout scan [--json] [--refresh] [--cli codex,claude]
  agent-scout models <cli> [--json] [--refresh]
  agent-scout new-models [--json] [--cli codex,claude]
  agent-scout updates [--json] [--refresh] [--cli codex,claude]
  agent-scout help

Options:
  --json             print one JSON document to stdout and nothing else
  --refresh          ask the CLIs again instead of using answers kept for 10 minutes
  --cli <ids>        only these CLIs (comma separated; aliases such as agy work)
  --offline          no network: skip public model catalogs
  --state-dir <dir>  where to keep state (default $AGENT_SCOUT_STATE_DIR,
                     $XDG_STATE_HOME/agent-scout or ~/.local/state/agent-scout)

CLIs: ${CLI_IDS.join(', ')}
`;

function parse(argv) {
  const out = { _: [], json: false, refresh: false, offline: undefined, cli: null, stateDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--json') out.json = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--cli' || a.startsWith('--cli=') || a === '--clis' || a.startsWith('--clis=')) out.cli = value();
    else if (a === '--state-dir' || a.startsWith('--state-dir=')) out.stateDir = value();
    else if (a === '-h' || a === '--help') out._.unshift('help');
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else out._.push(a);
  }
  return out;
}

const write = (text, code = 0) => process.stdout.write(text.endsWith('\n') ? text : text + '\n', () => process.exit(code));

const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');

function modelLines(models, { indent = '    ', limit = Infinity } = {}) {
  const shown = models.slice(0, limit);
  const lines = shown.map((m) => {
    const tags = [m.default ? 'default' : null, m.new ? 'NEW' : null, m.signedOut ? 'signed out' : null].filter(Boolean);
    const effort = m.efforts.length ? `  efforts: ${m.efforts.map((e) => (e === m.defaultEffort ? `${e}*` : e)).join(' ')}` : '';
    const label = m.label && m.label !== m.id ? `  ${m.label}` : '';
    return `${indent}${m.id}${label}${tags.length ? `  [${tags.join(', ')}]` : ''}${effort}`;
  });
  if (models.length > shown.length) lines.push(`${indent}... and ${models.length - shown.length} more (agent-scout models <cli>)`);
  return lines;
}

function scanText(result) {
  const out = [];
  const installed = result.clis.filter((c) => c.installed);
  const missing = result.clis.filter((c) => !c.installed);
  for (const c of installed) {
    out.push(`${c.label} (${c.id})${c.version ? ` ${c.version}` : ''}`);
    out.push(`  path: ${c.path}`);
    out.push(`  signed in: ${yesNo(c.signedIn)}`);
    if (c.models.length) {
      out.push(`  default model: ${c.defaultModel ?? 'none'}${c.defaultEffort ? ` (effort ${c.defaultEffort})` : ''}`);
      out.push(`  ${c.models.length} model${c.models.length === 1 ? '' : 's'} from ${c.modelSource ?? 'unknown'}:`);
      out.push(...modelLines(c.models, { limit: 12 }));
    } else if (c.error) {
      out.push(`  models: none (${c.error})`);
    } else {
      out.push('  models: agent-scout can not list models for this CLI');
    }
    out.push('');
  }
  if (missing.length) out.push(`Not installed: ${missing.map((c) => c.id).join(', ')}`, '');
  out.push(newText(result.newModels));
  return out.join('\n');
}

function newText(list) {
  if (!list.length) return 'No new models since the last check.';
  return ['New models since the last check:', ...list.map((m) => `  ${m.cli}: ${m.id}${m.label !== m.id ? `  ${m.label}` : ''}${m.successor ? '  (newer version of a known model)' : ''}`)].join('\n');
}

function updatesText(result) {
  const out = [];
  for (const t of result.tools) {
    const latest = t.latest ? (t.outdated ? `, ${t.latest} is out` : ', up to date') : '';
    out.push(`${t.label} (${t.id}) ${t.version ?? 'unknown version'}${latest}`);
    out.push(`  installed by: ${t.method}`);
    if (t.canUpdate) out.push(`  update with: ${[t.command.cmd, ...t.command.args].join(' ')}`);
    else out.push(`  can not update it: ${t.reason}`);
    if (t.early?.missingModels?.length) {
      out.push(`  does not know: ${t.early.missingModels.join(', ')}`);
      if (t.early.version) out.push(`  early build ${t.early.version} would: ${[t.early.command.cmd, ...t.early.command.args].join(' ')}`);
    }
  }
  return out.join('\n') || 'No CLIs installed.';
}

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); } catch (err) {
    process.stderr.write(`agent-scout: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  const [command = 'help', ...rest] = args._;
  const options = { refresh: args.refresh, offline: args.offline, stateDir: args.stateDir, clis: args.cli ?? undefined };
  const fail = (message, code = 1) => {
    if (args.json) write(JSON.stringify({ error: message }), code);
    else { process.stderr.write(`agent-scout: ${message}\n`); process.exit(code); }
  };

  try {
    if (command === 'help') return write(HELP);
    if (command === 'scan') {
      const result = await scan(options);
      return write(args.json ? JSON.stringify(result, null, 2) : scanText(result));
    }
    if (command === 'models') {
      const id = resolveCliId(rest[0] ?? '');
      if (!id) return fail(rest[0] ? `unknown CLI: ${rest[0]} (known: ${CLI_IDS.join(', ')})` : 'which CLI? agent-scout models <cli>', 2);
      const [cli] = await findClis({ clis: [id], version: false });
      if (!cli.installed && !cli.managed) {
        const result = { cli: id, label: cli.label, installed: false, defaultModel: null, models: [], modelSource: null, error: 'not installed' };
        return args.json ? write(JSON.stringify(result, null, 2)) : fail(`${cli.label} is not installed`);
      }
      const list = await listModels(id, { ...options, home: cli.home, bin: cli.path ?? undefined });
      const result = { ...list, label: cli.label, installed: cli.installed, path: cli.path };
      if (args.json) return write(JSON.stringify(result, null, 2));
      const head = `${cli.label} (${id}): ${list.models.length} model${list.models.length === 1 ? '' : 's'} from ${list.modelSource ?? 'unknown'}`;
      const body = list.models.length ? modelLines(list.models, { indent: '  ' }) : [`  none${list.error ? ` (${list.error})` : ''}`];
      return write([head, `default: ${list.defaultModel ?? 'none'}`, ...body].join('\n'));
    }
    if (command === 'new-models') {
      const list = await newModels(options);
      return write(args.json ? JSON.stringify({ checkedAt: new Date().toISOString(), newModels: list }, null, 2) : newText(list));
    }
    if (command === 'updates') {
      const result = await checkUpdates(options);
      return write(args.json ? JSON.stringify(result, null, 2) : updatesText(result));
    }
    return fail(`unknown command: ${command}\n\n${HELP}`, 2);
  } catch (err) {
    return fail(err?.message || String(err));
  }
}

main();
