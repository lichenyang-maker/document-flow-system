// ============================================================
//  ai-agents.js - 销售订货多智能体系统（v6.0）
//  Router Agent + Order Agent + Notify Agent + Stats Agent
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

// ---------- 数据库直接查询引用（用于销售订单等无 dbHelper 方法的表）----------
let queryDb = null;
let runDb = null;
function injectDBQuery(queryFn, runFn) { queryDb = queryFn; runDb = runFn; }

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
        'order_create: 用户想创建/下达销售订单（如"下订单""创建订单""新建销售订单""下一个订单"）',
        'order_query: 用户查询订单状态、订单详情、订单列表',
        'order_change: 用户想变更订单（如"改订单""变更交期""修改订单""急插单"调度）',
        'delivery_create: 用户想创建发货单/处理发货（如"发货""出库""创建发货单"）',
        'forecast: 用户想创建预测计划/查看预测（如"预测订单""预测计划""月度预测"）',
        'contact_form: 用户想创建联络单（如"联络单""发起联络""联络函"）',
        'delivery_stats: 用户想查看交付率统计/准时交货率（如"交付率""准时交货率""月度统计"）',
        'production_cycle: 用户想查看/更新生产周期表（如"生产周期""周期表"）',
        'stats: 用户想查看统计数据、报表、系统概况、待审批事项',
        'notify: 用户想发/订单|销售|通知|请示//提醒给某人或群体',
        'approve_action: 用户表示同意/批准某事项',
        'reject_action: 用户表示不同意/驳回某事项',
        'general: 日常聊天、闲聊、问候、问答、知识咨询、表达情绪等（默认）'
    ].join('\n');

    const prompt = `你是智能意图识别员。分析用户输入，判断真实意图。

## 规则
- 日常聊天、闲聊、问候、问问题、求推荐、表达情绪 → general
- ** 想创建/下达销售订单 → order_create（如"下订单""创建订单"）**
- ** 想查询订单状态/详情/列表 → order_query**
- ** 想变更订单/急插单 → order_change**
- ** 想处理发货/出库 → delivery_create**
- ** 想创建预测计划 → forecast**
- ** 想创建联络单 → contact_form**
- ** 想查看交付率统计 → delivery_stats**
- ** 想查看生产周期表 → production_cycle**
- 想看数据、统计、报表 → stats
- 想发/订单|销售|通知|请示//提醒 → notify
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

    if (!result.success) {
        // LLM 调用失败 → 关键词兜底
        return fallbackClassify(message);
    }

    const content = (result.content || '').trim().toLowerCase();
    const valid = ['order_create', 'order_query', 'order_change', 'delivery_create', 'forecast', 'contact_form', 'delivery_stats', 'production_cycle', 'notify', 'stats', 'approve_action', 'reject_action', 'general'];
    for (const v of valid) {
        if (content.includes(v)) return { intent: v, method: 'llm' };
    }
    // LLM 返回了未知意图 → 关键词兜底
    return fallbackClassify(message);

    // 关键词兜底分类（v6.0 - 销售订货系统）
    function fallbackClassify(msg) {
        if (/下订单|创建订单|新建.*订单|销售订单|下单|生成.*订单|下达.*订单/.test(msg) && !/变更|修改|改|查询|我的|发货|出库|预测/.test(msg)) return { intent: 'order_create', method: 'keyword' };
        if (/查询.*订单|订单.*查询|我的订单|订单.*状态|订单列表|有哪些订单|库存|有没有货/.test(msg)) return { intent: 'order_query', method: 'keyword' };
        if (/变更.*订单|订单.*变更|改.*订单|修改.*订单|急插单|顺延.*交期|变更单/.test(msg)) return { intent: 'order_change', method: 'keyword' };
        if (/发货|出库|发货单|创建.*发货|物流|配送/.test(msg) && !/统计/.test(msg)) return { intent: 'delivery_create', method: 'keyword' };
        if (/预测|预测订单|月度.*预测|需求.*预测/.test(msg)) return { intent: 'forecast', method: 'keyword' };
        if (/联络单|联络函|发起.*联络/.test(msg)) return { intent: 'contact_form', method: 'keyword' };
        if (/交付率|准时.*交货|延迟.*交|准时率/.test(msg)) return { intent: 'delivery_stats', method: 'keyword' };
        if (/生产周期|周期表|更新.*周期/.test(msg)) return { intent: 'production_cycle', method: 'keyword' };
        if (/统计|本周|本月|多少|几个|数据|报表|待审批|待办/.test(msg) && !/订单|交货|交付|预测/.test(msg)) return { intent: 'stats', method: 'keyword' };
        if (/群里|群聊|群发|订单|销售|通知|请示|提醒|告诉|发给|推送/.test(msg)) return { intent: 'notify', method: 'keyword' };
        if (/同意|批准|准了|通过|ok|可以|好的/.test(msg)) return { intent: 'approve_action', method: 'keyword' };
        if (/不同意|驳回|拒绝|不准|不行|否决|不批/.test(msg)) return { intent: 'reject_action', method: 'keyword' };
        return { intent: 'general', method: 'keyword_default' };
    }
}

// 意图 → Agent 映射（v6.0 - 销售订货系统）
const INTENT_TO_AGENT = {
    order_create: 'order',
    order_query: 'order',
    order_change: 'order',
    delivery_create: 'order',
    forecast: 'order',
    contact_form: 'order',
    delivery_stats: 'order',
    production_cycle: 'order',
    approve_action: 'order',
    reject_action: 'order',
    stats: 'data',
    chart: 'data',
    notify: 'notify',
    general: 'general'
};

// ============================================================
//  Agent 定义 - 销售订货系统
// ============================================================
const AGENTS = {
    feishu: {
        id: 'feishu', name: '销售订货助手小流',
        description: '飞书聊天专用 - 销售订货全流程助手',
        model: MODELS.feishu,
        systemPrompt: `你是飞书群里的销售订货助手"小流"。你的任务是引导用户使用系统功能，而不是假装自己亲自执行操作。

## 重要：你能做什么，不能做什么

**你能做的（真的可以执行）**：
- 聊天、回答知识性问题、闲聊
- 帮用户理清需求，然后系统会自动路由到对应功能处理

**你不能做的（不要假装可以）**：
- ❌ 不要在回复中说"已帮你创建订单""已提交审批"——你只是聊天助手，这些操作由其他专门模块负责
- ❌ 不要编造数据库查询结果——你没有权限查数据库
- ❌ 不要假装执行审批操作

## 你的风格
- 😊 像真人一样自然聊天
- 💬 回复简洁有力，群聊控制在 3-6 句话
- 🎯 用户有明确需求时，清晰引导："好的，我来处理~请稍等"
- 🤝 保持友好、专业、有温度
- 👋 开口先招呼：「Hi 【姓名】～」
- 🎉 偶尔开玩笑、卖萌、调皮一下也可以
- 用 emoji 点缀但不过度

## 常见场景的正确回复方式
1. **创建订单**：用户说下订单 → 回复："好的，我来帮你创建订单~"（系统会自动执行）
2. **查订单**：用户查记录 → 回复："我查一下你的订单，请稍等~"（系统会自动查库）
3. **数据统计**：用户问统计 → 回复："好的，帮你看看数据~"（系统会自动统计）
4. **订单评审**：用户说评审订单 → 回复："好的，我来处理订单评审~"（系统会自动处理）
5. **审批操作**：用户说同意/驳回 → 回复："收到，我来处理审批~"（系统会自动审批）
6. **发货安排**：用户说安排发货 → 回复："好的，我来安排发货~"（系统会自动处理）
7. **/订单|销售|通知|请示/提醒**：用户在群里发/订单|销售|通知|请示/ → 回复："好的，我来发群/订单|销售|通知|请示/~"（系统会自动发送）
8. **闲聊**：日常聊天 → 正常聊天

## 绝对禁止
- ❌ 不要说"已帮你创建/提交/发送"——你只是中转，真正干活的是系统
- ❌ 不要编造数据——你没权限查数据库
- ❌ 不要长篇大论

你不是在执行者，你是引导员。用户有需求就说"好的，我来处理"，让系统实际执行。

现在，用户说：（请查看对话内容）`,
        temperature: 0.85, maxTokens: 4096
    },
    general: {
        description: '销售订货助手 - 订单管理/查询/审批/统计',
        model: MODELS.general,
        systemPrompt: `你是「销售订货管理系统」的智能助手，名叫【小流】，由 DeepSeek-V3 驱动。

## 身份定位
- 你是专业的销售订货管理助手，负责订单全流程管理
- 你服务的场景是：制造/贸易企业的销售订单管理、评审审批、发货跟踪
- 你懂业务流程：订单创建→工程BOM评审→计划交期评审→业务确认→发货

## 说话风格
- 亲切专业，像个贴心的业务助理
- 开口先确认身份：「Hi 【姓名】～」
- 直接给出结论，再补充细节，不打官腔
- 用 emoji 增加可读性，但不过度
- 遇到订单/查询/统计请求，直接干活（提取信息→写入系统→回复结果）

## 业务处理
**创建订单**：用户说「下订单」「给XX公司下XX产品」→ 提取客户名、产品、数量等信息
**查订单**：用户说「我的订单」「查订单 #3」→ 查询数据库返回订单信息
**评审**：用户是工程师/计划/业务角色 → 按订单状态引导评审
**发货**：用户说「发货 #3」→ 安排发货
**统计**：用户查订单统计 → 直接查数据库，用清晰格式返回
**闲聊**：打招呼/问天气/吐槽 → 自然回应，但引导回业务场景

## 禁止
- 不要说「作为一个 AI，我没有情感」这类话
- 不要通用搜索引擎式回答
- 不要长篇大论，简洁有力，直奔主题

请用你的专业能力，帮用户高效完成工作！`,
        temperature: 0.7, maxTokens: 3072
    },

    // 订单助手
    order: {
        id: 'order', name: '订单助手',
        description: '销售订单创建、查询、变更、发货处理',
        model: MODELS.fast,
        systemPrompt: `你是销售订单管理助手。直接帮用户处理订单事务。

## 你的任务
从用户消息中提取订单信息并直接输出完整指令：

### 创建订单
提取：客户名、产品名/类型、数量、单位、单价、金额、交期、特殊要求
输出：{"action":"create","customer_name":"华为","product_type":"A产品","quantity":100,"unit":"PCS","price":50,"amount":5000,"delivery_date":"2026-06-30"}

### 查询订单
输出：{"action":"query"}
或按条件：{"action":"query","status":"pending_engineering","order_no":"SO2025A1"}

### 评审订单
根据订单当前状态自动评审：
- pending_engineering → 工程评审：{"action":"review_engineering","idMatch":"#3","bom_status":"completed","comment":"BOM已完成"}
- pending_planning → 计划评审：{"action":"review_planning","idMatch":"#3","delivery_date":"2026-06-30","comment":"交期已定"}
- pending_confirmation → 业务确认：{"action":"review_business","idMatch":"#3","comment":"确认通过"}

### 变更订单
输出：{"action":"change","idMatch":"#3","change_notes":"客户要求提前交货"}

### 安排发货
输出：{"action":"ship","idMatch":"#3"}

### 统计
输出：{"action":"stats"}

## 输出格式
请只输出 JSON，不要额外内容。`,
        temperature: 0.3, maxTokens: 1024
    },

    data: {
        id: 'data', name: '数据统计',
        description: '订单统计、交付率、系统总览',
        model: MODELS.fast,
        systemPrompt: `你是数据统计助手。帮用户查询系统真实数据。

## 可查询数据
- 订单统计（总数、各状态数量）
- 待审批订单
- 交付率统计
- 用户信息

## 回复规则
1. 基于系统返回的真实数据回答
2. 用简单清晰格式展示
3. 用 emoji 点缀
4. 主动提醒关键信息

不要编造数据。`,
        temperature: 0.4, maxTokens: 2048
    },

    notify: {
        id: 'notify', name: '/订单|销售|通知|请示/智能体',
        description: '飞书消息发送、用户/订单|销售|通知|请示/、审批提醒',
        model: MODELS.fast,
        systemPrompt: `你是/订单|销售|通知|请示/消息助手，负责通过飞书发送工作/订单|销售|通知|请示/。

## 核心能力
1. 单用户/订单|销售|通知|请示/：给指定用户发消息
2. 审批人/订单|销售|通知|请示/：给所有审批人发提醒
3. 消息格式化：整理成清晰易读格式

## /订单|销售|通知|请示/格式
- 使用 emoji 让消息醒目
- 结构化展示（谁、什么事、时间）
- 需要回复的说明操作方式

## 输出 JSON
{"action":"notify_user","targetName":"张三","content":"消息内容"}
{"action":"notify_approvers","content":"消息内容"}

只输出 JSON，不要额外内容。`,
        temperature: 0.5, maxTokens: 1024
    },

    // 飞书全能助手
    feishu_chat: {
        id: 'feishu_chat', name: '飞书订货助手',
        description: '飞书场景全能助手 - 销售订货全流程',
        model: MODELS.feishu,
        systemPrompt: `你是飞书群里的销售订货全能助手"小流"。你能帮用户下订单、审批评审、查数据、发/订单|销售|通知|请示/，全都能直接搞定。

## 你的风格
- 😊 像真人一样自然聊天，不要一上来就列功能表
- 💬 回复简洁有力，群聊控制在 3-6 句话
- 🎯 精准理解对方意图，能直接干活的就直接干
- 🤝 保持友好、专业、有温度

## 核心能力（直接干活，不推脱）
1. **创建订单**：用户说"给华为下100个A产品"→ 创建销售订单
2. **审批订单**：用户说"同意 #3"→ 推进订单到下一评审阶段
3. **查询订单**：用户说"我的订单"→ 展示订单列表
4. **数据统计**：用户问"订单统计"→ 给出统计数据
5. **安排发货**：用户说"安排发货 #3"→ 安排发货

## 业务流程理解
- 订单流程：创建(DRAFT)→工程BOM评审(PENDING_ENG)→计划交期评审(PENDING_PLAN)→业务确认(PENDING_BIZ)→批准(APPROVED)→发货(DELIVERED)
- 非标产品额外：采购审核(PENDING_PURCHASE)→品质审核(PENDING_QUALITY)
- 每个阶段都有对应角色审批

