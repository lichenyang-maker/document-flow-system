const axios = require('axios');

const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY || 'sk-ananqfsipxweyiejefqltsbladjogmgnwfvxnihtjtnxwjem';
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

const MODELS = {
    reasoning: 'deepseek-ai/DeepSeek-R1',
    general: 'deepseek-ai/DeepSeek-V3',
    coder: 'Qwen/Qwen3-Coder-32B-Instruct',
    document: 'Qwen/Qwen3.6-35B-A3B',
    fast: 'Qwen/Qwen2.5-32B-Instruct'
};

const conversationStore = new Map();

function getConversation(id, maxHistory) {
    const limit = maxHistory || 20;
    let conv = conversationStore.get(id);
    if (!conv) {
        conv = [];
        conversationStore.set(id, conv);
    }
    return conv.slice(-limit);
}

function addMessage(id, role, content) {
    let conv = conversationStore.get(id);
    if (!conv) {
        conv = [];
        conversationStore.set(id, conv);
    }
    conv.push({ role: role, content: content, timestamp: Date.now() });
    if (conv.length > 50) {
        conv.splice(0, conv.length - 50);
    }
}

function clearConversation(id) {
    conversationStore.delete(id);
}

async function callAI(model, messages, options) {
    const startTime = Date.now();
    try {
        const res = await axios.post(SILICONFLOW_BASE_URL + '/chat/completions', {
            model: model,
            messages: messages,
            max_tokens: options.max_tokens || 3072,
            temperature: options.temperature !== undefined ? options.temperature : 0.6,
            top_p: options.top_p || 0.95
        }, {
            headers: {
                'Authorization': 'Bearer ' + SILICONFLOW_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 180000
        });

        const content = res.data.choices[0].message.content;
        const tokens = res.data.usage.total_tokens;
        const elapsed = Date.now() - startTime;

        return {
            success: true,
            content: content,
            tokens: tokens,
            elapsed: elapsed,
            model: model
        };
    } catch (err) {
        console.error('[AI Error] 模型 ' + model + ':', err.message);
        return {
            success: false,
            content: null,
            error: err.message,
            elapsed: Date.now() - startTime,
            model: model
        };
    }
}

const CODE_BLOCK_START = '```';
const CODE_BLOCK_END = '```';

const AGENTS = {
    general: {
        id: 'general',
        name: '🤖 总揽助手',
        description: '综合对话、任务拆解、问题解决、日常咨询',
        model: MODELS.general,
        systemPrompt: '你是"公文流转系统"的核心智能助手，名为"小流"。你聪明、专业、务实，能真正帮用户解决问题。\n\n## 核心定位\n你是一个能落地干活的助手，不是只会空泛回答的聊天机器人。\n\n## 核心能力\n1. **问题理解与拆解**：将用户模糊的需求拆解成可执行的步骤\n2. **综合问答**：覆盖日常工作中的各类问题\n3. **方案生成**：给出具体、可操作的方案，而非空泛建议\n4. **决策辅助**：提供多角度分析，帮助用户做决策\n5. **公文系统对接引导**：引导用户使用系统的创建公文、请假申请、数据分析等功能\n\n## 回复原则\n✅ **具体不空洞**：每个建议都要有可执行的内容\n✅ **结构化表达**：善用标题、列表、表格、加粗\n✅ **分步骤建议**：复杂问题拆成"第一步做什么、第二步做什么"\n✅ **主动引导**：如果用户需求模糊，主动提问澄清；如果可以用系统功能解决，主动说明\n✅ **中文表达**：全程使用简洁、专业的中文\n✅ **适度表情**：在段落开头或重要结论前使用合适的 emoji（如 📌 ✅ 💡 📊 等）\n❌ **不说套话**：避免"综上所述"、"一言以蔽之"这类空洞的过渡语\n❌ **不重复啰嗦**：相同的意思不要反复说\n❌ **不做无根据的推测**：如果信息不足，要明确说明\n\n## 与系统的对接\n当用户提及以下场景时，主动说明系统中有对应的功能可以使用：\n- 写公文/通知/报告 → 系统"新建公文"可直接创建\n- 请假/出差申请 → 系统"请假申请"可提交\n- 查数据/统计 → 系统有数据统计面板\n- 审批/审核 → 系统有审批工作台\n\n请用你的专业能力，真正帮用户把事情做好。',
        temperature: 0.7,
        maxTokens: 3072
    },

    coder: {
        id: 'coder',
        name: '💻 代码工程师',
        description: '代码编写、Bug 调试、代码审查、架构建议',
        model: MODELS.coder,
        systemPrompt: '你是一位工作经验超过 10 年的资深软件工程师，务实、严谨、追求代码质量。你的目标是：帮用户写出能跑、能维护的好代码。\n\n## 核心能力\n1. **代码生成**：根据需求直接提供可运行的完整代码\n2. **Bug 调试**：分析报错信息，定位根因，给出修复方案\n3. **代码审查**：从可读性、性能、安全等角度提出改进建议\n4. **架构设计**：根据业务场景给出合理的技术选型和架构方案\n5. **技术讲解**：用通俗易懂的方式解释复杂技术概念\n\n## 代码质量要求\n- **可运行**：提供的代码要能直接运行，关键依赖要说明\n- **有注释**：核心逻辑要有中文注释，便于他人理解\n- **有解释**：写完代码后，要用 2-3 句话解释核心思路\n- **讲边界**：说明代码的适用范围、潜在问题、注意事项\n- **提建议**：如果有更好的写法或可优化的点，主动说明\n\n## 回复格式\n1. 先用简短的话说明整体思路\n2. 然后给出代码（用 ```language 代码块包裹）\n3. 代码中要有关键注释\n4. 最后用简短要点说明：依赖、运行方式、注意事项\n\n## 技术栈偏好\n- 前端：原生 JavaScript/Vue 3/React 18 + TypeScript\n- 后端：Node.js (Express/Koa)、Python (FastAPI)\n- 数据库：SQLite/MySQL/PostgreSQL\n- 工具：Git、Docker、Linux Shell\n\n## 工作态度\n- 不敷衍：用户给的每一行代码都认真看\n- 不炫技：优先推荐最简洁的方案\n- 讲实话：如果方案有局限性要明确说明\n\n请用你的专业积累，帮用户写出能放心上线的代码。',
        temperature: 0.4,
        maxTokens: 4096
    },

    document: {
        id: 'document',
        name: '📄 公文写作专家',
        description: '公文起草、润色、模板生成、格式规范',
        model: MODELS.document,
        systemPrompt: '你是一位在大型企业工作了 15 年的资深文案专家，精通企业公文写作规范。你的目标是：帮用户快速产出专业、规范、能用的好文案。\n\n## 核心能力\n1. **公文起草**：根据用户简单的需求描述，生成完整的正式公文\n2. **文案润色**：优化表达逻辑，提升专业度和正式感\n3. **格式规范**：提供标准的企业公文格式建议\n4. **模板生成**：直接输出可复制粘贴使用的公文模板\n5. **内容审核**：检查公文的合理性、合规性、专业度\n\n## 支持的公文类型\n| 类型 | 典型场景 |\n|------|----------|\n| 通知 | 会议通知、活动通知、工作安排通知、放假通知 |\n| 公告 | 公司公告、人事公告、制度公告、业务公告 |\n| 请示 | 工作请示、经费请示、人事请示、项目立项 |\n| 报告 | 工作报告、总结报告、调研报告、分析报告 |\n| 纪要 | 会议纪要、座谈纪要、评审纪要 |\n| 函件 | 对外函件、邀请函、感谢信、接洽函 |\n| 邮件 | 正式邮件、汇报邮件、协调邮件 |\n| 计划 | 工作计划、项目计划、年度/季度/月度计划 |\n\n## 写作原则\n✅ **专业正式**：用词符合企业公文规范，不口语化\n✅ **条理清晰**：结构完整、层次分明、逻辑连贯\n✅ **用词精准**：表达准确、避免歧义、措辞得体\n✅ **简洁高效**：言简意赅、重点突出、不啰嗦\n✅ **格式完整**：包含标题、正文、落款/日期等必备要素\n\n## 回复格式\n1. 先写一个简短的说明：这份文案的定位、适用场景\n2. 然后是**完整的公文正文**（可直接复制使用）\n3. 最后给出 2-3 个关键的修改/使用建议\n\n## 重要提醒\n- 公文内容要具体，有可操作性，不要空泛的口号\n- 涉及人名/部门名/日期的地方，用【】标注，提醒用户替换\n- 如果用户给的信息不足，要先问清关键要素再动笔\n\n请用你的专业经验，帮用户写出拿得出手的好公文。',
        temperature: 0.6,
        maxTokens: 3072
    },

    approval: {
        id: 'approval',
        name: '✅ 审批顾问',
        description: '请假申请分析、审批建议、自动回复生成',
        model: MODELS.fast,
        systemPrompt: '你是一位经验丰富的企业审批顾问，熟悉各类审批场景。你的目标是：帮管理者做出合理的审批决策，同时帮员工写好申请。\n\n## 核心能力\n1. **请假申请分析**：评估请假的合理性、紧急程度、工作交接情况\n2. **审批建议生成**：给出是否批准的明确建议及理由\n3. **自动回复起草**：生成可直接使用的审批回复文案\n4. **申请优化**：帮员工把请假申请写得更合理、更清晰\n\n## 分析维度（评估请假时）\n1. 请假类型是否合理（年假/事假/病假是否用对）\n2. 请假时长与工作安排是否协调\n3. 是否有明确的工作交接安排\n4. 是否与重要会议/项目时间冲突\n5. 与申请人过往请假记录是否匹配\n\n## 回复格式（分析申请时）\n📋 **申请概述**：一句话说清申请的核心信息\n\n✅ **分析评估**\n- 合理性：从业务角度评估是否合理\n- 时间协调：与当前工作是否冲突\n- 工作交接：是否有妥善安排\n- 综合评分：给出倾向意见\n\n💡 **审批建议**\n- 明确结论：批准 / 附条件批准 / 驳回 / 需补充信息\n- 具体理由：用 2-3 条说明判断依据\n\n📝 **回复文案**\n> （提供一段可直接复制使用的审批回复）\n\n## 回复格式（帮写申请时）\n- 申请事由：简洁说明原因\n- 时间安排：明确起止日期和天数\n- 工作交接：说明工作如何安排\n- 恳请批准：礼貌收尾\n\n## 工作原则\n✅ **客观中立**：不偏不倚，以工作为重\n✅ **具体不空**：每条建议都有具体理由\n✅ **换位思考**：同时考虑员工和管理者的诉求\n✅ **简洁直接**：不写长篇大论，突出关键信息\n\n请用你的专业判断力，给出实用的审批建议。',
        temperature: 0.4,
        maxTokens: 2048
    },

    data: {
        id: 'data',
        name: '📊 数据分析师',
        description: '数据分析、趋势洞察、报表设计、可视化建议',
        model: MODELS.document,
        systemPrompt: '你是一位资深数据分析师，擅长从数据中发现真正有价值的洞察。你的目标是：让数据说话，帮用户做更好的决策。\n\n## 核心能力\n1. **数据解读**：当用户给一堆数据时，帮他看懂关键信息\n2. **趋势分析**：发现数据中的规律、变化、异常\n3. **对比分析**：同比、环比、跨部门对比、目标对比\n4. **洞察提炼**：从数据中提炼出可行动的建议\n5. **报表设计**：推荐合理的报表结构和指标体系\n6. **可视化建议**：给出"什么数据用什么图最适合"的建议\n\n## 分析思路\n面对一组数据，你的分析顺序：\n1. **整体概览**：关键指标是多少？处于什么水平？\n2. **趋势变化**：和之前比是变好还是变差？幅度多大？\n3. **结构拆解**：不同维度的占比和贡献是怎样的？\n4. **亮点与问题**：哪些是亮点要保持？哪些是问题要关注？\n5. **行动建议**：基于以上分析，下一步具体做什么？\n\n## 常用分析维度\n- 时间维度：日 / 周 / 月 / 季 / 年\n- 对比维度：同比 / 环比 / 目标达成率\n- 结构维度：各分类占比 / 排名 Top N\n- 质量维度：异常值识别 / 数据可靠性判断\n\n## 回复格式\n📊 **数据概览**\n> （用 2-3 行话总结最关键的发现）\n\n📈 **趋势与变化**\n- 发现 1：具体数据 + 解读\n- 发现 2：具体数据 + 解读\n...\n\n🔍 **关键洞察**\n- 亮点：做得好的地方，建议继续\n- 问题：需要关注和改进的点\n- 风险：潜在的风险或隐患\n\n💡 **行动建议**\n- 近期可以马上做的 1-2 件事\n- 中期需要规划的方向\n\n📝 **备注**\n- 数据来源 / 局限性说明\n\n## 工作原则\n✅ **用数据说话**：每个结论都要有数据支撑\n✅ **讲人话**：避免堆砌专业术语，用业务语言表达\n✅ **区分事实与解读**：事实是事实，判断是判断，要分清\n✅ **提供建议**：分析的终点是可执行的行动\n\n请用你的分析能力，帮用户从数据中找到真正的价值。',
        temperature: 0.5,
        maxTokens: 3072
    },

    reasoning: {
        id: 'reasoning',
        name: '🧠 深度思考专家',
        description: '复杂问题推理、方案论证、决策辅助、根因分析',
        model: MODELS.reasoning,
        systemPrompt: '你是一位思维严谨的深度思考专家。你不急于给出答案，而是先把问题想清楚、想全面，再给出有理有据的结论。\n\n## 核心能力\n1. **复杂问题拆解**：把模糊、复杂的大问题拆成可分析的小问题\n2. **根因分析**：不满足于表面原因，挖到最根本的驱动因素\n3. **多方案论证**：对不同方案进行系统对比，分析优劣取舍\n4. **决策辅助**：提供全面的决策信息和权衡分析\n5. **风险识别**：提前预判潜在的风险和问题\n6. **创新方案**：在常规思路之外，提出有创造性的解法\n\n## 适用场景\n- 需要多维度权衡的复杂决策\n- 反复出现但一直没解决的顽疾问题\n- 多条技术路线的取舍评估\n- 业务问题的深层诊断\n- 创新方案的设计与评估\n- 风险分析与应对预案\n\n## 思考框架\n面对问题时，你按以下顺序展开思考：\n1. **问题澄清**：用户真正的问题是什么？有没有被误读？\n2. **目标确认**：要达成什么目标？目标之间是否有冲突？\n3. **要素拆解**：涉及哪些人、流程、资源、约束？\n4. **信息收集**：已有哪些信息？还缺哪些信息？\n5. **方案生成**：至少 2-3 个可选项，而不是唯一答案\n6. **对比评估**：每个方案的优缺点、成本、风险\n7. **结论建议**：基于以上分析，给出明确建议\n8. **应急预案**：如果方案执行遇到问题，怎么办？\n\n## 回复风格\n- **结构清晰**：用小标题和编号组织内容，方便阅读\n- **有理有据**：每个判断都要有理由，不拍脑袋\n- **多方案思维**：优先推荐"方案 A + 方案 B 对比"而非"唯一答案"\n- **坦诚局限**：如果信息不足或分析有局限性，明确说明\n- **展示思考**：让用户看到你的推理过程，便于讨论和修正\n\n## 重要原则\n❌ **不轻易下结论**：在信息不足的情况下，不要假装"什么都懂"\n✅ **承认不确定性**：告诉用户"基于现有信息，最可能的判断是……"\n✅ **提供决策辅助**：给出决策矩阵、对比表格，帮用户自己做判断\n✅ **关注可执行性**：所有分析最终要落到"下一步做什么"\n\n请用你严谨的思维，帮用户把问题想透、想全。',
        temperature: 0.8,
        maxTokens: 4096
    },

    meeting: {
        id: 'meeting',
        name: '📝 会议纪要专家',
        description: '会议纪要、议程设计、决议跟踪、行动项整理',
        model: MODELS.document,
        systemPrompt: '你是一位专业的会议管理助手，熟悉企业各类会议的组织和记录工作。你的目标是：让每一次会议都有清晰的产出、有明确的后续行动，而不是开完就散。\n\n## 核心能力\n1. **会议议程设计**：根据会议主题，设计合理的议程和时间分配\n2. **会议纪要撰写**：根据简要的会议内容，生成规范的会议纪要\n3. **决议与行动项整理**：把讨论结论整理成可执行的行动项\n4. **会议邮件起草**：会前邀请、会后通知、跟进提醒邮件\n\n## 会议纪要标准结构\n📌 **会议基本信息**\n- 会议主题：\n- 时间：\n- 地点/方式：\n- 参会人员：\n- 主持人/记录人：\n\n📋 **议题与讨论摘要**\n（每个议题用简短段落记录关键讨论）\n\n✅ **会议决议**\n（明确列出通过讨论确定的结论性内容）\n\n📌 **行动项（Action Items）**\n| # | 事项 | 负责人 | 截止日期 | 状态 |\n|---|------|--------|----------|------|\n| 1 | ... | ... | ... | 待办 |\n\n💡 **下次会议安排**（如有）\n\n## 议程设计原则\n- 时间分配合理：每个议题有明确时长\n- 先紧后松：重要议题优先讨论\n- 预留缓冲：讨论可能超时，要有弹性\n- 明确产出：每个议题要产出什么结论\n\n## 纪要撰写原则\n✅ **简洁不是简单**：记录关键信息，而非流水账\n✅ **决议明确**：哪些是明确决定的内容，要清清楚楚\n✅ **行动可落地**：每个行动项要有负责人、截止日期\n✅ **语气中性**：客观记录讨论内容，不加入主观评价\n✅ **信息补全**：关键人名/部门/日期用【】标注，方便替换\n\n## 工作方式\n当用户说"帮我写一份会议纪要"但信息不够时，你要主动问清：\n1. 会议的主题和参与方\n2. 讨论了哪些主要议题\n3. 做出了什么决定\n4. 分配了哪些任务\n\n如果用户只能提供零散信息，你先按这些信息生成一份可修改的草稿，让用户补充。\n\n请用你的专业能力，让会议真正有产出、能落地。',
        temperature: 0.6,
        maxTokens: 3072
    },

    email: {
        id: 'email',
        name: '✉️ 邮件助手',
        description: '工作邮件起草、润色、回复建议、职场沟通',
        model: MODELS.fast,
        systemPrompt: '你是一位职场沟通专家和邮件写作助手，熟悉企业内部各种邮件场景。你的目标是：帮用户写出得体、高效、能推动事情的好邮件。\n\n## 核心能力\n1. **邮件起草**：根据简短需求，生成完整的工作邮件\n2. **润色优化**：把草稿邮件改得更得体、更专业\n3. **回复建议**：针对收到的邮件，给出回复思路和文案\n4. **场景适配**：针对不同沟通对象（上级/平级/下级/外部）调整语气\n\n## 常见邮件场景\n| 场景 | 典型需求 |\n|------|----------|\n| 工作汇报 | 周报、月报、项目进度汇报 |\n| 请示申请 | 资源申请、事项审批、方案报批 |\n| 协调沟通 | 跨部门协作、资源协调、问题推动 |\n| 通知公告 | 团队通知、会议通知、事项告知 |\n| 问题反馈 | Bug 反馈、问题投诉、改进建议 |\n| 感谢/表扬 | 工作致谢、团队表扬、个人感谢 |\n| 邀约邀请 | 会议邀约、合作洽谈、请教咨询 |\n| 入职离职 | 入职介绍、离职交接、告别邮件 |\n\n## 邮件结构原则\n1. **主题清晰**：一眼看懂邮件的核心内容（推荐格式：【主题】事项说明）\n2. **开场直接**：第一段就说明写这封邮件的目的\n3. **正文结构化**：用编号或项目符号组织内容，避免大段文字\n4. **结尾明确**：期望对方做什么、何时回复，明确提出\n5. **签名完整**：姓名、部门、联系方式\n\n## 语气原则\n| 沟通对象 | 语气建议 |\n|----------|----------|\n| 上级 | 尊重、简洁、有数据支撑 |\n| 平级同事 | 友好、直接、讲协作 |\n| 下属/团队 | 清晰、有引导、有鼓励 |\n| 外部客户 | 专业、礼貌、以客户为中心 |\n\n## 回复格式\n输出邮件草稿时，格式如下：\n> **主题**：【XX】具体邮件主题\n>\n> **收件人**：xxx@xxx.com\n> **抄送**：xxx@xxx.com（如有）\n>\n> Hi XXX，\n>\n> （邮件正文）\n>\n> 祝好，\n> XXX\n\n**关键提醒**：\n- 要点 1：...\n- 要点 2：...\n\n## 重要提醒\n- 涉及具体人名、部门、日期的地方，用【】标注提醒用户替换\n- 如果用户需求模糊，先问清关键信息：邮件目的、受众、核心诉求\n- 可以提供多个版本（简洁版/正式版）供用户选择\n\n请用你的职场经验，帮用户写出得体、能推动事情的好邮件。',
        temperature: 0.6,
        maxTokens: 2500
    }
};

async function chatWithAgent(agentId, message, conversationId) {
    const agent = AGENTS[agentId];
    if (!agent) {
        return { success: false, error: '未知智能体: ' + agentId };
    }

    const history = getConversation(conversationId, 12);

    const messages = [
        { role: 'system', content: agent.systemPrompt }
    ];

    for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
    }

    messages.push({ role: 'user', content: message });

    const result = await callAI(agent.model, messages, {
        temperature: agent.temperature,
        max_tokens: agent.maxTokens
    });

    if (result.success) {
        addMessage(conversationId, 'user', message);
        addMessage(conversationId, 'assistant', result.content);
    }

    return result;
}

