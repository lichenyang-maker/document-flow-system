// ============================================================
//  ???? + ???? - ??? AI ?????
//  ??:3000 | ???:sql.js (?JS SQLite)
// ============================================================
const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

// ---------- Auth ?? ----------
let authModule = null;
try {
    authModule = require('./auth-routes');
    console.log('[OK] Auth ?????');
} catch (err) {
    console.error('[WARN] Auth ??????:', err.message);
}

let aiAgents = null;
try {
    aiAgents = require('./ai-agents');
    console.log('[OK] ?????????');
} catch (err) {
    console.error('[WARN] ?????????:', err.message);
}

// ---------- ???? ----------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'document_flow.db');
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aaa152828fb95bda';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'CSyWDYc75HnNz7k0MLn6EciZ5ajjwNvZ';
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY || 'sk-ananqfsipxweyiejefqltsbladjogmgnwfvxnihtjtnxwjem';

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS ??(??????)
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

// ---------- ??? ----------
let db;

async function initDB() {
    const SQL = await initSqlJs();
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log('[OK] ??????:', dbDir);
    }
    if (fs.existsSync(DB_PATH)) {
        db = new SQL.Database(fs.readFileSync(DB_PATH));
        console.log('[OK] ??????:', DB_PATH);
    } else {
        db = new SQL.Database();
        console.log('[OK] ?????');
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
    // sql.js ??? prepare + bind + step ????????? SQL
    if (params && params.length > 0) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        stmt.step();
        stmt.free();
    } else {
        db.run(sql);
    }
    // ??: ??? saveDB() (???? db.export()) ???? last_insert_rowid()
    // db.export() ??? last_insert_rowid() ? 0
    let lastId = 0;
    try {
        const lr = db.exec('SELECT last_insert_rowid() as id')[0];
        if (lr && lr.values && lr.values[0]) lastId = lr.values[0][0];
    } catch (e) { lastId = 0; }
    saveDB();
    return { lastID: lastId, changes: db.getRowsModified() };
}

// ---------- ?????(??) ----------
let larkClient = null;

// ---------- ?????? ----------
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

// ---------- ?????? ----------
async function sendFeishuMsg(chatId, text) {
    if (!larkClient) return false;
    try {
        await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: chatId,
                content: JSON.stringify({ text }),
                msg_type: 'text'
            }
        });
        return true;
    } catch (err) { console.error('[??] ?????:', err.message); return false; }
}

// ---------- ????????????(?? open_id)----------
async function sendFeishuToUser(systemUserId, text) {
    if (!larkClient) return { success: false, reason: '?????????' };
    const feishuOpenId = getFeishuIdBySystemUser(systemUserId);
    if (!feishuOpenId) return { success: false, reason: '????????' };
    try {
        await larkClient.im.message.create({
            params: { receive_id_type: 'open_id' },
            data: {
                receive_id: feishuOpenId,
                content: JSON.stringify({ text }),
                msg_type: 'text'
            }
        });
        return { success: true };
    } catch (err) {
        console.error('[??] ????????:', err.message);
        return { success: false, reason: err.message };
    }
}

// ---------- ??????(ADMIN ??)????? ----------
async function sendFeishuToApprovers(text) {
    if (!larkClient) return { success: false, sent: 0, reason: '?????????' };
    const admins = query('SELECT id, name FROM users WHERE role = ?', ['ADMIN']);
    if (admins.length === 0) return { success: false, sent: 0, reason: '????????' };

    let sentCount = 0;
    let failedNames = [];

    for (const admin of admins) {
        const feishuOpenId = getFeishuIdBySystemUser(admin.id);
        if (!feishuOpenId) {
            failedNames.push(admin.name + '(???)');
            continue;
        }
        try {
            await larkClient.im.message.create({
                params: { receive_id_type: 'open_id' },
                data: {
                    receive_id: feishuOpenId,
                    content: JSON.stringify({ text }),
                    msg_type: 'text'
                }
            });
            sentCount++;
        } catch (err) {
            console.error('[??] ???? ' + admin.name + ' ?????:', err.message);
            failedNames.push(admin.name);
        }
    }

    return {
        success: sentCount > 0,
        sent: sentCount,
        total: admins.length,
        failed: failedNames.length > 0 ? failedNames.join(', ') : ''
    };
}

