const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const serverProcess = spawn('node', [path.join(__dirname, 'server-sqlite.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
});

let started = false;
let output = '';

function onData(data) {
    output += data.toString();
    process.stdout.write(data.toString());
    if (!started && data.toString().includes('服务已启动')) {
        started = true;
        setTimeout(runTests, 2000);
    }
}
serverProcess.stdout.on('data', onData);
serverProcess.stderr.on('data', onData);
serverProcess.on('error', (err) => { console.log('子进程错误:', err.message); });
setTimeout(() => { if (!started) { console.log('⏱️ 启动超时'); runTests(); } }, 15000);

let token = '';
function request(pathname, options = {}) {
    return new Promise((resolve) => {
        const opts = {
            hostname: '127.0.0.1', port: 3000, path: pathname,
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        };
        if (token) opts.headers['Authorization'] = 'Bearer ' + token;
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: data, json: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data, json: null }); }
            });
        });
        req.on('error', (e) => { resolve({ status: 'error', body: e.message, json: null }); });
        req.setTimeout(15000, () => { req.destroy(); resolve({ status: 'timeout', body: 'timeout', json: null }); });
        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
    });
}

async function runTests() {
    console.log('\n\n===========================================');
    console.log('   📊  Stats Agent 统计智能体测试');
    console.log('===========================================\n');

    let failed = [];
    let passed = [];

    function check(name, res, expectedStatus = 200, checkJson = true) {
        const ok = res.status === expectedStatus && (!checkJson || res.json !== null);
        if (ok) passed.push(name);
        else { failed.push(name); console.log(`  ❌ ${name}: status=${res.status}, body=${res.body.substring(0, 200)}`); }
        return ok;
    }

    // 1. 登录
    console.log('--- 1. 登录获取 token ---');
    const login = await request('/api/public/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    if (check('登录', login, 200, true)) {
        token = login.json?.token || login.json?.accessToken || (typeof login.json === 'string' ? login.json : '');
        console.log('  ✅ token:', token.substring(0, 30) + '...');
    }

    // 2. 测试基础统计 API
    console.log('\n--- 2. 基础统计 API ---');
    const stats = await request('/api/stats');
    check('GET /api/stats', stats, 200, true);
    if (stats.json) {
        console.log('  📊 系统总览:', {
            totalUsers: stats.json.totalUsers,
            totalDocs: stats.json.totalDocs,
            totalLeave: stats.json.totalLeave,
            pendingDocs: stats.json.pendingDocs,
            pendingLeave: stats.json.pendingLeave
        });
    }

    const balance = await request('/api/stats/balance');
    check('GET /api/stats/balance (假期余额)', balance, 200, true);
    if (balance.json) {
        console.log('  🌴 假期余额:', {
            userName: balance.json.userName,
            annual: balance.json.balance?.annual,
            sick: balance.json.balance?.sick,
            personal: balance.json.balance?.personal
        });
    }

    const myLeave = await request('/api/stats/my-leave');
    check('GET /api/stats/my-leave (我的请假)', myLeave, 200, true);
    if (myLeave.json) {
        console.log('  📋 我的请假数量:', myLeave.json.total);
    }

    const pending = await request('/api/stats/pending');
    check('GET /api/stats/pending (待审批)', pending, 200, true);
    if (pending.json) {
        console.log('  ⏳ 待审批公文:', pending.json.pendingDocs?.count, '份');
        console.log('  ⏳ 待审批请假:', pending.json.pendingLeave?.count, '份');
    }

    // 3. 测试自然语言统计查询（Stats Agent 核心）
    console.log('\n--- 3. Stats Agent 自然语言查询 ---');

    const testQueries = [
        '我还剩几天年假',
        '本周有多少请假',
        '本月请假情况',
        '我的请假记录',
        '有多少待审批',
        '公文统计',
        '统计一下系统总览',
        '有多少用户'
    ];

    for (const q of testQueries) {
        console.log(`\n  🔍 查询: "${q}"`);
        const res = await request('/api/stats/query', { method: 'POST', body: { message: q } });
        const ok = check(`查询: ${q}`, res, 200, true);
        if (ok && res.json) {
            console.log('    📝 查询类型:', res.json.queryType);
            console.log('    📊 数据用户:', res.json.userName);
            // 只打印前 200 字符
            const text = (res.json.text || '').substring(0, 200);
            console.log('    💬 AI 回复:', text.replace(/\n/g, ' '));
        }
    }

    // 4. 测试 Data Agent 聊天接口（集成数据查询）
    console.log('\n--- 4. Data Agent 聊天接口（/api/agents/chat）---');
    const chatTests = [
        { agentId: 'data', message: '我还剩几天年假' },
        { agentId: 'data', message: '本周有多少请假' },
        { agentId: 'data', message: '统计一下' },
    ];

    for (const t of chatTests) {
        console.log(`\n  🔍 Agent=${t.agentId}, query="${t.message}"`);
        const res = await request('/api/agents/chat', {
            method: 'POST',
            body: { agentId: t.agentId, message: t.message, conversationId: 'test_data_agent' }
        });
        const ok = check(`Data Agent chat: ${t.message}`, res, 200, true);
        if (ok && res.json) {
            console.log('    ✅ success:', res.json.success);
            console.log('    💬 content:', (res.json.content || '').substring(0, 200).replace(/\n/g, ' '));
        }
    }

    // 5. 测试意图识别
    console.log('\n--- 5. 意图识别 ---');
    const intentTests = [
        '我还剩几天年假',
        '我要请3天假',
        '帮我写一份采购申请',
        '提醒张三开会',
        '本周请假情况'
    ];

    for (const msg of intentTests) {
        const res = await request('/api/agents/classify', { method: 'POST', body: { message: msg } });
        console.log(`  "${msg}" => 意图: ${res.json?.agent || 'unknown'}`);
    }

    // 总结
    console.log('\n===========================================');
    console.log(`   ✅ 测试结果: ${passed.length} 通过, ${failed.length} 失败`);
    console.log('===========================================');
    if (failed.length > 0) {
        console.log('   ❌ 失败项:', failed.join(', '));
        process.exit(1);
    }

    // 关闭服务器
    setTimeout(() => {
        try { serverProcess.kill(); } catch (e) {}
        process.exit(0);
    }, 1000);
}
