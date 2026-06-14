// ========================================
// 公文流转系统 - 全功能测试脚本 (Node.js)
// ========================================
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:3000';
let pass = 0;
let fail = 0;

function test(name, ok, detail) {
    if (ok) { pass++; console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`); }
    else { fail++; console.log(`  \x1b[31m[FAIL]\x1b[0m ${name} - ${detail || ''}`); }
}

function fetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(url, { method: opts.method || 'GET', headers: opts.headers || {}, timeout: opts.timeout || 15000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data), text: data }); }
                catch (e) { resolve({ status: res.statusCode, text: data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (opts.body) req.write(JSON.stringify(opts.body));
        req.end();
    });
}

async function main() {
    console.log('\n\x1b[36m========================================\x1b[0m');
    console.log('\x1b[36m  公文流转系统 - 全功能测试\x1b[0m');
    console.log('\x1b[36m========================================\x1b[0m\n');

    // ========================================
    // Part 1: 飞书 API 凭证测试
    // ========================================
    console.log('\x1b[33m--- Part 1: 飞书 API 凭证测试 ---\x1b[0m');
    
    let feishuToken = null;
    try {
        const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { app_id: 'cli_aaa152828fb95bda', app_secret: '61tkmvxLdXZ2Tx0m4AgZFez4CC0xvzjx' }
        });
        if (r.data && r.data.code === 0) {
            test('飞书 Tenant Token 获取', true, 'code=' + r.data.code);
            feishuToken = r.data.tenant_access_token;
            
            // 测试发送消息
            const msg = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + feishuToken, 'Content-Type': 'application/json' },
                body: { receive_id: 'oc_a30a910385446ce307f8eb5436050ad1', msg_type: 'text', content: JSON.stringify({text:'【系统测试】公文流转系统全功能测试 - 飞书消息发送正常'}) }
            });
            test('飞书消息发送', msg.data && msg.data.code === 0, msg.data ? 'code='+msg.data.code : msg.text);
        } else {
            test('飞书 Tenant Token 获取', false, JSON.stringify(r.data));
        }
    } catch(e) {
        test('飞书 API 连接', false, e.message);
    }

    // ========================================
    // Part 2: 启动服务器
    // ========================================
    console.log('\n\x1b[33m--- Part 2: 启动服务器 ---\x1b[0m');
    
    const server = spawn('node', ['server-sqlite.js'], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: '3000' }
    });
    
    let serverOutput = '';
    server.stdout.on('data', d => serverOutput += d.toString());
    server.stderr.on('data', d => serverOutput += d.toString());
    
    await new Promise(r => setTimeout(r, 4000));
    
    // 检查健康
    try {
        const health = await fetch(BASE + '/health', { timeout: 5000 });
        test('服务器启动 (健康检查)', health.status === 200, JSON.stringify(health.data).substring(0,200));
    } catch(e) {
        test('服务器启动 (健康检查)', false, e.message);
        console.log('  服务器输出: ' + serverOutput.substring(0, 500));
    }

    // ========================================
    // Part 3: 页面路由测试
    // ========================================
    console.log('\n\x1b[33m--- Part 3: 页面路由测试 ---\x1b[0m');
    
    const pages = [
        { name: '首页', path: '/' },
        { name: 'AI聊天', path: '/chat' },
        { name: '飞书', path: '/feishu' },
        { name: '飞书聊天', path: '/feishu-chat' }
    ];
    
    for (const p of pages) {
        try {
            const res = await fetch(BASE + p.path, { timeout: 5000 });
            test('页面: ' + p.name, res.status === 200, 'status=' + res.status);
        } catch(e) {
            test('页面: ' + p.name, false, e.message);
        }
    }

    // ========================================
    // Part 4: 登录 API
    // ========================================
    console.log('\n\x1b[33m--- Part 4: 登录 API 测试 ---\x1b[0m');
    
    let token = null;
    let headers = {};
    
    try {
        const login = await fetch(BASE + '/api/public/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { username: 'admin', password: 'admin123' }
        });
        if (login.data && login.data.token) {
            token = login.data.token;
            headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
            test('登录 (admin)', true, 'token: ' + token.substring(0,20) + '...');
        } else {
            test('登录 (admin)', false, JSON.stringify(login.data));
        }
    } catch(e) {
        test('登录 (admin)', false, e.message);
    }
    
    if (token) {
        try {
            const me = await fetch(BASE + '/api/auth/me', { headers });
            test('获取用户信息', me.data && me.data.username === 'admin', 'username=' + (me.data ? me.data.username : 'null'));
        } catch(e) {
            test('获取用户信息', false, e.message);
        }
    }

    // ========================================
    // Part 5: 统计 API
    // ========================================
    console.log('\n\x1b[33m--- Part 5: 统计 API 测试 ---\x1b[0m');
    
    if (token) {
        try {
            const stats = await fetch(BASE + '/api/stats', { headers });
            test('系统统计', stats.data != null, JSON.stringify(stats.data).substring(0,150));
        } catch(e) { test('系统统计', false, e.message); }
        
        try {
            const balance = await fetch(BASE + '/api/stats/balance', { headers });
            test('假期余额', balance.data != null, JSON.stringify(balance.data).substring(0,100));
        } catch(e) { test('假期余额', false, e.message); }
        
        try {
            const myLeave = await fetch(BASE + '/api/stats/my-leave', { headers });
            test('我的请假', myLeave.data != null, 'ok');
        } catch(e) { test('我的请假', false, e.message); }
        
        try {
            const pending = await fetch(BASE + '/api/stats/pending', { headers });
            test('待审批列表', pending.data != null, 'ok');
        } catch(e) { test('待审批列表', false, e.message); }
        
        const queries = ['balance', 'my-leave', 'pending', 'docs'];
        for (const q of queries) {
            try {
                const qr = await fetch(BASE + '/api/stats/query', { method: 'POST', headers, body: { query: q }, timeout: 15000 });
                test('自然语言查询: ' + q, qr.data != null, 'ok');
            } catch(e) { test('自然语言查询: ' + q, false, e.message); }
        }
    }

    // ========================================
    // Part 6: 公文 API
    // ========================================
    console.log('\n\x1b[33m--- Part 6: 公文 API 测试 ---\x1b[0m');
    
    if (token) {
        try {
            const docs = await fetch(BASE + '/api/docs', { headers });
            test('公文列表', docs.data != null, 'ok');
        } catch(e) { test('公文列表', false, e.message); }
        
        try {
            const newDoc = await fetch(BASE + '/api/docs', {
                method: 'POST', headers,
                body: { title: '【测试】测试公文', content: '自动测试创建', type: '通知', priority: '普通' }
            });
            test('创建公文', newDoc.data != null, 'id=' + (newDoc.data ? newDoc.data.id : 'null'));
        } catch(e) { test('创建公文', false, e.message); }
    }

    // ========================================
    // Part 7: 请假 API
    // ========================================
    console.log('\n\x1b[33m--- Part 7: 请假 API 测试 ---\x1b[0m');
    
    if (token) {
        try {
            const leaves = await fetch(BASE + '/api/leave', { headers });
            test('请假列表', leaves.data != null, 'ok');
        } catch(e) { test('请假列表', false, e.message); }
        
        try {
            const leaveStats = await fetch(BASE + '/api/leave/stats', { headers });
            test('请假统计', leaveStats.data != null, JSON.stringify(leaveStats.data).substring(0,100));
        } catch(e) { test('请假统计', false, e.message); }
        
        try {
            const newLeave = await fetch(BASE + '/api/leave', {
                method: 'POST', headers,
                body: { type: '年假', start_date: '2026-06-20', end_date: '2026-06-21', days: 2, reason: '【测试】自动测试' }
            });
            test('创建请假', newLeave.data != null, 'id=' + (newLeave.data ? newLeave.data.id : 'null'));
        } catch(e) { test('创建请假', false, e.message); }
    }

    // ========================================
    // Part 8: AI 智能体 API
    // ========================================
    console.log('\n\x1b[33m--- Part 8: AI 智能体 API 测试 ---\x1b[0m');
    
    if (token) {
        try {
            const agents = await fetch(BASE + '/api/agents');
            test('智能体列表', agents.data && agents.data.agents && agents.data.agents.length > 0, 
                'count=' + (agents.data ? agents.data.agents.length : 0));
        } catch(e) { test('智能体列表', false, e.message); }
        
        try {
            const chat = await fetch(BASE + '/api/agents/chat', {
                method: 'POST', headers, timeout: 30000,
                body: { agentId: 'general', message: '你好，简单回答', context: [] }
            });
            const ok = chat.data && (chat.data.reply || chat.data.success);
            test('AI 对话 (general)', ok, 'reply length=' + (chat.data && chat.data.reply ? chat.data.reply.length : 0));
        } catch(e) { test('AI 对话 (general)', false, e.message); }
        
        try {
            const classify = await fetch(BASE + '/api/agents/classify', {
                method: 'POST', headers, timeout: 20000,
                body: { message: '我想请年假3天' }
            });
            test('意图分类', classify.data && classify.data.intent, 'intent=' + (classify.data ? classify.data.intent : 'null'));
        } catch(e) { test('意图分类', false, e.message); }
        
        try {
            const dataChat = await fetch(BASE + '/api/agents/chat', {
                method: 'POST', headers, timeout: 30000,
                body: { agentId: 'data', message: '我的假期余额是多少', context: [] }
            });
            const ok = dataChat.data && (dataChat.data.reply || dataChat.data.success);
            test('AI 对话 (data agent)', ok, 'ok');
        } catch(e) { test('AI 对话 (data agent)', false, e.message); }
    }

    // ========================================
    // Part 9: 飞书集成 API
    // ========================================
    console.log('\n\x1b[33m--- Part 9: 飞书集成 API 测试 ---\x1b[0m');
    
    try {
        const feishuConfig = await fetch(BASE + '/api/feishu/config');
        test('飞书配置', feishuConfig.data != null, JSON.stringify(feishuConfig.data).substring(0,100));
    } catch(e) { test('飞书配置', false, e.message); }
    
    if (token) {
        try {
            const bindings = await fetch(BASE + '/api/feishu/bindings', { headers });
            test('飞书绑定列表', bindings.data != null, 'ok');
        } catch(e) { test('飞书绑定列表', false, e.message); }
        
        try {
            const notifyConfig = await fetch(BASE + '/api/notify/config', { headers });
            test('通知配置', notifyConfig.data != null, 'ok');
        } catch(e) { test('通知配置', false, e.message); }
    }

    // ========================================
    // Part 10: 多智能体协作 API
    // ========================================
    console.log('\n\x1b[33m--- Part 10: 多智能体协作 API 测试 ---\x1b[0m');
    
    if (token) {
        try {
            const modes = await fetch(BASE + '/api/agents/collaboration/modes');
            test('协作模式列表', modes.data && modes.data.modes, 'count=' + (modes.data && modes.data.modes ? modes.data.modes.length : 0));
        } catch(e) { test('协作模式列表', false, e.message); }
        
        try {
            const plan = await fetch(BASE + '/api/agents/collaboration/plan', {
                method: 'POST', headers, timeout: 30000,
                body: { task: '分析最近请假数据并生成报告', mode: 'sequential' }
            });
            test('协作计划生成', plan.data != null, 'ok');
        } catch(e) { test('协作计划生成', false, e.message); }
    }

    // ========================================
    // Part 11: 用户管理 API
    // ========================================
    console.log('\n\x1b[33m--- Part 11: 用户管理 API 测试 ---\x1b[0m');
    
    if (token) {
        try {
            const users = await fetch(BASE + '/api/users', { headers });
            test('用户列表', users.data != null, 'ok');
        } catch(e) { test('用户列表', false, e.message); }
    }

    // ========================================
    // 停止服务器
    // ========================================
    console.log('\n\x1b[33m--- 停止服务器 ---\x1b[0m');
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch(e) {} }, 2000);
    console.log('  服务器已停止');

    // ========================================
    // 总结
    // ========================================
    console.log('\n\x1b[36m========================================\x1b[0m');
    console.log('\x1b[36m  测试完成\x1b[0m');
    console.log('\x1b[36m========================================\x1b[0m');
    console.log('  \x1b[32m通过: ' + pass + '\x1b[0m');
    console.log('  \x1b[31m失败: ' + fail + '\x1b[0m');
    console.log('  总计: ' + (pass + fail));
    
    if (fail === 0) {
        console.log('\n  \x1b[32m[OK] 所有测试通过!\x1b[0m');
    } else {
        console.log('\n  \x1b[33m[WARN] 有 ' + fail + ' 个测试失败\x1b[0m');
    }
    
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('测试脚本异常:', e);
    process.exit(1);
});