// ---------- ?????????????? ----------
async function sendFeishuToUserByName(userName, text) {
    if (!larkClient) return { success: false, reason: '?????????' };
    if (!userName) return { success: false, reason: '??????' };
    const users = query('SELECT id, name, username FROM users WHERE name LIKE ? OR username LIKE ?',
        ['%' + userName + '%', '%' + userName + '%']);
    if (users.length === 0) return { success: false, reason: '?????"' + userName + '"???' };
    if (users.length > 1) return { success: false, reason: '????????:' + users.map(function(u) { return u.name; }).join(', ') };

    const user = users[0];
    const feishuOpenId = getFeishuIdBySystemUser(user.id);
    if (!feishuOpenId) return { success: false, reason: '?? ' + user.name + ' ?????' };

    try {
        await larkClient.im.message.create({
            params: { receive_id_type: 'open_id' },
            data: {
                receive_id: feishuOpenId,
                content: JSON.stringify({ text }),
                msg_type: 'text'
            }
        });
        return { success: true, user: user.name };
    } catch (err) {
        console.error('[??] ?????:', err.message);
        return { success: false, reason: err.message };
    }
}

// ---------- ????? ----------
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
        
        console.log('[OK] ????????');
    } catch (err) {
        console.error('[ERROR] ???????:', err.message);
    }
}

// ============================================================
//  AI ????
// ============================================================
function aiDetectIntent(text) {
    const t = text.trim();
    
    // ????(????,???????)
    const rejectWords = ['???', '??', '??', '??', '??', '??', '??'];
    if (rejectWords.some(w => t.includes(w))) {
        const comment = t.replace(/???|??|??|??|??|??|??/g, '').trim();
        return { type: 'REJECT', comment: comment || '????' };
    }
    
    // ????
    const approveWords = ['??', '??', 'ok', 'okay', '??', '??', '??', '??', '???', '??', '??'];
    if (approveWords.some(w => t.toLowerCase().includes(w))) {
        const comment = t.replace(/??|??|ok|okay|??|??|??|??|???|??|??/gi, '').trim();
        return { type: 'APPROVE', comment: comment || '???' };
    }
    
    // ????
    const leaveWords = ['??', '??', '??', '??', '??', '??', '??', '??'];
    if (leaveWords.some(w => t.includes(w))) {
        return { type: 'LEAVE_REQUEST' };
    }
    
    // ????
    const queryWords = ['????', '????', '????', '???', '????', '????', '?????'];
    if (queryWords.some(w => t.includes(w))) {
        return { type: 'QUERY' };
    }
    
    // ????
    if (t.match(/??[^\s,,?!!??]+/) && !leaveWords.some(w => t.includes(w))) {
        return { type: 'BIND' };
    }
    
    return { type: 'UNKNOWN' };
}

// ---------- AI ?????? ----------
function aiParseLeaveMessage(text) {
    const today = new Date();
    const result = { isLeaveRequest: true, userName: null, type: null, startDate: null, endDate: null, days: null, reason: '' };
    
    // ????
    const nm = text.match(/??([^\s,,?!!??]+)/);
    if (nm) result.userName = nm[1];
    
    // ????
    const typeMap = { '??': '??', '??': '??', '??': '??', '??': '??', '??': '??', '??': '??' };
    for (const [k, v] of Object.entries(typeMap)) { if (text.includes(k)) { result.type = v; break; } }
    if (!result.type) result.type = '??'; // ????
    
    // ????
    const dp2 = [...text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)].map(m => `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
    const dp1 = [...text.matchAll(/(\d{1,2})?(\d{1,2})[??]/g)].map(m => `${today.getFullYear()}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
    const dates = [...dp2, ...dp1];
    if (dates.length >= 2) { result.startDate = dates[0]; result.endDate = dates[1]; }
    else if (dates.length === 1) { result.startDate = result.endDate = dates[0]; }
    
    // ??
    const dm = text.match(/(\d+)[???]/);
    if (dm) result.days = parseInt(dm[1]);
    if (!result.days && result.startDate && result.endDate) {
        const diff = (new Date(result.endDate) - new Date(result.startDate)) / 86400000 + 1;
        result.days = Math.max(1, diff);
    }
    if (!result.days) result.days = 1;
    
    // ??
    const reasonMatch = text.match(/(?:??|??|??|???)([^\s,,?!!??]+)/);
    if (reasonMatch) result.reason = reasonMatch[1];
    
    return result;
}

