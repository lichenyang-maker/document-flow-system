const fs = require('fs');
const buf = fs.readFileSync('d:/document-flow-system/public/chat.html');
const html = buf.toString('utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];

// 用 vm 模块测试
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
  console.log('✅ JS 代码解析和执行成功！');
  
  // 验证关键函数存在
  console.log('\n=== 关键函数验证 ===');
  console.log('  sendMessage:', typeof sandbox.sendMessage === 'function' ? '✅ 存在' : '❌ 不存在');
  console.log('  checkAuth:', typeof sandbox.checkAuth === 'function' ? '✅ 存在' : '❌ 不存在');
  console.log('  loadAgents:', typeof sandbox.loadAgents === 'function' ? '✅ 存在' : '❌ 不存在');
  console.log('  formatMarkdown:', typeof sandbox.formatMarkdown === 'function' ? '✅ 存在' : '❌ 不存在');
  console.log('  clearChat:', typeof sandbox.clearChat === 'function' ? '✅ 存在' : '❌ 不存在');
  
  // 测试 formatMarkdown
  console.log('\n=== formatMarkdown 测试 ===');
  const test1 = sandbox.formatMarkdown('## 测试标题');
  console.log('  标题测试:', test1.includes('md-h2') ? '✅ 正确' : '❌ 失败');
  const test2 = sandbox.formatMarkdown('- 列表项 1\n- 列表项 2');
  console.log('  列表测试:', test2.includes('md-ul') ? '✅ 正确' : '❌ 失败');
  const test3 = sandbox.formatMarkdown('> 引用内容');
  console.log('  引用测试:', test3.includes('md-quote') ? '✅ 正确' : '❌ 失败');
  
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
