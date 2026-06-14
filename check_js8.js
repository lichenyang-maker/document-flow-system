const fs = require('fs');

// 用最严格的方式读取
const buf = fs.readFileSync('d:/document-flow-system/public/chat.html');
// 作为 UTF-8 解析  
const html = buf.toString('utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];

// 打印整个 JS 代码的前 15 行，看是否有隐藏字符
const lines = js.split('\n');
console.log('=== 前 20 行原始内容 ===');
for (let i = 0; i < Math.min(20, lines.length); i++) {
  const line = lines[i];
  let hasHidden = false;
  for (let k = 0; k < line.length; k++) {
    const code = line.charCodeAt(k);
    if ((code < 32 && code !== 9) || code === 127 || (code >= 0x80 && code < 0xFF) || code === 0xFEFF || code === 0xFFFE) {
      hasHidden = true;
    }
  }
  console.log(`${String(i+1).padStart(2)}${hasHidden ? ' ⚠️' : '  '}: ${line}`);
}

// 现在直接用 acorn 风格的解析测试 - 用 vm 模块
console.log('\n=== 完整 JS 语法测试 ===');
try {
  const vm = require('vm');
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: () => ({ innerHTML: '', appendChild: () => {}, style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, querySelector: () => null, querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0, dataset: {}, value: '' }),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    alert: () => {},
    confirm: () => true,
    window: { location: { href: '' } },
    Set: Set,
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, agents: [] }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { displayErrors: true });
  console.log('✅ JS 代码执行成功！');
} catch(e) {
  console.log('❌ JS 错误:', e.message);
  // 尝试定位行号
  const m = e.stack.match(/<anonymous>:(\d+)/);
  if (m) {
    const lineNum = parseInt(m[1]);
    console.log(`\n错误发生在第 ${lineNum} 行:`);
    for (let j = Math.max(0, lineNum - 5); j < Math.min(lines.length, lineNum + 3); j++) {
      console.log(`  ${j+1}: ${lines[j]}`);
    }
  }
}
