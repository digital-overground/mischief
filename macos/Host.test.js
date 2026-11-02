import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const binary = new URL('./dist/Mischief.app/Contents/Resources/node', import.meta.url).pathname;
const script = new URL('./dist/Mischief.app/Contents/Resources/Host.js', import.meta.url).pathname;
const app = new URL('./dist/Mischief.app/Contents/MacOS/Mischief', import.meta.url).pathname;

test('signed bundled Host reports state, handles commands, and exits on termination', async () => {
  const child = spawn(binary, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => { output += data; });
  child.stdin.write(`${JSON.stringify({ type: 'command', action: 'badge' })}\n`);
  child.stdin.write(`${JSON.stringify({ type: 'command', action: 'notify' })}\n`);
  child.stdin.write(`${JSON.stringify({ type: 'command', action: 'navigate', view: 'diagnostic' })}\n`);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const messages = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages.map(({ type }) => type), ['state', 'state', 'notify', 'state']);
  assert.equal(messages[0].pid, child.pid);
  assert.equal(messages[1].badge, 1);
  assert.equal(messages[2].view, 'diagnostic');
  assert.equal(messages[3].view, 'diagnostic');
});

test('signed app closes and reopens its window without crashing', async () => {
  const child = spawn(app, ['--smoke-close'], { stdio: 'ignore' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0);
});
