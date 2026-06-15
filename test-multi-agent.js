const { chatWithAgent, classifyIntent, getAgentsList, analyzeWithAgent, routerAgentProcess } = require('./ai-agents');
const { injectDB, injectFeishu, injectDBQuery } = require('./ai-agents');

async function test() {
    console.log('========================================');
    console.log('  🤖 销售订货多智能体系统测试');
    console.log('========================================\n');

    console.log('📋 可用智能体:');
    const agents = getAgentsList();
    agents.forEach(a => {
        console.log(`   ${a.name} - ${a.description}`);
    });
    console.log();

    const testCases = [
        { agent: 'general', msg: '帮我介绍一下销售订货系统的主要功能' },
        { agent: 'order', msg: '帮我创建一个销售订单，客户名称是华为科技，产品是服务器，数量10台' },
        { agent: 'data', msg: '请分析一下订单交付率数据' },
        { agent: 'notify', msg: '通知工程部，订单SO20260615001需要紧急评审' },
        { agent: 'feishu', msg: '查看我的待审批订单' }
    ];

    for (const tc of testCases) {
        console.log(`\n🔹 测试 [${tc.agent}]: ${tc.msg.substring(0, 40)}...`);
        const convId = 'test_' + tc.agent + '_' + Date.now();
        const result = await chatWithAgent(tc.agent, tc.msg, convId);
        if (result.success) {
            console.log(`   ✅ 成功 | 耗时: ${result.elapsed}ms | Tokens: ${result.tokens}`);
            console.log(`   回复预览: ${result.content.substring(0, 80).replace(/\n/g, ' ')}...\n`);
        } else {
            console.log(`   ❌ 失败: ${result.error}\n`);
        }
    }

    console.log('\n========================================');
    console.log('  🔍 意图分类测试');
    console.log('========================================\n');

    const intentTests = [
        '我要下订单，客户是腾讯',
        '帮我查一下我的订单',
        '订单SO001需要变更',
        '查看交付率统计',
        '发联络单给计划部',
        '帮我查库存',
        '这个月生产周期是多少',
        '你好，今天天气不错'
    ];

    for (const msg of intentTests) {
        try {
            const intent = await classifyIntent(msg);
            console.log(`   "${msg.substring(0, 25).padEnd(25)}" -> ${intent}`);
        } catch (e) {
            console.log(`   "${msg.substring(0, 25).padEnd(25)}" -> ERROR: ${e.message}`);
        }
    }

    console.log('\n========================================');
    console.log('  ✅ 测试完成');
    console.log('========================================');
}

// 如果需要注入数据库和飞书依赖，取消下面注释
// const dbHelper = null;
// injectDB(dbHelper);
// injectFeishu({});

test();
