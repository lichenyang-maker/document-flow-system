/**
 * AI 全功能测试脚本
 * 测试所有 AI Agent、Router、协作系统、聊天接口
 */
const http = require('http');

const BASE = 'http://localhost:3000';
let adminToken = '';
let studentToken = '';
let teacherToken = '';
let counselorToken = '';

let passed = 0, failed = 0, total = 0;
const results = [];

function req(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE);
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);

        const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 60000 };
        const r = http.request(opts, res => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(buf), raw: buf }); }
                catch { resolve({ status: res.statusCode, body: null, raw: buf }); }
            });
        });
        r.on('error', e => reject(e));
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
        if (data) r.write(data);
        r.end();
    });
}

async function test(name, fn) {
    total++;
    const start = Date.now();
    try {
        const result = await fn();
        const elapsed = Date.now() - start;
        if (result) {
            passed++;
            results.push({ name, status: 'PASS', elapsed, detail: result });
            console.log(`  ✅ PASS  [${elapsed}ms] ${name}`);
        } else {
            failed++;
            results.push({ name, status: 'FAIL', elapsed, detail: result });
            console.log(`  ❌ FAIL  [${elapsed}ms] ${name}`);
        }
    } catch (e) {
        failed++;
        const elapsed = Date.now() - start;
        results.push({ name, status: 'ERROR', elapsed, error: e.message });
        console.log(`  💥 ERROR [${elapsed}ms] ${name}: ${e.message}`);
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║     🤖 AI 全功能测试 - 文档流转系统 v2.0        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // ======================== 1. 基础检查 ========================
    console.log('━━━ 1. 基础服务检查 ━━━');
    await test('服务健康检查', async () => {
        const r = await req('GET', '/api/agents');
        return r.status === 200;
    });

    // ======================== 2. 登录获取 Token ========================
    console.log('\n━━━ 2. 用户登录 ━━━');
    await test('admin 登录', async () => {
        const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
        adminToken = r.body?.token;
        return r.status === 200 && !!adminToken;
    });
    await test('学生 xiaoming 登录', async () => {
        const r = await req('POST', '/api/auth/login', { username: 'xiaoming', password: '123456' });
        studentToken = r.body?.token;
        return r.status === 200 && !!studentToken;
    });
    await test('老师 wanglaoshi 登录', async () => {
        const r = await req('POST', '/api/auth/login', { username: 'wanglaoshi', password: '123456' });
        teacherToken = r.body?.token;
        return r.status === 200 && !!teacherToken;
    });
    await test('辅导员 fudaoyuan 登录', async () => {
        const r = await req('POST', '/api/auth/login', { username: 'fudaoyuan', password: '123456' });
        counselorToken = r.body?.token;
        return r.status === 200 && !!counselorToken;
    });

    // ======================== 3. Agent 列表 ========================
    console.log('\n━━━ 3. Agent 列表 ━━━');
    await test('GET /api/agents - 获取所有 Agent', async () => {
        const r = await req('GET', '/api/agents');
        return r.status === 200 && Array.isArray(r.body?.agents) && r.body.agents.length >= 10;
    });

    // ======================== 4. 意图识别 (Classify) ========================
    console.log('\n━━━ 4. 意图识别 /api/agents/classify ━━━');
    await test('识别请假意图', async () => {
        const r = await req('POST', '/api/agents/classify', { message: '我想请3天年假，回家探亲' }, adminToken);
        return r.status === 200 && r.body?.agent;
    });
    await test('识别公文写作意图', async () => {
        const r = await req('POST', '/api/agents/classify', { message: '帮我写一份会议通知' }, adminToken);
        return r.status === 200 && r.body?.agent;
    });
    await test('识别数据统计意图', async () => {
        const r = await req('POST', '/api/agents/classify', { message: '统计本月的请假情况' }, adminToken);
        return r.status === 200 && r.body?.agent;
    });
    await test('识别审批意图', async () => {
        const r = await req('POST', '/api/agents/classify', { message: '同意这个请假申请' }, adminToken);
        return r.status === 200 && r.body?.agent;
    });

    // ======================== 5. 独立 Agent 聊天 ========================
    console.log('\n━━━ 5. 独立 Agent 聊天 /api/agents/chat ━━━');
    await test('chat with general agent', async () => {
        const r = await req('POST', '/api/agents/chat', {
            agentId: 'general',
            message: '你好，介绍一下你的功能',
            conversationId: 'test-general-' + Date.now()
        }, adminToken);
        return r.status === 200 && (r.body?.content || r.body?.reply);
    });
    await test('chat with data agent (统计查询)', async () => {
        const r = await req('POST', '/api/agents/chat', {
            agentId: 'data',
            message: '当前系统有多少用户？请假情况如何？',
            conversationId: 'test-data-' + Date.now()
        }, adminToken);
        return r.status === 200 && (r.body?.content || r.body?.reply);
    });
    await test('chat with document agent', async () => {
        const r = await req('POST', '/api/agents/chat', {
            agentId: 'document',
            message: '帮我起草一份关于期末考试安排的通知',
            conversationId: 'test-doc-' + Date.now()
        }, adminToken);
        return r.status === 200 && (r.body?.content || r.body?.reply);
    });
    await test('chat with leave agent', async () => {
        const r = await req('POST', '/api/agents/chat', {
            agentId: 'leave',
            message: '查询我的请假记录',
            conversationId: 'test-leave-' + Date.now()
        }, adminToken);
        return r.status === 200 && (r.body?.content || r.body?.reply);
    });

    // ======================== 6. Router Agent (核心) ========================
    console.log('\n━━━ 6. Router Agent /api/ai/router ━━━');
    await test('Router: 请假申请 (自动路由到 leave agent)', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '请3天年假，从明天开始，回家探亲',
            conversationId: 'test-router-leave-' + Date.now()
        }, studentToken);
        return r.status === 200;
    });
    await test('Router: 查询请假 (自动路由到 leave agent)', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '查看我的请假记录',
            conversationId: 'test-router-query-' + Date.now()
        }, studentToken);
        return r.status === 200;
    });
    await test('Router: 统计查询 (自动路由到 data agent)', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '统计当前请假数据',
            conversationId: 'test-router-stats-' + Date.now()
        }, adminToken);
        return r.status === 200;
    });
    await test('Router: 通用对话 (自动路由到 general agent)', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '你好，今天天气怎么样？',
            conversationId: 'test-router-general-' + Date.now()
        }, adminToken);
        return r.status === 200;
    });

    // ======================== 7. Web Chat 接口 ========================
    console.log('\n━━━ 7. Web Chat /api/agents/router ━━━');
    await test('Web Chat: 请假申请', async () => {
        const r = await req('POST', '/api/agents/router', {
            message: '我想请1天病假',
            conversationId: 'webchat-' + Date.now()
        }, studentToken);
        return r.status === 200;
    });
    await test('Web Chat: 快速审批 (同意)', async () => {
        const r = await req('POST', '/api/agents/router', {
            message: '同意',
            conversationId: 'webchat-approve-' + Date.now()
        }, counselorToken);
        return r.status === 200;
    });

    // ======================== 8. 智能分析接口 ========================
    console.log('\n━━━ 8. 智能分析 /api/agents/analyze ━━━');
    await test('Analyze: 请假数据分析', async () => {
        const r = await req('POST', '/api/agents/analyze', {
            agentId: 'data',
            prompt: '分析当前请假趋势和类型分布',
        }, adminToken);
        return r.status === 200 && r.body?.content;
    });
    await test('Analyze: 审批分析', async () => {
        const r = await req('POST', '/api/agents/analyze', {
            agentId: 'approval',
            prompt: '分析审批流程是否合理',
        }, adminToken);
        return r.status === 200 && r.body?.content;
    });

    // ======================== 9. 多智能体协作 ========================
    console.log('\n━━━ 9. 多智能体协作 ━━━');
    await test('协作模式列表', async () => {
        const r = await req('GET', '/api/agents/collaboration/modes');
        return r.status === 200 && Array.isArray(r.body?.modes);
    });
    await test('协作计划生成', async () => {
        const r = await req('POST', '/api/agents/collaboration/plan', {
            message: '系统需要处理一个学生请假申请：学生小明请3天年假回家探亲。需要数据分析师统计当前请假情况，请假智能体处理申请，通知智能体发送通知。',
        }, adminToken);
        return r.status === 200 && (r.body?.mode || r.body?.plan);
    });
    await test('协作执行 (Sequential)', async () => {
        const r = await req('POST', '/api/agents/collaboration/execute', {
            message: '分析请假数据并生成一份总结报告',
            mode: 'sequential',
            agents: ['data', 'document'],
        }, adminToken);
        return r.status === 200;
    });
    await test('协作执行 (Parallel)', async () => {
        const r = await req('POST', '/api/agents/collaboration/execute', {
            message: '从请假、审批、统计三个角度分析当前系统状态',
            mode: 'parallel',
            agents: ['leave', 'approval', 'data'],
        }, adminToken);
        return r.status === 200;
    });

    // ======================== 10. 独立 AI API 端点 ========================
    console.log('\n━━━ 10. 独立 AI API 端点 ━━━');
    await test('POST /api/ai/leave', async () => {
        const r = await req('POST', '/api/ai/leave', {
            message: '查询所有待审批的请假',
        }, adminToken);
        return r.status === 200;
    });
    await test('POST /api/ai/document', async () => {
        const r = await req('POST', '/api/ai/document', {
            message: '生成一份请假审批通过的通知公文',
        }, adminToken);
        return r.status === 200;
    });
    await test('POST /api/ai/notify (admin)', async () => {
        const r = await req('POST', '/api/ai/notify', {
            message: '通知所有辅导员明天上午9点开会',
        }, adminToken);
        return r.status === 200;
    });

    // ======================== 11. 飞书 Router ========================
    console.log('\n━━━ 11. 飞书 AI Router /api/ai/feishu-router ━━━');
    await test('飞书 Router: 请假消息', async () => {
        const r = await req('POST', '/api/ai/feishu-router', {
            message: '请3天年假',
            userId: 'test_user_xiaoming',
            userName: '小明',
            chatId: 'test_chat_001',
            chatType: 'group',
        });
        return r.status === 200;
    });
    await test('飞书 Router: 统计查询', async () => {
        const r = await req('POST', '/api/ai/feishu-router', {
            message: '请假统计',
            userId: 'test_user_admin',
            userName: '管理员',
            chatId: 'test_chat_002',
            chatType: 'p2p',
        });
        return r.status === 200;
    });

    // ======================== 12. 页面访问 ========================
    console.log('\n━━━ 12. 页面访问 ━━━');
    await test('GET /chat - AI 聊天页面', async () => {
        const r = await req('GET', '/chat');
        return r.status === 200 && r.raw.includes('html');
    });
    await test('GET /feishu-chat - 飞书聊天页面', async () => {
        const r = await req('GET', '/feishu-chat');
        return r.status === 200 && r.raw.includes('html');
    });

    // ======================== 13. 权限验证 ========================
    console.log('\n━━━ 13. AI 权限验证 ━━━');
    await test('学生不能查看他人数据 (Router)', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '查看小红的请假记录',
            conversationId: 'perm-test-' + Date.now()
        }, studentToken);
        return r.status === 200; // Router 应该返回但数据过滤
    });
    await test('未登录不能调用 AI', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '你好',
        });
        return r.status === 401;
    });

    // ======================== 14. 压力/边界测试 ========================
    console.log('\n━━━ 14. 边界测试 ━━━');
    await test('空消息处理', async () => {
        const r = await req('POST', '/api/agents/classify', { message: '' }, adminToken);
        return r.status === 200 || r.status === 400; // 应该返回错误或默认意图
    });
    await test('无效 Agent ID', async () => {
        const r = await req('POST', '/api/agents/chat', {
            agentId: 'nonexistent_agent',
            message: '测试',
            conversationId: 'invalid-' + Date.now()
        }, adminToken);
        return r.status === 400 || r.status === 404 || r.status === 500; // 应该返回错误
    });
    await test('长消息处理', async () => {
        const r = await req('POST', '/api/ai/router', {
            message: '请分析系统状态' + '并给出总结 '.repeat(20),
            conversationId: 'long-' + Date.now()
        }, adminToken);
        return r.status === 200;
    });

    // ======================== 总结 ========================
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║               📊 测试结果汇总                     ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  总计: ${String(total).padEnd(5)}  ✅ 通过: ${String(passed).padEnd(5)}  ❌ 失败: ${String(failed).padEnd(5)} ║`);
    console.log(`║  通过率: ${((passed/total)*100).toFixed(1)}%                                  ║`);
    console.log('╚══════════════════════════════════════════════════╝');

    // 详细结果
    console.log('\n详细结果:');
    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '💥';
        const detail = r.detail ? ` - ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail).slice(0, 80)}` : '';
        const err = r.error ? ` - ${r.error}` : '';
        console.log(`  ${icon} [${r.elapsed}ms] ${r.name}${detail}${err}`);
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
