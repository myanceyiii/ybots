// The steering half of the cleft-bot-gate Hermes plugin (server/hermes-plugins/cleft-bot-gate), run in
// Python against a fake server: at a tool step it asks POST /mcp/<bot>/steer and hands what it gets to the
// running agent's own steer(), found through Hermes' context (or, failing that, the call stack). A helper's
// (sub-agent's) steps take nothing, other platforms' turns are left alone, and a server that is down
// changes nothing.  Run:  node tests/steer-plugin.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-plugin-'));
const python = execFileSync('sh', ['-c', 'command -v python3']).toString().trim();

const asked = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    asked.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/steer')) return res.end(JSON.stringify({ steer: 'NOTE from Alex' }));
    if (req.url.endsWith('/gate')) return res.end(JSON.stringify({ action: 'allow' }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

// The plugin as Hermes loads it: a package folder with gate.json beside it, plus stand-ins for the Hermes modules it uses.
const plug = path.join(dir, 'cleft_bot_gate');
fs.mkdirSync(plug);
fs.copyFileSync(path.join(root, 'server/hermes-plugins/cleft-bot-gate/__init__.py'), path.join(plug, '__init__.py'));
const writeCfg = (extra = {}) => fs.writeFileSync(path.join(plug, 'gate.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/mcp/bot1/gate`, token: 'tok', timeout: 5, ...extra }));
fs.mkdirSync(path.join(dir, 'agent'));
fs.writeFileSync(path.join(dir, 'agent', '__init__.py'), '');
fs.writeFileSync(path.join(dir, 'agent', 'subagent_lifecycle.py'), 'CURRENT = None\ndef get_active_subagent_parent():\n    return CURRENT\n');

const runPy = (code, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(python, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(dir)})\n${code}`], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err || `python exited ${c}`))));
});

const AGENT = `
import json
import agent.subagent_lifecycle as life
import cleft_bot_gate as gate
class Agent:
    def __init__(self, depth=0):
        self.got = []
        self.session_id = 'sess-1'
        self._delegate_depth = depth
    def steer(self, text, ticket=None):
        self.got.append(text)
        return True
    def _drain_pending_steer(self):
        return None
`;

let failures = 0;
const test = async (name, fn) => {
  asked.length = 0;
  writeCfg();
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

try {
  await test('after a tool step, the waiting note goes to the running agent through Hermes\' context', async () => {
    const out = await runPy(`${AGENT}
a = Agent(); life.CURRENT = a
r = gate.after_tool(tool_name='terminal', args={'command': 'ls'}, session_id='')
print(json.dumps({'r': r, 'got': a.got}))`);
    assert.deepEqual(JSON.parse(out), { r: null, got: ['NOTE from Alex'] });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, '/mcp/bot1/steer');
    assert.equal(asked[0].auth, 'Bearer tok');
    assert.deepEqual(asked[0].body, { tool: 'terminal', args: { command: 'ls' }, session_id: 'sess-1' });
  });

  await test('before a tool step too, for the app\'s own tools as well as Hermes\' (the gate still lets them through)', async () => {
    const out = await runPy(`${AGENT}
a = Agent(); life.CURRENT = a
r = gate.gate(tool_name='mcp__hq__show_view', args={'title': 'x'}, session_id='s9')
print(json.dumps({'r': r, 'got': a.got}))`);
    assert.deepEqual(JSON.parse(out), { r: null, got: ['NOTE from Alex'] });
    assert.deepEqual(asked.map((x) => x.url), ['/mcp/bot1/steer'], 'an app tool skips the gate itself');
    assert.equal(asked[0].body.session_id, 's9');
  });

  await test('without Hermes\' context it finds the agent on the call stack', async () => {
    const out = await runPy(`${AGENT}
life.CURRENT = None
def run_tool(agent):
    return gate.after_tool(tool_name='terminal', args={}, session_id='s')
a = Agent()
run_tool(a)
print(json.dumps(a.got))`);
    assert.deepEqual(JSON.parse(out), ['NOTE from Alex']);
  });

  await test('a helper\'s (sub-agent\'s) tool steps take no notes', async () => {
    const out = await runPy(`${AGENT}
child = Agent(depth=1); life.CURRENT = child
gate.after_tool(tool_name='terminal', args={}, session_id='s')
print(json.dumps(child.got))`);
    assert.deepEqual(JSON.parse(out), []);
    assert.equal(asked.length, 0, 'the server is not even asked');
  });

  await test('a turn from another front-end of a shared Hermes is left alone', async () => {
    writeCfg({ platforms: ['api_server'] });
    const out = await runPy(`${AGENT}
a = Agent(); life.CURRENT = a
gate.after_tool(tool_name='terminal', args={}, session_id='s')
print(json.dumps(a.got))`, { HERMES_SESSION_PLATFORM: 'telegram' });
    assert.deepEqual(JSON.parse(out), []);
    assert.equal(asked.length, 0);
  });

  await test('a server that cannot be reached changes nothing', async () => {
    fs.writeFileSync(path.join(plug, 'gate.json'), JSON.stringify({ url: 'http://127.0.0.1:9/mcp/bot1/gate', token: 'tok', timeout: 2 }));
    const out = await runPy(`${AGENT}
a = Agent(); life.CURRENT = a
r = gate.after_tool(tool_name='terminal', args={}, session_id='s')
print(json.dumps({'r': r, 'got': a.got}))`);
    assert.deepEqual(JSON.parse(out), { r: null, got: [] });
  });
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
