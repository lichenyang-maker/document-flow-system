// ============================================================
//  公文流转 + 请假系统 - 全流程 AI 群聊审批版
//  端口：3000 | 数据库：sql.js (纯JS SQLite)
//  v2.0 - 多智能体系统 + 飞书深度集成
// ============================================================
const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

// ---------- Auth 模块 ----------
let authModule = null;
try {
    authModule = require('./auth-routes');
    console.log('[OK] Auth 模块已加载');
} catch (err) {
    console.error('[WARN] Auth 模块加载失败:', err.message);
}

// ---------- 数据库 Helper ----------
let dbHelper = null;
try {
    const { initDBHelper } = require('./db-helper');
    // dbHelper 在 initDB 后初始化
    console.log('[OK] db-helper 模块已加载');
} catch (err) {
    console.error('[WARN] db-helper 模块加载失败:', err.message);
}

// ---------- AI 多智能体 ----------
let aiAgents = null;
try {
    aiAgents = require('./ai-agents');
    console.log('[OK] 多智能体系统已加载');
} catch (err) {
    console.error('[WARN] 智能体模块加载失败:', err.message);
}

// ---------- 环境配置 ----------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'document_flow.db');
// ⚠️ 生产环境请务必通过环境变量设置，不要将密钥写死在代码中
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aaa152828fb95bda';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'REPLACE_WITH_YOUR_ACTUAL_FEISHU_APP_SECRET';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY || 'sk-ananqfsipxweyiejefqltsbladjogmgnwfvxnihtjtnxwjem';

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS 支持（飞书环境需要）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
    try {
        const userCount = query('SELECT COUNT(*) as c FROM users')[0]?.c || 0;
        const docCount = query('SELECT COUNT(*) as c FROM documents')[0]?.c || 0;
        const leaveCount = query('SELECT COUNT(*) as c FROM leave_requests')[0]?.c || 0;
        res.json({
            status: 'ok',
            time: new Date().toISOString(),
            database: DB_PATH,
            stats: { users: userCount, documents: docCount, leave_requests: leaveCount },
            aiEnabled: !!aiAgents
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/feishu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feishu.html')));

// ---------- 数据库 ----------
let db;

async function initDB() {
    const SQL = await initSqlJs();
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log('[OK] 创建数据目录:', dbDir);
    }
    if (fs.existsSync(DB_PATH)) {
        db = new SQL.Database(fs.readFileSync(DB_PATH));
        console.log('[OK] 数据库已加载:', DB_PATH);
    } else {
        db = new SQL.Database();
        console.log('[OK] 新建数据库');
    }
    db.run('PRAGMA foreign_keys = ON');

    // ------ 表结构初始化 ------
    const tables = [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT DEFAULT '',
            name TEXT NOT NULL,
            role TEXT DEFAULT 'EMPLOYEE',
            department TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT DEFAULT '',
            type TEXT DEFAULT 'NOTICE',
            priority TEXT DEFAULT 'NORMAL',
            status TEXT DEFAULT 'PENDING',
            applicant_id INTEGER,
            approver_id INTEGER,
            approver_comment TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS leave_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT DEFAULT '事假',
            start_date TEXT DEFAULT '',
            end_date TEXT DEFAULT '',
            days REAL DEFAULT 0,
            reason TEXT DEFAULT '',
            status TEXT DEFAULT 'PENDING',
            approver_id INTEGER,
            approver_comment TEXT DEFAULT '',
            feishu_chat_id TEXT DEFAULT '',
            feishu_msg_id TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER,
            approver_id INTEGER,
            action TEXT DEFAULT '',
            comment TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS feishu_user_map (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feishu_open_id TEXT UNIQUE NOT NULL,
            system_user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            channel TEXT DEFAULT '',
            title TEXT DEFAULT '',
            content TEXT DEFAULT '',
            status TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS leave_balance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            year INTEGER NOT NULL,
            annual_days REAL DEFAULT 10,
            used_days REAL DEFAULT 0,
            sick_days REAL DEFAULT 5,
            sick_used REAL DEFAULT 0,
            personal_days REAL DEFAULT 3,
            personal_used REAL DEFAULT 0,
            UNIQUE(user_id, year)
        )`
    ];

    for (const sql of tables) {
        try { db.run(sql); } catch (e) { console.warn('[WARN] 建表失败:', e.message); }
    }

    // ------ 初始数据（如果是空数据库） ------
    const userCount = query('SELECT COUNT(*) as c FROM users')[0].c;
    if (userCount === 0) {
        run("INSERT INTO users (username, password, name, role, department) VALUES (?, ?, ?, ?, ?)",
            ['admin', 'admin123', '管理员', 'ADMIN', '管理部']);
        // 初始化管理员的年假余额
        const year = new Date().getFullYear();
        run(`INSERT INTO leave_balance (user_id, year, annual_days, used_days, sick_days, sick_used, personal_days, personal_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [1, year, 10, 0, 5, 0, 3, 0]);
        console.log('[OK] 初始管理员账号已创建');
    }
}

function saveDB() {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function run(sql, params = []) {
    // sql.js 需要用 prepare + bind + step 来安全执行带参数的 SQL
    if (params && params.length > 0) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        stmt.step();
        stmt.free();
    } else {
        db.run(sql);
    }
    // 注意: 必须在 saveDB() (内部调用 db.export()) 之前获取 last_insert_rowid()
    // db.export() 会重置 last_insert_rowid() 为 0
    let lastId = 0;
    try {
        const lr = db.exec('SELECT last_insert_rowid() as id')[0];
        if (lr && lr.values && lr.values[0]) lastId = lr.values[0][0];
    } catch (e) { lastId = 0; }
    saveDB();
    return { lastID: lastId, changes: db.getRowsModified() };
}

// ---------- 飞书客户端（全局） ----------
let larkClient = null;

// ---------- 飞书用户映射 ----------
function getSystemUserByFeishuId(feishuOpenId) {
    const map = query('SELECT system_user_id FROM feishu_user_map WHERE feishu_open_id = ?', [feishuOpenId]);
    if (map.length > 0) {
        return query('SELECT id, username, name, role FROM users WHERE id = ?', [map[0].system_user_id])[0];
    }
    return null;
}

function getFeishuIdBySystemUser(systemUserId) {
    const map = query('SELECT feishu_open_id FROM feishu_user_map WHERE system_user_id = ?', [systemUserId]);
    if (map.length > 0) return map[0].feishu_open_id;
    return null;
}

// ---------- 发飞书消息（通用，自动根据 receiveId 类型选择）----------
async function _feishuSendRaw(receiveId, receiveType, text) {
    if (!larkClient) {
        console.warn('[飞书] ❌ 客户端未初始化，无法发送消息');
        return { success: false, reason: '飞书客户端未初始化' };
    }
    if (!receiveId) {
        console.warn('[飞书] ❌ 未提供接收 ID，跳过发送');
        return { success: false, reason: '未提供接收者 ID' };
    }
    try {
        const res = await larkClient.im.message.create({
            params: { receive_id_type: receiveType },
            data: {
                receive_id: receiveId,
                content: JSON.stringify({ text }),
                msg_type: 'text'
            }
        });
        const msgId = res?.data?.message_id || res?.message_id || 'ok';
        console.log(`[飞书] ✅ 消息发送成功 [${receiveType}] msg_id=${msgId}`);
        return { success: true, messageId: msgId };
    } catch (err) {
        // 同时打印详细错误信息，便于调试（飞书错误通常带 code/msg）
        const detail = err?.data || err?.response?.data || err?.message || String(err);
        console.error(`[飞书] ❌ 发送消息失败 [${receiveType}=${receiveId.slice(0, 12)}...] err=`, typeof detail === 'object' ? JSON.stringify(detail) : detail);
        return { success: false, reason: typeof detail === 'object' ? (detail.msg || detail.code || detail.message || String(detail)) : String(detail) };
    }
}

// ---------- 发飞书群消息 ----------
async function sendFeishuMsg(chatId, text) {
    if (!larkClient) return false;
    const r = await _feishuSendRaw(chatId, 'chat_id', text);
    return r.success;
}

// ---------- 给指定系统用户发飞书消息（通过 open_id）----------
async function sendFeishuToUser(systemUserId, text) {
    if (!larkClient) return { success: false, reason: '飞书客户端未初始化' };
    const feishuOpenId = getFeishuIdBySystemUser(systemUserId);
    if (!feishuOpenId) {
        console.warn(`[飞书] 用户 #${systemUserId} 未绑定飞书，跳过`);
        return { success: false, reason: '该用户未绑定飞书' };
    }
    return await _feishuSendRaw(feishuOpenId, 'open_id', text);
}

// ---------- 发消息到指定群聊（用于定时任务推送到群里）----------
const FEISHU_GROUP_CHAT_ID = process.env.FEISHU_GROUP_CHAT_ID || 'oc_a30a910385446ce307f8eb5436050ad1';
async function sendFeishuToGroup(text) {
    if (!larkClient) return { success: false, reason: '飞书客户端未初始化' };
    return await _feishuSendRaw(FEISHU_GROUP_CHAT_ID, 'chat_id', text);
}

// ---------- 给所有审批人（ADMIN 角色）发飞书消息 ----------
async function sendFeishuToApprovers(text) {
    if (!larkClient) return { success: false, sent: 0, reason: '飞书客户端未初始化' };
    const admins = query('SELECT id, name FROM users WHERE role = ?', ['ADMIN']);
    if (admins.length === 0) return { success: false, sent: 0, reason: '系统中没有管理员' };

    let sentCount = 0;
    const failedNames = [];
    const openIds = [];

    for (const admin of admins) {
        const feishuOpenId = getFeishuIdBySystemUser(admin.id);
        if (!feishuOpenId) {
            failedNames.push(admin.name + '(未绑定)');
            continue;
        }
        openIds.push({ id: admin.id, name: admin.name, openId: feishuOpenId });
    }

    if (openIds.length === 0) {
        return { success: false, sent: 0, reason: '所有管理员均未绑定飞书: ' + failedNames.join(', ') };
    }

    for (const u of openIds) {
        const r = await _feishuSendRaw(u.openId, 'open_id', text);
        if (r.success) {
            sentCount++;
        } else {
            failedNames.push(u.name + '(' + r.reason + ')');
        }
    }

    console.log(`[飞书] 给审批人通知完成: ${sentCount}/${openIds.length} 成功`);
    return {
        success: sentCount > 0,
        sent: sentCount,
        total: admins.length,
        boundTotal: openIds.length,
        failed: failedNames.length > 0 ? failedNames.join('; ') : ''
    };
}

// ---------- 通过姓名模糊匹配给用户发消息 ----------
async function sendFeishuToUserByName(userName, text) {
    if (!larkClient) return { success: false, reason: '飞书客户端未初始化' };
    if (!userName) return { success: false, reason: '未指定用户名' };
    const users = query('SELECT id, name, username FROM users WHERE name LIKE ? OR username LIKE ?',
        ['%' + userName + '%', '%' + userName + '%']);
    if (users.length === 0) return { success: false, reason: '找不到名为"' + userName + '"的用户' };
    if (users.length > 1) return { success: false, reason: '找到多个匹配用户：' + users.map(function(u) { return u.name; }).join(', ') };

    const user = users[0];
    const feishuOpenId = getFeishuIdBySystemUser(user.id);
    if (!feishuOpenId) return { success: false, reason: '用户 ' + user.name + ' 未绑定飞书' };

    return await _feishuSendRaw(feishuOpenId, 'open_id', text);
}

// ---------- 飞书长连接 / API ----------
let wsClientInstance = null;
let feishuTokenValid = false;
let feishuTokenExpireAt = 0;

async function initLark() {
    try {
        console.log('[飞书] 正在初始化...');
        console.log('[飞书] App ID: ' + FEISHU_APP_ID.slice(0, 8) + '***');
        console.log('[飞书] Secret: ' + FEISHU_APP_SECRET.slice(0, 6) + '***');

        if (!FEISHU_APP_ID || FEISHU_APP_ID.includes('cli-aaa') === false && FEISHU_APP_ID.length < 5) {
            console.warn('[飞书] ⚠️ FEISHU_APP_ID 看起来不正确，请通过环境变量设置正确的 App ID');
        }
        if (!FEISHU_APP_SECRET || FEISHU_APP_SECRET.includes('REPLACE_WITH_YOUR')) {
            console.warn('[飞书] ⚠️ FEISHU_APP_SECRET 未配置（使用占位符），飞书 API 将无法正常工作。请通过环境变量设置真正的 App Secret。');
        }

        const lark = require('@larksuiteoapi/node-sdk');
        larkClient = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

        // 先测试 API 连通性：获取 tenant_access_token
        try {
            const tokenRes = await axios.post(
                'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
                { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
            );
            if (tokenRes.data.code === 0) {
                feishuTokenValid = true;
                feishuTokenExpireAt = Date.now() + (tokenRes.data.expire || 7200) * 1000;
                console.log('[飞书] ✅ Tenant Token 获取成功，凭证有效。飞书消息发送功能已就绪。');
            } else {
                console.error('[飞书] ❌ Tenant Token 获取失败: code=' + tokenRes.data.code + ' msg=' + tokenRes.data.msg);
                console.error('[飞书] 请检查: 1) App ID / App Secret 是否正确 2) 应用是否已发布 3) 网络是否能访问 open.feishu.cn');
                feishuTokenValid = false;
            }
        } catch (err) {
            console.error('[飞书] ❌ 无法连接飞书 API: ' + err.message);
            feishuTokenValid = false;
            return;
        }

        // 长连接：用于接收飞书消息（飞书 → 系统）
        try {
            wsClientInstance = new lark.WSClient({
                appId: FEISHU_APP_ID,
                appSecret: FEISHU_APP_SECRET,
                logger: {
                    info: (...args) => console.log('[飞书WS]', ...args),
                    warn: (...args) => console.warn('[飞书WS]', ...args),
                    error: (...args) => console.error('[飞书WS]', ...args),
                    debug: (...args) => { /* 静默 debug */ }
                }
            });

            wsClientInstance.start({
                eventDispatcher: new lark.EventDispatcher({}).register({
                    'im.message.receive_v1': async (data) => {
                        console.log('[飞书] 📩 收到消息事件 (receive_v1)');
                        await handleFeishuMessage(data);
                    }
                })
            });

            console.log('[OK] 飞书长连接已启动 (WebSocket 模式) - 可接收用户消息并回复');
            console.log('[飞书] 提示：请确保飞书开放平台已开启「使用长连接接收事件」并开通「im:message」「im:message:send_as_bot」权限');
        } catch (wsErr) {
            console.error('[飞书] ⚠️ 长连接启动失败 (仅影响"接收飞书消息并回复"功能，主动发通知仍可用): ' + wsErr.message);
        }
    } catch (err) {
        console.error('[ERROR] 飞书初始化失败:', err.message);
        console.error('[ERROR] 详细:', err.stack);
    }
}

// ============================================================
//  飞书全流程消息处理（v3.0 - 全 AI 驱动）
// ============================================================
async function handleFeishuMessage(data) {
    try {
        const msg = data.message;
        const chatId = msg.chat_id;
        const msgId = msg.message_id;
        const senderId = data.sender?.sender_id?.open_id || data.sender?.id?.open_id || '';
        const chatType = msg.chat_type || 'p2p'; // 'p2p' 或 'group'

        // 解析消息文本（飞书消息 content 是 JSON 字符串）
        let content = '';
        try {
            const parsed = JSON.parse(msg.content);
            content = (parsed.text || '').trim();
        } catch (_e) { content = (msg.content || '').trim(); }

        // 去掉 @机器人 mention（飞书群聊 @ 机器人会带 @_user_1 等格式）
        content = content.replace(/@_user_\d+\s*/g, '').replace(/@_all\s*/g, '').trim();

        // 忽略空消息
        if (!content) return;

        console.log('[飞书] === 收到消息 === chat=' + chatId.slice(0, 10) + '...' +
            ' sender=' + senderId.slice(0, 10) + '...' +
            ' type=' + chatType +
            ' msg="' + content.slice(0, 80) + '"');

        // ========== 优先处理：身份绑定「我是XXX」 ==========
        const bindMatch = content.match(/我是([^\s，,。!！?？]+)/);
        if (bindMatch && !/请假|审批|统计|创建|起草|通知|提醒/.test(content)) {
            const name = bindMatch[1];
            let sysUser = null;
            if (dbHelper) sysUser = dbHelper.getUserByName(name);
            else sysUser = query('SELECT id, name, role FROM users WHERE name = ?', [name])[0];

            if (sysUser) {
                if (dbHelper) {
                    dbHelper.bindFeishuUser(senderId, sysUser.id);
                } else {
                    const existMap = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
                    if (existMap.length > 0) {
                        run('UPDATE feishu_user_map SET system_user_id = ? WHERE feishu_open_id = ?', [sysUser.id, senderId]);
                    } else {
                        run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [senderId, sysUser.id]);
                    }
                }
                console.log('[飞书] 绑定成功: ' + senderId + ' → ' + sysUser.name + ' (' + sysUser.role + ')');
                await sendFeishuMsg(chatId,
                    '✅ 绑定成功！' + sysUser.name + '（' + (sysUser.role === 'ADMIN' ? '管理员' : '员工') + '）\n\n' +
                    '以后直接发消息即可操作：\n' +
                    '📝 请假 → 说「请假3天 年假 6月15到17号」\n' +
                    '📄 写公文 → 说「帮我写一份采购申请」\n' +
                    '📊 查数据 → 说「本周有多少请假」\n' +
                    '🔍 查询 → 说「我的请假记录」\n' +
                    '✅ 审批 → 回复「同意」或「不同意」');
                return;
            } else {
                await sendFeishuMsg(chatId, '❌ 系统中未找到「' + name + '」这个用户。\n请让管理员先在系统里添加你的账号，或核对名字是否正确。');
                return;
            }
        }

        // ========== 确认飞书用户身份 ==========
        let user = null;
        if (dbHelper) user = dbHelper.getUserByFeishuId(senderId);
        else user = getSystemUserByFeishuId(senderId);

        // 自动绑定：如果「我是XXX」中的 XXX 是本地用户
        if (!user && bindMatch) {
            const name = bindMatch[1];
            let sysUser = null;
            if (dbHelper) sysUser = dbHelper.getUserByName(name);
            else sysUser = query('SELECT id, username, name, role FROM users WHERE name = ?', [name])[0];
            if (sysUser) {
                if (dbHelper) dbHelper.bindFeishuUser(senderId, sysUser.id);
                user = sysUser;
                console.log('[飞书] 自动绑定: ' + senderId + ' → ' + user.name);
            }
        }

        // 未绑定身份 → 友好提示绑定
        if (!user) {
            await sendFeishuMsg(chatId,
                '👋 你好！我是公文流转助手。\n\n' +
                '⚠️ 当前还没有绑定你的身份。\n\n' +
                '🔗 请回复：「我是你的名字」\n   例如：「我是张三」\n\n' +
                '已存在的用户：admin(管理员)、张三、李四、王五、赵六、孙七\n\n' +
                '绑定后我就能帮你请假、审批、查数据啦！');
            return;
        }

        console.log('[飞书] 当前身份: ' + user.name + ' (' + user.role + ')');

        // ========== Router Agent 智能路由（全 AI 驱动）==========
        if (aiAgents && dbHelper) {
            try {
                const context = {
                    userId: user.id,
                    userName: user.name,
                    isAdmin: user.role === 'ADMIN',
                    feishuChatId: chatId,
                    feishuMsgId: msgId,
                    feishuOpenId: senderId,
                    conversationId: 'feishu_' + senderId + '_' + chatId
                };

                console.log('[Router] 处理: "' + content.slice(0, 60) + '" by ' + user.name);
                const result = await aiAgents.routerAgentProcess(content, context);

                if (result && typeof result === 'object' && result.content) {
                    await sendFeishuMsg(chatId, String(result.content));
                    return;
                }
            } catch (err) {
                console.error('[Router] 路由处理失败:', err.message);
                await sendFeishuMsg(chatId, '😅 抱歉，处理你的消息时出了点问题，请稍后再试。');
            }
            return;
        }
    } catch (err) {
        console.error('[飞书] 处理失败:', err.message, err.stack);
    }
}

// ============================================================
//  主动提醒：30分钟检查待审批事项
// ============================================================
async function sendApprovalReminder(pendingDocs, pendingLeaves) {
    try {
        const title = '⏰ 待审批事项提醒';
        const time = new Date().toLocaleString('zh-CN');
        let body = `${title}\n\n🕐 ${time}\n\n`;

        if (pendingDocs && pendingDocs.length > 0) {
            body += `📄 待审批公文（${pendingDocs.length}）：\n`;
            for (const doc of pendingDocs) {
                const priorityMap = { HIGH: '🔥', NORMAL: '📋', LOW: '💡' };
                body += `  ${priorityMap[doc.priority] || '📋'} ${doc.title}（申请人：${doc.applicant_name || '未知'}）\n`;
            }
            body += '\n';
        }

        if (pendingLeaves && pendingLeaves.length > 0) {
            body += `🏖️ 待审批请假（${pendingLeaves.length}）：\n`;
            for (const l of pendingLeaves) {
                body += `  📅 ${l.user_name || '未知'} - ${l.type} ${l.start_date}~${l.end_date}（${l.days}天）\n`;
            }
            body += '\n';
        }

        body += '👉 请及时处理！回复「同意」或「不同意」即可审批\n';

        // 同时发给管理员私聊 + 群聊
        const result = await sendFeishuToApprovers(body);
        if (result.success) {
            console.log(`[定时任务] 待审批提醒已发送给 ${result.sent} 位审批人`);
        } else {
            console.warn(`[定时任务] 待审批提醒发送失败: ${result.reason || ''}`);
        }
        // 也发到群里
        try { await sendFeishuToGroup(body); console.log('[定时任务] 待审批提醒已发到群聊'); } catch(e) {}
        return result;
    } catch (err) {
        console.error('[定时任务] 待审批提醒异常:', err.message);
        return { success: false, reason: err.message };
    }
}

function startApprovalChecker() {
    let firstRun = true;
    // 启动时立即检查一次
    const checkOnce = async () => {
        try {
            const pendingDocs = query(
                `SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.status = 'PENDING'`
            );
            const pendingLeaves = query(
                `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING'`
            );
            if (pendingDocs.length > 0 || pendingLeaves.length > 0) {
                console.log(`[定时任务] 发现 ${pendingDocs.length} 份待审批公文, ${pendingLeaves.length} 条待审批请假`);
                await sendApprovalReminder(pendingDocs, pendingLeaves);
            } else {
                console.log('[定时任务] 当前没有待审批事项');
            }
        } catch (e) {
            console.error('[定时任务] 待审批检查失败:', e.message);
        }
    };

    if (firstRun) {
        firstRun = false;
        setTimeout(checkOnce, 5000); // 启动 5 秒后首次检查
    }
    setInterval(checkOnce, 30 * 60 * 1000); // 30分钟
    console.log('[定时任务] 待审批检查已启动（每30分钟）');
}

// ============================================================
//  每日简报推送（每天 9:00）
// ============================================================
async function sendDailyBriefing() {
    try {
        const today = new Date().toLocaleDateString('zh-CN');
        const now = new Date();
        const weekDay = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];

        const userCount = query('SELECT COUNT(*) as c FROM users')[0]?.c || 0;
        const totalDocs = query('SELECT COUNT(*) as c FROM documents')[0]?.c || 0;
        const pendingDocs = query("SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'")[0]?.c || 0;
        const approvedDocs = query("SELECT COUNT(*) as c FROM documents WHERE status = 'APPROVED'")[0]?.c || 0;
        const totalLeaves = query('SELECT COUNT(*) as c FROM leave_requests')[0]?.c || 0;
        const pendingLeaves = query("SELECT COUNT(*) as c FROM leave_requests WHERE status = 'PENDING'")[0]?.c || 0;
        const approvedLeaves = query("SELECT COUNT(*) as c FROM leave_requests WHERE status = 'APPROVED'")[0]?.c || 0;

        const title = `📊 每日工作简报 - ${today} 星期${weekDay}`;
        let body = `${title}\n\n`;
        body += `👥 团队成员：${userCount} 人\n`;
        body += `📄 公文总量：${totalDocs} 份（待审批 ${pendingDocs}，已审批 ${approvedDocs}）\n`;
        body += `🏖️ 请假申请：${totalLeaves} 条（待审批 ${pendingLeaves}，已批准 ${approvedLeaves}）\n\n`;

        if (pendingDocs > 0 || pendingLeaves > 0) {
            body += `⚠️ 今日提醒：\n`;
            if (pendingDocs > 0) {
                body += `  📄 有 ${pendingDocs} 份公文待审批\n`;
            }
            if (pendingLeaves > 0) {
                body += `  🏖️ 有 ${pendingLeaves} 条请假待审批\n`;
            }
            body += `\n👉 请各位领导及时处理！\n`;
        } else {
            body += `✅ 所有事项已处理完毕，团队运转正常！\n`;
        }

        const result = await sendFeishuToApprovers(body);
        if (result.success) {
            console.log(`[定时任务] 每日简报已发送给 ${result.sent} 位审批人`);
        } else {
            console.warn(`[定时任务] 每日简报发送失败: ${result.reason || ''}`);
        }
        // 也发到群聊
        try { await sendFeishuToGroup(body); console.log('[定时任务] 每日简报已发到群聊'); } catch(e) {}
        return result;
    } catch (err) {
        console.error('[定时任务] 每日简报异常:', err.message);
        return { success: false, reason: err.message };
    }
}

function scheduleDailyBriefing() {
    const targetHour = 9;
    const targetMinute = 0;

    const runDaily = async () => {
        try {
            await sendDailyBriefing();
        } catch (e) {
            console.error('[定时任务] 每日简报推送失败:', e.message);
        }
    };

    const scheduleNext = () => {
        const now = new Date();
        const next = new Date(now);
        next.setHours(targetHour, targetMinute, 0, 0);
        if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1);
        }
        const delay = next.getTime() - now.getTime();
        console.log(`[定时任务] 下次每日简报时间：${next.toLocaleString('zh-CN')}（${Math.round(delay / 60000)} 分钟后）`);

        setTimeout(() => {
            runDaily();
            // 触发后，再排下一次（递归），避免 setInterval 漂移
            setInterval(runDaily, 24 * 60 * 60 * 1000);
        }, delay);
    };

    scheduleNext();
    console.log(`[定时任务] 每日简报已安排（每天 ${targetHour}:${targetMinute.toString().padStart(2, '0')}）`);
}

