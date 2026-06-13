// ============================================================
//  ai-agents.js - 多智能体系统（完整版）
//  Router Agent + Leave Agent + Document Agent
//  + Notify Agent + Stats Agent
// ============================================================
'use strict';

const axios = require('axios');

// ---------- 配置 ----------
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY || 'sk-ananqfsipxweyiejefqltsbladjogmgnwfvxnihtjtnxwjem';
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

const MODELS = {
    reasoning: 'deepseek-ai/DeepSeek-R1',        // 深度推理（复杂问题）
    general: 'deepseek-ai/DeepSeek-V3',          // 主力对话模型
    feishu: 'deepseek-ai/DeepSeek-V3',           // 飞书机器人专用（可独立切换）
    coder: 'Qwen/Qwen3-Coder-32B-Instruct',
    document: 'Qwen/Qwen3.6-35B-A3B',
    fast: 'Qwen/Qwen2.5-32B-Instruct',
    intent: 'Qwen/Qwen3-32B'                     // 意图识别专用（更快更准）
};

// ---------- 对话历史存储 ----------
const conversationStore = new Map();
function getConversation(id, maxHistory = 20) {
    let conv = conversationStore.get(id);
    if (!conv) { conv = []; conversationStore.set(id, conv); }
    return conv.slice(-maxHistory);
}
function addMessage(id, role, content) {
    let conv = conversationStore.get(id);
    if (!conv) { conv = []; conversationStore.set(id, conv); }
    conv.push({ role, content, timestamp: Date.now() });
    if (conv.length > 50) conv.splice(0, conv.length - 50);
}
function clearConversation(id) { conversationStore.delete(id); }

// ---------- 数据库引用（启动时注入）----------
let dbHelper = null;
function injectDB(helper) { dbHelper = helper; }

// ---------- 飞书消息发送引用（启动时注入）----------
let feishuSender = null;
function injectFeishu(sender) { feishuSender = sender; }

// ============================================================
//  AI 调用底层
// ============================================================
async function callAI(model, messages, options = {}) {
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
        return {
            success: true,
            content: content,
            tokens: res.data.usage?.total_tokens || 0,
            elapsed: Date.now() - startTime,
            model: model
        };
    } catch (err) {
        console.error('[AI Error]', model, ':', err.message);
        return {
            success: false, content: null,
            error: err.message,
            elapsed: Date.now() - startTime,
            model: model
        };
    }
}

// ============================================================
//  Router Agent - 意图识别 & 路由（v3.0 - 全 AI 驱动）
// ============================================================

// 快速审批检测（同意/驳回太简单，不值得 LLM 调用）
function detectQuickApproval(message) {
    const lower = (message || '').trim().toLowerCase();
    const approveExact = ['同意', '批准', '准了', '通过', '准假', '批了', 'approve', 'ok', '好的', '可以', '没问题'];
    for (const kw of approveExact) {
        if (lower === kw || (lower.length <= 6 && lower.includes(kw))) {
            return 'approve_action';
        }
    }
    const rejectExact = ['不同意', '驳回', '拒绝', '不准', '否决', '不批', 'reject', '不行', '不可以'];
    for (const kw of rejectExact) {
        if (lower === kw || (lower.length <= 6 && lower.includes(kw))) {
            return 'reject_action';
        }
    }
    return null;
}

// LLM 意图识别 - 核心路由（全 AI 驱动）
async function classifyIntent(message) {
    if (!message) return { intent: 'general', method: 'default' };

    // 仅保留极短审批词快速通道
    const quick = detectQuickApproval(message);
    if (quick) return { intent: quick, method: 'quick' };

    const intentList = [
        'leave_apply: 用户想请假/休假（如"我要请假3天""休年假""调休"等任何请假相关表述）',
        'leave_query: 用户查询请假记录、假期余额、假期剩余天数',
        'doc_create: 用户想写/起草/生成公文、通知、报告、请示、会议纪要等文档',
        'doc_approve: 用户想审批/审核/批准公文',
        'stats: 用户想查看统计数据、报表、系统概况、待审批事项',
        'notify: 用户想发通知/提醒给某人或群体',
        'approve_action: 用户表示同意/批准某事项',
        'reject_action: 用户表示不同意/驳回某事项',
        'general: 日常聊天、闲聊、问候、问答、知识咨询、表达情绪等（默认）'
    ].join('\n');

    const prompt = `你是智能意图识别员。分析用户输入，判断真实意图。

## 规则
- 日常聊天、闲聊、问候、问问题、求推荐、表达情绪 → general
- 明确想请假、休假（不管什么假） → leave_apply
- 想查请假记录、假期余额 → leave_query
- 想写公文、通知、报告等文档 → doc_create
- 想审批/审核公文 → doc_approve
- 想看数据、统计、报表 → stats
- 想发通知/提醒 → notify
- 明确说同意/批准 → approve_action
- 明确说不同意/驳回 → reject_action

## 可选意图
${intentList}

## 重要
请只输出意图名称（一个英文词），不要任何其他内容。

用户输入：${message}`;

    const result = await callAI(MODELS.intent, [
        { role: 'system', content: '你只返回意图名称，不要解释。' },
        { role: 'user', content: prompt }
    ], { temperature: 0.1, max_tokens: 50 });

    if (!result.success) return { intent: 'general', method: 'fallback' };

    const content = (result.content || '').trim().toLowerCase();
    const valid = ['leave_apply', 'leave_query', 'doc_create', 'doc_approve', 'notify', 'stats', 'approve_action', 'reject_action', 'general'];
    for (const v of valid) {
        if (content.includes(v)) return { intent: v, method: 'llm' };
    }
    return { intent: 'general', method: 'llm_default' };
}

// 意图 → Agent 映射
const INTENT_TO_AGENT = {
    leave_apply: 'leave',
    leave_query: 'leave',
    approve_action: 'leave',
    reject_action: 'leave',
    doc_create: 'document',
    doc_approve: 'approval',
    stats: 'data',
    notify: 'notify',
    general: 'general'
};

