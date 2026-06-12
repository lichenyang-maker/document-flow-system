// ============================================================
//  公文流转 + 请假系统 - 合并版（MySQL + 微信通知 + AI解析 + 飞书集成）
//  端口：3000
// ============================================================
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const axios = require('axios');
const http = require('http');

// ---------- 飞书配置 ----------
const FEISHU_CONFIG = {
    APP_ID: 'cli_aaa152828fb95bda',
    APP_SECRET: 'CSyWDYc75HnNz7k0MLn6EciZ5ajjwNvZ',
    // 长连接模式不需要配置回调地址
};

// 飞书长连接客户端（将在服务启动后初始化）
let larkClient = null;

const app = express();
const PORT = 3000;

// ---------- MySQL ----------
const db = mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'root',
    charset: 'utf8mb4'
});

// 自动重连
db.on('error', function(err) {
    console.log('[DB] Error:', err.code);
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
        console.log('[DB] Reconnecting...');
        setTimeout(() => db.connect(), 3000);
    }
});

db.connect((err) => {
    if (err) { console.error('[ERROR] MySQL:', err.message); process.exit(1); }
    console.log('[OK] MySQL Connected');
    // 确保两个数据库都存在
    db.query('CREATE DATABASE IF NOT EXISTS document_flow', () => {});
    db.query('CREATE DATABASE IF NOT EXISTS leave_system', () => {});
    db.query('USE document_flow');
});

