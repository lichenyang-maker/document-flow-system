const fs = require('fs');
const buf = fs.readFileSync('d:/document-flow-system/public/chat.html');
const html = buf.toString('utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];
const lines = js.split('\n');

// 精确检查 formatMarkdown 函数（第 32-78 行，JS 代码中的位置）
// 对应 HTML 中的行大约是 922-969
console.log('=== 检查 formatMarkdown 函数 (JS 代码行 32-78) ===');

// 找到 formatMarkdown 函数的位置
let startLine = -1, endLine = -1;
let braceCount = 0;
let started = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function formatMarkdown')) {
    started = true;
    startLine = i;
    braceCount = 0;
  }
  if (started) {
    for (let j = 0; j < lines[i].length; j++) {
      if (lines[i][j] === '{') braceCount++;
      if (lines[i][j] === '}') braceCount--;
    }
    if (braceCount === 0 && i > startLine) {
      endLine = i;
      break;
    }
  }
}

console.log(`函数范围: JS 代码行 ${startLine+1} - ${endLine+1}`);
console.log('');

// 详细检查这个区域的括号
let paren = 0, brace = 0, bracket = 0;
let inSingle = false, inDouble = false, inTemplate = false;

for (let i = startLine; i <= endLine; i++) {
  const line = lines[i];
  let lineHasChange = false;
  let startParen = paren, startBrace = brace, startBracket = bracket;
  
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (inSingle) {
      if (ch === "'" && line[j-1] !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && line[j-1] !== '\\') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '`' && line[j-1] !== '\\') inTemplate = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }
    
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === '{') brace++;
    if (ch === '}') brace--;
    if (ch === '[') bracket++;
    if (ch === ']') bracket--;
  }
  
  if (paren !== startParen || brace !== startBrace || bracket !== startBracket) {
    lineHasChange = true;
  }
  
  console.log(`JS行${String(i+1).padStart(3)} ():${String(paren).padStart(2)} {}:${String(brace).padStart(2)} []:${String(bracket).padStart(2)}  ${line}`);
}

console.log('\n=== 函数末尾括号计数 ===');
console.log(`  (): ${paren}`);
console.log(`  {}: ${brace}`);
console.log(`  []: ${bracket}`);
if (inSingle) console.log('  ⚠️ 单引号未闭合');
if (inDouble) console.log('  ⚠️ 双引号未闭合');
if (inTemplate) console.log('  ⚠️ 模板字符串未闭合');
