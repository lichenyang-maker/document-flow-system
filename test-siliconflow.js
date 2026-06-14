const axios = require('axios');

const API_KEY = 'sk-ananqfsipxweyiejefqltsbladjogmgnwfvxnihtjtnxwjem';
const BASE_URL = 'https://api.siliconflow.cn/v1';

async function test() {
    console.log('=== 测试硅基流动 API ===\n');

    const models = [
        'deepseek-ai/DeepSeek-V3.2',
        'Qwen/Qwen3-Coder-30B-A3B-Instruct',
        'Qwen/Qwen3.6-35B-A3B',
        'deepseek-ai/DeepSeek-R1'
    ];

    for (const model of models) {
        try {
            const start = Date.now();
            const res = await axios.post(`${BASE_URL}/chat/completions`, {
                model: model,
                messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
                max_tokens: 100,
                temperature: 0.7
            }, {
                headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
            });
            const content = res.data.choices[0].message.content;
            const elapsed = Date.now() - start;
            const tokens = res.data.usage.total_tokens;
            console.log(`✅ ${model}`);
            console.log(`   耗时: ${elapsed}ms, Tokens: ${tokens}`);
            console.log(`   回复: ${content.substring(0, 60)}...\n`);
        } catch (err) {
            console.log(`❌ ${model}: ${err.message}\n`);
        }
    }
    console.log('=== 测试完成 ===');
}

test();