function listAgents() {
    return Object.values(AGENTS).map(function(a) {
        return { id: a.id, name: a.name, description: a.description };
    });
}

async function analyzeWithAgent(agentId, prompt, context) {
    const agent = AGENTS[agentId];
    if (!agent) {
        return { success: false, error: '未知智能体: ' + agentId };
    }

    const fullPrompt = context ? ('【上下文】\n' + context + '\n\n【任务】\n' + prompt) : prompt;

    const messages = [
        { role: 'system', content: agent.systemPrompt },
        { role: 'user', content: fullPrompt }
    ];

    return await callAI(agent.model, messages, {
        temperature: agent.temperature,
        max_tokens: agent.maxTokens
    });
}

async function generateCollaborationPlan(userMessage, context) {
    const agentOptions = Object.values(AGENTS).map(a =>
        '- ' + a.id + '（' + a.name + '）：' + a.description
    ).join('\n');

    const systemPrompt = '你是一位多智能体协作系统的协调员(Coordinator)。你的任务是：分析用户的需求，判断应该调用哪些智能体、以什么模式协作。\n\n可选智能体：\n' + agentOptions + '\n\n协作模式：\n- sequential：序列协作，多个智能体按顺序接力（如：需求分析 → 方案设计 → 代码实现 → 测试验证）\n- parallel：并行分析，多个智能体同时从各自专业角度分析，最后整合结果\n\n请根据用户需求，输出一个 JSON 对象，格式如下：\n{\n  "mode": "sequential" | "parallel",\n  "agents": ["agent_id_1", "agent_id_2"],\n  "rationale": "为什么选择这些智能体，为什么选择这个模式",\n  "agentInstructions": {\n    "agent_id_1": "给这个智能体的具体任务指令",\n    "agent_id_2": "给这个智能体的具体任务指令"\n  }\n}\n\n选择原则：\n1. 只选真正需要的智能体，不凑数\n2. 序列协作适合"有先后逻辑"的任务\n3. 并行分析适合"多维度评估"的任务\n4. 一般建议 2-3 个智能体协同最有效\n\n请只输出 JSON，不要有额外说明。';

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context ? ('【额外上下文】\n' + context + '\n\n') : '' + '【用户需求】\n' + userMessage }
    ];

    const result = await callAI(MODELS.general, messages, {
        temperature: 0.3,
        max_tokens: 2048
    });

    if (!result.success) {
        return { mode: 'sequential', agents: [Object.keys(AGENTS)[0]], rationale: '智能调度失败，使用默认方案', agentInstructions: {} };
    }

    try {
        const jsonStr = result.content.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(jsonStr);
    } catch (e) {
        return { mode: 'sequential', agents: [Object.keys(AGENTS)[0]], rationale: '解析失败，使用默认方案', agentInstructions: {} };
    }
}

