const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

let serverProcess = null;

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
    const results = [];
    let token = null;
    let userId = null;

    function test(name, promise) {
        results.push({ name, promise });
        return promise;
    }

    // 1. 健康检查
    const h = await test('健康检查', request('/health'));
    console.log(' [1/6] /health    →', h.status, h.status === 200 ? '✓' : '✗');

    // 2. 首页
    const idx = await test('首页 HTML', request('/'));
    console.log(' [2/6] /          →', idx.status, '字节数=', idx.body?.length || 0, idx.status === 200 && idx.body?.length > 500 ? '✓' : '✗');

    // 3. AI 助手页面
    const chat = await test('AI助手 HTML', request('/chat'));
    console.log(' [3/6] /chat      →', chat.status, '字节数=', chat.body?.length || 0, chat.status === 200 && chat.body?.length > 500 ? '✓' : '✗');

    // 4. 智能体列表（无需登录）
    const agents = await test('智能体列表', request('/api/agents'));
    console.log(' [4/6] /api/agents→', agents.status, 'agents=', agents.json?.agents?.length || 0, agents.json?.agents?.length > 0 ? '✓' : '✗');

    // 5. 登录
    const login = await test('登录', request('/api/public/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    }));
    token = login.json?.token;
    userId = login.json?.user?.id;
    console.log(' [5/6] 登录 admin →', login.status, 'token获取=', token ? '✓' : '✗', token ? '('+token.substring(0,20)+'...)' : '');

    // 6. 已登录用户信息
    let me = null;
    if (token) {
        me = await test('用户信息', request('/api/auth/me', {
            headers: { 'Authorization': 'Bearer ' + token }
        }));
        console.log(' [6/6] /api/auth/me→', me.status, '用户=', me.json?.name || me.json?.username || '-', me.status === 200 ? '✓' : '✗');
    }

    // 总结
    console.log('\n=========  测试结果汇总  =========');
    const passed = [
        h.status === 200,
        idx.status === 200 && idx.body?.length > 500,
        chat.status === 200 && chat.body?.length > 500,
        agents.status === 200 && agents.json?.agents?.length > 0,
        login.status === 200 && token,
        me && me.status === 200
    ].filter(Boolean).length;
    console.log(`✅ 测试通过: ${passed} / 6`);
    if (passed >= 5) {
        console.log('\n🎉 服务运行正常！请在浏览器访问：');
        console.log('   📄 http://localhost:3000/   (登录: admin / admin123)');
        console.log('   🤖 http://localhost:3000/chat  (AI智能助手)');
    } else {
        console.log('\n⚠️  部分测试失败，请检查服务配置');
    }
}

function startServer() {
    return new Promise((resolve) => {
        serverProcess = spawn('node', [path.join(__dirname, 'server-sqlite.js')], {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let startupDone = false;
        let outputBuffer = '';

        function checkStartup(data) {
            if (startupDone) return;
            outputBuffer += data.toString();
            if (outputBuffer.includes('服务已启动') || outputBuffer.includes('ERROR') || outputBuffer.includes('启动失败')) {
                startupDone = true;
                resolve(true);
            }
        }

        serverProcess.stdout.on('data', checkStartup);
        serverProcess.stderr.on('data', checkStartup);

        serverProcess.on('error', (err) => {
            console.log('子进程错误:', err.message);
            resolve(false);
        });

        setTimeout(() => {
            if (!startupDone) {
                startupDone = true;
                console.log('⏱️  启动超时,输出:\n' + outputBuffer.substring(0, 500));
                resolve(true);
            }
        }, 8000);
    });
}

async function main() {
    console.log('===========================================');
    console.log('   公文流转系统 - 服务启动与验证');
    console.log('===========================================\n');

    console.log('▶ 正在启动服务...');
    const started = await startServer();
    if (!started) { console.log('❌ 服务启动失败'); process.exit(1); }

    // 等待服务完全就绪
    await new Promise(r => setTimeout(r, 1500));

    console.log('▶ 开始验证 API 端点...\n');
    await runTests();

    // 关闭子进程
    if (serverProcess) {
        serverProcess.kill();
        setTimeout(() => process.exit(0), 500);
    }
}

main();
