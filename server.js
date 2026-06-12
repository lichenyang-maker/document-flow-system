// 公文流转审批系统 - MySQL后端服务
const express = require('express');
const mysql = require('mysql2');
const path = require('path');

const app = express();
const PORT = 3000;

// MySQL连接
const db = mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'root',
    database: 'document_flow',
    charset: 'utf8mb4'
});

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// 连接数据库
db.connect((err) => {
    if (err) {
        console.error('[ERROR] MySQL:', err.message);
    } else {
        console.log('[OK] MySQL Connected');
    }
});

// 辅助函数
function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, results) => {
            if (err) reject(err);
            else resolve(results);
        });
    });
}

// ============ 认证接口 ============
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, users) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (users.length > 0) {
            const user = users[0];
            delete user.password;
            res.json({ success: true, user, token: 'session_' + user.id });
        } else {
            res.status(401).json({ success: false, message: 'Username or password incorrect' });
        }
    });
});

app.get('/api/users', (req, res) => {
    db.query('SELECT id, username, name, role, department, email, phone FROM users', (err, users) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        res.json(users);
    });
});

// ============ 公文接口 ============
app.get('/api/docs', (req, res) => {
    const { status, department, keyword, creatorId } = req.query;
    let sql = `
        SELECT d.*, u1.name as creatorName, u2.name as approverName 
        FROM documents d 
        LEFT JOIN users u1 ON d.creator_id = u1.id 
        LEFT JOIN users u2 ON d.approver_id = u2.id 
        WHERE 1=1
    `;
    const params = [];
    
    if (status && status !== 'all') { sql += ' AND d.status = ?'; params.push(status); }
    if (department && department !== 'all') { sql += ' AND d.department = ?'; params.push(department); }
    if (keyword) { sql += ' AND (d.title LIKE ? OR d.content LIKE ?)'; params.push('%' + keyword + '%', '%' + keyword + '%'); }
    if (creatorId) { sql += ' AND d.creator_id = ?'; params.push(creatorId); }
    
    sql += ' ORDER BY d.updated_at DESC';
    
    db.query(sql, params, (err, docs) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        res.json(docs);
    });
});

app.get('/api/docs/:id', (req, res) => {
    db.query(`
        SELECT d.*, u1.name as creatorName, u2.name as approverName 
        FROM documents d 
        LEFT JOIN users u1 ON d.creator_id = u1.id 
        LEFT JOIN users u2 ON d.approver_id = u2.id 
        WHERE d.id = ?
    `, [req.params.id], (err, docs) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        if (docs.length === 0) return res.status(404).json({ message: 'Document not found' });
        
        db.query(`
            SELECT l.*, u.name as approverName 
            FROM approval_logs l 
            LEFT JOIN users u ON l.approver_id = u.id 
            WHERE l.document_id = ? 
            ORDER BY l.created_at ASC
        `, [req.params.id], (err, logs) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            res.json({ ...docs[0], comments: logs });
        });
    });
});

app.post('/api/docs', (req, res) => {
    const { title, content, type, priority, department, creatorId } = req.body;
    db.query(
        'INSERT INTO documents (title, content, type, status, priority, department, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [title, content, type || 'Report', 'DRAFT', priority || 'normal', department, creatorId],
        (err, result) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            db.query('SELECT * FROM documents WHERE id = ?', [result.insertId], (err, docs) => {
                if (err) return res.status(500).json({ message: 'Server error' });
                res.json(docs[0]);
            });
        }
    );
});

app.put('/api/docs/:id', (req, res) => {
    const { title, content, type, priority, department } = req.body;
    db.query(
        'UPDATE documents SET title = ?, content = ?, type = ?, priority = ?, department = ?, updated_at = NOW() WHERE id = ?',
        [title, content, type, priority, department, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            db.query('SELECT * FROM documents WHERE id = ?', [req.params.id], (err, docs) => {
                if (err) return res.status(500).json({ message: 'Server error' });
                res.json(docs[0]);
            });
        }
    );
});

app.post('/api/docs/:id/submit', (req, res) => {
    const { approverId } = req.body;
    db.query(
        'UPDATE documents SET status = ?, approver_id = ?, updated_at = NOW() WHERE id = ?',
        ['PENDING', approverId, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            db.query(
                'INSERT INTO approval_logs (document_id, approver_id, action, comment) VALUES (?, ?, ?, ?)',
                [req.params.id, approverId, 'SUBMIT', 'Submitted for approval'],
                (err) => {
                    if (err) return res.status(500).json({ message: 'Server error' });
                    db.query('SELECT * FROM documents WHERE id = ?', [req.params.id], (err, docs) => {
                        if (err) return res.status(500).json({ message: 'Server error' });
                        res.json(docs[0]);
                    });
                }
            );
        }
    );
});

app.post('/api/docs/:id/approve', (req, res) => {
    const { action, comment, approverId } = req.body;
    db.query('UPDATE documents SET status = ?, updated_at = NOW() WHERE id = ?', [action, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        db.query(
            'INSERT INTO approval_logs (document_id, approver_id, action, comment) VALUES (?, ?, ?, ?)',
            [req.params.id, approverId, action, comment || ''],
            (err) => {
                if (err) return res.status(500).json({ message: 'Server error' });
                db.query('SELECT * FROM documents WHERE id = ?', [req.params.id], (err, docs) => {
                    if (err) return res.status(500).json({ message: 'Server error' });
                    res.json(docs[0]);
                });
            }
        );
    });
});

app.delete('/api/docs/:id', (req, res) => {
    db.query('DELETE FROM approval_logs WHERE document_id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: 'Server error' });
        db.query('DELETE FROM documents WHERE id = ?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ message: 'Server error' });
            res.json({ success: true });
        });
    });
});

// ============ 统计接口 ============
app.get('/api/stats', (req, res) => {
    const stats = {};
    let completed = 0;
    
    function checkDone() {
        completed++;
        if (completed === 4) res.json(stats);
    }
    
    db.query('SELECT COUNT(*) as c FROM documents', (err, r) => {
        stats.total = r[0].c;
        checkDone();
    });
    db.query("SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'", (err, r) => {
        stats.pending = r[0].c;
        checkDone();
    });
    db.query("SELECT COUNT(*) as c FROM documents WHERE status = 'APPROVED'", (err, r) => {
        stats.approved = r[0].c;
        checkDone();
    });
    db.query("SELECT COUNT(*) as c FROM documents WHERE status = 'REJECTED'", (err, r) => {
        stats.rejected = r[0].c;
        checkDone();
    });
});

// ============ 启动服务器 ============
app.listen(PORT, () => {
    console.log('========================================');
    console.log('  Document Flow System - MySQL Version');
    console.log('========================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`DB: document_flow | root/root`);
    
    db.query('SELECT COUNT(*) as c FROM users', (err, r) => {
        if (!err) console.log(`DB OK: ${r[0].c} users`);
    });
    db.query('SELECT COUNT(*) as c FROM documents', (err, r) => {
        if (!err) console.log(`DB OK: ${r[0].c} documents`);
    });
    console.log('========================================');
});