// ============================================================
//  ?????????
// ============================================================
async function handleFeishuMessage(data) {
    try {
        const msg = data.message;
        const chatId = msg.chat_id;
        const msgId = msg.message_id;
        const senderId = data.sender?.sender_id?.open_id || data.sender?.id?.open_id || '';
        const chatType = msg.chat_type; // 'p2p' ? 'group'
        
        // ??????
        let content = '';
        try {
            const parsed = JSON.parse(msg.content);
            content = (parsed.text || '').trim();
        } catch { content = (msg.content || '').trim(); }
        
        // ?????
        if (!content) return;
        
        console.log(`[??] type=${chatType} chat=${chatId} sender=${senderId} msg="${content}"`);
        
        // ========== ???? ==========
        const intent = aiDetectIntent(content);
        console.log(`[??] ??: ${intent.type}`);
        
        if (intent.type === 'LEAVE_REQUEST') {
            // ==================== ???? ====================
            const result = aiParseLeaveMessage(content);
            
            // ?????:???? > ?????
            let applicant = getSystemUserByFeishuId(senderId);
            if (!applicant && result.userName) {
                applicant = query('SELECT id, username, name, role FROM users WHERE name = ?', [result.userName])[0];
            }
            if (!applicant) {
                await sendFeishuMsg(chatId, '? ????????,??????????????,????????');
                return;
            }
            
            // ????
            const existMap = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
            if (existMap.length === 0) {
                run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [senderId, applicant.id]);
                console.log(`[??] ????: ${senderId} ? ${applicant.name}`);
            }
            
            // ????
            const leaveId = run(
                `INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, feishu_chat_id, feishu_msg_id) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
                [applicant.id, result.type, result.startDate || '', result.endDate || '', result.days, result.reason || '', chatId, msgId]
            ).lastID;
            
            // ???????
            const admins = query('SELECT name FROM users WHERE role = "ADMIN"');
            const adminNames = admins.map(a => a.name).join('?');
            
            await sendFeishuMsg(chatId,
                `?? ???????\n\n` +
                `?? ???:${applicant.name}\n` +
                `?? ??:${result.type}\n` +
                `?? ??:${result.startDate || '???'} ? ${result.endDate || '???'}\n` +
                `?? ??:${result.days}?\n` +
                `?? ??:${result.reason || '?'}\n\n` +
                `? ?? ${adminNames} ??\n\n` +
                `?? ???????????????`);
            
            // ????
            await sendWechatNotify(`??????${applicant.name}`,
                `??:${result.type}\n??:${result.startDate} ? ${result.endDate}\n??:${result.days}\n??:${result.reason || '?'}`);
                
        } else if (intent.type === 'APPROVE') {
            // ==================== ???? ====================
            let approver = getSystemUserByFeishuId(senderId);
            if (!approver || approver.role !== 'ADMIN') {
                await sendFeishuMsg(chatId, '?? ?????????????');
                return;
            }
            
            // ???????????
            const pending = query(
                `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.feishu_chat_id = ? AND l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 1`,
                [chatId]
            );
            if (pending.length === 0) {
                await sendFeishuMsg(chatId, '????????????');
                return;
            }
            
            const leave = pending[0];
            const comment = intent.comment || '???';
            
            run(`UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
                [approver.id, comment, leave.id]);
            
            await sendFeishuMsg(chatId,
                `? ?????!\n\n` +
                `?? ???:${leave.user_name}\n` +
                `?? ???:${approver.name}\n` +
                `?? ??:${leave.type}\n` +
                `?? ??:${leave.start_date} ? ${leave.end_date}(${leave.days}?)\n` +
                `?? ????:${comment}\n\n` +
                `?? ${leave.user_name},????!`);
            
            await sendWechatNotify(`??????${leave.user_name}`,
                `??${leave.type}??${approver.name}??\n??:${leave.start_date} ? ${leave.end_date}`);
                
        } else if (intent.type === 'REJECT') {
            // ==================== ???? ====================
            let approver = getSystemUserByFeishuId(senderId);
            if (!approver || approver.role !== 'ADMIN') {
                await sendFeishuMsg(chatId, '?? ?????????????');
                return;
            }
            
            const pending = query(
                `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.feishu_chat_id = ? AND l.status = 'PENDING' ORDER BY l.created_at DESC LIMIT 1`,
                [chatId]
            );
            if (pending.length === 0) {
                await sendFeishuMsg(chatId, '????????????');
                return;
            }
            
            const leave = pending[0];
            const comment = intent.comment || '????';
            
            run(`UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
                [approver.id, comment, leave.id]);
            
            await sendFeishuMsg(chatId,
                `? ?????\n\n` +
                `?? ???:${leave.user_name}\n` +
                `?? ???:${approver.name}\n` +
                `?? ??:${leave.type}\n` +
                `?? ????:${comment}`);
                
        } else if (intent.type === 'QUERY') {
            // ==================== ?????? ====================
            let user = getSystemUserByFeishuId(senderId);
            if (!user) {
                await sendFeishuMsg(chatId, '??????,??????????');
                return;
            }
            
            const leaves = query(
                `SELECT l.type, l.start_date, l.end_date, l.days, l.status, l.reason FROM leave_requests l WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 5`,
                [user.id]
            );
            if (leaves.length === 0) {
                await sendFeishuMsg(chatId, `${user.name},?????????`);
                return;
            }
            
            const emoji = { PENDING: '?', APPROVED: '?', REJECTED: '?' };
            let text = `${user.name}?????:\n\n`;
            for (const l of leaves) {
                text += `${emoji[l.status] || '?'} ${l.type} ${l.start_date}~${l.end_date}(${l.days}?)${l.status === 'PENDING' ? '???' : l.status === 'APPROVED' ? '???' : '???'}\n   ??:${l.reason || '?'}\n\n`;
            }
            await sendFeishuMsg(chatId, text);
            
        } else if (intent.type === 'BIND') {
            // ==================== ???? ====================
            const nameMatch = content.match(/??([^\s,,?!!??]+)/);
            if (!nameMatch) {
                await sendFeishuMsg(chatId, '??????????????,????????');
                return;
            }
            const sysUser = query('SELECT id, name, role FROM users WHERE name = ?', [nameMatch[1]]);
            if (sysUser.length === 0) {
                await sendFeishuMsg(chatId, `? ???????${nameMatch[1]}?,????????`);
                return;
            }
            
            const existMap = query('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [senderId]);
            if (existMap.length > 0) {
                run('UPDATE feishu_user_map SET system_user_id = ? WHERE feishu_open_id = ?', [sysUser[0].id, senderId]);
            } else {
                run('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [senderId, sysUser[0].id]);
            }
            
            await sendFeishuMsg(chatId,
                `? ????!${nameMatch[1]}(${sysUser[0].role === 'ADMIN' ? '???' : '??'})\n\n` +
                `???????????:\n` +
                `?? ?? ? ????3? ?? 6?15?17??\n` +
                `?? ?? ? ?????????`);
            
        } else {
            // ==================== ?? ====================
            await sendFeishuMsg(chatId,
                `??!???????? ??\n\n` +
                `?????:\n` +
                `?? ?? ? ????3? ?? 6?15?17? ?????\n` +
                `? ?? ? ??????????????\n` +
                `?? ?? ? ?????????\n` +
                `?? ?? ? ???????\n\n` +
                `?? ???????????!`);
        }
    } catch (err) {
        console.error('[??] ????:', err.message, err.stack);
    }
}

// ---------- Server??? ----------
async function sendWechatNotify(title, content) {
    try {
        const cfg = query('SELECT api_key FROM wechat_config LIMIT 1');
        if (!cfg[0]?.api_key) return;
        await axios.get(`https://sc.ftqq.com/${cfg[0].api_key}.send?text=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`);
    } catch (err) { console.error('[??] ????:', err.message); }
}

// ---------- ?? ----------
function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: '???' });
    try {
        const parts = Buffer.from(token, 'base64').toString().split(':');
        if (parts.length !== 2) throw new Error();
        req.userId = parseInt(parts[0]);
        req.username = parts[1];
        next();
    } catch { res.status(401).json({ message: '????' }); }
}

