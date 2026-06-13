// auth-routes.js - 登录/Auth 中间件
'use strict';
const crypto = require('crypto');

module.exports = function initAuth(db, query, run, cryptoModule) {
    const crypto_ = cryptoModule || crypto;
    const md5 = p => crypto_.createHash('md5').update(p).digest('hex');

    function jwtSign(payload, secret) {
        const h = crypto_.createHmac('sha256', secret || 'docflow-secret-2024');
        const b64 = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
        const sig = h.update(b64).digest('base64url');
        return b64 + '.' + sig;
    }

    // Auth 中间件
    function auth(req, res, next) {
        const header = req.headers.authorization || '';
        if (!header.startsWith('Bearer ')) return res.status(401).json({ message: '未登录' });
        const token = header.slice(7);
        try {
            const [b64, sig] = token.split('.');
            const h = crypto_.createHmac('sha256', 'docflow-secret-2024').update(b64).digest('base64url');
            if (h !== sig) throw new Error('invalid sig');
            const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
            req.userId = payload.id;
            req.userRole = payload.role;
            next();
        } catch (e) {
            res.status(401).json({ message: '无效凭证' });
        }
    }

    // 路由
    function addRoutes(app) {
        // 账号密码登录
        app.post('/api/auth/login', (req, res) => {
            const { username, password } = req.body || {};
            if (!username || !password) return res.json({ success: false, error: '缺少用户名或密码' });

            const hashedPwd = md5(password);
            const users = query('SELECT id, username, name, role, email FROM users WHERE username = ? AND password = ?', [username, hashedPwd]);
            if (!users.length) return res.json({ success: false, error: '用户名或密码错误' });

            const user = users[0];
            const token = jwtSign({ id: user.id, role: user.role, username: user.username });
            console.log(`[登录] 用户: ${username} (ID=${user.id})`);
            res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email } });
        });

        console.log('[OK] Auth 路由已注册');
    }

    return { addRoutes, auth };
};