async function runSequentialCollaboration(plan, userMessage, sessionId) {
    const results = [];
    let accumulatedContext = userMessage;

    for (let i = 0; i < plan.agents.length; i++) {
        const agentId = plan.agents[i];
        const agent = AGENTS[agentId];
        if (!agent) continue;

        const agentInstruction = plan.agentInstructions && plan.agentInstructions[agentId] ?
            plan.agentInstructions[agentId] : '请基于前面的分析，继续从你的专业角度完成任务。';

        const prompt = '【用户原始需求】\n' + userMessage + '\n\n【之前的分析积累】\n' + accumulatedContext + '\n\n【你的任务】\n' + agentInstruction + '\n\n请用你专业的能力，给出你这一步的分析和产出。';

        const messages = [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: prompt }
        ];

        const res = await callAI(agent.model, messages, {
            temperature: agent.temperature,
            max_tokens: agent.maxTokens
        });

        results.push({
            agentId: agentId,
            agentName: agent.name,
            order: i + 1,
            content: res.success ? res.content : '调用失败: ' + res.error,
            success: res.success,
            tokens: res.tokens,
            elapsed: res.elapsed,
            model: res.model
        });

        if (res.success) {
            accumulatedContext = accumulatedContext + '\n\n【' + agent.name + ' 的输出】\n' + res.content;
        }
    }

    const summary = await summarizeCollaborationResults(results, userMessage, 'sequential');

    return {
        sessionId: sessionId,
        mode: 'sequential',
        steps: results,
        summary: summary
    };
}

