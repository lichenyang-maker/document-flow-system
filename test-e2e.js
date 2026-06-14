const http = require('http');

function httpRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function runTests() {
    console.log('\n===========================================');
    console.log('   🔍  端到端功能验证测试');
    console.log('===========================================\n');

    let failed = [];
    let passed = [];
    const host = 'localhost';
    const port = 3000;

    function check(name, res, expectedStatus = 200, checkJson = true) {
        const ok = res.status === expectedStatus && (!checkJson || res.json !== null);
        if (ok) passed.push(name);
        else failed.push({ name, status: res.status, body: res.body?.substring(0, 150) });
        console.log(`${ok ? '✅' : '❌'} ${name.padEnd(28)} → HTTP ${res.status}${checkJson ? (res.json ? ' JSON✓' : ' JSON❌') : ''}`);
        return ok;
    }

    // 1. 基础测试
    console.log('── 1. 基础服务检查 ──');
    const health = await httpRequest({ host, port, path: '/health', method: 'GET' });
    check('健康检查 /health', health);
    if (health.json) {
        console.log(`   └─ 统计: ${health.json.stats?.users || 0}用户 / ${health.json.stats?.documents || 0}公文 / ${health.json.stats?.leave_requests || 0}请假`);
        console.log(`   └─ AI: ${health.json.aiEnabled ? '已启用 ✓' : '未启用'}`);
    }

    const root = await httpRequest({ host, port, path: '/', method: 'GET' });
    check('主页面 /', root, 200, false);

    const chatPage = await httpRequest({ host, port, path: '/chat', method: 'GET' });
    check('AI助手页面 /chat', chatPage, 200, false);

    // 2. 登录测试
    console.log('\n── 2. 登录与认证 ──');
    const loginRes = await httpRequest(
        { host, port, path: '/api/public/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ username: 'admin', password: 'admin123' })
    );
    check('管理员登录', loginRes);

    let token = null;
    if (loginRes.json && loginRes.json.token) {
        token = loginRes.json.token;
        console.log(`   └─ Token: ${token.substring(0, 15)}...`);
    } else {
        console.log('   └─ ⚠️  未获取到 token，后续认证测试将跳过');
    }

    const authHeaders = token ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } : { 'Content-Type': 'application/json' };

    // 3. 用户信息
    console.log('\n── 3. 用户信息与统计 ──');
    if (token) {
        const me = await httpRequest({ host, port, path: '/api/auth/me', method: 'GET', headers: authHeaders });
        check('获取用户信息 /api/auth/me', me);

        const stats = await httpRequest({ host, port, path: '/api/stats', method: 'GET', headers: authHeaders });
        check('获取统计 /api/stats', stats);
    }

    // 4. 数据列表
    console.log('\n── 4. 数据列表 API ──');
    if (token) {
        const docs = await httpRequest({ host, port, path: '/api/docs', method: 'GET', headers: authHeaders });
        check('公文列表 /api/docs', docs);

        const leave = await httpRequest({ host, port, path: '/api/leave', method: 'GET', headers: authHeaders });
        check('请假列表 /api/leave', leave);

        const leaveStats = await httpRequest({ host, port, path: '/api/leave/stats', method: 'GET', headers: authHeaders });
        check('请假统计 /api/leave/stats', leaveStats);
    }

    // 5. 公文创建测试（这是之前 headers bug 会影响的功能）
    console.log('\n── 5. 写操作测试 (之前 headers bug 影响) ──');
    if (token) {
        const newDoc = await httpRequest(
            { host, port, path: '/api/docs', method: 'POST', headers: authHeaders },
            JSON.stringify({ title: '测试-' + Date.now(), content: '测试内容', type: 'NOTICE', priority: 'NORMAL' })
        );
        check('创建公文 POST /api/docs', newDoc);
        if (newDoc.json) console.log(`   └─ 返回: ${JSON.stringify(newDoc.json).substring(0, 80)}...`);

        const newLeave = await httpRequest(
            { host, port, path: '/api/leave', method: 'POST', headers: authHeaders },
            JSON.stringify({ type: '事假', startDate: '2024-12-01', endDate: '2024-12-01', days: 1, reason: '测试请假' })
        );
        check('申请请假 POST /api/leave', newLeave);
        if (newLeave.json) console.log(`   └─ 返回: ${JSON.stringify(newLeave.json).substring(0, 80)}...`);

        // 尝试审批
        const pendingLeave = await httpRequest({ host, port, path: '/api/leave', method: 'GET', headers: authHeaders });
        if (pendingLeave.json && pendingLeave.json.length > 0) {
            const pending = pendingLeave.json.find(l => l.status === 'PENDING');
            if (pending) {
                const approveRes = await httpRequest(
                    { host, port, path: `/api/leave/${pending.id}/approve`, method: 'POST', headers: authHeaders },
                    JSON.stringify({ comment: '同意' })
                );
                check(`审批请假 POST /api/leave/${pending.id}/approve`, approveRes);
            }
        }
    }

    // 6. AI 智能体
    console.log('\n── 6. AI 智能体系统 ──');
    const agents = await httpRequest({ host, port, path: '/api/agents', method: 'GET' });
    check('智能体列表 /api/agents', agents);
    if (agents.json && agents.json.agents) {
        console.log(`   └─ 可用: ${agents.json.agents.length} 个智能体`);
        agents.json.agents.forEach(a => console.log(`      · ${a.id}${a.name ? ' (' + a.name + ')' : ''}`));
    }

    if (token) {
        console.log('\n── 7. AI 对话测试 ──');
        const chatRes = await httpRequest(
            { host, port, path: '/api/agents/chat', method: 'POST', headers: authHeaders, timeout: 60000 },
            JSON.stringify({ agentId: 'general', message: '你好，请用一句话介绍你自己', conversationId: 'test_conv_' + Date.now() })
        );
        check('AI对话 POST /api/agents/chat', chatRes);
        if (chatRes.json) {
            console.log(`   └─ 模型: ${chatRes.json.model || 'unknown'}`);
            console.log(`   └─ 耗时: ${chatRes.json.elapsed || 'unknown'}ms, tokens: ${chatRes.json.tokens || 'unknown'}`);
            console.log(`   └─ 内容: ${(chatRes.json.content || '').substring(0, 120)}...`);
        }
    }

    // 总结
    console.log('\n===========================================');
    console.log(`📊 测试结果: ${passed.length} 通过 / ${failed.length} 失败`);
    console.log('===========================================\n');

    if (failed.length > 0) {
        console.log('❌ 失败项:');
        failed.forEach(f => console.log(`   - ${f.name} (HTTP ${f.status})`));
    }

    if (passed.length === 0 && failed.length === 0) {
        console.log('⚠️  没有运行任何测试 — 请先启动服务: node server-sqlite.js');
    }
}

// 增加超时处理
const originalRequest = http.request;
http.request = function(options, callback) {
    const req = originalRequest.call(http, options, callback);
    const timeout = options.timeout || 120000;
    req.setTimeout(timeout, () => { req.abort(); });
    return req;
};

runTests().catch(e => console.error('测试脚本错误:', e.message));
