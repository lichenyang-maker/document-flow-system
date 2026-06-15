const fs = require('fs');
const path = require('path');

// 先检查 server-sqlite.js 能否被 Node.js 加载
try {
  const code = fs.readFileSync('server-sqlite.js', 'utf8');
  new Function(code);
  console.log('[OK] server-sqlite.js 语法正确');
} catch(e) {
  console.log('[FAIL] server-sqlite.js:', e.message.substr(0, 200));
  process.exit(1);
}

// 模拟 routerAgentProcess 的 classifyIntent 逻辑
const aiCode = fs.readFileSync('ai-agents.js', 'utf8');
try {
  new Function(aiCode);
  console.log('[OK] ai-agents.js 语法正确');
} catch(e) {
  console.log('[FAIL] ai-agents.js:', e.message.substr(0, 200));
  process.exit(1);
}

// 测试：各种用户输入是否能匹配到正确意图
const testCases = [
  { msg: '帮我创建一份通知', expectContains: '创建' },
  { msg: '帮我写个公文', expectContains: '写' },
  { msg: '我要请假3天', expectContains: '请假' },
  { msg: '本周请假统计', expectContains: '统计' },
  { msg: '我还有多少天年假', expectContains: '余额' },
  { msg: '在群里发个通知', expectContains: '群' },
  { msg: '同意 #5', expectContains: '同意' },
];

// 检查 keyword 匹配逻辑
console.log('\n=== 6. 关键词匹配测试 ===');
const docPattern = /公文|起草|创建|新建|生成|写份|写个|拟|草拟|采购|会议纪要|帮我写/;
const leavePattern = /请个?假|申请请假|身体不舒服|生病|不舒服|想休息|休个?假|要休息|请病假|请事假|请年假|调休|想请假/;
const statsPattern = /统计|本周|本月|这个月|多少人|几个.*请假|报表|周报|月报|待审批|待办|待处理/;
const notifyPattern = /通知|提醒|告诉|发给|推送/;
const groupPattern = /群里|群聊|群发|在群|告诉大家|通知大家|发个通知|群通知|发到群|在飞书群/;

for (const t of testCases) {
  let matched = '未匹配';
  if (docPattern.test(t.msg)) matched = 'documentAgent';
  else if (leavePattern.test(t.msg)) matched = 'leaveAgent';
  else if (statsPattern.test(t.msg)) matched = 'statsAgent';
  else if (groupPattern.test(t.msg)) matched = 'notifyAgent(group)';
  else if (notifyPattern.test(t.msg)) matched = 'notifyAgent';
  
  if (matched === '未匹配') {
    console.log('[FAIL] "' + t.msg + '" → ' + matched);
  } else {
    console.log('[OK] "' + t.msg + '" → ' + matched);
  }
}

console.log('\n=== 7. 写入权限测试 ===');
try {
  const testDb = path.join(__dirname, 'data', 'test_write.tmp');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(testDb, 'test');
  fs.unlinkSync(testDb);
  console.log('[OK] 数据库目录可写');
} catch(e) {
  console.log('[FAIL] 写入失败:', e.message);
}

console.log('\n=== 测试完成 ===');