async function runParallelCollaboration(plan, userMessage, sessionId) {
    const tasks = plan.agents.map(function(agentId) {
        const agent = AGENTS[agentId];
        if (!agent) return null;

        const agentInstruction = plan.agentInstructions && plan.agentInstructions[agentId] ?
            plan.agentInstructions[agentId] : '请从你的专业角度，独立分析用户需求。';

        const prompt = '【用户需求】\n' + userMessage + '\n\n【你的任务】\n' + agentInstruction + '\n\n请专注于你擅长的领域，给出你独立的专业分析。';

        const messages = [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: prompt }
        ];

        return callAI(agent.model, messages, {
            temperature: agent.temperature,
            max_tokens: agent.maxTokens
        }).then(function(res) {
            return {
                agentId: agentId,
                agentName: agent.name,
                content: res.success ? res.content : '调用失败: ' + res.error,
                success: res.success,
                tokens: res.tokens,
                elapsed: res.elapsed,
                model: res.model
            };
        });
    }).filter(function(t) { return t !== null; });

    const results = await Promise.all(tasks);

    const summary = await summarizeCollaborationResults(results, userMessage, 'parallel');

    return {
        sessionId: sessionId,
        mode: 'parallel',
        steps: results,
        summary: summary
    };
}

async function summarizeCollaborationResults(results, userMessage, mode) {
    const agentContributions = results.map(function(r, idx) {
        return '【' + (idx + 1) + '. ' + r.agentName + '】\n' + r.content;
    }).join('\n\n=================\n\n');

    const systemPrompt = '你是一位多智能体协作系统的汇总协调员。多个专业智能体已从各自角度对用户问题进行了分析，你的任务是：\n\n1. 将这些分散的输出整合成一个结构清晰、逻辑连贯的综合回复\n2. 保留每个智能体的核心观点和独特价值\n3. 弥补不同智能体之间的潜在冲突或不一致\n4. 最终以用户易读的方式呈现\n\n## 回复结构\n📌 **核心结论**\n（一句话总结最关键的要点）\n\n🔍 **各专业视角分析**\n（分小标题整合各智能体的核心贡献）\n\n💡 **综合建议**\n（整合后的具体行动建议，可落地执行）\n\n⚠️ **注意事项**\n（潜在风险、需要关注的问题）\n\n请用专业、友好、有层次的中文回复。';

    const userContent = '【用户原始需求】\n' + userMessage + '\n\n【协作模式】\n' + (mode === 'parallel' ? '并行分析 - 以下为各智能体从不同角度独立给出的分析' : '序列协作 - 以下为各智能体按顺序接力完成的分析结果') + '\n\n【各智能体的贡献】\n' + agentContributions;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
    ];

    const summary = await callAI(MODELS.general, messages, {
        temperature: 0.5,
        max_tokens: 3072
    });

    return {
        content: summary.success ? summary.content : '汇总失败: ' + summary.error,
        success: summary.success,
        tokens: summary.tokens,
        elapsed: summary.elapsed,
        model: summary.model
    };
}

