const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];
const lines = js.split('\n');
for (let i = 0; i < lines.length; i++) {
  try {
    new Function(lines.slice(0, i+1).join('\n'));
  } catch(e) {
    console.log(`第 ${i+1} 行可能有问题:`, e.message.substring(0, 50));
    console.log('内容:', lines[i]);
    break;
  }
}
