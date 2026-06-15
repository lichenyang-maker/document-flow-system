// ============================================================
//  学工请假系统 - 全流程 AI 飞书审批版
//  端口：3000 | 数据库：sql.js (纯JS SQLite)
//  v4.0 - 学工角色 + 全流程AI + 飞书闭环
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
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '61tkmvxLdXZ2Tx0m4AgZFez4CC0xvzjx';

// 启动时检查关键环境变量
if (!FEISHU_APP_ID) console.warn('[WARN] 未设置 FEISHU_APP_ID 环境变量，飞书集成将不可用');
if (!FEISHU_APP_SECRET) console.warn('[WARN] 未设置 FEISHU_APP_SECRET 环境变量，飞书集成将不可用');

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '10mb', charset: 'utf-8' }));

// CORS 支持（飞书环境需要）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 所有 JSON 响应强制 UTF-8 编码（修复中文乱码）
app.use((req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = (body) => {
        if (!res.get('Content-Type')?.includes('charset')) {
            res.set('Content-Type', 'application/json; charset=utf-8');
        }
        return origJson(body);
    };
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
            course TEXT DEFAULT '',
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

    // ------ 数据库迁移 ------
    try { db.run("ALTER TABLE leave_requests ADD COLUMN course TEXT DEFAULT ''"); } catch (e) { /* 已存在 */ }
    try { db.run("ALTER TABLE users ADD COLUMN custom_role TEXT DEFAULT ''"); } catch (e) { /* 已存在 */ }

    // ------ 初始数据（如果是空数据库）------
    const userCount = query('SELECT COUNT(*) as c FROM users')[0].c;
    if (userCount === 0) {
        const year = new Date().getFullYear();
        const md5 = p => crypto.createHash('md5').update(p).digest('hex');
        // 学工系统角色：ADMIN(系统管理员), COUNSELOR(辅导员), TEACHER(老师), STUDENT(学生)
        const initUsers = [
            ['admin', md5('admin123'), '系统管理员', 'ADMIN', '信息中心'],
            ['fudaoyuan', md5('123456'), '李辅导员', 'COUNSELOR', '学生工作部'],
            ['wanglaoshi', md5('123456'), '王老师', 'TEACHER', '计算机系'],
            ['zhanglaoshi', md5('123456'), '张老师', 'TEACHER', '数学系'],
            ['xiaoming', md5('123456'), '小明', 'STUDENT', '计算机系2023级'],
            ['xiaohong', md5('123456'), '小红', 'STUDENT', '数学系2023级'],
            ['xiaogang', md5('123456'), '小刚', 'STUDENT', '计算机系2024级'],
        ];
        for (const [username, password, name, role, dept] of initUsers) {
            run("INSERT INTO users (username, password, name, role, department) VALUES (?, ?, ?, ?, ?)",
                [username, password, name, role, dept]);
        }
        // 给每个人初始化年假余额
        for (let i = 1; i <= initUsers.length; i++) {
            run(`INSERT INTO leave_balance (user_id, year, annual_days, used_days, sick_days, sick_used, personal_days, personal_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [i, year, 10, 0, 5, 0, 3, 0]);
        }
        console.log('[OK] 学工系统初始账号已创建（管理员/辅导员/老师/学生共7人）');
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

// ---------- 飞书用户信息获取（自动识别用）----------
async function fetchFeishuUserName(openId) {
    if (!larkClient || !openId) return null;
    try {
        const res = await larkClient.contact.v3.user.get({
            path: { user_id: openId },
            params: { user_id_type: 'open_id' }
        });
        const userData = res?.data?.user;
        if (userData) {
            // 优先用 name，其次 nick_name
            return userData.name || userData.nick_name || null;
        }
    } catch (e) {
        console.warn('[飞书] 获取用户信息失败:', e.message?.slice(0,80) || String(e).slice(0,80));
    }
    return null;
}

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

// ---------- 跨平台对话同步 ----------
function saveConversation(userId, source, role, content, agent, feishuChatId) {
    try {
        run("INSERT INTO conversations (user_id, source, role, content, agent, feishu_chat_id) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, source, role, content, agent || '', feishuChatId || '']);
        run("DELETE FROM conversations WHERE user_id = ? AND id NOT IN (SELECT id FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 100)", [userId, userId]);
    } catch (e) {
        console.error('[对话] 保存失败:', e.message);
    }
}

async function sendToFeishuIfBound(userId, text) {
    const feishuOpenId = getFeishuIdBySystemUser(userId);
    if (feishuOpenId && larkClient) {
        try {
            const r = await _feishuSendRaw(feishuOpenId, 'open_id', text);
            if (r.success) {
                console.log('[同步] 已发送到飞书 user_id=' + userId);
                saveConversation(userId, 'feishu', 'assistant', text, '', '');
                return true;
            }
        } catch (e) {
            console.warn('[同步] 飞书发送失败:', e.message);
        }
    }
    return false;
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

// ---------- 发飞书交互卡片（教师审批专用）----------
async function sendFeishuCard(receiveId, receiveType, cardContent) {
    if (!larkClient) return { success: false, reason: '飞书客户端未初始化' };
    if (!receiveId) return { success: false, reason: '未提供接收者 ID' };
    try {
        const res = await larkClient.im.message.create({
            params: { receive_id_type: receiveType },
            data: { receive_id: receiveId, content: JSON.stringify(cardContent), msg_type: 'interactive' }
        });
        const msgId = res?.data?.message_id || res?.message_id || 'ok';
        console.log('[飞书] 卡片发送成功 [' + receiveType + '] msg_id=' + msgId);
        return { success: true, messageId: msgId };
    } catch (err) {
        const detail = err?.data || err?.response?.data || err?.message || String(err);
        console.error('[飞书] 卡片发送失败 [' + receiveType + '] err=', typeof detail === 'object' ? JSON.stringify(detail) : detail);
        return { success: false, reason: typeof detail === 'object' ? (detail.msg || detail.code || detail.message || String(detail)) : String(detail) };
    }
}

function buildLeaveApprovalCard(leave, applicant) {
    var emoji = { '\u5e74\u5047': '\ud83c\udf34', '\u4e8b\u5047': '\ud83d\udccb', '\u75c5\u5047': '\ud83e\udd12', '\u5a5a\u5047': '\ud83d\udc91', '\u4ea7\u5047': '\ud83d\udc76', '\u4e27\u5047': '\ud83d\udd6f\ufe0f' };
    var typeEmoji = emoji[leave.type] || '\ud83d\udcdd';
    var courseLine = leave.course ? '\n**\ud83d\udcda \u6d89\u53ca\u8bfe\u7a0b**\uff1a' + leave.course : '';
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '\ud83d\udccb \u8bf7\u5047\u5ba1\u6279\u7533\u8bf7' }, template: 'blue' },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\ud83d\udc64 \u7533\u8bf7\u4eba**\uff1a' + (applicant?.name || '\u672a\u77e5') + '\uff08' + (applicant?.department || '') + '\uff09\n' +
                '**' + typeEmoji + ' \u7c7b\u578b**\uff1a' + leave.type + ' \u00b7 ' + leave.days + '\u5929\n' +
                '**\ud83d\udcc5 \u65f6\u95f4**\uff1a' + leave.start_date + ' ~ ' + leave.end_date + '\n' +
                '**\ud83d\udcac \u4e8b\u7531**\uff1a' + (leave.reason || '\u65e0') + '\n' +
                '**\ud83d\udd19 \u7f16\u53f7**\uff1a#' + leave.id + courseLine
            } },
            { tag: 'hr' },
            { tag: 'action', actions: [
                { tag: 'button', text: { tag: 'plain_text', content: '\u2705 \u540c\u610f\u5e76\u6279\u5047' }, value: { action: 'approve_leave', leave_id: leave.id }, type: 'primary' },
                { tag: 'button', text: { tag: 'plain_text', content: '\u274c \u62d2\u7edd' }, value: { action: 'reject_leave', leave_id: leave.id }, type: 'danger' }
            ] },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '\u70b9\u51fb\u6309\u94ae\u5373\u53ef\u5ba1\u6279\uff0c\u4e5f\u53ef\u56de\u590d\u300c\u540c\u610f #' + leave.id + '\u300d\u6216\u300c\u4e0d\u540c\u610f #' + leave.id + '\u300d' }] }
        ]
    };
}

function buildLeaveResultCard(leave, result, approverName, comment) {
    var isApproved = result === 'APPROVED';
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: (isApproved ? '\u2705 \u8bf7\u5047\u5df2\u6279\u51c6' : '\u274c \u8bf7\u5047\u672a\u901a\u8fc7') }, template: isApproved ? 'green' : 'red' },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\ud83d\udccb \u7c7b\u578b**\uff1a' + leave.type + ' \u00b7 ' + leave.days + '\u5929\n' +
                '**\ud83d\udcc5 \u65f6\u95f4**\uff1a' + leave.start_date + ' ~ ' + leave.end_date + '\n' +
                '**\ud83d\udc64 \u5ba1\u6279\u4eba**\uff1a' + approverName + '\n' +
                '**\ud83d\udcac \u5ba1\u6279\u610f\u89c1**\uff1a' + (comment || (isApproved ? '\u5df2\u6279\u51c6' : '\u4e0d\u4e88\u6279\u51c6'))
            } },
            { tag: 'note', elements: [{ tag: 'plain_text', content: isApproved ? '\ud83c\udf89 \u5047\u671f\u6109\u5feb\uff01' : '\u5982\u6709\u7591\u95ee\u8bf7\u8054\u7cfb\u5ba1\u6279\u4eba' }] }
        ]
    };
}

// ---------- 给系统用户发飞书审批卡片 ----------
async function sendCardToUser(systemUserId, cardContent) {
    var feishuOpenId = getFeishuIdBySystemUser(systemUserId);
    if (!feishuOpenId) return { success: false, reason: '\u8be5\u7528\u6237\u672a\u7ed1\u5b9a\u98de\u4e66' };
    return await sendFeishuCard(feishuOpenId, 'open_id', cardContent);
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

// ---------- 给所有审批人（ADMIN/COUNSELOR/TEACHER）发飞书消息 ----------
async function sendFeishuToApprovers(text) {
    if (!larkClient) return { success: false, sent: 0, reason: '飞书客户端未初始化' };
    const admins = query('SELECT id, name, role FROM users WHERE role IN (?, ?, ?)', ['ADMIN', 'COUNSELOR', 'TEACHER']);
    if (admins.length === 0) return { success: false, sent: 0, reason: '系统中没有审批人（管理员/辅导员/老师）' };

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
        return { success: false, sent: 0, reason: '所有审批人均未绑定飞书: ' + failedNames.join(', ') };
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
// 消息去重：避免WS和Webhook双通道重复处理
var processedMsgIds = processedMsgIds || new Set();

async function handleFeishuMessage(data) {
    try {
        const msg = data.message;
        const chatId = msg.chat_id;
        const msgId = msg.message_id;
        // **去重：同一msg_id 5秒内不处理两次**
        if (msgId) {
            if (processedMsgIds.has(msgId)) {
                console.log('[飞书] ⏭️ 跳过重复消息 msgId=' + msgId.slice(0, 16));
                return;
            }
            processedMsgIds.add(msgId);
            setTimeout(function() { processedMsgIds.delete(msgId); }, 5000);
        }

        const senderId = data.sender?.sender_id?.open_id || data.sender?.id?.open_id || '';
        const chatType = msg.chat_type || 'p2p';

        // 解析消息
        var messageType = msg.message_type || 'text';
        let content = '';
        try {
            var parsed = JSON.parse(msg.content);
            content = (parsed.text || '').trim();
        } catch (_e) { content = (msg.content || '').trim(); }

        // ===== 文件消息处理（飞书传文件）=====
        if (messageType === 'file' || messageType === 'media' || msg.file_key) {
            try {
                var fileKey = msg.file_key || (parsed && parsed.file_key) || '';
                var fileName = (parsed && parsed.file_name) || '未命名文件';
                var fileSize = (parsed && parsed.file_size) || 0;
                console.log('[飞书] 📎 收到文件: ' + fileName + ' (' + fileSize + ' bytes) key=' + fileKey);

                if (fileKey && larkClient) {
                    var downloadResult = await downloadFeishuFile(fileKey);
                    if (downloadResult && downloadResult.content) {
                        var fileText = downloadResult.content;
                        var newId = createDocumentFromText(fileText, fileName, senderId);
                        if (newId) {
                            await sendFeishuMsg(chatId,
                                '📄 **公文上传成功**\n\n' +
                                '📎 文件：' + fileName + '\n' +
                                '📝 内容摘要：' + fileText.substring(0, 100).replace(/\n/g, ' ') + '...\n' +
                                '🆔 文档编号：#' + newId + '\n\n' +
                                '👉 可使用「查看公文」查看详情，或直接让AI处理');
                            console.log('[飞书] 文件已转为公文 #' + newId);
                        }
                    } else {
                        await sendFeishuMsg(chatId, '⚠️ 文件下载失败，请确认文件类型（支持 .txt / .md 文本文件）');
                    }
                }
            } catch (fileErr) {
                console.error('[飞书] 文件处理失败:', fileErr.message);
                try { await sendFeishuMsg(chatId, '⚠️ 文件处理失败: ' + fileErr.message); } catch(e) {}
            }
            return;
        }

        // 去掉 @机器人 mention
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
                const roleNames = { ADMIN: '系统管理员', COUNSELOR: '辅导员', TEACHER: '老师', STUDENT: '学生', EMPLOYEE: '员工' };
                const roleName = roleNames[sysUser.role] || sysUser.role;
                console.log('[飞书] 绑定成功: ' + senderId + ' → ' + sysUser.name + ' (' + sysUser.role + ')');

                let tipsMsg = '✅ 绑定成功！' + sysUser.name + '（' + roleName + '）\n\n以后直接发消息即可操作：\n';
                if (sysUser.role === 'STUDENT') {
                    tipsMsg += '📝 请假 → 说「我要请假3天回家」\n' +
                        '🔍 查询 → 说「我的请假记录」\n' +
                        '📊 余额 → 说「我还有多少天年假」';
                } else if (['COUNSELOR', 'TEACHER', 'ADMIN'].includes(sysUser.role)) {
                    tipsMsg += '✅ 审批 → 回复「同意 #编号」或「不同意」\n' +
                        '📊 查看 → 说「待审批事项」或「本周统计」\n' +
                        '📢 通知 → 说「提醒学生XX」';
                }
                await sendFeishuMsg(chatId, tipsMsg);
                return;
            } else {
                await sendFeishuMsg(chatId, '❌ 系统中未找到「' + name + '」这个用户。\n请让管理员先在系统里添加你的账号，或核对名字是否正确。');
                return;
            }
        }

        // 解除绑定：「我不是XXX」
        const unbindMatch = content.match(/我不是([^\s，,。!！?？]+)/);
        if (unbindMatch) {
            if (dbHelper) dbHelper.unbindFeishuUser(senderId);
            else run('DELETE FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
            await sendFeishuMsg(chatId, '🔓 已解除飞书身份绑定。\n\n下次发消息时会自动尝试识别你的身份，也可以说「我是你的名字」来重新绑定。');
            console.log('[飞书] 解除绑定: ' + senderId);
            return;
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

        // 未绑定身份 → 尝试自动检测飞书昵称匹配
        if (!user) {
            // 尝试通过飞书 API 获取用户信息自动匹配
            try {
                const feishuName = await fetchFeishuUserName(senderId);
                if (feishuName) {
                    const sysUser = query('SELECT id, username, name, role FROM users WHERE name = ?', [feishuName])[0];
                    if (sysUser) {
                        if (dbHelper) dbHelper.bindFeishuUser(senderId, sysUser.id);
                        else {
                            const em = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
                            if (em.length > 0) run('UPDATE feishu_user_map SET system_user_id = ? WHERE feishu_open_id = ?', [sysUser.id, senderId]);
                            else run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [senderId, sysUser.id]);
                        }
                        user = sysUser;
                        const roleLabel = {ADMIN:'👑管理员',COUNSELOR:'🎓辅导员',TEACHER:'👨‍🏫老师',STUDENT:'🧑‍🎓学生',EMPLOYEE:'💼员工'}[user.role]||user.role;
                        const isManager = ['ADMIN','COUNSELOR','TEACHER'].includes(user.role);
                        console.log('[飞书] 🎯 自动识别: open_id=' + senderId.slice(0,12) + ' → ' + user.name + ' (' + user.role + ') ' + (isManager?'管理者':'成员'));
                        await sendFeishuMsg(chatId, `🎯 已自动识别你的身份：${user.name}（${roleLabel}）

` +
                            (isManager ? '你拥有审批权限，可以直接审批请假和公文！' : '你有问题随时找我请假或查数据～') +
                            `\n\n💡 如身份不对，请回复「我不是${user.name}」`);
                    }
                }
            } catch (e) {
                console.warn('[飞书] 自动识别失败:', e.message);
            }
        }

        if (!user) {
            const allUsers = query('SELECT name, role FROM users LIMIT 10');
            const userList = allUsers.map(u => u.name + '(' + ({ADMIN:'管理员',COUNSELOR:'辅导员',TEACHER:'老师',STUDENT:'学生',EMPLOYEE:'员工'}[u.role]||u.role) + ')').join('、');
            await sendFeishuMsg(chatId,
                '👋 你好！我是学工请假助手。\n\n' +
                '⚠️ 当前还没有绑定你的身份。\n\n' +
                '🔗 请回复：「我是你的名字」\n   例如：「我是小明」\n\n' +
                '系统中已有用户：' + userList + '\n\n' +
                '绑定后我就能帮你请假、审批、查数据啦！');
            return;
        }

        console.log('[飞书] 当前身份: ' + user.name + ' (' + user.role + ')');

        // ========== Router Agent 智能路由（v4.0 全 AI 驱动 + 学工角色）==========
        if (aiAgents && dbHelper) {
            try {
                const context = {
                    userId: user.id,
                    userName: user.name,
                    userRole: user.role,
                    isAdmin: (user.role === 'ADMIN' || user.role === 'COUNSELOR'),
                    feishuChatId: chatId,
                    feishuMsgId: msgId,
                    feishuOpenId: senderId,
                    conversationId: 'feishu_' + senderId + '_' + chatId
                };

                // 保存飞书用户消息到对话记录（供网页端查看）
                if (user && user.id) {
                    saveConversation(user.id, 'feishu', 'user', content, '', chatId);
                }

                console.log('[Router] 处理: "' + content.slice(0, 60) + '" by ' + user.name + ' (' + user.role + ')');
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

        // ========== 兜底处理：AI 不可用时回复 ==========
        if (!aiAgents || !dbHelper) {
            console.log('[飞书] AI 或数据库未准备就绪，发送兜底回复');
            try {
                await sendFeishuMsg(chatId,
                    '👋 你好！我是学工请假助手小流。\n\n' +
                    '当前 AI 系统正在初始化或维护中，暂时无法智能回答。\n' +
                    '你可以尝试以下功能：\n' +
                    '📝 说「我要请假X天」提交请假\n' +
                    '✅ 说「同意 #编号」审批请假\n' +
                    '📊 说「待审批事项」查看待办\n\n' +
                    '🔧 如果问题持续，请联系管理员检查 AI 服务状态。');
            } catch (e) {
                console.error('[飞书] 兜底回复发送失败:', e.message);
            }
            return;
        }
    } catch (err) {
        console.error('[飞书] 处理失败:', err.message, err.stack);
    }
}

// ---------- 飞书文件下载（用于处理飞书传的公文文件）----------
async function downloadFeishuFile(fileKey) {
    if (!larkClient) return null;
    try {
        var tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
            { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        var token = tokenRes.data?.tenant_access_token;
        if (!token) { console.error('[飞书下载] 获取token失败'); return null; }
        var fileRes = await axios.get('https://open.feishu.cn/open-apis/im/v1/messages/' + fileKey + '/download', {
            headers: { Authorization: 'Bearer ' + token },
            timeout: 30000,
            responseType: 'arraybuffer'
        });
        var fileContent = Buffer.from(fileRes.data).toString('utf8');
        if (fileContent && fileContent.length > 10) {
            console.log('[飞书下载] 文件下载成功, 大小=' + fileContent.length + ' 字符');
            return { success: true, content: fileContent };
        }
        return null;
    } catch (err) {
        console.error('[飞书下载] 失败:', err.message);
        return null;
    }
}

// ---------- 从文件内容创建公文记录 ----------
function createDocumentFromText(text, fileName, feishuOpenId) {
    if (!text || text.length < 5) return null;
    try {
        var lines = text.split('\n').filter(function(l) { return l.trim(); });
        var title = fileName.replace(/\.(txt|md|doc|docx)$/i, '') || '文件_' + Date.now();
        if (lines.length > 0 && lines[0].length < 50) {
            title = lines[0].replace(/^#+\s*|^\*\*|\*\*$/g, '').trim() || title;
        }
        var type = 'NORMAL';
        if (/通知|通告|公告/.test(text)) type = 'NOTICE';
        else if (/请示|申请|报告/.test(text)) type = 'REQUEST';
        else if (/纪要|记录/.test(text)) type = 'MINUTES';
        else if (/制度|规定|办法/.test(text)) type = 'POLICY';
        var userId = null;
        if (feishuOpenId) {
            var mapped = query('SELECT system_user_id FROM feishu_user_map WHERE feishu_open_id = ?', [feishuOpenId]);
            if (mapped.length > 0) userId = mapped[0].system_user_id;
        }
        if (!userId) {
            var admin = query('SELECT id FROM users WHERE role = ? LIMIT 1', ['ADMIN']);
            if (admin.length > 0) userId = admin[0].id;
        }
        if (!userId) userId = 1;
        var r = run(
            "INSERT INTO documents (title, content, type, status, applicant_id, created_at) VALUES (?, ?, ?, 'PENDING', ?, datetime('now'))",
            [title, text, type, userId]
        );
        console.log('[公文] 从文件创建公文 #' + r.lastID + ': ' + title + ' (' + type + ')');
        return r.lastID;
    } catch (err) {
        console.error('[公文] 创建失败:', err.message);
        return null;
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

// ---------- 通知推送（已移除微信 - 仅保留飞书） ----------


// ---------- 认证 ----------
function auth(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ message: '未登录' });
    const token = header.slice(7);
    try {
        const [b64, sig] = token.split('.');
        if (b64 && sig) {
            const h = crypto.createHmac('sha256', 'docflow-secret-2024').update(b64).digest('base64url');
            if (h !== sig) throw new Error('invalid sig');
            const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
            req.userId = payload.id;
            req.userRole = payload.role;
            return next();
        }
        // 兼容 base64(id:username) 格式
        var dec = Buffer.from(token, 'base64').toString();
        var uid = parseInt(dec.split(':')[0]);
        if (!uid) throw new Error('invalid token');
        var userRow = query('SELECT id, role FROM users WHERE id = ?', [uid])[0];
        if (!userRow) throw new Error('user not found');
        req.userId = userRow.id;
        req.userRole = userRow.role;
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

app.post('/api/auth/change-password', auth, (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) return res.json({ success: false, message: '参数不完整' });
        if (newPassword.length < 6) return res.json({ success: false, message: '新密码至少6位' });
        const user = query('SELECT * FROM users WHERE id = ?', [req.userId])[0];
        if (!user) return res.json({ success: false, message: '用户不存在' });
        // Support both MD5 and plaintext
        const crypto = require('crypto');
        const oldMd5 = crypto.createHash('md5').update(oldPassword).digest('hex');
        if (user.password !== oldPassword && user.password !== oldMd5) {
            return res.json({ success: false, message: '当前密码不正确' });
        }
        const newMd5 = crypto.createHash('md5').update(newPassword).digest('hex');
        run('UPDATE users SET password = ? WHERE id = ?', [newMd5, req.userId]);
        res.json({ success: true, message: '密码修改成功' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/users', auth, (req, res) => {
    try { res.json(query('SELECT id, username, name, role, created_at FROM users ORDER BY id')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});

app.put('/api/users/:id', auth, (req, res) => {
    try {
        const cur = query('SELECT * FROM users WHERE id = ?', [req.userId])[0];
        if (!cur || cur.role !== 'ADMIN') return res.status(403).json({ message: '需要管理员权限' });
        const { role, name, custom_role } = req.body;
        if (role) run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
        if (name) run('UPDATE users SET name = ? WHERE id = ?', [name, req.params.id]);
        if (custom_role !== undefined) run('UPDATE users SET custom_role = ? WHERE id = ?', [custom_role, req.params.id]);
        res.json({ success: true });
// 创建用户（管理员）
app.post('/api/users', auth, (req, res) => {
    try {
        var cur = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        if (!cur || cur.role !== 'ADMIN') return res.status(403).json({ message: '需要管理员权限' });
        var body = req.body;
        if (!body.username || !body.password || !body.name || !body.role) return res.status(400).json({ message: '缺少必填字段(用户名/密码/姓名/角色)' });
        var md5 = function(p) { return require('crypto').createHash('md5').update(p).digest('hex'); };
        var pwd = md5(body.password);
        var existing = query('SELECT id FROM users WHERE username = ?', [body.username]);
        if (existing.length > 0) return res.status(400).json({ message: '用户名已存在' });
        var r = run('INSERT INTO users (username, password, name, role, department) VALUES (?, ?, ?, ?, ?)',
            [body.username, pwd, body.name, body.role, body.department || '']);
        console.log('[用户] 管理员创建用户: ' + body.username + ' (' + body.role + ')');
        res.json({ success: true, id: r.lastID });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 删除用户（管理员）
app.delete('/api/users/:id', auth, (req, res) => {
    try {
        var cur = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        if (!cur || cur.role !== 'ADMIN') return res.status(403).json({ message: '需要管理员权限' });
        var targetId = parseInt(req.params.id);
        if (targetId === req.userId) return res.status(400).json({ message: '不能删除自己' });
        run('DELETE FROM leave_requests WHERE user_id = ?', [targetId]);
        run('DELETE FROM leave_balance WHERE user_id = ?', [targetId]);
        run('DELETE FROM feishu_user_map WHERE system_user_id = ?', [targetId]);
        run('DELETE FROM users WHERE id = ?', [targetId]);
        console.log('[用户] 管理员删除用户 #' + targetId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 获取所有角色枚举
app.get('/api/roles', auth, (req, res) => {
    try {
        res.json({
            success: true,
            roles: [
                { value: 'ADMIN', label: '管理员', desc: '系统管理、用户管理、全部审批' },
                { value: 'COUNSELOR', label: '辅导员', desc: '请假审批、公文审批' },
                { value: 'TEACHER', label: '老师', desc: '请假审批、课程管理' },
                { value: 'STUDENT', label: '学生', desc: '请假申请、查看记录' },
                { value: 'EMPLOYEE', label: '职工', desc: '请假申请、公文查看' },
                { value: 'MANAGER', label: '部门经理', desc: '本部门审批、公文管理' },
                { value: 'HR', label: '人事', desc: '人员管理、考勤统计' }
            ]
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});


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

// 飞书卡片按钮回调（教师点击同意/拒绝时飞书回调）
app.post('/api/feishu/card/action', async (req, res) => {
    try {
        var body = req.body;
        var action = body?.action?.value || {};
        var openId = body?.operator?.open_id || body?.user?.open_id || '';
        console.log('[飞书卡片] 回调 action=' + JSON.stringify(action));
        if (!action.leave_id) return res.json({ code: 0, msg: 'no action' });
        var leaveId = parseInt(action.leave_id);
        var operator = getSystemUserByFeishuId(openId);
        if (!operator) return res.json({ code: 0, msg: 'user not bound' });
        var leave = query('SELECT * FROM leave_requests WHERE id = ?', [leaveId])[0];
        if (!leave || leave.status !== 'PENDING') return res.json({ code: 0, msg: 'done' });
        var applicant = query('SELECT id, name, department FROM users WHERE id = ?', [leave.user_id])[0];
        if (action.action === 'approve_leave') {
            run("UPDATE leave_requests SET status='APPROVED', approver_id=?, approver_comment='已批准', updated_at=datetime('now') WHERE id=?", [operator.id, leaveId]);
            console.log('[飞书卡片] ' + operator.name + ' 批准请假 #' + leaveId);
            if (applicant) {
                var oid = getFeishuIdBySystemUser(applicant.id);
                if (oid) await sendFeishuCard(oid, 'open_id', buildLeaveResultCard(leave, 'APPROVED', operator.name, '已批准'));
            }
        } else if (action.action === 'reject_leave') {
            run("UPDATE leave_requests SET status='REJECTED', approver_id=?, approver_comment='不予批准', updated_at=datetime('now') WHERE id=?", [operator.id, leaveId]);
            console.log('[飞书卡片] ' + operator.name + ' 驳回请假 #' + leaveId);
            if (applicant) {
                var oid2 = getFeishuIdBySystemUser(applicant.id);
                if (oid2) await sendFeishuCard(oid2, 'open_id', buildLeaveResultCard(leave, 'REJECTED', operator.name, '不予批准'));
            }
        }
        res.json({ code: 0, msg: 'success' });
    } catch (e) {
        console.error('[飞书卡片] 错误:', e.message);
        res.json({ code: 0, msg: 'error: ' + e.message });
    }
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

app.post('/api/docs', auth, async (req, res) => {
    try {
        const { title, content, type, priority } = req.body;
        const r = run(`INSERT INTO documents (title, content, type, priority, status, applicant_id) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [title, content, type || 'NORMAL', priority || 'NORMAL', req.userId]);
        const docId = r.lastID;
        try {
            const applicant = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
            const typeNames = { NOTICE: '通知', PROPOSAL: '请示', REPORT: '报告', MINUTES: '会议纪要', POLICY: '制度', NORMAL: '普通' };
            const notifyText = `📄 **新公文待审批**\n\n` +
                `📌 标题：${title}\n` +
                `📝 类型：${typeNames[type] || type}\n` +
                `🔥 优先级：${priority === 'HIGH' ? '紧急' : priority === 'LOW' ? '普通' : '一般'}\n` +
                `👤 申请人：${applicant?.name || '用户#' + req.userId}\n` +
                `🆔 编号：#${docId}\n\n` +
                `👉 请及时审批！回复「同意 #${docId}」或「不同意 #${docId}」`;
            await sendFeishuToApprovers(notifyText);
            await sendFeishuToGroup(notifyText);
        } catch (e) { console.warn('[公文] 通知失败:', e.message); }
        res.json({ success: true, id: docId });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/docs/:id/approve', auth, async (req, res) => {
    try {
        const docId = req.params.id;
        const approver = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        const doc = query('SELECT d.*, u.name as applicant_name, u.id as applicant_id FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.id = ?', [docId])[0];
        run(`UPDATE documents SET status = 'APPROVED', updated_at = datetime('now') WHERE id = ?`, [docId]);
        run(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'APPROVE', ?)`, [docId, req.userId, req.body.comment || '']);
        if (doc && doc.applicant_id) {
            try { await sendFeishuToUser(doc.applicant_id, `✅ **公文已批准**\n\n📌 ${doc.title}\n👤 审批人：${approver?.name || '管理员'}\n💬 ${req.body.comment || '已批准'}`); } catch(e) {}
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/docs/:id/reject', auth, async (req, res) => {
    try {
        const docId = req.params.id;
        const approver = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        const doc = query('SELECT d.*, u.name as applicant_name, u.id as applicant_id FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE d.id = ?', [docId])[0];
        run(`UPDATE documents SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?`, [docId]);
        run(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'REJECT', ?)`, [docId, req.userId, req.body.comment || '']);
        if (doc && doc.applicant_id) {
            try { await sendFeishuToUser(doc.applicant_id, `❌ **公文已驳回**\n\n📌 ${doc.title}\n👤 审批人：${approver?.name || '管理员'}\n💬 ${req.body.comment || '不符合要求'}`); } catch(e) {}
        }
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

        // 检查是否是发送到群聊
        if (/群里|群聊|群发|告诉大家|通知大家|在群里|群通知|发到群/.test(message)) {
            let content = message;
            content = content.replace(/在群里|群聊|群发|告诉大家|通知大家|群通知|发到群/g, '').trim();
            if (!content || content.length < 2) content = '📢 来自系统的群通知';

            const result = await sendFeishuToGroup('📢 群通知\n\n' + content + '\n\n—— ' + new Date().toLocaleString('zh-CN'));
            return res.json({
                success: result.success,
                target: '群聊',
                content: content,
                reason: result.reason
            });
        }

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
        // ADMIN/COUNSELOR/TEACHER 可看全部请假，STUDENT 只看自己的
        const canSeeAll = user && ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role);
        const uid = canSeeAll ? null : req.userId;
        let sql = `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE 1=1`;
        const p = [];
        if (uid) { sql += ' AND l.user_id = ?'; p.push(uid); }
        if (req.query.status) { sql += ' AND l.status = ?'; p.push(req.query.status); }
        sql += ' ORDER BY l.created_at DESC';
        res.json(query(sql, p));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 请假申请 - 提交后自动通知审批人（辅导员/老师）
app.post('/api/leave', auth, async (req, res) => {
    try {
        const { type, startDate, endDate, start_date, end_date, days, reason } = req.body;
        const sDate = startDate || start_date || '';
        const eDate = endDate || end_date || '';
        const r = run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
            [req.userId, type, sDate, eDate, days, reason || '']);
        const leaveId = r.lastID;

        const applicant = query('SELECT id, name, role, department FROM users WHERE id = ?', [req.userId])[0];

        // 构建通知消息
        const notifyText = `📝 **新的请假申请**\n\n` +
            `👤 申请人：${applicant.name}（${applicant.department || ''}）\n` +
            `📋 类型：${type}\n` +
            `📅 时间：${sDate} 至 ${eDate}（${days}天）\n` +
            `💬 事由：${reason || '无'}\n` +
            `🆔 编号：#${leaveId}\n\n` +
            `👉 请及时审批！回复「同意 #${leaveId}」或「不同意 #${leaveId}」`;

        // 1. 飞书通知审批人（辅导员+老师+管理员）
        let feishuResult = { success: false, sent: 0 };
        try {
            // 通知辅导员和管理员（他们负责审批学生请假）
            const approvers = query(
                `SELECT id, name, role FROM users WHERE role IN ('COUNSELOR', 'ADMIN') OR (role = 'TEACHER' AND department LIKE ?)`,
                ['%' + (applicant.department || '').replace(/[0-9]+级$/, '') + '%']
            );
            if (approvers.length === 0) {
                // 如果没有匹配的老师，通知所有辅导员和管理员
                const fallbackApprovers = query(`SELECT id, name, role FROM users WHERE role IN ('COUNSELOR', 'ADMIN')`);
                for (const a of fallbackApprovers) {
                    const r2 = await sendFeishuToUser(a.id, notifyText);
                    if (r2.success) feishuResult.sent++;
                }
            } else {
                for (const a of approvers) {
                    const r2 = await sendFeishuToUser(a.id, notifyText);
                    if (r2.success) feishuResult.sent++;
                }
            }
            feishuResult.success = feishuResult.sent > 0;
        } catch (e) { console.error('[请假通知] 飞书通知失败:', e.message); }

        // 2. 也发到群聊
        try { await sendFeishuToGroup(notifyText); } catch (e) {}

        res.json({
            success: true,
            id: leaveId,
            notified: feishuResult.sent > 0,
            notifiedCount: feishuResult.sent
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 请假审批 - 通过后自动通知申请人
app.post('/api/leave/:id/approve', auth, async (req, res) => {
    try {
        const leaveId = req.params.id;
        const comment = req.body.comment || '已批准';

        run(`UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
            [req.userId, comment, leaveId]);

        const leave = query('SELECT l.*, u.name as user_name, u.department FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.id = ?', [leaveId])[0];
        const approver = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];

        if (leave) {
            // 通知申请人
            const notifyText = `✅ **请假已批准**\n\n` +
                `📋 ${leave.type} · ${leave.days}天\n` +
                `📅 ${leave.start_date} ~ ${leave.end_date}\n` +
                `👤 审批人：${approver?.name || '管理员'}\n` +
                `💬 审批意见：${comment}\n\n` +
                `🎉 假期愉快！`;

            await sendFeishuToUser(leave.user_id, notifyText);
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 请假驳回 - 驳回后自动通知申请人
app.post('/api/leave/:id/reject', auth, async (req, res) => {
    try {
        const leaveId = req.params.id;
        const comment = req.body.comment || '不予批准';

        run(`UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
            [req.userId, comment, leaveId]);

        const leave = query('SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.id = ?', [leaveId])[0];
        const approver = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];

        if (leave) {
            const notifyText = `❌ **请假未通过**\n\n` +
                `📋 ${leave.type} · ${leave.days}天\n` +
                `📅 ${leave.start_date} ~ ${leave.end_date}\n` +
                `👤 审批人：${approver?.name || '管理员'}\n` +
                `💬 驳回理由：${comment}\n\n` +
                `如有疑问请联系审批人。`;

            await sendFeishuToUser(leave.user_id, notifyText);
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 获取单个请假详情
app.get('/api/leave/:id', auth, (req, res) => {
    try {
        const leaveId = parseInt(req.params.id);
        if (!leaveId) return res.status(400).json({ message: '无效的请假编号' });
        const leave = query('SELECT l.*, u.name as user_name, u.department FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.id = ?', [leaveId])[0];
        if (!leave) return res.status(404).json({ message: '请假记录不存在' });
        const cur = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        const canSeeAll = cur && ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(cur.role);
        if (!canSeeAll && leave.user_id !== req.userId) return res.status(403).json({ message: '无权查看此请假记录' });
        res.json(leave);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
//  销售订单管理 API
// ============================================================

// 获取销售订单列表
app.get('/api/sales-orders', auth, (req, res) => {
    try {
        const user = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        const canSeeAll = user && ['ADMIN', 'COUNSELOR', 'MANAGER'].includes(user.role);
        let sql = 'SELECT * FROM sales_orders WHERE 1=1';
        const p = [];
        if (!canSeeAll) { sql += ' AND applicant_id = ?'; p.push(req.userId); }
        if (req.query.status) { sql += ' AND status = ?'; p.push(req.query.status); }
        if (req.query.type) { sql += ' AND order_type = ?'; p.push(req.query.type); }
        sql += ' ORDER BY created_at DESC';
        res.json(query(sql, p));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 获取单个销售订单
app.get('/api/sales-orders/:id', auth, (req, res) => {
    try {
        const order = query('SELECT * FROM sales_orders WHERE id = ?', [parseInt(req.params.id)])[0];
        if (!order) return res.status(404).json({ message: '订单不存在' });
        res.json(order);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 创建销售订单
app.post('/api/sales-orders', auth, (req, res) => {
    try {
        const b = req.body;
        if (!b.customer_name) return res.status(400).json({ message: '客户名称不能为空' });
        var applicant = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        var orderNo = 'SO' + Date.now().toString(36).toUpperCase();
        var r = run(`INSERT INTO sales_orders (
            order_no, customer_name, contact_person, contact_phone, order_type,
            product_type, is_rush, quantity, unit, price, amount,
            delivery_date, required_date, special_requirements, status,
            applicant_id, applicant_name
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
        [orderNo, b.customer_name, b.contact_person||'', b.contact_phone||'', b.order_type||'normal',
         b.product_type||'standard', b.is_rush?1:0, b.quantity||1, b.unit||'PCS', b.price||0, b.amount||0,
         b.delivery_date||'', b.required_date||'', b.special_requirements||'',
         req.userId, applicant?.name||'']);
        console.log('[销售订单] 创建 #' + r.lastID + ' ' + orderNo);
        res.json({ success: true, id: r.lastID, order_no: orderNo });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 提交评审（工程部/计划部/业务部确认）
app.post('/api/sales-orders/:id/review', auth, async (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        var order = query('SELECT * FROM sales_orders WHERE id = ?', [orderId])[0];
        if (!order) return res.status(404).json({ message: '订单不存在' });
        
        var b = req.body;
        var stage = b.stage || ''; // engineering / planning / business
        var comment = b.comment || '';
        var approver = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        var now = new Date().toISOString();

        if (stage === 'engineering') {
            run(`UPDATE sales_orders SET status='pending_planning', bom_status=?, bom_notes=?,
                 reviewer_eng_id=?, reviewer_eng_comment=?, reviewer_eng_at=? WHERE id=?`,
                [b.bom_status||'completed', b.bom_notes||'', req.userId, comment, now, orderId]);
            console.log('[销售订单] #' + orderId + ' 工程部评审完成');
        } else if (stage === 'planning') {
            var newDelivery = b.delivery_date || order.delivery_date;
            run(`UPDATE sales_orders SET status='pending_confirmation', delivery_date=?,
                 reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?`,
                [newDelivery, req.userId, comment, now, orderId]);
            console.log('[销售订单] #' + orderId + ' 计划部评审完成');
        } else if (stage === 'business') {
            run(`UPDATE sales_orders SET status='confirmed',
                 reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?`,
                [req.userId, comment, now, orderId]);
            console.log('[销售订单] #' + orderId + ' 业务部确认完成');
        } else {
            return res.status(400).json({ message: '未知评审阶段: ' + stage });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 订单变更
app.post('/api/sales-orders/:id/change', auth, (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        var b = req.body;
        if (!b.change_notes) return res.status(400).json({ message: '变更说明不能为空' });
        run(`UPDATE sales_orders SET status='draft', change_notes=?, updated_at=datetime('now') WHERE id=?`,
            [b.change_notes, orderId]);
        console.log('[销售订单] #' + orderId + ' 已变更');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 发货
app.post('/api/sales-orders/:id/ship', auth, (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        run(`UPDATE sales_orders SET status='shipped', shipped_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, [orderId]);
        console.log('[销售订单] #' + orderId + ' 已发货');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 销售订单统计
app.get('/api/sales-orders/stats/info', auth, (req, res) => {
    try {
        res.json({
            total: query('SELECT COUNT(*) as c FROM sales_orders')[0].c,
            draft: query("SELECT COUNT(*) as c FROM sales_orders WHERE status='draft'")[0].c,
            pendingEng: query("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending_engineering'")[0].c,
            pendingPlan: query("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending_planning'")[0].c,
            pendingConfirm: query("SELECT COUNT(*) as c FROM sales_orders WHERE status='pending_confirmation'")[0].c,
            confirmed: query("SELECT COUNT(*) as c FROM sales_orders WHERE status='confirmed'")[0].c,
            shipped: query("SELECT COUNT(*) as c FROM sales_orders WHERE status='shipped'")[0].c
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 取消请假
app.put('/api/leave/:id/cancel', auth, (req, res) => {
    try {
        const leaveId = parseInt(req.params.id);
        if (!leaveId) return res.status(400).json({ message: '无效的请假编号' });
        const leave = query('SELECT * FROM leave_requests WHERE id = ?', [leaveId])[0];
        if (!leave) return res.status(404).json({ message: '请假记录不存在' });
        if (leave.user_id !== req.userId) return res.status(403).json({ message: '只能取消自己的请假' });
        if (leave.status !== 'PENDING') return res.status(400).json({ message: '只能取消待审批状态的请假' });
        run("UPDATE leave_requests SET status='CANCELLED', updated_at=datetime('now') WHERE id=?", [leaveId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/leave/stats', auth, (req, res) => {
    try {
        const user = query('SELECT role FROM users WHERE id = ?', [req.userId])[0];
        // ADMIN/COUNSELOR/TEACHER 可看全部，STUDENT 只看自己的
        const canSeeAll = user && ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role);
        const uid = canSeeAll ? null : req.userId;
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
    const admins = query('SELECT id, name, role FROM users WHERE role IN (?, ?, ?)', ['ADMIN', 'COUNSELOR', 'TEACHER']);
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

        const isAdmin = ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role);
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

// ===== 飞书诊断端点 =====
app.get('/api/feishu/test', (req, res) => {
    const status = {
        larkClient: !!larkClient,
        tokenValid: feishuTokenValid,
        appId: FEISHU_APP_ID ? FEISHU_APP_ID.slice(0, 8) + '***' : '未设置',
        groupChatId: FEISHU_GROUP_CHAT_ID ? FEISHU_GROUP_CHAT_ID.slice(0, 8) + '***' : '未设置',
        aiAgents: !!aiAgents,
        dbHelper: !!dbHelper
    };
    res.json({ success: true, ...status });
});

// ===== 飞书消息发送测试 =====
app.post('/api/feishu/test/send', async (req, res) => {
    try {
        const { target, text } = req.body;
        if (!text) return res.json({ success: false, error: '缺少 text' });
        let result;
        if (target === 'group' || !target) {
            result = await sendFeishuToGroup(text || '🧪 测试消息：飞书消息通道正常');
        } else {
            result = await sendFeishuToUser(parseInt(target), text);
        }
        res.json({ success: result.success, detail: result });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// 飞书 Webhook
app.post('/api/feishu/webhook', async (req, res) => {
    const body = req.body;
    
    // URL 验证（飞书事件订阅首次配置）
    if (body.type === 'url_verification') {
        console.log('[飞书Webhook] ✓ URL 验证通过');
        return res.json({ challenge: body.challenge });
    }
    
    // 快速响应飞书（20ms 内，否则飞书重试）
    res.json({ success: true });
    
    // 打印收到的完整事件结构（调试用）
    console.log('[飞书Webhook] 收到事件: type=' + (body.header?.event_type || body.type || 'unknown'));
    
    // 异步处理消息（WS无法接收消息，用Webhook处理）
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
            userRole: user ? user.role : 'STUDENT',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'COUNSELOR') : false,
            conversationId: 'web_' + req.userId
        };

        console.log(`[Router API] 用户=${context.userName} 角色=${context.userRole} 消息="${message.slice(0, 60)}"`);
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

// Web Chat 入口 - chat.html 调用此接口（与 /api/ai/router 功能相同）
// 文件上传 + AI 处理（网页版）
app.post('/api/ai/upload', auth, async (req, res) => {
    try {
        var message = req.body.message || '';
        var fileData = req.body.file;
        if (!fileData && !message) return res.status(400).json({ success: false, error: '缺少消息或文件' });
        if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

        var user = dbHelper ? dbHelper.getUserById(req.userId) :
            query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];

        var fileDesc = '';
        if (fileData) {
            try {
                var buff = Buffer.from(fileData.content, 'base64');
                var text = buff.toString('utf8');
                var fileName = fileData.name || '未命名文件';
                var fileSize = buff.length;
                console.log('[上传] 收到文件: ' + fileName + ' (' + fileSize + ' bytes)');
                fileDesc = '\n\n--- 用户上传的文件 ---\n文件名: ' + fileName + '\n文件大小: ' + fileSize + ' 字节\n文件内容:\n' + text.substring(0, 50000) + '\n--- 文件结束 ---';
                // 也写入公文库
                if (typeof createDocumentFromText === 'function') {
                    try { createDocumentFromText(text, fileName, null); } catch(e) { console.error('[上传] 公文创建失败:', e.message); }
                }
            } catch (err) {
                console.error('[上传] 文件解码失败:', err.message);
                return res.status(400).json({ success: false, error: '文件解码失败: ' + err.message });
            }
        }

        var fullMessage = message + fileDesc;
        var context = {
            userId: req.userId,
            userName: user ? user.name : '用户#' + req.userId,
            userRole: user ? user.role : 'STUDENT',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'COUNSELOR') : false,
            conversationId: req.body.conversationId || ('web_' + req.userId)
        };

        console.log('[上传AI] 用户=' + context.userName + ' 文件=' + (fileData?.name || '无') + ' 消息=' + message.substring(0, 50));
        var result = await aiAgents.routerAgentProcess(fullMessage, context);

        if (result && result.success) {
            res.json(result);
        } else {
            res.status(500).json(result || { success: false, error: 'AI处理失败' });
        }
    } catch (err) {
        console.error('[上传AI] 错误:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/agents/router', auth, async (req, res) => {
    const { message, conversationId } = req.body;
    if (!message) return res.status(400).json({ success: false, error: '缺少 message' });
    if (!aiAgents) return res.status(500).json({ success: false, error: '智能体系统未启用' });

    try {
        const user = dbHelper ? dbHelper.getUserById(req.userId) :
            query('SELECT id, name, role FROM users WHERE id = ?', [req.userId])[0];

        const context = {
            userId: req.userId,
            userName: user ? user.name : '用户#' + req.userId,
            userRole: user ? user.role : 'STUDENT',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'COUNSELOR') : false,
            conversationId: conversationId || ('web_' + req.userId)
        };

        console.log(`[Agents Router] 用户=${context.userName} 角色=${context.userRole} 消息="${message.slice(0, 60)}"`);
        const result = await aiAgents.routerAgentProcess(message, context);

        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (err) {
        console.error('[Agents Router] 错误:', err.message);
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
            userRole: user ? user.role : 'STUDENT',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'COUNSELOR') : false,
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

// ===== 对话历史 API（跨平台同步）=====
app.get('/api/conversations', auth, (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const source = req.query.source || '';
        let sql = 'SELECT id, source, role, content, agent, feishu_chat_id, created_at FROM conversations WHERE user_id = ?';
        const params = [req.userId];
        if (source) { sql += ' AND source = ?'; params.push(source); }
        sql += ' ORDER BY id DESC LIMIT ?';
        params.push(limit);
        const rows = query(sql, params);
        rows.reverse();
        res.json({ success: true, conversations: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
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
            userName: user ? user.name : '用户#' + req.userId,
            userRole: user ? user.role : 'STUDENT',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'COUNSELOR') : false
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

            const isAdmin = ['ADMIN', 'COUNSELOR', 'TEACHER'].includes(user.role);
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
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/feishu-chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feishu-chat.html')));
app.get('/leave', (req, res) => res.sendFile(path.join(__dirname, 'leave.html')));
app.get('/docflow', (req, res) => res.sendFile(path.join(__dirname, 'docflow.html')));
app.get('/docflow-pro', (req, res) => res.sendFile(path.join(__dirname, 'docflow_pro.html')));
app.get('/docflow-advanced', (req, res) => res.sendFile(path.join(__dirname, 'docflow_advanced.html')));
app.get('/docflow-ai', (req, res) => res.sendFile(path.join(__dirname, 'docflow_ai.html')));


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
                // 飞书消息发送器（含交互卡片）
                aiAgents.injectFeishu({
                    sendToUser: async (userId, text) => await sendFeishuToUser(userId, text),
                    sendToApprovers: async (text) => await sendFeishuToApprovers(text),
                    sendToUserByName: async (name, text) => await sendFeishuToUserByName(name, text),
                    sendToChat: async (chatId, text) => await sendFeishuMsg(chatId, text),
                    sendToGroup: async (text) => await sendFeishuToGroup(text),
                    sendCardToUser: async (userId, card) => await sendCardToUser(userId, card),
                    buildLeaveApprovalCard: buildLeaveApprovalCard,
                    buildLeaveResultCard: buildLeaveResultCard
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
            { name: 'users', sql: `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT DEFAULT '', name TEXT NOT NULL, role TEXT DEFAULT 'STUDENT', department TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'documents', sql: `CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, type TEXT DEFAULT 'NORMAL', priority TEXT DEFAULT 'NORMAL', status TEXT DEFAULT 'PENDING', applicant_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME)` },
            { name: 'leave_requests', sql: `CREATE TABLE IF NOT EXISTS leave_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, start_date TEXT, end_date TEXT, days INTEGER, reason TEXT, status TEXT DEFAULT 'PENDING', approver_id INTEGER, approver_comment TEXT, feishu_chat_id TEXT, feishu_msg_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME)` },
            { name: 'approvals', sql: `CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER, approver_id INTEGER, action TEXT, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'feishu_user_map', sql: `CREATE TABLE IF NOT EXISTS feishu_user_map (id INTEGER PRIMARY KEY AUTOINCREMENT, feishu_open_id TEXT UNIQUE NOT NULL, system_user_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
                        { name: 'conversations', sql: `CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, source TEXT DEFAULT 'web', role TEXT, content TEXT, agent TEXT, feishu_chat_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'sales_orders', sql: `CREATE TABLE IF NOT EXISTS sales_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_no TEXT UNIQUE NOT NULL,
                customer_name TEXT NOT NULL,
                contact_person TEXT DEFAULT '',
                contact_phone TEXT DEFAULT '',
                order_type TEXT DEFAULT 'normal',
                product_type TEXT DEFAULT 'standard',
                is_rush INTEGER DEFAULT 0,
                quantity INTEGER DEFAULT 1,
                unit TEXT DEFAULT 'PCS',
                price REAL DEFAULT 0,
                amount REAL DEFAULT 0,
                delivery_date TEXT,
                required_date TEXT,
                bom_status TEXT DEFAULT 'pending',
                bom_notes TEXT DEFAULT '',
                special_requirements TEXT DEFAULT '',
                attachments TEXT DEFAULT '',
                status TEXT DEFAULT 'draft',
                applicant_id INTEGER,
                applicant_name TEXT DEFAULT '',
                reviewer_eng_id INTEGER,
                reviewer_eng_comment TEXT DEFAULT '',
                reviewer_eng_at TEXT,
                reviewer_plan_id INTEGER,
                reviewer_plan_comment TEXT DEFAULT '',
                reviewer_plan_at TEXT,
                reviewer_biz_id INTEGER,
                reviewer_biz_comment TEXT DEFAULT '',
                reviewer_biz_at TEXT,
                change_notes TEXT DEFAULT '',
                shipped_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )` }
        ];

        let createdCount = 0;
        tables.forEach(t => { if (safeRun(t.sql, t.name)) createdCount++; });
        ];

        let createdCount = 0;
        tables.forEach(t => { if (safeRun(t.sql, t.name)) createdCount++; });
        console.log(`[OK] 数据表检查完成 (${createdCount}/${tables.length})`);

        // （已移除：默认测试数据初始化。仅保留管理员账号，由 initDB 创建）

        try { saveDB(); } catch (e) { console.error('[WARN] 保存数据库失败:', e.message); }
        try { await initLark(); } catch (e) { /* initLark 已有处理 */ }
        try { startScheduledTasks(); } catch (e) { console.error('[WARN] 启动定时任务失败:', e.message); }
        // 启动5秒后发送每日简报测试（验证飞书发送通道是否正常）
        setTimeout(async () => {
            try {
                await sendDailyBriefing();
                console.log('[启动] 每日简报测试发送完成');
            } catch(e) {
                console.error('[启动] 每日简报测试发送失败:', e.message);
            }
        }, 5000);

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
                const { addRoutes, auth: authMiddleware } = authModule(db, query, run, crypto);
                addRoutes(app);
                // 重新注册所有需要 auth 的路由（因为 auth 中间件是在 initAuth 中创建的）
                // 注意：auth 变量在文件顶层未定义，这里通过重新注册来修复
                // 方案：在 app 上挂载 auth 中间件引用，供后续使用
                app._authMiddleware = authMiddleware;
                console.log('[OK] Auth 中间件已注册');
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
            console.log(`========================================================\n`);
        });
    } catch (err) {
        console.error('[ERROR] 启动失败:', err);
        process.exit(1);
    }
}

start();