// ============================================================
//  REST API
// ============================================================

app.post('/api/public/login', (req, res) => {
    try {
        const { username, password } = req.body;
        const md5pwd = crypto.createHash('md5').update(password).digest('hex');
        // ???? MD5 ????
        let users = query('SELECT id, username, name, role, email FROM users WHERE username = ? AND password = ?', [username, md5pwd]);
        if (!users.length) {
            // ???????(????????)
            users = query('SELECT id, username, name, role, email FROM users WHERE username = ? AND password = ?', [username, password]);
            if (users.length) { run('UPDATE users SET password = ? WHERE id = ?', [md5pwd, users[0].id]); console.log(`[??] ${username} ?????`); }
        }
        if (!users.length) return res.status(401).json({ message: '????????' });
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

// ??????(API??)
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
                    console.log('[??] ?? code ????:', openId, userName);
                }
            } catch (err) {
                console.log('[??] code ????,??????:', err.message);
            }
        }

        if (!openId) {
            return res.status(400).json({ message: '??????????' });
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
        console.log('[??] ??????:', newUsername, userName);
        res.json({ success: true, token, user: { id: r.lastID, username: newUsername, name: userName || newUsername, role: 'EMPLOYEE' }, isNew: true, autoCreated: true });
    } catch (e) {
        console.error('[????] ??:', e);
        res.status(500).json({ message: e.message });
    }
});