// ============================================================
//  Agent 定义
// ============================================================
const AGENTS = {
    general: {
        id: 'general', name: '全能助手',
        description: '综合办公助手 - 能聊能干活，直接处理请假/公文/审批/查询',
        model: MODELS.general,
        systemPrompt: `你是智能办公全能助手"小流"，由 DeepSeek-V3 驱动。你不仅能聊天，更能直接干活——请假、写公文、审批、查数据、发通知，全都在行。

## 核心原则
- 🎯 **直接干活**：用户说要请假，你就帮他把请假申请写好；用户说要写公文，你就直接写出来
- 📝 **结构化输出**：善用标题、列表、分段，让信息一目了然
- 💡 **可执行**：每个建议都有具体步骤，不说空话
- ⚡ **简洁高效**：不啰嗦、不重复、不堆砌套话
- 😊 **友好自然**：语气亲切但保持专业

## 你能直接干的事
1. **请假**：帮用户起草请假申请，提取类型、天数、日期、原因
2. **写公文**：起草通知、报告、请示、会议纪要等各类公文
3. **审批建议**：分析请假/公文申请是否合理，给出审批意见
4. **数据分析**：解读数据、发现规律、给出建议
5. **知识问答**：回答工作相关的问题，提供专业方案
6. **日常聊天**：闲聊、问候、答疑都行

## 回复格式
- 请假申请：直接输出完整的请假申请信息（类型、时间、天数、事由）
- 公文写作：直接输出完整公文正文，人名/部门/日期用【】标注
- 数据查询：用清晰格式展示，配合 emoji
- 聊天：自然对话即可

请用你的专业能力，帮用户高效完成工作！`,
        temperature: 0.7, maxTokens: 3072
    },

    leave: {
        id: 'leave', name: '请假智能体',
        description: '请假申请解析、查询、审批处理',
        model: MODELS.fast,
        systemPrompt: `你是请假管理助手。直接帮用户处理请假事务。

## 你的任务
从用户消息中提取请假信息并直接输出完整申请：
- 类型：年假/事假/病假/婚假/产假/丧假（默认事假）
- 天数：从"X天""X日"中提取
- 日期：支持 "6月15日"、"6月15到17号"、"2024-06-15" 等格式
- 原因：从"因为""事由"后提取

## 输出 JSON 格式
请只输出 JSON，不要额外内容：
{"action":"apply","type":"年假","days":3,"startDate":"2024-06-15","endDate":"2024-06-17","reason":"家庭旅游"}

如果是查询：{"action":"query"}
如果是审批：{"action":"approve","comment":"批准"}
如果是驳回：{"action":"reject","comment":"理由"}`,
        temperature: 0.3, maxTokens: 1024
    },

    document: {
        id: 'document', name: '公文写作专家',
        description: '公文起草、润色、模板生成',
        model: MODELS.document,
        systemPrompt: `你是资深企业文案专家，精通公文写作。

## 支持的公文类型
| 类型 | 场景 |
|------|------|
| 通知 | 会议通知、工作安排、放假通知 |
| 请示 | 工作请示、经费请示、人事请示 |
| 报告 | 工作报告、总结报告、调研报告 |
| 纪要 | 会议纪要、座谈纪要 |

## 写作原则
- 专业正式，符合企业公文规范
- 条理清晰，结构完整
- 用词精准，避免歧义
- 包含标题、正文、落款/日期

## 回复格式
1. 简短说明定位和适用场景
2. 完整公文正文（可直接使用）
3. 2-3个修改建议

涉及人名/部门/日期用【】标注提醒替换。`,
        temperature: 0.6, maxTokens: 3072
    },

    approval: {
        id: 'approval', name: '审批顾问',
        description: '公文审批分析、审批建议',
        model: MODELS.fast,
        systemPrompt: `你是企业审批顾问，帮管理者做合理审批决策。

## 分析维度
1. 申请是否合理
2. 与工作安排是否协调
3. 是否有工作交接安排

## 回复格式
📋 申请概述
✅ 分析评估
💡 审批建议
📝 回复文案（可直接使用）`,
        temperature: 0.4, maxTokens: 2048
    },

    data: {
        id: 'data', name: '数据分析师',
        description: '请假统计、公文统计、系统总览',
        model: MODELS.fast,
        systemPrompt: `你是数据统计助手。帮用户查询系统真实数据。

## 可查询数据
- 个人假期余额（剩余年假、病假）
- 请假统计（本周/本月/历史）
- 公文统计（总数、各类型数量）
- 待审批事项
- 系统总览

## 回复规则
1. 基于系统返回的真实数据回答
2. 用简单清晰格式展示
3. 用 emoji 点缀
4. 主动提醒关键信息

不要编造数据。`,
        temperature: 0.4, maxTokens: 2048
    },

    notify: {
        id: 'notify', name: '通知智能体',
        description: '飞书消息发送、用户通知、审批提醒',
        model: MODELS.fast,
        systemPrompt: `你是通知消息助手，负责通过飞书发送工作通知。

## 核心能力
1. 单用户通知：给指定用户发消息
2. 审批人通知：给所有管理员发提醒
3. 消息格式化：整理成清晰易读格式

## 通知格式
- 使用 emoji 让消息醒目
- 结构化展示（谁、什么事、时间）
- 需要回复的说明操作方式

## 输出 JSON
{"action":"notify_user","targetName":"张三","content":"消息内容"}
{"action":"notify_approvers","content":"消息内容"}

只输出 JSON，不要额外内容。`,
        temperature: 0.5, maxTokens: 1024
    },

    // 保留旧版 agent 定义
    coder: {
        id: 'coder', name: '代码工程师',
        description: '代码编写、调试、审查',
        model: MODELS.coder,
        systemPrompt: '你是资深软件工程师，帮用户写出能跑、能维护的好代码。',
        temperature: 0.4, maxTokens: 4096
    },

    reasoning: {
        id: 'reasoning', name: '深度思考专家',
        description: '复杂问题推理、决策辅助',
        model: MODELS.reasoning,
        systemPrompt: '你是思维严谨的深度思考专家，帮用户把问题想透、想全。',
        temperature: 0.8, maxTokens: 4096
    },

    meeting: {
        id: 'meeting', name: '会议纪要专家',
        description: '会议纪要、议程设计',
        model: MODELS.document,
        systemPrompt: '你是会议管理助手，让会议有产出、能落地。',
        temperature: 0.6, maxTokens: 3072
    },

    email: {
        id: 'email', name: '邮件助手',
        description: '工作邮件起草、润色',
        model: MODELS.fast,
        systemPrompt: '你是职场沟通专家，帮用户写出得体的好邮件。',
        temperature: 0.6, maxTokens: 2500
    },

    // 飞书全能助手（飞书群聊 + 私聊专用）
    feishu_chat: {
        id: 'feishu_chat', name: '飞书全能助手',
        description: '飞书场景全能助手 - 自然聊天 + 直接干活',
        model: MODELS.feishu,
        systemPrompt: `你是飞书群里的智能全能助手"小流"。你不仅能自然聊天，更能直接帮人干活——请假、写公文、审批、查数据、发通知，全都能直接搞定。

## 你的风格
- 😊 像真人一样自然聊天，不要一上来就列功能表
- 💬 回复简洁有力，群聊控制在 3-6 句话为宜
- 🎯 精准理解对方意图，能直接干活的就直接干，不废话
- 🤝 保持友好、幽默但不油腻
- 🧠 聪明但有边界，不懂就说不知道

## 核心能力（直接干活，不推脱）
1. **请假**：用户说"请假3天"→ 直接帮他整理请假申请（类型/时间/天数/事由），给出完整格式
2. **写公文**：用户说"帮我写通知"→ 直接写出完整公文，人名部门用【】标注
3. **审批**：看到请假/公文申请 → 给出审批意见（同意/驳回+理由）
4. **查数据**：用户要统计 → 给出数据分析和建议
5. **发通知**：用户要通知谁 → 写出通知内容
6. **聊天**：闲聊就闲聊，但要像真人一样接话

## 聊天原则
1. **先干活再聊天**：用户有明确需求就先满足需求，不要绕弯子
2. **简短优先**：群聊回复控制在 3-6 句话
3. **先回应再扩展**：先接住对方的话，再提供有用信息
4. **自然过渡**：闲聊就闲聊，不要强行引导到系统功能
5. **有温度**：适当用语气词和 emoji，但别过度

## 最重要的是
你是能直接干活的助手，不是只会说"我建议你这样做"的客服。用户要请假你就帮请假，要写公文你就写公文，要查数据你就查数据。直接、高效、不推脱！`,
        temperature: 0.85, maxTokens: 2048
    }
};

