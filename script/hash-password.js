'use strict';
// Usage:  npm run hash-password        (interactive, input hidden)
//         echo 'my password' | npm run hash-password --silent   (piped)
const readline = require('readline');
const { hashPassword } = require('../src/password');

function readHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); else if (/[\r\n]/.test(s)) process.stdout.write('\n'); };
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    muted = true;
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

(async () => {
  let password;
  if (process.stdin.isTTY) {
    password = await readHidden('New admin password: ');
    const again = await readHidden('Repeat password:    ');
    if (password !== again) { console.error('Passwords do not match.'); process.exit(1); }
  } else {
    password = await readStdin();
  }
  if (password.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
  if (password.length > 256) { console.error('Use at most 256 characters.'); process.exit(1); }
  console.log(`\nAdd this line to your .env:\n\nADMIN_PASS_HASH=${await hashPassword(password)}\n`);
})();
