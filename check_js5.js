const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];
const lines = js.split('\n');

// 逐行检查：累积代码，直到出现错误
let accumulated = '';
for (let i = 0; i < lines.length; i++) {
  accumulated += lines[i] + '\n';
  try {
    new Function(accumulated);
  } catch(e) {
    if (e.message.includes('Unexpected')) {
      console.log(`\n=== 错误发生在第 ${i+1} 行附近 ===`);
      console.log(`错误: ${e.message}`);
      console.log('\n最近 10 行:');
      for (let j = Math.max(0, i - 10); j <= i; j++) {
        console.log(`  ${String(j+1).padStart(3)}: ${lines[j]}`);
      }
      // 打印整行的每个字符
      console.log('\n第 ' + (i+1) + ' 行的字符分析:');
      const line = lines[i];
      for (let k = 0; k < line.length; k++) {
        const c = line[k];
        const code = line.charCodeAt(k);
        if (code === 39 || code === 34 || code === 8216 || code === 8217 || code === 8220 || code === 8221) {
          console.log(`  位置 ${k}: "${c}" (ASCII ${code})`);
        }
      }
      break;
    }
  }
}