// ============================================================
//  Agent 聊天接口
// ============================================================
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
    return Object.values(AGENTS).map(a => ({ id: a.id, name: a.name, description: a.description }));
}

async function analyzeWithAgent(agentId, prompt, context) {
    const agent = AGENTS[agentId];
    if (!agent) return { success: false, error: '未知智能体: ' + agentId };
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

// ============================================================
//  Leave Agent - 请假智能体（完整实现）
// ============================================================
async function leaveAgentProcess(message, context = {}) {
    const { userId, userName, feishuChatId, feishuMsgId, feishuOpenId } = context;

    // 第一步：AI 解析请假信息
    const parsePrompt = `请从以下用户消息中提取请假信息，输出 JSON：

用户消息：${message}

输出格式：
{"action":"apply","type":"年假/事假/病假","days":3,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","reason":"请假原因"}
或 {"action":"query"}（查询请假记录）
或 {"action":"approve","comment":"批准理由"}
或 {"action":"reject","comment":"驳回理由"}

只输出 JSON，不要额外内容。`;

    const parseResult = await callAI(MODELS.fast, [
        { role: 'system', content: '你是请假信息提取器。只输出 JSON。' },
        { role: 'user', content: parsePrompt }
    ], { temperature: 0.1, max_tokens: 500 });

    if (!parseResult.success) {
        return { success: false, content: 'AI 解析请假信息失败，请重新描述。', error: parseResult.error };
    }

    // 解析 JSON
    let action;
    try {
        const jsonStr = (parseResult.content || '').match(/\{[\s\S]*\}/);
        if (jsonStr) {
            action = JSON.parse(jsonStr[0]);
        } else {
            action = { action: 'apply', type: '事假', days: 1, reason: message };
        }
    } catch (e) {
        action = { action: 'apply', type: '事假', days: 1, reason: message };
    }

    console.log('[Leave Agent] 解析结果:', JSON.stringify(action));

    // 第二步：执行对应操作
    if (action.action === 'query' || message.includes('查询') || message.includes('记录')) {
        // 查询请假
        if (!dbHelper) return { success: false, content: '数据库未连接' };
        const leaves = dbHelper.getMyLeaves(userId, 10);
        const balance = dbHelper.getLeaveBalance(userId);

        if (leaves.length === 0) {
            return { success: true, content: `📋 ${userName || '你'}目前没有请假记录。\n\n🌴 当前年假余额：${balance.annual.remaining} 天` };
        }

        let text = `📋 ${userName || '你'}的请假记录（共 ${leaves.length} 条）\n\n`;
        const emoji = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌' };
        for (const l of leaves.slice(0, 10)) {
            const st = l.status === 'APPROVED' ? '已批准' : l.status === 'REJECTED' ? '已驳回' : '待审批';
            text += `${emoji[l.status] || '❓'} ${l.type} · ${l.days}天 (${l.start_date}~${l.end_date})\n`;
            if (l.reason) text += `   事由：${l.reason}\n`;
            text += `   状态：${st}\n\n`;
        }
        text += `🌴 当前年假余额：${balance.annual.remaining} 天`;
        return { success: true, content: text, action: 'query', data: { leaves, balance } };
    }

    if (action.action === 'approve' || action.action === 'reject') {
        return {
            success: true,
            content: action.action === 'approve'
                ? `✅ 审批通过！\n💬 ${action.comment || '已批准'}`
                : `❌ 已驳回。\n💬 ${action.comment || '不予批准'}`,
            action: action.action,
            comment: action.comment
        };
    }

    // apply: 提交请假申请
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    const leaveType = action.type || '事假';
    const days = action.days || 1;
    const startDate = action.startDate || new Date().toISOString().slice(0, 10);
    const endDate = action.endDate || startDate;
    const reason = action.reason || '';

    const r = dbHelper.createLeaveRequest(userId, leaveType, startDate, endDate, days, reason, feishuChatId || '', feishuMsgId || '');

    // 查余额
    const balance = dbHelper.getLeaveBalance(userId);
    const admins = dbHelper.getAdmins();
    const adminNames = admins.map(a => a.name).join('、');

    const resultText = `📝 请假申请已提交\n\n` +
        `👤 申请人：${userName || '用户#' + userId}\n` +
        `📋 类型：${leaveType}\n` +
        `📅 时间：${startDate} 至 ${endDate}\n` +
        `📊 天数：${days}天\n` +
        `💬 事由：${reason || '无'}\n` +
        `🌴 剩余年假：${balance.annual.remaining} 天\n\n` +
        `⏳ 等待 ${adminNames} 审批\n` +
        `👉 领导请回复「同意」或「不同意」`;

    // 异步给审批人发飞书通知
    if (feishuSender) {
        const notifyText = `📝 新的请假申请\n\n` +
            `👤 ${userName || '用户#' + userId}\n` +
            `📋 ${leaveType} · ${days}天\n` +
            `📅 ${startDate} ~ ${endDate}\n` +
            `💬 ${reason || '无'}\n\n` +
            `👉 请及时审批！回复「同意」或「不同意」`;
        try {
            await feishuSender.sendToApprovers(notifyText);
        } catch (e) {
            console.error('[Leave Agent] 飞书通知失败:', e.message);
        }
    }

    return {
        success: true,
        content: resultText,
        action: 'apply',
        data: { leaveId: r.lastID, type: leaveType, days, startDate, endDate, reason }
    };
}

// ============================================================
//  Document Agent - 公文智能体（完整实现）
// ============================================================
async function documentAgentProcess(message, context = {}) {
    const { userId, userName } = context;

    // 判断是创建公文还是审批公文
    const isCreate = /创建|写|起草|新建|生成|帮我写|帮忙写|写份|写个|拟|草拟|create|write|draft|procurement/i.test(message);
    const isApprove = /审批公文|批准公文|审核公文|审阅公文|approve document/i.test(message);

    if (isCreate) {
        // 第一步：AI 提取公文要素
        const extractPrompt = `从用户消息中提取公文信息，输出 JSON：
用户消息：${message}

{"title":"公文标题","type":"NOTICE/PROPOSAL/REPORT","priority":"NORMAL/HIGH/LOW","content":"公文正文内容"}

类型说明：
- NOTICE: 通知（会议通知、工作安排等）
- PROPOSAL: 请示（经费请示、人事请示等）
- REPORT: 报告（工作报告、总结报告等）

只输出 JSON，不要额外内容。`;

        const extractResult = await callAI(MODELS.fast, [
            { role: 'system', content: '你是公文信息提取器。只输出 JSON。' },
            { role: 'user', content: extractPrompt }
        ], { temperature: 0.2, max_tokens: 2000 });

        let docInfo = { title: message.slice(0, 50), type: 'NOTICE', priority: 'NORMAL', content: '' };
        if (extractResult.success) {
            try {
                const jsonStr = (extractResult.content || '').match(/\{[\s\S]*\}/);
                if (jsonStr) {
                    const parsed = JSON.parse(jsonStr[0]);
                    docInfo.title = parsed.title || docInfo.title;
                    docInfo.type = parsed.type || docInfo.type;
                    docInfo.priority = parsed.priority || docInfo.priority;
                    docInfo.content = parsed.content || '';
                }
            } catch (e) { /* 解析失败用默认值 */ }
        }

        // 第二步：如果 AI 没有生成正文，用 Document Agent 生成
        if (!docInfo.content || docInfo.content.length < 20) {
            const genPrompt = `请为以下公文生成完整正文：
标题：${docInfo.title}
类型：${docInfo.type === 'NOTICE' ? '通知' : docInfo.type === 'PROPOSAL' ? '请示' : '报告'}
要求：专业正式，条理清晰，包含必要的段落和落款。`;

            const genResult = await callAI(MODELS.document, [
                { role: 'system', content: AGENTS.document.systemPrompt },
                { role: 'user', content: genPrompt }
            ], { temperature: 0.6, max_tokens: 2000 });

            if (genResult.success) {
                docInfo.content = genResult.content;
            } else {
                docInfo.content = docInfo.title + '\n\n（内容待补充）';
            }
        }

        // 第三步：写入数据库
        if (!dbHelper) return { success: false, content: '数据库未连接' };
        const r = dbHelper.createDocument(docInfo.title, docInfo.content, docInfo.type, docInfo.priority, userId);

        const typeNames = { NOTICE: '通知', PROPOSAL: '请示', REPORT: '报告' };
        const resultText = `📄 公文已创建\n\n` +
            `📌 标题：${docInfo.title}\n` +
            `📝 类型：${typeNames[docInfo.type] || docInfo.type}\n` +
            `🔥 优先级：${docInfo.priority === 'HIGH' ? '紧急' : docInfo.priority === 'LOW' ? '普通' : '一般'}\n` +
            `👤 创建人：${userName || '用户#' + userId}\n` +
            `🆔 编号：#${r.lastID}\n` +
            `⏳ 状态：待审批\n\n` +
            `📋 正文：\n${docInfo.content.slice(0, 500)}${docInfo.content.length > 500 ? '\n...(内容较长，已截断)' : ''}`;

        // 给审批人发飞书通知
        if (feishuSender) {
            const notifyText = `📄 新公文待审批\n\n📌 ${docInfo.title}\n📝 ${typeNames[docInfo.type] || docInfo.type}\n👤 ${userName || '用户#' + userId}\n🔥 ${docInfo.priority === 'HIGH' ? '紧急' : '一般'}\n\n👉 请及时审批！`;
            try { await feishuSender.sendToApprovers(notifyText); } catch (e) {}
        }

        return {
            success: true,
            content: resultText,
            action: 'create',
            data: { docId: r.lastID, title: docInfo.title, type: docInfo.type, content: docInfo.content }
        };
    }

    if (isApprove) {
        // 审批公文
        if (!dbHelper) return { success: false, content: '数据库未连接' };

        // 尝试从消息中提取公文编号
        const idMatch = message.match(/#?(\d+)/);
        if (idMatch) {
            const docId = parseInt(idMatch[1]);
            const doc = dbHelper.getDocumentById(docId);
            if (!doc) return { success: false, content: `找不到编号 #${docId} 的公文` };
            if (doc.status !== 'PENDING') return { success: false, content: `公文 #${docId} 当前状态为 ${doc.status}，无需审批` };

            dbHelper.approveDocument(docId, userId, '已批准');

            // 给申请人发通知
            if (feishuSender && doc.applicant_id) {
                try {
                    await feishuSender.sendToUser(doc.applicant_id,
                        `✅ 你的公文已批准\n\n📌 ${doc.title}\n👤 审批人：${userName || '管理员'}`);
                } catch (e) {}
            }

            return {
                success: true,
                content: `✅ 公文 #${docId}「${doc.title}」已批准！`,
                action: 'approve',
                data: { docId }
            };
        }

        // 没有编号，列出待审批公文
        const pendingDocs = dbHelper.getPendingDocs(5);
        if (pendingDocs.length === 0) {
            return { success: true, content: '📋 当前没有待审批的公文' };
        }
        let text = '📋 待审批公文：\n\n';
        for (const d of pendingDocs) {
            text += `  📄 #${d.id} ${d.title}\n     👤 ${d.applicant_name || '未知'} | ${d.type} | ${d.priority === 'HIGH' ? '🔥紧急' : '一般'}\n\n`;
        }
        text += '👉 回复「同意 #编号」即可审批';
        return { success: true, content: text, action: 'list_pending', data: { pendingDocs } };
    }

    return { success: true, content: '请说明具体操作：创建公文 / 审批公文' };
}

// ============================================================
//  Stats Agent - 统计智能体（完整实现）
// ============================================================
async function statsAgentProcess(message, context = {}) {
    const { userId, userName, isAdmin } = context;
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    const user = dbHelper.getUserById(userId) || { id: userId, name: userName, role: isAdmin ? 'ADMIN' : 'EMPLOYEE' };
    const adminView = isAdmin || user.role === 'ADMIN';

    // 假期余额
    if (/剩余|还剩|还有多少|年假|余额|假期|可休|balance|remaining/i.test(message)) {
        const balance = dbHelper.getLeaveBalance(userId);
        return {
            success: true,
            content: `📅 ${balance.year}年度假期余额\n\n` +
                `🌴 年假：剩余 ${balance.annual.remaining} 天（共 ${balance.annual.total} 天，已用 ${balance.annual.used} 天）\n` +
                `🤒 病假：剩余 ${balance.sick.remaining} 天（共 ${balance.sick.total} 天）\n` +
                `📋 事假：剩余 ${balance.personal.remaining} 天（共 ${balance.personal.total} 天）`,
            action: 'balance', data: { balance }
        };
    }

    // 本周统计
    if (/本周|这周|this week/i.test(message)) {
        const week = dbHelper.getWeekRange();
        const weekLeave = dbHelper.countLeavesInRange(adminView ? null : userId, week.start, week.end, false);
        return {
            success: true,
            content: `📅 本周请假统计（${week.start} ~ ${week.end}）\n\n📝 请假单：${weekLeave.count} 份\n📊 请假天数：${weekLeave.days} 天`,
            action: 'week_stats', data: { week, weekLeave }
        };
    }

    // 本月统计
    if (/本月|这个月/.test(message)) {
        const month = dbHelper.getMonthRange();
        const monthLeave = dbHelper.countLeavesInRange(adminView ? null : userId, month.start, month.end, false);
        return {
            success: true,
            content: `📅 本月请假统计（${month.start} ~ ${month.end}）\n\n📝 请假单：${monthLeave.count} 份\n📊 请假天数：${monthLeave.days} 天`,
            action: 'month_stats', data: { month, monthLeave }
        };
    }

    // 待审批
    if (/待审批|待办|待处理|pending/i.test(message)) {
        const pendingDocs = dbHelper.getPendingDocs(10);
        const pendingLeaves = dbHelper.dbAll(
            `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 10`
        );
        let text = `📋 待审批事项\n\n📄 待审批公文：${pendingDocs.length} 份\n`;
        for (const d of pendingDocs.slice(0, 5)) {
            text += `  · #${d.id} ${d.title} (${d.applicant_name || '未知'})\n`;
        }
        text += `\n📝 待审批请假：${pendingLeaves.length} 份\n`;
        for (const l of pendingLeaves.slice(0, 5)) {
            text += `  · #${l.id} ${l.user_name || '未知'}：${l.type} ${l.days}天\n`;
        }
        return { success: true, content: text, action: 'pending', data: { pendingDocs, pendingLeaves } };
    }

    // 公文统计
    if (/公文|文档|通知|请示|报告/.test(message)) {
        const stats = dbHelper.getDocStats();
        const typeNames = { NOTICE: '通知', PROPOSAL: '请示', REPORT: '报告', DECISION: '决议', MEMO: '会议纪要' };
        let text = `📄 公文统计\n\n总数：${stats.total} 份\n\n`;
        for (const t of stats.byType) {
            text += `  · ${typeNames[t.type] || t.type}：${t.count} 份\n`;
        }
        text += `\n⏳ 待审批：${stats.pending} | ✅ 已批准：${stats.approved} | ❌ 已驳回：${stats.rejected}`;
        return { success: true, content: text, action: 'doc_stats', data: stats };
    }

    // 系统总览（默认）
    const overview = dbHelper.getSystemOverview();
    const balance = dbHelper.getLeaveBalance(userId);
    const week = dbHelper.getWeekRange();
    const weekLeave = dbHelper.countLeavesInRange(adminView ? null : userId, week.start, week.end, false);

    let text = `📊 系统数据概览\n\n`;
    text += `👥 用户总数：${overview.totalUsers} 人\n`;
    text += `📄 公文总数：${overview.totalDocs} 份\n`;
    text += `📝 请假申请：${overview.totalLeave} 份\n`;
    text += `⏳ 待审批公文：${overview.pendingDocs} 份\n`;
    text += `⏳ 待审批请假：${overview.pendingLeave} 份\n`;
    text += `📅 本周请假：${weekLeave.count} 份 (${weekLeave.days} 天)\n\n`;
    text += `${user.name || userName}的个人信息：\n`;
    text += `🌴 剩余年假：${balance.annual.remaining} 天`;
    if (overview.admins.length > 0) {
        text += `\n\n👔 管理员：${overview.admins.map(a => a.name).join('、')}`;
    }
    return { success: true, content: text, action: 'overview', data: { overview, balance } };
}

// ============================================================
//  Notify Agent - 通知智能体（完整实现）
// ============================================================
async function notifyAgentProcess(message, context = {}) {
    if (!feishuSender) {
        return { success: false, content: '飞书消息服务未连接，无法发送通知。' };
    }
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    // AI 解析通知意图
    const parsePrompt = `从用户消息中提取通知信息，输出 JSON：
用户消息：${message}

可选操作：
- notify_user: 给指定用户发消息 → {"action":"notify_user","targetName":"张三","content":"消息内容"}
- notify_approvers: 给所有审批人发消息 → {"action":"notify_approvers","content":"消息内容"}

如果找不到明确目标，默认 notify_approvers。
只输出 JSON。`;

    const parseResult = await callAI(MODELS.fast, [
        { role: 'system', content: '你是通知信息提取器。只输出 JSON。' },
        { role: 'user', content: parsePrompt }
    ], { temperature: 0.1, max_tokens: 500 });

    let action = { action: 'notify_approvers', content: message };
    if (parseResult.success) {
        try {
            const jsonStr = (parseResult.content || '').match(/\{[\s\S]*\}/);
            if (jsonStr) action = JSON.parse(jsonStr[0]);
        } catch (e) { /* 使用默认值 */ }
    }

    if (action.action === 'notify_user' && action.targetName) {
        // 按姓名查找用户
        const user = dbHelper.getUserByName(action.targetName);
        if (!user) {
            return { success: false, content: `找不到名为「${action.targetName}」的用户` };
        }

        const text = `📢 来自系统的通知\n\n${action.content}\n\n—— ${new Date().toLocaleString('zh-CN')}`;
        try {
            const result = await feishuSender.sendToUser(user.id, text);
            if (result.success) {
                dbHelper.createNotification(user.id, 'FEISHU', '通知', text, 'SENT');
                return { success: true, content: `✅ 已给 ${user.name} 发送飞书通知`, action: 'notify_user', data: { user } };
            } else {
                return { success: false, content: `❌ 发送失败：${result.reason || '未知错误'}` };
            }
        } catch (e) {
            return { success: false, content: `❌ 发送失败：${e.message}` };
        }
    }

    // 默认：发给审批人
    const text = `📢 通知提醒\n\n${action.content}\n\n—— ${new Date().toLocaleString('zh-CN')}`;
    try {
        const result = await feishuSender.sendToApprovers(text);
        if (result.success) {
            return {
                success: true,
                content: `✅ 已给 ${result.sent}/${result.total} 位审批人发送飞书通知`,
                action: 'notify_approvers',
                data: result
            };
        } else {
            return { success: false, content: `❌ 发送失败：${result.reason || '所有审批人未绑定飞书'}` };
        }
    } catch (e) {
        return { success: false, content: `❌ 发送失败：${e.message}` };
    }
}

// ============================================================
//  Router Agent - 主入口（意图 → Agent 执行）
// ============================================================
async function routerAgentProcess(message, context = {}) {
    console.log('[Router] 收到消息:', message.slice(0, 80));
    console.log('[Router] 上下文:', JSON.stringify({ userId: context.userId, userName: context.userName, isAdmin: context.isAdmin }));

    const isFeishu = !!(context.feishuChatId || context.feishuOpenId);
    const convId = context.conversationId || ('user_' + (context.userId || 'anon'));

    // 1. 统一 LLM 意图识别（全 AI 驱动，不再用死板规则）
    const intentResult = await classifyIntent(message);
    console.log('[Router] 意图:', intentResult.intent, '方法:', intentResult.method);

    // 2. 根据意图路由到对应处理
    switch (intentResult.intent) {
        case 'leave_apply':
        case 'leave_query':
            return await leaveAgentProcess(message, context);

        case 'doc_create':
        case 'doc_approve':
            return await documentAgentProcess(message, context);

        case 'stats':
            return await statsAgentProcess(message, context);

        case 'notify':
            return await notifyAgentProcess(message, context);

        case 'approve_action':
        case 'reject_action':
            return await handleQuickApproval(message, context, intentResult.intent);

        default:
            // 通用对话 - 用全能助手直接干活
            if (isFeishu) {
                // 飞书场景 → 用飞书全能助手（能聊能干活）
                const userNameTag = context.userName ? `\n[当前用户：${context.userName}，用户ID：${context.userId}，${context.isAdmin ? '管理员' : '员工'}]` : '';
                const result = await chatWithAgent('feishu_chat', message + userNameTag, convId);
                if (result.success) {
                    return { success: true, content: result.content, action: 'chat' };
                }
            } else {
                // Web 场景 → 用全能助手
                const userNameTag = context.userName ? `\n[当前用户：${context.userName}，用户ID：${context.userId}，${context.isAdmin ? '管理员' : '员工'}]` : '';
                const result = await chatWithAgent('general', message + userNameTag, convId);
                if (result.success) {
                    return { success: true, content: result.content, action: 'chat' };
                }
            }
            return { success: false, content: 'AI 服务暂时不可用，请稍后重试。' };
    }
}

// 快速审批处理（同意/驳回）
async function handleQuickApproval(message, context, actionType) {
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    const { userId, userName, feishuChatId } = context;

    // 检查是否是管理员
    const user = dbHelper.getUserById(userId);
    if (!user || user.role !== 'ADMIN') {
        return { success: true, content: '⚠️ 只有管理员可以审批。如需审批，请联系管理员。' };
    }

    // 找待审批的请假
    let pendingLeave = null;
    if (feishuChatId) {
        pendingLeave = dbHelper.getPendingLeaveInChat(feishuChatId);
    }
    if (!pendingLeave) {
        pendingLeave = dbHelper.dbGet(
            `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 1`
        );
    }

    // 找待审批的公文
    const pendingDocs = dbHelper.getPendingDocs(1);

    if (actionType === 'approve_action') {
        let resultText = '';
        let hasApproved = false;

        // 优先审批请假
        if (pendingLeave) {
            dbHelper.approveLeave(pendingLeave.id, userId, message.replace(/同意|批准|ok|okay|好的|可以|准了|通过|没问题|准假|批了/gi, '').trim() || '已批准');
            resultText += `✅ 请假已批准！\n👤 ${pendingLeave.user_name} · ${pendingLeave.type} ${pendingLeave.days}天\n📅 ${pendingLeave.start_date} ~ ${pendingLeave.end_date}\n🎉 假期愉快！`;
            hasApproved = true;

            // 给申请人发通知
            if (feishuSender && pendingLeave.user_id) {
                try {
                    await feishuSender.sendToUser(pendingLeave.user_id,
                        `✅ 你的请假已批准\n\n📋 ${pendingLeave.type} · ${pendingLeave.days}天\n📅 ${pendingLeave.start_date} ~ ${pendingLeave.end_date}\n👤 审批人：${userName || '管理员'}\n🎉 假期愉快！`);
                } catch (e) {}
            }
        }

        if (pendingDocs.length > 0) {
            const doc = pendingDocs[0];
            dbHelper.approveDocument(doc.id, userId, '已批准');
            if (resultText) resultText += '\n\n';
            resultText += `✅ 公文已批准！\n📄 #${doc.id} ${doc.title}`;
            hasApproved = true;

            if (feishuSender && doc.applicant_id) {
                try {
                    await feishuSender.sendToUser(doc.applicant_id,
                        `✅ 你的公文已批准\n\n📌 ${doc.title}\n👤 审批人：${userName || '管理员'}`);
                } catch (e) {}
            }
        }

        if (!hasApproved) {
            resultText = '📋 当前没有待审批的事项。';
        }
        return { success: true, content: resultText, action: 'approve' };
    }

    // 驳回
    if (actionType === 'reject_action') {
        let resultText = '';
        let hasRejected = false;
        const comment = message.replace(/不同意|驳回|拒绝|不准|不行|否决|不批/g, '').trim() || '不予批准';

        if (pendingLeave) {
            dbHelper.rejectLeave(pendingLeave.id, userId, comment);
            resultText += `❌ 请假已驳回！\n👤 ${pendingLeave.user_name} · ${pendingLeave.type} ${pendingLeave.days}天\n💬 ${comment}`;
            hasRejected = true;

            if (feishuSender && pendingLeave.user_id) {
                try {
                    await feishuSender.sendToUser(pendingLeave.user_id,
                        `❌ 你的请假未通过\n\n📋 ${pendingLeave.type} · ${pendingLeave.days}天\n📅 ${pendingLeave.start_date} ~ ${pendingLeave.end_date}\n💬 ${comment}`);
                } catch (e) {}
            }
        }

        if (pendingDocs.length > 0) {
            const doc = pendingDocs[0];
            dbHelper.rejectDocument(doc.id, userId, comment);
            if (resultText) resultText += '\n\n';
            resultText += `❌ 公文已驳回！\n📄 #${doc.id} ${doc.title}\n💬 ${comment}`;
            hasRejected = true;
        }

        if (!hasRejected) {
            resultText = '📋 当前没有待审批的事项。';
        }
        return { success: true, content: resultText, action: 'reject' };
    }

    return { success: false, content: '无法处理审批操作' };
}

// ============================================================
//  协作系统（保留原有多智能体协作）
// ============================================================
async function generateCollaborationPlan(userMessage, context) {
    const agentOptions = Object.values(AGENTS).map(a =>
        '- ' + a.id + '（' + a.name + '）：' + a.description
    ).join('\n');

    const systemPrompt = `你是多智能体协作协调员。分析需求，判断调用哪些智能体。

可选智能体：\n${agentOptions}

协作模式：
- sequential：序列协作（有先后逻辑的任务）
- parallel：并行分析（多维度评估）

输出 JSON：
{"mode":"sequential|parallel","agents":["id1","id2"],"rationale":"选择理由","agentInstructions":{"id1":"任务指令","id2":"任务指令"}}

只输出 JSON。`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: (context ? '【上下文】\n' + context + '\n\n' : '') + '【需求】\n' + userMessage }
    ];

    const result = await callAI(MODELS.general, messages, { temperature: 0.3, max_tokens: 2048 });

    if (!result.success) {
        return { mode: 'sequential', agents: ['general'], rationale: '智能调度失败', agentInstructions: {} };
    }
    try {
        const jsonStr = result.content.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(jsonStr);
    } catch (e) {
        return { mode: 'sequential', agents: ['general'], rationale: '解析失败', agentInstructions: {} };
    }
}

