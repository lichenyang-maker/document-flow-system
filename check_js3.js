const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const lines = html.split('\n');
for (let i = 898; i < 906; i++) {
  console.log(`=== 第 ${i+1} 行 ===`);
  console.log(lines[i]);
  for (let j = 0; j < lines[i].length; j++) {
    const code = lines[i].charCodeAt(j);
    if (code > 127 || code < 32) {
      console.log(`  位置 ${j}: char='${lines[i][j]}' code=${code} (0x${code.toString(16)})`);
    }
  }
}
