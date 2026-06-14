const fs = require('fs');
const buf = fs.readFileSync('d:/document-flow-system/public/chat.html');
const html = buf.toString('utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];
const lines = js.split('\n');

// 检查括号和引号匹配
let depth = { paren: 0, bracket: 0, brace: 0 };
let inString = null;
let inTemplateString = false;
let stringStart = { line: 0, col: 0, type: null };

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const code = line.charCodeAt(j);
    
    // 字符串处理
    if (inString) {
      if (ch === inString && line[j-1] !== '\\') {
        inString = null;
      }
      continue;
    }
    if (inTemplateString) {
      if (ch === '`' && line[j-1] !== '\\') {
        inTemplateString = false;
      }
      continue;
    }
    
    if (ch === "'" || ch === '"') {
      inString = ch;
      stringStart = { line: i+1, col: j+1, type: ch };
      continue;
    }
    if (ch === '`') {
      inTemplateString = true;
      stringStart = { line: i+1, col: j+1, type: 'template' };
      continue;
    }
    
    // 括号处理
    if (ch === '(') depth.paren++;
    if (ch === ')') depth.paren--;
    if (ch === '[') depth.bracket++;
    if (ch === ']') depth.bracket--;
    if (ch === '{') depth.brace++;
    if (ch === '}') depth.brace--;
    
    // 检测负值（多余的闭括号）
    if (depth.paren < 0) { console.log(`行 ${i+1} 列 ${j+1}: 多余的 ')'`); depth.paren = 0; }
    if (depth.bracket < 0) { console.log(`行 ${i+1} 列 ${j+1}: 多余的 ']'`); depth.bracket = 0; }
    if (depth.brace < 0) { console.log(`行 ${i+1} 列 ${j+1}: 多余的 '}'`); depth.brace = 0; }
  }
}

console.log('\n最终深度计数:');
console.log(`  (): ${depth.paren}`);
console.log(`  []: ${depth.bracket}`);
console.log(`  {}: ${depth.brace}`);

if (inString) {
  console.log(`\n⚠️ 字符串未闭合! 从行 ${stringStart.line} 列 ${stringStart.col} 的 ${stringStart.type} 开始`);
}
if (inTemplateString) {
  console.log(`\n⚠️ 模板字符串未闭合! 从行 ${stringStart.line} 列 ${stringStart.col} 开始`);
}

// 更精确地：找模板字符串 ` 未闭合的地方
console.log('\n=== 检查模板字符串 ===');
let backtickCount = 0;
let backtickPositions = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    if (line.charCodeAt(j) === 96) {
      backtickCount++;
      backtickPositions.push({ line: i+1, col: j+1 });
    }
  }
}
console.log(`模板字符串 (\`) 总数: ${backtickCount}`);
if (backtickCount % 2 !== 0) {
  console.log('⚠️ 模板字符串数量是奇数！有一个未闭合');
  console.log('位置:');
  backtickPositions.forEach((p, idx) => {
    console.log(`  ${idx+1}. 行 ${p.line} 列 ${p.col}: ${lines[p.line-1].substring(Math.max(0, p.col-10), p.col+20)}`);
  });
}