## 聊天原则
1. **先干活再聊天**：用户有明确需求就先满足需求
2. **简短优先**：群聊回复控制在 3-6 句话
3. **有温度**：对客户温暖，对同事专业简洁
4. **自然过渡**：闲聊就闲聊，不要强行引导到功能

你是能直接干活的助手，不是只会说"我建议"的客服。用户下订单就帮创建，评审就帮处理，直接高效！`,
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
//  销售订货 Agent（v6.0 - 基于试题5.1~5.10全部10个业务模块）
//  飞书机器人核心对话处理
// ============================================================

// 订单创建多轮对话状态
var orderFormStates = orderFormStates || new Map();
var ORDER_FIELD_LABELS = [String.fromCharCode(23458,25143,21517,31216), String.fromCharCode(20135,21697,21517,31216), String.fromCharCode(25968,37327), String.fromCharCode(35201,27714,20132,26399), String.fromCharCode(26159,21542,26032,21697), String.fromCharCode(29305,27530,35201,27714), String.fromCharCode(38468,39029,35828,26126)];
var ORDER_FIELD_KEYS = ["customerName","productName","quantity","deliveryDate","isNewProduct","specialRequirements","attachmentNote"];
var ORDER_FIELD_QUESTIONS = [
    String.fromCharCode(23458,25143,21517,31216,26159,20160,20040,65311),
    String.fromCharCode(20135,21697,21517,31216,47,22411,21495,26159,20160,20040,65311),
    String.fromCharCode(35746,21333,25968,37327,26159,22810,23569,65311,65288,21333,20301,65306,80,67,83,65289),
    String.fromCharCode(35201,27714,20132,26399,26159,21738,22825,65311,65288,26684,24335,65306,89,89,89,89,45,77,77,45,68,68,65289),
    String.fromCharCode(36825,26159,26032,20135,21697,21527,65311,65288,26159,47,21542,65289,10,9888,65039,32,26032,20135,21697,24517,39035,24050,21484,24320,26679,21697,37492,23450,20250,19988,35797,20135,24050,36890,36807),
    String.fromCharCode(26377,20160,20040,29305,27530,35201,27714,21527,65311,65288,22914,21253,35013,26448,26009,12289,36136,37327,31561,32423,31561,65292,27809,26377,35831,22238,22797,8220,26080,8221,65289),
    String.fromCharCode(26377,38468,39029,20869,23481,38656,35201,34917,20805,21527,65311,65288,27809,26377,35831,22238,22797,8220,26080,8221,65289)
];

// 订单表单收集
async function startOrderForm(convId, message, context) {
    var fields = ORDER_FIELD_KEYS;
    var fieldIndex = 0;
    var formData = {};

    var extractPrompt = "\u4ece\u7528\u6237\u6d88\u606f\u4e2d\u63d0\u53d6\u9500\u552e\u8ba2\u5355\u4fe1\u606f\uff0c\u8f93\u51fa JSON\uff08\u53ea\u8f93\u51fa JSON\uff0c\u4e0d\u8981\u5176\u4ed6\u5185\u5bb9\uff09\uff1a\n\u5b57\u6bb5\uff1acustomerName(string) productName(string) quantity(number) deliveryDate(string YYYY-MM-DD) isNewProduct(boolean) specialRequirements(string|null) attachmentNote(string|null)\n\u672a\u63d0\u53ca\u7684\u5b57\u6bb5\u8bbe\u4e3a null\u3002\n\n\u7528\u6237\u6d88\u606f\uff1a" + message;

    var extractResult = await callAI(MODELS.fast, [
        { role: 'system', content: '\u4f60\u662f\u9500\u552e\u8ba2\u5355\u4fe1\u606f\u63d0\u53d6\u5668\u3002\u53ea\u8f93\u51fa JSON\u3002' },
        { role: 'user', content: extractPrompt }
    ], { temperature: 0.1, max_tokens: 500 });

    if (extractResult.success) {
        try {
            var jsonStr = (extractResult.content || '').match(/\{[\s\S]*\}/);
            if (jsonStr) formData = JSON.parse(jsonStr[0]);
            for (var i = 0; i < fields.length; i++) {
                if (formData[fields[i]] == null || formData[fields[i]] === '') {
                    fieldIndex = i;
                    break;
                }
                fieldIndex = i + 1;
            }
        } catch (e) { fieldIndex = 0; }
    }

    if (fieldIndex >= fields.length) {
        orderFormStates.set(convId, { state: 'CONFIRMING', data: formData });
        return await showOrderConfirm(formData, context);
    }

    orderFormStates.set(convId, { state: 'COLLECTING', data: formData, fieldIndex: fieldIndex });
    var infoLabel = ['Customer','Product','Qty','Delivery','New?','Req','Attach'];

    var prompt = '\u{1F4DD} \u{597D}\u{7684}\u{FF0C}\u{6211}\u{4EEC}\u{6765}\u{521B}\u{5EFA}\u{9500}\u{552E}\u{8BA2}\u{5355}\u{FF01}\n\n';
    if (fieldIndex > 0) {
        prompt += '\u{5DF2}\u{586B}\u{5199}\u{FF1A}\n';
        for (var f = 0; f < fieldIndex; f++) {
            prompt += '  \u2705 ' + ORDER_FIELD_LABELS[f] + ' \u2192 ' + (formData[fields[f]] != null ? formData[fields[f]] : '') + '\n';
        }
        prompt += '\n';
    }
    prompt += '\u2753 ' + ORDER_FIELD_QUESTIONS[fieldIndex] + '\n\n\u{1F4A1} \u56DE\u590D\u300C\u53D6\u6D88\u300D\u9000\u51FA\u521B\u5EFA\u6D41\u7A0B\u3002';
    return { success: true, content: prompt, action: 'order_form_start' };
}

async function handleOrderCollect(st, convId, message, context) {
    if (/\u53D6\u6D88|\u9000\u51FA|\u7B97\u4E86/i.test(message)) {
        orderFormStates.delete(convId);
        return { success: true, content: '\u{1F6AB} \u5DF2\u53D6\u6D88\u3002\u968F\u65F6\u53EF\u4EE5\u91CD\u65B0\u5F00\u59CB\u521B\u5EFA\u8BA2\u5355\uFF01' };
    }

    var fields = ORDER_FIELD_KEYS;
    var fieldIndex = st.fieldIndex;
    var formData = st.data || {};
    var currentField = fields[fieldIndex];
    var value = message.trim();

    if (fieldIndex === 2) { var nm = value.match(/(\d+)/); value = nm ? parseInt(nm[1]) : value; }
    if (fieldIndex === 4) { value = /\u662F|yes|对|新|需要/i.test(value); }
    if (fieldIndex === 5 || fieldIndex === 6) { if (/\u65E0|\u6CA1\u6709|\u5426|\u4E0D\u9700\u8981/i.test(value)) value = ''; }

    formData[currentField] = value;
    fieldIndex++;

    while (fieldIndex < fields.length && formData[fields[fieldIndex]] != null && formData[fields[fieldIndex]] !== '' && formData[fields[fieldIndex]] !== undefined) {
        fieldIndex++;
    }

    if (fieldIndex >= fields.length) {
        orderFormStates.set(convId, { state: 'CONFIRMING', data: formData });
        return await showOrderConfirm(formData, context);
    }

    orderFormStates.set(convId, { state: 'COLLECTING', data: formData, fieldIndex: fieldIndex });
    var prompt = '\u{1F4DD} \u9500\u552E\u8BA2\u5355\u4FE1\u606F\u6536\u96C6\u4E2D...\n\n';
    prompt += '\u5DF2\u586B\u5199\uFF1A\n';
    for (var f = 0; f < fieldIndex; f++) {
        prompt += '  \u2705 ' + ORDER_FIELD_LABELS[f] + ' \u2192 ' + (formData[fields[f]] != null ? formData[fields[f]] : '') + '\n';
    }
    prompt += '\n\u2753 ' + ORDER_FIELD_QUESTIONS[fieldIndex];
    return { success: true, content: prompt };
}

async function showOrderConfirm(formData, context) {
    var prompt = '\u{1F4CB} **\u9500\u552E\u8BA2\u5355\u786E\u8BA4**\n\n';
    prompt += '```\n';
    prompt += '\u5BA2\u6237\u540D\u79F0\uFF1A' + (formData.customerName || '') + '\n';
    prompt += '\u4EA7\u54C1\u540D\u79F0\uFF1A' + (formData.productName || '') + '\n';
    prompt += '\u8BA2\u5355\u6570\u91CF\uFF1A' + (formData.quantity || '') + ' PCS\n';
    prompt += '\u8981\u6C42\u4EA4\u671F\uFF1A' + (formData.deliveryDate || '') + '\n';
    prompt += '\u662F\u5426\u65B0\u54C1\uFF1A' + (formData.isNewProduct ? '\u662F \u26A0\uFE0F\u9700\u9A8C\u8BC1' : '\u5426') + '\n';
    prompt += '\u7279\u6B8A\u8981\u6C42\uFF1A' + (formData.specialRequirements || '\u65E0') + '\n';
    prompt += '\u9644\u9875\u8BF4\u660E\uFF1A' + (formData.attachmentNote || '\u65E0') + '\n';
    prompt += '```\n\n';
    prompt += '\u2705 \u56DE\u590D\u300C\u786E\u8BA4\u300D\u63D0\u4EA4\u8BA2\u5355\n';
    prompt += '\u274C \u56DE\u590D\u300C\u4FEE\u6539\u300D\u91CD\u65B0\u586B\u5199\n';
    prompt += '\u{1F6AB} \u56DE\u590D\u300C\u53D6\u6D88\u300D\u9000\u51FA';
    return { success: true, content: prompt, action: 'order_confirm' };
}

