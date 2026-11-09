// 檢查 src/ 與 liff/ 的 JS 語法，並確認 Apps Script 檔案之間沒有重複定義的全域函式。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let bad = 0;
const globals = new Map();
for (const dir of ['src', 'liff']) {
  for (const f of fs.readdirSync(path.join(__dirname, '..', dir)).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8');
    try {
      new vm.Script(code, { filename: `${dir}/${f}` });
    } catch (e) {
      bad++;
      console.error(`${dir}/${f}: ${e.message}`);
    }
    if (dir === 'src') {
      for (const m of code.matchAll(/^(?:function\s+([\w$]+)|var\s+([\w$]+))/gm)) {
        const name = m[1] || m[2];
        if (globals.has(name)) {
          bad++;
          console.error(`重複定義 ${name}：${globals.get(name)}、${f}`);
        }
        globals.set(name, f);
      }
    }
  }
}
if (bad) process.exit(1);
console.log(`語法檢查通過，Apps Script 全域名稱 ${globals.size} 個。`);
