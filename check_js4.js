const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];

// 模拟浏览器环境
const mockLocalStorage = {
  getItem: (k) => k === 'token' ? 'test_token' : null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {}
};

const mockElement = {
  innerHTML: '',
  style: {},
  classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  appendChild: () => {},
  remove: () => {},
  querySelector: () => ({ textContent: '' }),
  querySelectorAll: () => [],
  scrollTop: 0,
  scrollHeight: 100,
  dataset: {},
  value: ''
};

const mockDoc = {
  getElementById: () => mockElement,
  querySelector: () => mockElement,
  querySelectorAll: () => []
};

const mockAlert = (msg) => console.log('[ALERT]', msg);
const mockConfirm = () => true;

const globals = {
  localStorage: mockLocalStorage,
  document: mockDoc,
  alert: mockAlert,
  confirm: mockConfirm,
  window: { location: { href: '' } },
  Set: Set,
  fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ success: true, agents: [] }), text: () => Promise.resolve('') })
};

const ctx = { ...globals };
try {
  const fn = new Function(...Object.keys(ctx), js);
  fn(...Object.values(ctx));
  console.log('=== JS 执行通过 ===');
} catch(e) {
  console.log('JS 错误:', e.message);
  console.log('堆栈:', e.stack);
}