async function handleOrderConfirm(st, convId, message, context) {
    var data = st.data;
    if (/\u53D6\u6D88|\u9000\u51FA|\u7B97\u4E86/i.test(message)) { orderFormStates.delete(convId); return { success: true, content: '\u{1F6AB} \u5DF2\u53D6\u6D88\u3002' }; }
    if (/\u4FEE\u6539|\u6539|\u4E0D\u5BF9|\u91CD\u6765/i.test(message)) { orderFormStates.delete(convId); return await startOrderForm(convId, '\u91CD\u65B0\u521B\u5EFA', context); }
    if (!/\u786E\u8BA4|\u662F\u7684|\u5BF9|\u53EF\u4EE5|\u6B63\u786E|\u6CA1.*\u95EE\u9898|ok|yes|\u63D0\u4EA4/i.test(message)) {
        return { success: true, content: '\u8BF7\u56DE\u590D\u300C\u786E\u8BA4\u300D\u63D0\u4EA4\u8BA2\u5355\u3001\u300C\u4FEE\u6539\u300D\u91CD\u65B0\u586B\u5199\u3001\u6216\u300C\u53D6\u6D88\u300D\u9000\u51FA\u3002' };
    }

    var errors = [];
    var deliveryDate = new Date(data.deliveryDate);
    if (isNaN(deliveryDate.getTime())) errors.push('\u26A0\uFE0F \u4EA4\u671F\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u8BF7\u8F93\u5165 YYYY-MM-DD \u683C\u5F0F');
    if (data.isNewProduct) {
        errors.push('\u26A0\uFE0F \u30105.2.1\u3011\u65B0\u54C1\u8BA2\u5355\uFF1A\u8BF7\u786E\u8BA4\u6837\u54C1\u9274\u5B9A\u4F1A\u5DF2\u53EC\u5F00\u4E14\u8BD5\u4EA7\u5DF2\u901A\u8FC7\u3002\u5982\u672A\u901A\u8FC7\u5219\u4E0D\u5141\u8BB8\u4E0B\u8BA2\u5355\u3002');
    }
    try {
        var cycles = query("SELECT * FROM production_cycles WHERE product_name = ? AND status = 'ACTIVE'", [data.productName]);
        if (cycles.length > 0 && !isNaN(deliveryDate.getTime())) {
            var cycleDays = cycles[0].cycle_days;
            var minDate = new Date(); minDate.setDate(minDate.getDate() + cycleDays);
            if (deliveryDate < minDate) {
                errors.push('\u26A0\uFE0F \u30105.2.3\u3011\u4EA4\u671F\u4E0D\u6EE1\u8DB3\u751F\u4EA7\u5468\u671F\uFF1A' + data.productName + ' \u751F\u4EA7\u5468\u671F ' + cycleDays + ' \u5929\uFF0C\u6700\u65E9\u53EF\u4EA4\u671F\u4E3A ' + minDate.toISOString().slice(0, 10));
            }
        }
    } catch (e) {}

    if (errors.length > 0) {
        orderFormStates.delete(convId);
        return { success: true, content: '\u26A0\uFE0F \u8BA2\u5355\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A\n\n' + errors.join('\n\n') + '\n\n\u{1F4A1} \u8BF7\u89E3\u51B3\u4EE5\u4E0A\u95EE\u9898\u540E\u91CD\u65B0\u521B\u5EFA\u8BA2\u5355\u3002' };
    }

    try {
        var now = new Date();
        var orderNo = 'SO' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
        var insertResult = run('INSERT INTO sales_orders (order_no, customer_name, product_name, quantity, delivery_date, is_new_product, special_requirements, attachment_note, status, applicant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [orderNo, data.customerName, data.productName, data.quantity, data.deliveryDate, data.isNewProduct?1:0, data.specialRequirements||'', data.attachmentNote||'', 'DRAFT', context.userId]);
        var orderId = insertResult.lastID;
        orderFormStates.delete(convId);

        var resultMsg = '\u2705 **\u9500\u552E\u8BA2\u5355\u521B\u5EFA\u6210\u529F\uFF01**\n\n' +
            '\u{1F516} \u8BA2\u5355\u7F16\u53F7\uFF1A' + orderNo + '\n' +
            '\u{1F4CB} \u5185\u90E8ID\uFF1A#' + orderId + '\n' +
            '\u{1F464} \u5BA2\u6237\uFF1A' + data.customerName + '\n' +
            '\u{1F4E6} \u4EA7\u54C1\uFF1A' + data.productName + ' \u00D7 ' + data.quantity + 'PCS\n' +
            '\u{1F4C5} \u4EA4\u671F\uFF1A' + data.deliveryDate + '\n' +
            '\u{1F4CC} \u72B6\u6001\uFF1A\u8349\u7A3F\n\n' +
            '\u{1F4A1} **\u4E0B\u4E00\u6B65\u6D41\u7A0B\uFF1A**\n' +
            '\u2022 \u63D0\u4EA4\u5BA1\u6279 \u2192 \u56DE\u590D\u300C\u63D0\u4EA4\u5BA1\u6279 #' + orderId + '\u300D\n' +
            '\u2022 \u8BA2\u5355\u5C06\u8FDB\u5165\uFF1A**\u5DE5\u7A0B\u90E8BOM\u8BC4\u5BA1 \u2192 \u8BA1\u5212\u90E8\u4EA4\u671F\u8BC4\u5BA1 \u2192 \u4E1A\u52A1\u90E8\u786E\u8BA4**';
        try { run('INSERT INTO notifications (user_id, source, title, content, status) VALUES (?,?,?,?,?)', [context.userId, 'SYSTEM', '\u8BA2\u5355\u5DF2\u521B\u5EFA', orderNo + ' - ' + data.customerName, 'PENDING']); } catch(e){}
        return { success: true, content: resultMsg, data: { orderId: orderId, orderNo: orderNo } };
    } catch (e) {
        orderFormStates.delete(convId);
        if (e.message && e.message.includes('no such table')) {
            return { success: true, content: '\u26A0\uFE0F \u9500\u552E\u8BA2\u5355\u8868\uFF08sales_orders\uFF09\u5C1A\u672A\u521D\u59CB\u5316\u3002\n\n\u8BF7\u5148\u5728\u6570\u636E\u5E93\u4E2D\u6267\u884C\u5EFA\u8868\u8BED\u53E5\u3002\n\n\u4E4B\u540E\u5C31\u53EF\u4EE5\u6B63\u5E38\u521B\u5EFA\u8BA2\u5355\u4E86\uFF01' };
        }
        return { success: false, content: '\u274C \u521B\u5EFA\u8BA2\u5355\u5931\u8D25\uFF1A' + e.message };
    }
}

// 订单查询
async function queryOrders(context, filter) {
    try {
        var userId = context.userId, userRole = context.userRole;
        var orders;
        if (userRole === 'ADMIN' || userRole === 'SALES' || userRole === 'SALES_INTL' || userRole === 'ENGINEER' || userRole === 'PLANNER' || userRole === 'DIRECTOR') {
            orders = query("SELECT * FROM sales_orders ORDER BY created_at DESC LIMIT 10");
        } else {
            orders = query("SELECT * FROM sales_orders WHERE applicant_id = ? ORDER BY created_at DESC LIMIT 10", [userId]);
        }
        if (!orders || orders.length === 0) return { success: true, content: '\u{1F4CB} \u5F53\u524D\u6CA1\u6709\u9500\u552E\u8BA2\u5355\u3002\n\n\u{1F4A1} \u8BF4\u300C\u6211\u8981\u4E0B\u8BA2\u5355\u300D\u5F00\u59CB\u521B\u5EFA\uFF01' };

        var statusMap = { 'DRAFT':'\u8349\u7A3F','PENDING_ENG':'\u5F85\u5DE5\u7A0B\u8BC4\u5BA1','PENDING_PLAN':'\u5F85\u8BA1\u5212\u8BC4\u5BA1','APPROVED':'\u5DF2\u6279\u51C6','IN_PRODUCTION':'\u751F\u4EA7\u4E2D','COMPLETED':'\u5DF2\u5B8C\u6210','DELIVERED':'\u5DF2\u53D1\u8D27','CHANGED':'\u5DF2\u53D8\u66F4','CANCELLED':'\u5DF2\u53D6\u6D88' };
        var text = '\u{1F4CB} **\u9500\u552E\u8BA2\u5355\u5217\u8868**\uFF08\u5171 ' + orders.length + ' \u6761\uFF09\n\n';
        for (var i = 0; i < Math.min(orders.length, 8); i++) {
            var o = orders[i];
            text += '\u{1F516} #' + o.id + ' ' + (o.order_no||'SO'+o.id) + ' | ' + o.customer_name + '\n';
            text += '   \u{1F4E6} ' + o.product_name + ' \u00D7 ' + o.quantity + (o.unit||'PCS') + '\n';
            text += '   \u{1F4C5} \u4EA4\u671F\uFF1A' + (o.delivery_date||'\u5F85\u5B9A') + ' | ' + (statusMap[o.status]||o.status) + '\n';
            if (o.order_type === 'RUSH') text += '   \u26A1 \u6025\u63D2\u5355\n';
            if (o.is_new_product) text += '   \u{1F195} \u65B0\u54C1\n';
            text += '\n';
        }
        text += '\u{1F4A1} \u67E5\u770B\u8BA2\u5355\u8BE6\u60C5\uFF1A\u56DE\u590D\u300C\u67E5\u770B\u8BA2\u5355 #\u7F16\u53F7\u300D';
        return { success: true, content: text };
    } catch (e) {
        return { success: true, content: '\u{1F4CB} \u8BA2\u5355\u67E5\u8BE2\n\n\u26A0\uFE0F \u6570\u636E\u8868\u5C1A\u672A\u521D\u59CB\u5316\uFF0C\u8BF7\u5148\u6267\u884C\u5EFA\u5E93\u811A\u672C\u3002' };
    }
}

// 创建发货单
async function createDeliveryNote(context, orderId) {
    try {
        var order;
        if (orderId) {
            order = query("SELECT * FROM sales_orders WHERE id = ? AND status IN ('APPROVED','IN_PRODUCTION','COMPLETED')", [orderId])[0];
        } else {
            order = query("SELECT * FROM sales_orders WHERE status IN ('APPROVED','IN_PRODUCTION','COMPLETED') ORDER BY delivery_date ASC LIMIT 1")[0];
        }
        if (!order) {
            return { success: true, content: '\u{1F4E6} \u5F53\u524D\u6CA1\u6709\u53EF\u53D1\u8D27\u7684\u8BA2\u5355\u3002\n\n\u2705 \u53EA\u6709\u72B6\u6001\u4E3A\u300C\u5DF2\u6279\u51C6\u300D\u300C\u751F\u4EA7\u4E2D\u300D\u300C\u5DF2\u5B8C\u6210\u300D\u7684\u8BA2\u5355\u624D\u80FD\u53D1\u8D27\u3002\n\u{1F4A1} \u8BF4\u300C\u6211\u7684\u8BA2\u5355\u300D\u67E5\u770B\u6240\u6709\u8BA2\u5355\u72B6\u6001\u3002' };
        }
        var now = new Date();
        var dno = 'DN' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
        try {
            var insertResult = run("INSERT INTO delivery_notes (delivery_no, order_id, customer_name, product_name, quantity, status, created_by) VALUES (?,?,?,?,?,?,?)",
                [dno, order.id, order.customer_name, order.product_name, order.quantity, 'PENDING', context.userId]);
        } catch(tableErr) {
            return { success: true, content: '\u26A0\uFE0F \u53D1\u8D27\u5355\u8868\uFF08delivery_notes\uFF09\u5C1A\u672A\u521D\u59CB\u5316\u3002\n\u8BF7\u5148\u6267\u884C\u5EFA\u8868\u8BED\u53E5\u3002' };
        }
        return {
            success: true,
            content: '\u2705 **\u53D1\u8D27\u5355\u5DF2\u521B\u5EFA\uFF01**\n\n\u{1F4E6} \u53D1\u8D27\u5355\u53F7\uFF1A' + dno + '\n\u{1F516} \u5173\u8054\u8BA2\u5355\uFF1A#' + order.id + '\n\u{1F464} \u5BA2\u6237\uFF1A' + order.customer_name + '\n\u{1F4E6} \u4EA7\u54C1\uFF1A' + order.product_name + ' \u00D7 ' + order.quantity + 'PCS\n\n\u26A0\uFE0F \u4E0B\u4E00\u6B65\uFF1A\u9700\u8D22\u52A1\u90E8\u5BA1\u6838\u540E\u51FA\u5E93\u3002\n\u{1F4A1} Web\u7AEF\u300C\u53D1\u8D27\u7BA1\u7406\u300D\u9875\u9762\u53EF\u5B8C\u6210\u5BA1\u6838\u4E0E\u51FA\u5E93\u64CD\u4F5C\u3002'
        };
    } catch (e) {
        return { success: false, content: '\u274C \u521B\u5EFA\u53D1\u8D27\u5355\u5931\u8D25\uFF1A' + e.message };
    }
}

// 订单变更引导
// ============================================================
//  5.4 订单变更管理 — 飞书全流程（客户变更/计划延期/急插单）
// ============================================================
async function orderChangeGuide(context) {
    var userId = context.userId, userName = context.userName;
    var convId = userId ? 'change_' + userId : 'change_anon';
    var st = getConversationState(convId);
    // 展示可变更订单列表
    var orders = query("SELECT * FROM sales_orders WHERE status IN ('APPROVED','PENDING_ENG','PENDING_PLAN','PENDING_BIZ','PENDING_PURCHASE','PENDING_QUALITY') ORDER BY updated_at DESC LIMIT 8");
    if (!orders || orders.length === 0) return { success: true, content: '📝 当前没有可变更的订单。' };
    var text = '📝 **订单变更管理（5.4）**\n\n可变更订单：\n';
    for (var i = 0; i < orders.length; i++) {
        var o = orders[i];
        text += '🔖 #' + o.id + ' | ' + o.customer_name + ' | ' + (o.product_name||'-') + ' ×' + o.quantity + ' | 📅' + (o.delivery_date||'-') + ' | ' + (ORDER_STATUS[o.status]||o.status) + '\n';
    }
    text += '\n📌 **三种变更类型：**\n';
    text += '① 客户变更：「变更 #编号 客户要求改交期到YYYY-MM-DD」\n';
    text += '② 计划延期：「变更 #编号 计划部无法按时交付需顺延N天」\n';
    text += '③ 急插单：「急插单 客户名 产品 数量 交期」\n';
    text += '\n📄 变更后系统生成《销售订单变更及/订单|销售|通知|请示/单》，自动触发重新评审。';
    return { success: true, content: text };
}

// 急插单表单收集
var changeFormState = {};
async function startUrgentOrder(convId, message, context) {
    changeFormState[convId] = { step: 'urgent_customer', data: {}, createdAt: Date.now() };
    return { success: true, content: '🚨 **急插单申请（5.5）**\n\n⚠️ 规则：需提前7个工作日/订单|销售|通知|请示/，原订单应相应顺延。\n\n请按格式回复：\n客户名,产品名,数量,要求交期\n\n示例：华为技术,电源模块PCB,500,2026-07-15' };
}
async function handleUrgentCollect(st, convId, message, context) {
    var step = st.step, data = st.data;
    if (step === 'urgent_customer') {
        var parts = message.split(/[,，]/);
        if (parts.length < 4) return { success: true, content: '⚠️ 请按格式：客户名,产品名,数量,要求交期\n示例：华为技术,电源模块PCB,500,2026-07-15' };
        data.customer_name = parts[0].trim();
        data.product_name = parts[1].trim();
        data.quantity = parseInt(parts[2]) || 1;
        data.delivery_date = parts[3].trim();
        // 7工作日校验
        var today = new Date(); var target = new Date(data.delivery_date);
        var workdays = 0; var d = new Date(today);
        while (d < target) { d.setDate(d.getDate()+1); if (d.getDay() !== 0 && d.getDay() !== 6) workdays++; }
        if (workdays < 7) {
            return { success: true, content: '⚠️ **急插单需提前7个工作日/订单|销售|通知|请示/！**\n当前距交期仅' + workdays + '个工作日（需≥7）。\n\n请重新输入或联系计划部特批。' };
        }
        data.workdays = workdays;
        // 确认
        var text = '🚨 **急插单确认**\n\n';
        text += '客户：' + data.customer_name + '\n';
        text += '产品：' + data.product_name + '\n';
        text += '数量：' + data.quantity + ' PCS\n';
        text += '要求交期：' + data.delivery_date + '（' + workdays + '个工作日）\n';
        text += '\n✅ 确认创建？回复「确认」或「取消」';
        st.step = 'urgent_confirm';
        return { success: true, content: text };
    }
    if (step === 'urgent_confirm') {
        if (message.includes('确认') || message.includes('是') || message === 'y') {
            // 创建急插单（同时记录原订单顺延）
            var orderNo = 'RU' + pad4(new Date().getFullYear() % 100) + pad4(new Date().getMonth()+1) + pad4(new Date().getDate()) + pad4(new Date().getHours()*60+new Date().getMinutes());
            run("INSERT INTO sales_orders (order_no,customer_name,product_name,quantity,delivery_date,is_rush,order_type,status,applicant_id,applicant_name,special_requirements) VALUES (?,?,?,?,?,1,'rush','DRAFT',?,?,'急插单-原单顺延')",
                [orderNo, data.customer_name, data.product_name, data.quantity, data.delivery_date, context.userId||0, context.userName||'']);
            var newId = query("SELECT last_insert_rowid() as id")[0].id;
            // 记录变更日志
            run("INSERT INTO order_changes (order_id,change_type,change_reason,old_value,new_value,status,applicant_id) VALUES (?,?,?,?,?,?,?)",
                [newId, 'urgent_insert', '急插单', '-', data.customer_name+' '+data.product_name+'×'+data.quantity, 'pending', context.userId||0]);
            delete changeFormState[convId];
            return { success: true, skipAI: true, content: '🚨 **急插单已创建！**\n\n订单号：' + orderNo + '\n客户：' + data.customer_name + '\n产品：' + data.product_name + ' ×' + data.quantity + '\n交期：' + data.delivery_date + '\n\n⚠️ 原订单已标记顺延。\n📋 请说「提交审批 #' + newId + '」启动评审。' };
        }
        delete changeFormState[convId];
        return { success: true, content: '已取消急插单。' };
    }
    return { success: true, content: '操作已取消。' };
}

// 处理订单变更对话
async function handleChangeConversation(message, context) {
    var userId = context.userId, convId = userId ? 'change_' + userId : 'change_anon';
    var st = getConversationState(convId);
    // 变更 #ID 客户要求改交期到YYYY-MM-DD
    var cm = message.match(/变更\s*#(\d+)\s*(.+)/i);
    if (cm) {
        var orderId = parseInt(cm[1]); var detail = cm[2];
        var order = query("SELECT * FROM sales_orders WHERE id = ?", [orderId])[0];
        if (!order) return { success: true, content: '❌ 订单 #' + orderId + ' 不存在。' };
        if (order.status === 'CANCELLED' || order.status === 'DELIVERED') return { success: true, content: '❌ 订单 #' + orderId + ' 状态为' + (ORDER_STATUS[order.status]||order.status) + '，不可变更。' };
        // 解析变更类型
        var changeType, oldValue, newValue, reason;
        if (detail.includes('交期') || detail.includes('日期')) {
            changeType = 'customer_change';
            oldValue = order.delivery_date||'-';
            var dateMatch = detail.match(/(\d{4}-\d{2}-\d{2})/);
            newValue = dateMatch ? dateMatch[1] : detail;
            reason = '客户要求变更交期';
        } else if (detail.includes('顺延') || detail.includes('延期') || detail.includes('延迟')) {
            changeType = 'planning_delay';
            oldValue = order.delivery_date||'-';
            var dayMatch = detail.match(/(\d+)\s*天/);
            var delayDays = dayMatch ? parseInt(dayMatch[1]) : 7;
            var newDate = new Date(order.delivery_date); newDate.setDate(newDate.getDate()+delayDays);
            newValue = newDate.toISOString().slice(0,10);
            reason = '计划部无法按时交付，需顺延' + delayDays + '天';
        } else {
            changeType = 'other_change';
            oldValue = '-';
            newValue = detail;
            reason = detail;
        }
        // 记录变更
        run("INSERT INTO order_changes (order_id,change_type,change_reason,old_value,new_value,status,applicant_id) VALUES (?,?,?,?,?,?,?)",
            [orderId, changeType, reason, oldValue, newValue, 'pending', userId||0]);
        run("UPDATE sales_orders SET status='DRAFT', change_notes=?, updated_at=datetime('now') WHERE id=?", [reason, orderId]);
        var text = '📝 **订单变更已记录**\n\n';
        text += '订单 #' + orderId + ' | ' + order.customer_name + '\n';
        text += '变更类型：' + (changeType==='customer_change'?'客户变更':changeType==='planning_delay'?'计划延期':'其他变更') + '\n';
        text += '变更原因：' + reason + '\n';
        text += '原值：' + oldValue + ' → 新值：' + newValue + '\n';
        text += '\n📄 已生成《销售订单变更及/订单|销售|通知|请示/单》\n';
        text += '📋 订单状态已退回草稿，请说「提交审批 #' + orderId + '」重新评审。';
        return { success: true, content: text };
    }
    // 急插单入口
    if (message.match(/急插单|加急订单/)) {
        return await startUrgentOrder(convId, message, context);
    }
    return null;
}

// ============================================================
//  5.7 联络单 — 飞书多轮表单
// ============================================================
var contactFormState = {};
async function contactFormGuide(context) {
    var convId = context.userId ? 'contact_' + context.userId : 'contact_anon';
    contactFormState[convId] = { step: 'title', data: {} };
    return { success: true, content: '📋 **联络单创建（5.7）**\n\n用于非订单类需求。\n\n第1步：请输入联络单标题。' };
}
async function handleContactCollect(st, convId, message, context) {
    var data = st.data;
    if (st.step === 'title') {
        data.title = message.trim();
        st.step = 'content';
        return { success: true, content: '✅ 标题：' + data.title + '\n\n第2步：请输入联络单详细内容。' };
    }
    if (st.step === 'content') {
        data.content = message.trim();
        st.step = 'dept';
        return { success: true, content: '✅ 内容已记录。\n\n第3步：请输入接收部门（如：计划部/工程部/品质部）。' };
    }
    if (st.step === 'dept') {
        data.department = message.trim();
        st.step = 'confirm';
        var text = '📋 **联络单确认**\n\n';
        text += '标题：' + data.title + '\n';
        text += '内容：' + data.content + '\n';
        text += '接收部门：' + data.department + '\n';
        text += '\n回复「确认」提交。';
        return { success: true, content: text };
    }
    if (st.step === 'confirm') {
        if (message.includes('确认') || message === 'y') {
            run("INSERT INTO contact_forms (title,content,department,status,applicant_id) VALUES (?,?,?,'pending',?)",
                [data.title, data.content, data.department, context.userId||0]);
            delete contactFormState[convId];
            return { success: true, content: '✅ **联络单已创建！**\n\n标题：' + data.title + '\n接收部门：' + data.department + '\n状态：待处理\n\n📌 请/订单|销售|通知|请示/' + data.department + '处理。' };
        }
        delete contactFormState[convId];
        return { success: true, content: '已取消联络单。' };
    }
    return { success: true, content: '操作已取消。' };
}

// ============================================================
//  5.8 预测计划 — 飞书多轮表单
// ============================================================
var forecastFormState = {};
async function forecastGuide(context) {
    var convId = context.userId ? 'forecast_' + context.userId : 'forecast_anon';
    forecastFormState[convId] = { step: 'month', data: {} };
    return { success: true, content: '📊 **预测需求计划（5.8）**\n\n规则：每月25号业务部与计划部召开产销协调会，制定下月预测。\n\n第1步：请输入预测月份（如 2026-07）。' };
}
async function handleForecastCollect(st, convId, message, context) {
    var data = st.data;
    if (st.step === 'month') {
        data.month = message.trim();
        st.step = 'dept';
        return { success: true, content: '✅ 月份：' + data.month + '\n\n第2步：请输入目标部门。' };
    }
    if (st.step === 'dept') {
        data.target_department = message.trim();
        st.step = 'content';
        return { success: true, content: '✅ 部门：' + data.target_department + '\n\n第3步：请输入预测计划详细内容。' };
    }
    if (st.step === 'content') {
        data.plan_content = message.trim();
        st.step = 'confirm';
        var text = '📊 **预测计划确认**\n\n';
        text += '月份：' + data.month + '\n';
        text += '目标部门：' + data.target_department + '\n';
        text += '内容：' + data.plan_content + '\n';
        text += '\n⚠️ 预测订单免评审流程（5.3.5）。\n回复「确认」提交。';
        return { success: true, content: text };
    }
    if (st.step === 'confirm') {
        if (message.includes('确认') || message === 'y') {
            run("INSERT INTO prediction_plans (month,target_department,plan_content,status,creator_id) VALUES (?,?,?,'draft',?)",
                [data.month, data.target_department, data.plan_content, context.userId||0]);
            delete forecastFormState[convId];
            return { success: true, content: '✅ **预测计划已创建！**\n\n月份：' + data.month + '\n部门：' + data.target_department + '\n\n📌 系统将自动转为预测销售订单，PMC录入ERP后执行。' };
        }
        delete forecastFormState[convId];
        return { success: true, content: '已取消预测计划。' };
    }
    return { success: true, content: '操作已取消。' };
}

// ============================================================
//  5.9 交付率统计 — 飞书记录+查询
// ============================================================
async function deliveryStatsQuery(context) {
    try {
        var stats = query("SELECT * FROM delivery_stats ORDER BY month DESC LIMIT 6");
        if (!stats || stats.length === 0) {
            var text = '📊 **准时交付率统计（5.9）**\n\n暂无数据。\n\n规则：\n• 每月5日前统计上月数据\n• 计算准时交付率 = 准时订单/总订单\n• 分析延迟原因\n• 提出改善措施\n\n💡 录入统计说「录入交付率 月份 总订单 准时 延迟 原因」';
            return { success: true, content: text };
        }
        var text = '📊 **准时交付率统计**\n\n';
        var totalOrders = 0, totalOnTime = 0;
        for (var i = 0; i < stats.length; i++) {
            var s = stats[i];
            var rate = s.total_orders > 0 ? (s.on_time / s.total_orders * 100) : 0;
            text += '📅 ' + s.month + '：准时交付率 **' + rate.toFixed(1) + '%**\n';
            text += '   总订单 ' + s.total_orders + ' | 准时 ' + s.on_time + ' | 延迟 ' + s.delay_count + '\n';
            if (s.delay_reason) text += '   延迟原因：' + s.delay_reason + '\n';
            if (s.improvement) text += '   改善措施：' + s.improvement + '\n';
            text += '\n';
        }
        text += '💡 录入新统计：「录入交付率 2026-06 50 45 5 供应商延迟」';
        return { success: true, content: text };
    } catch (e) {
        return { success: true, content: '📊 交付率统计功能可用。\n💡 说「录入交付率 月份 总订单 准时 延迟 原因」开始。' };
    }
}

// 录入交付率
async function recordDeliveryStats(message, context) {
    var m = message.match(/录入交付率\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)/i);
    if (!m) return { success: true, content: '⚠️ 格式：录入交付率 月份 总订单 准时 延迟 原因\n示例：录入交付率 2026-06 50 45 5 供应商延迟' };
    var month = m[1], total = parseInt(m[2]), ontime = parseInt(m[3]), delay = parseInt(m[4]), reason = (m[5]||'').trim();
    var rate = total > 0 ? (ontime / total * 100).toFixed(1) : '0.0';
    // Check if exists
    var exist = query("SELECT id FROM delivery_stats WHERE month = ?", [month]);
    if (exist.length > 0) {
        run("UPDATE delivery_stats SET total_orders=?, on_time=?, delay_count=?, delay_reason=?, updated_at=datetime('now') WHERE month=?",
            [total, ontime, delay, reason, month]);
    } else {
        run("INSERT INTO delivery_stats (order_id,month,total_orders,on_time,delay_count,delay_reason,on_time_pct) VALUES (0,?,?,?,?,?,?)",
            [month, total, ontime, delay, reason, parseFloat(rate)]);
    }
    return { success: true, content: '✅ **交付率已录入！**\n\n月份：' + month + '\n准时交付率：**' + rate + '%**\n总订单：' + total + ' | 准时：' + ontime + ' | 延迟：' + delay + '\n' + (reason ? '延迟原因：' + reason + '\n' : '') + '\n📌 计划部请据此分析改善。' };
}

// ============================================================
//  5.10 生产周期表 — 飞书CRUD
// ============================================================
async function productionCycleQuery(context) {
    try {
        var cycles = query("SELECT * FROM production_cycles ORDER BY product_code LIMIT 15");
        if (!cycles || cycles.length === 0) {
            var text = '🏭 **产品生产周期表（5.10）**\n\n暂无数据。\n\n规则：\n• 每季度与计划部更新一次\n• 需分管领导审批签核\n• 文控中心受控发行\n\n💡 添加周期：「添加周期 产品编码 产品名 生产天数」';
            return { success: true, content: text };
        }
        var text = '🏭 **产品生产周期表**\n\n';
        for (var i = 0; i < cycles.length; i++) {
            var c = cycles[i];
            text += '📦 ' + c.product_code + ' ' + (c.product_name||'') + ' | 周期：**' + c.lead_days + '天**';
            if (c.cycle_category) text += ' | ' + c.cycle_category;
            text += ' | 生效：' + (c.valid_from||'-') + '\n';
        }
        text += '\n💡 添加：「添加周期 产品编码 产品名 生产天数」\n💡 更新：「更新周期 产品编码 新天数」';
        return { success: true, content: text };
    } catch (e) {
        return { success: true, content: '🏭 生产周期表功能可用。\n💡 说「添加周期」或「查看周期」。' };
    }
}

// 添加/更新生产周期
async function manageProductionCycle(message, context) {
    var addMatch = message.match(/添加周期\s+(\S+)\s+(\S+)\s+(\d+)/i);
    var updMatch = message.match(/更新周期\s+(\S+)\s+(\d+)/i);
    if (addMatch) {
        var code = addMatch[1], name = addMatch[2], days = parseInt(addMatch[3]);
        var today = new Date().toISOString().slice(0,10);
        run("INSERT OR REPLACE INTO production_cycles (product_code,product_name,lead_days,valid_from) VALUES (?,?,?,?)",
            [code, name, days, today]);
        return { success: true, content: '✅ **生产周期已添加！**\n\n产品：' + code + ' ' + name + '\n生产周期：' + days + '天\n生效日期：' + today + '\n\n📌 请分管领导审批签核。' };
    }
    if (updMatch) {
        var code2 = updMatch[1], newDays = parseInt(updMatch[2]);
        var exist = query("SELECT * FROM production_cycles WHERE product_code = ?", [code2]);
        if (exist.length === 0) return { success: true, content: '❌ 产品编码 ' + code2 + ' 不存在。请先用「添加周期」创建。' };
        run("UPDATE production_cycles SET lead_days=?, updated_at=datetime('now') WHERE product_code=?", [newDays, code2]);
        return { success: true, content: '✅ **生产周期已更新！**\n\n产品：' + code2 + '\n生产周期：' + exist[0].lead_days + '天 → **' + newDays + '天**\n\n📌 请分管领导审批签核。' };
    }
    return null;
}

// ============================================================
//  辅助函数
// ============================================================
function getConversationState(convId) {
    // Order form state (uses Map)
    var orderSt = orderFormStates.get(convId);
    if (orderSt) return orderSt;
    // Other form states
    if (convId.startsWith('change_')) return changeFormState[convId] || null;
    if (convId.startsWith('contact_')) return contactFormState[convId] || null;
    if (convId.startsWith('forecast_')) return forecastFormState[convId] || null;
    return null;
}

// ============================================================
//  销售订单 Agent Process（v6.0 主入口）
// ============================================================
async function orderAgentProcess(message, context = {}) {
    var userId = context.userId, userName = context.userName, userRole = context.userRole, feishuChatId = context.feishuChatId, isAdmin = context.isAdmin;
    var convId = userId ? "order_" + userId : "order_anon";

    // ===== 多轮表单状态检查（所有类型）=====
    // 订单表单
    var st = orderFormStates.get(convId);
    if (st) {
        if (st.state === "COLLECTING") return await handleOrderCollect(st, convId, message, context);
        if (st.state === "CONFIRMING") return await handleOrderConfirm(st, convId, message, context);
        if (st.state === "SUBMITTED") orderFormStates.delete(convId);
    }
    // 联络单表单
    var contactId = userId ? 'contact_' + userId : 'contact_anon';
    var cfSt = contactFormState[contactId];
    if (cfSt) return await handleContactCollect(cfSt, contactId, message, context);
    // 预测表单
    var forecastId = userId ? 'forecast_' + userId : 'forecast_anon';
    var ffSt = forecastFormState[forecastId];
    if (ffSt) return await handleForecastCollect(ffSt, forecastId, message, context);
    // 急插单表单
    var changeId = userId ? 'change_' + userId : 'change_anon';
    var chSt = changeFormState[changeId];
    if (chSt) return await handleUrgentCollect(chSt, changeId, message, context);

    // ===== 变更/急插单 对话处理 =====
    if ((/\u53D8\u66F4|\u6539\u8BA2\u5355|\u4FEE\u6539\u8BA2\u5355|\u987A\u5EF6/.test(message)) && !(/\u53D6\u6D88|\u9000\u51FA/.test(message))) {
        var changeR = await handleChangeConversation(message, context);
        if (changeR) return changeR;
        return await orderChangeGuide(context);
    }
    if (/\u6025\u63D2\u5355|\u52A0\u6025/.test(message)) return await startUrgentOrder(changeId, message, context);

    // ===== 关键词路由 =====
    if (/\u4E0B\u8BA2\u5355|\u521B\u5EFA\u8BA2\u5355|\u65B0\u5EFA.*\u8BA2\u5355|\u9500\u552E\u8BA2\u5355|\u4E0B\u5355|\u751F\u6210.*\u8BA2\u5355|\u4E0B\u8FBE.*\u8BA2\u5355/.test(message) && !/\u53D8\u66F4|\u4FEE\u6539|\u6539|\u67E5\u8BE2|\u6211\u7684|\u53D1\u8D27|\u51FA\u5E93|\u9884\u6D4B/.test(message)) {
        return await startOrderForm(convId, message, context);
    }
    if (/\u6211\u7684\u8BA2\u5355|\u8BA2\u5355\u5217\u8868|\u67E5\u8BE2.*\u8BA2\u5355|\u8BA2\u5355.*\u67E5\u8BE2|\u6709\u54EA\u4E9B\u8BA2\u5355/.test(message)) return await queryOrders(context);
    if (/\u53D1\u8D27|\u51FA\u5E93|\u53D1\u8D27\u5355/.test(message)) { var om = message.match(/#(\d+)/); return await createDeliveryNote(context, om ? parseInt(om[1]) : null); }
    if (/\u8054\u7EDC\u5355|\u8054\u7EDC\u51FD/.test(message)) return await contactFormGuide(context);
    if (/\u9884\u6D4B|\u6708\u5EA6.*\u9884\u6D4B|\u9700\u6C42.*\u9884\u6D4B/.test(message)) return await forecastGuide(context);
    if (/\u5F55\u5165\u4EA4\u4ED8\u7387|\u5F55\u5165.*\u7EDF\u8BA1/.test(message)) return await recordDeliveryStats(message, context);
    if (/\u4EA4\u4ED8\u7387|\u51C6\u65F6.*\u4EA4\u8D27|\u5EF6\u8FDF.*\u4EA4|\u51C6\u65F6\u7387/.test(message)) return await deliveryStatsQuery(context);
    if (/\u6DFB\u52A0\u5468\u671F|\u66F4\u65B0\u5468\u671F/.test(message)) { var pcR = await manageProductionCycle(message, context); if (pcR) return pcR; }
    if (/\u751F\u4EA7\u5468\u671F|\u5468\u671F\u8868/.test(message)) return await productionCycleQuery(context);
    if (/\u5E93\u5B58|\u6709\u6CA1\u6709\u8D27|\u67E5\u5E93\u5B58|\u5B58\u8D27/.test(message)) {
        try {
            var products = query("SELECT * FROM products LIMIT 10");
            if (products && products.length > 0) {
                var txt = '\u{1F4E6} **\u4EA7\u54C1\u5E93\u5B58**\n\n';
                for (var i = 0; i < products.length; i++) {
                    var p = products[i];
                    txt += '\u{1F4E6} ' + (p.product_code || '') + ' ' + p.product_name + ' | \u5E93\u5B58\uFF1A' + p.inventory_qty + 'PCS';
                    if (p.inventory_qty < p.min_stock) txt += ' \u26A0\uFE0F\u4F4E\u4E8E\u8B66\u6212\u7EBF';
                    txt += '\n';
                }
                return { success: true, content: txt };
            }
            return { success: true, content: '\u{1F4E6} \u6682\u65E0\u4EA7\u54C1\u5E93\u5B58\u6570\u636E\u3002\n\u{1F4A1} Web\u7AEF\u53EF\u7BA1\u7406\u4EA7\u54C1\u5468\u671F\u8868\u3002' };
        } catch (e) {
            return { success: true, content: '\u{1F4E6} \u5E93\u5B58\u67E5\u8BE2\n\n\u26A0\uFE0F \u4EA7\u54C1\u8868\u5C1A\u672A\u521D\u59CB\u5316\u3002' };
        }
    }
    if (/BOM|\u7528\u6599\u6E05\u5355|\u7269\u6599/.test(message)) {
        return { success: true, content: '\u{1F4CB} **BOM\u7528\u6599\u6E05\u5355**\n\n\u5411\u5DE5\u7A0B\u90E8\u786E\u8BA4\u4EA7\u54C1\u7528\u6599\u3002\n\u{1F4A1} \u5DE5\u7A0B\u90E8\u9700\u5728Web\u7AEF\u300C\u8BA2\u5355\u8BC4\u5BA1\u300D\u4E2D\u5F55\u5165BOM\u6E05\u5355\u3002' };
    }

    // AI 解析兜底
    var parsePrompt = '\u4ECE\u7528\u6237\u6D88\u606F\u63D0\u53D6\u9500\u552E\u8BA2\u8D27\u610F\u56FE\uFF0C\u8F93\u51FA JSON\uFF08\u53EA\u8F93\u51FA JSON\uFF09\uFF1A\n\u53EF\u9009 action\uFF1Acreate(\u521B\u5EFA\u8BA2\u5355) / query(\u67E5\u8BE2) / change(\u53D8\u66F4) / delivery(\u53D1\u8D27) / forecast(\u9884\u6D4B) / contact(\u8054\u7EDC\u5355) / stats(\u4EA4\u4ED8\u7387) / cycle(\u751F\u4EA7\u5468\u671F) / help(\u5E2E\u52A9)\u3002\n\u7528\u6237\u6D88\u606F\uFF1A' + message;

    var parseResult = await callAI(MODELS.fast, [
        { role: 'system', content: '\u4F60\u662F\u9500\u552E\u8BA2\u8D27\u610F\u56FE\u63D0\u53D6\u5668\u3002\u53EA\u8F93\u51FA JSON\u3002' },
        { role: 'user', content: parsePrompt }
    ], { temperature: 0.1, max_tokens: 200 });

    var parsedAction = 'help';
    if (parseResult.success) {
        try { var m = (parseResult.content||'').match(/\{[\s\S]*\}/); if (m) parsedAction = (JSON.parse(m[0])).action || 'help'; } catch(e) {}
    }

    switch (parsedAction) {
        case 'create': return await startOrderForm(convId, message, context);
        case 'query': return await queryOrders(context);
        case 'change': return await orderChangeGuide(context);
        case 'delivery': return await createDeliveryNote(context, null);
        case 'forecast': return forecastGuide();
        case 'contact': return contactFormGuide();
        case 'stats': return await deliveryStatsQuery();
        case 'cycle': return await productionCycleQuery();
        default:
            return {
                success: true,
                content: '\u{1F44B} \u4F60\u597D\uFF01\u6211\u662F\u9500\u552E\u8BA2\u8D27\u52A9\u624B\uFF0C\u53EF\u4EE5\u5E2E\u4F60\uFF1A\n\n' +
                    '\u{1F4DD} **\u4E0B\u8BA2\u5355** \u2192 \u8BF4\u300C\u6211\u8981\u4E0B\u8BA2\u5355\u300D\n' +
                    '\u{1F50D} **\u67E5\u8BA2\u5355** \u2192 \u8BF4\u300C\u6211\u7684\u8BA2\u5355\u300D\n' +
                    '\u2710\uFE0F **\u6539\u8BA2\u5355** \u2192 \u8BF4\u300C\u53D8\u66F4\u7BA1\u7406\u300D\n' +
                    '\u{1F4E6} **\u53D1\u8D27** \u2192 \u8BF4\u300C\u521B\u5EFA\u53D1\u8D27\u5355\u300D\n' +
                    '\u{1F4CA} **\u7EDF\u8BA1** \u2192 \u8BF4\u300C\u4EA4\u4ED8\u7387\u7EDF\u8BA1\u300D\n' +
                    '\u{1F3ED} **\u5468\u671F\u8868** \u2192 \u8BF4\u300C\u751F\u4EA7\u5468\u671F\u8868\u300D\n\n' +
                    '\u{1F4A1} \u4E5F\u53EF\u4EE5\u76F4\u63A5\u544A\u8BC9\u6211\u4F60\u60F3\u505A\u4EC0\u4E48\uFF01'
            };
    }
}


// ============================================================
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
            content: `📅 本周订单统计（${week.start} ~ ${week.end}）\n\n📝 订单数：${weekLeave.count} 份\n📊 总数量：${weekLeave.days} 天`,
            action: 'week_stats', data: { week, weekLeave }
        };
    }

    // 本月统计
    if (/本月|这个月/.test(message)) {
        const month = dbHelper.getMonthRange();
        const monthLeave = dbHelper.countLeavesInRange(adminView ? null : userId, month.start, month.end, false);
        return {
            success: true,
            content: `📅 本月订单统计（${month.start} ~ ${month.end}）\n\n📝 订单数：${monthLeave.count} 份\n📊 总数量：${monthLeave.days} 天`,
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
        text += `\n📝 待处理：${pendingLeaves.length} 份\n`;
        for (const l of pendingLeaves.slice(0, 5)) {
            text += `  · #${l.id} ${l.user_name || '未知'}：${l.type} ${l.days}天\n`;
        }
        return { success: true, content: text, action: 'pending', data: { pendingDocs, pendingLeaves } };
    }

    // 订单统计
    if (/订单|销售|通知|请示/|/订单|销售|通知|请示/|/订单|销售|通知|请示/|/订单|销售|通知|请示/|/订单|销售|通知|请示/) {
        const stats = dbHelper.getDocStats();
        const typeNames = { NOTICE: '/订单|销售|通知|请示/', PROPOSAL: '/订单|销售|通知|请示/', REPORT: '报告', DECISION: '决议', MEMO: '会议纪要' };
        let text = `📄 订单统计\n\n总数：${stats.total} 份\n\n`;
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
    const weekLeave = dbHelper.countLeavesInRange(adminView ? null : userId, week.start, week.end, false);

    let text = `📊 系统数据概览\n\n`;
    text += `👥 用户总数：${overview.totalUsers} 人\n`;
    text += `📦 订单总量：${overview.totalDocs} 份\n`;
    text += `${overview.totalLeave} 份\n`;
    text += `⏳ 待审批订单：${overview.pendingDocs} 份\n`;
    text += `${overview.pendingLeave} 份\n`;
    text += `📅 本周订单：${weekLeave.count} 份 (${weekLeave.days} 天)\n\n`;
    text += `${user.name || userName}的个人信息：\n`;
    text += `🌴 剩余年假：${balance.annual.remaining} 天`;
    if (overview.admins.length > 0) {
        text += `\n\n👔 管理员：${overview.admins.map(a => a.name).join('、')}`;
    }
    return { success: true, content: text, action: 'overview', data: { overview, balance } };
}

// ============================================================
//  Notify Agent - /订单|销售|通知|请示/智能体（完整实现）
// ============================================================
async function notifyAgentProcess(message, context = {}) {
    if (!feishuSender) {
        return { success: false, content: '飞书消息服务未连接，无法发送/订单|销售|通知|请示/。' };
    }
    if (!dbHelper) return { success: false, content: '数据库未连接' };

    // AI 解析/订单|销售|通知|请示/意图
    const parsePrompt = `从用户消息中提取/订单|销售|通知|请示/信息，输出 JSON：
用户消息：${message}

可选操作：
- notify_user: 给指定用户发消息 → {"action":"notify_user","targetName":"张三","content":"消息内容"}
- notify_approvers: 给所有审批人发消息 → {"action":"notify_approvers","content":"消息内容"}
- notify_group: 在飞书群里发消息//订单|销售|通知|请示/ → {"action":"notify_group","content":"消息内容"}

如果用户说「在群里发」「群/订单|销售|通知|请示/」「群发」「告诉大家」「/订单|销售|通知|请示/一下大家」→ notify_group
如果找不到明确目标，默认 notify_approvers。
只输出 JSON。`;

    const parseResult = await callAI(MODELS.fast, [
        { role: 'system', content: '你是/订单|销售|通知|请示/信息提取器。只输出 JSON。' },
        { role: 'user', content: parsePrompt }
    ], { temperature: 0.1, max_tokens: 500 });

    let action = { action: 'notify_approvers', content: message };
    if (parseResult.success) {
        try {
            const jsonStr = (parseResult.content || '').match(/\{[\s\S]*\}/);
            if (jsonStr) action = JSON.parse(jsonStr[0]);
        } catch (e) { /* 使用默认值 */ }
    }

    // ===== 群聊/订单|销售|通知|请示/ =====
    if (action.action === 'notify_group' && action.content) {
        const text = `📢 群/订单|销售|通知|请示/\n\n${action.content}\n\n—— ${new Date().toLocaleString('zh-CN')}`;
        try {
            const result = await feishuSender.sendToGroup(text);
            if (result.success) {
                return { success: true, content: `✅ 已发送群/订单|销售|通知|请示/！`, action: 'notify_group' };
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

        const text = `📢 来自系统的/订单|销售|通知|请示/\n\n${action.content}\n\n—— ${new Date().toLocaleString('zh-CN')}`;
        try {
            const result = await feishuSender.sendToUser(user.id, text);
            if (result.success) {
                dbHelper.createNotification(user.id, 'FEISHU', '/订单|销售|通知|请示/', text, 'SENT');
                return { success: true, content: `✅ 已给 ${user.name} 发送飞书/订单|销售|通知|请示/`, action: 'notify_user', data: { user } };
            } else {
                return { success: false, content: `❌ 发送失败：${result.reason || '未知错误'}` };
            }
        } catch (e) {
            return { success: false, content: `❌ 发送失败：${e.message}` };
        }
    }

    // 默认：发给审批人
    const text = `📢 交货率统计\n\n${action.content}\n\n—— ${new Date().toLocaleString('zh-CN')}`;
    try {
        const result = await feishuSender.sendToApprovers(text);
        if (result.success) {
            return {
                success: true,
                content: `✅ 已给 ${result.sent}/${result.total} 位审批人发送飞书/订单|销售|通知|请示/`,
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
//  Sales Order Agent - 销售订单智能体（完整实现）
//  支持：创建订单、查询订单、评审（工程/计划/业务）、变更、发货
// ============================================================
const SALES_STATUS_MAP = {
    draft: '📝 草稿',
    pending_engineering: '🔧 待工程评审',
    pending_planning: '📋 待计划评审',
    pending_confirmation: '✅ 待业务确认',
    confirmed: '🎯 已确认',
    shipped: '🚚 已发货',
    cancelled: '❌ 已取消'
};

async function salesAgentProcess(message, context = {}) {
    const { userId, userName, userRole } = context;
    const isAdmin = userRole === 'ADMIN' || userRole === 'MANAGER';
    const convId = context.conversationId || ('sales_' + (userId || 'anon'));

    if (!queryDb || !runDb) {
        return { success: false, content: '❌ 数据库连接未就绪，请稍后重试。' };
    }

    // 检查 sales_orders 表是否存在
    try {
        queryDb("SELECT 1 FROM sales_orders LIMIT 1");
    } catch (e) {
        return { success: false, content: '❌ 销售订单表不存在，请先初始化数据库。' };
    }

    // ===== 1. AI 解析用户意图 =====

    // ===== 0. 关键词快速拦截（不依赖LLM）=====
    // 提交审批
    var submitMatch = message.match(/(提交审批|提交审核|送审|发起审批)\s*#(\d+)/i);
    if (submitMatch) {
        var submitId = parseInt(submitMatch[2]);
        var submitOrder = queryDb('SELECT * FROM sales_orders WHERE id = ? AND status = \'draft\'', [submitId])[0];
        if (submitOrder) {
            runDb("UPDATE sales_orders SET status='pending_engineering', updated_at=datetime('now') WHERE id=?", [submitId]);
            return { success: true, content: `✅ **订单 #${submitId} 已提交评审！**\n\n📋 ${submitOrder.order_no} · ${submitOrder.customer_name}\n🔄 状态：草稿 → 🔧 待工程部评审\n\n👉 工程部回复「评审 #${submitId} BOM已完成」继续流程` };
        }
        return { success: true, content: `⚠️ 订单 #${submitId} 不存在或不是草稿状态。` };
    }

    // 审批/驳回指令
    var approveMatch = message.match(/(同意|审批通过|通过|批准)\s*#(\d+)/i);
    var rejectMatch = message.match(/(驳回|拒绝|不同意)\s*#(\d+)/i);
    var reviewMatch = approveMatch || rejectMatch;
    if (reviewMatch) {
        var rCmd = approveMatch ? 'approve' : 'reject';
        var rId = parseInt(reviewMatch[2]);
        var rOrder = queryDb('SELECT * FROM sales_orders WHERE id = ?', [rId])[0];
        if (!rOrder) return { success: true, content: `❌ 订单 #${rId} 不存在。` };
        var rComment = (message.replace(reviewMatch[0], '')).trim() || (rCmd === 'approve' ? '审批通过' : '已驳回');
        var rNow = new Date().toISOString();
        if (rOrder.status === 'pending_engineering') {
            if (rCmd === 'approve') {
                runDb("UPDATE sales_orders SET status='pending_planning', reviewer_eng_id=?, reviewer_eng_comment=?, reviewer_eng_at=? WHERE id=?", [userId, rComment, rNow, rId]);
                return { success: true, content: `✅ **工程部评审通过** #${rId}\n💬 ${rComment}\n🔄 下一站：计划部评审\n👉 计划部回复「计划评审 #${rId} 交期...」` };
            } else {
                runDb("UPDATE sales_orders SET status='draft', change_notes=? WHERE id=?", ['工程部驳回: '+rComment, rId]);
                return { success: true, content: `❌ **工程部驳回** #${rId}\n💬 ${rComment}\n🔄 订单已退回草稿状态，请修改后重新提交。` };
            }
        } else if (rOrder.status === 'pending_planning') {
            if (rCmd === 'approve') {
                runDb("UPDATE sales_orders SET status='pending_confirmation', reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?", [userId, rComment, rNow, rId]);
                return { success: true, content: `✅ **计划部评审通过** #${rId}\n💬 ${rComment}\n🔄 下一站：业务部确认\n👉 业务部回复「确认 #${rId}」` };
            } else {
                runDb("UPDATE sales_orders SET status='draft', change_notes=? WHERE id=?", ['计划部驳回: '+rComment, rId]);
                return { success: true, content: `❌ **计划部驳回** #${rId}\n💬 ${rComment}\n🔄 订单已退回草稿状态。` };
            }
        } else if (rOrder.status === 'pending_confirmation') {
            if (rCmd === 'approve') {
                runDb("UPDATE sales_orders SET status='confirmed', reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?", [userId, rComment, rNow, rId]);
                return { success: true, content: `✅ **业务部确认通过！订单已生效** #${rId}\n💬 ${rComment}\n🎉 订单完成所有评审！说「安排发货 #${rId}」安排发货` };
            } else {
                runDb("UPDATE sales_orders SET status='draft', change_notes=? WHERE id=?", ['业务部驳回: '+rComment, rId]);
                return { success: true, content: `❌ **业务部驳回** #${rId}\n💬 ${rComment}\n🔄 订单已退回草稿状态。` };
            }
        } else {
            return { success: true, content: `⚠️ 订单 #${rId} 当前状态为「${SALES_STATUS_MAP[rOrder.status] || rOrder.status}」，无需审批。` };
        }
    }

    // 阶段评审（评审 #id + BOM/交期等关键词）
    var genReviewMatch = message.match(/评审\s*#(\d+)/i);
    if (genReviewMatch && !reviewMatch) {
        var grId = parseInt(genReviewMatch[1]);
        var grOrder = queryDb('SELECT * FROM sales_orders WHERE id = ?', [grId])[0];
        if (!grOrder) return { success: true, content: `❌ 订单 #${grId} 不存在。` };
        var grComment = (message.replace(genReviewMatch[0], '')).trim() || '评审通过';
        var grNow = new Date().toISOString();
        if (grOrder.status === 'pending_engineering') {
            var bomStatus = /BOM\s*(已完|完|通过|完成|OK)/i.test(message) ? 'completed' : 'completed';
            var bomNotes = message.includes('BOM') ? grComment : '';
            runDb("UPDATE sales_orders SET status='pending_planning', bom_status=?, bom_notes=?, reviewer_eng_id=?, reviewer_eng_comment=?, reviewer_eng_at=? WHERE id=?", [bomStatus, bomNotes, userId, grComment, grNow, grId]);
            return { success: true, content: `✅ **工程部评审完成！** #${grId}\n🔧 ${grComment}\n📊 BOM确认通过\n🔄 下一站：计划部评审\n👉 计划部回复「计划评审 #${grId} 交期...」` };
        } else if (grOrder.status === 'pending_planning') {
            var newDate = message.match(/交期[：:]\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[月/]\d{1,2}[日号]?)/i);
            if (newDate) {
                var d = newDate[1];
                if (/\d{1,2}[月/]/.test(d)) { var m = d.match(/(\d{1,2})[月/](\d{1,2})/); d = '2026-' + m[1].padStart(2,'0') + '-' + m[2].padStart(2,'0'); }
                runDb("UPDATE sales_orders SET status='pending_confirmation', delivery_date=?, reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?", [d, userId, grComment, grNow, grId]);
            } else {
                runDb("UPDATE sales_orders SET status='pending_confirmation', reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?", [userId, grComment, grNow, grId]);
            }
            return { success: true, content: `✅ **计划部评审通过** #${grId}\n💬 ${grComment}\n🔄 下一站：业务部确认\n👉 业务部回复「确认 #${grId}」` };
        } else if (grOrder.status === 'pending_confirmation') {
            runDb("UPDATE sales_orders SET status='confirmed', reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?", [userId, grComment, grNow, grId]);
            return { success: true, content: `✅ **业务部确认完成！订单已生效** #${grId}\n💬 ${grComment}\n🎉 说「安排发货 #${grId}」安排发货` };
        } else {
            return { success: true, content: `⚠️ 订单 #${grId} 当前状态为「${SALES_STATUS_MAP[grOrder.status] || grOrder.status}」。\n需要先提交评审：「提交审批 #${grId}」` };
        }
    }

    // 确认/业务确认
    var confirmMatch = message.match(/(确认|业务确认)\s*#(\d+)/i);
    if (confirmMatch) {
        var cfId = parseInt(confirmMatch[2]);
        var cfOrder = queryDb('SELECT * FROM sales_orders WHERE id = ?', [cfId])[0];
        if (!cfOrder) return { success: true, content: `❌ 订单 #${cfId} 不存在。` };
        if (cfOrder.status === 'pending_confirmation') {
            runDb("UPDATE sales_orders SET status='confirmed', reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?", [userId, '确认通过', new Date().toISOString(), cfId]);
            return { success: true, content: `✅ **业务部确认完成！订单已生效** #${cfId}\n🎉 说「安排发货 #${cfId}」安排发货` };
        }
        return { success: true, content: `⚠️ 订单 #${cfId} 当前状态为「${SALES_STATUS_MAP[cfOrder.status] || cfOrder.status}」，不是待确认状态。` };
    }

    // 发货
    var shipMatch = message.match(/(发货|安排发货|出库|发运)\s*#(\d+)/i);
    if (shipMatch) {
        var spId = parseInt(shipMatch[2]);
        var spOrder = queryDb('SELECT * FROM sales_orders WHERE id = ?', [spId])[0];
        if (!spOrder) return { success: true, content: `❌ 订单 #${spId} 不存在。` };
        if (spOrder.status !== 'confirmed') return { success: true, content: `⚠️ 订单 #${spId} 状态为「${SALES_STATUS_MAP[spOrder.status] || spOrder.status}」，需确认后才能发货。` };
        runDb("UPDATE sales_orders SET status='shipped', shipped_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [spId]);
        // Create delivery note
        var dnNo = 'DN' + Date.now().toString(36).toUpperCase();
        runDb("INSERT INTO delivery_notes (order_id,delivery_no,warehouse_status,shipped_at,created_at) VALUES (?,?,'shipped',datetime('now'),datetime('now'))", [spId, dnNo]);
        return { success: true, content: `🚚 **发货/订单|销售|通知|请示/：订单已发货！** #${spId}\n📋 ${spOrder.order_no} · ${spOrder.customer_name}\n📦 ${spOrder.product_type || ''} × ${spOrder.quantity}${spOrder.unit || 'PCS'}\n🔖 发货单号：${dnNo}\n📅 发货时间：${new Date().toLocaleString('zh-CN')}\n🎉 订单流程完成！` };
    }

    // 变更订单
    var chgMatch = message.match(/(变更|修改订单|改订单)\s*#(\d+)/i);
    if (chgMatch) {
        var chgId = parseInt(chgMatch[2]);
        var chgOrder = queryDb('SELECT * FROM sales_orders WHERE id = ?', [chgId])[0];
        if (!chgOrder) return { success: true, content: `❌ 订单 #${chgId} 不存在。` };
        if (chgOrder.status === 'shipped' || chgOrder.status === 'cancelled') return { success: true, content: `⚠️ 订单 #${chgId} 已${chgOrder.status === 'shipped' ? '发货' : '取消'}，无法变更。` };
        var chgNote = (message.replace(chgMatch[0], '')).trim() || '客户要求变更';
        runDb("UPDATE sales_orders SET status='draft', change_notes=?, updated_at=datetime('now') WHERE id=?", [chgNote, chgId]);
        runDb("INSERT INTO order_changes (order_id,change_type,change_reason,applicant_id,created_at) VALUES (?,?,?,?,datetime('now'))", [chgId, 'modification', chgNote, userId]);
        return { success: true, content: `✅ **订单已变更，回到草稿状态** #${chgId}\n💬 ${chgNote}\n🔄 修改后说「提交审批 #${chgId}」重新提交` };
    }

    // 联络单
    if (/联络单|联络函/.test(message)) return await contactFormGuide(context);
    // 预测计划
    if (/预测|月度.*预测|需求.*预测/.test(message)) return await forecastGuide(context);
    // 交付率
    if (/录入交付率|录入.*统计/.test(message)) return await recordDeliveryStats(message, context);
    if (/交付率|准时.*交货/.test(message)) return await deliveryStatsQuery(context);
    // 生产周期
    if (/添加周期|更新周期/.test(message)) { var pcR = await manageProductionCycle(message, context); if (pcR) return pcR; }
    if (/生产周期|周期表/.test(message)) return await productionCycleQuery(context);

    // ===== 1. LLM 解析用户意图（兜底）=====
    const parsePrompt = `你是销售订单系统助手。分析用户消息，提取意图和结构化数据，只输出 JSON。

当前用户：${userName || '未知'}（${userRole || '用户'}）
当前时间：${new Date().toLocaleString('zh-CN')}

用户消息：${message}

## 可选操作
1. **创建订单** (action: create)
   - 需要字段: customer_name(客户名), contact_person(联系人), contact_phone(电话), order_type(订单类型: normal/rush), product_type(产品类型), quantity(数量), unit(单位:PCS/M/套等), price(单价), amount(总金额), delivery_date(交期/YYYY-MM-DD), required_date(要求日期), special_requirements(特殊要求)
   - 示例: "给华为下100个A产品的订单" → {"action":"create","customer_name":"华为","product_type":"A产品","quantity":100,"unit":"PCS"}

2. **查询订单** (action: query)
   - 可选: status(状态筛选), order_no(订单号), keyword(关键词搜索), id(订单ID)
   - 示例: "我的订单" → {"action":"query"}
   - 示例: "查SO2025A1订单" → {"action":"query","order_no":"SO2025A1"}
   - 示例: "待评审的订单" → {"action":"query","status":"pending_engineering"}

3. **提交评审** (action: submit_review)
   - 用户说"提交评审"、"送审" → 找最近草稿状态订单
   - 需要 orderId 或 idMatch(从最近订单查找)

4. **工程部评审** (action: review_engineering)
   - 字段: orderId(或idMatch), comment(评审意见), bom_status(BOM状态:completed/pending), bom_notes(BOM备注)
   - 示例: "评审#3订单，BOM已完成" → {"action":"review_engineering","idMatch":"#3","bom_status":"completed","comment":"BOM已完成"}

5. **计划部评审** (action: review_planning)
   - 字段: orderId, comment, delivery_date(确定的交期)
   - 示例: "计划评审#3，交期定在6月30日" → {"action":"review_planning","idMatch":"#3","delivery_date":"2026-06-30","comment":"交期已定"}

6. **业务部确认** (action: review_business)
   - 字段: orderId, comment
   - 示例: "确认#3订单" → {"action":"review_business","idMatch":"#3","comment":"确认通过"}

7. **变更订单** (action: change)
   - 字段: orderId(或idMatch), change_notes(变更说明)
   - 示例: "改#3订单，客户要求提前交货" → {"action":"change","idMatch":"#3","change_notes":"客户要求提前交货"}

8. **发货** (action: ship)
   - 字段: orderId(或idMatch)
   - 示例: "#3订单安排发货" → {"action":"ship","idMatch":"#3"}

9. **通用评审** (action: review，系统自动判断当前评审阶段)
   - 字段: orderId(或idMatch), comment
   - 如果订单是 pending_engineering 状态，自动做工程部评审
   - 如果订单是 pending_planning 状态，自动做计划部评审
   - 如果订单是 pending_confirmation 状态，自动做业务部确认
   - 示例: "评审#3" → {"action":"review","idMatch":"#3"}

10. **统计** (action: stats)
   - 无特殊字段

11. **联络单** (action: contact_form)
   - 用于非订单类需求，如内部联络
   - 示例: "联络单" "创建联络单"

12. **预测计划** (action: forecast)
   - 用于月度预测需求计划
   - 示例: "预测计划" "月度预测" "需求预测"

13. **交付率统计** (action: delivery_stats)
   - 查询准时交付率
   - 示例: "交付率" "准时交货统计"

14. **生产周期表** (action: production_cycle)
   - 查询产品生产周期
   - 示例: "生产周期" "周期表"

15. **急插单** (action: urgent_order)
   - 创建紧急插单
   - 示例: "急插单" "加急订单"

## 输出格式
只输出 JSON 对象，不要任何其他内容。`;

    const parseResult = await callAI(MODELS.fast, [
        { role: 'system', content: '你只输出 JSON，不要解释。' },
        { role: 'user', content: parsePrompt }
    ], { temperature: 0.15, max_tokens: 600 });

    let action = { action: 'query' };
    if (parseResult.success) {
        try {
            const jsonStr = (parseResult.content || '').match(/\{[\s\S]*\}/);
            if (jsonStr) action = JSON.parse(jsonStr[0]);
        } catch (e) {
            console.warn('[Sales Agent] AI 解析失败:', e.message, '原始:', (parseResult.content || '').slice(0, 100));
        }
    }

    console.log('[Sales Agent] AI解析结果:', JSON.stringify(action));

    // ===== 2. 解析 idMatch（如 #3 或 SO开头）=====
    function resolveOrderId(act) {
        if (act.orderId) return act.orderId;
        if (act.idMatch) {
            const num = parseInt(act.idMatch.replace(/[^0-9]/g, ''));
            if (!isNaN(num)) return num;
        }
        if (act.order_no) {
            const rows = queryDb("SELECT id FROM sales_orders WHERE order_no = ?", [act.order_no]);
            if (rows.length > 0) return rows[0].id;
        }
        return null;
    }

    // ===== 2. 执行操作 =====
    try {
        // ---- 创建订单 ----
        if (action.action === 'create') {
            const customerName = (action.customer_name || '').trim();
            if (!customerName) {
                return { success: true, content: '❌ 请告诉我客户名称，例如"给华为下100个A产品的订单"' };
            }
            const orderNo = 'SO' + Date.now().toString(36).toUpperCase();
            const amount = action.amount || (parseFloat(action.price) || 0) * (parseInt(action.quantity) || 1);
            runDb(`INSERT INTO sales_orders (
                order_no, customer_name, contact_person, contact_phone, order_type,
                product_type, is_rush, quantity, unit, price, amount,
                delivery_date, required_date, special_requirements, status,
                applicant_id, applicant_name
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`, [
                orderNo, customerName, action.contact_person || '', action.contact_phone || '',
                action.order_type || 'normal', action.product_type || '', action.is_rush ? 1 : 0,
                parseInt(action.quantity) || 1, action.unit || 'PCS', parseFloat(action.price) || 0,
                amount, action.delivery_date || '', action.required_date || '',
                action.special_requirements || '', userId || 1, userName || ''
            ]);
            const order = queryDb("SELECT * FROM sales_orders WHERE order_no = ?", [orderNo])[0];
            if (!order) return { success: true, content: '❌ 订单创建失败，请稍后重试。' };

            return {
                success: true,
                content: `✅ **销售订单已创建！**\n\n` +
                    `📋 订单号：${orderNo}\n` +
                    `🏢 客户：${customerName}\n` +
                    `📦 产品：${action.product_type || '未指定'} × ${parseInt(action.quantity) || 1}${action.unit || 'PCS'}\n` +
                    `💰 金额：¥${amount.toFixed(2)}\n` +
                    `📝 状态：${SALES_STATUS_MAP.draft || '📝 草稿'}\n` +
                    `🆔 编号：#${order.id}\n\n` +
                    `👉 说「提交评审 #${order.id}」或「送审 #${order.id}」进入评审流程`
            };
        }

        // ---- 查询订单 ----
        if (action.action === 'query') {
            let sql = 'SELECT * FROM sales_orders WHERE 1=1';
            const params = [];
            if (action.order_no) { sql += ' AND order_no = ?'; params.push(action.order_no); }
            if (action.id) { sql += ' AND id = ?'; params.push(parseInt(action.id)); }
            if (action.status) { sql += ' AND status = ?'; params.push(action.status); }
            if (!action.order_no && !action.id && !action.status) {
                // 默认：当前用户的订单
                if (!isAdmin) { sql += ' AND applicant_id = ?'; params.push(userId); }
                sql += ' ORDER BY created_at DESC LIMIT 10';
            } else {
                sql += ' ORDER BY created_at DESC';
            }
            const orders = queryDb(sql, params);
            if (!orders || orders.length === 0) {
                return { success: true, content: '📋 未找到相关订单。\n\n💡 试试说「下订单」来创建一个新订单。' };
            }

            let text = `📋 **销售订单列表**（共 ${orders.length} 条）\n\n`;
            for (let i = 0; i < Math.min(orders.length, 8); i++) {
                const o = orders[i];
                const statusIcon = SALES_STATUS_MAP[o.status] || '📄';
                text += `#${o.id} ${o.order_no}\n`;
                text += `   🏢 ${o.customer_name} · ${o.product_type || '未指定'} × ${o.quantity}${o.unit || 'PCS'}\n`;
                text += `   ${statusIcon} · ¥${(o.amount || 0).toFixed(2)}\n`;
                if (o.delivery_date) text += `   📅 交期：${o.delivery_date}\n`;
                text += '\n';
            }
            if (orders.length > 8) text += `... 还有 ${orders.length - 8} 条\n\n`;
            text += `💡 查看详情说「查看 #编号」，评审说「评审 #编号」`;
            return { success: true, content: text, action: 'query', data: orders };
        }

        // ---- 提交评审（草稿→待工程评审）----
        if (action.action === 'submit_review') {
            const oid = resolveOrderId(action);
            let order = null;
            if (oid) {
                order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            } else {
                const orders = queryDb("SELECT * FROM sales_orders WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1");
                order = orders.length > 0 ? orders[0] : null;
            }
            if (!order) {
                return { success: true, content: '📋 没有找到草稿状态的订单可提交。\n\n💡 试试说「下订单」先创建订单。' };
            }
            if (order.status !== 'draft') {
                return { success: true, content: `⚠️ 订单 #${order.id} 当前状态为「${SALES_STATUS_MAP[order.status] || order.status}」，无法提交评审。` };
            }
            runDb("UPDATE sales_orders SET status='pending_engineering', updated_at=datetime('now') WHERE id=?", [order.id]);
            return {
                success: true,
                content: `✅ **订单 #${order.id} 已提交评审！**\n\n` +
                    `📋 ${order.order_no} · ${order.customer_name}\n` +
                    `🔄 状态：草稿 → 🔧 待工程部评审\n\n` +
                    `👉 现在等待工程部回复「评审 #${order.id}」进行 BOM 评审`
            };
        }

        // ---- 工程部评审 ----
        if (action.action === 'review_engineering') {
            const oid = resolveOrderId(action);
            if (!oid) return { success: true, content: '❌ 请指定订单编号，如「评审 #3 BOM已完成」' };
            const order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            if (!order) return { success: true, content: `❌ 订单 #${oid} 不存在。` };
            if (order.status !== 'pending_engineering') {
                return { success: true, content: `⚠️ 订单 #${oid} 当前状态为「${SALES_STATUS_MAP[order.status] || order.status}」，不是待工程评审状态。` };
            }
            const now = new Date().toISOString();
            const bomStatus = action.bom_status || 'completed';
            const bomNotes = action.bom_notes || '';
            const comment = action.comment || '工程部评审通过';
            runDb(`UPDATE sales_orders SET status='pending_planning', bom_status=?, bom_notes=?,
                 reviewer_eng_id=?, reviewer_eng_comment=?, reviewer_eng_at=? WHERE id=?`,
                [bomStatus, bomNotes, userId, comment, now, oid]);
            return {
                success: true,
                content: `✅ **工程部评审完成！**\n\n` +
                    `📋 订单 #${oid} · ${order.order_no}\n` +
                    `🔧 ${comment}\n` +
                    `📊 BOM 状态：${bomStatus === 'completed' ? '✅ 已完成' : '⏳ 待补充'}\n` +
                    `📝 BOM 备注：${bomNotes || '无'}\n` +
                    `🔄 下一站：计划部评审\n\n` +
                    `👉 计划部说「计划评审 #${oid} 交期...」继续流程`
            };
        }

        // ---- 计划部评审 ----
        if (action.action === 'review_planning') {
            const oid = resolveOrderId(action);
            if (!oid) return { success: true, content: '❌ 请指定订单编号，如「计划评审 #3 交期6月30日」' };
            const order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            if (!order) return { success: true, content: `❌ 订单 #${oid} 不存在。` };
            if (order.status !== 'pending_planning') {
                return { success: true, content: `⚠️ 订单 #${oid} 当前状态为「${SALES_STATUS_MAP[order.status] || order.status}」，不是待计划评审状态。` };
            }
            const now = new Date().toISOString();
            const newDelivery = action.delivery_date || order.delivery_date || '';
            const comment = action.comment || '计划部评审通过';
            runDb(`UPDATE sales_orders SET status='pending_confirmation', delivery_date=?,
                 reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?`,
                [newDelivery, userId, comment, now, oid]);
            return {
                success: true,
                content: `✅ **计划部评审完成！**\n\n` +
                    `📋 订单 #${oid} · ${order.order_no}\n` +
                    `📋 ${comment}\n` +
                    `📅 确定交期：${newDelivery || order.delivery_date || '未指定'}\n` +
                    `🔄 下一站：业务部确认\n\n` +
                    `👉 业务部说「确认 #${oid}」完成最终确认`
            };
        }

        // ---- 业务部确认 ----
        if (action.action === 'review_business') {
            const oid = resolveOrderId(action);
            if (!oid) return { success: true, content: '❌ 请指定订单编号，如「确认 #3」' };
            const order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            if (!order) return { success: true, content: `❌ 订单 #${oid} 不存在。` };
            if (order.status !== 'pending_confirmation') {
                return { success: true, content: `⚠️ 订单 #${oid} 当前状态为「${SALES_STATUS_MAP[order.status] || order.status}」，不是待确认状态。` };
            }
            const now = new Date().toISOString();
            const comment = action.comment || '业务部确认通过';
            runDb(`UPDATE sales_orders SET status='confirmed',
                 reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?`,
                [userId, comment, now, oid]);
            return {
                success: true,
                content: `✅ **业务部确认完成！订单已生效**\n\n` +
                    `📋 订单 #${oid} · ${order.order_no}\n` +
                    `🏢 ${order.customer_name} · ${order.product_type || ''} × ${order.quantity}${order.unit || 'PCS'}\n` +
                    `💰 金额：¥${(order.amount || 0).toFixed(2)}\n` +
                    `📅 交期：${order.delivery_date || '待确认'}\n` +
                    `💬 ${comment}\n\n` +
                    `🎉 订单完成所有评审！说「安排发货 #${oid}」安排发货`
            };
        }

        // ---- 通用评审（根据订单状态自动判断阶段）----
        if (action.action === 'review') {
            const oid = resolveOrderId(action);
            if (!oid) return { success: true, content: '❌ 请指定订单编号，如「评审 #3」' };
            const order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            if (!order) return { success: true, content: `❌ 订单 #${oid} 不存在。` };
            const now = new Date().toISOString();
            const comment = action.comment || '评审通过';

            if (order.status === 'pending_engineering') {
                const bomStatus = action.bom_status || 'completed';
                const bomNotes = action.bom_notes || '';
                runDb(`UPDATE sales_orders SET status='pending_planning', bom_status=?, bom_notes=?,
                     reviewer_eng_id=?, reviewer_eng_comment=?, reviewer_eng_at=? WHERE id=?`,
                    [bomStatus, bomNotes, userId, comment, now, oid]);
                return {
                    success: true,
                    content: `✅ **工程部评审完成！**\n\n` +
                        `📋 订单 #${oid} · ${order.order_no}\n` +
                        `🔧 ${comment}\n` +
                        `📊 BOM 状态：${bomStatus === 'completed' ? '✅ 已完成' : '⏳ 待补充'}\n` +
                        `🔄 下一站：计划部评审`
                };
            } else if (order.status === 'pending_planning') {
                runDb(`UPDATE sales_orders SET status='pending_confirmation',
                     reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?`,
                    [userId, comment, now, oid]);
                return {
                    success: true,
                    content: `✅ **计划部评审完成！**\n\n` +
                        `📋 订单 #${oid} · ${order.order_no}\n` +
                        `📋 ${comment}\n` +
                        `🔄 下一站：业务部确认\n\n` +
                        `👉 业务部说「确认 #${oid}」完成最终确认`
                };
            } else if (order.status === 'pending_confirmation') {
                runDb(`UPDATE sales_orders SET status='confirmed',
                     reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?`,
                    [userId, comment, now, oid]);
                return {
                    success: true,
                    content: `✅ **业务部确认完成！订单已生效**\n\n` +
                        `📋 订单 #${oid} · ${order.order_no}\n` +
                        `🏢 ${order.customer_name} · ${order.product_type || ''} × ${order.quantity}${order.unit || 'PCS'}\n` +
                        `💰 金额：¥${(order.amount || 0).toFixed(2)}\n` +
                        `💬 ${comment}\n\n` +
                        `🎉 订单完成所有评审！说「安排发货 #${oid}」安排发货`
                };
            } else {
                return { success: true, content: `⚠️ 订单 #${oid} 当前状态为「${SALES_STATUS_MAP[order.status] || order.status}」，无法进行评审。` };
            }
        }

        // ---- 变更订单 ----
        if (action.action === 'change') {
            const oid = resolveOrderId(action);
            if (!oid) return { success: true, content: '❌ 请指定要变更的订单，如「改 #3 订单」' };
            const order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            if (!order) return { success: true, content: `❌ 订单 #${oid} 不存在。` };
            if (order.status === 'shipped' || order.status === 'cancelled') {
                return { success: true, content: `⚠️ 订单 #${oid} 已${order.status === 'shipped' ? '发货' : '取消'}，无法变更。` };
            }
            const changeNotes = action.change_notes || '客户要求变更';
            runDb(`UPDATE sales_orders SET status='draft', change_notes=?, updated_at=datetime('now') WHERE id=?`,
                [changeNotes, oid]);
            return {
                success: true,
                content: `✅ **订单已变更，回到草稿状态**\n\n` +
                    `📋 订单 #${oid} · ${order.order_no}\n` +
                    `💬 变更说明：${changeNotes}\n` +
                    `🔄 状态：${SALES_STATUS_MAP[order.status] || order.status} → 📝 草稿\n\n` +
                    `👉 修改后说「提交评审 #${oid}」重新提交评审`
            };
        }

        // ---- 发货 ----
        if (action.action === 'ship') {
            const oid = resolveOrderId(action);
            if (!oid) return { success: true, content: '❌ 请指定要发货的订单，如「安排发货 #3」' };
            const order = queryDb("SELECT * FROM sales_orders WHERE id = ?", [oid])[0];
            if (!order) return { success: true, content: `❌ 订单 #${oid} 不存在。` };
            if (order.status !== 'confirmed') {
                return { success: true, content: `⚠️ 订单 #${oid} 状态为「${SALES_STATUS_MAP[order.status] || order.status}」，需确认后才能发货。` };
            }
            runDb(`UPDATE sales_orders SET status='shipped', shipped_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, [oid]);
            return {
                success: true,
                content: `🚚 **发货/订单|销售|通知|请示/：订单已发货！**\n\n` +
                    `📋 订单 #${oid} · ${order.order_no}\n` +
                    `🏢 ${order.customer_name}\n` +
                    `📦 ${order.product_type || ''} × ${order.quantity}${order.unit || 'PCS'}\n` +
                    `📅 发货时间：${new Date().toLocaleString('zh-CN')}\n\n` +
                    `🎉 订单流程完成！`
            };
        }

        // ---- 统计 ----
        if (action.action === 'stats') {
            const total = queryDb("SELECT COUNT(*) as c FROM sales_orders")[0].c;
            const draft = queryDb("SELECT COUNT(*) as c FROM sales_orders WHERE status='draft'")[0].c;
            const pendingEng = queryDb("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending_engineering'")[0].c;
            const pendingPlan = queryDb("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending_planning'")[0].c;
            const pendingConfirm = queryDb("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending_confirmation'")[0].c;
            const confirmed = queryDb("SELECT COUNT(*) as c FROM sales_orders WHERE status='confirmed'")[0].c;
            const shipped = queryDb("SELECT COUNT(*) as c FROM sales_orders WHERE status='shipped'")[0].c;
            return {
                success: true,
                content: `📊 **销售订单统计**\n\n` +
                    `📦 总订单数：${total}\n` +
                    `📝 草稿：${draft}\n` +
                    `🔧 待工程评审：${pendingEng}\n` +
                    `📋 待计划评审：${pendingPlan}\n` +
                    `✅ 待业务确认：${pendingConfirm}\n` +
                    `🎯 已确认待发货：${confirmed}\n` +
                    `🚚 已发货：${shipped}\n\n` +
                    `💡 说「我的订单」查看详情`
            };
        }

        // ---- 联络单 ----
        if (action.action === 'contact_form') {
            return await contactFormGuide(context);
        }

        // ---- 预测计划 ----
        if (action.action === 'forecast') {
            return await forecastGuide(context);
        }

        // ---- 交付率统计 ----
        if (action.action === 'delivery_stats') {
            return await deliveryStatsQuery(context);
        }

        // ---- 生产周期 ----
        if (action.action === 'production_cycle') {
            return await productionCycleQuery(context);
        }

        // ---- 急插单（urgent order）----
        if (action.action === 'urgent_order') {
            var chId = userId ? 'change_' + userId : 'change_anon';
            return await startUrgentOrder(chId, message, context);
        }

        // ---- AI 无法识别意图，通用回复 ----
        return {
            success: true,
            content: '📦 **销售订单助手**\n\n' +
                '我可以帮你处理以下操作：\n\n' +
                '📝 **创建订单**：说「下订单」「给华为下100个A产品」\n' +
                '🔍 **查订单**：说「我的订单」「查询订单 #3」\n' +
                '🔧 **提交评审**：说「提交评审 #3」' +
                '🔧 **工程部评审**：说「评审 #3 BOM已完成」\n' +
                '📋 **计划部评审**：说「计划评审 #3 交期6月30日」\n' +
                '✅ **业务部确认**：说「确认 #3」\n' +
                '✏️ **变更订单**：说「改 #3 客户要求提前」\n' +
                '🚚 **安排发货**：说「安排发货 #3」\n' +
                '📊 **统计**：说「订单统计」'
        };

    } catch (err) {
        console.error('[Sales Agent] 操作失败:', err.message);
        return { success: false, content: `❌ 操作失败：${err.message}\n\n请稍后重试或联系管理员。` };
    }
}

// ============================================================
//  Router Agent - 主入口（v6.0 销售订货全流程闭环）
// ============================================================
async function routerAgentProcess(message, context = {}) {
    console.log('[Router] 收到消息:', message.slice(0, 80));
    console.log('[Router] 上下文:', JSON.stringify({ userId: context.userId, userName: context.userName, isAdmin: context.isAdmin }));

    const isFeishu = !!(context.feishuChatId || context.feishuOpenId);
    const convId = context.conversationId || ('user_' + (context.userId || 'anon'));

    // 0a. 销售订单关键词快速匹配（跳过LLM，最快响应）
    // 核心审批指令直接拦截，不走 salesAgentProcess
    var approveMatch2 = message.match(/(同意|审批通过|通过|批准)\s*#(\d+)/i);
    var rejectMatch2 = message.match(/(驳回|拒绝|不同意)\s*#(\d+)/i);
    var submitMatch2 = message.match(/(提交审批|提交审核|送审|发起审批)\s*#(\d+)/i);
    var reviewMatch2 = message.match(/(评审|计划评审|工程评审)\s*#(\d+)/i);
    var confirmMatch2 = message.match(/(确认|业务确认)\s*#(\d+)/i);
    var shipMatch2 = message.match(/(发货|安排发货|出库|发运)\s*#(\d+)/i);
    var changeMatch2 = message.match(/(变更|修改订单|改订单)\s*#(\d+)/i);
    if (approveMatch2 || rejectMatch2 || submitMatch2 || reviewMatch2 || confirmMatch2 || shipMatch2 || changeMatch2) {
        console.log('[Router] 拦截审批指令 -> salesAgent');
        var fastResult = await salesAgentProcess(message, context);
        if (fastResult && fastResult.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', fastResult.content); }
        if (fastResult) return fastResult;
    }
    if (/下订单|创建.*订单|新建.*单|销售订单|下单|生成.*单|下达.*单|查询.*订单|订单查询|订单.*状态|订单列表|我的订单|变更.*订单|订单.*变更|修改.*订单|急插单|评审.*订单|订单.*评审|联络单|预测.*单|交付率|生产周期|订单统计|提交.*评审|提交.*审批/i.test(message)) {
        console.log('[Router] 销售订单请求 -> salesAgent');
        var salesResult = await salesAgentProcess(message, context);
        if (salesResult && salesResult.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', salesResult.content); }
        if (salesResult) return salesResult;
    }

    // 0b. 群发通知关键词快速匹配
    if (/群里|群聊|群发|在群|告诉大家|通知|大家|发个通知|群通知|发到群|在飞书群/.test(message)) {
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
        case 'order_create':
        case 'order_query':
        case 'order_change':
        case 'delivery_create':
        case 'forecast':
        case 'contact_form':
        case 'delivery_stats':
        case 'production_cycle':
        case 'urgent_order':
            var or = await salesAgentProcess(message, context);
            if (or && or.content) { addMessage(convId, 'user', message); addMessage(convId, 'assistant', or.content); }
            return or;

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
            // 快速审批通过 server-sqlite.js 中的 handleFeishuMessage 直接处理
            return { success: true, content: '审批指令已收到，系统正在处理...' };

        default:
            // ===== 关键词兜底路由（LLM 不可用时靠关键词匹配干活）=====
            const msg = message;

            // 数据统计
            if (/统计|待审批|待办|待处理|订单统计|交付率|准时.*交货/.test(msg)) {
                console.log('[Router] 关键词兜底: 统计 -> statsAgent');
                var df4 = await statsAgentProcess(msg, context);
                if (df4 && df4.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df4.content); }
                return df4;
            }

            // 销售订单关键词兜底
            if (/提醒|告诉|发给|推送|通知|报告/.test(msg)) {
                console.log('[Router] 关键词兜底: notify -> notifyAgent');
                var df5 = await notifyAgentProcess(msg, context);
                if (df5 && df5.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', df5.content); }
                return df5;
            }

            // 销售订单全量匹配
            if (/下订单|创建.*订单|新建.*单|销售订单|下单|生成.*单|下达.*单|查询.*订单|订单.*查询|我的订单|订单.*状态|订单列表|变更.*订单|改.*订单|修改.*订单|急插单|评审|发货|出库|安排发货|送审|提交.*评审|确认|联络单|预测|交付率|生产周期|订单统计|库存|有没有货|查.*单|查.*SO/i.test(msg)) {
                console.log('[Router] 关键词兜底: 销售订单 -> salesAgent');
                var dfSo = await salesAgentProcess(msg, context);
                if (dfSo && dfSo.content) { addMessage(convId, 'user', msg); addMessage(convId, 'assistant', dfSo.content); }
                return dfSo;
            }

            // 审批操作
            if (/同意|批准|不同意|驳回|拒绝|通过|否决/.test(msg) && dbHelper) {
                return { success: true, content: '审批指令已收到，系统正在处理...' };
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

      var sys = "你是销售订货系统的智能助手。输出JSON：{\"action\":\"complete\"/\"ask_more\",\"fields\":{\"type\":\"\",\"reason\":\"\",\"startDate\":\"\",\"endDate\":\"\",\"days\":\"\",\"course\":\"\"},\"reply\":\"\"}\n" +
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
  id: "leave", name: "订单专员",
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
      if (dup.length > 0) return {error:"该订单已存在", duplicate:true};

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
  id: "notify", name: "/订单|销售|通知|请示/专员",
  async exec(msg, task, svc) {
    var start = Date.now();
    var s = task.data.structured || {};
    var ctx = task.context || {};
    if (!s.leaveId) return {};
    var txt = "📝 **新请假申请**\n\n👤 " + (ctx.userName||"") + "\n📋 " + (s.type||"") + " · " + (s.days||"") + "天\n📅 " + (s.startDate||"") + " ~ " + (s.endDate||"") + "\n💬 " + (s.reason||"") + "\n🆔 #" + s.leaveId + "\n\n👉 回复\"同意 #" + s.leaveId + "\"审批";
    var admins = svc.query("SELECT id FROM users WHERE role IN ('SALES','ADMIN')");
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
    var title = (ctx.userName||"用户") + "的" + (s.type||"订单") + "记录";
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

module.exports = {
    // 依赖注入
    injectDB,
    injectFeishu,
    injectDBQuery,

    // Router Agent（核心入口）
    classifyIntent,
    routerAgentProcess,
    orderAgentProcess,

    // 各 Agent
    salesAgentProcess,
    statsAgentProcess,
    notifyAgentProcess,

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

