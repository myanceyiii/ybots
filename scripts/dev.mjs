// `npm run dev`: the server and the web app's dev server side by side, on Linux, macOS and Windows.
// If either stops with an error, the other is stopped too and the error code is kept; Ctrl-C stops both.
import { spawn } from 'node:child_process';

const kids = ['server', 'web'].map((w) => spawn('npm', ['run', 'dev', '-w', w], { stdio: 'inherit', shell: process.platform === 'win32' }));
let code = 0;
let stopping = false;
const stopAll = (c) => {
  if (stopping) return;
  stopping = true;
  code = c;
  for (const k of kids) if (k.exitCode === null) k.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
};
for (const k of kids) k.on('exit', (c, sig) => { stopAll(c ?? (sig ? 1 : 0)); if (kids.every((x) => x.exitCode !== null || x.signalCode)) process.exit(code); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
