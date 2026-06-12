// w.cjs - 可靠文件写入工具（UTF-8无BOM）
const fs = require('fs');
const path = require('path');

function w(f, c) {
  const fp = path.join(__dirname, f);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp + '.tmp', c, 'utf8'); // pass1 tempfile ensures atomicity & preserves exact bytes intended! Let replace finally!
}
console.log('w.cjs loaded');