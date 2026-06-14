// 测试飞书机器人 - 模拟飞书 Webhook 请求
const http = require('http');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

function postJSON(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const url = new URL(path, SERVER_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const req = http.request(options, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
                } catch {
                    resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log('='.repeat(60));
    console.log('🔍 飞书机器人测试');
    console.log('目标服务器:', SERVER_URL);
    console.log('='.repeat(60));

    // 测试1：模拟飞书 Webhook - 用户发送「我是张三」
    console.log('\n📩 测试1：身份绑定 - 飞书用户发送「我是张三」');
    try {
        const r1 = await postJSON('/api/feishu/webhook', {
            header: { event_type: 'im.message.receive_v1' },
            event: {
                message: {
                    chat_id: 'oc_test_chat_123',
                    message_id: 'om_test_msg_001',
                    chat_type: 'group',
                    content: JSON.stringify({ text: '我是张三' })
                },
                sender: {
                    sender_id: { open_id: 'ou_test_openid_zhangsan' }
                }
            }
        });
        console.log('  响应:', r1.status, JSON.stringify(r1.body));
    } catch (e) {
        console.error('  ❌ 请求失败:', e.message);
    }

    // 等待异步处理
    await new Promise(r => setTimeout(r, 2000));

    // 测试2：模拟飞书 Webhook - 用户发送「请假」
    console.log('\n📩 测试2：请假 - 飞书用户发送「请假2天」');
    try {
        const r2 = await postJSON('/api/feishu/webhook', {
            header: { event_type: 'im.message.receive_v1' },
            event: {
                message: {
                    chat_id: 'oc_test_chat_123',
                    message_id: 'om_test_msg_002',
                    chat_type: 'group',
                    content: JSON.stringify({ text: '请假2天' })
                },
                sender: {
                    sender_id: { open_id: 'ou_test_openid_zhangsan' }
                }
            }
        });
        console.log('  响应:', r2.status, JSON.stringify(r2.body));
    } catch (e) {
        console.error('  ❌ 请求失败:', e.message);
    }

    // 等待异步处理
    await new Promise(r => setTimeout(r, 2000));

    // 测试3：直接调用 AI Router
    console.log('\n📩 测试3：AI Router - 直接调用 API');
    try {
        const r3 = await postJSON('/api/ai/feishu-router', {
            message: '请假3天',
            openId: 'ou_test_openid_zhangsan',
            chatId: 'oc_test_chat_456',
            msgId: 'om_test_msg_003'
        });
        console.log('  响应:', r3.status, JSON.stringify(r3.body));
    } catch (e) {
        console.error('  ❌ 请求失败:', e.message);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ 测试完成！');
    console.log('请检查服务器日志输出，确认：');
    console.log('  1. [飞书] Token 是否获取成功');
    console.log('  2. [飞书] 长连接是否启动');
    console.log('  3. 消息处理是否有报错');
    console.log('='.repeat(60));
}

main().catch(console.error);
