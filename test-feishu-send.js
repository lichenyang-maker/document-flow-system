// 测试飞书消息发送 API
const https = require('https');

const APP_ID = 'cli_aaa152828fb95bda';
const APP_SECRET = '61tkmvxLdXZ2Tx0m4AgZFez4CC0xvzjx';

function postJSON(hostname, path, data, headers = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const options = {
            hostname, port: 443, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
        };
        const req = https.request(options, (res) => {
            let chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
                catch { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function main() {
    console.log('='.repeat(60));
    console.log('🔍 飞书 API 完整测试');
    console.log('='.repeat(60));

    // Step 1: 获取 Token
    console.log('\n📌 Step 1: 获取 tenant_access_token...');
    const tokenRes = await postJSON('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: APP_ID, app_secret: APP_SECRET
    });
    
    if (tokenRes.body.code !== 0) {
        console.log('❌ Token 获取失败:', JSON.stringify(tokenRes.body));
        return;
    }
    const token = tokenRes.body.tenant_access_token;
    console.log('✅ Token OK:', token.slice(0, 20) + '...');

    // Step 2: 测试发送消息到群聊 (需要真实 chat_id)
    console.log('\n📌 Step 2: 获取机器人所在群列表...');
    try {
        const chatList = await postJSON('open.feishu.cn', '/open-apis/im/v1/chats?page_size=10', {}, {
            'Authorization': 'Bearer ' + token
        });
        console.log('  群列表:', JSON.stringify(chatList.body, null, 2).slice(0, 500));
        
        if (chatList.body.code === 0 && chatList.body.data?.items?.length > 0) {
            const chats = chatList.body.data.items;
            console.log(`\n  找到 ${chats.length} 个群聊:`);
            chats.forEach(c => {
                console.log(`    - ${c.name || '(未命名)'} (chat_id: ${c.chat_id})`);
            });
        } else if (chatList.body.code !== 0) {
            console.log('  ⚠️ 获取群列表失败, code:', chatList.body.code, 'msg:', chatList.body.msg);
            console.log('  可能原因: 机器人没有 im:chat 权限，或尚未被拉入任何群');
        }
    } catch (e) {
        console.error('  请求失败:', e.message);
    }

    // Step 3: 检查应用权限
    console.log('\n📌 Step 3: 检查机器人信息...');
    try {
        const botInfo = await postJSON('open.feishu.cn', '/open-apis/bot/v3/info', {}, {
            'Authorization': 'Bearer ' + token
        });
        console.log('  机器人信息:', JSON.stringify(botInfo.body, null, 2).slice(0, 500));
        
        if (botInfo.body.code === 0) {
            console.log('  ✅ 机器人状态正常');
            const bot = botInfo.body.data?.bot || {};
            console.log('  机器人名称:', bot.app_name);
            console.log('  激活状态:', bot.activate_status === 1 ? '已激活' : '未激活');
        } else {
            console.log('  ⚠️ 获取机器人信息失败, code:', botInfo.body.code);
        }
    } catch (e) {
        console.error('  请求失败:', e.message);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ 测试完成');
    console.log('='.repeat(60));
}

main().catch(console.error);
