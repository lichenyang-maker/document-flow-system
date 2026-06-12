// ============================================================
//  公文流转 + 请假系统 - SQLite 版本（支持飞书长连接）
//  端口：3000
// ============================================================
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const fs = require('fs');

// ---------- 环境配置 ----------
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'document_flow.db');
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aaa152828fb95bda';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'CSyWDYc75HnNz7k0MLn6EciZ5ajjwNvZ';
const USE_SQLITE = process.env.USE_SQLITE !== 'false';

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ---------- SQLite ----------
let db;
function initDB() {
    return new Promise((resolve, reject) => {
        // 确保目录存在
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[ERROR] SQLite 连接失败:', err.message);
                reject(err);
                return;
            }
            console.log('[OK] SQLite Connected:', DB_PATH);
            
            // 启用外键
            db.run('PRAGMA foreign_keys = ON', () => {
                resolve();
            });
        });
    });
}

function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// ---------- 飞书长连接 ----------
async function initLarkLongConnection() {
    try {
        const { lark, LarkConfig } = require('@larksuiteoapi/node-sdk');
        
        const client = new lark(LarkConfig.createByAppInfo(
            FEISHU_APP_ID,
            FEISHU_APP_SECRET
        ));
        
        client.eventManager.start({ autoReconnect: true });
        
        client.eventManager.on('im.message.receive_v1', async (data) => {
            console.log('[飞书] 收到消息:', JSON.stringify(data));
            await handleFeishuMessage(data);
        });
        
        console.log('[OK] 飞书长连接已启动');
        return true;
    } catch (err) {
        console.error('[ERROR] 飞书长连接启动失败:', err.message);
        console.log('[提示] 请确保已安装: npm install @larksuiteoapi/node-sdk');
        return false;
    }
}

async function handleFeishuMessage(data) {
    try {
        const message = data.message;
        const content = JSON.parse(message.content).text;
        console.log(`[飞书] 消息内容: ${content}`);
        
        // AI 解析并自动提交请假
        const parseResult = await aiParseLeaveMessage(content);
        if (parseResult.isLeaveRequest && parseResult.userName) {
            // 查找用户并提交请假
            const users = await query('SELECT id FROM users WHERE name = ?', [parseResult.userName]);
            if (users.length > 0) {
                await run(`
                    INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
                `, [users[0].id, parseResult.type || '年假', parseResult.startDate, parseResult.endDate, parseResult.days || 1, parseResult.reason]);
                
                console.log(`[飞书] 请假申请已自动提交: ${parseResult.userName}`);
                await sendWechatNotify('【飞书请假】来自 ' + parseResult.userName, 
                    `请假类型：${parseResult.type}\n时间：${parseResult.startDate} 至 ${parseResult.endDate}\n天数：${parseResult.days}\n事由：${parseResult.reason}`);
            }
        }
    } catch (err) {
        console.error('[飞书] 处理消息失败:', err.message);
    }
}