async function runSequentialCollaboration(plan, userMessage, sessionId) {
    const results = [];
    let accumulatedContext = userMessage;
    for (let i = 0; i < plan.agents.length; i++) {
        const agentId = plan.agents[i];
        const agent = AGENTS[agentId];
        if (!agent) continue;

        const instruction = (plan.agentInstructions && plan.agentInstructions[agentId])
            ? plan.agentInstructions[agentId]
            : '请基于前面的分析，继续从你的专业角度完成任务。';

        const prompt = `【用户原始需求】\n${userMessage}\n\n【之前的分析】\n${accumulatedContext}\n\n【你的任务】\n${instruction}`;
        const messages = [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: prompt }
        ];
        const res = await callAI(agent.model, messages, { temperature: agent.temperature, max_tokens: agent.maxTokens });
        results.push({
            agentId, agentName: agent.name, order: i + 1,
            content: res.success ? res.content : '调用失败: ' + res.error,
            success: res.success, tokens: res.tokens, elapsed: res.elapsed, model: res.model
        });
        if (res.success) accumulatedContext += '\n\n【' + agent.name + ' 的输出】\n' + res.content;
    }
    const summary = await summarizeResults(results, userMessage, 'sequential');
    return { sessionId, mode: 'sequential', steps: results, summary };
}