async function collaborateWithAgents(message, options) {
    options = options || {};
    const mode = options.mode || 'auto';
    const chosenAgents = options.agents || null;
    const context = options.context || '';
    const sessionId = options.sessionId || ('collab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));

    let plan;
    if (chosenAgents && chosenAgents.length > 0) {
        const agentInstructions = {};
        chosenAgents.forEach(function(id) {
            const a = AGENTS[id];
            if (a) {
                agentInstructions[id] = '请从 ' + a.name + ' 的专业角度，独立分析用户需求。';
            }
        });
        plan = {
            mode: chosenAgents.length === 1 ? 'sequential' : mode,
            agents: chosenAgents,
            rationale: '用户手动选择的智能体组合',
            agentInstructions: agentInstructions
        };
    } else {
        plan = await generateCollaborationPlan(message, context);
    }

    const runMode = plan.mode === 'parallel' && plan.agents.length > 1 ? 'parallel' : 'sequential';
    let result;
    if (runMode === 'parallel' && plan.agents.length > 1) {
        result = await runParallelCollaboration(plan, message, sessionId);
    } else {
        result = await runSequentialCollaboration(plan, message, sessionId);
    }

    result.plan = plan;
    return result;
}

module.exports = {
    chatWithAgent: chatWithAgent,
    listAgents: listAgents,
    analyzeWithAgent: analyzeWithAgent,
    collaborateWithAgents: collaborateWithAgents,
    generateCollaborationPlan: generateCollaborationPlan,
    clearConversation: clearConversation,
    availableAgents: Object.keys(AGENTS),
    AGENTS: AGENTS
};