// ---------- AI 解析 ----------
async function aiParseLeaveMessage(text) {
    const today = new Date();
    const result = {
        isLeaveRequest: false,
        userName: null,
        type: null,
        startDate: null,
        endDate: null,
        days: null,
        reason: ''
    };

    const leaveKeywords = ['请假', '年假', '事假', '病假', '婚假', '产假', '丧假', '休假'];
    result.isLeaveRequest = leaveKeywords.some(k => text.includes(k));
    if (!result.isLeaveRequest) return result;

    // 提取姓名
    const nameMatch = text.match(/我是([^\s，,。]+)/);
    if (nameMatch) result.userName = nameMatch[1];

    // 提取假期类型
    const typeMap = { '年假': '年假', '事假': '事假', '病假': '病假', '婚假': '婚假', '产假': '产假' };
    for (const [kw, type] of Object.entries(typeMap)) {
        if (text.includes(kw)) { result.type = type; break; }
    }

    // 提取日期
    const datePattern1 = /(\d{1,2})月(\d{1,2})[号日]/g;
    const datePattern2 = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
    const dates = [];
    let m;
    
    datePattern2.lastIndex = 0;
    while ((m = datePattern2.exec(text)) !== null) {
        dates.push(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
    }
    
    datePattern1.lastIndex = 0;
    while ((m = datePattern1.exec(text)) !== null) {
        const year = today.getFullYear();
        dates.push(`${year}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
    }

    if (dates.length >= 2) {
        result.startDate = dates[0];
        result.endDate = dates[1];
    } else if (dates.length === 1) {
        result.startDate = result.endDate = dates[0];
    }

    // 提取天数
    const daysMatch = text.match(/(\d+)[天日周]/);
    if (daysMatch) result.days = parseInt(daysMatch[1]);

    return result;
}

// ---------- Server酱推送 ----------
async function sendWechatNotify(title, content) {
    try {
        const config = await query('SELECT api_key FROM wechat_config LIMIT 1');
        if (!config[0]?.api_key) return;
        
        await axios.get(`https://sc.ftqq.com/${config[0].api_key}.send?text=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`);
        console.log('[微信] 推送成功');
    } catch (err) {
        console.error('[微信] 推送失败:', err.message);
    }
}

// ---------- 认证中间件 ----------
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: '未登录' });
    
    // 简单 token 验证（实际应该用 JWT）
    try {
        const parts = Buffer.from(token, 'base64').toString().split(':');
        if (parts.length !== 2) throw new Error('Invalid token');
        req.userId = parseInt(parts[0]);
        req.username = parts[1];
        next();
    } catch {
        res.status(401).json({ message: '无效的凭证' });
    }
}

// ============================================================
//  API 路由
// ============================================================

// 登录
app.post('/api/public/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = await query('SELECT id, username, name, role FROM users WHERE username = ? AND password = ?', [username, password]);
        
        if (users.length === 0) {
            return res.status(401).json({ message: '用户名或密码错误' });
        }

        const user = users[0];
        const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
        
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, name: user.name, role: user.role }
        });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 获取当前用户
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const users = await query('SELECT id, username, name, role FROM users WHERE id = ?', [req.userId]);
        if (users.length === 0) throw new Error('User not found');
        res.json(users[0]);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 获取用户列表