async function runParallelCollaboration(plan, userMessage, sessionId) {
    const tasks = plan.agents.map(agentId => {
        const agent = AGENTS[agentId];
        if (!agent) return null;
        const instruction = (plan.agentInstructions && plan.agentInstructions[agentId])
            ? plan.agentInstructions[agentId]
            : '请从你的专业角度独立分析。';
        const prompt = `【用户需求】\n${userMessage}\n\n【你的任务】\n${instruction}`;
        return callAI(agent.model, [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: prompt }
        ], { temperature: agent.temperature, max_tokens: agent.maxTokens }).then(res => ({
            agentId, agentName: agent.name,
            content: res.success ? res.content : '调用失败: ' + res.error,
            success: res.success, tokens: res.tokens, elapsed: res.elapsed, model: res.model
        }));
    }).filter(t => t !== null);

    const results = await Promise.all(tasks);
    const summary = await summarizeResults(results, userMessage, 'parallel');
    return { sessionId, mode: 'parallel', steps: results, summary };
}

async function summarizeResults(results, userMessage, mode) {
    const contributions = results.map((r, i) => `【${i + 1}. ${r.agentName}】\n${r.content}`).join('\n\n=================\n\n');
    const prompt = `你是协作汇总协调员。整合各智能体的输出。

回复结构：
📌 核心结论
🔍 各专业视角分析
💡 综合建议
⚠️ 注意事项`;

    const res = await callAI(MODELS.general, [
        { role: 'system', content: prompt },
        { role: 'user', content: `【用户原始需求】\n${userMessage}\n\n【模式】\n${mode}\n\n【各智能体贡献】\n${contributions}` }
    ], { temperature: 0.5, max_tokens: 3072 });

    return {
        content: res.success ? res.content : '汇总失败: ' + res.error,
        success: res.success, tokens: res.tokens, elapsed: res.elapsed, model: res.model
    };
}

