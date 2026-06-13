// ============================================================
//  公文流转 + 请假系统 - 全流程 AI 群聊审批版
//  端口：3000 | 数据库：sql.js (纯JS SQLite)
// ============================================================
const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const axios = require('axios');
const fs = require('fs');

// ---------- 环境配置 ----------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'document_flow.db');
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aaa152828fb95bda';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'CSyWDYc75HnNz7k0MLn6EciZ5ajjwNvZ';

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

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
    db.run(sql, params);
    saveDB();
    return { lastID: db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] || 0, changes: db.getRowsModified() };
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

// ---------- 发飞书群消息 ----------
async function sendFeishuMsg(chatId, text) {
    if (!larkClient) return;
    try {
        await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: chatId,
                content: JSON.stringify({ text }),
                msg_type: 'text'
            }
        });
    } catch (err) { console.error('[飞书] 发消息失败:', err.message); }
}

// ---------- 飞书长连接 ----------
async function initLark() {
    try {
        const lark = require('@larksuiteoapi/node-sdk');
        larkClient = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
        const wsClient = new lark.WSClient({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
        
        wsClient.start({
            eventDispatcher: new lark.EventDispatcher({}).register({
                'im.message.receive_v1': async (data) => {
                    await handleFeishuMessage(data);
                }
            })
        });
        
        console.log('[OK] 飞书长连接已启动');
    } catch (err) {
        console.error('[ERROR] 飞书长连接失败:', err.message);
    }
}

// ============================================================
//  AI 意图识别
// ============================================================
function aiDetectIntent(text) {
    const t = text.trim();
    
    // 审批拒绝（优先检测，因为包含否定词）
    const rejectWords = ['不同意', '驳回', '拒绝', '不准', '不行', '否决', '不批'];
    if (rejectWords.some(w => t.includes(w))) {
        const comment = t.replace(/不同意|驳回|拒绝|不准|不行|否决|不批/g, '').trim();
        return { type: 'REJECT', comment: comment || '不予批准' };
    }
    
    // 审批同意
    const approveWords = ['同意', '批准', 'ok', 'okay', '好的', '可以', '准了', '通过', '没问题', '准假', '批了'];
    if (approveWords.some(w => t.toLowerCase().includes(w))) {
        const comment = t.replace(/同意|批准|ok|okay|好的|可以|准了|通过|没问题|准假|批了/gi, '').trim();
        return { type: 'APPROVE', comment: comment || '已批准' };
    }
    
    // 请假意图
    const leaveWords = ['请假', '年假', '事假', '病假', '婚假', '产假', '丧假', '休假'];
    if (leaveWords.some(w => t.includes(w))) {
        return { type: 'LEAVE_REQUEST' };
    }
    
    // 查询意图
    const queryWords = ['我的请假', '请假记录', '请假情况', '我的假', '查看请假', '请假状态', '我请了多少'];
    if (queryWords.some(w => t.includes(w))) {
        return { type: 'QUERY' };
    }
    
    // 绑定意图
    if (t.match(/我是[^\s，,。!！?？]+/) && !leaveWords.some(w => t.includes(w))) {
        return { type: 'BIND' };
    }
    
    return { type: 'UNKNOWN' };
}

// ---------- AI 请假信息解析 ----------
function aiParseLeaveMessage(text) {
    const today = new Date();
    const result = { isLeaveRequest: true, userName: null, type: null, startDate: null, endDate: null, days: null, reason: '' };
    
    // 姓名提取
    const nm = text.match(/我是([^\s，,。!！?？]+)/);
    if (nm) result.userName = nm[1];
    
    // 假期类型
    const typeMap = { '年假': '年假', '事假': '事假', '病假': '病假', '婚假': '婚假', '产假': '产假', '丧假': '丧假' };
    for (const [k, v] of Object.entries(typeMap)) { if (text.includes(k)) { result.type = v; break; } }
    if (!result.type) result.type = '事假'; // 默认事假
    
    // 日期提取
    const dp2 = [...text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)].map(m => `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
    const dp1 = [...text.matchAll(/(\d{1,2})月(\d{1,2})[号日]/g)].map(m => `${today.getFullYear()}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
    const dates = [...dp2, ...dp1];
    if (dates.length >= 2) { result.startDate = dates[0]; result.endDate = dates[1]; }
    else if (dates.length === 1) { result.startDate = result.endDate = dates[0]; }
    
    // 天数
    const dm = text.match(/(\d+)[天日周]/);
    if (dm) result.days = parseInt(dm[1]);
    if (!result.days && result.startDate && result.endDate) {
        const diff = (new Date(result.endDate) - new Date(result.startDate)) / 86400000 + 1;
        result.days = Math.max(1, diff);
    }
    if (!result.days) result.days = 1;
    
    // 事由
    const reasonMatch = text.match(/(?:事由|原因|因为|原因是)([^\s，,。!！?？]+)/);
    if (reasonMatch) result.reason = reasonMatch[1];
    
    return result;
}

// ============================================================
//  飞书全流程消息处理
// ============================================================
async function handleFeishuMessage(data) {
    try {
        const msg = data.message;
        const chatId = msg.chat_id;
        const msgId = msg.message_id;
        const senderId = data.sender?.sender_id?.open_id || data.sender?.id?.open_id || '';
        const chatType = msg.chat_type; // 'p2p' 或 'group'
        
        // 解析消息文本
        let content = '';
        try {
            const parsed = JSON.parse(msg.content);
            content = (parsed.text || '').trim();
        } catch { content = (msg.content || '').trim(); }
        
        // 忽略空消息
        if (!content) return;
        
        console.log(`[飞书] type=${chatType} chat=${chatId} sender=${senderId} msg="${content}"`);
        
        // ========== 意图识别 ==========
        const intent = aiDetectIntent(content);
        console.log(`[飞书] 意图: ${intent.type}`);
        
        if (intent.type === 'LEAVE_REQUEST') {
            // ==================== 请假申请 ====================
            const result = aiParseLeaveMessage(content);
            
            // 确认申请人：飞书映射 > 消息中名字
            let applicant = getSystemUserByFeishuId(senderId);
            if (!applicant && result.userName) {
                applicant = query('SELECT id, username, name, role FROM users WHERE name = ?', [result.userName])[0];
            }
            if (!applicant) {
                await sendFeishuMsg(chatId, '❌ 无法确认你的身份，请先回复「我是你的名字」绑定，例如「我是张三」');
                return;
            }
            
            // 自动绑定
            const existMap = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
            if (existMap.length === 0) {
                run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [senderId, applicant.id]);
                console.log(`[飞书] 自动绑定: ${senderId} → ${applicant.name}`);
            }
            
            // 提交请假
            const leaveId = run(
                `INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, feishu_chat_id, feishu_msg_id) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
                [applicant.id, result.type, result.startDate || '', result.endDate || '', result.days, result.reason || '', chatId, msgId]
            ).lastID;
            
            // 群里发审批通知
            const admins = query('SELECT name FROM users WHERE role = "ADMIN"');
            const adminNames = admins.map(a => a.name).join('、');
            
            await sendFeishuMsg(chatId,
                `📝 请假申请已提交\n\n` +
                `👤 申请人：${applicant.name}\n` +
                `📋 类型：${result.type}\n` +
                `📅 时间：${result.startDate || '待确认'} 至 ${result.endDate || '待确认'}\n` +
                `📊 天数：${result.days}天\n` +
                `💬 事由：${result.reason || '无'}\n\n` +
                `⏳ 等待 ${adminNames} 审批\n\n` +
                `👉 领导请回复「同意」或「不同意」`);
            
            // 微信推送
            await sendWechatNotify(`【请假申请】${applicant.name}`,
                `类型：${result.type}\n时间：${result.startDate} 至 ${result.endDate}\n天数：${result.days}\n事由：${result.reason || '无'}`);
                
        } else if (intent.type === 'APPROVE') {
            // ==================== 审批同意 ====================
            let approver = getSystemUserByFeishuId(senderId);
            if (!approver || approver.role !== 'ADMIN') {
                await sendFeishuMsg(chatId, '⚠️ 只有管理员可以审批请假申请');
                return;
            }
            
            // 找群里最近的待审批请假
            const pending = query(
                `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.feishu_chat_id = ? AND l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 1`,
                [chatId]
            );
            if (pending.length === 0) {
                await sendFeishuMsg(chatId, '当前没有待审批的请假申请');
                return;
            }
            
            const leave = pending[0];
            const comment = intent.comment || '已批准';
            
            run(`UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
                [approver.id, comment, leave.id]);
            
            await sendFeishuMsg(chatId,
                `✅ 请假已批准！\n\n` +
                `👤 申请人：${leave.user_name}\n` +
                `✍️ 审批人：${approver.name}\n` +
                `📋 类型：${leave.type}\n` +
                `📅 时间：${leave.start_date} 至 ${leave.end_date}（${leave.days}天）\n` +
                `💬 审批意见：${comment}\n\n` +
                `🎉 ${leave.user_name}，假期愉快！`);
            
            await sendWechatNotify(`【请假批准】${leave.user_name}`,
                `你的${leave.type}已被${approver.name}批准\n时间：${leave.start_date} 至 ${leave.end_date}`);
                
        } else if (intent.type === 'REJECT') {
            // ==================== 审批驳回 ====================
            let approver = getSystemUserByFeishuId(senderId);
            if (!approver || approver.role !== 'ADMIN') {
                await sendFeishuMsg(chatId, '⚠️ 只有管理员可以审批请假申请');
                return;
            }
            
            const pending = query(
                `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.feishu_chat_id = ? AND l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 1`,
                [chatId]
            );
            if (pending.length === 0) {
                await sendFeishuMsg(chatId, '当前没有待审批的请假申请');
                return;
            }
            
            const leave = pending[0];
            const comment = intent.comment || '不予批准';
            
            run(`UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
                [approver.id, comment, leave.id]);
            
            await sendFeishuMsg(chatId,
                `❌ 请假未通过\n\n` +
                `👤 申请人：${leave.user_name}\n` +
                `✍️ 审批人：${approver.name}\n` +
                `📋 类型：${leave.type}\n` +
                `💬 驳回原因：${comment}`);
                
        } else if (intent.type === 'QUERY') {
            // ==================== 查询请假状态 ====================
            let user = getSystemUserByFeishuId(senderId);
            if (!user) {
                await sendFeishuMsg(chatId, '请先绑定身份，回复「我是你的名字」');
                return;
            }
            
            const leaves = query(
                `SELECT l.type, l.start_date, l.end_date, l.days, l.status, l.reason FROM leave_requests l WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 5`,
                [user.id]
            );
            if (leaves.length === 0) {
                await sendFeishuMsg(chatId, `${user.name}，你目前没有请假记录`);
                return;
            }
            
            const emoji = { PENDING: '⏳', APPROVED: '✅', REJECTED: '❌' };
            let text = `${user.name}的请假记录：\n\n`;
            for (const l of leaves) {
                text += `${emoji[l.status] || '❓'} ${l.type} ${l.start_date}~${l.end_date}（${l.days}天）${l.status === 'PENDING' ? '待审批' : l.status === 'APPROVED' ? '已批准' : '已驳回'}\n   事由：${l.reason || '无'}\n\n`;
            }
            await sendFeishuMsg(chatId, text);
            
        } else if (intent.type === 'BIND') {
            // ==================== 绑定身份 ====================
            const nameMatch = content.match(/我是([^\s，,。!！?？]+)/);
            if (!nameMatch) {
                await sendFeishuMsg(chatId, '请回复「我是你的名字」来绑定，例如「我是张三」');
                return;
            }
            const sysUser = query('SELECT id, name, role FROM users WHERE name = ?', [nameMatch[1]]);
            if (sysUser.length === 0) {
                await sendFeishuMsg(chatId, `❌ 系统中未找到「${nameMatch[1]}」，请联系管理员添加`);
                return;
            }
            
            const existMap = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
            if (existMap.length > 0) {
                run('UPDATE feishu_user_map SET system_user_id = ? WHERE feishu_open_id = ?', [sysUser[0].id, senderId]);
            } else {
                run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [senderId, sysUser[0].id]);
            }
            
            await sendFeishuMsg(chatId,
                `✅ 绑定成功！${nameMatch[1]}（${sysUser[0].role === 'ADMIN' ? '管理员' : '员工'}）\n\n` +
                `以后直接发消息即可操作：\n` +
                `📝 请假 → 说「请假3天 年假 6月15到17号」\n` +
                `🔍 查询 → 说「我的请假记录」`);
            
        } else {
            // ==================== 帮助 ====================
            await sendFeishuMsg(chatId,
                `你好！我是公文流转助手 📋\n\n` +
                `我可以帮你：\n` +
                `📝 请假 → 说「请假3天 年假 6月15到17号 事由团建」\n` +
                `✅ 审批 → 领导回复「同意」或「不同意」\n` +
                `🔍 查询 → 说「我的请假记录」\n` +
                `🔗 绑定 → 说「我是张三」\n\n` +
                `💡 第一次使用请先绑定身份！`);
        }
    } catch (err) {
        console.error('[飞书] 处理失败:', err.message, err.stack);
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
        const users = query('SELECT id, username, name, role FROM users WHERE username = ? AND password = ?', [username, password]);
        if (!users.length) return res.status(401).json({ message: '用户名或密码错误' });
        const user = users[0];
        const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
        res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/auth/me', auth, (req, res) => {
    try {
        const users = query('SELECT id, username, name, role FROM users WHERE id = ?', [req.userId]);
        res.json(users[0] || { message: 'Not found' });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/users', auth, (req, res) => {
    try { res.json(query('SELECT id, username, name, role, created_at FROM users ORDER BY id')); }
    catch (e) { res.status(500).json({ message: e.message }); }
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
            appEnabled: FEISHU_APP_ID !== 'cli_aaa152828fb95bda' && FEISHU_APP_ID.length > 5
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
        const { type, startDate, endDate, days, reason } = req.body;
        const r = run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
            [req.userId, type, startDate, endDate, days, reason || '']);
        const user = query('SELECT name FROM users WHERE id = ?', [req.userId])[0];
        sendWechatNotify('【新请假申请】来自 ' + (user?.name || ''),
            `请假类型：${type}\n时间：${startDate} 至 ${endDate}\n天数：${days}\n事由：${reason || '无'}`);
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
        const w = uid ? `WHERE user_id = ${uid}` : '';
        const total = query(`SELECT COUNT(*) as c FROM leave_requests ${w}`)[0].c;
        const pending = query(`SELECT COUNT(*) as c FROM leave_requests ${w} AND status = 'PENDING'`)[0].c;
        const approved = query(`SELECT COUNT(*) as c FROM leave_requests ${w} AND status = 'APPROVED'`)[0].c;
        const rejected = query(`SELECT COUNT(*) as c FROM leave_requests ${w} AND status = 'REJECTED'`)[0].c;
        res.json({ total, pending, approved, rejected });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 统计
app.get('/api/stats', auth, (req, res) => {
    try {
        res.json({
            totalUsers: query('SELECT COUNT(*) as c FROM users')[0].c,
            totalDocs: query('SELECT COUNT(*) as c FROM documents')[0].c,
            pendingDocs: query(`SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'`)[0].c,
            totalLeave: query('SELECT COUNT(*) as c FROM leave_requests')[0].c,
            pendingLeave: query(`SELECT COUNT(*) as c FROM leave_requests WHERE status = 'PENDING'`)[0].c,
            systemHealth: true
        });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// 微信 Webhook
app.post('/api/wechat/webhook', express.raw({ type: 'application/xml', limit: '1mb' }), async (req, res) => {
    res.json({ success: true });
});

// 飞书 Webhook
app.post('/api/feishu/webhook', async (req, res) => {
    res.json({ success: true });
});

// ============================================================
//  启动
// ============================================================

async function start() {
    try {
        await initDB();
        
        // 建表
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT DEFAULT 'EMPLOYEE',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT,
                type TEXT DEFAULT 'NORMAL',
                priority TEXT DEFAULT 'NORMAL',
                status TEXT DEFAULT 'PENDING',
                applicant_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS leave_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                type TEXT,
                start_date TEXT,
                end_date TEXT,
                days INTEGER,
                reason TEXT,
                status TEXT DEFAULT 'PENDING',
                approver_id INTEGER,
                approver_comment TEXT,
                feishu_chat_id TEXT,
                feishu_msg_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS approvals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id INTEGER,
                approver_id INTEGER,
                action TEXT,
                comment TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS wechat_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT,
                api_key TEXT,
                enabled INTEGER DEFAULT 1
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS feishu_user_map (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feishu_open_id TEXT UNIQUE NOT NULL,
                system_user_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 初始化默认数据
        if (query('SELECT COUNT(*) as c FROM users')[0].c === 0) {
            console.log('[初始化] 正在创建默认数据...');
            run(`INSERT INTO users (username, password, name, role) VALUES ('admin', 'admin123', '管理员', 'ADMIN')`);
            run(`INSERT INTO users (username, password, name, role) VALUES ('zhangsan', '123456', '张三', 'EMPLOYEE')`);
            run(`INSERT INTO users (username, password, name, role) VALUES ('lisi', '123456', '李四', 'EMPLOYEE')`);
            run(`INSERT INTO users (username, password, name, role) VALUES ('wangwu', '123456', '王五', 'EMPLOYEE')`);
            run(`INSERT INTO users (username, password, name, role) VALUES ('zhaoliu', '123456', '赵六', 'EMPLOYEE')`);
            run(`INSERT INTO users (username, password, name, role) VALUES ('sunqi', '123456', '孙七', 'EMPLOYEE')`);
            run(`INSERT INTO wechat_config (provider, api_key, enabled) VALUES ('serverchan', 'SCT359275Tkk3wftrQnVAwazPBPOAWaMIR', 1)`);
            run(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于2024年度工作计划的通知', '请各部门于本周五前提交年度工作计划草案。', 'NOTICE', 'APPROVED', 'HIGH', 1)`);
            run(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于员工福利调整的申请', '建议提高员工餐补标准至每日50元。', 'PROPOSAL', 'PENDING', 'NORMAL', 2)`);
            run(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于办公室搬迁的通知', '市场部将于下周一搬迁至新办公区。', 'NOTICE', 'PENDING', 'LOW', 1)`);
            run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (2, '年假', '2024-06-10', '2024-06-12', 3, '计划带家人去旅游', 'APPROVED', 1)`);
            run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (3, '病假', '2024-06-05', '2024-06-05', 1, '发烧感冒', 'APPROVED', 1)`);
            run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (4, '事假', '2024-06-15', '2024-06-16', 2, '家中装修需要监工', 'PENDING')`);
            console.log('[初始化] 默认数据创建完成');
        }
        
        saveDB();
        await initLark();
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🚀 服务已启动: http://localhost:${PORT}`);
            console.log(`🤖 飞书应用: ${FEISHU_APP_ID}`);
            console.log(`\n📋 飞书群聊使用方式：`);
            console.log(`   1. 绑定身份 → 回复「我是张三」`);
            console.log(`   2. 请假 → 回复「请假3天 年假 6月15到17号 事由团建」`);
            console.log(`   3. 审批 → 领导回复「同意」或「不同意」`);
            console.log(`   4. 查询 → 回复「我的请假记录」`);
        });
    } catch (err) {
        console.error('[ERROR] 启动失败:', err);
        process.exit(1);
    }
}

start();
