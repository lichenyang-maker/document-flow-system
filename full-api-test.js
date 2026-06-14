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
            headers: { ...(options.headers || {}) }
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
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function runTests() {
    console.log('\n\n===========================================');
    console.log('   🔍  前端 API 全链路测试');
    console.log('===========================================\n');

    let failed = [];
    let passed = [];

    function check(name, res, expectedStatus = 200, checkJson = true) {
        const ok = res.status === expectedStatus && (!checkJson || res.json !== null);
        if (ok) passed.push(name);
        else failed.push({ name, status: res.status, body: res.body?.substring(0, 200) });
        console.log(`${ok ? '✅' : '❌'} ${name.padEnd(30)} → HTTP ${res.status}${checkJson ? (res.json ? ' JSON✓' : ' JSON❌') : ''}`);
        return ok;
    }

    // 1. 登录
    console.log('── 1. 登录流程 ──');
    const loginRes = await request('/api/public/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    check('POST /api/public/login', loginRes);
    token = loginRes.json?.token || '';
    if (token) console.log(`   token: ${token.substring(0, 30)}...`);
    else console.log('   ❌ 无 token 返回');

    // 2. 用户信息
    console.log('\n── 2. 用户信息 ──');
    const me = await request('/api/auth/me');
    check('GET /api/auth/me', me);
    if (me.json) console.log(`   user: ${me.json.name}, role: ${me.json.role}`);

    // 3. Dashboard 相关 API
    console.log('\n── 3. Dashboard 相关 API ──');
    const stats = await request('/api/stats');
    check('GET /api/stats', stats);
    if (stats.json) console.log(`   数据: ${JSON.stringify(stats.json).substring(0, 150)}`);

    // 4. 文档列表
    console.log('\n── 4. 文档 API ──');
    const docs = await request('/api/docs?limit=5');
    check('GET /api/docs?limit=5', docs);
    if (docs.json) console.log(`   数量: ${Array.isArray(docs.json) ? docs.json.length : '非数组'}`);
    if (Array.isArray(docs.json) && docs.json.length > 0) {
        console.log(`   第一条: id=${docs.json[0].id}, title=${(docs.json[0].title || '').substring(0, 20)}, status=${docs.json[0].status}`);
    }

    // 5. 创建文档
    console.log('\n── 5. 创建文档 ──');
    const createDoc = await request('/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '测试文档-' + Date.now(), content: '这是测试内容', type: 'NOTICE', priority: 'NORMAL' })
    });
    check('POST /api/docs', createDoc, 200, false);
    console.log(`   返回: ${createDoc.body.substring(0, 150)}`);

    // 6. 请假 API
    console.log('\n── 6. 请假 API ──');
    const leave = await request('/api/leave?limit=20');
    check('GET /api/leave', leave);
    if (leave.json) console.log(`   数量: ${Array.isArray(leave.json) ? leave.json.length : '非数组'}`);
    if (Array.isArray(leave.json) && leave.json.length > 0) {
        console.log(`   第一条: id=${leave.json[0].id}, type=${leave.json[0].type}, status=${leave.json[0].status}`);
    }

    const leaveStats = await request('/api/leave/stats');
    check('GET /api/leave/stats', leaveStats);
    if (leaveStats.json) console.log(`   ${JSON.stringify(leaveStats.json)}`);

    // 7. 请假审批
    console.log('\n── 7. 请假审批 ──');
    if (Array.isArray(leave.json) && leave.json.length > 0) {
        const pendingLeave = leave.json.find(l => l.status === 'PENDING') || leave.json[0];
        if (pendingLeave && pendingLeave.id) {
            const approveRes = await request('/api/leave/' + pendingLeave.id + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment: '同意' })
            });
            check(`POST /api/leave/${pendingLeave.id}/approve`, approveRes, 200, false);
            console.log(`   返回: ${approveRes.body.substring(0, 150)}`);
        }
    }

    // 8. AI 智能体 API
    console.log('\n── 8. AI 智能体 API ──');
    const agents = await request('/api/agents');
    check('GET /api/agents', agents);
    if (agents.json && agents.json.agents) {
        console.log(`   可用智能体: ${agents.json.agents.length} 个`);
        agents.json.agents.forEach(a => console.log(`     · ${a.id} (${a.model || '-'})`));
    }

    // 9. AI 聊天（需要等待真实响应，可能较慢）
    console.log('\n── 9. AI 单智能体聊天 ──');
    const chatRes = await request('/api/agents/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'general', message: '你好，请用一句话介绍自己', conversationId: 'test_' + Date.now() })
    });
    console.log(`   请求已发送，状态: ${chatRes.status}`);
    console.log(`   返回体: ${chatRes.body.substring(0, 300)}`);
    if (chatRes.json) {
        console.log(`   success: ${chatRes.json.success}, content长度: ${chatRes.json.content?.length || 0}`);
        if (chatRes.json.success) passed.push('POST /api/agents/chat');
        else failed.push({ name: 'POST /api/agents/chat', status: chatRes.status, body: chatRes.body.substring(0, 150) });
    } else {
        failed.push({ name: 'POST /api/agents/chat', status: chatRes.status, body: '无JSON' });
    }

    // 10. AI 协作（序列）
    console.log('\n── 10. AI 协作模式 ──');
    const collabRes = await request('/api/agents/collaboration/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: '帮我评估一个简单的业务问题',
            mode: 'sequential',
            agents: ['general', 'document', 'data'],
            sessionId: 'collab_test_' + Date.now()
        })
    });
    console.log(`   请求已发送，状态: ${collabRes.status}`);
    console.log(`   返回体: ${collabRes.body.substring(0, 300)}`);
    if (collabRes.json) {
        console.log(`   success: ${collabRes.json.success}`);
        if (collabRes.json.success) passed.push('POST /api/agents/collaboration/execute');
        else failed.push({ name: 'POST /api/agents/collaboration/execute', status: collabRes.status, body: collabRes.body.substring(0, 150) });
    } else {
        failed.push({ name: 'POST /api/agents/collaboration/execute', status: collabRes.status, body: '无JSON' });
    }

    // 总结
    console.log('\n\n===========================================');
    console.log(`   📊 测试结果: ${passed.length} 通过 / ${failed.length} 失败`);
    console.log('===========================================\n');
    if (failed.length > 0) {
        console.log('❌ 失败项:');
        failed.forEach(f => console.log(`   - ${f.name} (HTTP ${f.status})`));
    } else {
        console.log('🎉 所有关键 API 均正常工作！');
        console.log('   浏览器访问 http://localhost:3000/ 登录: admin / admin123');
        console.log('   AI助手: http://localhost:3000/chat');
    }

    setTimeout(() => { serverProcess.kill(); setTimeout(() => process.exit(0), 500); }, 1000);
}