// ---------- 中间件 ----------
app.use('/api/wechat/webhook', express.raw({ type: 'application/xml', limit: '1mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ---------- 飞书长连接初始化 ----------
async function initLarkLongConnection() {
    try {
        // 动态导入飞书 SDK（需要确保已安装）
        const { lark, LarkConfig } = require('@larksuiteoapi/node-sdk');
        
        larkClient = new lark(LarkConfig.createByAppInfo(
            FEISHU_CONFIG.APP_ID,
            FEISHU_CONFIG.APP_SECRET,
            {
                appType: lark.AppType.SelfBuild,
                appAccessType: lark.AppAccessType.Snapshot,
            }
        ));
        
        // 启动长连接，接收事件
        larkClient.eventManager.start({
            autoReconnect: true,
            reconnectMaxRetries: 10,
            reconnectDelay: 3000,
        });
        
        // 监听消息接收事件
        larkClient.eventManager.on('im.message.receive_v1', async (data) => {
            console.log('[飞书] 收到消息:', JSON.stringify(data));
            await handleFeishuMessage(data);
        });
        
        console.log('[OK] 飞书长连接已启动');
        return true;
    } catch (err) {
        console.error('[ERROR] 飞书长连接启动失败:', err.message);
        console.log('[提示] 请运行: npm install @larksuiteoapi/node-sdk');
        return false;
    }
}

// 处理飞书消息
async function handleFeishuMessage(data) {
    try {
        const message = data.message;
        const senderId = message.sender.sender_id.user_id;
        const content = JSON.parse(message.content).text;
        
        console.log(`[飞书] 来自 ${senderId} 的消息: ${content}`);
        
        // 调用 AI 解析请假意图
        const parseResult = await aiParseLeaveMessage(content);
        
        if (parseResult.isLeaveRequest && parseResult.userName) {
            // 自动提交请假申请
            // ... (实现逻辑类似微信 webhook)
            console.log('[飞书] 检测到请假意图，准备自动提交...');
        }
    } catch (err) {
        console.error('[飞书] 处理消息失败:', err.message);
    }
}

// ---------- Helper ----------
function query(sql, params = [], cbDb) {
    return new Promise((resolve, reject) => {
        (cbDb || db).query(sql, params, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
}

// ============================================================
//  AI 解析微信消息（调用 OpenClaw 本地模型路由）
// ============================================================
async function aiParseLeaveMessage(text) {
    // 调用 OpenClaw 的模型接口解析请假意图
    // 使用简单的规则解析作为兜底，同时尝试调用 AI 接口
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

    // 第一遍：规则快速判断
    const leaveKeywords = ['请假', '年假', '事假', '病假', '婚假', '产假', '丧假', '休假', '要请假', '请个假'];
    result.isLeaveRequest = leaveKeywords.some(k => text.includes(k));

    if (!result.isLeaveRequest) return result;

    // 用 AI 模型解析（通过 OpenClaw HTTP API）
    try {
        const prompt = `请解析以下微信消息，提取请假信息，以 JSON 格式返回。
消息内容：「${text}」

请返回严格 JSON（不要加任何解释）：
{
  "isLeaveRequest": true/false,
  "userName": "员工姓名或null",
  "type": "年假/事假/病假/婚假/产假/丧假 或 null",
  "startDate": "YYYY-MM-DD 或 null",
  "endDate": "YYYY-MM-DD 或 null",
  "days": 天数数字或null,
  "reason": "请假事由或空字符串"
}

注意：
- 如果消息里有"下周一"等相对日期，请结合今天日期 ${today.toISOString().slice(0,10)} 推算
- userName 如果消息里没有明确姓名，返回 null
- 如果天数没说，根据起止日期计算`;

        // 尝试调用 OpenClaw 本地 gateway API（如果有运行中的 openclaw gateway）
        const aiRes = await axios.post('http://127.0.0.1:3000/api/ai/parse', { text: text, prompt: prompt }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        }).catch(() => null);

        if (aiRes && aiRes.data && aiRes.data.result) {
            try {
                const parsed = JSON.parse(aiRes.data.result);
                Object.assign(result, parsed);
                return result;
            } catch(e) {}
        }
    } catch(e) {
        console.log('[AI] Parse failed, fallback to regex:', e.message);
    }

    // 兜底：正则解析
    const regexResult = parseLeaveByRegex(text, today);
    result.isLeaveRequest = regexResult.isLeaveRequest;
    result.userName = regexResult.userName;
    result.type = regexResult.type;
    result.startDate = regexResult.startDate;
    result.endDate = regexResult.endDate;
    result.days = regexResult.days;
    result.reason = regexResult.reason;
    return result;
}

function parseLeaveByRegex(text, today) {
    const result = {
        isLeaveRequest: true,
        userName: null,
        type: null,
        startDate: null,
        endDate: null,
        days: null,
        reason: ''
    };

    // 提取姓名（常见中文姓名模式）
    const nameMatch = text.match(/(?:我是|我叫|姓名[：:])?([张王李赵刘陈杨黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文|[\u4e00-\u9fa5]{2,3})(?:的|，|,|\s|请)/);
    if (nameMatch) result.userName = nameMatch[1];

    // 提取类型
    const typeMap = { '年假': '年假', '年休假': '年假', '事假': '事假', '病假': '病假', '婚假': '婚假', '产假': '产假', '丧假': '丧假' };
    for (const [k, v] of Object.entries(typeMap)) {
        if (text.includes(k)) { result.type = v; break; }
    }

    // 提取日期：YYYY-MM-DD 或 MM-DD 或 M月D日
    const datePattern1 = /\b(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/g;
    const datePattern2 = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
    const dates = [];
    let m;
    while ((m = datePattern1.exec(text)) !== null) {
        dates.push(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
    }
    datePattern1.lastIndex = 0;
    while ((m = datePattern2.exec(text)) !== null) {
        dates.push(`${today.getFullYear()}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
    }
    if (dates.length >= 2) {
        result.startDate = dates[0];
        result.endDate = dates[1];
    } else if (dates.length === 1) {
        result.startDate = dates[0];
        result.endDate = dates[0];
    }

    // 提取天数
    const dayMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:天|日)/);
    if (dayMatch) result.days = parseFloat(dayMatch[1]);

    // 提取事由（"因为"/"原因"/"事由"之后到句尾）
    const reasonMatch = text.match(/(?:因为|原因|事由|事宜)[：:\s]*(.+)/);
    if (reasonMatch) result.reason = reasonMatch[1].trim();

    return result;
}

// ============================================================
//  AI 解析接口（供内部调用）
// ============================================================
app.post('/api/ai/parse', async (req, res) => {
    try {
        const { text, prompt } = req.body;
        // 调用 OpenClaw 模型（通过 stdout 调用 qclaw 命令行，或直接使用 axios 调用模型 API）
        // 这里提供一个简单实现：调用本地 Ollama 或 OpenAI 兼容接口
        // 如果用户没有配置，返回正则表达式解析结果
        const result = parseLeaveByRegex(text, new Date());
        res.json({ success: true, result: JSON.stringify(result) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
//  微信通知
// ============================================================
async function sendWechatNotify(title, content) {
    try {
        const configs = await query('SELECT * FROM leave_system.wechat_config WHERE enabled = TRUE LIMIT 1');
        if (configs.length === 0) { console.log('[WX] No config, skip'); return; }
        const cfg = configs[0];

        if (cfg.provider === 'serverchan') {
            // Server酱 v1: sc.ftqq.com/{SENDKEY}.send
            const url = `https://sc.ftqq.com/${cfg.api_key}.send?text=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`;
            await axios.get(url, { timeout: 8000 });
        } else if (cfg.provider === 'pushplus') {
            const url = `http://www.pushplus.plus/send?token=${cfg.api_key}&title=${encodeURIComponent(title)}&content=${encodeURIComponent(content)}`;
            await axios.get(url, { timeout: 8000 });
        } else if (cfg.provider === 'wecom' && cfg.webhook_url) {
            await axios.post(cfg.webhook_url, {
                msgtype: 'text',
                text: { content: `${title}\n${content}` }
            }, { timeout: 8000 });
        }
        console.log('[WX] Notified:', title);
    } catch (e) {
        console.log('[WX] Notify failed:', e.message);
    }
}

// ============================================================
//  微信消息接收 Webhook（公众号/小程序回调）
// ============================================================
app.post('/api/wechat/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let xmlStr = '';
    let fromUser = '', toUser = '';
    try {
        // 兼容多种编码：UTF-8 / UTF-8 BOM / GBK
        let buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
        // 去掉 BOM (EF BB BF)
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
            buffer = buffer.slice(3);
        }
        xmlStr = buffer.toString('utf-8');
        console.log('[WX] 收到微信消息:', xmlStr.slice(0, 200));

        // 解析微信 XML CDATA
        const getVal = (xml, tag) => {
            const start = xml.indexOf(`<${tag}>`);
            if (start === -1) return '';
            const cdStart = xml.indexOf('<![CDATA[', start);
            if (cdStart === -1 || cdStart > xml.indexOf(`</${tag}>`, start)) return '';
            return xml.substring(cdStart + '<![CDATA['.length, xml.indexOf(']]>', cdStart)).trim();
        };

        const msgType = getVal(xmlStr, 'MsgType');
        const content = getVal(xmlStr, 'Content');
        fromUser = getVal(xmlStr, 'FromUserName');
        toUser = getVal(xmlStr, 'ToUserName');

        const reply = (text) => {
            res.set('Content-Type', 'application/xml');
            res.send(`<xml><ToUserName><![CDATA[${fromUser}]]></ToUserName><FromUserName><![CDATA[${toUser}]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime></xml>`);
        };

        if (msgType !== 'text') return reply('仅支持文字消息');

        // 用 AI 解析消息
        const parsed = await aiParseLeaveMessage(content);
        console.log('[AI] Parsed result:', JSON.stringify(parsed, null, 2));

        if (!parsed.isLeaveRequest) {
            return reply('未识别到请假意图。\n\n发送格式参考：\n我要请3天年假，6月15到17号，去旅游\n\n或：请假#姓名#类型#开始#结束#天数#事由');
        }

        // 查找用户
        let userName = parsed.userName;
        if (!userName) {
            // 根据微信 FromUserName 查 wx_id
            const u = await query('SELECT id, name FROM leave_system.users WHERE wx_id = ? LIMIT 1', [fromUser]);
            if (u.length > 0) userName = u[0].name;
        }
        if (!userName) {
            return reply('❌ 未能识别您的姓名，请在消息中说明您的姓名，例如：\n我是张三，要请3天年假');
        }

        const users = await query('SELECT id, name, department FROM leave_system.users WHERE name = ? OR username = ? LIMIT 1', [userName, userName]);
        if (users.length === 0) {
            return reply(`❌ 未找到员工「${userName}」，请联系管理员添加`);
        }
        const userId = users[0].id;
        const userDept = users[0].department;

        // 计算天数
        let days = parsed.days;
        if (!days && parsed.startDate && parsed.endDate) {
            const s = new Date(parsed.startDate);
            const e = new Date(parsed.endDate);
            days = Math.round((e - s) / 86400000) + 1;
        }
        if (!days || days <= 0) days = 1;

        const today = new Date();
        const type = parsed.type || '事假';
        const startDate = parsed.startDate || today.toISOString().slice(0, 10);
        const endDate = parsed.endDate || startDate;

        // 获取审批人
        const managers = await query('SELECT id, name FROM leave_system.users WHERE role = ? AND department = ? LIMIT 1', ['MANAGER', userDept]);
        const approver_id = managers.length > 0 ? managers[0].id : null;

        // 插入请假记录
        const result = await query(
            'INSERT INTO leave_system.leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (?,?,?,?,?,?,?,?)',
            [userId, type, startDate, endDate, days, parsed.reason || '微信消息提交', 'PENDING', approver_id]
        );

        // 通知审批人
        if (approver_id) {
            await sendWechatNotify(
                '【微信请假申请】来自 ' + users[0].name,
                `申请人：${users[0].name}（${userDept}）\n类型：${type}\n时间：${startDate} 至 ${endDate}（共 ${days} 天）\n事由：${parsed.reason || '无'}\n\n↗ 来自微信消息自动创建，请登录系统审批`
            );
        }

        reply(`✅ 请假申请已提交！\n━━━━━━━━━━━━━━━━━\n申请人：${users[0].name}\n类型：${type}\n时间：${startDate} 至 ${endDate}\n天数：${days} 天\n事由：${parsed.reason || '无'}\n━━━━━━━━━━━━━━━━━\n状态：⏳ 待审批\n\n请等待主管审批，结果将通知您`);
    } catch (e) {
        console.log('[WX] Webhook error:', e.message);
        res.set('Content-Type', 'application/xml');
        res.send(`<xml><ToUserName><![CDATA[${fromUser}]]></ToUserName><FromUserName><![CDATA[${toUser}]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[服务器错误，请稍后重试]]></Content></xml>`);
    }
});

// 微信 URL 验证（微信公众号后台配置用）
app.get('/api/wechat/webhook', (req, res) => {
    const { echostr } = req.query;
    if (echostr) return res.send(echostr);
    res.json({ ok: true, msg: 'WeChat webhook is active' });
});

// ============================================================
//  （以下为公文流转系统原有接口，保持不变）
// ============================================================
function authMiddleware(req, res, next) {
    const session = req.headers['authorization'] || '';
    const match = session.match(/session_(\d+)/);
    if (!match) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.userId = parseInt(match[1]);
    next();
}

// ---------- 公开 API（免登录）----------
app.get('/api/public/users', async (req, res) => {
    try {
        const rows = await query('SELECT id, name, username, department FROM leave_system.users ORDER BY id');
        res.json({ success: true, users: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/public/leave/list', async (req, res) => {
    try {
        const rows = await query(`
            SELECT lr.*, u.name as user_name, u.department
            FROM leave_system.leave_requests lr
            LEFT JOIN leave_system.users u ON lr.user_id = u.id
            ORDER BY lr.created_at DESC
        `);
        res.json({ success: true, requests: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/public/leave/stats', async (req, res) => {
    try {
        const [total, pending, approved, rejected] = await Promise.all([
            query('SELECT COUNT(*) as count FROM leave_system.leave_requests'),
            query('SELECT COUNT(*) as count FROM leave_system.leave_requests WHERE status="PENDING"'),
            query('SELECT COUNT(*) as count FROM leave_system.leave_requests WHERE status="APPROVED"'),
            query('SELECT COUNT(*) as count FROM leave_system.leave_requests WHERE status="REJECTED"')
        ]);
        res.json({
            success: true,
            stats: {
                total: total[0].count,
                pending: pending[0].count,
                approved: approved[0].count,
                rejected: rejected[0].count
            }
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/public/leave/submit', async (req, res) => {
    try {
        const { userId, type, startDate, endDate, days, reason } = req.body;
        await query(
            'INSERT INTO leave_system.leave_requests (user_id, type, start_date, end_date, days, status, reason) VALUES (?,?,?,?,?,?,?)',
            [userId, type, startDate, endDate, days, 'PENDING', reason || '']
        );
        // 发送微信通知
        const user = await query('SELECT name FROM leave_system.users WHERE id = ?', [userId]);
        if (user.length > 0) {
            sendWechatNotify(`【新请假申请】\n申请人：${user[0].name}\n类型：${type}\n时间：${startDate} 至 ${endDate}\n天数：${days}天\n事由：${reason || '无'}`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/public/leave/approve/:id', async (req, res) => {
    try {
        await query('UPDATE leave_system.leave_requests SET status="APPROVED", updated_at=NOW() WHERE id=?', [req.params.id]);
        const rows = await query(`SELECT lr.*, u.name as user_name FROM leave_system.leave_requests lr LEFT JOIN leave_system.users u ON lr.user_id = u.id WHERE lr.id=?`, [req.params.id]);
        if (rows.length > 0) {
            sendWechatNotify(`【请假已通过】\n申请人：${rows[0].user_name}\n时间：${formatDate(rows[0].start_date)} 至 ${formatDate(rows[0].end_date)}\n状态：✅ 已批准`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/public/leave/reject/:id', async (req, res) => {
    try {
        await query('UPDATE leave_system.leave_requests SET status="REJECTED", updated_at=NOW() WHERE id=?', [req.params.id]);
        const rows = await query(`SELECT lr.*, u.name as user_name FROM leave_system.leave_requests lr LEFT JOIN leave_system.users u ON lr.user_id = u.id WHERE lr.id=?`, [req.params.id]);
        if (rows.length > 0) {
            sendWechatNotify(`【请假已拒绝】\n申请人：${rows[0].user_name}\n时间：${formatDate(rows[0].start_date)} 至 ${formatDate(rows[0].end_date)}\n状态：❌ 已拒绝`);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

function formatDate(d) { return d ? new Date(d).toISOString().split('T')[0] : '-'; }

// ---------- 认证 ----------
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM document_flow.users WHERE username = ? AND password = ?', [username, password], (err, users) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (users.length > 0) {
            const user = users[0];
            delete user.password;
            res.json({ success: true, user, token: 'session_' + user.id });
        } else {
            res.status(401).json({ success: false, message: '用户名或密码错误' });
        }
    });
});

app.get('/api/users', authMiddleware, (req, res) => {
    db.query('SELECT id, username, name, role, department, email, phone FROM document_flow.users', (err, users) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        res.json(users);
    });
});

// ---------- 公文 ----------
app.get('/api/docs', authMiddleware, (req, res) => {
    let sql = `SELECT d.*, u1.name as creatorName, u2.name as approverName FROM document_flow.documents d LEFT JOIN document_flow.users u1 ON d.creator_id = u1.id LEFT JOIN document_flow.users u2 ON d.approver_id = u2.id WHERE 1=1 `;
    const params = [];
    if (req.query.status && req.query.status !== 'all') { sql += ' AND d.status = ?'; params.push(req.query.status); }
    if (req.query.department && req.query.department !== 'all') { sql += ' AND d.department = ?'; params.push(req.query.department); }
    if (req.query.keyword) { sql += ' AND (d.title LIKE ? OR d.content LIKE ?)'; params.push('%'+req.query.keyword+'%', '%'+req.query.keyword+'%'); }
    if (req.query.creatorId) { sql += ' AND d.creator_id = ?'; params.push(req.query.creatorId); }
    sql += ' ORDER BY d.updated_at DESC';
    db.query(sql, params, (err, docs) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        res.json(docs);
    });
});

app.get('/api/docs/:id', authMiddleware, (req, res) => {
    db.query(`SELECT d.*, u1.name as creatorName, u2.name as approverName FROM document_flow.documents d LEFT JOIN document_flow.users u1 ON d.creator_id = u1.id LEFT JOIN document_flow.users u2 ON d.approver_id = u2.id WHERE d.id = ?`, [req.params.id], (err, docs) => {
        if (err || docs.length === 0) return res.status(404).json({ message: 'Not found' });
        db.query('SELECT l.*, u.name as approverName FROM document_flow.approval_logs l LEFT JOIN document_flow.users u ON l.approver_id = u.id WHERE l.document_id = ? ORDER BY l.created_at ASC', [req.params.id], (err2, logs) => {
            if (err2) return res.status(500).json({ message: 'Server error' });
            res.json({ ...docs[0], comments: logs });
        });
    });
});

app.post('/api/docs', authMiddleware, (req, res) => {
    const { title, content, type, priority, department } = req.body;
    db.query('INSERT INTO document_flow.documents (title, content, type, status, priority, department, creator_id) VALUES (?,?,?,?,?,?,?)',
        [title, content, type||'Report', 'DRAFT', priority||'normal', department, req.userId],
        (err, result) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            db.query('SELECT * FROM document_flow.documents WHERE id = ?', [result.insertId], (e2, d2) => res.json(d2[0]));
        });
});

app.put('/api/docs/:id', authMiddleware, (req, res) => {
    const { title, content, type, priority, department } = req.body;
    db.query('UPDATE document_flow.documents SET title=?, content=?, type=?, priority=?, department=?, updated_at=NOW() WHERE id=?',
        [title, content, type, priority, department, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            db.query('SELECT * FROM document_flow.documents WHERE id = ?', [req.params.id], (e2, d2) => res.json(d2[0]));
        });
});

app.post('/api/docs/:id/submit', authMiddleware, (req, res) => {
    const { approverId } = req.body;
    db.query('UPDATE document_flow.documents SET status=?, approver_id=?, updated_at=NOW() WHERE id=?',
        ['PENDING', approverId, req.params.id], (err) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            db.query('INSERT INTO document_flow.approval_logs (document_id, approver_id, action, comment) VALUES (?,?,?,?)',
                [req.params.id, approverId, 'SUBMIT', 'Submitted for approval'], () => {
                    db.query('SELECT * FROM document_flow.documents WHERE id = ?', [req.params.id], (e2, d2) => res.json(d2[0]));
                });
    });
});

app.post('/api/docs/:id/approve', authMiddleware, (req, res) => {
    const { action, comment } = req.body;
    db.query('UPDATE document_flow.documents SET status=?, updated_at=NOW() WHERE id=?', [action, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        db.query('INSERT INTO document_flow.approval_logs (document_id, approver_id, action, comment) VALUES (?,?,?,?)',
            [req.params.id, req.userId, action, comment||''], () => {
                db.query('SELECT * FROM document_flow.documents WHERE id = ?', [req.params.id], (e2, d2) => res.json(d2[0]));
            });
    });
});

app.delete('/api/docs/:id', authMiddleware, (req, res) => {
    db.query('DELETE FROM document_flow.approval_logs WHERE document_id = ?', [req.params.id], () => {
        db.query('DELETE FROM document_flow.documents WHERE id = ?', [req.params.id], () => res.json({ success: true }));
    });
});

// ---------- 公文统计 ----------
app.get('/api/stats', authMiddleware, (req, res) => {
    const stats = {};
    let done = 0;
    function cd() { if (++done === 4) res.json(stats); }
    db.query('SELECT COUNT(*) as c FROM document_flow.documents', (e,r) => { stats.total=r[0].c; cd(); });
    db.query("SELECT COUNT(*) as c FROM document_flow.documents WHERE status='PENDING'", (e,r) => { stats.pending=r[0].c; cd(); });
    db.query("SELECT COUNT(*) as c FROM document_flow.documents WHERE status='APPROVED'", (e,r) => { stats.approved=r[0].c; cd(); });
    db.query("SELECT COUNT(*) as c FROM document_flow.documents WHERE status='REJECTED'", (e,r) => { stats.rejected=r[0].c; cd(); });
});

// ============================================================
//  （以下为请假系统接口，合并进来）
// ============================================================

// ---------- 当前用户（兼用 authMiddleware）----------
app.get('/api/auth/me', authMiddleware, (req, res) => {
    db.query('SELECT id, username, name, role, department FROM leave_system.users WHERE id = ?', [req.userId], (err, users) => {
        if (err || users.length === 0) return res.status(401).json({ success: false });
        res.json({ success: true, user: users[0] });
    });
});

// ---------- 请假列表 ----------
app.get('/api/leave', authMiddleware, async (req, res) => {
    try {
        const user = (await query('SELECT role, department FROM leave_system.users WHERE id = ?', [req.userId]))[0];
        let sql, params;
        if (user.role === 'ADMIN') {
            sql = `SELECT l.*, u.name as userName, u.department, a.name as approverName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id LEFT JOIN leave_system.users a ON l.approver_id=a.id ORDER BY l.created_at DESC`;
            params = [];
        } else if (user.role === 'MANAGER') {
            sql = `SELECT l.*, u.name as userName, u.department, a.name as approverName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id LEFT JOIN leave_system.users a ON l.approver_id=a.id WHERE u.department = ? ORDER BY l.created_at DESC`;
            params = [user.department];
        } else {
            sql = `SELECT l.*, u.name as userName, u.department, a.name as approverName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id LEFT JOIN leave_system.users a ON l.approver_id=a.id WHERE l.user_id = ? ORDER BY l.created_at DESC`;
            params = [req.userId];
        }
        const rows = await query(sql, params);
        res.json(rows);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 提交请假 ----------
app.post('/api/leave', authMiddleware, async (req, res) => {
    try {
        const { type, start_date, end_date, days, reason } = req.body;
        if (!type || !start_date || !end_date || !days) return res.status(400).json({ message: '缺少必填字段' });

        const users = await query('SELECT name, department FROM leave_system.users WHERE id = ?', [req.userId]);
        if (users.length === 0) return res.status(401).json({ message: '用户不存在' });
        const user = users[0];

        const managers = await query('SELECT id, name FROM leave_system.users WHERE role = ? AND department = ? LIMIT 1', ['MANAGER', user.department]);
        const approver_id = managers.length > 0 ? managers[0].id : null;

        const result = await query(
            'INSERT INTO leave_system.leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id) VALUES (?,?,?,?,?,?,?,?)',
            [req.userId, type, start_date, end_date, days, reason || '', 'PENDING', approver_id]
        );

        const record = (await query('SELECT l.*, u.name as userName, a.name as approverName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id LEFT JOIN leave_system.users a ON l.approver_id=a.id WHERE l.id = ?', [result.insertId]))[0];

        if (approver_id) {
            const manager = (await query('SELECT name FROM leave_system.users WHERE id = ?', [approver_id]))[0];
            await sendWechatNotify(
                '【请假申请】来自 ' + user.name,
                `申请人：${user.name}（${user.department}）\n类型：${type}\n时间：${start_date} 至 ${end_date}（共 ${days} 天）\n事由：${reason || '无'}\n\n请登录系统审批：http://localhost:${PORT}`
            );
        }

        res.json({ success: true, record });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 请假详情 ----------
app.get('/api/leave/:id', authMiddleware, async (req, res) => {
    try {
        const rows = await query('SELECT l.*, u.name as userName, a.name as approverName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id LEFT JOIN leave_system.users a ON l.approver_id=a.id WHERE l.id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Not found' });
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 取消请假 ----------
app.put('/api/leave/:id/cancel', authMiddleware, async (req, res) => {
    try {
        const rows = await query('SELECT * FROM leave_system.leave_requests WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
        if (rows.length === 0) return res.status(404).json({ message: 'Not found or unauthorized' });
        if (rows[0].status !== 'PENDING') return res.status(400).json({ message: '只能取消待审批的请假' });
        await query('UPDATE leave_system.leave_requests SET status = ? WHERE id = ?', ['CANCELLED', req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 审批通过 ----------
app.post('/api/leave/:id/approve', authMiddleware, async (req, res) => {
    try {
        const { comment } = req.body;
        const rows = await query('SELECT l.*, u.name as userName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id WHERE l.id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Not found' });
        if (rows[0].status !== 'PENDING') return res.status(400).json({ message: '当前状态不允许审批' });

        await query('UPDATE leave_system.leave_requests SET status = ?, approver_id = ?, approver_comment = ? WHERE id = ?',
            ['APPROVED', req.userId, comment || '', req.params.id]);

        await sendWechatNotify(
            '【请假已通过】来自 ' + rows[0].userName,
            `申请人：${rows[0].userName}\n请假类型：${rows[0].type}\n时间：${rows[0].start_date} 至 ${rows[0].end_date}（共 ${rows[0].days} 天）\n\n审批结果：通过 ✓\n审批意见：${comment || '同意'}`
        );

        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 审批驳回 ----------
app.post('/api/leave/:id/reject', authMiddleware, async (req, res) => {
    try {
        const { comment } = req.body;
        const rows = await query('SELECT l.*, u.name as userName FROM leave_system.leave_requests l LEFT JOIN leave_system.users u ON l.user_id=u.id WHERE l.id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Not found' });
        if (rows[0].status !== 'PENDING') return res.status(400).json({ message: '当前状态不允许审批' });

        await query('UPDATE leave_system.leave_requests SET status = ?, approver_id = ?, approver_comment = ? WHERE id = ?',
            ['REJECTED', req.userId, comment || '', req.params.id]);

        await sendWechatNotify(
            '【请假被驳回】来自 ' + rows[0].userName,
            `申请人：${rows[0].userName}\n请假类型：${rows[0].type}\n时间：${rows[0].start_date} 至 ${rows[0].end_date}（共 ${rows[0].days} 天）\n\n审批结果：驳回 ✗\n驳回原因：${comment || '不符合规定'}`
        );

        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 请假统计 ----------
app.get('/api/leave/stats', authMiddleware, async (req, res) => {
    try {
        const user = (await query('SELECT role FROM leave_system.users WHERE id = ?', [req.userId]))[0];
        const uid = user.role === 'ADMIN' ? null : req.userId;
        const r1 = uid ? (await query('SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE user_id = ?', [uid])) : (await query('SELECT COUNT(*) as c FROM leave_system.leave_requests'));
        const r2 = uid ? (await query("SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE status='PENDING' AND user_id = ?", [uid])) : (await query("SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE status='PENDING'"));
        const r3 = uid ? (await query("SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE status='APPROVED' AND user_id = ?", [uid])) : (await query("SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE status='APPROVED'"));
        const r4 = uid ? (await query("SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE status='REJECTED' AND user_id = ?", [uid])) : (await query("SELECT COUNT(*) as c FROM leave_system.leave_requests WHERE status='REJECTED'"));
        res.json({ total: r1[0].c, pending: r2[0].c, approved: r3[0].c, rejected: r4[0].c });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ---------- 微信配置 ----------
app.get('/api/config/wechat', authMiddleware, async (req, res) => {
    try {
        const rows = await query('SELECT id, provider, api_key, webhook_url, enabled FROM leave_system.wechat_config LIMIT 1');
        res.json(rows[0] || {});
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.put('/api/config/wechat', authMiddleware, async (req, res) => {
    try {
        const { provider, api_key, webhook_url, enabled } = req.body;
        const exists = await query('SELECT id FROM leave_system.wechat_config LIMIT 1');
        if (exists.length > 0) {
            await query('UPDATE leave_system.wechat_config SET provider=?, api_key=?, webhook_url=?, enabled=? WHERE id=?', [provider, api_key||'', webhook_url||'', enabled!==false, exists[0].id]);
        } else {
            await query('INSERT INTO leave_system.wechat_config (provider, api_key, webhook_url, enabled) VALUES (?,?,?,?)', [provider, api_key||'', webhook_url||'', enabled!==false]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
//  启动
// ============================================================
app.listen(PORT, () => {
    console.log('========================================');
    console.log('  公文流转 + 请假系统（合并版）');
    console.log('========================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log('DB: document_flow + leave_system | root/root');
    db.query('SELECT COUNT(*) as c FROM document_flow.users', (e,r) => { if (!e) console.log(`  document_flow: ${r[0].c} users`); });
    db.query('SELECT COUNT(*) as c FROM document_flow.documents', (e,r) => { if (!e) console.log(`  document_flow: ${r[0].c} docs`); });
    db.query('SELECT COUNT(*) as c FROM leave_system.users', (e,r) => { if (!e) console.log(`  leave_system:  ${r[0].c} users`); });
    db.query('SELECT COUNT(*) as c FROM leave_system.leave_requests', (e,r) => { if (!e) console.log(`  leave_system:  ${r[0].c} leave requests`); });
    console.log('========================================');
    console.log('WeChat webhook: /api/wechat/webhook');
    console.log('========================================');
});