async function collaborateWithAgents(message, options = {}) {
    const mode = options.mode || 'auto';
    const chosenAgents = options.agents || null;
    const context = options.context || '';
    const sessionId = options.sessionId || ('collab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));

    let plan;
    if (chosenAgents && chosenAgents.length > 0) {
        const agentInstructions = {};
        chosenAgents.forEach(id => {
            if (AGENTS[id]) agentInstructions[id] = '请从 ' + AGENTS[id].name + ' 角度独立分析。';
        });
        plan = { mode: chosenAgents.length === 1 ? 'sequential' : mode, agents: chosenAgents, rationale: '手动选择', agentInstructions };
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

// ============================================================
//  导出
// ============================================================
module.exports = {
    // 依赖注入
    injectDB,
    injectFeishu,

    // Router Agent（核心入口）
    classifyIntent,
    routerAgentProcess,

    // 各 Agent
    leaveAgentProcess,
    documentAgentProcess,
    statsAgentProcess,
    notifyAgentProcess,
    handleQuickApproval,

    // 通用 AI 接口
    callAI,
    chatWithAgent,
    listAgents: listAgents,
    analyzeWithAgent,
    clearConversation,

    // 协作系统
    collaborateWithAgents,
    generateCollaborationPlan,

    // 常量
    INTENT_TO_AGENT,
    AGENTS,
    MODELS,
    availableAgents: Object.keys(AGENTS),

    // 兼容旧接口
    getAgentsList: () => Object.values(AGENTS).map(a => ({ id: a.id, name: a.name, description: a.description })),
    COLLABORATION_STYLES: {
        sequential: { name: '序列协作', desc: '多个智能体按顺序接力完成任务' },
        parallel: { name: '并行分析', desc: '多个智能体同时从各自专业角度分析' },
        auto: { name: '自动调度', desc: 'AI 自动选择最优的智能体和协作模式' }
    },
    getCollaborationPlanOnly: generateCollaborationPlan
};
