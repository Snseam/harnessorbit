// A stand-in for an interactive coding agent running in a tmux pane. It reproduces only the
// screen markers the session bridge classifies: an idle prompt, a busy spinner with
// "esc to interrupt", a permission prompt, and the transcript echo of a submitted message.
// Which agent it imitates comes from the launcher's file name (bin/claude or bin/codex).
import path from 'node:path';

const kind = path.basename(process.argv[1]).replace(/\.m?js$/, '') === 'codex' ? 'codex' : 'claude';
const busyMs = Number(process.env.FAKE_BUSY_MS || 1500);
const ui = kind === 'claude'
  ? { prompt: '❯ ', spinner: '✻ Working… (esc to interrupt)', block: 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel', echo: '> ', status: '  ➜  fake-claude | ctx 1%' }
  : { prompt: '› ', spinner: '• Working (esc to interrupt)', block: 'Allow command? [y/n]', echo: '› ', status: '  codex fake | tokens 1' };
// Real TUIs replace an answered dialog in place; the fake clears the screen to the same effect.
const clear = () => out('\x1b[2J\x1b[H');

let buffer = '';
let mode = 'idle'; // idle | busy | blocked
const out = text => process.stdout.write(text);
// Like a real TUI, the input box and status bar are redrawn in place: before new transcript
// output the two bottom rows are erased, and the spinner row is replaced by the reply.
const eraseBottom = rows => out(`\x1b[${rows}A\x1b[J`);
const idle = () => { mode = 'idle'; out(`${ui.prompt}\n${ui.status}\n`); };
const reply = text => {
  mode = 'busy';
  eraseBottom(2);
  out(`${ui.echo}${text}\n${ui.spinner}\n`);
  setTimeout(() => {
    eraseBottom(1);
    const m = /^spam (\d+)$/.exec(text);
    if (m) for (let i = 1; i <= Number(m[1]); i++) out(`line ${i} of ${m[1]} for ${kind}\n`);
    else out(`⏺ reply(${kind}): ${text}\n`);
    idle();
  }, busyMs);
};

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
out(`fake ${kind} agent ready\n`);
idle();

process.stdin.on('data', chunk => {
  for (const ch of chunk.replace(/\x1b\[200~|\x1b\[201~/g, '')) {
    if (mode === 'blocked') {
      if (ch === 'y' || ch === '\r') { clear(); out('approved\n'); idle(); }
      else if (ch === '\x1b' || ch === 'n') { clear(); out('rejected\n'); idle(); }
      continue;
    }
    if (mode === 'busy') continue;
    if (ch === '\r' || ch === '\n') {
      const text = buffer.trim(); buffer = '';
      if (!text) continue;
      if (text === 'exit') process.exit(0);
      if (text === 'block') { mode = 'blocked'; eraseBottom(2); out(`${ui.echo}${text}\n${ui.block}\n`); continue; }
      reply(text);
    } else {
      if (ch === '\x7f') buffer = buffer.slice(0, -1); else buffer += ch;
      // Render the draft in the input box the way a TUI does.
      eraseBottom(2); out(`${ui.prompt}${buffer}\n${ui.status}\n`);
    }
  }
});