app.get('/api/feishu/bindings', auth, (req, res) => {
    try {
        res.json(query('SELECT f.feishu_open_id, f.system_user_id, u.name as user_name FROM feishu_user_map f LEFT JOIN users u ON f.system_user_id = u.id'));
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ??
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

// ??
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
        sendWechatNotify('????????? ' + (user?.name || ''),
            `????:${type}\n??:${startDate} ? ${endDate}\n??:${days}\n??:${reason || '?'}`);
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

// ??
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

// ?? Webhook
app.post('/api/wechat/webhook', express.raw({ type: 'application/xml', limit: '1mb' }), async (req, res) => {
    res.json({ success: true });
});

// ?? Webhook
app.post('/api/feishu/webhook', async (req, res) => {
    res.json({ success: true });
});

// ============================================================
//  AI ?????? API
// ============================================================

// ?????????
app.get('/api/agents', (req, res) => {
    if (!aiAgents) {
        return res.json({ success: false, agents: [] });
    }
    res.json({ success: true, agents: aiAgents.getAgentsList() });
});

// ??????(?????)
app.post('/api/agents/chat', auth, async (req, res) => {
    const { agentId, message, conversationId } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '????????' });
    }
    if (!agentId || !message) {
        return res.status(400).json({ success: false, error: '?? agentId ? message' });
    }

    const convId = conversationId || ('user_' + req.userId + '_' + agentId);
    const result = await aiAgents.chatWithAgent(agentId, message, convId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// ????(??,????,????/??/??????)
app.post('/api/agents/analyze', auth, async (req, res) => {
    const { agentId, prompt, context } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '????????' });
    }
    if (!agentId || !prompt) {
        return res.status(400).json({ success: false, error: '?? agentId ? prompt' });
    }

    const result = await aiAgents.analyzeWithAgent(agentId, prompt, context);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// ??????
app.post('/api/agents/classify', auth, async (req, res) => {
    const { message } = req.body;
    if (!aiAgents) {
        return res.json({ agent: 'general' });
    }
    const agent = await aiAgents.classifyIntent(message || '');
    res.json({ agent });
});

// ---------- ???????? API ----------

// ????????
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

// ????????(??????)
app.post('/api/agents/collaboration/plan', auth, async (req, res) => {
    const { message, context } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '????????' });
    }
    if (!message) {
        return res.status(400).json({ success: false, error: '?? message ??' });
    }
    try {
        const result = await aiAgents.getCollaborationPlanOnly(message, context);
        res.json(result);
    } catch (err) {
        console.error('[Collaboration Plan Error]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ????????(????)
app.post('/api/agents/collaboration/execute', auth, async (req, res) => {
    const { message, mode, agents, context, sessionId } = req.body;
    if (!aiAgents) {
        return res.status(500).json({ success: false, error: '????????' });
    }
    if (!message) {
        return res.status(400).json({ success: false, error: '?? message ??' });
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

// AI ???????
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// ?? AI ????
app.get('/feishu-chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feishu-chat.html')));

// ============================================================
//  ??
// ============================================================

async function start() {
    const startTime = Date.now();
    console.log('\n========================================');
    console.log('?? ???? + AI ?????');
    console.log('========================================');
    console.log('[??] ????????...');

    try {
        await initDB();

        // ???? SQL:?? SQL ????????
        function safeRun(sql, label) {
            try {
                db.run(sql);
                return true;
            } catch (e) {
                console.error(`[WARN] ${label} ??:`, e.message);
                return false;
            }
        }

        // ??
        console.log('[??] ???????...');
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
        console.log(`[OK] ??????? (${createdCount}/${tables.length})`);

        // ???????(?? users ????)
        try {
            if (query('SELECT COUNT(*) as c FROM users')[0].c === 0) {
                console.log('[???] ????????...');
                function insert(sql, params = []) { try { run(sql, params); } catch (e) {} }
                insert(`INSERT INTO users (username, password, name, role) VALUES ('admin', 'admin123', '???', 'ADMIN')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('zhangsan', '123456', '??', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('lisi', '123456', '??', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('wangwu', '123456', '??', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('zhaoliu', '123456', '??', 'EMPLOYEE')`);
                insert(`INSERT INTO users (username, password, name, role) VALUES ('sunqi', '123456', '??', 'EMPLOYEE')`);
                insert(`INSERT INTO wechat_config (provider, api_key, enabled) VALUES ('serverchan', 'SCT359275Tkk3wftrQnVAwazPBPOAWaMIR', 1)`);
                insert(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('??2024?????????', '????????????????????', 'NOTICE', 'APPROVED', 'HIGH', 1)`);
                insert(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('???????????', '?????????????50??', 'PROPOSAL', 'PENDING', 'NORMAL', 2)`);
                insert(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('??????????', '????????????????', 'NOTICE', 'PENDING', 'LOW', 1)`);
                insert(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (2, '??', '2024-06-10', '2024-06-12', 3, '????????', 'APPROVED', 1)`);
                insert(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (3, '??', '2024-06-05', '2024-06-05', 1, '????', 'APPROVED', 1)`);
                insert(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (4, '??', '2024-06-15', '2024-06-16', 2, '????????', 'PENDING')`);
                console.log('[???] ????????');
            }
        } catch (e) {
            console.error('[WARN] ???????:', e.message);
        }

        try { saveDB(); } catch (e) { console.error('[WARN] ???????:', e.message); }
        try { await initLark(); } catch (e) { /* initLark ???? */ }

        // ???????
        try {
            const userCount = query('SELECT COUNT(*) as c FROM users')[0].c;
            const docCount = query('SELECT COUNT(*) as c FROM documents')[0].c;
            const leaveCount = query('SELECT COUNT(*) as c FROM leave_requests')[0].c;
            console.log(`[OK] ????: ?? ${userCount} ? | ?? ${docCount} ? | ?? ${leaveCount} ?`);
        } catch (e) {}

        // ????:?????????
        const migrations = [
            ['email',         'ALTER TABLE users ADD COLUMN email TEXT'],
            ['phone',         'ALTER TABLE users ADD COLUMN phone TEXT'],
            ['avatar',        'ALTER TABLE users ADD COLUMN avatar TEXT'],
            ['verified',      'ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0'],
            ['oauth_provider','ALTER TABLE users ADD COLUMN oauth_provider TEXT'],
            ['oauth_id',      'ALTER TABLE users ADD COLUMN oauth_id TEXT'],
        ];
        migrations.forEach(([col, sql]) => {
            try { db.run(sql); console.log(`[??] users.${col} ???`); } catch (e) {}
        });

        // ?? Auth ??
        if (authModule) {
            try {
                const { addRoutes } = authModule(db, query, run, crypto);
                addRoutes(app);
            } catch (e) { console.error('[WARN] Auth ??????:', e.message); }
        }

        app.listen(PORT, '0.0.0.0', () => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`\n========================================================`);
            console.log(`?? ????? (?? ${elapsed}s)`);
            console.log(`?? ???:    http://localhost:${PORT}/`);
            console.log(`?? AI??:    http://localhost:${PORT}/chat`);
            console.log(`?? ????:  http://localhost:${PORT}/health`);
            console.log(`?? ????:  admin / admin123`);
            console.log(`              zhangsan / 123456`);
            console.log(`========================================================\n`);
        });
    } catch (err) {
        console.error('[ERROR] ????:', err);
        process.exit(1);
    }
}

start();
