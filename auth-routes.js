// auth-routes.js - ??/??/OAuth ????
// ??? server-sqlite.js ? require ??? initAuth(db, query, run, crypto)
'use strict';
const nodemailer = require('nodemailer');
const crypto = require('crypto');

module.exports = function initAuth(db, query, run, cryptoModule) {
    const crypto_ = cryptoModule || crypto;
    const md5 = p => crypto_.createHash('md5').update(p).digest('hex');

    // ---------- ???? ----------
    const verificationCodes = new Map(); // email -> { code, type, expires }
    const pendingUsers = new Map();       // email -> { username, password, name, code, expires }

    // ---------- SMTP ?? ----------
    let transporter = null;
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const FROM_NAME  = process.env.SMTP_FROM_NAME || '????';

    if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        console.log('[Auth] SMTP ???: ' + SMTP_HOST);
    } else {
        console.log('[Auth] SMTP ???,???????');
    }

    // ---------- ???? ----------
    function generateCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }
    function cleanupExpired() {
        const now = Date.now();
        for (const [k, v] of verificationCodes) {
            if (now > v.expires) verificationCodes.delete(k);
        }
        for (const [k, v] of pendingUsers) {
            if (now > v.expires) pendingUsers.delete(k);
        }
    }
    setInterval(cleanupExpired, 5 * 60 * 1000); // ?5????

    function jwtSign(payload, secret) {
        const h = crypto_.createHmac('sha256', secret || 'docflow-secret-2024');
        const b64 = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
        const sig = h.update(b64).digest('base64url');
        return b64 + '.' + sig;
    }

    // ---------- Auth ??? ----------
    function auth(req, res, next) {
        const header = req.headers.authorization || '';
        if (!header.startsWith('Bearer ')) return res.status(401).json({ message: '???' });
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
            res.status(401).json({ message: '????' });
        }
    }

    // ---------- ?? ----------
    function addRoutes(app) {
        // ???????
        app.get('/api/auth/methods', (req, res) => {
            res.json({
                success: true,
                methods: {
                    password:   { enabled: true,  label: '??????' },
                    email_code: { enabled: !!transporter, label: '???????' },
                    github:     { enabled: !!process.env.GITHUB_CLIENT_ID, label: 'GitHub ??' },
                    wechat:     { enabled: false, label: '????' },
                    qq:         { enabled: false, label: 'QQ ??' }
                }
            });
        });

        // ?????
        app.post('/api/auth/send-code', async (req, res) => {
            const { email, type } = req.body || {};
            if (!email || !email.includes('@')) return res.json({ success: false, error: '????' });
            if (!['register', 'login', 'bind'].includes(type)) return res.json({ success: false, error: '????' });

            const code = generateCode();
            verificationCodes.set(email, { code, type, expires: Date.now() + 10 * 60 * 1000 });

            if (transporter) {
                try {
                    await transporter.sendMail({
                        from: `"${FROM_NAME}" <${SMTP_USER}>`,
                        to: email, subject: '???????',
                        html: `<h2>??????:<strong style="font-size:24px;color:#1a73e8">${code}</strong></h2><p>10?????,???????</p>`
                    });
                    return res.json({ success: true, message: '?????????' });
                } catch (e) {
                    console.error('[Auth] ??????:', e.message);
                }
            }
            // ????
            console.log(`[Auth] SMTP ???,???????\n[??] ??? ${code} -> ${email}`);
            res.json({ success: true, mode: 'simulated', message: `???:${code}(????)` });
        });

        // ??
        app.post('/api/auth/register', (req, res) => {
            const { username, password, name, email, code } = req.body || {};
            if (!username || !password || !name || !email) return res.json({ success: false, error: '??????' });
            if (password.length < 6) return res.json({ success: false, error: '????6?' });

            // ?????(?????SMTP??)
            if (transporter) {
                const v = verificationCodes.get(email);
                if (!v || v.code !== code || v.type !== 'register') {
                    return res.json({ success: false, error: '?????????' });
                }
                verificationCodes.delete(email);
            }

            // ??????????
            const existing = query('SELECT id FROM users WHERE username = ?', [username]);
            if (existing.length) return res.json({ success: false, error: '???????' });

            // ????(MD5??)
            const hashedPwd = md5(password);
            run('INSERT INTO users (username, password, name, role, email, verified) VALUES (?, ?, ?, ?, ?, 1)',
                [username, hashedPwd, name, 'EMPLOYEE', email]);

            const users = query('SELECT id, username, name, role, email FROM users WHERE username = ?', [username]);
            const user = users[0];
            const token = jwtSign({ id: user.id, role: user.role, username: user.username });
            console.log(`[??] ???: ${username} (ID=${user.id}) ??=${email}`);

            res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role, email: user.email } });
        });

        // OAuth ??
        app.get('/api/auth/oauth/:provider', (req, res) => {
            const { provider } = req.params;
            if (provider === 'github' && process.env.GITHUB_CLIENT_ID) {
                const redirect = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=read:user`;
                return res.redirect(redirect);
            }
            if (provider === 'wechat') return res.json({ success: false, error: '???????,??????', unconfigured: true });
            if (provider === 'qq')      return res.json({ success: false, error: 'QQ ?????,??????', unconfigured: true });
            res.json({ success: false, error: `${provider} ?????` });
        });

        // GitHub OAuth ??
        app.get('/api/auth/oauth/github/callback', async (req, res) => {
            const { code } = req.query;
            if (!code) return res.status(400).json({ success: false, error: '?? code' });
            try {
                // ? code ? access_token
                const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code })
                });
                const tokenData = await tokenResp.json();
                const accessToken = tokenData.access_token;
                if (!accessToken) return res.status(400).json({ success: false, error: 'GitHub ????' });

                // ?? GitHub ????
                const userResp = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github.v3+json' } });
                const ghUser = await userResp.json();

                // ?????????
                let users = query('SELECT id, username, name, role FROM users WHERE oauth_provider = ? AND oauth_id = ?', ['github', String(ghUser.id)]);
                let user, isNew = false;
                if (!users.length) {
                    // ????(oauth??)
                    run('INSERT INTO users (username, password, name, role, oauth_provider, oauth_id, verified) VALUES (?, ?, ?, ?, ?, ?, 1)',
                        [`gh_${ghUser.login}`, md5(crypto_.randomBytes(16).toString()), ghUser.name || ghUser.login, 'EMPLOYEE', 'github', String(ghUser.id)]);
                    users = query('SELECT id, username, name, role FROM users WHERE oauth_provider = ? AND oauth_id = ?', ['github', String(ghUser.id)]);
                    isNew = true;
                }
                user = users[0];
                const token = jwtSign({ id: user.id, role: user.role, username: user.username });
                console.log(`[OAuth] GitHub ??: ${ghUser.login} -> ????: ${user.username} (new=${isNew})`);

                // ?? token ???(?? URL ??)
                res.redirect(`/?oauth=github&token=${token}&username=${encodeURIComponent(user.username)}`);
            } catch (e) {
                console.error('[OAuth] GitHub callback error:', e.message);
                res.status(500).json({ success: false, error: 'OAuth ????' });
            }
        });

        // ????(???)
        app.get('/api/auth/verify/:token', (req, res) => {
            try {
                const [b64, sig] = req.params.token.split('.');
                const h = crypto_.createHmac('sha256', 'docflow-secret-2024').update(b64).digest('base64url');
                if (h !== sig) throw new Error('invalid');
                const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
                if (payload.type !== 'verify_email') throw new Error('wrong type');
                run('UPDATE users SET verified = 1 WHERE id = ?', [payload.userId]);
                res.send('<h2>??????!??????,???????</h2><script>setTimeout(()=>window.close(),3000)</script>');
            } catch (e) {
                res.status(400).send('??????????');
            }
        });

        console.log('[OK] Auth ?????');
    }

    return { addRoutes, auth };
};
