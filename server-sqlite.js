// ============================================================
//  销售订货系统 - 全流程 AI 飞书审批版
//  端口：3000 | 数据库：sql.js (纯JS SQLite)
//  v4.0 - 销售角色 + 全流程AI + 飞书闭环
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
        )`,
        // ============ 销售订货系统表 ============
        `CREATE TABLE IF NOT EXISTS order_approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            approver_id INTEGER,
            approver_name TEXT DEFAULT '',
            stage TEXT NOT NULL,
            action TEXT NOT NULL,
            comment TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS delivery_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            delivery_no TEXT UNIQUE NOT NULL,
            warehouse_status TEXT DEFAULT 'pending',
            financial_status TEXT DEFAULT 'pending',
            financial_reviewer_id INTEGER,
            shipped_at TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS order_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            change_type TEXT NOT NULL,
            change_reason TEXT DEFAULT '',
            old_value TEXT DEFAULT '',
            new_value TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            applicant_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS contact_forms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT DEFAULT '',
            department TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            applicant_id INTEGER,
            approver_id INTEGER,
            approver_comment TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS prediction_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            month TEXT NOT NULL,
            target_department TEXT DEFAULT '',
            plan_content TEXT DEFAULT '',
            status TEXT DEFAULT 'draft',
            creator_id INTEGER,
            approver_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS production_cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            product_name TEXT DEFAULT '',
            lead_days INTEGER NOT NULL,
            cycle_category TEXT DEFAULT 'standard',
            valid_from TEXT NOT NULL,
            valid_to TEXT,
            approver_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS bom_materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_code TEXT DEFAULT '',
            material_code TEXT NOT NULL,
            material_name TEXT DEFAULT '',
            specification TEXT DEFAULT '',
            quantity REAL DEFAULT 0,
            unit TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS delivery_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            month TEXT NOT NULL UNIQUE,
            total_orders INTEGER DEFAULT 0,
            on_time INTEGER DEFAULT 0,
            delay_count INTEGER DEFAULT 0,
            on_time_pct REAL DEFAULT 0,
            delay_reason TEXT DEFAULT '',
            improvement TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        // ============ 销售订货5.4-5.10新增表 ============
        `CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            product_name TEXT DEFAULT '',
            category TEXT DEFAULT '',
            specification TEXT DEFAULT '',
            quantity REAL DEFAULT 0,
            unit TEXT DEFAULT 'PCS',
            location TEXT DEFAULT '',
            min_stock REAL DEFAULT 0,
            max_stock REAL DEFAULT 0,
            last_check_at TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS monthly_forecasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            month TEXT NOT NULL,
            department TEXT DEFAULT '',
            product_category TEXT DEFAULT '',
            forecast_quantity REAL DEFAULT 0,
            actual_quantity REAL DEFAULT 0,
            variance REAL DEFAULT 0,
            notes TEXT DEFAULT '',
            creator_id INTEGER,
            status TEXT DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS new_product_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_name TEXT NOT NULL,
            product_code TEXT DEFAULT '',
            specification TEXT DEFAULT '',
            bom_status TEXT DEFAULT 'pending',
            bom_content TEXT DEFAULT '',
            sample_status TEXT DEFAULT 'pending',
            sample_notes TEXT DEFAULT '',
            review_result TEXT DEFAULT 'pending',
            reviewer_id INTEGER,
            reviewed_at TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS order_confirmations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            conf_no TEXT UNIQUE NOT NULL,
            customer_name TEXT NOT NULL,
            total_amount REAL DEFAULT 0,
            deposit_amount REAL DEFAULT 0,
            deposit_paid INTEGER DEFAULT 0,
            delivery_terms TEXT DEFAULT '',
            payment_terms TEXT DEFAULT '',
            confirmed_by INTEGER,
            confirmed_at TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS rush_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            rush_reason TEXT DEFAULT '',
            original_delivery TEXT,
            new_delivery TEXT,
            days_ahead INTEGER DEFAULT 0,
            approved_by INTEGER,
            approved_at TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS change_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            change_type TEXT NOT NULL,
            change_detail TEXT DEFAULT '',
            reason TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            applicant_id INTEGER,
            reviewer_eng_id INTEGER,
            reviewer_eng_comment TEXT DEFAULT '',
            reviewer_plan_id INTEGER,
            reviewer_plan_comment TEXT DEFAULT '',
            reviewer_biz_id INTEGER,
            reviewer_biz_comment TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS notification_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            channel TEXT DEFAULT 'feishu',
            title TEXT DEFAULT '',
            content TEXT DEFAULT '',
            status TEXT DEFAULT 'sent',
            read_at TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        // 学工系统角色：ADMIN(系统管理员), SALES(辅导员), ENGINEER(老师), PLANNER(学生)
        const initUsers = [
            ['admin', md5('admin123'), '系统管理员', 'ADMIN', '信息中心'],
            ['fudaoyuan', md5('123456'), '张业务', 'SALES', '业务部/市场部'],
            ['wanglaoshi', md5('123456'), '李工程', 'ENGINEER', '工程部'],
            ['zhanglaoshi', md5('123456'), '王计划', 'ENGINEER', '计划部'],
            ['xiaoming', md5('123456'), '赵采购', 'PLANNER', '工程部2023级'],
            ['xiaohong', md5('123456'), '钱品质', 'PLANNER', '计划部2023级'],
            ['xiaogang', md5('123456'), '孙主管', 'PLANNER', '工程部2024级'],
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
        console.log('[OK] 系统初始账号已创建（管理员/业务部/工程部/计划部等共7人）');
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

// ============================================================
//  销售订货审批卡片系统（v6.0 -飞书端完整审批流程）
//  每个功能模块按流程图关联：下单→工程BOM评审→计划交期评审→业务确认→发货
//  非标产品额外：采购审核→品质审核
// ============================================================

var ORDER_STATUS = {
    DRAFT: '\u8349\u7A3F',
    PENDING_ENG: '\u5F85\u5DE5\u7A0B\u8BC4\u5BA1',
    PENDING_PLAN: '\u5F85\u8BA1\u5212\u8BC4\u5BA1',
    PENDING_BIZ: '\u5F85\u4E1A\u52A1\u786E\u8BA4',
    PENDING_PURCHASE: '\u5F85\u91C7\u8D2D\u5BA1\u6838',
    PENDING_QUALITY: '\u5F85\u54C1\u8D28\u5BA1\u6838',
    APPROVED: '\u5DF2\u6279\u51C6',
    IN_PRODUCTION: '\u751F\u4EA7\u4E2D',
    COMPLETED: '\u5DF2\u5B8C\u6210',
    DELIVERED: '\u5DF2\u53D1\u8D27',
    CHANGED: '\u5DF2\u53D8\u66F4',
    CANCELLED: '\u5DF2\u53D6\u6D88'
};

var ORDER_FLOW = {
    DRAFT: { next: 'PENDING_ENG', action: 'submit', btn: '\u63D0\u4EA4\u8BC4\u5BA1', desc: '\u63D0\u4EA4\u5DE5\u7A0B\u90E8BOM\u8BC4\u5BA1' },
    PENDING_ENG: { next: 'PENDING_PLAN', action: 'eng_approve', btn: '\u5DE5\u7A0B\u786E\u8BA4', desc: '\u5DE5\u7A0B\u90E8BOM\u8BC4\u5BA1\u786E\u8BA4',
                   reject: 'DRAFT', rejectAction: 'eng_reject', rejectBtn: '\u5DE5\u7A0B\u8FD4\u56DE', rejectDesc: '\u8FD4\u56DE\u8BA2\u5355\u4FEE\u6539' },
    PENDING_PLAN: { next: 'PENDING_BIZ', action: 'plan_approve', btn: '\u8BA1\u5212\u786E\u8BA4', desc: '\u8BA1\u5212\u90E8\u4EA4\u671F\u8BC4\u5BA1',
                   reject: 'DRAFT', rejectAction: 'plan_reject', rejectBtn: '\u8BA1\u5212\u8FD4\u56DE', rejectDesc: '\u4EA4\u671F\u65E0\u6CD5\u6EE1\u8DB3\uFF0C\u8FD4\u56DE\u4FEE\u6539' },
    PENDING_BIZ: { action: 'biz_confirm', btn: '\u4E1A\u52A1\u786E\u8BA4', desc: '\u4E1A\u52A1\u90E8\u6700\u7EC8\u786E\u8BA4',
                  nextStandard: 'APPROVED', nextNonStandard: 'PENDING_PURCHASE',
                  reject: 'DRAFT', rejectAction: 'biz_reject', rejectBtn: '\u4E1A\u52A1\u8FD4\u56DE', rejectDesc: '\u8FD4\u56DE\u4FEE\u6539' },
    PENDING_PURCHASE: { next: 'PENDING_QUALITY', action: 'purchase_approve', btn: '\u91C7\u8D2D\u786E\u8BA4', desc: '\u91C7\u8D2D\u90E8\u5BA1\u6838\u4F9B\u5E94\u94FE',
                       reject: 'PENDING_BIZ', rejectAction: 'purchase_reject', rejectBtn: '\u91C7\u8D2D\u8FD4\u56DE', rejectDesc: '\u8FD4\u56DE\u4E1A\u52A1\u91CD\u65B0\u786E\u8BA4' },
    PENDING_QUALITY: { next: 'APPROVED', action: 'quality_approve', btn: '\u54C1\u8D28\u786E\u8BA4', desc: '\u54C1\u8D28\u90E8\u5BA1\u6838',
                      reject: 'PENDING_BIZ', rejectAction: 'quality_reject', rejectBtn: '\u54C1\u8D28\u8FD4\u56DE', rejectDesc: '\u8FD4\u56DE\u4E1A\u52A1\u91CD\u65B0\u786E\u8BA4' }
};

// ---------- 构建订单审批卡片 ----------
function buildOrderReviewCard(order, applicant, stage) {
    var PRODUCT_TYPE = order.product_type || 'standard';
    var isNonStandard = PRODUCT_TYPE !== 'standard';
    var isRush = order.is_rush ? '\u26A1 \u6025\u63D2\u5355 ' : '';
    var isNew = order.is_new_product ? '\u{1F195} \u65B0\u54C1 ' : '';

    // 评审流程可视化
    var stages = [
        { label: '\u{1F4E8}\u4E0B\u5355', done: true },
        { label: '\u2699\uFE0F\u5DE5\u7A0B', done: stage === 'PENDING_PLAN' || stage === 'PENDING_BIZ' || stage === 'PENDING_PURCHASE' || stage === 'PENDING_QUALITY' || stage === 'APPROVED', current: stage === 'PENDING_ENG' },
        { label: '\u{1F4C5}\u8BA1\u5212', done: stage === 'PENDING_BIZ' || stage === 'PENDING_PURCHASE' || stage === 'PENDING_QUALITY' || stage === 'APPROVED', current: stage === 'PENDING_PLAN' },
        { label: '\u{1F4CB}\u4E1A\u52A1', done: stage === 'APPROVED', current: stage === 'PENDING_BIZ' }
    ];
    if (isNonStandard) {
        stages.push({ label: '\u{1F6AC}\u91C7\u8D2D', done: stage === 'PENDING_QUALITY' || stage === 'APPROVED', current: stage === 'PENDING_PURCHASE' });
        stages.push({ label: '\u2705\u54C1\u8D28', done: stage === 'APPROVED', current: stage === 'PENDING_QUALITY' });
    }
    stages.push({ label: '\u2705\u5B8C\u6210', done: stage === 'APPROVED', current: false });

    var flowLine = '';
    for (var i = 0; i < stages.length; i++) {
        var s = stages[i];
        if (s.done) flowLine += '\u2705 ' + s.label;
        else if (s.current) flowLine += '\u{1F534} **' + s.label + '**';
        else flowLine += '\u26AA ' + s.label;
        if (i < stages.length - 1) flowLine += '\u2192 ';
    }

    var flow = ORDER_FLOW[stage];
    var card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: isRush + '\u{1F4CB} \u9500\u552E\u8BA2\u5355\u5BA1\u6279' + (isNonStandard ? '\uFF08\u975E\u6807\uFF09' : '') },
            template: isRush ? 'orange' : (isNonStandard ? 'purple' : 'blue')
        },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\u{1F516} \u8BA2\u5355\u7F16\u53F7**\uFF1A' + (order.order_no || 'SO#' + order.id) + '  ' + isNew + '\n' +
                '**\u{1F3E2} \u5BA2\u6237**\uFF1A' + (order.customer_name || '') + '\n' +
                '**\u{1F4E6} \u4EA7\u54C1**\uFF1A' + (order.product_name || '') + ' \u00D7 ' + (order.quantity || 0) + ' PCS\n' +
                '**\u{1F4C5} \u8981\u6C42\u4EA4\u671F**\uFF1A' + (order.delivery_date || '\u5F85\u5B9A') + '\n' +
                '**\u{1F4DD} \u4EA7\u54C1\u7C7B\u578B**\uFF1A' + (isNonStandard ? '\u975E\u6807\u4EA7\u54C1' : '\u6807\u51C6\u4EA7\u54C1') + '\n' +
                '**\u{1F464} \u7533\u8BF7\u4EBA**\uFF1A' + (applicant?.name || order.applicant_name || '') + '\n' +
                (order.special_requirements ? '**\u26A0\uFE0F \u7279\u6B8A\u8981\u6C42**\uFF1A' + order.special_requirements + '\n' : '') +
                (order.attachment_note ? '**\u{1F4CE} \u9644\u9875**\uFF1A' + order.attachment_note + '\n' : '')
            } },
            { tag: 'hr' },
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\u{1F504} \u5BA1\u6279\u6D41\u7A0B**\uFF1A\n' + flowLine + '\n\n' +
                '**\u{1F4CC} \u5F53\u524D\u73AF\u8282**\uFF1A' + (flow ? flow.desc : '\u5F85\u5BA1\u6279') + '\n' +
                (isNonStandard ? '**\u26A0\uFE0F \u975E\u6807\u4EA7\u54C1\uFF0C\u5C06\u989D\u5916\u7ECF\u91C7\u8D2D\u90E8 \u2192 \u54C1\u8D28\u90E8\u5BA1\u6838**' : '')
            } }
        ]
    };

    // 审批/驳回按钮
    if (flow && flow.action) {
        var actions = [];
        actions.push({
            tag: 'button',
            text: { tag: 'plain_text', content: '\u2705 ' + (flow.btn || '\u540C\u610F') },
            value: { action: 'order_' + flow.action, order_id: order.id },
            type: 'primary'
        });
        if (flow.rejectAction) {
            actions.push({
                tag: 'button',
                text: { tag: 'plain_text', content: '\u274c ' + (flow.rejectBtn || '\u8FD4\u56DE') },
                value: { action: 'order_' + flow.rejectAction, order_id: order.id },
                type: 'danger'
            });
        }
        card.elements.push({ tag: 'action', actions: actions });
    }

    card.elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '\u70B9\u51FB\u6309\u94AE\u5373\u53EF\u5BA1\u6279\uFF0C\u4E5F\u53EF\u5728\u7FA4\u804A\u4E2D\u56DE\u590D\u300C\u540C\u610F/驳回 #' + order.id + '\u300D' }] });
    return card;
}

// ---------- 构建订单审批结果卡片 ----------
function buildOrderResultCard(order, result, reviewerName, comment) {
    var isApproved = result === 'APPROVED';
    var nextStage = '';
    if (isApproved) {
        var flow = ORDER_FLOW[order.status];
        if (flow) nextStage = '\u2192 ' + (ORDER_STATUS[flow.next] || ORDER_STATUS[flow.nextStandard] || '');
    }
    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: (isApproved ? '\u2705 \u8BA2\u5355\u5BA1\u6279\u901A\u8FC7' : '\u274c \u8BA2\u5355\u8FD4\u56DE\u4FEE\u6539') },
            template: isApproved ? 'green' : 'red'
        },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\u{1F516} \u8BA2\u5355**\uFF1A' + (order.order_no || 'SO#' + order.id) + '\n' +
                '**\u{1F3E2} \u5BA2\u6237**\uFF1A' + order.customer_name + '\n' +
                '**\u{1F4E6} \u4EA7\u54C1**\uFF1A' + order.product_name + ' \u00D7 ' + order.quantity + ' PCS\n' +
                '**\u{1F464} \u5BA1\u6279\u4EBA**\uFF1A' + (reviewerName || '') + '\n' +
                '**\u{1F4AC} \u5BA1\u6279\u610F\u89C1**\uFF1A' + (comment || (isApproved ? '\u5DF2\u786E\u8BA4\u901A\u8FC7' : '\u8BF7\u4FEE\u6539\u540E\u91CD\u65B0\u63D0\u4EA4')) + '\n' +
                (isApproved && nextStage ? '**\u{1F504} \u4E0B\u4E00\u6B65**\uFF1A' + nextStage : '')
            } },
            { tag: 'note', elements: [{ tag: 'plain_text', content: isApproved ? '\u{1F389} \u5BA1\u6279\u5DF2\u5B8C\u6210\uFF0C\u6D41\u7A0B\u7EE7\u7EED\u63A8\u8FDB' : '\u8BF7\u4FEE\u6539\u8BA2\u5355\u4FE1\u606F\u540E\u91CD\u65B0\u63D0\u4EA4\u5BA1\u6279' }] }
        ]
    };
}

// ---------- 构建发货确认卡片 ----------
function buildDeliveryReviewCard(order, deliveryNote) {
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '\u{1F4E6} \u53D1\u8D27\u786E\u8BA4\u5355' }, template: 'green' },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\u{1F516} \u53D1\u8D27\u5355\u53F7**\uFF1A' + (deliveryNote.delivery_no || 'DN#') + '\n' +
                '**\u{1F516} \u5173\u8054\u8BA2\u5355**\uFF1A' + (order.order_no || '#' + order.id) + '\n' +
                '**\u{1F3E2} \u5BA2\u6237**\uFF1A' + order.customer_name + '\n' +
                '**\u{1F4E6} \u4EA7\u54C1**\uFF1A' + order.product_name + ' \u00D7 ' + order.quantity + ' PCS\n' +
                '**\u{1F4C5} \u4EA4\u671F**\uFF1A' + (order.delivery_date || '') + '\n' +
                '**\u{1F4B0} \u8D22\u52A1\u5BA1\u6838**\uFF1A\u5F85\u786E\u8BA4'
            } },
            { tag: 'action', actions: [
                { tag: 'button', text: { tag: 'plain_text', content: '\u2705 \u8D22\u52A1\u786E\u8BA4\u51FA\u5E93' }, value: { action: 'order_delivery_approve', order_id: order.id, delivery_id: deliveryNote.id }, type: 'primary' },
                { tag: 'button', text: { tag: 'plain_text', content: '\u274c \u8D22\u52A1\u62D2\u7EDD' }, value: { action: 'order_delivery_reject', order_id: order.id, delivery_id: deliveryNote.id }, type: 'danger' }
            ] }
        ]
    };
}

// ---------- 构建变更单通知卡片 ----------
function buildOrderChangeCard(order, changeType, changeDetail) {
    var typeMap = { CUSTOMER_CHANGE: '\u5BA2\u6237\u53D8\u66F4', PLAN_DELAY: '\u8BA1\u5212\u90E8\u5EF6\u8FDF', RUSH_INSERT: '\u26A1 \u6025\u63D2\u5355', AUTO_EXTEND: '\u81EA\u52A8\u987A\u5EF6' };
    return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '\u{1F4C4} \u9500\u552E\u8BA2\u5355\u53D8\u66F4\u53CA\u901A\u77E5\u5355' }, template: 'orange' },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content:
                '**\u{1F516} \u8BA2\u5355**\uFF1A' + (order.order_no || '#' + order.id) + '\n' +
                '**\u{1F3E2} \u5BA2\u6237**\uFF1A' + order.customer_name + '\n' +
                '**\u2604\uFE0F \u53D8\u66F4\u7C7B\u578B**\uFF1A' + (typeMap[changeType] || changeType) + '\n' +
                '**\u{1F4DD} \u53D8\u66F4\u5185\u5BB9**\uFF1A' + (changeDetail || '') + '\n' +
                '**\u{1F4C5} \u539F\u4EA4\u671F**\uFF1A' + (order.delivery_date || '') + '\n' +
                (order.changed_delivery_date ? '**\u{1F4C5} \u65B0\u4EA4\u671F**\uFF1A' + order.changed_delivery_date + '\n' : '')
            } },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '\u53D8\u66F4\u540E\u9700\u91CD\u65B0\u8FDB\u5165\u8BC4\u5BA1\u6D41\u7A0B\uFF08\u5DE5\u7A0B\u2192\u8BA1\u5212\u2192\u4E1A\u52A1\uFF09' }] }
        ]
    };
}

// ============================================================
//  订单审批流程核心函数
// ============================================================

// 提交订单→工程部评审
async function submitOrderForReview(orderId) {
    var order = query("SELECT * FROM sales_orders WHERE id = ? AND status = 'DRAFT'", [orderId])[0];
    if (!order) return { success: false, reason: '订单不存在或已提交' };
    run("UPDATE sales_orders SET status='PENDING_ENG', updated_at=datetime('now') WHERE id=?", [orderId]);
    var applicant = query("SELECT id, name FROM users WHERE id = ?", [order.applicant_id])[0];

    // 发送飞书卡片给工程部审批人和申请人
    var users = query("SELECT id, name, feishu_open_id FROM users WHERE role IN ('ENGINEER','ADMIN','DIRECTOR')");
    var card = buildOrderReviewCard({ ...order, status: 'PENDING_ENG' }, applicant, 'PENDING_ENG');

    var sentCount = 0;
    for (var i = 0; i < users.length; i++) {
        var u = users[i];
        if (u.feishu_open_id) {
            try { await sendFeishuCard(u.feishu_open_id, 'open_id', card); sentCount++; } catch(e) {}
        }
    }

    // 发送通知消息到群聊
    try {
        var groupMsg = '📋 **新订单待工程部BOM评审** #' + orderId + '\n' +
                       '🔖 ' + (order.order_no || 'SO#'+orderId) + ' | 🏢 ' + order.customer_name + '\n' +
                       '📦 ' + order.product_name + ' × ' + order.quantity + 'PCS | 📅 ' + (order.delivery_date||'待定') + '\n' +
                       '💡 回复「同意 #' + orderId + '」或「驳回 #' + orderId + '」进行审批';
        await sendFeishuToGroup(groupMsg);
    } catch(e) { console.error('[订单] 群发通知失败:', e.message); }

    // 记录审批日志
    try { run("INSERT INTO order_approvals (order_id, approver_id, action, comment, created_at) VALUES (?,?,?,?,datetime('now'))", [orderId, applicant?.id || 0, 'SUBMIT', '提交订单审批']); } catch(e) {}

    return { success: true, orderId: orderId, newStatus: 'PENDING_ENG', cardSent: sentCount };
}

// 审批订单→下一阶段
async function approveOrderStage(orderId, stage, reviewerId, reviewerName, comment) {
    var order = query("SELECT * FROM sales_orders WHERE id = ? AND status = ?", [orderId, stage])[0];
    if (!order) return { success: false, reason: '订单不存在或状态不正确（当前状态: ' + stage + '）' };

    var flow = ORDER_FLOW[stage];
    if (!flow) return { success: false, reason: '未知审批阶段: ' + stage };

    var nextStatus;
    if (stage === 'PENDING_BIZ') {
        var isNonStandard = (order.product_type && order.product_type !== 'standard');
        nextStatus = isNonStandard ? (flow.nextNonStandard || 'APPROVED') : (flow.nextStandard || 'APPROVED');
    } else {
        nextStatus = flow.next || 'APPROVED';
    }

    run("UPDATE sales_orders SET status=?, updated_at=datetime('now') WHERE id=?", [nextStatus, orderId]);
    try { run("INSERT INTO order_approvals (order_id, approver_id, action, comment, created_at) VALUES (?,?,?,?,datetime('now'))", [orderId, reviewerId, 'APPROVE', comment || flow.desc]); } catch(e) {}

    var applicant = query("SELECT id, name, feishu_open_id FROM users WHERE id = ?", [order.applicant_id])[0];
    var reviewer = reviewerName || '审核人';

    // 发结果卡片给申请人
    if (applicant?.feishu_open_id) {
        try { await sendFeishuCard(applicant.feishu_open_id, 'open_id', buildOrderResultCard({ ...order, status: nextStatus }, 'APPROVED', reviewer, comment)); } catch(e) {}
    }

    // 如果进入下一审批阶段，发卡片给对应审批人
    if (nextStatus !== 'APPROVED' && ORDER_FLOW[nextStatus]) {
        var roleMap = {
            PENDING_PLAN: ['PLANNER', 'ADMIN', 'DIRECTOR'],
            PENDING_BIZ: ['SALES', 'SALES_INTL', 'ADMIN', 'DIRECTOR'],
            PENDING_PURCHASE: ['PURCHASE', 'ADMIN', 'DIRECTOR'],
            PENDING_QUALITY: ['QUALITY', 'ADMIN', 'DIRECTOR']
        };
        var roles = roleMap[nextStatus] || ['ADMIN', 'DIRECTOR'];
        var nextUsers = query("SELECT id, name, feishu_open_id FROM users WHERE role IN (" + roles.map(function(){return '?';}).join(',') + ")", roles);
        var nextCard = buildOrderReviewCard({ ...order, status: nextStatus }, applicant, nextStatus);
        var sc = 0;
        for (var i = 0; i < nextUsers.length; i++) {
            if (nextUsers[i].feishu_open_id) {
                try { await sendFeishuCard(nextUsers[i].feishu_open_id, 'open_id', nextCard); sc++; } catch(e) {}
            }
        }
        try {
            var stageNames = { PENDING_PLAN: '计划部交期评审', PENDING_BIZ: '业务部确认', PENDING_PURCHASE: '采购部审核', PENDING_QUALITY: '品质部审核' };
            await sendFeishuToGroup('📋 **订单进入' + (stageNames[nextStatus] || nextStatus) + '** #' + orderId + '\n' +
                '🔖 ' + (order.order_no || 'SO#'+orderId) + ' | 🏢 ' + order.customer_name + '\n' +
                '💡 回复「同意 #' + orderId + '」或「驳回 #' + orderId + '」进行审批');
        } catch(e) {}
    }

    if (nextStatus === 'APPROVED') {
        try {
            await sendFeishuToGroup('🎉 **订单已批准！** #' + orderId + '\n' +
                '🔖 ' + (order.order_no || 'SO#'+orderId) + ' | 🏢 ' + order.customer_name + '\n' +
                '📦 ' + order.product_name + ' × ' + order.quantity + 'PCS\n' +
                '📌 状态：已批准 → 可进入生产发货流程\n' +
                '💡 说「发货 #' + orderId + '」创建发货单');
        } catch(e) {}
    }

    return { success: true, orderId: orderId, oldStatus: stage, newStatus: nextStatus };
}

// 驳回订单
async function rejectOrderStage(orderId, stage, reviewerId, reviewerName, comment) {
    var order = query("SELECT * FROM sales_orders WHERE id = ? AND status = ?", [orderId, stage])[0];
    if (!order) return { success: false, reason: '订单不存在或状态不正确' };

    var flow = ORDER_FLOW[stage];
    var targetStatus = (flow && flow.reject) ? flow.reject : 'DRAFT';

    run("UPDATE sales_orders SET status=?, updated_at=datetime('now') WHERE id=?", [targetStatus, orderId]);
    try { run("INSERT INTO order_approvals (order_id, approver_id, action, comment, created_at) VALUES (?,?,?,?,datetime('now'))", [orderId, reviewerId, 'REJECT', comment || '审批驳回']); } catch(e) {}

    // 发送驳回卡片给申请人
    var applicant = query("SELECT id, name, feishu_open_id FROM users WHERE id = ?", [order.applicant_id])[0];
    if (applicant?.feishu_open_id) {
        try { await sendFeishuCard(applicant.feishu_open_id, 'open_id', buildOrderResultCard(order, 'REJECTED', reviewerName, comment)); } catch(e) {}
    }

    try {
        await sendFeishuToGroup('❌ **订单审批驳回** #' + orderId + '\n' +
            '🔖 ' + (order.order_no || 'SO#'+orderId) + ' | 🏢 ' + order.customer_name + '\n' +
            '👤 驳回人：' + (reviewerName || '系统') + '\n' +
            '💬 原因：' + (comment || '请修改后重新提交') + '\n' +
            '💡 请修改订单信息后重新提交审批');
    } catch(e) {}

    return { success: true, orderId: orderId, newStatus: targetStatus };
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

// ---------- 给所有审批人（ADMIN/SALES/ENGINEER）发飞书消息 ----------
async function sendFeishuToApprovers(text) {
    if (!larkClient) return { success: false, sent: 0, reason: '飞书客户端未初始化' };
    const admins = query('SELECT id, name, role FROM users WHERE role IN (?, ?, ?)', ['ADMIN', 'SALES', 'ENGINEER']);
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
                const roleNames = { ADMIN: '系统管理员', SALES: '辅导员', ENGINEER: '老师', PLANNER: '学生', EMPLOYEE: '员工' };
                const roleName = roleNames[sysUser.role] || sysUser.role;
                console.log('[飞书] 绑定成功: ' + senderId + ' → ' + sysUser.name + ' (' + sysUser.role + ')');

                let tipsMsg = '✅ 绑定成功！' + sysUser.name + '（' + roleName + '）\n\n以后直接发消息即可操作：\n';
                if (sysUser.role === 'PLANNER') {
                    tipsMsg += '📝 下订单 → 说「我要下订单」\n' +
                        '🔍 查订单 → 说「我的订单」\n' +
                        '📊 统计 → 说「交付率统计」';
                } else if (['SALES', 'ENGINEER', 'ADMIN'].includes(sysUser.role)) {
                    tipsMsg += '✅ 审批 → 回复「同意 #编号」确认评审\n' +
                        '📊 查看 → 说「待审批订单」或「交付率统计」\n' +
                        '📢 通知 → 说「发消息给工程部XX」';
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
                        const roleLabel = {ADMIN:'👑管理员',SALES:'🎓辅导员',ENGINEER:'👨‍🏫老师',PLANNER:'🧑‍🎓学生',EMPLOYEE:'💼员工'}[user.role]||user.role;
                        const isManager = ['ADMIN','SALES','ENGINEER'].includes(user.role);
                        console.log('[飞书] 🎯 自动识别: open_id=' + senderId.slice(0,12) + ' → ' + user.name + ' (' + user.role + ') ' + (isManager?'管理者':'成员'));
                        await sendFeishuMsg(chatId, `🎯 已自动识别你的身份：${user.name}（${roleLabel}）