app.get('/api/users', authMiddleware, async (req, res) => {
    try {
        const users = await query('SELECT id, username, name, role, created_at FROM users ORDER BY id');
        res.json(users);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// ========== 公文 API ==========

// 获取公文列表
app.get('/api/docs', authMiddleware, async (req, res) => {
    try {
        const { status, type } = req.query;
        let sql = `SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id WHERE 1=1`;
        const params = [];
        
        if (status) { sql += ' AND d.status = ?'; params.push(status); }
        if (type) { sql += ' AND d.type = ?'; params.push(type); }
        
        sql += ' ORDER BY d.created_at DESC';
        const docs = await query(sql, params);
        res.json(docs);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 创建公文
app.post('/api/docs', authMiddleware, async (req, res) => {
    try {
        const { title, content, type, priority } = req.body;
        const result = await run(`
            INSERT INTO documents (title, content, type, priority, status, applicant_id)
            VALUES (?, ?, ?, ?, 'PENDING', ?)
        `, [title, content, type || 'NORMAL', priority || 'NORMAL', req.userId]);
        
        res.json({ success: true, id: result.lastID });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 审批公文
app.post('/api/docs/:id/approve', authMiddleware, async (req, res) => {
    try {
        const { comment } = req.body;
        await run(`UPDATE documents SET status = 'APPROVED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
        await run(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'APPROVE', ?)`, [req.params.id, req.userId, comment || '']);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 驳回公文
app.post('/api/docs/:id/reject', authMiddleware, async (req, res) => {
    try {
        const { comment } = req.body;
        await run(`UPDATE documents SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
        await run(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'REJECT', ?)`, [req.params.id, req.userId, comment || '']);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// ========== 请假 API ==========

// 获取请假列表
app.get('/api/leave', authMiddleware, async (req, res) => {
    try {
        const user = (await query('SELECT role FROM users WHERE id = ?', [req.userId]))[0];
        const uid = user.role === 'ADMIN' ? null : req.userId;
        let sql = `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE 1=1`;
        const params = [];
        
        if (uid) { sql += ' AND l.user_id = ?'; params.push(uid); }
        if (req.query.status) { sql += ' AND l.status = ?'; params.push(req.query.status); }
        
        sql += ' ORDER BY l.created_at DESC';
        const leaves = await query(sql, params);
        res.json(leaves);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 创建请假
app.post('/api/leave', authMiddleware, async (req, res) => {
    try {
        const { type, startDate, endDate, days, reason } = req.body;
        const result = await run(`
            INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
        `, [req.userId, type, startDate, endDate, days, reason || '']);
        
        // 发送微信通知
        const user = (await query('SELECT name FROM users WHERE id = ?', [req.userId]))[0];
        await sendWechatNotify('【新请假申请】来自 ' + user.name,
            `请假类型：${type}\n时间：${startDate} 至 ${endDate}\n天数：${days}\n事由：${reason || '无'}`);
        
        res.json({ success: true, id: result.lastID });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 审批请假
app.post('/api/leave/:id/approve', authMiddleware, async (req, res) => {
    try {
        const { comment } = req.body;
        await run(`UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approver_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [req.userId, comment || '', req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 驳回请假
app.post('/api/leave/:id/reject', authMiddleware, async (req, res) => {
    try {
        const { comment } = req.body;
        await run(`UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approver_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [req.userId, comment || '', req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 请假统计
app.get('/api/leave/stats', authMiddleware, async (req, res) => {
    try {
        const user = (await query('SELECT role FROM users WHERE id = ?', [req.userId]))[0];
        const uid = user.role === 'ADMIN' ? null : req.userId;
        const where = uid ? `WHERE user_id = ${uid}` : '';
        
        const total = (await query(`SELECT COUNT(*) as c FROM leave_requests ${where}`))[0].c;
        const pending = (await query(`SELECT COUNT(*) as c FROM leave_requests ${where} AND status = 'PENDING'`))[0].c;
        const approved = (await query(`SELECT COUNT(*) as c FROM leave_requests ${where} AND status = 'APPROVED'`))[0].c;
        const rejected = (await query(`SELECT COUNT(*) as c FROM leave_requests ${where} AND status = 'REJECTED'`))[0].c;
        
        res.json({ total, pending, approved, rejected });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// ========== 统计 API ==========

app.get('/api/stats', authMiddleware, async (req, res) => {
    try {
        const totalUsers = (await query('SELECT COUNT(*) as c FROM users'))[0].c;
        const totalDocs = (await query('SELECT COUNT(*) as c FROM documents'))[0].c;
        const pendingDocs = (await query(`SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'`))[0].c;
        const totalLeave = (await query('SELECT COUNT(*) as c FROM leave_requests'))[0].c;
        const pendingLeave = (await query(`SELECT COUNT(*) as c FROM leave_requests WHERE status = 'PENDING'`))[0].c;
        
        res.json({
            totalUsers, totalDocs, pendingDocs, totalLeave, pendingLeave,
            systemHealth: true
        });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// ========== 微信 Webhook ==========

app.post('/api/wechat/webhook', express.raw({ type: 'application/xml', limit: '1mb' }), async (req, res) => {
    res.json({ success: true });
    
    try {
        const xml = req.body.toString();
        const contentMatch = xml.match(/<Content><!\[CDATA\[([^\]]+)\]\]><\/Content>/);
        if (!contentMatch) return;
        
        const content = contentMatch[1];
        console.log('[微信] 收到消息:', content);
        
        const parseResult = await aiParseLeaveMessage(content);
        if (parseResult.isLeaveRequest && parseResult.userName) {
            const users = await query('SELECT id FROM users WHERE name = ?', [parseResult.userName]);
            if (users.length > 0) {
                await run(`
                    INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
                `, [users[0].id, parseResult.type || '年假', parseResult.startDate, parseResult.endDate, parseResult.days || 1, parseResult.reason]);
                
                await sendWechatNotify('【微信请假】来自 ' + parseResult.userName,
                    `请假类型：${parseResult.type}\n时间：${parseResult.startDate} 至 ${parseResult.endDate}\n天数：${parseResult.days}\n事由：${parseResult.reason}`);
            }
        }
    } catch (err) {
        console.error('[微信] Webhook 处理失败:', err.message);
    }
});

// ========== 飞书 Webhook ==========

app.post('/api/feishu/webhook', async (req, res) => {
    res.json({ success: true });
    
    try {
        const { content, user_id } = req.body;
        if (!content) return;
        
        console.log('[飞书] Webhook 收到:', content);
        
        const parseResult = await aiParseLeaveMessage(content);
        if (parseResult.isLeaveRequest) {
            let userId = req.userId;
            if (parseResult.userName) {
                const users = await query('SELECT id FROM users WHERE name = ?', [parseResult.userName]);
                if (users.length > 0) userId = users[0].id;
            }
            
            if (userId) {
                await run(`
                    INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
                `, [userId, parseResult.type || '年假', parseResult.startDate, parseResult.endDate, parseResult.days || 1, parseResult.reason]);
                
                await sendWechatNotify('【飞书请假】',
                    `请假类型：${parseResult.type}\n时间：${parseResult.startDate} 至 ${parseResult.endDate}\n天数：${parseResult.days}\n事由：${parseResult.reason}`);
            }
        }
    } catch (err) {
        console.error('[飞书] Webhook 处理失败:', err.message);
    }
});

// ============================================================
//  启动服务
// ============================================================

async function start() {
    try {
        await initDB();
        
        // 初始化数据库表（如果不存在）
        await run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT DEFAULT 'EMPLOYEE',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // 检查是否需要初始化默认数据
        const userCount = (await query('SELECT COUNT(*) as c FROM users'))[0].c;
        if (userCount === 0) {
            console.log('[初始化] 正在创建默认数据...');
            // 插入默认用户
            await run(`INSERT INTO users (username, password, name, role) VALUES ('admin', 'admin123', '管理员', 'ADMIN')`);
            await run(`INSERT INTO users (username, password, name, role) VALUES ('zhangsan', '123456', '张三', 'EMPLOYEE')`);
            await run(`INSERT INTO users (username, password, name, role) VALUES ('lisi', '123456', '李四', 'EMPLOYEE')`);
            await run(`INSERT INTO users (username, password, name, role) VALUES ('wangwu', '123456', '王五', 'EMPLOYEE')`);
            await run(`INSERT INTO users (username, password, name, role) VALUES ('zhaoliu', '123456', '赵六', 'EMPLOYEE')`);
            await run(`INSERT INTO users (username, password, name, role) VALUES ('sunqi', '123456', '孙七', 'EMPLOYEE')`);
            
            // 插入微信配置
            await run(`INSERT INTO wechat_config (provider, api_key, enabled) VALUES ('serverchan', 'SCT359275Tkk3wftrQnVAwazPBPOAWaMIR', 1)`);
            
            // 插入示例数据
            await run(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于2024年度工作计划的通知', '请各部门于本周五前提交年度工作计划草案。', 'NOTICE', 'APPROVED', 'HIGH', 1)`);
            await run(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于员工福利调整的申请', '建议提高员工餐补标准至每日50元。', 'PROPOSAL', 'PENDING', 'NORMAL', 2)`);
            await run(`INSERT INTO documents (title, content, type, status, priority, applicant_id) VALUES ('关于办公室搬迁的通知', '市场部将于下周一搬迁至新办公区。', 'NOTICE', 'PENDING', 'LOW', 1)`);
            
            await run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (2, '年假', '2024-06-10', '2024-06-12', 3, '计划带家人去旅游', 'APPROVED', 1)`);
            await run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (3, '病假', '2024-06-05', '2024-06-05', 1, '发烧感冒', 'APPROVED', 1)`);
            await run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) VALUES (4, '事假', '2024-06-15', '2024-06-16', 2, '家中装修需要监工', 'PENDING')`);
            
            console.log('[初始化] 默认数据创建完成');
        }
        
        // 启动飞书长连接
        await initLarkLongConnection();
        
        // 启动 HTTP 服务
        app.listen(PORT, () => {
            console.log(`\n🚀 服务已启动: http://localhost:${PORT}`);
            console.log(`📱 数据库: ${DB_PATH}`);
            console.log(`🤖 飞书应用: ${FEISHU_APP_ID}`);
        });
    } catch (err) {
        console.error('[ERROR] 启动失败:', err);
        process.exit(1);
    }
}

start();