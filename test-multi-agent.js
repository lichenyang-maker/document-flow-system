const { chatWithAgent, classifyIntent, getAgentsList, analyzeWithAgent } = require('./ai-agents');

async function test() {
    console.log('========================================');
    console.log('  🤖 多智能体系统测试');
    console.log('========================================\n');

    console.log('📋 可用智能体:');
    const agents = getAgentsList();
    agents.forEach(a => {
        console.log(`   ${a.name} - ${a.description}`);
    });
    console.log();

    const testCases = [
        { agent: 'general', msg: '帮我介绍一下公文流转系统的主要功能' },
        { agent: 'coder', msg: '写一个 Node.js 函数，读取 CSV 文件并返回 JSON 格式数据' },
        { agent: 'document', msg: '帮我写一份会议通知，关于下周的季度总结会议' },
        { agent: 'approval', msg: '分析一下这个请假申请：张三，3天年假，6月20-22日，原因是陪家人出游' },
        { agent: 'data', msg: '请分析以下数据：5月有12个请假申请，6月至今有8个，其中病假3个，事假5个，年假12个' },
        { agent: 'reasoning', msg: '公司需要在传统审批流程和自动化审批系统之间做选择，请帮我分析利弊' }
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
        '帮我写一个请假申请',
        '如何用 Python 连接数据库',
        '写一份季度工作总结',
        '分析一下最近的请假数据趋势',
        '公司是否应该引入新的审批系统，请深度分析'
    ];

    for (const msg of intentTests) {
        const intent = await classifyIntent(msg);
        console.log(`   "${msg.substring(0, 20)}..." -> ${intent}`);
    }

    console.log('\n========================================');
    console.log('  ✅ 测试完成');
    console.log('========================================');
}

test();