` +
                            (isManager ? '你拥有审批权限，可以直接审核销售订单流程！' : '你有问题随时找我下订单或查数据～') +
                            `\n\n💡 如身份不对，请回复「我不是${user.name}」`);
                    }
                }
            } catch (e) {
                console.warn('[飞书] 自动识别失败:', e.message);
            }
        }

        if (!user) {
            const allUsers = query('SELECT name, role FROM users LIMIT 10');
            const userList = allUsers.map(u => u.name + '(' + ({ADMIN:'管理员',SALES:'辅导员',ENGINEER:'老师',PLANNER:'学生',EMPLOYEE:'员工'}[u.role]||u.role) + ')').join('、');
            await sendFeishuMsg(chatId,
                '👋 你好！我是销售订货助手。\n\n' +
                '⚠️ 当前还没有绑定你的身份。\n\n' +
                '🔗 请回复：「我是你的名字」\n   例如：「我是赵采购」\n\n' +
                '系统中已有用户：' + userList + '\n\n' +
                '绑定后我就能帮你下订单、查订单、看统计啦！');
            return;
        }

        console.log('[飞书] 当前身份: ' + user.name + ' (' + user.role + ')');

        // ========== Router Agent 智能路由（v6.0 全 AI 驱动 + 销售角色）==========
        if (aiAgents && dbHelper) {
            try {
                const context = {
                    userId: user.id,
                    userName: user.name,
                    userRole: user.role,
                    isAdmin: (user.role === 'ADMIN' || user.role === 'SALES'),
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

                // ===== v6.0: 订单审批指令预处理（同意/驳回 #订单ID）=====
                var orderApproveMatch = content.match(/(同意|批准|通过|ok|yes|确认|同意并|可以)\s*#(\d+)/i);
                var orderRejectMatch = content.match(/(驳回|拒绝|不同意|不准|不行|不批|退回|返回)\s*#(\d+)/i);
                if (orderApproveMatch || orderRejectMatch) {
                    var isOrderApprove = !!orderApproveMatch;
                    var orderMatch = orderApproveMatch || orderRejectMatch;
                    var targetId = parseInt(orderMatch[2]);
                    var orderCheck = query('SELECT * FROM sales_orders WHERE id = ?', [targetId])[0];
                    var leaveCheck = query('SELECT * FROM leave_requests WHERE id = ?', [targetId])[0];

                    if (orderCheck && !leaveCheck) {
                        if (isOrderApprove) {
                            var approveResult = await approveOrderStage(targetId, orderCheck.status, user.id, user.name,
                                (orderApproveMatch[1] || '同意') + ' (飞书快捷审批)');
                            if (approveResult.success) {
                                await sendFeishuMsg(chatId,
                                    '\u2705 **订单审批通过** #' + targetId + '\n\n' +
                                    '\u{1F516} ' + (orderCheck.order_no || 'SO#'+orderCheck.id) + '\n' +
                                    '\u{1F3E2} ' + orderCheck.customer_name + '\n' +
                                    '\u{1F4E6} ' + orderCheck.product_name + ' \u00D7 ' + orderCheck.quantity + 'PCS\n' +
                                    '\u{1F504} ' + (ORDER_STATUS[orderCheck.status] || orderCheck.status) + ' \u2192 **' + (ORDER_STATUS[approveResult.newStatus] || approveResult.newStatus) + '**');
                            } else {
                                await sendFeishuMsg(chatId, '\u274C 订单审批失败：' + (approveResult.reason || '未知错误'));
                            }
                        } else {
                            var rejectResult = await rejectOrderStage(targetId, orderCheck.status, user.id, user.name,
                                (orderRejectMatch[1] || '驳回') + ' (飞书快捷审批)');
                            if (rejectResult.success) {
                                await sendFeishuMsg(chatId,
                                    '\u274C **订单已驳回** #' + targetId + '\n\n' +
                                    '\u{1F516} ' + (orderCheck.order_no || 'SO#'+orderCheck.id) + '\n' +
                                    '\u{1F3E2} ' + orderCheck.customer_name + '\n' +
                                    '\u{1F4A1} 请修改订单信息后重新提交审批。');
                            } else {
                                await sendFeishuMsg(chatId, '\u274C 驳回失败：' + (rejectResult.reason || '未知错误'));
                            }
                        }
                        return;
                    }
                }

                var submitMatch = content.match(/(提交审批|提交审核|送审|发起审批)\s*#(\d+)/i);
                if (submitMatch) {
                    var submitId = parseInt(submitMatch[2]);
                    var submitOrder = query('SELECT * FROM sales_orders WHERE id = ? AND status = \'DRAFT\'', [submitId])[0];
                    if (submitOrder) {
                        var submitResult = await submitOrderForReview(submitId);
                        if (submitResult.success) {
                            await sendFeishuMsg(chatId,
                                '\u2705 **订单已提交审批** #' + submitId + '\n\n' +
                                '\u{1F516} ' + (submitOrder.order_no || 'SO#'+submitOrder.id) + '\n' +
                                '\u{1F3E2} ' + submitOrder.customer_name + '\n' +
                                '\u{1F504} 草稿 \u2192 **待工程部BOM评审**\n\n' +
                                '\u{1F4A1} 工程部将收到飞书审批卡片');
                        } else {
                            await sendFeishuMsg(chatId, '\u274C 提交失败：' + (submitResult.reason || '未知错误'));
                        }
                        return;
                    }
                }

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
                    '👋 你好！我是销售订货助手小流。\n\n' +
                    '当前 AI 系统正在初始化或维护中，暂时无法智能回答。\n' +
                    '你可以尝试以下功能：\n' +
                    '📝 说「我要下订单」创建销售订单\n' +
                    '✅ 说「我的订单」查询订单列表\n' +
                    '📊 说「交付率统计」查看数据\n\n' +
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
async function sendOrderReminder(pendingOrders) {
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
            const pendingOrders = query(
                `SELECT so.*, u.name as applicant_name FROM sales_orders so LEFT JOIN users u ON so.applicant_id = u.id WHERE so.status IN ('PENDING_ENG','PENDING_PLAN','PENDING_BIZ')`
            );
            if (pendingOrders.length > 0) {
                console.log(`[定时任务] 发现 ${pendingOrders.length} 个待审批订单`);
                await sendOrderReminder(pendingOrders);
            } else {
                console.log('[定时任务] 当前没有待审批订单');
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
                { value: 'SALES', label: '辅导员', desc: '请假审批、公文审批' },
                { value: 'ENGINEER', label: '老师', desc: '请假审批、课程管理' },
                { value: 'PLANNER', label: '学生', desc: '请假申请、查看记录' },
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
        // 销售订单卡片操作 (v6.0)
        if (action.order_id || (typeof action.action === 'string' && action.action.startsWith('order_'))) {
            console.log('[卡片] 收到订单操作: ' + JSON.stringify(action));
            var orderId = parseInt(action.order_id);
            if (!orderId) return res.json({ code: 0, msg: 'no order_id' });

            var operator = getSystemUserByFeishuId(openId);
            if (!operator) return res.json({ code: 0, msg: 'user not bound' });

            var order = query("SELECT * FROM sales_orders WHERE id = ?", [orderId])[0];
            if (!order) return res.json({ code: 0, msg: 'order not found' });

            var result = null;

            // 提交审批
            if (action.action === 'order_submit') {
                result = await submitOrderForReview(orderId);
                console.log('[卡片] ' + operator.name + ' 提交订单 #' + orderId + ' 审批');
            }
            // 工程部确认
            else if (action.action === 'order_eng_approve') {
                result = await approveOrderStage(orderId, 'PENDING_ENG', operator.id, operator.name, '工程部BOM评审通过');
                console.log('[卡片] ' + operator.name + ' 工程确认订单 #' + orderId);
            }
            // 工程部返回
            else if (action.action === 'order_eng_reject') {
                result = await rejectOrderStage(orderId, 'PENDING_ENG', operator.id, operator.name, '工程部BOM评审返回修改');
                console.log('[卡片] ' + operator.name + ' 工程返回订单 #' + orderId);
            }
            // 计划部确认
            else if (action.action === 'order_plan_approve') {
                result = await approveOrderStage(orderId, 'PENDING_PLAN', operator.id, operator.name, '计划部交期评审通过');
                console.log('[卡片] ' + operator.name + ' 计划确认订单 #' + orderId);
            }
            // 计划部返回
            else if (action.action === 'order_plan_reject') {
                result = await rejectOrderStage(orderId, 'PENDING_PLAN', operator.id, operator.name, '计划部交期无法满足');
                console.log('[卡片] ' + operator.name + ' 计划返回订单 #' + orderId);
            }
            // 业务部确认
            else if (action.action === 'order_biz_confirm') {
                result = await approveOrderStage(orderId, 'PENDING_BIZ', operator.id, operator.name, '业务部最终确认通过');
                console.log('[卡片] ' + operator.name + ' 业务确认订单 #' + orderId);
            }
            // 业务部返回
            else if (action.action === 'order_biz_reject') {
                result = await rejectOrderStage(orderId, 'PENDING_BIZ', operator.id, operator.name, '业务部返回修改');
                console.log('[卡片] ' + operator.name + ' 业务返回订单 #' + orderId);
            }
            // 采购部确认
            else if (action.action === 'order_purchase_approve') {
                result = await approveOrderStage(orderId, 'PENDING_PURCHASE', operator.id, operator.name, '采购部审核通过');
                console.log('[卡片] ' + operator.name + ' 采购确认订单 #' + orderId);
            }
            // 采购部返回
            else if (action.action === 'order_purchase_reject') {
                result = await rejectOrderStage(orderId, 'PENDING_PURCHASE', operator.id, operator.name, '采购部审核返回');
                console.log('[卡片] ' + operator.name + ' 采购返回订单 #' + orderId);
            }
            // 品质部确认
            else if (action.action === 'order_quality_approve') {
                result = await approveOrderStage(orderId, 'PENDING_QUALITY', operator.id, operator.name, '品质部审核通过');
                console.log('[卡片] ' + operator.name + ' 品质确认订单 #' + orderId);
            }
            // 品质部返回
            else if (action.action === 'order_quality_reject') {
                result = await rejectOrderStage(orderId, 'PENDING_QUALITY', operator.id, operator.name, '品质部审核返回');
                console.log('[卡片] ' + operator.name + ' 品质返回订单 #' + orderId);
            }
            // 发货确认
            else if (action.action === 'order_delivery_approve') {
                var deliveryId = parseInt(action.delivery_id) || 0;
                run("UPDATE delivery_notes SET status='APPROVED', financial_reviewer_id=?, updated_at=datetime('now') WHERE id=?", [operator.id, deliveryId]);
                run("UPDATE sales_orders SET status='DELIVERED', shipped_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [orderId]);
                result = { success: true, orderId: orderId, newStatus: 'DELIVERED' };
                console.log('[卡片] ' + operator.name + ' 财务确认发货 #' + orderId);
            }
            else if (action.action === 'order_delivery_reject') {
                var deliveryId2 = parseInt(action.delivery_id) || 0;
                run("UPDATE delivery_notes SET status='REJECTED', updated_at=datetime('now') WHERE id=?", [deliveryId2]);
                result = { success: true, orderId: orderId, newStatus: 'APPROVED' };
                console.log('[卡片] ' + operator.name + ' 财务拒绝发货 #' + orderId);
            }

            if (result && !result.success) {
                console.error('[卡片] 订单操作失败:', result.reason);
            }
            return res.json({ code: 0, msg: result?.success ? 'success' : (result?.reason || 'error') });
        }

        // 联络单审批
        if (action.action === 'contact_approve' && action.id) {
            var cardOp1 = getSystemUserByFeishuId(openId);
            if (!cardOp1) return res.json({ code: 0, msg: 'user not bound' });
            run("UPDATE contact_forms SET status='approved', approver_id=?, approver_comment='已批准' WHERE id=?", [cardOp1.id, parseInt(action.id)]);
            console.log('[飞书卡片] 联络单审批通过 #' + action.id);
            return res.json({ code: 0, msg: 'approved' });
        }
        if (action.action === 'contact_reject' && action.id) {
            var cardOp2 = getSystemUserByFeishuId(openId);
            if (!cardOp2) return res.json({ code: 0, msg: 'user not bound' });
            run("UPDATE contact_forms SET status='rejected', approver_id=?, approver_comment='已驳回' WHERE id=?", [cardOp2.id, parseInt(action.id)]);
            console.log('[飞书卡片] 联络单驳回 #' + action.id);
            return res.json({ code: 0, msg: 'rejected' });
        }
        // 生产周期审批
        if (action.action === 'cycle_approve' && action.product_code) {
            var cardOp3 = getSystemUserByFeishuId(openId);
            if (!cardOp3) return res.json({ code: 0, msg: 'user not bound' });
            run("UPDATE production_cycles SET approver_id=?, valid_from=date('now'), valid_to=date('now','+6 months') WHERE product_code=?", [cardOp3.id, action.product_code]);
            console.log('[飞书卡片] 生产周期审批通过 ' + action.product_code);
            return res.json({ code: 0, msg: 'approved' });
        }
        if (action.action === 'cycle_reject' && action.product_code) {
            console.log('[飞书卡片] 生产周期驳回 ' + action.product_code);
            return res.json({ code: 0, msg: 'rejected' });
        }

        // 请假卡片操作（保留兼容）
        if (!action.leave_id) return res.json({ code: 0, msg: 'done' });
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


// ============================================================
//  销售订单审批 API 路由（v6.0 - 飞书端完整审批流程）
// ============================================================

// 提交订单进入审批流程
app.post('/api/orders/:id/submit', auth, async (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        var result = await submitOrderForReview(orderId);
        if (result.success) res.json({ message: '订单已提交审批', status: result.newStatus, cardSent: result.cardSent });
        else res.status(400).json({ message: result.reason || '提交失败' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 审批当前阶段（自动识别审批人角色和订单当前状态）
app.post('/api/orders/:id/approve', auth, async (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        var order = query("SELECT * FROM sales_orders WHERE id = ?", [orderId])[0];
        if (!order) return res.status(404).json({ message: '订单不存在' });
        if (!ORDER_FLOW[order.status]) return res.status(400).json({ message: '订单当前状态不可审批: ' + order.status });

        var user = query("SELECT * FROM users WHERE id = ?", [req.userId])[0];
        var comment = req.body.comment || '';

        var result = await approveOrderStage(orderId, order.status, req.userId, user?.name || '用户', comment);
        if (result.success) res.json({ message: '审批通过', oldStatus: result.oldStatus, newStatus: result.newStatus });
        else res.status(400).json({ message: result.reason || '审批失败' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 驳回当前阶段
app.post('/api/orders/:id/reject', auth, async (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        var order = query("SELECT * FROM sales_orders WHERE id = ?", [orderId])[0];
        if (!order) return res.status(404).json({ message: '订单不存在' });

        var user = query("SELECT * FROM users WHERE id = ?", [req.userId])[0];
        var comment = req.body.comment || '需要修改';

        var result = await rejectOrderStage(orderId, order.status, req.userId, user?.name || '用户', comment);
        if (result.success) res.json({ message: '已驳回', newStatus: result.newStatus });
        else res.status(400).json({ message: result.reason || '操作失败' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 创建发货单
app.post('/api/orders/:id/deliver', auth, async (req, res) => {
    try {
        var orderId = parseInt(req.params.id);
        var order = query("SELECT * FROM sales_orders WHERE id = ? AND status = 'APPROVED'", [orderId])[0];
        if (!order) return res.status(400).json({ message: '订单不存在或未批准' });

        var now = new Date();
        var dno = 'DN' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
        var r = run("INSERT INTO delivery_notes (delivery_no, order_id, customer_name, product_name, quantity, status, created_by) VALUES (?,?,?,?,?,?,?)",
            [dno, orderId, order.customer_name, order.product_name, order.quantity, 'PENDING', req.userId]);

        // 发送发货确认卡片给财务部
        var fnUsers = query("SELECT id, name, feishu_open_id FROM users WHERE role IN ('FINANCE','ADMIN','DIRECTOR')");
        var deliveryNote = query("SELECT * FROM delivery_notes WHERE id = ?", [r.lastID])[0];
        if (deliveryNote) {
            var delCard = buildDeliveryReviewCard(order, deliveryNote);
            for (var i = 0; i < fnUsers.length; i++) {
                if (fnUsers[i].feishu_open_id) {
                    try { await sendFeishuCard(fnUsers[i].feishu_open_id, 'open_id', delCard); } catch(e) {}
                }
            }
            try { await sendFeishuToGroup('📦 **新发货单待财务审核**\n🔖 ' + (order.order_no||'#'+orderId) + ' | 🏢 ' + order.customer_name + '\n💡 财务部请在卡片中确认出库'); } catch(e) {}
        }

        res.json({ message: '发货单已创建', deliveryId: r.lastID, deliveryNo: dno });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 获取订单详情（含审批记录）
app.get('/api/orders/:id', auth, (req, res) => {
    try {
        var order = query("SELECT * FROM sales_orders WHERE id = ?", [parseInt(req.params.id)])[0];
        if (!order) return res.status(404).json({ message: '订单不存在' });
        var approvals = query("SELECT oa.*, u.name as approver_name FROM order_approvals oa LEFT JOIN users u ON oa.approver_id = u.id WHERE oa.order_id = ? ORDER BY oa.created_at ASC", [order.id]);
        var deliveryNotes = query("SELECT * FROM delivery_notes WHERE order_id = ? ORDER BY created_at DESC", [order.id]);
        res.json({ order: order, approvals: approvals, deliveryNotes: deliveryNotes });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 获取待审批订单列表
app.get('/api/orders/pending', auth, (req, res) => {
    try {
        var orders = query("SELECT * FROM sales_orders WHERE status IN ('PENDING_ENG','PENDING_PLAN','PENDING_BIZ','PENDING_PURCHASE','PENDING_QUALITY') ORDER BY created_at DESC");
        res.json(orders);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 获取全部订单列表
app.get('/api/orders', auth, (req, res) => {
    try {
        var { status, customer } = req.query;
        var sql = "SELECT o.*, u.name as applicant_name FROM sales_orders o LEFT JOIN users u ON o.applicant_id = u.id WHERE 1=1";
        var params = [];
        if (status) { sql += ' AND o.status = ?'; params.push(status); }
        if (customer) { sql += ' AND o.customer_name LIKE ?'; params.push('%' + customer + '%'); }
        sql += ' ORDER BY o.created_at DESC LIMIT 50';
        var orders = query(sql, params);
        res.json(orders);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 创建订单（API）
app.post('/api/orders', auth, async (req, res) => {
    try {
        var { customer_name, product_name, quantity, delivery_date, is_new_product, product_type, special_requirements, attachment_note, is_rush } = req.body;
        var now = new Date();
        var orderNo = 'SO' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
        var r = run("INSERT INTO sales_orders (order_no, customer_name, product_name, quantity, delivery_date, is_new_product, product_type, special_requirements, attachment_note, is_rush, status, applicant_id, applicant_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, (SELECT name FROM users WHERE id = ?))",
            [orderNo, customer_name, product_name, quantity, delivery_date, is_new_product?1:0, product_type||'standard', special_requirements||'', attachment_note||'', is_rush?1:0, 'DRAFT', req.userId, req.userId]);
        try { await sendFeishuToGroup('📝 **新销售订单已创建**\n🔖 ' + orderNo + ' | 🏢 ' + customer_name + '\n📦 ' + product_name + ' × ' + quantity + 'PCS\n💡 回复「提交审批 #' + r.lastID + '」进入评审流程'); } catch(e) {}
        res.json({ id: r.lastID, order_no: orderNo, message: '订单已创建' });
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
        // ADMIN/SALES/ENGINEER 可看全部请假，PLANNER 只看自己的
        const canSeeAll = user && ['ADMIN', 'SALES', 'ENGINEER'].includes(user.role);
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
                `SELECT id, name, role FROM users WHERE role IN ('SALES', 'ADMIN') OR (role = 'ENGINEER' AND department LIKE ?)`,
                ['%' + (applicant.department || '').replace(/[0-9]+级$/, '') + '%']
            );
            if (approvers.length === 0) {
                // 如果没有匹配的老师，通知所有辅导员和管理员
                const fallbackApprovers = query(`SELECT id, name, role FROM users WHERE role IN ('SALES', 'ADMIN')`);
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
        const canSeeAll = cur && ['ADMIN', 'SALES', 'ENGINEER'].includes(cur.role);
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
        const canSeeAll = user && ['ADMIN', 'SALES', 'MANAGER'].includes(user.role);
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
        
        // 5.2.1 新产品验证
        if (b.is_new_product) {
            var existingReview=query('SELECT id,review_result FROM new_product_reviews WHERE product_code=? OR product_name=? ORDER BY created_at DESC LIMIT 1',[b.product_code||'',b.product_name||'']);
            if(existingReview.length>0 && existingReview[0].review_result==='pending'){
                return res.status(400).json({message:'5.2.1 该新产品评审未通过，暂不允许下订单'});
            }
        }
        // 5.2.3 交期验证
        if(b.delivery_date && b.product_code){
            var cycle=query('SELECT lead_days FROM production_cycles WHERE product_code=? AND valid_from<=date("now") AND (valid_to IS NULL OR valid_to>=date("now")) ORDER BY created_at DESC LIMIT 1',[b.product_code]);
            if(cycle.length>0){
                var minDate=new Date();minDate.setDate(minDate.getDate()+cycle[0].lead_days);
                var deliveryDate=new Date(b.delivery_date);
                if(deliveryDate<minDate){
                    return res.status(400).json({message:'5.2.3 交期不满足产品生产周期表要求，最早交期'+minDate.toISOString().slice(0,10)});
                }
            }
        }
        // 5.2.4 附页确认
        if(b.has_attachment && !b.attachment_confirmed){
            return res.status(400).json({message:'5.2.4 请确认订单附页内容是否完整'});
        }
        // 5.2.5 不能确认需求
        if(b.has_unconfirmed_requirement && !b.confirm_deadline){
            return res.status(400).json({message:'5.2.5 存在不能确认的需求，请填写预计确认日期'});
        }
        // 5.5 急插单7工作日验证
        if(b.is_rush && b.delivery_date){
            var rushDelivery=new Date(b.delivery_date);
            var today=new Date();
            var workDays=0;
            var tempDate=new Date(today);
            while(tempDate<=rushDelivery){
                var day=tempDate.getDay();
                if(day!==0 && day!==6) workDays++;
                tempDate.setDate(tempDate.getDate()+1);
            }
            if(workDays<7){
                return res.status(400).json({message:'5.5 急插单需至少提前七个工作日，当前仅剩'+workDays+'个工作日'});
            }
        }

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

// ================ 新增业务表 Web API ================

// 联络单
app.get('/api/contact-forms', auth, (req, res) => {
    try { res.json(query('SELECT * FROM contact_forms ORDER BY created_at DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/contact-forms', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.title) return res.status(400).json({ message: '标题不能为空' });
        run("INSERT INTO contact_forms (title,content,department,status,applicant_id) VALUES (?,?,?,'pending',?)",
            [b.title, b.content||'', b.department||'', req.userId]);
        res.json({ success: true, id: query('SELECT last_insert_rowid() as id')[0].id });
// 联络单审批（5.7）
app.post('/api/contact-forms/:id/approve', auth, (req, res) => {
    try {
        var formId = parseInt(req.params.id);
        var action = req.body.action || 'approved';
        var status = action === 'approved' ? 'approved' : 'rejected';
        run("UPDATE contact_forms SET status=?, approver_id=?, approver_comment=? WHERE id=?", [status, req.userId, req.body.comment||'', formId]);
        var form = query('SELECT cf.*, u.name as applicant_name FROM contact_forms cf LEFT JOIN users u ON cf.applicant_id=u.id WHERE cf.id=?', [formId])[0];
        if (form) {
            var statusText = status === 'approved' ? '✅ 已批准' : '❌ 已驳回';
            try { sendFeishuToGroup(statusText + '\n📋 ' + form.title + '\n👤 ' + (form.applicant_name||'')); } catch(ign) {}
        }
        res.json({ success: true, status: status });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 预测计划
app.get('/api/prediction-plans', auth, (req, res) => {
    try { res.json(query('SELECT * FROM prediction_plans ORDER BY created_at DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/prediction-plans', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.month) return res.status(400).json({ message: '预测月份不能为空' });
        run("INSERT INTO prediction_plans (month,target_department,plan_content,status,creator_id) VALUES (?,?,?,'draft',?)",
            [b.month, b.target_department||'', b.plan_content||'', req.userId]);
        res.json({ success: true, id: query('SELECT last_insert_rowid() as id')[0].id });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 生产周期表
app.get('/api/production-cycles', auth, (req, res) => {
    try { res.json(query('SELECT * FROM production_cycles ORDER BY product_code')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/production-cycles', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.product_code) return res.status(400).json({ message: '产品编码不能为空' });
        var today = new Date().toISOString().slice(0,10);
        run("INSERT OR REPLACE INTO production_cycles (product_code,product_name,lead_days,cycle_category,valid_from) VALUES (?,?,?,?,?)",
            [b.product_code, b.product_name||'', b.lead_days||30, b.cycle_category||'standard', today]);
        res.json({ success: true });
// 生产周期审批（5.10）
app.post('/api/production-cycles/:id/approve', auth, (req, res) => {
    try {
        var cycleId = parseInt(req.params.id);
        var action = req.body.action || 'approved';
        run("UPDATE production_cycles SET approver_id=?, valid_from=date('now'), valid_to=date('now','+6 months') WHERE id=?", [req.userId, cycleId]);
        res.json({ success: true, message: action === 'approved' ? '已批准（有效期6个月）' : '已驳回' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 流程汇总
app.get('/api/flow-summary', auth, (req, res) => {
    try {
        var totalOrders = query('SELECT COUNT(*) as c FROM sales_orders')[0].c;
        var pendingReview = query("SELECT COUNT(*) as c FROM sales_orders WHERE status IN ('PENDING_ENG','PENDING_PLAN','PENDING_BIZ')")[0].c;
        var shippedThisMonth = query("SELECT COUNT(*) as c FROM sales_orders WHERE status='shipped' AND shipped_at >= date('now','start of month')")[0].c;
        var latestForecast = query('SELECT month, forecast_quantity FROM monthly_forecasts ORDER BY created_at DESC LIMIT 1')[0];
        var latestDeliveryRate = query('SELECT month, on_time_pct FROM delivery_stats ORDER BY month DESC LIMIT 1')[0];
        var activeCycles = query('SELECT COUNT(*) as c FROM production_cycles WHERE valid_to >= date(\'now\')')[0].c;
        res.json({
            flow: [
                { step: 1, name: '5.1 接收订单', icon: '📥', count: totalOrders },
                { step: 2, name: '5.2 创建订单', icon: '📝', count: totalOrders },
                { step: 3, name: '5.3 订单评审', icon: '🔧', count: pendingReview, status: pendingReview > 0 ? 'pending' : 'done' },
                { step: 4, name: '5.4 订单变更', icon: '🔄', count: query('SELECT COUNT(*) as c FROM change_reviews WHERE created_at >= date(\'now\', \'-7 days\')')[0].c },
                { step: 5, name: '5.5 急插单', icon: '⚡', count: query('SELECT COUNT(*) as c FROM rush_orders WHERE created_at >= date(\'now\', \'-7 days\')')[0].c },
                { step: 6, name: '5.6 发货', icon: '🚚', count: shippedThisMonth },
                { step: 7, name: '5.7 联络单', icon: '📋', count: query('SELECT COUNT(*) as c FROM contact_forms WHERE created_at >= date(\'now\', \'-30 days\')')[0].c },
                { step: 8, name: '5.8 预测计划', icon: '📊', count: latestForecast?.forecast_quantity||0 },
                { step: 9, name: '5.9 交付率', icon: '📈', count: latestDeliveryRate?.on_time_pct||0 },
                { step: 10, name: '5.10 生产周期', icon: '⏱️', count: activeCycles }
            ]
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 交付率统计
app.get('/api/delivery-stats', auth, (req, res) => {
    try { res.json(query('SELECT * FROM delivery_stats ORDER BY month DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/delivery-stats', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.month) return res.status(400).json({ message: '统计月份不能为空' });
        var exist = query('SELECT id FROM delivery_stats WHERE month = ?', [b.month]);
        if (exist.length > 0) {
            run("UPDATE delivery_stats SET total_orders=?, on_time=?, delay_count=?, delay_reason=?, improvement=?, updated_at=datetime('now') WHERE month=?",
                [b.total_orders||0, b.on_time||0, b.delay_count||0, b.delay_reason||'', b.improvement||'', b.month]);
        } else {
            run("INSERT INTO delivery_stats (month,total_orders,on_time,delay_count,delay_reason,improvement) VALUES (?,?,?,?,?,?)",
                [b.month, b.total_orders||0, b.on_time||0, b.delay_count||0, b.delay_reason||'', b.improvement||'']);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 订单变更记录
app.get('/api/order-changes', auth, (req, res) => {
    try {
        var sql = 'SELECT * FROM order_changes';
        if (req.query.order_id) { sql += ' WHERE order_id = ?'; }
        sql += ' ORDER BY created_at DESC';
        var params = req.query.order_id ? [parseInt(req.query.order_id)] : [];
        res.json(query(sql, params));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 发货单
app.get('/api/delivery-notes', auth, (req, res) => {
    try { res.json(query('SELECT * FROM delivery_notes ORDER BY created_at DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});

// 订单审批记录
app.get('/api/order-approvals', auth, (req, res) => {
    try {
        var sql = 'SELECT * FROM order_approvals';
        if (req.query.order_id) { sql += ' WHERE order_id = ?'; }
        sql += ' ORDER BY created_at DESC';
        var params = req.query.order_id ? [parseInt(req.query.order_id)] : [];
        res.json(query(sql, params));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// BOM 物料管理
app.get('/api/bom-materials', auth, (req, res) => {
    try {
        var sql = 'SELECT * FROM bom_materials';
        if (req.query.order_id) { sql += ' WHERE order_id = ?'; }
        sql += ' ORDER BY created_at DESC';
        var params = req.query.order_id ? [parseInt(req.query.order_id)] : [];
        res.json(query(sql, params));
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/bom-materials', auth, (req, res) => {
    try {
        var b = req.body;
        run("INSERT INTO bom_materials (order_id,product_code,material_code,material_name,specification,quantity,unit,status) VALUES (?,?,?,?,?,?,?,'pending')",
            [b.order_id||0, b.product_code||'', b.material_code, b.material_name||'', b.specification||'', b.quantity||0, b.unit||'']);
        res.json({ success: true, id: query('SELECT last_insert_rowid() as id')[0].id });
    } catch (e) { res.status(500).json({ message: e.message }); }
});


// ============================================================
//  销售订货 5.4-5.10 新增 API 路由
// ============================================================

// 5.4 订单变更重新评审
app.post('/api/change-reviews', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.order_id || !b.change_type) return res.status(400).json({ message: '订单ID和变更类型不能为空' });
        run(`INSERT INTO change_reviews (order_id,change_type,change_detail,reason,status,applicant_id) VALUES (?,?,?,?,'pending',?)`,
            [b.order_id, b.change_type, b.change_detail||'', b.reason||'', req.userId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/api/change-reviews', auth, (req, res) => {
    try {
        var sql = 'SELECT cr.*, u.name as applicant_name FROM change_reviews cr LEFT JOIN users u ON cr.applicant_id=u.id WHERE 1=1';
        if (req.query.order_id) sql += ' AND cr.order_id = ?';
        sql += ' ORDER BY cr.created_at DESC';
        res.json(query(sql, req.query.order_id ? [parseInt(req.query.order_id)] : []));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.5 新物料评审
app.post('/api/new-product-reviews', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.product_name) return res.status(400).json({ message: '产品名称不能为空' });
        run(`INSERT INTO new_product_reviews (order_id,product_name,product_code,specification,reviewer_id) VALUES (?,?,?,?,?)`,
            [b.order_id||0, b.product_name, b.product_code||'', b.specification||'', req.userId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/api/new-product-reviews', auth, (req, res) => {
    try { res.json(query('SELECT * FROM new_product_reviews ORDER BY created_at DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.6 急插单管理
app.post('/api/rush-orders', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.order_id) return res.status(400).json({ message: '订单ID不能为空' });
        run(`INSERT INTO rush_orders (order_id,rush_reason,original_delivery,new_delivery,days_ahead,status) VALUES (?,?,?,?,?,'pending')`,
            [b.order_id, b.rush_reason||'', b.original_delivery||'', b.new_delivery||'', b.days_ahead||0]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/api/rush-orders', auth, (req, res) => {
    try {
        var sql = 'SELECT ro.*, so.order_no, so.customer_name FROM rush_orders ro LEFT JOIN sales_orders so ON ro.order_id=so.id WHERE 1=1';
        if (req.query.order_id) sql += ' AND ro.order_id = ?';
        sql += ' ORDER BY ro.created_at DESC';
        res.json(query(sql, req.query.order_id ? [parseInt(req.query.order_id)] : []));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.7 订单确认单
app.post('/api/order-confirmations', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.order_id || !b.customer_name) return res.status(400).json({ message: '订单ID和客户名称不能为空' });
        var now = new Date();
        var confNo = 'CONF' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
        run(`INSERT INTO order_confirmations (order_id,conf_no,customer_name,total_amount,deposit_amount,delivery_terms,payment_terms,confirmed_by,confirmed_at,status) VALUES (?,?,?,?,?,?,?,?,datetime('now'),'confirmed')`,
            [b.order_id, confNo, b.customer_name, b.total_amount||0, b.deposit_amount||0, b.delivery_terms||'', b.payment_terms||'', req.userId]);
        run("UPDATE sales_orders SET status='confirmed', updated_at=datetime('now') WHERE id=?", [b.order_id]);
        res.json({ success: true, conf_no: confNo });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/api/order-confirmations', auth, (req, res) => {
    try { res.json(query('SELECT * FROM order_confirmations ORDER BY created_at DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.8 月度预测计划
app.post('/api/monthly-forecasts', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.month) return res.status(400).json({ message: '月份不能为空' });
        run(`INSERT INTO monthly_forecasts (month,department,product_category,forecast_quantity,notes,creator_id,status) VALUES (?,?,?,?,?,?,'draft')`,
            [b.month, b.department||'', b.product_category||'', b.forecast_quantity||0, b.notes||'', req.userId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/api/monthly-forecasts', auth, (req, res) => {
    try { res.json(query('SELECT mf.*, u.name as creator_name FROM monthly_forecasts mf LEFT JOIN users u ON mf.creator_id=u.id ORDER BY mf.month DESC')); }
    catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.9 库存管理
app.get('/api/inventory', auth, (req, res) => {
    try {
        var sql = 'SELECT * FROM inventory WHERE 1=1';
        if (req.query.category) sql += ' AND category = ?';
        if (req.query.product_code) sql += ' AND product_code = ?';
        sql += ' ORDER BY product_code';
        var p = [];
        if (req.query.category) p.push(req.query.category);
        if (req.query.product_code) p.push(req.query.product_code);
        res.json(query(sql, p));
    } catch (e) { res.status(500).json({ message: e.message }); }
});
app.post('/api/inventory', auth, (req, res) => {
    try {
        var b = req.body;
        if (!b.product_code) return res.status(400).json({ message: '产品编码不能为空' });
        var exist = query('SELECT id FROM inventory WHERE product_code = ?', [b.product_code]);
        if (exist.length > 0) {
            run("UPDATE inventory SET product_name=?,category=?,specification=?,quantity=?,unit=?,location=?,min_stock=?,max_stock=?,updated_at=datetime('now') WHERE product_code=?",
                [b.product_name||'', b.category||'', b.specification||'', b.quantity||0, b.unit||'PCS', b.location||'', b.min_stock||0, b.max_stock||0, b.product_code]);
        } else {
            run("INSERT INTO inventory (product_code,product_name,category,specification,quantity,unit,location,min_stock,max_stock) VALUES (?,?,?,?,?,?,?,?,?)",
                [b.product_code, b.product_name||'', b.category||'', b.specification||'', b.quantity||0, b.unit||'PCS', b.location||'', b.min_stock||0, b.max_stock||0]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 5.10 通知日志
app.get('/api/notification-logs', auth, (req, res) => {
    try { res.json(query('SELECT nl.*, u.name as user_name FROM notification_logs nl LEFT JOIN users u ON nl.user_id=u.id ORDER BY nl.created_at DESC LIMIT 100')); }
    catch (e) { res.status(500).json({ message: e.message }); }
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
        // ADMIN/SALES/ENGINEER 可看全部，PLANNER 只看自己的
        const canSeeAll = user && ['ADMIN', 'SALES', 'ENGINEER'].includes(user.role);
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
    const admins = query('SELECT id, name, role FROM users WHERE role IN (?, ?, ?)', ['ADMIN', 'SALES', 'ENGINEER']);
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

        const isAdmin = ['ADMIN', 'SALES', 'ENGINEER'].includes(user.role);
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
            userRole: user ? user.role : 'PLANNER',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'SALES') : false,
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
            userRole: user ? user.role : 'PLANNER',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'SALES') : false,
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

        // ===== 销售订单快速指令拦截（不经过LLM，直接SQL处理）=====
        var msg = message.trim();
        var fastHit = null;

        console.log('[Agents Router DEBUG] 收到消息: ' + msg.substring(0, 60));

        // 提交审批
        var sm = msg.match(/(提交审批|提交审核|送审|发起审批)\s*#(\d+)/i);
        if (sm) {
            console.log('[Agents Router DEBUG] 匹配到提交审批, ID=' + sm[2]);
            var sid = parseInt(sm[2]);
            var so = query("SELECT * FROM sales_orders WHERE id = ? AND status = 'draft'", [sid])[0];
            if (so) {
                run("UPDATE sales_orders SET status='pending_engineering', updated_at=datetime('now') WHERE id=?", [sid]);
                fastHit = { success: true, content: `✅ **订单 #${sid} 已提交评审！**\n\n📋 ${so.order_no} · ${so.customer_name}\n🔄 状态：草稿 → 🔧 待工程部评审\n\n👉 工程部回复「评审 #${sid} BOM已完成」继续流程` };
            } else {
                fastHit = { success: true, content: `⚠️ 订单 #${sid} 不存在或不是草稿状态。请先创建订单或检查状态。` };
            }
        }

        // 评审指令
        if (!fastHit) {
            var rm = msg.match(/(评审|计划评审|工程评审)\s*#(\d+)/i);
            if (rm) {
                var rid = parseInt(rm[2]);
                var ro = query('SELECT * FROM sales_orders WHERE id = ?', [rid])[0];
                if (!ro) fastHit = { success: true, content: `❌ 订单 #${rid} 不存在。` };
                else {
                    var rComment = msg.replace(rm[0], '').trim() || '评审通过';
                    var rNow = new Date().toISOString();
                    if (ro.status === 'pending_engineering') {
                        run("UPDATE sales_orders SET status='pending_planning', bom_status='completed', reviewer_eng_id=?, reviewer_eng_comment=?, reviewer_eng_at=? WHERE id=?", [req.userId, rComment, rNow, rid]);
                        fastHit = { success: true, content: `✅ **工程部评审完成！** #${rid}\n🔧 ${rComment}\n🔄 下一站：计划部评审\n👉 计划部回复「计划评审 #${rid} 交期...」` };
                    } else if (ro.status === 'pending_planning') {
                        var nd = msg.match(/交期[：:]\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[月/]\d{1,2}[日号]?)/i);
                        if (nd) { var dd = nd[1]; if (/\d{1,2}[月/]/.test(dd)) { var mp = dd.match(/(\d+)[月/](\d+)/); dd = '2026-' + mp[1].padStart(2,'0') + '-' + mp[2].padStart(2,'0'); } ro.delivery_date = dd; run("UPDATE sales_orders SET delivery_date=? WHERE id=?", [dd, rid]); }
                        run("UPDATE sales_orders SET status='pending_confirmation', reviewer_plan_id=?, reviewer_plan_comment=?, reviewer_plan_at=? WHERE id=?", [req.userId, rComment, rNow, rid]);
                        fastHit = { success: true, content: `✅ **计划部评审通过** #${rid}\n💬 ${rComment}\n${ro.delivery_date ? '📅 交期：'+ro.delivery_date+'\n' : ''}🔄 下一站：业务部确认\n👉 业务部回复「确认 #${rid}」` };
                    } else if (ro.status === 'pending_confirmation') {
                        run("UPDATE sales_orders SET status='confirmed', reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?", [req.userId, rComment, rNow, rid]);
                        fastHit = { success: true, content: `✅ **业务部确认完成！订单已生效** #${rid}\n💬 ${rComment}\n🎉 说「发货 #${rid}」安排发货` };
                    } else {
                        fastHit = { success: true, content: `⚠️ 订单 #${rid} 当前状态为「${ro.status}」。\n需要先提交审批：「提交审批 #${rid}」` };
                    }
                }
            }
        }

        // 确认指令
        if (!fastHit) {
            var cm = msg.match(/(确认|业务确认)\s*#(\d+)/i);
            if (cm) {
                var cid = parseInt(cm[2]);
                var co = query('SELECT * FROM sales_orders WHERE id = ?', [cid])[0];
                if (!co) fastHit = { success: true, content: `❌ 订单 #${cid} 不存在。` };
                else if (co.status !== 'pending_confirmation') fastHit = { success: true, content: `⚠️ 订单 #${cid} 当前状态为「${co.status}」，无法确认。` };
                else {
                    run("UPDATE sales_orders SET status='confirmed', reviewer_biz_id=?, reviewer_biz_comment=?, reviewer_biz_at=? WHERE id=?", [req.userId, '确认通过', new Date().toISOString(), cid]);
                    fastHit = { success: true, content: `✅ **业务部确认完成！订单已生效** #${cid}\n🎉 说「发货 #${cid}」安排发货` };
                }
            }
        }

        // 发货指令
        if (!fastHit) {
            var shm = msg.match(/(发货|安排发货|出库|发运)\s*#(\d+)/i);
            if (shm) {
                var shid = parseInt(shm[2]);
                var sho = query('SELECT * FROM sales_orders WHERE id = ?', [shid])[0];
                if (!sho) fastHit = { success: true, content: `❌ 订单 #${shid} 不存在。` };
                else if (sho.status !== 'confirmed') fastHit = { success: true, content: `⚠️ 订单 #${shid} 状态为「${sho.status}」，需确认后才能发货。` };
                else {
                    var dnNo = 'DN' + Date.now().toString(36).toUpperCase();
                    run("UPDATE sales_orders SET status='shipped', shipped_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [shid]);
                    run("INSERT INTO delivery_notes (order_id,delivery_no,warehouse_status,shipped_at,created_at) VALUES (?,?,'shipped',datetime('now'),datetime('now'))", [shid, dnNo]);
                    fastHit = { success: true, content: `🚚 **发货通知：订单已发货！** #${shid}\n📋 ${sho.order_no} · ${sho.customer_name}\n📦 ${sho.product_type || ''} × ${sho.quantity}${sho.unit || 'PCS'}\n🔖 发货单号：${dnNo}\n📅 发货时间：${new Date().toLocaleString('zh-CN')}\n🎉 订单流程完成！` };
                }
            }
        }

        // 变更指令
        if (!fastHit) {
            var chm = msg.match(/(变更|修改订单|改订单)\s*#(\d+)/i);
            if (chm) {
                var chid = parseInt(chm[2]);
                var cho = query('SELECT * FROM sales_orders WHERE id = ?', [chid])[0];
                if (!cho) fastHit = { success: true, content: `❌ 订单 #${chid} 不存在。` };
                else if (cho.status === 'shipped' || cho.status === 'cancelled') fastHit = { success: true, content: `⚠️ 订单 #${chid} 已${cho.status === 'shipped' ? '发货' : '取消'}，无法变更。` };
                else {
                    var chNote = msg.replace(chm[0], '').trim() || '客户要求变更';
                    run("UPDATE sales_orders SET status='draft', change_notes=?, updated_at=datetime('now') WHERE id=?", [chNote, chid]);
                    run("INSERT INTO order_changes (order_id,change_type,change_reason,applicant_id,created_at) VALUES (?,?,?,?,datetime('now'))", [chid, 'modification', chNote, req.userId]);
                    fastHit = { success: true, content: `✅ **订单已变更，回到草稿状态** #${chid}\n💬 ${chNote}\n🔄 修改后说「提交审批 #${chid}」重新提交` };
                }
            }
        }

        // 驳回/审批
        if (!fastHit) {
            var am = msg.match(/(同意|审批通过|通过|批准)\s*#(\d+)/i);
            var bm = msg.match(/(驳回|拒绝|不同意)\s*#(\d+)/i);
            var match = am || bm;
            if (match) {
                var isApprove = !!am;
                var aid = parseInt(match[2]);
                var ao = query('SELECT * FROM sales_orders WHERE id = ?', [aid])[0];
                if (!ao) fastHit = { success: true, content: `❌ 订单 #${aid} 不存在。` };
                else {
                    var aComment = msg.replace(match[0], '').trim() || (isApprove ? '审批通过' : '已驳回');
                    var aNow = new Date().toISOString();
                    var stages = {
                        'pending_engineering': ['工程部', 'reviewer_eng_id', 'reviewer_eng_comment', 'reviewer_eng_at', 'pending_planning'],
                        'pending_planning': ['计划部', 'reviewer_plan_id', 'reviewer_plan_comment', 'reviewer_plan_at', 'pending_confirmation'],
                        'pending_confirmation': ['业务部', 'reviewer_biz_id', 'reviewer_biz_comment', 'reviewer_biz_at', 'confirmed']
                    };
                    var stage = stages[ao.status];
                    if (stage) {
                        if (isApprove) {
                            run(`UPDATE sales_orders SET status='${stage[4]}', ${stage[1]}=?, ${stage[2]}=?, ${stage[3]}=? WHERE id=?`, [req.userId, aComment, aNow, aid]);
                            fastHit = { success: true, content: `✅ **${stage[0]}审批通过** #${aid}\n💬 ${aComment}\n🔄 流程已推进` };
                        } else {
                            run("UPDATE sales_orders SET status='draft', change_notes=? WHERE id=?", [`${stage[0]}驳回: ${aComment}`, aid]);
                            fastHit = { success: true, content: `❌ **${stage[0]}驳回** #${aid}\n💬 ${aComment}\n🔄 订单已退回草稿状态，请修改后重新提交。` };
                        }
                    } else {
                        fastHit = { success: true, content: `⚠️ 订单 #${aid} 当前状态为「${ao.status}」，无需审批。` };
                    }
                }
            }
        }

        if (fastHit) {
            console.log('[Agents Router] 快速拦截命中: ' + msg.slice(0, 40));
            return res.json(fastHit);
        }

        const context = {
            userId: req.userId,
            userName: user ? user.name : '用户#' + req.userId,
            userRole: user ? user.role : 'PLANNER',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'SALES') : false,
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
            userRole: user ? user.role : 'PLANNER',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'SALES') : false,
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
            userRole: user ? user.role : 'PLANNER',
            isAdmin: user ? (user.role === 'ADMIN' || user.role === 'SALES') : false
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

            const isAdmin = ['ADMIN', 'SALES', 'ENGINEER'].includes(user.role);
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
app.get('/sales', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sales.html')));
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
    console.log('📋 销售订货 + AI 多智能体系统 v6.0');
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
    submitOrderForReview: submitOrderForReview,
    approveOrderStage: approveOrderStage,
    rejectOrderStage: rejectOrderStage,
    buildOrderReviewCard: buildOrderReviewCard,
    buildOrderResultCard: buildOrderResultCard,
    ORDER_FLOW: ORDER_FLOW,
    ORDER_STATUS: ORDER_STATUS,
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
            { name: 'users', sql: `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT DEFAULT '', name TEXT NOT NULL, role TEXT DEFAULT 'PLANNER', department TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
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
            )` },
            { name: 'order_approvals', sql: `CREATE TABLE IF NOT EXISTS order_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, approver_id INTEGER, approver_name TEXT DEFAULT '', stage TEXT NOT NULL, action TEXT NOT NULL, comment TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'delivery_notes', sql: `CREATE TABLE IF NOT EXISTS delivery_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, delivery_no TEXT UNIQUE NOT NULL, warehouse_status TEXT DEFAULT 'pending', financial_status TEXT DEFAULT 'pending', financial_reviewer_id INTEGER, shipped_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'order_changes', sql: `CREATE TABLE IF NOT EXISTS order_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, change_type TEXT NOT NULL, change_reason TEXT DEFAULT '', old_value TEXT DEFAULT '', new_value TEXT DEFAULT '', status TEXT DEFAULT 'pending', applicant_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'contact_forms', sql: `CREATE TABLE IF NOT EXISTS contact_forms (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT DEFAULT '', department TEXT DEFAULT '', status TEXT DEFAULT 'pending', applicant_id INTEGER, approver_id INTEGER, approver_comment TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'prediction_plans', sql: `CREATE TABLE IF NOT EXISTS prediction_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, target_department TEXT DEFAULT '', plan_content TEXT DEFAULT '', status TEXT DEFAULT 'draft', creator_id INTEGER, approver_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'production_cycles', sql: `CREATE TABLE IF NOT EXISTS production_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, product_code TEXT NOT NULL, product_name TEXT DEFAULT '', lead_days INTEGER NOT NULL, cycle_category TEXT DEFAULT 'standard', valid_from TEXT NOT NULL, valid_to TEXT, approver_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'bom_materials', sql: `CREATE TABLE IF NOT EXISTS bom_materials (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product_code TEXT DEFAULT '', material_code TEXT NOT NULL, material_name TEXT DEFAULT '', specification TEXT DEFAULT '', quantity REAL DEFAULT 0, unit TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'delivery_stats', sql: `CREATE TABLE IF NOT EXISTS delivery_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL UNIQUE, total_orders INTEGER DEFAULT 0, on_time INTEGER DEFAULT 0, delay_count INTEGER DEFAULT 0, on_time_pct REAL DEFAULT 0, delay_reason TEXT DEFAULT '', improvement TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'inventory', sql: `CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, product_code TEXT NOT NULL, product_name TEXT DEFAULT '', category TEXT DEFAULT '', specification TEXT DEFAULT '', quantity REAL DEFAULT 0, unit TEXT DEFAULT 'PCS', location TEXT DEFAULT '', min_stock REAL DEFAULT 0, max_stock REAL DEFAULT 0, last_check_at TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'monthly_forecasts', sql: `CREATE TABLE IF NOT EXISTS monthly_forecasts (id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, department TEXT DEFAULT '', product_category TEXT DEFAULT '', forecast_quantity REAL DEFAULT 0, actual_quantity REAL DEFAULT 0, variance REAL DEFAULT 0, notes TEXT DEFAULT '', creator_id INTEGER, status TEXT DEFAULT 'draft', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'new_product_reviews', sql: `CREATE TABLE IF NOT EXISTS new_product_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product_name TEXT NOT NULL, product_code TEXT DEFAULT '', specification TEXT DEFAULT '', bom_status TEXT DEFAULT 'pending', bom_content TEXT DEFAULT '', sample_status TEXT DEFAULT 'pending', sample_notes TEXT DEFAULT '', review_result TEXT DEFAULT 'pending', reviewer_id INTEGER, reviewed_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'order_confirmations', sql: `CREATE TABLE IF NOT EXISTS order_confirmations (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, conf_no TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, total_amount REAL DEFAULT 0, deposit_amount REAL DEFAULT 0, deposit_paid INTEGER DEFAULT 0, delivery_terms TEXT DEFAULT '', payment_terms TEXT DEFAULT '', confirmed_by INTEGER, confirmed_at TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'rush_orders', sql: `CREATE TABLE IF NOT EXISTS rush_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, rush_reason TEXT DEFAULT '', original_delivery TEXT, new_delivery TEXT, days_ahead INTEGER DEFAULT 0, approved_by INTEGER, approved_at TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'change_reviews', sql: `CREATE TABLE IF NOT EXISTS change_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, change_type TEXT NOT NULL, change_detail TEXT DEFAULT '', reason TEXT DEFAULT '', status TEXT DEFAULT 'pending', applicant_id INTEGER, reviewer_eng_id INTEGER, reviewer_eng_comment TEXT DEFAULT '', reviewer_plan_id INTEGER, reviewer_plan_comment TEXT DEFAULT '', reviewer_biz_id INTEGER, reviewer_biz_comment TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)` },
            { name: 'notification_logs', sql: `CREATE TABLE IF NOT EXISTS notification_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, channel TEXT DEFAULT 'feishu', title TEXT DEFAULT '', content TEXT DEFAULT '', status TEXT DEFAULT 'sent', read_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)` }
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
            console.log(``);
            console.log(``);
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
