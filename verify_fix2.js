const fs = require('fs');
const buf = fs.readFileSync('d:/document-flow-system/public/chat.html');
const html = buf.toString('utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];

try {
  const vm = require('vm');
  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      getElementById: () => ({ innerHTML: '', appendChild: () => {}, style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, querySelector: () => null, querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0, dataset: {}, value: '', textContent: '', focus: () => {} }),
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
  console.log('✅ JS 代码解析成功！');
  console.log('\n=== 关键函数验证 ===');
  console.log('  quickSwitchAgent:', typeof sandbox.quickSwitchAgent === 'function' ? '✅ 存在' : '❌ 不存在');
  console.log('  sendMessage:', typeof sandbox.sendMessage === 'function' ? '✅ 存在' : '❌ 不存在');
  console.log('  selectAgent:', typeof sandbox.selectAgent === 'function' ? '✅ 存在' : '❌ 不存在');
} catch(e) {
  console.log('❌ JS 错误:', e.message);
  const lines = js.split('\n');
  const m = e.stack.match(/<anonymous>:(\d+)/);
  if (m) {
    const lineNum = parseInt(m[1]);
    console.log(`\n错误发生在第 ${lineNum} 行:`);
    for (let j = Math.max(0, lineNum - 5); j < Math.min(lines.length, lineNum + 3); j++) {
      console.log(`  ${j+1}: ${lines[j]}`);
    }
  }
}
