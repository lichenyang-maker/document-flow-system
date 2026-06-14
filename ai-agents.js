var leaveFormStates = new Map();
var FIELD_PROMPTS = {
  type: "请问想请什么类别的假？（年假 / 事假 / 病假）",
  reason: "请假原因是什么？",
  startDate: "从哪天开始？（格式：YYYY-MM-DD）",
  endDate: "什么时候结束？（格式：YYYY-MM-DD）",
  days: "请几天？",
  course: "涉及哪门课程？（如果有）"
};

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
function getConversation(id, maxHistory = 30) {
    let conv = conversationStore.get(id);
    if (!conv) { conv = []; conversationStore.set(id, conv); }
    return conv.slice(-maxHistory);
}
function addMessage(id, role, content) {
    let conv = conversationStore.get(id);
    if (!conv) { conv = []; conversationStore.set(id, conv); }
    conv.push({ role, content, timestamp: Date.now() });
    if (conv.length > 80) conv.splice(0, conv.length - 80);
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

用户输入：（请查看对话内容）`;

    const result = await callAI(MODELS.intent, [
        { role: 'system', content: '你只返回意图名称，不要解释。' },
        { role: 'user', content: prompt }
    ], { temperature: 0.1, max_tokens: 50 });

    if (!result.success) {
        // LLM 调用失败 → 关键词兜底
        return fallbackClassify(message);
    }

    const content = (result.content || '').trim().toLowerCase();
    const valid = ['leave_apply', 'leave_query', 'doc_create', 'doc_approve', 'notify', 'stats', 'approve_action', 'reject_action', 'general'];
    for (const v of valid) {
        if (content.includes(v)) return { intent: v, method: 'llm' };
    }
    // LLM 返回了未知意图 → 关键词兜底
    return fallbackClassify(message);

    // 关键词兜底分类
    function fallbackClassify(msg) {
        if (/请个?假|申请请假|身体不舒服|生病|不舒服|想休息|休个?假|要休息|请病假|请事假|请年假|调休/.test(msg)) return { intent: 'leave_apply', method: 'keyword' };
        if (/查询|余额|记录|还剩|剩余|还有多少|年假/.test(msg)) return { intent: 'leave_query', method: 'keyword' };
        if (/统计|本周|本月|多少|几个|数据|报表|待审批|待办/.test(msg)) return { intent: 'stats', method: 'keyword' };
        if (/群里|群聊|群发|通知|提醒|告诉|发给|推送/.test(msg)) return { intent: 'notify', method: 'keyword' };
        if (/公文|起草|写份|写个|拟|草拟|采购|会议纪要/.test(msg)) return { intent: 'doc_create', method: 'keyword' };
        if (/审批公文|批准公文/.test(msg)) return { intent: 'doc_approve', method: 'keyword' };
        if (/同意|批准|准了|通过|准假|ok|可以|好的/.test(msg)) return { intent: 'approve_action', method: 'keyword' };
        if (/不同意|驳回|拒绝|不准|不行|否决|不批/.test(msg)) return { intent: 'reject_action', method: 'keyword' };
        return { intent: 'general', method: 'keyword_default' };
    }
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
    chart: 'data',
    notify: 'notify',
    general: 'general'
};

// ============================================================
//  Agent 定义
// ============================================================
const AGENTS = {
    feishu: {
        id: 'feishu', name: '学工助手小流',
        description: '飞书聊天专用 - 学工请假+公文审批助手',
        model: MODELS.feishu,
        systemPrompt: `你是飞书群里的学工请假全能助手"小流"。你能帮学生请假、帮老师审批、查记录、发通知，全都能直接搞定。

## 你的风格
- 😊 像真人一样自然聊天，不要一上来就列功能表
- 💬 回复简洁有力，群聊控制在 3-6 句话
- 🎯 精准理解对方意图，能直接干活的就直接干
- 🤝 保持友好、专业、有温度
- 👋 开口先招呼：「Hi 【姓名】～」
- 🎉 偶尔开玩笑、卖萌、调皮一下也可以，别太死板
- 用 emoji 点缀但不过度

## 核心能力（直接干活，不推脱）
1. **请假申请**：学生说"我要请假3天回家"→ 帮他整理请假信息（类型/时间/天数/事由），提交后通知老师审批
2. **审批请假**：老师说"同意 #5"→ 批准对应请假，自动通知学生结果
3. **查询记录**：学生问"我的请假记录"→ 展示历史请假和余额
4. **数据统计**：老师问"这周多少人请假"→ 给出统计数据
5. **通知提醒**：需要催审批时→ 主动提醒审批人
6. **群发消息**：用户说"在群里发个通知""告诉大家下午开会"→ 在飞书群里发消息

## 学工场景理解
- 学生请假需要辅导员/老师审批
- 辅导员可以审批所有学生的请假
- 老师可以审批本系学生的请假
- 审批后结果自动反馈给申请人

## 聊天原则
1. **先干活再聊天**：用户有明确需求就先满足需求
2. **简短优先**：群聊回复控制在 3-6 句话
3. **有温度**：对学生温暖鼓励，对老师专业简洁，熟人之间可以更随意
4. **自然过渡**：闲聊就闲聊，不要强行引导到功能
5. **禁止**：不要说「作为一个 AI」之类的话，不要教科书式回复，不要长篇大论

你是能直接干活的助手，不是只会说"我建议"的客服。学生请假就帮提交，老师审批就帮处理，直接高效！

现在，用户说：（请查看对话内容）`,
        temperature: 0.85, maxTokens: 2048
    },
    general: {
        description: '综合办公助手 - 能聊能干活，直接处理请假/公文/审批/查询',
        model: MODELS.general,
        systemPrompt: `你是「学工请假与公文审批系统」的智能助手，名叫【小流】，由 DeepSeek-V3 驱动。

## 身份定位
- 你是专业的学工管理助手，不是通用搜索引擎
- 你服务的场景是：高校/单位的请假审批、公文流转、通知发放
- 你懂学工业务：事假/病假/年假/婚假/丧假/产假各种假期制度，了解公文审批流程

## 说话风格
- 亲切专业，像个贴心的行政助理
- 开口先确认身份：「Hi 【姓名】～」
- 直接给出结论，再补充细节，不打官腔
- 用 emoji 增加可读性，但不过度
- 遇到请假/公文/统计请求，直接干活（提取信息→写入系统→回复结果）

## 业务处理
**请假**：用户说「请假」「想休息」「身体不舒服」→ 帮用户整理请假信息并提交系统
**公文**：用户说「写通知」「起草报告」「发会议纪要」→ 直接生成完整公文草稿
**审批**：用户是领导/老师 → 告诉他有哪些待审批，征询他的意见
**查询**：用户查记录/余额 → 直接查数据库，用清晰格式返回
**闲聊**：打招呼/问天气/吐槽 → 自然回应，但引导回业务场景

## 禁止
- 不要说「作为一个 AI，我没有情感」这类话
- 不要通用搜索引擎式回答
- 不要长篇大论，简洁有力，直奔主题

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
        description: '飞书场景全能助手 - 学工请假 + 自然聊天 + 直接干活',
        model: MODELS.feishu,
        systemPrompt: `你是飞书群里的学工请假全能助手"小流"。你能帮学生请假、帮老师审批、查记录、发通知，全都能直接搞定。

## 你的风格
- 😊 像真人一样自然聊天，不要一上来就列功能表
- 💬 回复简洁有力，群聊控制在 3-6 句话
- 🎯 精准理解对方意图，能直接干活的就直接干
- 🤝 保持友好、专业、有温度

## 核心能力（直接干活，不推脱）
1. **请假申请**：学生说"我要请假3天回家"→ 帮他整理请假信息（类型/时间/天数/事由），提交后通知老师审批
2. **审批请假**：老师说"同意 #5"→ 批准对应请假，自动通知学生结果
3. **查询记录**：学生问"我的请假记录"→ 展示历史请假和余额
4. **数据统计**：老师问"这周多少人请假"→ 给出统计数据
5. **通知提醒**：需要催审批时→ 主动提醒审批人

## 学工场景理解
- 学生请假需要辅导员/老师审批
- 辅导员可以审批所有学生的请假
- 老师可以审批本系学生的请假
- 审批后结果自动反馈给申请人

## 聊天原则
1. **先干活再聊天**：用户有明确需求就先满足需求
2. **简短优先**：群聊回复控制在 3-6 句话
3. **有温度**：对学生温暖鼓励，对老师专业简洁
4. **自然过渡**：闲聊就闲聊，不要强行引导到功能

你是能直接干活的助手，不是只会说"我建议"的客服。学生请假就帮提交，老师审批就帮处理，直接高效！`,
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
    const history = getConversation(conversationId, 20);
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
//  Leave Agent - 请假智能体（v4.0 全流程闭环）
// ============================================================


// ===== 多轮对话状态机处理 =====
async function startForm(convId, msg, ctx) {
  var f = {};
  try {
    var r = await callAI(MODELS.fast, [
      {role:"system",content:"从下面的消息中提取请假信息，输出 JSON。格式：{\"type\":\"\u5e74假/\u4e8b\u5047/\u75c5\u5047\",\"days\":\"\",\"startDate\":\"YYYY-MM-DD\",\"endDate\":\"\",\"reason\":\"\u539f因\",\"course\":\"\"}"},
      {role:"user",content:msg}
    ], {temperature:0.1, max_tokens:400});
    if (r && r.success && r.content) {
      var j = JSON.parse(r.content.replace(/```[\s\S]*?```/g,"").trim());
      for (var k in j) { if (j[k]) f[k] = String(j[k]).trim(); }
    }
  } catch(e){}

  var state = {state:"COLLECTING", fields:f, convId:convId, userId:ctx.userId, userName:ctx.userName, createdAt:Date.now()};
  var missing = ["type","reason","startDate","endDate","days"].filter(function(x){return !f[x] || !String(f[x]).trim()});
  leaveFormStates.set(convId, state);
  if (missing.length === 0) {
    state.state = "CONFIRMING";
    leaveFormStates.set(convId, state);
    return {success:true, content:buildConfirmMsg(f), action:"leave_form_confirm"};
  }
  return {success:true, content:FIELD_PROMPTS[missing[0]], action:"leave_form_collect"};
}

async function handleCollect(st, convId, msg, ctx) {
  var f = st.fields;
  // 检测修改命令
  if (/改|修改|变更|换成|调整|不对|等一下/i.test(msg)) {
    try {
      var r = await callAI(MODELS.fast, [
        {role:"system",content:"当前已有信息：" + JSON.stringify(f) + "\n用户要修改。输出修改后的完整 JSON。只输出 JSON。"},
        {role:"user",content:msg}
      ], {temperature:0.1, max_tokens:400});
      if (r && r.success && r.content) {
        var j = JSON.parse(r.content.replace(/```[\s\S]*?```/g,"").trim());
        for (var k in j) { if (j[k]) f[k] = String(j[k]).trim(); }
      }
    } catch(e){}
  } else {
    // 尝试提取信息
    try {
      var r = await callAI(MODELS.fast, [
        {role:"system",content:"提取请假信息 JSON。格式：{\"type\":\"\u5e74\u5047/\u4e8b\u5047/\u75c5\u5047\",\"days\":\"\",\"startDate\":\"\",\"endDate\":\"\",\"reason\":\"\",\"course\":\"\"}\u3002缺少的用空字符串。只输出 JSON。"},
        {role:"user",content:msg}
      ], {temperature:0.1, max_tokens:400});
      if (r && r.success && r.content) {
        var j = JSON.parse(r.content.replace(/```[\s\S]*?```/g,"").trim());
        for (var k in j) { if (j[k]) f[k] = String(j[k]).trim(); }
      }
    } catch(e){}
  }

  var missing = ["type","reason","startDate","endDate","days"].filter(function(x){return !f[x] || !String(f[x]).trim()});
  if (missing.length === 0) {
    st.state = "CONFIRMING";
    leaveFormStates.set(convId, st);
    return {success:true, content:buildConfirmMsg(f), action:"leave_form_confirm"};
  }
  leaveFormStates.set(convId, st);
  return {success:true, content:FIELD_PROMPTS[missing[0]], action:"leave_form_collect"};
}

async function handleConfirm(st, convId, msg, ctx) {
  if (/确认|提交|发送|发出|好的|可以|ok|yes|submit|confirm|确定|就这样|没问题/i.test(msg)) {
    // 提交请假
    var f = st.fields;
    if (!f.endDate && f.startDate && f.days) {
      var dd = new Date(f.startDate); dd.setDate(dd.getDate() + parseInt(f.days) - 1);
      f.endDate = dd.toISOString().slice(0,10);
    }
    if (!f.days && f.startDate && f.endDate) {
      f.days = String(Math.round((new Date(f.endDate) - new Date(f.startDate)) / 86400000) + 1);
    }
    var submitResult = await doSubmit(st, ctx);
    st.state = "SUBMITTED";
    leaveFormStates.set(convId, st);
    setTimeout(function(){leaveFormStates.delete(convId)}, 120000);
    return submitResult;
  }
  if (/不|取消|算了|不要|cancel/i.test(msg)) {
    st.state = "COLLECTING";
    leaveFormStates.set(convId, st);
    return {success:true, content:"想修改哪个？直接告诉我新的值。", action:"leave_form_collect"};
  }
  return {success:true, content:buildConfirmMsg(st.fields) + "\n\n→ 回复“确认”提交，或“修改”调整", action:"leave_form_confirm"};
}

function buildConfirmMsg(f) {
  var t = "请确认请假信息：\n\n";
  if (f.type) t += "📋 类别：" + f.type + "\n";
  if (f.reason) t += "💬 原因：" + f.reason + "\n";
  if (f.startDate) t += "📅 开始：" + f.startDate + "\n";
  if (f.endDate) t += "📅 结束：" + f.endDate + "\n";
  if (f.days) t += "⏰ 天数：" + f.days + "天\n";
  if (f.course) t += "📚 课程：" + f.course + "\n";
  t += "\n→ 回复“确认”提交，或“修改”调整";
  return t;
}

async function doSubmit(st, ctx) {
  var f = st.fields;
  if (!dbHelper) return {success:false, content:"数据库未连接"};
  try {
    var t = f.type||"事假", d = parseInt(f.days)||1, s = f.startDate||new Date().toISOString().slice(0,10), e = f.endDate||s, r = f.reason||"", c = f.course||"";
    var rr = dbHelper.createLeaveRequest(ctx.userId, t, s, e, d, r, ctx.feishuChatId||"", ctx.feishuMsgId||"", c);
    var bal = dbHelper.getLeaveBalance(ctx.userId);
    return {success:true, content:"✅ **请假申请已提交！**\n\n📋 类别：" + t + "\n📅 " + s + " ~ " + e + "\n⏰ " + d + "天\n💬 " + r + "\n🔙 #" + rr.lastID + "\n🌴 剩余年假：" + (bal?.annual?.remaining||"?") + "天\n\n⏳ 等待审批人审批..."};
  } catch(err) {
    return {success:false, content:"提交失败：" + err.message};
  }
}

async function leaveAgentProcess(message, context = {}) {
    const { userId, userName, feishuChatId, feishuMsgId, feishuOpenId, isAdmin } = context;


    // ===== 检查多轮对话状态 =====
    var convId = userId ? "leave_" + userId : "leave_anon";
    var st = leaveFormStates.get(convId);
    if (st) {
      if (st.state === "COLLECTING") return await handleCollect(st, convId, message, context);
      if (st.state === "CONFIRMING") return await handleConfirm(st, convId, message, context);
      if (st.state === "SUBMITTED") leaveFormStates.delete(convId);
    }

    // 识别“我要请假”
    if (/\u6211\u8981\u8bf7\u5047|\u60f3\u8bf7\u5047|\u7533\u8bf7\u8bf7\u5047|\u8bf7\u5047\u7533\u8bf7/i.test(message) && !/\u67e5\u8be2|\u8bb0\u5f55|\u5ba1\u6279|\u540c\u610f|\u62d2\u7edd|\u7edf\u8ba1|\u901a\u77e5|\u516c\u6587|\u521b\u5efa/.test(message)) {
      return await startForm(convId, message, context);
    }

    // 第一步：AI 解析请假信息
    const parsePrompt = `请从以下用户消息中提取请假信息，输出 JSON：

用户消息：（请查看对话内容）

## 意图判断
- 如果用户想请假/申请请假 → action=apply
- 如果用户想查询请假记录/余额 → action=query
- 如果用户说同意/批准某个请假 → action=approve，提取请假编号
- 如果用户说不同意/驳回某个请假 → action=reject，提取请假编号

## 输出格式
{"action":"apply","type":"年假/事假/病假","days":3,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","reason":"请假原因","course":"涉及的课程名（如果有）"}
{"action":"query"}
{"action":"approve","leaveId":123,"comment":"批准理由"}
{"action":"reject","leaveId":123,"comment":"驳回理由"}

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

    // ===== 查询请假记录 =====
    if (action.action === 'query' || message.includes('查询') || message.includes('记录') || message.includes('余额')) {
        if (!dbHelper) return { success: false, content: '数据库未连接' };
        const leaves = dbHelper.getMyLeaves(userId, 10);
        const balance = dbHelper.getLeaveBalance(userId);

        if (leaves.length === 0) {
            return { success: true, content: `📋 ${userName || '你'}目前没有请假记录。\n\n🌴 当前假期余额：\n  年假剩余 ${balance.annual.remaining} 天\n  病假剩余 ${balance.sick.remaining} 天\n  事假剩余 ${balance.personal.remaining} 天` };
        }

        let text = `📋 ${userName || '你'}的请假记录（共 ${leaves.length} 条）\n\n`;
        const emoji = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌' };
        for (const l of leaves.slice(0, 10)) {
            const st = l.status === 'APPROVED' ? '已批准' : l.status === 'REJECTED' ? '已驳回' : '待审批';
            text += `${emoji[l.status] || '❓'} #${l.id} ${l.type} · ${l.days}天 (${l.start_date}~${l.end_date})\n`;
            if (l.reason) text += `   事由：${l.reason}\n`;
            if (l.course) text += `   课程：${l.course}\n`;
            text += `   状态：${st}\n\n`;
        }
        text += `🌴 当前假期余额：\n  年假剩余 ${balance.annual.remaining} 天 | 病假剩余 ${balance.sick.remaining} 天 | 事假剩余 ${balance.personal.remaining} 天`;
        return { success: true, content: text, action: 'query', data: { leaves, balance } };
    }

    // ===== 审批请假（辅导员/老师/管理员专用）=====
    if (action.action === 'approve' || action.action === 'reject') {
        if (!dbHelper) return { success: false, content: '数据库未连接' };

        // 先检查用户是否有审批权限
        const user = dbHelper.getUserById(userId);
        if (!user || !['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role)) {
            return { success: true, content: '⚠️ 你没有审批权限。只有辅导员、老师或管理员可以审批请假。' };
        }

        // 尝试从消息或 action 中获取 leaveId
        let leaveId = action.leaveId;
        if (!leaveId) {
            const idMatch = message.match(/#(\d+)/);
            if (idMatch) leaveId = parseInt(idMatch[1]);
        }

        let leave;
        if (leaveId) {
            leave = dbHelper.getLeaveById ? dbHelper.getLeaveById(leaveId) : null;
        }
        if (!leave) {
            // 找最近的待审批请假
            leave = dbHelper.dbGet(
                `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 1`
            );
        }
        if (!leave) {
            return { success: true, content: '📋 当前没有待审批的请假。' };
        }

        if (action.action === 'approve') {
            const comment = action.comment || '已批准';
            dbHelper.approveLeave(leave.id, userId, comment);

            // 通知申请人（优先发结果卡片）
            let notified = false;
            if (feishuSender && leave.user_id) {
                try {
                    if (feishuSender.buildLeaveResultCard) {
                        const card = feishuSender.buildLeaveResultCard(leave, 'APPROVED', userName || '管理员', comment);
                        const result = await feishuSender.sendCardToUser(leave.user_id, card);
                        notified = result && result.success;
                    }
                    if (!notified) {
                        const result = await feishuSender.sendToUser(leave.user_id,
                            `✅ **请假已批准**\n\n📋 ${leave.type} · ${leave.days}天\n📅 ${leave.start_date} ~ ${leave.end_date}\n👤 审批人：${userName || '管理员'}\n💬 ${comment}\n\n🎉 假期愉快！`);
                        notified = result && result.success;
                    }
                } catch (e) { console.error('[Leave Agent] 通知申请人失败:', e.message); }
            }
            // 未绑定飞书 → 记录系统通知
            if (!notified && dbHelper && leave.user_id) {
                dbHelper.createNotification(leave.user_id, 'SYSTEM', '请假已批准',
                    `${leave.type} ${leave.days}天 (${leave.start_date}~${leave.end_date}) 已批准。审批人：${userName || '管理员'}。${comment}`, 'APPROVED');
            }

            return {
                success: true,
                content: `✅ 请假 #${leave.id} 已批准！\n\n👤 ${leave.user_name} · ${leave.type} ${leave.days}天\n📅 ${leave.start_date} ~ ${leave.end_date}\n${notified ? '🎉 已通知申请人' : '📝 已记录系统通知（该用户未绑定飞书）'}`,
                action: 'approve',
                data: { leaveId: leave.id }
            };
        } else {
            const comment = action.comment || '不予批准';
            dbHelper.rejectLeave(leave.id, userId, comment);

            let notified = false;
            if (feishuSender && leave.user_id) {
                try {
                    if (feishuSender.buildLeaveResultCard) {
                        const card = feishuSender.buildLeaveResultCard(leave, 'REJECTED', userName || '管理员', comment);
                        const result = await feishuSender.sendCardToUser(leave.user_id, card);
                        notified = result && result.success;
                    }
                    if (!notified) {
                        const result = await feishuSender.sendToUser(leave.user_id,
                            `❌ **请假未通过**\n\n📋 ${leave.type} · ${leave.days}天\n📅 ${leave.start_date} ~ ${leave.end_date}\n👤 审批人：${userName || '管理员'}\n💬 ${comment}\n\n如有疑问请联系审批人。`);
                        notified = result && result.success;
                    }
                } catch (e) { console.error('[Leave Agent] 通知申请人失败:', e.message); }
            }
            if (!notified && dbHelper && leave.user_id) {
                dbHelper.createNotification(leave.user_id, 'SYSTEM', '请假已驳回',
                    `${leave.type} ${leave.days}天 (${leave.start_date}~${leave.end_date}) 未通过。审批人：${userName || '管理员'}。${comment}`, 'REJECTED');
            }

            return {
                success: true,
                content: `❌ 请假 #${leave.id} 已驳回\n\n👤 ${leave.user_name} · ${leave.type} ${leave.days}天\n💬 ${comment}\n\n${notified ? '📤 已通知申请人' : '📝 已记录系统通知（该用户未绑定飞书）'}`,
                action: 'reject',
                data: { leaveId: leave.id }
            };
        }
    }

    // ===== 提交请假申请 =====
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    const leaveType = action.type || '事假';
    const days = action.days || 1;
    const startDate = action.startDate || new Date().toISOString().slice(0, 10);
    const endDate = action.endDate || startDate;
    const reason = action.reason || '';

    const course = action.course || '';
    const r = dbHelper.createLeaveRequest(userId, leaveType, startDate, endDate, days, reason, feishuChatId || '', feishuMsgId || '', course);

    // 查余额
    const balance = dbHelper.getLeaveBalance(userId);

    // 找审批人
    const applicant = dbHelper.getUserById(userId);
    const deptPrefix = (applicant?.department || '').replace(/[0-9]+级$/, '');
    let approvers = dbHelper.dbAll(
        `SELECT id, name, role FROM users WHERE role IN ('COUNSELOR', 'ADMIN') OR (role = 'TEACHER' AND department LIKE ?)`,
        ['%' + deptPrefix + '%']
    );
    if (approvers.length === 0) {
        approvers = dbHelper.dbAll(`SELECT id, name, role FROM users WHERE role IN ('COUNSELOR', 'ADMIN')`);
    }
    const approverNames = approvers.map(a => a.name).join('、');

    // 异步给每个审批人发飞书通知（教师收卡片，辅导员/管理员收文字）
    let notifiedCount = 0;
    const unboundApprovers = [];
    if (feishuSender) {
        // 分离教师和行政审批人
        const teacherApprovers = approvers.filter(a => a.role === 'TEACHER');
        const adminApprovers = approvers.filter(a => a.role !== 'TEACHER');

        // 给教师发交互卡片（含同意/拒绝按钮）
        if (teacherApprovers.length > 0 && feishuSender.buildLeaveApprovalCard) {
            const cardData = feishuSender.buildLeaveApprovalCard({
                id: r.lastID, type: leaveType, start_date: startDate,
                end_date: endDate, days, reason, course: action.course || '',
                user_id: userId
            }, applicant);
            for (const a of teacherApprovers) {
                try {
                    const sendResult = await feishuSender.sendCardToUser(a.id, cardData);
                    if (sendResult && sendResult.success) {
                        notifiedCount++;
                    } else {
                        unboundApprovers.push(a.name);
                    }
                } catch (e) {
                    console.error(`[Leave Agent] 卡片通知 ${a.name} 失败:`, e.message);
                    unboundApprovers.push(a.name);
                }
            }
        }

        // 给辅导员/管理员发文字通知
        if (adminApprovers.length > 0) {
            const notifyText = `📝 **新的请假申请**\n\n` +
                `👤 ${userName || '用户#' + userId}（${applicant?.department || ''}）\n` +
                `📋 ${leaveType} · ${days}天\n` +
                `📅 ${startDate} ~ ${endDate}\n` +
                `💬 ${reason || '无'}\n` +
                (action.course ? `📚 涉及课程：${action.course}\n` : '') +
                `🆔 编号：#${r.lastID}\n\n` +
                `👉 请及时审批！回复「同意 #${r.lastID}」或「不同意 #${r.lastID}」`;
            for (const a of adminApprovers) {
                try {
                    const sendResult = await feishuSender.sendToUser(a.id, notifyText);
                    if (sendResult && sendResult.success) {
                        notifiedCount++;
                    } else {
                        unboundApprovers.push(a.name);
                        if (dbHelper) {
                            dbHelper.createNotification(a.id, 'SYSTEM', '新请假申请待审批',
                                `${userName || '用户#' + userId} 提交了请假申请 #${r.lastID}（${leaveType} ${days}天）`, 'PENDING');
                        }
                    }
                } catch (e) {
                    console.error(`[Leave Agent] 通知 ${a.name} 失败:`, e.message);
                    unboundApprovers.push(a.name);
                }
            }
        }

        // 教师未绑飞书时记录系统通知
        for (const a of teacherApprovers) {
            if (unboundApprovers.includes(a.name)) {
                if (dbHelper) {
                    dbHelper.createNotification(a.id, 'SYSTEM', '新请假申请待审批',
                        `${userName || '用户#' + userId} 提交了请假申请 #${r.lastID}（${leaveType} ${days}天）${action.course ? '（课程：' + action.course + '）' : ''}`, 'PENDING');
                }
            }
        }
    }

    // 系统通知提示
    let notifyNote = '';
    if (unboundApprovers.length > 0 && unboundApprovers.length === approvers.length) {
        notifyNote = '\n⚠️ 所有审批人尚未绑定飞书，已转为系统通知。请提醒审批人登录系统查看。';
    } else if (unboundApprovers.length > 0) {
        notifyNote = `\n⚠️ ${unboundApprovers.join('、')} 未绑定飞书，已发系统通知。`;
    }

    const courseLine = course ? `📚 涉及课程：${course}\n` : '';
    const resultText = `📝 **请假申请已提交**\n\n` +
        `👤 申请人：${userName || '用户#' + userId}\n` +
        `📋 类型：${leaveType}\n` +
        `📅 时间：${startDate} 至 ${endDate}\n` +
        `📊 天数：${days}天\n` +
        `${courseLine}` +
        `💬 事由：${reason || '无'}\n` +
        `🆔 编号：#${r.lastID}\n` +
        `🌴 剩余年假：${balance.annual.remaining} 天\n` +
        `📤 已通知 ${notifiedCount}/${approvers.length} 位审批人\n` +
        (notifiedCount > 0 ? `⏳ 等待 ${approverNames} 审批\n` : '') +
        `👉 审批人请回复「同意 #${r.lastID}」或「不同意 #${r.lastID}」` +
        notifyNote;

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
用户消息：（请查看对话内容）

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
        const weekLeave = dbHelper.countLeavesInRange(adminView ? null : userId, c_week.start, c_week.end, false);
        return {
            success: true,
            content: `📅 本周请假统计（${c_week.start} ~ ${c_week.end}）\n\n📝 请假单：${c_wl.count} 份\n📊 请假天数：${c_wl.days} 天`,
            action: 'week_stats', data: { week, weekLeave }
        };
    }

    // 本月统计
    if (/本月|这个月/.test(message)) {
        const month = dbHelper.getMonthRange();
        const monthLeave = dbHelper.countLeavesInRange(adminView ? null : userId, c_month.start, c_month.end, false);
        return {
            success: true,
            content: `📅 本月请假统计（${c_month.start} ~ ${c_month.end}）\n\n📝 请假单：${c_ml.count} 份\n📊 请假天数：${c_ml.days} 天`,
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

    
    // ===== 图表生成 =====
    if (/图表|趋势图|柱状图|饼图|折线图|趋势|chart|统计图/i.test(message)) {
        try {
            var c_overview = dbHelper.getSystemOverview();
            var c_week = dbHelper.getWeekRange();
            var c_wl= dbHelper.countLeavesInRange(adminView ? null : userId, c_week.start, c_week.end, false);
            var c_month = dbHelper.getMonthRange();
            var c_ml= dbHelper.countLeavesInRange(adminView ? null : userId, c_month.start, c_month.end, false);
            var allLeaves = dbHelper.dbAll("SELECT type, COUNT(*) as cnt FROM leave_requests GROUP BY type");
            
            // Build chart data for quickchart.io
            var typeLabels = []; var typeCounts = [];
            var typeMap = { '\u5e74\u5047':'\u5e74\u5047', '\u4e8b\u5047':'\u4e8b\u5047', '\u75c5\u5047':'\u75c5\u5047', '\u5a5a\u5047':'\u5a5a\u5047', '\u4ea7\u5047':'\u4ea7\u5047' };
            for (var i = 0; i < allLeaves.length; i++) {
                typeLabels.push(allLeaves[i].type || '\u5176\u4ed6');
                typeCounts.push(allLeaves[i].cnt);
            }
            if (typeLabels.length === 0) { typeLabels = ['\u6682\u65e0\u6570\u636e']; typeCounts = [0]; }
            
            var chartConfig = JSON.stringify({
                type: 'bar',
                data: {
                    labels: typeLabels,
                    datasets: [{
                        label: '\u8bf7\u5047\u7c7b\u578b\u5206\u5e03',
                        data: typeCounts,
                        backgroundColor: ['rgba(64,158,255,0.7)', 'rgba(103,194,58,0.7)', 'rgba(230,162,60,0.7)', 'rgba(245,108,108,0.7)', 'rgba(144,147,153,0.7)'],
                        borderColor: ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399'],
                        borderWidth: 2
                    }]
                },
                options: {
                    title: { display: true, text: '\u8bf7\u5047\u7edf\u8ba1\u56fe\u8868' },
                    plugins: { legend: { display: true, position: 'bottom' } },
                    scales: { yAxes: [{ ticks: { beginAtZero: true, precision: 0 } }] }
                }
            });
            
            var chartUrl = 'https://quickchart.io/chart?c=' + encodeURIComponent(chartConfig) + '&width=600&height=350&backgroundColor=white&format=png';
            
            text = '\ud83d\udcca **\u8bf7\u5047\u7edf\u8ba1\u56fe\u8868**\n\n' +
                '\u672c\u5468\u8bf7\u5047\uff1a' + c_wl.count + ' \u4efd (' + c_wl.days + '\u5929)\n' +
                '\u672c\u6708\u8bf7\u5047\uff1a' + c_ml.count + ' \u4efd (' + c_ml.days + '\u5929)\n\n' +
                '\u7c7b\u578b\u5206\u5e03\uff1a' + typeLabels.map(function(t,i){return t + ' ' + typeCounts[i] + '\u4efd'}).join('\u3001') + '\n\n' +
                '![' + encodeURI('\u8bf7\u5047\u7edf\u8ba1\u56fe') + '](' + chartUrl + ')';
            return { success: true, content: text, action: 'chart', data: { chartUrl: chartUrl, labels: typeLabels, counts: typeCounts } };
        } catch (chartErr) {
            console.error('[Stats Agent] \u56fe\u8868\u751f\u6210\u5931\u8d25:', chartErr.message);
        }
    }


// 系统总览（默认）
    const overview = dbHelper.getSystemOverview();
    const balance = dbHelper.getLeaveBalance(userId);
    const week = dbHelper.getWeekRange();
    const weekLeave = dbHelper.countLeavesInRange(adminView ? null : userId, c_week.start, c_week.end, false);

    let text = `📊 系统数据概览\n\n`;
    text += `👥 用户总数：${overview.totalUsers} 人\n`;
    text += `📄 公文总数：${overview.totalDocs} 份\n`;
    text += `📝 请假申请：${overview.totalLeave} 份\n`;
    text += `⏳ 待审批公文：${overview.pendingDocs} 份\n`;
    text += `⏳ 待审批请假：${overview.pendingLeave} 份\n`;
    text += `📅 本周请假：${c_wl.count} 份 (${c_wl.days} 天)\n\n`;
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
用户消息：（请查看对话内容）

可选操作：
- notify_user: 给指定用户发消息 → {"action":"notify_user","targetName":"张三","content":"消息内容"}
- notify_approvers: 给所有审批人发消息 → {"action":"notify_approvers","content":"消息内容"}
- notify_group: 在飞书群里发消息/通知 → {"action":"notify_group","content":"消息内容"}

如果用户说「在群里发」「群通知」「群发」「告诉大家」「通知一下大家」→ notify_group
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

    // ===== 群聊通知 =====
    if (action.action === 'notify_group' && action.content) {
        const text = `📢 群通知\n\n${action.content}\n\n—— ${new Date().toLocaleString('zh-CN')}`;
        try {
            const result = await feishuSender.sendToGroup(text);
            if (result.success) {
                return { success: true, content: `✅ 已发送群通知！`, action: 'notify_group' };
            } else {
                return { success: false, content: `❌ 群发失败：${result.reason || '未知错误'}` };
            }
        } catch (e) {
            return { success: false, content: `❌ 群发失败：${e.message}` };
        }
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
//  Router Agent - 主入口（v4.0 全流程闭环）
// ============================================================
async function routerAgentProcess(message, context = {}) {
    console.log('[Router] 收到消息:', message.slice(0, 80));
    console.log('[Router] 上下文:', JSON.stringify({ userId: context.userId, userName: context.userName, isAdmin: context.isAdmin }));

    const isFeishu = !!(context.feishuChatId || context.feishuOpenId);
    const convId = context.conversationId || ('user_' + (context.userId || 'anon'));

    // 0a. 请假关键词快速匹配
    if (/\u6211\u8981\u8bf7\u5047|\u60f3\u8bf7\u5047|\u7533\u8bf7\u8bf7\u5047|\u8bf7\u5047\u7533\u8bf7/i.test(message) && !/\u67e5\u8be2|\u8bb0\u5f55|\u5ba1\u6279|\u540c\u610f|\u62d2\u7edd|\u7edf\u8ba1|\u901a\u77e5|\u516c\u6587|\u521b\u5efa|\u6279\u51c6/.test(message)) {
        console.log('[Router] \u8bf7\u5047\u8bf7\u6c42 -> leaveAgent');
        var leaveResult = await leaveAgentProcess(message, context);
        if (leaveResult && leaveResult.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', leaveResult.content); }
        if (leaveResult) return leaveResult;
    }

    // 0b. 图表关键词快速匹配（跳过LLM）
    if (/图表|趋势图|柱状图|饼图|折线图|统计图|统计图表|生成.*图|chart/i.test(message)) {
        console.log('[Router] \u56fe\u8868\u8bf7\u6c42 -> statsAgent');
        var chartResult = await statsAgentProcess(message, context);
        if (chartResult && chartResult.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', chartResult.content); }
        if (chartResult) return chartResult;
    }

    // 0c. 群发通知关键词快速匹配（发群消息/群通知）
    if (/群里|群聊|群发|在群|告诉大家|通知大家|发个通知|群通知|发到群|在飞书群/.test(message)) {
        console.log('[Router] 群发请求 -> notifyAgent');
        var notifyResult = await notifyAgentProcess(message, context);
        if (notifyResult && notifyResult.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', notifyResult.content); }
        if (notifyResult) return notifyResult;
    }

        // 1. 统一 LLM 意图识别
    const intentResult = await classifyIntent(message);
    console.log('[Router] 意图:', intentResult.intent, '方法:', intentResult.method);

    // 2. 根据意图路由到对应处理
    switch (intentResult.intent) {
        case 'leave_apply':
        case 'leave_query':
            var lr = await leaveAgentProcess(message, context);
            if (lr && lr.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', lr.content); }
            return lr;

        case 'doc_create':
        case 'doc_approve':
            var dr = await documentAgentProcess(message, context);
            if (dr && dr.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', dr.content); }
            return dr;

        case 'stats':
            var sr = await statsAgentProcess(message, context);
            if (sr && sr.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', sr.content); }
            return sr;

        case 'notify':
            var nr = await notifyAgentProcess(message, context);
            if (nr && nr.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', nr.content); }
            return nr;

        case 'approve_action':
        case 'reject_action':
            // 快速审批：先检查用户有没有审批权限
            if (dbHelper) {
                const user = dbHelper.getUserById(context.userId);
                if (user && ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role)) {
                    var ar = await handleQuickApproval(message, context, intentResult.intent);
                    if (ar && ar.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', ar.content); }
                    return ar;
                }
            }
            var lr2 = await leaveAgentProcess(message, context);
            if (lr2 && lr2.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', lr2.content); }
            return lr2;

        default:
            // ===== 关键词兜底路由（LLM 不可用时靠关键词匹配干活）=====
            const msg = message;

            // 请假申请
            if (/请个?假|身体不舒服|生病了|不舒服|想休息|休个?假|要休息|申请休假|休假申请|请病假|请事假|请年假|调休|想请假/.test(msg) &&
                !/查询|记录|余额|统计|通知/.test(msg)) {
                console.log('[Router] 关键词兜底: 请假 -> leaveAgent');
                var df1 = await leaveAgentProcess(msg, context);
                if (df1 && df1.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df1.content); }
                return df1;
            }

            // 查询假期余额
            if (/余额|还剩|剩余|还有.*天|年假|假期.*剩|可休|有多少天/.test(msg)) {
                console.log('[Router] 关键词兜底: 余额查询 -> statsAgent');
                var df2 = await statsAgentProcess(msg, context);
                if (df2 && df2.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df2.content); }
                return df2;
            }

            // 查询记录
            if (/查询|记录|历史|我的.*请假|请假.*情况/.test(msg) && !/申请|创建/.test(msg)) {
                console.log('[Router] 关键词兜底: 记录查询 -> leaveAgent');
                var df3 = await leaveAgentProcess(msg, context);
                if (df3 && df3.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df3.content); }
                if (df3) return df3;
            }

            // 数据统计
            if (/统计|本周|本月|这个月|多少人|几个.*请假|报表|周报|月报|待审批|待办|待处理/.test(msg)) {
                console.log('[Router] 关键词兜底: 统计 -> statsAgent');
                var df4 = await statsAgentProcess(msg, context);
                if (df4 && df4.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df4.content); }
                return df4;
            }

            // 通知/提醒
            if (/通知|提醒|告诉|发给|推送/.test(msg) && !/公文|文档|通知.*书/.test(msg)) {
                console.log('[Router] 关键词兜底: 通知 -> notifyAgent');
                var df5 = await notifyAgentProcess(msg, context);
                if (df5 && df5.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df5.content); }
                return df5;
            }

            // 公文起草
            if (/公文|起草|写份|写个|拟|草拟|采购|会议纪要|会议通知|发个通知/.test(msg)) {
                console.log('[Router] 关键词兜底: 公文 -> documentAgent');
                var df6 = await documentAgentProcess(msg, context);
                if (df6 && df6.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df6.content); }
                return df6;
            }

            // 审批操作
            if (/同意|批准|不同意|驳回|拒绝|准假|通过|否决/.test(msg) && dbHelper) {
                const user = dbHelper.getUserById(context.userId);
                if (user && ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role)) {
                    console.log('[Router] 关键词兜底: 审批 -> handleQuickApproval');
                    var df7 = await handleQuickApproval(msg, context, /同意|批准|准假|通过/.test(msg) ? 'approve_action' : 'reject_action');
                    if (df7 && df7.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df7.content); }
                    return df7;
                }
                console.log('[Router] 关键词兜底: 审批(无权限) -> leaveAgent');
                var df8 = await leaveAgentProcess(msg, context);
                if (df8 && df8.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df8.content); }
                return df8;
            }

            // 以上都没匹配 → 走通用对话
            if (isFeishu) {
                const roleTag = context.isAdmin ? '管理员' : (context.userRole || '用户');
                const userNameTag = context.userName ? `\n[当前用户：${context.userName}，用户ID：${context.userId}，角色：${roleTag}]` : '';
                const result = await chatWithAgent('feishu', message + userNameTag, convId, context);
                if (result.success) {
                    return { success: true, content: result.content, action: 'chat' };
                }
            } else {
                const roleTag = context.isAdmin ? '管理员' : (context.userRole || '用户');
                const userNameTag = context.userName ? `\n[当前用户：${context.userName}，用户ID：${context.userId}，角色：${roleTag}]` : '';
                const result = await chatWithAgent('general', message + userNameTag, convId, context);
                if (result.success) {
                    return { success: true, content: result.content, action: 'chat' };
                }
            }
            return { success: false, content: 'AI 服务暂时不可用，请稍后重试。' };
    }
}

// 快速审批处理（同意/驳回）— v4.0 支持学工角色
async function handleQuickApproval(message, context, actionType) {
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    const { userId, userName, feishuChatId } = context;

    // 检查审批权限：ADMIN、COUNSELOR、TEACHER 都可以审批
    const user = dbHelper.getUserById(userId);
    if (!user || !['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role)) {
        return { success: true, content: '⚠️ 你没有审批权限。只有辅导员、老师和管理员可以审批。' };
    }

    // 尝试从消息中提取请假编号
    const idMatch = message.match(/#(\d+)/);
    let targetLeaveId = idMatch ? parseInt(idMatch[1]) : null;

    // 找待审批的请假
    let pendingLeave = null;
    if (targetLeaveId) {
        pendingLeave = dbHelper.dbGet(
            `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.id = ? AND l.status = 'PENDING'`,
            [targetLeaveId]
        );
    }
    if (!pendingLeave && feishuChatId) {
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
        const resultStatus = 'APPROVED';

        if (pendingLeave) {
            const comment = message.replace(/同意|批准|ok|okay|好的|可以|准了|通过|没问题|准假|批了|#\d+/gi, '').trim() || '已批准';
            dbHelper.approveLeave(pendingLeave.id, userId, comment);
            resultText += `✅ **请假已批准！**\n\n👤 ${pendingLeave.user_name} · ${pendingLeave.type} ${pendingLeave.days}天\n📅 ${pendingLeave.start_date} ~ ${pendingLeave.end_date}\n💬 ${comment}\n🎉 假期愉快！`;
            hasApproved = true;

            // 通知申请人（优先发结果卡片，降级为文字）
            let notified = false;
            if (feishuSender && pendingLeave.user_id) {
                try {
                    if (feishuSender.buildLeaveResultCard) {
                        const card = feishuSender.buildLeaveResultCard(pendingLeave, resultStatus, userName || '管理员', comment);
                        const result = await feishuSender.sendCardToUser(pendingLeave.user_id, card);
                        notified = result && result.success;
                    }
                    if (!notified) {
                        const msg = `✅ **请假已批准**\n\n📋 ${pendingLeave.type} · ${pendingLeave.days}天\n📅 ${pendingLeave.start_date} ~ ${pendingLeave.end_date}\n👤 审批人：${userName || '管理员'}\n💬 ${comment}\n\n🎉 假期愉快！`;
                        const result = await feishuSender.sendToUser(pendingLeave.user_id, msg);
                        notified = result && result.success;
                    }
                } catch (e) { console.error('[审批通知] 失败:', e.message); }
            }
            if (!notified && dbHelper && pendingLeave.user_id) {
                dbHelper.createNotification(pendingLeave.user_id, 'SYSTEM', '请假已批准',
                    `${pendingLeave.type} ${pendingLeave.days}天 (${pendingLeave.start_date}~${pendingLeave.end_date}) 已批准。审批人：${userName || '管理员'}。${comment}`, 'APPROVED');
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
            resultText = '📋 当前没有待审批的事项。\n\n💡 提示：如果有学生提交了请假申请，你会收到飞书通知。';
        }
        return { success: true, content: resultText, action: 'approve' };
    }

    // 驳回
    if (actionType === 'reject_action') {
        let resultText = '';
        let hasRejected = false;
        const resultStatus = 'REJECTED';
        const comment = message.replace(/不同意|驳回|拒绝|不准|不行|否决|不批|#\d+/g, '').trim() || '不予批准';

        if (pendingLeave) {
            dbHelper.rejectLeave(pendingLeave.id, userId, comment);
            resultText += `❌ **请假已驳回**\n\n👤 ${pendingLeave.user_name} · ${pendingLeave.type} ${pendingLeave.days}天\n💬 ${comment}`;
            hasRejected = true;

            let notified = false;
            if (feishuSender && pendingLeave.user_id) {
                try {
                    if (feishuSender.buildLeaveResultCard) {
                        const card = feishuSender.buildLeaveResultCard(pendingLeave, resultStatus, userName || '管理员', comment);
                        const result = await feishuSender.sendCardToUser(pendingLeave.user_id, card);
                        notified = result && result.success;
                    }
                    if (!notified) {
                        const msg = `❌ **请假未通过**\n\n📋 ${pendingLeave.type} · ${pendingLeave.days}天\n📅 ${pendingLeave.start_date} ~ ${pendingLeave.end_date}\n👤 审批人：${userName || '管理员'}\n💬 ${comment}\n\n如有疑问请联系审批人。`;
                        const result = await feishuSender.sendToUser(pendingLeave.user_id, msg);
                        notified = result && result.success;
                    }
                } catch (e) { console.error('[驳回通知] 失败:', e.message); }
            }
            if (!notified && dbHelper && pendingLeave.user_id) {
                dbHelper.createNotification(pendingLeave.user_id, 'SYSTEM', '请假已驳回',
                    `${pendingLeave.type} ${pendingLeave.days}天 (${pendingLeave.start_date}~${pendingLeave.end_date}) 未通过。审批人：${userName || '管理员'}。${comment}`, 'REJECTED');
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


// ============================================================
//  Multi-Agent Team System (v5.0)
//  Coordinator + Chat + Leave + Notify + Doc + Stats
// ============================================================
var taskCounter = 0;
var activeTasks = new Map();

function genTaskId() {
  taskCounter++;
  var d = new Date();
  return "task_" + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + "_" + pad4(taskCounter);
}
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function pad4(n) { return n < 10 ? "000" + n : n < 100 ? "00" + n : n < 1000 ? "0" + n : "" + n; }

function makeTask(type, msg, ctx) {
  return {
    id: genTaskId(), type: type, status: "pending",
    createdBy: { userId: ctx.userId, userName: ctx.userName, userRole: ctx.userRole },
    userMessage: msg,
    data: { raw: {}, structured: {}, notifications: [], documents: [] },
    timeline: [{ time: new Date().toISOString(), agent: "coordinator", action: "created", type: type }],
    approval: { required: [], approved: [], rejected: null, expiresAt: null },
    createdAt: new Date().toISOString(),
    context: ctx
  };
}

function saveT(task, svc) {
  if (!svc || !svc.run) return;
  try {
    var e = svc.query("SELECT id FROM agent_tasks WHERE id=?", [task.id]);
    if (e.length > 0) {
      svc.run("UPDATE agent_tasks SET status=?, data=?, timeline=?, result=?, updated_at=datetime('now') WHERE id=?",
        [task.status, JSON.stringify(task.data), JSON.stringify(task.timeline), task.result || "", task.id]);
    } else {
      svc.run("INSERT INTO agent_tasks (id,type,status,data,timeline,created_by,user_message) VALUES (?,?,?,?,?,?,?)",
        [task.id, task.type, task.status, JSON.stringify(task.data), JSON.stringify(task.timeline), JSON.stringify(task.createdBy), task.userMessage || ""]);
    }
  } catch(e) { console.error("[Task] save error:", e.message); }
}

function logAgent(aid, tid, act, inp, out, model, tok, lat, ok, err, svc) {
  if (!svc || !svc.run) return;
  try {
    svc.run("INSERT INTO agent_logs (agent_id,task_id,action,input,output,model,tokens,latency_ms,success,error) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [aid, tid||"", act, JSON.stringify(inp||{}), JSON.stringify(out||{}), model||"", tok||0, lat||0, ok!==false?1:0, err||null]);
  } catch(e) { console.error("[Log] error:", e.message); }
}

// ===== Chat Agent =====
var CHAT = {
  id: "chat", name: "对话服务台",
  async exec(msg, task, svc) {
    var start = Date.now();
    try {
      task.status = "processing";
      task.timeline.push({ time: new Date().toISOString(), agent: "chat", action: "processing" });
      saveT(task, svc);

      var sys = "你是学工系统的对话服务台。输出JSON：{\"action\":\"complete\"/\"ask_more\",\"fields\":{\"type\":\"\",\"reason\":\"\",\"startDate\":\"\",\"endDate\":\"\",\"days\":\"\",\"course\":\"\"},\"reply\":\"\"}\n" +
        "必填：type(年假/事假/病假), reason, startDate, endDate, days。信息不足用ask_more，充足用complete。";

      var r = await callAI(MODELS.fast, [{role:"system",content:sys},{role:"user",content:msg}], {temperature:0.2,max_tokens:500});
      var lat = Date.now() - start;

      if (!r || !r.success || !r.content) {
        logAgent("chat", task.id, "ai_err", {msg}, {err:r?.error}, MODELS.fast, 0, lat, false, r?.error, svc);
        return {content:"对不起，没听清，能再说一次吗？", action:"retry"};
      }

      try {
        var p = JSON.parse(r.content.replace(/```[\s\S]*?```/g,"").trim());
        var act = p.action || "ask_more";
        var f = p.fields || {};
        for (var k in f) { if (f[k] && String(f[k]).trim()) task.data.raw[k] = String(f[k]).trim(); }
        logAgent("chat", task.id, act, {msg,f}, {reply:p.reply,fields:task.data.raw}, MODELS.fast, r.tokens||0, lat, true, null, svc);
        task.timeline.push({ time: new Date().toISOString(), agent: "chat", action: act });
        saveT(task, svc);

        if (act === "complete") {
          if (!task.data.raw.endDate && task.data.raw.startDate && task.data.raw.days) {
            var dd = new Date(task.data.raw.startDate);
            dd.setDate(dd.getDate() + parseInt(task.data.raw.days) - 1);
            task.data.raw.endDate = dd.toISOString().slice(0,10);
          }
          return {content: p.reply, action: "complete", fields: task.data.raw};
        }
        return {content: p.reply, action: "ask_more", fields: task.data.raw};
      } catch(e) {
        logAgent("chat", task.id, "parse_err", {msg,raw:r.content}, {err:e.message}, MODELS.fast, r.tokens||0, lat, false, e.message, svc);
        return {content: r.content, action: "reply"};
      }
    } catch(err) { return {content:"处理失败", action:"error"}; }
  }
};

// ===== Leave Agent =====
var LEAVE = {
  id: "leave", name: "请假专员",
  async exec(msg, task, svc) {
    var start = Date.now();
    try {
      var f = task.data.raw || {};
      var ctx = task.context || {};
      var db = svc.dbHelper;
      if (!db) return {error:"数据库未连接"};

      var t = f.type||"事假", d = parseInt(f.days)||1, s = f.startDate||new Date().toISOString().slice(0,10), e = f.endDate||s, r = f.reason||"", c = f.course||"";
      var uid = ctx.userId;

      var dup = svc.query("SELECT id FROM leave_requests WHERE user_id=? AND start_date=? AND status IN ('PENDING','APPROVED')", [uid, s]);
      if (dup.length > 0) return {error:"该日期已有请假记录", duplicate:true};

      var rr = db.createLeaveRequest(uid, t, s, e, d, r, ctx.feishuChatId||"", ctx.feishuMsgId||"", c);
      task.data.structured = {leaveId:rr.lastID, type:t, days:d, startDate:s, endDate:e, reason:r, course:c};
      task.status = "waiting_approval";
      task.timeline.push({ time: new Date().toISOString(), agent: "leave", action: "submitted", leaveId: rr.lastID });
      saveT(task, svc);
      logAgent("leave", task.id, "submitted", {uid,t,d,s,e}, {leaveId:rr.lastID}, null, 0, Date.now()-start, true, null, svc);
      return {leaveId: rr.lastID};
    } catch(err) { return {error:err.message}; }
  }
};

// ===== Notify Agent =====
var NOTIFY = {
  id: "notify", name: "通知专员",
  async exec(msg, task, svc) {
    var start = Date.now();
    var s = task.data.structured || {};
    var ctx = task.context || {};
    if (!s.leaveId) return {};
    var txt = "📝 **新请假申请**\n\n👤 " + (ctx.userName||"") + "\n📋 " + (s.type||"") + " · " + (s.days||"") + "天\n📅 " + (s.startDate||"") + " ~ " + (s.endDate||"") + "\n💬 " + (s.reason||"") + "\n🆔 #" + s.leaveId + "\n\n👉 回复\"同意 #" + s.leaveId + "\"审批";
    var admins = svc.query("SELECT id FROM users WHERE role IN ('COUNSELOR','ADMIN')");
    for (var i = 0; i < admins.length; i++) {
      if (svc.sendFeishuToUser) await svc.sendFeishuToUser(admins[i].id, txt);
    }
    logAgent("notify", task.id, "notified", {admins:admins.length}, {}, null, 0, Date.now()-start, true, null, svc);
    task.timeline.push({ time: new Date().toISOString(), agent: "notify", action: "notified" });
    saveT(task, svc);
    return {};
  }
};

// ===== Doc Agent =====
var DOC = {
  id: "doc", name: "公文专员",
  async exec(msg, task, svc) {
    var s = task.data.structured || {};
    var ctx = task.context || {};
    if (!s.leaveId) return {};
    var title = (ctx.userName||"用户") + "的" + (s.type||"请假") + "记录";
    var content = "# " + title + "\n\n申请人：" + ctx.userName + "\n类别：" + (s.type||"") + "\n时间：" + (s.startDate||"") + " ~ " + (s.endDate||"") + "\n天数：" + (s.days||"") + "天\n原因：" + (s.reason||"") + "\n课程：" + (s.course||"无");
    var r = svc.run("INSERT INTO documents (title,content,type,status,applicant_id,created_at) VALUES (?,?,'LEAVE','APPROVED',?,datetime('now'))", [title, content, ctx.userId||1]);
    task.data.documents.push({docId:r.lastID, title:title});
    task.timeline.push({ time: new Date().toISOString(), agent: "doc", action: "created", docId: r.lastID });
    saveT(task, svc);
    return {docId: r.lastID};
  }
};

// ===== Stats Agent =====
var STATS = {
  id: "stats", name: "统计专员",
  async exec(msg, task, svc) {
    var db = svc.dbHelper;
    if (!db) return {};
    return {overview: db.getSystemOverview()};
  }
};

// ===== Workflows =====
var WORKFLOWS = {
  leave_request: ["chat", "leave", "notify", "doc", "stats"],
  leave_query: ["chat", "leave"],
  general: ["chat"]
};

// ===== Coordinator =====
function buildFinalReply(task, svc) {
  var s = task.data.structured || {};
  var ctx = task.context || {};
  if (task.status === "waiting_approval" && s.leaveId) {
    return "✅ **请假申请已提交！**\n\n👤 " + (ctx.userName||"") + "\n📋 " + (s.type||"") + " · " + (s.days||"") + "天\n📅 " + (s.startDate||"") + " ~ " + (s.endDate||"") + "\n💬 " + (s.reason||"") + "\n🆔 #" + s.leaveId + "\n\n⏳ 等待审批...";
  }
  return "处理完成！任务编号：" + task.id;
}

async function processTask(msg, ctx, svc) {
  var start = Date.now();
  try {
    var intent = "leave_request";
    if (/查询|记录|剩余/i.test(msg) && !/申请/i.test(msg)) intent = "leave_query";
    else if (!/请假|假|病|休/i.test(msg)) intent = "general";

    var task = makeTask(intent, msg, ctx);
    activeTasks.set(task.id, task);
    saveT(task, svc);
    console.log("[Coordinator] intent=" + intent + " task=" + task.id);
    logAgent("coordinator", task.id, "classified", {msg}, {intent}, null, 0, Date.now()-start, true, null, svc);

    var wf = WORKFLOWS[intent] || WORKFLOWS.general;
    var agents = {chat:CHAT, leave:LEAVE, notify:NOTIFY, doc:DOC, stats:STATS};
    var asked = false;

    for (var i = 0; i < wf.length; i++) {
      var agent = agents[wf[i]];
      if (!agent) continue;
      console.log("[Coordinator] -> " + agent.name);
      var result = await agent.exec(msg, task, svc);
      if (result && result.action === "ask_more" && !asked) {
        task.status = "waiting_input";
        saveT(task, svc);
        return { success: true, taskId: task.id, content: result.content, action: "ask_more", fields: task.data.raw };
      }
    }

    var finalMsg = buildFinalReply(task, svc);
    task.status = task.status === "waiting_approval" ? "waiting_approval" : "completed";
    task.result = finalMsg;
    task.timeline.push({ time: new Date().toISOString(), agent: "coordinator", action: "done" });
    saveT(task, svc);
    logAgent("coordinator", task.id, "completed", {intent,wf:wf.join("->")}, {taskId:task.id}, null, 0, Date.now()-start, true, null, svc);
    return { success: true, taskId: task.id, content: finalMsg, action: task.status === "waiting_approval" ? "waiting_approval" : "completed", data: task.data };
  } catch(err) {
    console.error("[Coordinator] error:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
    processTask,
    
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