function startScheduledTasks() {
    try {
        startApprovalChecker();
    } catch (e) {
        console.error('[定时任务] 启动待审批检查失败:', e.message);
    }
    try {
        scheduleDailyBriefing();
    } catch (e) {
        console.error('[定时任务] 启动每日简报失败:', e.message);
    }
}

// ---------- Server酱推送 ----------
async function sendWechatNotify(title, content) {
    try {
        const cfg = query('SELECT api_key FROM wechat_config LIMIT 1');
        if (!cfg[0]?.api_key) return;
        await axios.get(`https://sc.ftqq.com/${cfg[0].api_key}.send?text=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`);
    } catch (err) { console.error('[微信] 推送失败:', err.message); }
}

// ---------- 认证 ----------
function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: '未登录' });
    try {
        const parts = Buffer.from(token, 'base64').toString().split(':');
        if (parts.length !== 2) throw new Error();
        req.userId = parseInt(parts[0]);
        req.username = parts[1];
        next();
    } catch { res.status(401).json({ message: '无效凭证' }); }
}

// ============================================================
//  REST API
// ============================================================

app.post('/api/public/login', (req, res) => {
    try {
        const { username, password } = req.body;
        const md5pwd = crypto.createHash('md5').update(password).digest('hex');
        // 优先匹配 MD5 哈希密码
        let users = query('SELECT id, username, name, role, email FROM users WHERE username = ? AND password = ?', [username, md5pwd]);
        if (!users.length) {
            // 兼容旧明文密码（首次登录自动升级）
            users = query('SELECT id, username, name, role, email FROM users WHERE username = ? AND password = ?', [username, password]);
            if (users.length) { run('UPDATE users SET password = ? WHERE id = ?', [md5pwd, users[0].id]); console.log(`[迁移] ${username} 密码已升级`); }
        }
        if (!users.length) return res.status(401).json({ message: '用户名或密码错误' });
        const user = users[0];
        const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
        res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email || null } });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/auth/me', auth, (req, res) => {
    try {
        const users = query('SELECT id, username, name, role, email, phone, avatar, verified, oauth_provider FROM users WHERE id = ?', [req.userId]);
        res.json(users[0] || { message: 'Not found' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/users', auth, (req, res) => {
    try { res.json(query('SELECT id, username, name, role, created_at FROM users ORDER BY id')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});

app.put('/api/users/:id', auth, (req, res) => {
    try {
        const cur = query('SELECT * FROM users WHERE id = ?', [req.userId])[0];
        if (!cur || cur.role !== 'ADMIN') return res.status(403).json({ message: '需要管理员权限' });
        const { role, name } = req.body;
        if (role) run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
        if (name) run('UPDATE users SET name = ? WHERE id = ?', [name, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 飞书用户绑定（API方式）
app.post('/api/feishu/bind', (req, res) => {
    try {
        const { feishuOpenId, systemUserId } = req.body;
        const existMap = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [feishuOpenId]);
        if (existMap.length > 0) {
            run('UPDATE feishu_user_map SET system_user_id = ? WHERE feishu_open_id = ?', [systemUserId, feishuOpenId]);
        } else {
            run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [feishuOpenId, systemUserId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/feishu/config', (req, res) => {
    try {
        res.json({
            appId: FEISHU_APP_ID,
            appEnabled: FEISHU_APP_ID.length > 5
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/feishu/login', async (req, res) => {
    try {
        const { code, feishuOpenId, feishuName } = req.body;

        let openId = feishuOpenId || '';
        let userName = feishuName || '';

        if (code && larkClient) {
            try {
                const accessToken = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
                    app_id: FEISHU_APP_ID,
                    app_secret: FEISHU_APP_SECRET
                });
                const token = accessToken.data?.tenant_access_token;
                if (token) {
                    const userInfo = await axios.post('https://open.feishu.cn/open-apis/authen/v1/access_token',
                        { grant_type: 'authorization_code', code },
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    openId = userInfo.data?.data?.open_id || openId;
                    userName = userInfo.data?.data?.name || userName;
                    console.log('[飞书] 通过 code 获取用户:', openId, userName);
                }
            } catch (err) {
                console.log('[飞书] code 登录失败，尝试直接登录:', err.message);
            }
        }

        if (!openId) {
            return res.status(400).json({ message: '无法获取飞书用户信息' });
        }

        const mapResult = query('SELECT system_user_id FROM feishu_user_map WHERE feishu_open_id = ?', [openId]);
        if (mapResult.length > 0) {
            const sysUser = query('SELECT id, username, name, role FROM users WHERE id = ?', [mapResult[0].system_user_id]);
            if (sysUser.length > 0) {
                const user = sysUser[0];
                const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
                return res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role }, isNew: false });
            }
        }

        const existingUser = query('SELECT id, username, name, role FROM users WHERE name = ?', [userName || openId.slice(-8)]);
        if (existingUser.length > 0) {
            const user = existingUser[0];
            run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [openId, user.id]);
            const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
            return res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role }, isNew: true, autoBound: true });
        }

        const newUsername = 'fs_' + openId.slice(-8).toLowerCase();
        const r = run('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)', [newUsername, newUsername + '_2024', userName || newUsername, 'EMPLOYEE']);
        run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [openId, r.lastID]);
        const token = Buffer.from(`${r.lastID}:${newUsername}`).toString('base64');
        console.log('[飞书] 自动创建用户:', newUsername, userName);
        res.json({ success: true, token, user: { id: r.lastID, username: newUsername, name: userName || newUsername, role: 'EMPLOYEE' }, isNew: true, autoCreated: true });
    } catch (e) {
        console.error('[飞书登录] 错误:', e);
        res.status(500).json({ message: e.message });
    }
});

app.get('/api/feishu/bindings', auth, (req, res) => {
    try {
        res.json(query('SELECT f.feishu_open_id, f.system_user_id, u.name as user_name FROM feishu_user_map f LEFT JOIN users u ON f.system_user_id = u.id'));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 公文
app.get('/api/docs', auth, (req, res) => {
    try {
        const { status, type } = req.query;
        let sql = `SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE 1=1`;
        const p = [];
        if (status) { sql += ' AND d.status = ?'; p.push(status); }
        if (type) { sql += ' AND d.type = ?'; p.push(type); }
        sql += ' ORDER BY d.created_at DESC';
        res.json(query(sql, p));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/docs', auth, (req, res) => {
    try {
        const { title, content, type, priority } = req.body;
        const r = run(`INSERT INTO documents (title, content, type, priority, status, applicant_id) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [title, content, type || 'NORMAL', priority || 'NORMAL', req.userId]);
        res.json({ success: true, id: r.lastID });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/docs/:id/approve', auth, (req, res) => {
    try {
        run(`UPDATE documents SET status = 'APPROVED', updated_at = datetime('now') WHERE id = ?`, [req.params.id]);
        run(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'APPROVE', ?)`, [req.params.id, req.userId, req.body.comment || '']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/docs/:id/reject', auth, (req, res) => {
    try {
        run(`UPDATE documents SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?`, [req.params.id]);
        run(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'REJECT', ?)`, [req.params.id, req.userId, req.body.comment || '']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
//  Notify Agent - 飞书通知 API
// ============================================================

// 获取飞书通知配置（是否可用、用户列表）
app.get('/api/notify/config', auth, (req, res) => {
    try {
        const users = query('SELECT u.id, u.name, u.username, u.role, CASE WHEN m.feishu_open_id IS NOT NULL THEN 1 ELSE 0 END as hasFeishu FROM users u LEFT JOIN feishu_user_map m ON u.id = m.system_user_id');
        res.json({
            success: true,
            feishuReady: !!larkClient,
            users: users
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 给指定用户发飞书消息（通过用户 ID）
app.post('/api/notify/user/:userId', auth, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ success: false, message: '消息内容不能为空' });
        const result = await sendFeishuToUser(req.params.userId, text);
        res.json(result);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 给指定用户发飞书消息（通过姓名）
app.post('/api/notify/byName', auth, async (req, res) => {
    try {
        const { userName, text } = req.body;
        if (!text) return res.status(400).json({ success: false, message: '消息内容不能为空' });
        if (!userName) return res.status(400).json({ success: false, message: '用户名不能为空' });
        const result = await sendFeishuToUserByName(userName, text);
        res.json(result);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 给所有审批人发飞书消息
app.post('/api/notify/approvers', auth, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ success: false, message: '消息内容不能为空' });
        const result = await sendFeishuToApprovers(text);
        res.json(result);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 发送格式化的公文审批通知
app.post('/api/notify/docApproval', auth, async (req, res) => {
    try {
        const { docId, action, comment } = req.body;
        if (!docId || !action) return res.status(400).json({ success: false, message: '参数不全' });

        const doc = query('SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.id = ?', [docId])[0];
        if (!doc) return res.status(404).json({ success: false, message: '公文不存在' });

        const approver = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        const actionText = action === 'APPROVED' ? '✅ 批准' : '❌ 驳回';
        const notifyText = '【公文审批结果】\n\n' + actionText + '\n\n' +
            '📄 标题：' + doc.title + '\n' +
            '📝 类型：' + doc.type + '\n' +
            '👤 申请人：' + (doc.applicant_name || '未知') + '\n' +
            '🔍 审批人：' + (approver?.name || '未知') + '\n' +
            (comment ? '📋 审批意见：' + comment + '\n' : '') +
            '⏰ 时间：' + new Date().toLocaleString('zh-CN');

        // 给申请人发通知
        const userResult = await sendFeishuToUser(doc.applicant_id, notifyText);

        // 记录到通知日志
        try {
            run('INSERT INTO notifications (user_id, channel, title, content, status) VALUES (?, ?, ?, ?, ?)',
                [doc.applicant_id, 'FEISHU', '公文审批结果', notifyText, userResult?.success ? 'SENT' : 'FAILED']);
        } catch (e) { /* 日志表可能不存在，忽略 */ }

        res.json({ success: true, notifiedApplicant: userResult?.success });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 解析自然语言通知请求并发送（Notify Agent 核心功能）
app.post('/api/notify/send', auth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ success: false, message: '消息内容不能为空' });

        // 解析意图：判断是给指定用户、还是给审批人
        const lowerMsg = message.toLowerCase();

        // 检查是否是发送给审批人
        if (/审批人|管理员|领导|主管|经理/.test(message) ||
            (/(通知|提醒|发消息).*(审批|审批人|批)/.test(message))) {
            // 提取消息内容
            let content = message;
            content = content.replace(/通知.*(审批人|管理员|领导|主管|经理)/g, '');
            content = content.replace(/(提醒|通知|给|向).*(审批人|管理员|领导|主管|经理)/g, '');
            content = content.replace(/发消息给.*(审批人|管理员|领导|主管|经理)/g, '');
            content = content.trim();

            if (!content || content.length < 2) content = '【系统提醒】请及时处理待审批事项';

            const result = await sendFeishuToApprovers('📢 通知提醒\n\n' + content + '\n\n—— ' + new Date().toLocaleString('zh-CN'));
            return res.json({
                success: result.success,
                target: '审批人',
                sent: result.sent,
                total: result.total,
                failed: result.failed,
                content: content
            });
        }

        // 尝试匹配：给 XXXX 发消息 / 通知 XXXX
        let targetUser = null;
        let content = message;

        const byNameMatch1 = message.match(/(通知|提醒|发消息给|给|找)\s*([\u4e00-\u9fa5a-zA-Z0-9]{2,10})/);
        const byNameMatch2 = message.match(/([\u4e00-\u9fa5a-zA-Z0-9]{2,10})\s*(通知|提醒|看)/);

        if (byNameMatch1 && byNameMatch1[2]) {
            targetUser = byNameMatch1[2];
            content = message.replace(byNameMatch1[0], '').trim();
        } else if (byNameMatch2 && byNameMatch2[1]) {
            targetUser = byNameMatch2[1];
            content = message.replace(byNameMatch2[0], '').trim();
        }

        if (targetUser && content.length > 0) {
            const result = await sendFeishuToUserByName(targetUser, '📢 通知提醒\n\n' + content + '\n\n—— ' + new Date().toLocaleString('zh-CN'));
            return res.json({
                success: result.success,
                target: result.user || targetUser,
                reason: result.reason,
                content: content
            });
        }

        // 默认：将消息视为群发内容，发给审批人
        const defaultResult = await sendFeishuToApprovers('📢 通知\n\n' + message + '\n\n—— ' + new Date().toLocaleString('zh-CN'));
        res.json({
            success: defaultResult.success,
            target: '审批人',
            sent: defaultResult.sent,
            total: defaultResult.total,
            failed: defaultResult.failed,
            content: message
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 请假
app.get('/api/leave', auth, (req, res) => {
    try {
        const user = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        const uid = user?.role === 'ADMIN' ? null : req.userId;
        let sql = `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE 1=1`;
        const p = [];
        if (uid) { sql += ' AND l.user_id = ?'; p.push(uid); }
        if (req.query.status) { sql += ' AND l.status = ?'; p.push(req.query.status); }
        sql += ' ORDER BY l.created_at DESC';
        res.json(query(sql, p));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/leave', auth, (req, res) => {
    try {
        const { type, startDate, endDate, start_date, end_date, days, reason } = req.body;
        const sDate = startDate || start_date || '';
        const eDate = endDate || end_date || '';
        const r = run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
            [req.userId, type, sDate, eDate, days, reason || '']);
        const user = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        sendWechatNotify('【新请假申请】来自 ' + (user?.name || ''),
            `请假类型：${type}\n时间：${sDate} 至 ${eDate}\n天数：${days}\n事由：${reason || '无'}`);
        res.json({ success: true, id: r.lastID });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/leave/:id/approve', auth, (req, res) => {
    try {
        run(`UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
            [req.userId, req.body.comment || '', req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/leave/:id/reject', auth, (req, res) => {
    try {
        run(`UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
            [req.userId, req.body.comment || '', req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/leave/stats', auth, (req, res) => {
    try {
        const user = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        const uid = user?.role === 'ADMIN' ? null : req.userId;
        const w = uid ? ' WHERE user_id = ?' : '';
        const p = uid ? [uid] : [];
        const total = query('SELECT COUNT(*) as c FROM leave_requests' + w, p)[0].c;
        const pending = query('SELECT COUNT(*) as c FROM leave_requests' + w + (uid ? ' AND' : ' WHERE') + " status = 'PENDING'", p)[0].c;
        const approved = query('SELECT COUNT(*) as c FROM leave_requests' + w + (uid ? ' AND' : ' WHERE') + " status = 'APPROVED'", p)[0].c;
        const rejected = query('SELECT COUNT(*) as c FROM leave_requests' + w + (uid ? ' AND' : ' WHERE') + " status = 'REJECTED'", p)[0].c;
        res.json({ total, pending, approved, rejected });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
//  Stats Agent - 统计智能体（核心查询函数）
// ============================================================

// 获取周范围（ISO 周：周一到周日）
function getWeekRange(date) {
    const d = new Date(date || Date.now());
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    const fmt = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    return { start: fmt(monday), end: fmt(sunday), startDate: monday, endDate: sunday };
}

// 获取月范围
function getMonthRange(date) {
    const d = new Date(date || Date.now());
    const year = d.getFullYear();
    const month = d.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const fmt = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    return { start: fmt(firstDay), end: fmt(lastDay) };
}

// 通用：统计范围内的请假
function countLeavesInRange(userId, startDate, endDate, onlyApproved) {
    let sql = 'SELECT COALESCE(SUM(days), 0) as total_days, COUNT(*) as count FROM leave_requests WHERE 1=1';
    const params = [];
    if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
    if (onlyApproved) { sql += ' AND status = ?'; params.push('APPROVED'); }
    if (startDate) { sql += ' AND (start_date >= ? OR created_at >= ?)'; params.push(startDate, startDate); }
    if (endDate) { sql += ' AND (start_date <= ? OR created_at <= ?)'; params.push(endDate, endDate); }
    const r = query(sql, params);
    return { days: r[0].total_days || 0, count: r[0].count || 0 };
}

// 获取用户的年假余额
function getLeaveBalance(userId) {
    const year = new Date().getFullYear();
    const balance = query('SELECT * FROM leave_balance WHERE user_id = ? AND year = ?', [userId, year]);
    if (balance.length > 0) {
        const b = balance[0];
        return {
            year: year,
            annual: { total: b.annual_days, used: b.used_days, remaining: b.annual_days - b.used_days },
            sick: { total: b.sick_days, used: b.sick_used, remaining: b.sick_days - b.sick_used },
            personal: { total: b.personal_days, used: b.personal_used, remaining: b.personal_days - b.personal_used }
        };
    }
    return {
        year: year,
        annual: { total: 10, used: 0, remaining: 10 },
        sick: { total: 5, used: 0, remaining: 5 },
        personal: { total: 3, used: 0, remaining: 3 }
    };
}

// 获取用户的请假历史
function getMyLeaveHistory(userId, limit) {
    const max = limit || 10;
    return query('SELECT l.*, u.name as approver_name FROM leave_requests l LEFT JOIN users u ON l.approver_id = u.id WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT ?', [userId, max]);
}

// 获取所有请假（管理员视图）
function getAllLeaves(status, limit) {
    const max = limit || 20;
    let sql = 'SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id';
    const params = [];
    if (status && status !== 'all') {
        sql += ' WHERE l.status = ?';
        params.push(status.toUpperCase());
    }
    sql += ' ORDER BY l.created_at DESC LIMIT ?';
    params.push(max);
    return query(sql, params);
}

// 获取公文统计
function getDocStats(userId, role) {
    const isAdmin = role === 'ADMIN';
    let sql = 'SELECT COUNT(*) as c FROM documents';
    const params = [];
    const total = query(sql, params)[0].c;

    const pending = query(`SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'`)[0].c;
    const approved = query(`SELECT COUNT(*) as c FROM documents WHERE status = 'APPROVED'`)[0].c;
    const rejected = query(`SELECT COUNT(*) as c FROM documents WHERE status = 'REJECTED'`)[0].c;

    // 按类型分组
    const byType = query('SELECT type, COUNT(*) as count FROM documents GROUP BY type ORDER BY count DESC');

    // 个人提交的公文
    let mine = 0;
    if (!isAdmin && userId) {
        mine = query('SELECT COUNT(*) as c FROM documents WHERE applicant_id = ?', [userId])[0].c;
    }

    // 紧急程度统计
    const byPriority = query('SELECT priority, COUNT(*) as count FROM documents GROUP BY priority ORDER BY count DESC');

    return { total, pending, approved, rejected, byType, mine, byPriority };
}

// 获取公文列表
function getDocuments(status, limit) {
    const max = limit || 20;
    let sql = 'SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id';
    const params = [];
    if (status && status !== 'all') {
        sql += ' WHERE d.status = ?';
        params.push(status.toUpperCase());
    }
    sql += ' ORDER BY d.created_at DESC LIMIT ?';
    params.push(max);
    return query(sql, params);
}

// 获取系统总览数据
function getSystemOverview() {
    const totalUsers = query('SELECT COUNT(*) as c FROM users')[0].c;
    const totalDocs = query('SELECT COUNT(*) as c FROM documents')[0].c;
    const totalLeave = query('SELECT COUNT(*) as c FROM leave_requests')[0].c;
    const pendingDocs = query(`SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'`)[0].c;
    const pendingLeave = query(`SELECT COUNT(*) as c FROM leave_requests WHERE status = 'PENDING'`)[0].c;
    const admins = query('SELECT id, name, role FROM users WHERE role = ?', ['ADMIN']);
    // 检查 department 列是否存在（使用 try-catch 安全方式）
    let departments = [];
    try {
        departments = query('SELECT department, COUNT(*) as count FROM users WHERE department IS NOT NULL AND department != ? GROUP BY department ORDER BY count DESC', ['']);
        // 过滤掉空值
        departments = departments.filter(d => d.department && d.department.trim() !== '');
    } catch (e) {
        // 忽略 department 列缺失的错误
        departments = [];
    }
    return { totalUsers, totalDocs, totalLeave, pendingDocs, pendingLeave, admins, departments };
}

// 统计
app.get('/api/stats', auth, (req, res) => {
    try {
        const user = query('SELECT role, name FROM users WHERE id = ?', [req.userId])[0];
        const overview = getSystemOverview();
        const week = getWeekRange();
        const month = getMonthRange();
        const weekLeave = countLeavesInRange(null, week.start, week.end, false);
        const monthLeave = countLeavesInRange(null, month.start, month.end, false);

        res.json({
            systemHealth: true,
            totalUsers: overview.totalUsers,
            totalDocs: overview.totalDocs,
            totalLeave: overview.totalLeave,
            pendingDocs: overview.pendingDocs,
            pendingLeave: overview.pendingLeave,
            weekLeave: weekLeave,
            monthLeave: monthLeave,
            admins: overview.admins,
            departments: overview.departments,
            currentUser: user
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
//  Stats Agent - 自然语言查询 API（核心功能）
// ============================================================

// 获取我的年假余额
app.get('/api/stats/balance', auth, (req, res) => {
    try {
        const user = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        const balance = getLeaveBalance(req.userId);
        res.json({ success: true, userName: user?.name, balance });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 获取我的请假历史
app.get('/api/stats/my-leave', auth, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const history = getMyLeaveHistory(req.userId, limit);
        res.json({ success: true, history, total: history.length });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 获取待办统计（待审批）
app.get('/api/stats/pending', auth, (req, res) => {
    try {
        const pendingDocs = query(`SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.status = 'PENDING' ORDER BY d.created_at DESC LIMIT 10`);
        const pendingLeave = query(`SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 10`);
        res.json({
            success: true,
            pendingDocs: { count: pendingDocs.length, items: pendingDocs },
            pendingLeave: { count: pendingLeave.length, items: pendingLeave }
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 核心：自然语言统计查询（Stats Agent 智能体入口）
app.post('/api/stats/query', auth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ success: false, message: '查询内容不能为空' });

        const user = query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];
        if (!user) return res.status(401).json({ success: false, message: '用户不存在' });

        const isAdmin = user.role === 'ADMIN';
        const lowerMsg = message.toLowerCase();
        const text = message;
        const result = { success: true, queryType: 'unknown', data: {}, text: '', message: message, userName: user.name, isAdmin };

        // ------ 解析查询类型 ------
        let queryType = 'overview';
        if (/剩余|还剩|还有多少|年假|余额|假期|可休/.test(text)) queryType = 'balance';
        else if (/我的请假|我请了多少|我的假期|请假记录|我的请假/.test(text)) queryType = 'my-leave';
        else if (/本周|这周|本星期/.test(text)) queryType = 'week-leave';
        else if (/本月|这个月|当月/.test(text)) queryType = 'month-leave';
        else if (/上周|上个星期/.test(text)) queryType = 'lastweek-leave';
        else if (/上月|上个月/.test(text)) queryType = 'lastmonth-leave';
        else if (/待审批|待办|审批一下|待处理/.test(text)) queryType = 'pending';
        else if (/公文|文档|通知|请示|报告/.test(text)) queryType = 'docs';
        else if (/请假|休假/.test(text)) queryType = 'leave-list';
        else if (/总共有|共多少|有多少.*用户|有多少.*人|系统|总览|概览|概览|统计一下/.test(text)) queryType = 'overview';

        result.queryType = queryType;

        // ------ 执行对应查询 ------
        const now = new Date();

        switch (queryType) {
            case 'balance': {
                const balance = getLeaveBalance(user.id);
                result.data.balance = balance;
                result.text = `📅 ${balance.year}年度假期余额\n\n` +
                    `🌴 年假：剩余 ${balance.annual.remaining} 天（共 ${balance.annual.total} 天，已用 ${balance.used} 天）\n` +
                    `🤒 病假：剩余 ${balance.sick.remaining} 天（共 ${balance.sick.total} 天，已用 ${balance.sick.used} 天）\n` +
                    `📋 事假：剩余 ${balance.personal.remaining} 天（共 ${balance.personal.total} 天，已用 ${balance.personal.used} 天）`;
                break;
            }
            case 'my-leave': {
                const history = getMyLeaveHistory(user.id, 10);
                const balance = getLeaveBalance(user.id);
                result.data.history = history;
                result.data.balance = balance;
                if (history.length === 0) {
                    result.text = `📋 ${user.name}的请假记录\n\n暂无请假记录。`;
                } else {
                    let txt = `📋 ${user.name}的请假记录（共 ${history.length} 条）\n\n`;
                    for (const l of history) {
                        const icon = l.status === 'APPROVED' ? '✅' : l.status === 'REJECTED' ? '❌' : '⏳';
                        const statusTxt = l.status === 'APPROVED' ? '已批准' : l.status === 'REJECTED' ? '已驳回' : '待审批';
                        txt += `${icon} #${l.id} ${l.type} · ${l.days}天 (${l.start_date}${l.end_date ? ' ~ ' + l.end_date : ''})\n`;
                        if (l.reason) txt += `   ${l.reason}\n`;
                        txt += `   状态：${statusTxt}\n\n`;
                    }
                    txt += `🌴 当前年假余额：${balance.annual.remaining} 天`;
                    result.text = txt;
                }
                break;
            }
            case 'week-leave': {
                const week = getWeekRange();
                const weekLeave = countLeavesInRange(isAdmin ? null : user.id, week.start, week.end, false);
                const weekLeaveList = isAdmin ?
                    query('SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.start_date >= ? AND l.start_date <= ? ORDER BY l.created_at DESC',
                        [week.start, week.end]) :
                    query('SELECT l.* FROM leave_requests l WHERE l.user_id = ? AND l.start_date >= ? AND l.start_date <= ? ORDER BY l.created_at DESC',
                        [user.id, week.start, week.end]);
                result.data.week = week;
                result.data.weekLeave = weekLeave;
                result.data.items = weekLeaveList;
                let txt = `📅 本周请假统计（${week.start} ~ ${week.end}）\n\n`;
                txt += `📝 请假单：${weekLeave.count} 份\n`;
                txt += `📊 请假天数：${weekLeave.days} 天\n`;
                if (weekLeaveList.length > 0) {
                    txt += `\n`;
                    for (const l of weekLeaveList) {
                        const name = l.user_name || user.name;
                        txt += `  · ${name}：${l.type} ${l.days}天\n`;
                    }
                }
                result.text = txt;
                break;
            }
            case 'month-leave': {
                const month = getMonthRange();
                const monthLeave = countLeavesInRange(isAdmin ? null : user.id, month.start, month.end, false);
                result.data.month = month;
                result.data.monthLeave = monthLeave;
                result.text = `📅 本月请假统计（${month.start} ~ ${month.end}）\n\n` +
                    `📝 请假单：${monthLeave.count} 份\n` +
                    `📊 请假天数：${monthLeave.days} 天`;
                break;
            }
            case 'pending': {
                const pendingDocs = query(`SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.status = 'PENDING' ORDER BY d.created_at DESC LIMIT 10`);
                const pendingLeave = query(`SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 10`);
                result.data.pendingDocs = pendingDocs;
                result.data.pendingLeave = pendingLeave;
                let txt = `📋 待审批事项\n\n`;
                txt += `📄 待审批公文：${pendingDocs.length} 份\n`;
                if (pendingDocs.length > 0) {
                    for (const d of pendingDocs.slice(0, 5)) {
                        txt += `  · #${d.id} ${d.title} (${d.applicant_name || '未知'})\n`;
                    }
                }
                txt += `\n📝 待审批请假：${pendingLeave.length} 份\n`;
                if (pendingLeave.length > 0) {
                    for (const l of pendingLeave.slice(0, 5)) {
                        txt += `  · #${l.id} ${l.user_name || '未知'}：${l.type} ${l.days}天\n`;
                    }
                }
                result.text = txt;
                break;
            }
            case 'docs': {
                const docs = getDocuments(null, 10);
                const byType = query('SELECT type, COUNT(*) as count FROM documents GROUP BY type ORDER BY count DESC');
                result.data.docs = docs;
                result.data.byType = byType;
                let txt = `📄 公文统计\n\n总数：${docs.length} 份\n\n`;
                for (const t of byType) {
                    const typeMap = { NOTICE: '通知', PROPOSAL: '请示', REPORT: '报告', DECISION: '决议', MEMO: '会议纪要' };
                    txt += `  · ${typeMap[t.type] || t.type}：${t.count} 份\n`;
                }
                txt += `\n最近的公文：\n`;
                for (const d of docs.slice(0, 5)) {
                    const icon = d.status === 'APPROVED' ? '✅' : d.status === 'REJECTED' ? '❌' : '⏳';
                    txt += `  ${icon} #${d.id} ${d.title}\n`;
                }
                result.text = txt;
                break;
            }
            case 'leave-list': {
                const status = req.query.status || 'all';
                const leaves = getAllLeaves(status, 20);
                result.data.leaves = leaves;
                let txt = `📝 请假申请\n\n共 ${leaves.length} 份\n\n`;
                for (const l of leaves.slice(0, 10)) {
                    const icon = l.status === 'APPROVED' ? '✅' : l.status === 'REJECTED' ? '❌' : '⏳';
                    const statusTxt = l.status === 'APPROVED' ? '已批准' : l.status === 'REJECTED' ? '已驳回' : '待审批';
                    txt += `${icon} #${l.id} ${l.user_name || '未知'}：${l.type} ${l.days}天 [${statusTxt}]\n`;
                }
                result.text = txt;
                break;
            }
            default: {
                // 系统总览
                const overview = getSystemOverview();
                const week = getWeekRange();
                const weekLeave = countLeavesInRange(isAdmin ? null : user.id, week.start, week.end, false);
                const balance = getLeaveBalance(user.id);
                result.data.overview = overview;
                result.data.balance = balance;
                result.data.weekLeave = weekLeave;
                let txt = `📊 系统数据概览\n\n`;
                txt += `👥 用户总数：${overview.totalUsers} 人\n`;
                txt += `📄 公文总数：${overview.totalDocs} 份\n`;
                txt += `📝 请假申请：${overview.totalLeave} 份\n`;
                txt += `⏳ 待审批公文：${overview.pendingDocs} 份\n`;
                txt += `⏳ 待审批请假：${overview.pendingLeave} 份\n`;
                txt += `📅 本周请假：${weekLeave.count} 份 (${weekLeave.days} 天)\n`;
                txt += `\n`;
                txt += `${user.name}的个人信息：\n`;
                txt += `🌴 剩余年假：${balance.annual.remaining} 天\n`;
                if (overview.admins.length > 0) {
                    txt += `\n👔 管理员：${overview.admins.map(a => a.name).join('、')}`;
                }
                result.text = txt;
            }
        }

        res.json(result);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// 微信 Webhook
app.post('/api/wechat/webhook', express.raw({ type: 'application/xml', limit: '1mb' }), async (req, res) => {
    res.json({ success: true });
});

// 飞书 Webhook
app.post('/api/feishu/webhook', async (req, res) => {
    const body = req.body;
    
    // URL 验证（飞书事件订阅首次配置）
    if (body.type === 'url_verification') {
        return res.json({ challenge: body.challenge });
    }
    
    // 快速响应飞书（20ms 内，否则飞书重试）
    res.json({ success: true });
    
    // 异步处理消息
    try {
        if (body.header?.event_type === 'im.message.receive_v1') {
            const event = body.event || {};
            const msg = event.message || {};
            const sender = event.sender || {};
            
            // 解析消息文本
            let content = '';
            try {
                const parsed = JSON.parse(msg.content);
                content = (parsed.text || '').trim();
            } catch { content = (msg.content || '').trim(); }
            
            console.log(`[飞书Webhook] 收到消息: ${content} (sender=${sender.sender_id?.open_id || '?'})`);
            
            // 构造 handleFeishuMessage 所需的数据格式
            const data = {
                message: {
                    chat_id: msg.chat_id,
                    message_id: msg.message_id,
                    chat_type: msg.chat_type || 'group',
                    content: msg.content
                },
                sender: sender
            };
            await handleFeishuMessage(data);
        }
    } catch (err) {
        console.error('[飞书Webhook] 处理失败:', err.message);
    }
});

// ============================================================
//  AI 多智能体系统 API（v2.0）
// ============================================================

// 获取可用智能体列表
app.get('/api/agents', (req, res) => {
    if (!aiAgents) {
        return res.json({ success: false, agents: [] });
    }
    res.json({ success: true, agents: aiAgents.getAgentsList() });
});

// ============================================================
//  Router Agent API - 核心入口（意图识别 + 自动执行）
// ============================================================
app.post('/api/ai/router', auth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: '缺少 message' });
    if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

    try {
        const user = dbHelper ? dbHelper.getUserById(req.userId) :
            query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];

        const context = {
            userId: req.userId,
            userName: user ? user.name : '用户#' + req.userId,
            isAdmin: user ? user.role === 'ADMIN' : false,
            conversationId: 'web_' + req.userId
        };

        console.log(`[Router API] 用户=${context.userName} 消息="${message.slice(0, 60)}"`);
        const result = await aiAgents.routerAgentProcess(message, context);

        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (err) {
        console.error('[Router API] 错误:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 飞书消息 Router API（供外部系统调用）
app.post('/api/ai/feishu-router', async (req, res) => {
    const { message, openId, chatId, msgId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: '缺少 message' });
    if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

    // 快速响应
    res.json({ success: true, status: 'processing' });

    // 异步处理
    try {
        let user = null;
        if (openId && dbHelper) {
            user = dbHelper.getUserByFeishuId(openId);
        }

        const context = {
            userId: user ? user.id : 1,
            userName: user ? user.name : '飞书用户',
            isAdmin: user ? user.role === 'ADMIN' : false,
            feishuChatId: chatId || '',
            feishuMsgId: msgId || '',
            feishuOpenId: openId || '',
            conversationId: 'feishu_api_' + (openId || 'anon')
        };

        console.log(`[Feishu Router API] 消息="${message.slice(0, 60)}"`);
        const result = await aiAgents.routerAgentProcess(message, context);

        if (result.success && chatId) {
            await sendFeishuMsg(chatId, result.content);
        }
    } catch (err) {
        console.error('[Feishu Router API] 错误:', err.message);
    }
});

// ============================================================
//  Leave Agent API（独立调用）
// ============================================================
app.post('/api/ai/leave', auth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: '缺少 message' });
    if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

    try {
        const user = dbHelper ? dbHelper.getUserById(req.userId) :
            query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];

        const result = await aiAgents.leaveAgentProcess(message, {
            userId: req.userId,
            userName: user ? user.name : '用户#' + req.userId
        });

        res.json(result);
    } catch (err) {
        console.error('[Leave API] 错误:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
//  Document Agent API（独立调用）
// ============================================================
app.post('/api/ai/document', auth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: '缺少 message' });
    if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

    try {
        const user = dbHelper ? dbHelper.getUserById(req.userId) :
            query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];

        const result = await aiAgents.documentAgentProcess(message, {
            userId: req.userId,
            userName: user ? user.name : '用户#' + req.userId
        });

        res.json(result);
    } catch (err) {
        console.error('[Document API] 错误:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
//  Notify Agent API（独立调用）
// ============================================================
app.post('/api/ai/notify', auth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: '缺少 message' });
    if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

    try {
        const result = await aiAgents.notifyAgentProcess(message, {});
        res.json(result);
    } catch (err) {
        console.error('[Notify API] 错误:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 与智能体聊天（支持上下文）
app.post('/api/agents/chat', auth, async (req, res) => {
    const { agentId, message, conversationId } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '智能体系统未启用' });
    }
    if (!agentId || !message) {
        return res.status(400).json({ success: false, error: '缺少 agentId 或 message' });
    }

    const convId = conversationId || ('user_' + req.userId + '_' + agentId);

    // --- 特殊处理：data agent (Stats Agent) 先获取真实数据 ---
    if (agentId === 'data') {
        try {
            // 手动调用统计查询
            const user = query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];
            if (!user) return res.status(401).json({ success: false, error: '用户不存在' });

            const isAdmin = user.role === 'ADMIN';
            const text = message;

            // ---- 解析查询类型 ----
            let queryType = 'overview';
            if (/剩余|还剩|还有多少|年假|余额|假期|可休/.test(text)) queryType = 'balance';
            else if (/我的请假|我请了多少|我的假期|请假记录|我的请假/.test(text)) queryType = 'my-leave';
            else if (/本周|这周|本星期/.test(text)) queryType = 'week-leave';
            else if (/本月|这个月|当月/.test(text)) queryType = 'month-leave';
            else if (/上周|上个星期/.test(text)) queryType = 'lastweek-leave';
            else if (/上月|上个月/.test(text)) queryType = 'lastmonth-leave';
            else if (/待审批|待办|审批一下|待处理/.test(text)) queryType = 'pending';
            else if (/公文|文档|通知|请示|报告/.test(text)) queryType = 'docs';
            else if (/请假|休假/.test(text)) queryType = 'leave-list';
            else if (/总共有|共多少|有多少.*用户|有多少.*人|系统|总览|概览|统计一下/.test(text)) queryType = 'overview';

            // ---- 构造数据上下文 ----
            let dataContext = '';
            const week = getWeekRange();
            const month = getMonthRange();
            const balance = getLeaveBalance(user.id);
            const overview = getSystemOverview();

            switch (queryType) {
                case 'balance': {
                    dataContext = `【当前用户】${user.name}（${user.role}）\n` +
                        `【假期余额 ${balance.year}年】\n` +
                        `- 年假：剩余 ${balance.annual.remaining} 天（共 ${balance.annual.total} 天，已用 ${balance.annual.used} 天）\n` +
                        `- 病假：剩余 ${balance.sick.remaining} 天（共 ${balance.sick.total} 天，已用 ${balance.sick.used} 天）\n` +
                        `- 事假：剩余 ${balance.personal.remaining} 天（共 ${balance.personal.total} 天，已用 ${balance.personal.used} 天）\n`;
                    break;
                }
                case 'my-leave': {
                    const history = getMyLeaveHistory(user.id, 10);
                    dataContext = `【当前用户】${user.name}（${user.role}）\n` +
                        `【我的请假记录】\n` +
                        `- 总数量：${history.length} 条\n`;
                    if (history.length > 0) {
                        for (const l of history.slice(0, 10)) {
                            const statusTxt = l.status === 'APPROVED' ? '已批准' : l.status === 'REJECTED' ? '已驳回' : '待审批';
                            dataContext += `  · #${l.id} ${l.type} ${l.days}天 (${l.start_date}) [${statusTxt}]${l.reason ? ' - ' + l.reason : ''}\n`;
                        }
                    } else {
                        dataContext += `  · 暂无请假记录\n`;
                    }
                    dataContext += `【当前年假余额】${balance.annual.remaining} 天\n`;
                    break;
                }
                case 'week-leave': {
                    const weekLeave = countLeavesInRange(isAdmin ? null : user.id, week.start, week.end, false);
                    const weekLeaveList = isAdmin ?
                        query('SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.start_date >= ? AND l.start_date <= ? ORDER BY l.created_at DESC',
                            [week.start, week.end]) :
                        query('SELECT l.* FROM leave_requests l WHERE l.user_id = ? AND l.start_date >= ? AND l.start_date <= ? ORDER BY l.created_at DESC',
                            [user.id, week.start, week.end]);
                    dataContext = `【本周请假统计】${week.start} ~ ${week.end}\n` +
                        `- 请假单：${weekLeave.count} 份\n` +
                        `- 请假天数：${weekLeave.days} 天\n`;
                    if (weekLeaveList.length > 0) {
                        dataContext += `【详细清单】\n`;
                        for (const l of weekLeaveList) {
                            const name = l.user_name || user.name;
                            dataContext += `  · ${name}：${l.type} ${l.days}天\n`;
                        }
                    }
                    break;
                }
                case 'month-leave': {
                    const monthLeave = countLeavesInRange(isAdmin ? null : user.id, month.start, month.end, false);
                    dataContext = `【本月请假统计】${month.start} ~ ${month.end}\n` +
                        `- 请假单：${monthLeave.count} 份\n` +
                        `- 请假天数：${monthLeave.days} 天\n`;
                    break;
                }
                case 'pending': {
                    const pendingDocs = query(`SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.status = 'PENDING' ORDER BY d.created_at DESC LIMIT 10`);
                    const pendingLeave = query(`SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 10`);
                    dataContext = `【待审批事项】\n` +
                        `- 待审批公文：${pendingDocs.length} 份\n`;
                    if (pendingDocs.length > 0) {
                        for (const d of pendingDocs.slice(0, 5)) {
                            dataContext += `  · #${d.id} ${d.title} (${d.applicant_name || '未知'})\n`;
                        }
                    }
                    dataContext += `- 待审批请假：${pendingLeave.length} 份\n`;
                    if (pendingLeave.length > 0) {
                        for (const l of pendingLeave.slice(0, 5)) {
                            dataContext += `  · #${l.id} ${l.user_name || '未知'}：${l.type} ${l.days}天\n`;
                        }
                    }
                    break;
                }
                case 'docs': {
                    const docs = getDocuments(null, 10);
                    const byType = query('SELECT type, COUNT(*) as count FROM documents GROUP BY type ORDER BY count DESC');
                    const typeMap = { NOTICE: '通知', PROPOSAL: '请示', REPORT: '报告', DECISION: '决议', MEMO: '会议纪要' };
                    dataContext = `【公文统计】\n- 总数：${docs.length} 份\n`;
                    if (byType.length > 0) {
                        for (const t of byType) {
                            dataContext += `  · ${typeMap[t.type] || t.type}：${t.count} 份\n`;
                        }
                    }
                    if (docs.length > 0) {
                        dataContext += `【最近公文】\n`;
                        for (const d of docs.slice(0, 5)) {
                            const statusTxt = d.status === 'APPROVED' ? '✅已批准' : d.status === 'REJECTED' ? '❌已驳回' : '⏳待审批';
                            dataContext += `  · #${d.id} ${d.title} [${statusTxt}]\n`;
                        }
                    }
                    break;
                }
                case 'leave-list': {
                    const leaves = getAllLeaves(null, 20);
                    dataContext = `【请假申请】\n- 总数：${leaves.length} 份\n`;
                    if (leaves.length > 0) {
                        for (const l of leaves.slice(0, 10)) {
                            const statusTxt = l.status === 'APPROVED' ? '✅已批准' : l.status === 'REJECTED' ? '❌已驳回' : '⏳待审批';
                            dataContext += `  · #${l.id} ${l.user_name || '未知'}：${l.type} ${l.days}天 [${statusTxt}]\n`;
                        }
                    }
                    break;
                }
                default: {
                    const weekLeave = countLeavesInRange(isAdmin ? null : user.id, week.start, week.end, false);
                    dataContext = `【系统总览】\n` +
                        `- 用户总数：${overview.totalUsers} 人\n` +
                        `- 公文总数：${overview.totalDocs} 份\n` +
                        `- 请假申请：${overview.totalLeave} 份\n` +
                        `- 待审批公文：${overview.pendingDocs} 份\n` +
                        `- 待审批请假：${overview.pendingLeave} 份\n` +
                        `- 本周请假：${weekLeave.count} 份 (${weekLeave.days} 天)\n` +
                        `【${user.name}的信息】\n` +
                        `- 角色：${user.role}\n` +
                        `- 剩余年假：${balance.annual.remaining} 天\n`;
                    if (overview.admins.length > 0) {
                        dataContext += `【系统管理员】${overview.admins.map(a => a.name).join('、')}\n`;
                    }
                }
            }

            // ---- 构造带数据上下文的提示 ----
            const dataPrompt = `${message}\n\n---\n【系统返回的真实数据】\n${dataContext}\n---\n\n请基于以上真实数据，给用户一个清晰、友好的统计回复。要求：\n1. 用 emoji 和简单的分段让信息更清晰\n2. 只回答用户问的问题，不要额外的冗长内容\n3. 如果数据为空，要友好说明\n4. 不要编造数据，所有数字必须基于上面的【系统返回的真实数据】\n5. 用自然语言表达，不要像机器报告\n\n例如：用户问"我还剩几天年假"，回复应该简洁地告诉用户"还剩 X 天年假，已用 Y 天，共 Z 天。"`;

            // 让 AI 基于数据生成自然语言回复
            const result = await aiAgents.chatWithAgent(agentId, dataPrompt, convId);
            if (result.success) {
                // 附加数据信息，方便前端展示
                result.dataSource = { queryType, balance, overview, userName: user.name };
                res.json(result);
            } else {
                // 即使 AI 失败，也返回原始数据
                res.json({
                    success: true,
                    content: `📊 数据查询结果\n\n${dataContext}\n\n（AI 提示服务暂时不可用，以上为系统原始数据）`,
                    dataSource: { queryType, balance, overview, userName: user.name }
                });
            }
            return;
        } catch (e) {
            console.error('[Stats Agent] 数据查询失败:', e.message);
            // 回退到普通 AI 对话
            const result = await aiAgents.chatWithAgent(agentId, message, convId);
            if (result.success) {
                res.json(result);
            } else {
                res.status(500).json(result);
            }
            return;
        }
    }

    // 普通 agent 直接调用 AI
    const result = await aiAgents.chatWithAgent(agentId, message, convId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// 智能分析（单轮，无上下文，用于审批/数据/文档分析场景）
app.post('/api/agents/analyze', auth, async (req, res) => {
    const { agentId, prompt, context } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '智能体系统未启用' });
    }
    if (!agentId || !prompt) {
        return res.status(400).json({ success: false, error: '缺少 agentId 或 prompt' });
    }

    const result = await aiAgents.analyzeWithAgent(agentId, prompt, context);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// 自动识别意图
app.post('/api/agents/classify', auth, async (req, res) => {
    const { message } = req.body;
    if (!aiAgents) {
        return res.json({ agent: 'general' });
    }
    const result = await aiAgents.classifyIntent(message || '');
    // classifyIntent returns {intent, method, ...} object
    const agent = (result && result.intent) ? result.intent : 'general';
    res.json({ agent, detail: result || {} });
});

// ---------- 多智能体协作系统 API ----------

// 获取协作模式列表
app.get('/api/agents/collaboration/modes', (req, res) => {
    if (!aiAgents) {
        return res.json({ success: false, modes: [] });
    }
    res.json({
        success: true,
        modes: Object.entries(aiAgents.COLLABORATION_STYLES).map(([key, val]) => ({
            id: key,
            name: val.name,
            description: val.desc
        }))
    });
});

// 智能生成协作计划（只规划不执行）
app.post('/api/agents/collaboration/plan', auth, async (req, res) => {
    const { message, context } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '智能体系统未启用' });
    }
    if (!message) {
        return res.status(400).json({ success: false, error: '缺少 message 参数' });
    }
    try {
        const result = await aiAgents.getCollaborationPlanOnly(message, context);
        res.json(result);
    } catch (err) {
        console.error('[Collaboration Plan Error]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 执行多智能体协作（完整流程）
app.post('/api/agents/collaboration/execute', auth, async (req, res) => {
    const { message, mode, agents, context, sessionId } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '智能体系统未启用' });
    }
    if (!message) {
        return res.status(400).json({ success: false, error: '缺少 message 参数' });
    }
    try {
        const result = await aiAgents.collaborateWithAgents(message, {
            mode: mode || 'auto',
            agents: agents || null,
            context: context || '',
            sessionId: sessionId || ('user_' + req.userId + '_collab_' + Date.now())
        });
        res.json(result);
    } catch (err) {
        console.error('[Collaboration Error]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// AI 智能体聊天页面
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// 飞书 AI 聊天页面
app.get('/feishu-chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feishu-chat.html')));

// ============================================================
//  启动
// ============================================================

async function start() {
    const startTime = Date.now();
    console.log('\n========================================');
    console.log('📋 公文流转 + AI 多智能体系统 v2.0');
    console.log('========================================');
    console.log('[启动] 正在初始化数据库...');

    try {
        await initDB();

        // ========== 初始化 dbHelper ==========
        try {
            const { initDBHelper } = require('./db-helper');
            dbHelper = initDBHelper(db, saveDB);
            console.log('[OK] db-helper 已初始化');
        } catch (e) {
            console.error('[WARN] db-helper 初始化失败:', e.message);
        }

        // ========== 注入依赖到 aiAgents ==========
        if (aiAgents) {
            try {
                if (dbHelper) aiAgents.injectDB(dbHelper);
                // 飞书消息发送器
                aiAgents.injectFeishu({
                    sendToUser: async (userId, text) => await sendFeishuToUser(userId, text),
                    sendToApprovers: async (text) => await sendFeishuToApprovers(text),
                    sendToUserByName: async (name, text) => await sendFeishuToUserByName(name, text),
                    sendToChat: async (chatId, text) => await sendFeishuMsg(chatId, text)
                });
                console.log('[OK] AI 智能体依赖已注入');
            } catch (e) {
                console.error('[WARN] AI 依赖注入失败:', e.message);
            }
        }

        // 安全执行 SQL：单条 SQL 失败不影响其他表
        function safeRun(sql, label) {
            try {
                db.run(sql);
                return true;
            } catch (e) {
                console.error(`[WARN] ${label} 失败:`, e.message);
                return false;
            }
        }

        // 建表
        console.log('[启动] 检查数据表结构...');
        const tables = [
            { name: 'users', sql: `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT 'EMPLOYEE', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'documents', sql: `CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, type TEXT DEFAULT 'NORMAL', priority TEXT DEFAULT 'NORMAL', status TEXT DEFAULT 'PENDING', applicant_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME)` },
            { name: 'leave_requests', sql: `CREATE TABLE IF NOT EXISTS leave_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, start_date TEXT, end_date TEXT, days INTEGER, reason TEXT, status TEXT DEFAULT 'PENDING', approver_id INTEGER, approver_comment TEXT, feishu_chat_id TEXT, feishu_msg_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME)` },
            { name: 'approvals', sql: `CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER, approver_id INTEGER, action TEXT, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'wechat_config', sql: `CREATE TABLE IF NOT EXISTS wechat_config (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, api_key TEXT, enabled INTEGER DEFAULT 1)` },
            { name: 'feishu_user_map', sql: `CREATE TABLE IF NOT EXISTS feishu_user_map (id INTEGER PRIMARY KEY AUTOINCREMENT, feishu_open_id TEXT UNIQUE NOT NULL, system_user_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` }
        ];

        let createdCount = 0;
        tables.forEach(t => { if (safeRun(t.sql, t.name)) createdCount++; });
        console.log(`[OK] 数据表检查完成 (${createdCount}/${tables.length})`);

        // 初始化默认数据（仅当 users 表为空时）
        try {
            if (query('SELECT COUNT(*) as c FROM users')[0].c === 0) {
                console.log('[初始化] 正在创建默认数据...');
                function insert(sql, params = []) { try { run(sql, params); } catch (e) {} }
                insert(`INSERT INTO users (username, password, name, role) VALUES ('admin', 'admin123', '管理员', 'ADMIN')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('zhangsan', '123456', '张三', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('lisi', '123456', '李四', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('wangwu', '123456', '王五', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('zhaoliu', '123456', '赵六', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('sunqi', '123456', '孙七', 'EMPLOYEE')`);
                insert(`INSERT INTO wechat_config (provider, api_key, enabled) VALUES ('serverchan', 'SCT359275Tkk3wftrQnVAwazPBPOAWaMIR', 1)`);
                insert(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于2024年度工作计划的通知', '请各部门于本周五前提交年度工作计划草案。', 'NOTICE', 'APPROVED', 'HIGH', 1)`);
                insert(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于员工福利调整的申请', '建议提高员工餐补标准至每日50元。', 'PROPOSAL', 'PENDING', 'NORMAL', 2)`);
                insert(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于办公室搬迁的通知', '市场部将于下周一搬迁至新办公区。', 'NOTICE', 'PENDING', 'LOW', 1)`);
                insert(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (2, '年假', '2024-06-10', '2024-06-12', 3, '计划带家人去旅游', 'APPROVED', 1)`);
                insert(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (3, '病假', '2024-06-05', '2024-06-05', 1, '发烧感冒', 'APPROVED', 1)`);
                insert(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (4, '事假', '2024-06-15', '2024-06-16', 2, '家中装修需要监工', 'PENDING')`);
                console.log('[初始化] 默认数据创建完成');
            }
        } catch (e) {
            console.error('[WARN] 初始化数据失败:', e.message);
        }

        try { saveDB(); } catch (e) { console.error('[WARN] 保存数据库失败:', e.message); }
        try { await initLark(); } catch (e) { /* initLark 已有处理 */ }
        try { startScheduledTasks(); } catch (e) { console.error('[WARN] 启动定时任务失败:', e.message); }

        // 启动后发一条上线通知到飞书群聊
        setTimeout(async () => {
            try {
                await sendFeishuToGroup('🚀 公文流转助手已上线！\n\n' +
                    '👋 大家好，我是智能助手"小流"，以后有什么需要可以随时找我：\n\n' +
                    '📝 请假 → 说「请假3天」\n' +
                    '📄 写公文 → 说「帮我写一份通知」\n' +
                    '📊 查数据 → 说「本周请假统计」\n' +
                    '✅ 审批 → 回复「同意」或「不同意」\n\n' +
                    '⚠️ 新用户请先发送「我是你的名字」绑定身份哦～');
                console.log('[飞书] 上线通知已发到群聊');
            } catch (e) { console.warn('[飞书] 上线通知发送失败:', e.message); }
        }, 3000);

        // 打印初始化统计
        try {
            const userCount = query('SELECT COUNT(*) as c FROM users')[0].c;
            const docCount = query('SELECT COUNT(*) as c FROM documents')[0].c;
            const leaveCount = query('SELECT COUNT(*) as c FROM leave_requests')[0].c;
            console.log(`[OK] 数据统计: 用户 ${userCount} 人 | 公文 ${docCount} 份 | 请假 ${leaveCount} 条`);
        } catch (e) {}

        // 字段迁移：已有数据库添加新列
        const migrations = [
            ['email',         'ALTER TABLE users ADD COLUMN email TEXT'],
            ['phone',         'ALTER TABLE users ADD COLUMN phone TEXT'],
            ['avatar',        'ALTER TABLE users ADD COLUMN avatar TEXT'],
            ['verified',      'ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0'],
            ['oauth_provider','ALTER TABLE users ADD COLUMN oauth_provider TEXT'],
            ['oauth_id',      'ALTER TABLE users ADD COLUMN oauth_id TEXT'],
        ];
        migrations.forEach(([col, sql]) => {
            try { db.run(sql); console.log(`[迁移] users.${col} 已添加`); } catch (e) {}
        });

        // 注册 Auth 路由
        if (authModule) {
            try {
                const { addRoutes } = authModule(db, query, run, crypto);
                addRoutes(app);
            } catch (e) { console.error('[WARN] Auth 路由注册失败:', e.message); }
        }

        app.listen(PORT, '0.0.0.0', () => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`\n========================================================`);
            console.log(`🚀 服务已启动 (耗时 ${elapsed}s)`);
            console.log(`📄 主页面:     http://localhost:${PORT}/`);
            console.log(`🤖 AI助手:     http://localhost:${PORT}/chat`);
            console.log(`🤖 Router API: POST /api/ai/router`);
            console.log(`📝 Leave API:  POST /api/ai/leave`);
            console.log(`📄 Doc API:    POST /api/ai/document`);
            console.log(`📢 Notify API: POST /api/ai/notify`);
            console.log(`💊 健康检查:   http://localhost:${PORT}/health`);
            console.log(`🔐 登录账号:   admin / admin123`);
            console.log(`               zhangsan / 123456`);
            console.log(`========================================================\n`);
        });
    } catch (err) {
        console.error('[ERROR] 启动失败:', err);
        process.exit(1);
    }
}

start();
