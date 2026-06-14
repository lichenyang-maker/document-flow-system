const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];
const lines = js.split('\n');

// 检查每一行的单引号数量
console.log('检查单引号匹配 (前 50 行):');
let totalQuotes = 0;
for (let i = 0; i < 50; i++) {
  if (i >= lines.length) break;
  const line = lines[i];
  let count = 0;
  for (let k = 0; k < line.length; k++) {
    if (line.charCodeAt(k) === 39) count++;
  }
  totalQuotes += count;
  if (count > 0 || totalQuotes % 2 !== 0) {
    console.log(`  行${i+1}: 单引号=${count}, 累计=${totalQuotes}${totalQuotes % 2 !== 0 ? ' ⚠️ 奇数' : ''}`);
    console.log(`    ${line}`);
  }
}

// 更精确地：逐段查找问题
console.log('\n=== 逐块测试 ===');
let testCode = '';
for (let i = 0; i < lines.length; i++) {
  testCode += lines[i] + '\n';
  try {
    new Function(testCode);
  } catch(e) {
    if (e.message.includes('Unexpected') || e.message.includes('Unterminated')) {
      console.log(`\n❌ 问题在第 ${i+1} 行之后`);
      console.log(`错误: ${e.message}`);
      console.log('\n最近 15 行:');
      for (let j = Math.max(0, i-15); j <= i; j++) {
        console.log(`  ${j+1}: ${lines[j]}`);
      }
      break;
    }
  }
}
