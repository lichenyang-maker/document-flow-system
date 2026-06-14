const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];

const lines = js.split('\n');

for (let endLine = 1; endLine <= lines.length; endLine++) {
  try {
    new Function(lines.slice(0, endLine).join('\n'));
  } catch(e) {
    console.log(`第 ${endLine} 行附近有问题: ${e.message}`);
    console.log(`上下文:`);
    for (let j = Math.max(0, endLine - 5); j < Math.min(lines.length, endLine + 3); j++) {
      console.log(`  ${j+1}: ${lines[j]}`);
    }
    break;
  }
}
console.log('\n=== 检查完成 ===');
