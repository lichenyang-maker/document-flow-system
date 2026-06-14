const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const serverProcess = spawn('node', [path.join(__dirname, 'server-sqlite.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
});

let allOutput = '';
let started = false;

function onData(data) {
    const str = data.toString();
    allOutput += str;
    process.stdout.write(str);

    if (!started && (str.includes('服务已启动') || str.includes('ERROR') || str.includes('启动失败'))) {
        started = true;
        setTimeout(() => { runTests(); }, 2000);
    }
}

serverProcess.stdout.on('data', onData);
serverProcess.stderr.on('data', onData);

serverProcess.on('error', (err) => {
    console.log('子进程错误:', err.message);
});

serverProcess.on('exit', (code) => {
    if (!started) console.log('进程意外退出, code:', code);
});

setTimeout(() => {
    if (!started) {
        console.log('⏱️  启动超时, 输出:\n' + allOutput.substring(0, 2000));
        runTests();
    }
}, 15000);

function request(pathname, options = {}) {
    return new Promise((resolve) => {
        const opts = {
            hostname: '127.0.0.1',
            port: 3000,
            path: pathname,
            method: options.method || 'GET',
            headers: options.headers || {}
        };
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: data, json: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data, json: null }); }
            });
        });
        req.on('error', (e) => { resolve({ status: 'error', body: e.message, json: null }); });
        req.setTimeout(10000, () => { req.destroy(); resolve({ status: 'timeout', body: 'timeout', json: null }); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function runTests() {
    console.log('\n\n===========================================');
    console.log('   🔍  深度测试');
    console.log('===========================================\n');

    // 基础测试
    console.log('── 基础页面测试 ──');
    const r1 = await request('/');
    console.log(`/          → ${r1.status}, ${r1.body?.length}字节`);
    const r2 = await request('/chat');
    console.log(`/chat      → ${r2.status}, ${r2.body?.length}字节`);
    const r3 = await request('/health');
    console.log(`/health    → ${r3.status}`);

    // 智能体列表
    console.log('\n── 智能体 API 测试 ──');
    const r4 = await request('/api/agents');
    console.log(`/api/agents → ${r4.status}`);
    if (r4.json && r4.json.agents) {
        console.log(`  智能体数量: ${r4.json.agents.length}`);
        r4.json.agents.forEach(a => {
            console.log(`    · ${a.id} - ${a.name} (model: ${a.model || '-'})`);
        });
    } else {
        console.log('  ❌ 返回内容:', JSON.stringify(r4.json).substring(0, 200));
    }

    // 登录测试
    console.log('\n── 登录测试 ──');
    const r5 = await request('/api/public/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    console.log(`登录 admin → ${r5.status}`);
    const token = r5.json?.token;
    if (token) {
        console.log('  ✅ token:', token.substring(0, 30) + '...');
    } else {
        console.log('  ❌ 无 token, 返回体:', JSON.stringify(r5.json).substring(0, 300));
    }

    // 用户信息测试
    if (token) {
        console.log('\n── 带认证的 API 测试 ──');
        const r6 = await request('/api/auth/me', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        console.log(`/api/auth/me → ${r6.status}, user: ${r6.json?.name || r6.json?.username || '-'}`);

        const r7 = await request('/api/documents');
        // 注意: 有些 API 可能不需要 auth, 有些需要
        console.log(`/api/documents (无auth) → ${r7.status}`);

        const r7b = await request('/api/documents', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        console.log(`/api/documents (有auth) → ${r7b.status}, body长度: ${r7b.body?.length}`);
        if (r7b.status === 200 && r7b.body?.length > 0) {
            try {
                const docs = JSON.parse(r7b.body);
                console.log(`  文档数量: ${Array.isArray(docs) ? docs.length : '非数组'}`);
                if (Array.isArray(docs) && docs.length > 0) {
                    console.log(`  第一个: id=${docs[0].id}, title=${docs[0].title?.substring(0,20)}`);
                }
            } catch (e) {
                console.log('  JSON解析失败:', e.message, '内容:', r7b.body.substring(0, 100));
            }
        }

        const r8 = await request('/api/leave/stats', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        console.log(`/api/leave/stats → ${r8.status}, body: ${r8.body.substring(0, 150)}`);
    }

    // 关闭
    console.log('\n── 测试完成 ──');
    setTimeout(() => {
        serverProcess.kill();
        setTimeout(() => process.exit(0), 500);
    }, 1000);
}
