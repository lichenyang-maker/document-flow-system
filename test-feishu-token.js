// 测试飞书 API Token 是否有效
const https = require('https');

const APP_ID = 'cli_aaa152828fb95bda';
const APP_SECRET = '61tkmvxLdXZ2Tx0m4AgZFez4CC0xvzjx';

const data = JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET });

const options = {
    hostname: 'open.feishu.cn',
    port: 443,
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = https.request(options, (res) => {
    let chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        console.log('Status:', res.statusCode);
        try {
            const json = JSON.parse(body);
            console.log('Response:', JSON.stringify(json, null, 2));
            if (json.code === 0) {
                console.log('\n✅ 飞书 Token 获取成功！App ID/Secret 有效。');
                console.log('Token:', json.tenant_access_token?.slice(0, 20) + '...');
            } else {
                console.log('\n❌ 飞书 Token 获取失败！');
                console.log('   错误码:', json.code);
                console.log('   错误信息:', json.msg);
                console.log('\n可能原因:');
                console.log('   1. App Secret 已过期或被重置');
                console.log('   2. 需要在飞书开放平台重新获取 App Secret');
                console.log('   3. 应用已被删除或停用');
            }
        } catch (e) {
            console.log('Body:', body);
        }
    });
});

req.on('error', (e) => {
    console.error('❌ 网络请求失败:', e.message);
    console.log('可能原因: 无法访问 open.feishu.cn');
});

req.write(data);
req.end();
