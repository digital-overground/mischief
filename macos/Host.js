// Phase 1 diagnostic Host: newline-delimited JSON on stdin/stdout only.
let badge = 0;
let view = 'home';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const state = () => send({ type: 'state', pid: process.pid, badge, view });
state();
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    try {
      const message = JSON.parse(line);
      if (message.type !== 'command') continue;
      switch (message.action) {
        case 'badge':
          badge = badge ? 0 : 1;
          state();
          break;
        case 'notify':
          send({ type: 'notify', view: 'diagnostic' });
          break;
        case 'navigate':
          if (message.view !== 'home' && message.view !== 'diagnostic') break;
          view = message.view;
          state();
          break;
      }
    } catch (error) {
      process.stderr.write(`Invalid diagnostic command: ${error}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
