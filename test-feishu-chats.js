// 详细测试飞书机器人的群聊和权限
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

function getJSON(hostname, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = { hostname, port: 443, path, method: 'GET', headers };
        const req = https.request(options, (res) => {
            let chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
                catch { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log('='.repeat(60));
    console.log('🔍 飞书机器人详细诊断');
    console.log('='.repeat(60));

    // 获取 Token
    const tokenRes = await postJSON('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: APP_ID, app_secret: APP_SECRET
    });
    if (tokenRes.body.code !== 0) {
        console.log('❌ Token 获取失败');
        return;
    }
    const token = tokenRes.body.tenant_access_token;
    console.log('✅ Token OK');

    // 1. 机器人激活状态
    console.log('\n📌 1. 机器人激活状态');
    const botInfo = await getJSON('open.feishu.cn', '/open-apis/bot/v3/info', {
        'Authorization': 'Bearer ' + token
    });
    console.log('   activate_status:', botInfo.body.bot?.activate_status, '(1=已激活, 2=未激活)');
    console.log('   open_id:', botInfo.body.bot?.open_id);
    
    // 2. 获取群聊列表
    console.log('\n📌 2. 群聊列表');
    const chatList = await getJSON('open.feishu.cn', '/open-apis/im/v1/chats?page_size=20', {
        'Authorization': 'Bearer ' + token
    });
    
    if (chatList.body.code === 0 && chatList.body.data?.items) {
        const chats = chatList.body.data.items;
        console.log(`   找到 ${chats.length} 个群聊:`);
        for (const c of chats) {
            console.log(`   - ${c.name || '(未命名)'} | chat_id: ${c.chat_id} | type: ${c.chat_type} | 成员: ${c.member_count || '?'}`);
            
            // 获取群成员
            try {
                const members = await getJSON('open.feishu.cn', `/open-apis/im/v1/chats/${c.chat_id}/members?page_size=20`, {
                    'Authorization': 'Bearer ' + token
                });
                if (members.body.code === 0 && members.body.data?.items) {
                    for (const m of members.body.data.items) {
                        console.log(`     👤 ${m.name || m.member_id} (${m.member_id_type})`);
                    }
                }
            } catch (e) {
                console.log(`     ⚠️ 获取成员失败: ${e.message}`);
            }
        }
    } else {
        console.log('   ⚠️ 获取群列表失败, code:', chatList.body.code, 'msg:', chatList.body.msg);
    }

    // 3. 尝试发送测试消息到群
    console.log('\n📌 3. 尝试发送测试消息到群 oc_969cc25ee65a55d177494ed8379bec96');
    if (chatList.body.data?.items?.length > 0) {
        const chatId = chatList.body.data.items[0].chat_id;
        const sendRes = await postJSON('open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id', {
            receive_id: chatId,
            content: JSON.stringify({ text: '🧪 测试消息 - 机器人已上线！' }),
            msg_type: 'text'
        }, {
            'Authorization': 'Bearer ' + token
        });
        console.log('   结果:', JSON.stringify(sendRes.body, null, 2));
        
        if (sendRes.body.code === 0) {
            console.log('   ✅ 消息发送成功！');
        } else {
            console.log('   ❌ 消息发送失败, code:', sendRes.body.code, 'msg:', sendRes.body.msg);
            console.log('   常见原因:');
            console.log('     - 机器人未激活 (activate_status=2)');
            console.log('     - 没有 im:message:send_as_bot 权限');
            console.log('     - 机器人不在该群中');
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📋 诊断结论');
    console.log('='.repeat(60));
    
    if (botInfo.body.bot?.activate_status === 2) {
        console.log('🔴 机器人未激活！需要在飞书开放平台发布应用。');
        console.log('');
        console.log('解决步骤:');
        console.log('  1. 登录飞书开放平台: https://open.feishu.cn');
        console.log('  2. 进入「落地作业」应用');
        console.log('  3. 左侧菜单 →「应用发布」→「创建版本」');
        console.log('  4. 填写版本号（如 1.0.0）和更新说明');
        console.log('  5. 提交审核并发布');
        console.log('  6. 发布后 activate_status 变为 1');
    }
}

main().catch(console.error);
