// ============================================================
//  SQLite 数据库初始化脚本
//  运行一次即可自动创建所有表和数据
// ============================================================
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'document_flow.db');

console.log('[初始化] SQLite 数据库路径:', DB_PATH);

// 删除旧数据库（如果存在）
if (fs.existsSync(DB_PATH)) {
    console.log('[初始化] 删除旧数据库...');
    fs.unlinkSync(DB_PATH);
}

// 创建数据库连接
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('[ERROR] 无法创建数据库:', err.message);
        process.exit(1);
    }
    console.log('[OK] 数据库连接成功');
});

// 创建表
db.serialize(() => {
    console.log('\n[1/6] 创建用户表...');
    db.run(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT DEFAULT 'EMPLOYEE',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 用户表创建成功');
    });

    console.log('[2/6] 创建公文表...');
    db.run(`
        CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT,
            type TEXT DEFAULT 'NORMAL',
            status TEXT DEFAULT 'PENDING',
            priority TEXT DEFAULT 'NORMAL',
            applicant_id INTEGER,
            current_approver_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (applicant_id) REFERENCES users(id)
        )
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 公文表创建成功');
    });

    console.log('[3/6] 创建审批记录表...');
    db.run(`
        CREATE TABLE approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id INTEGER NOT NULL,
            approver_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (doc_id) REFERENCES documents(id),
            FOREIGN KEY (approver_id) REFERENCES users(id)
        )
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 审批记录表创建成功');
    });

    console.log('[4/6] 创建请假申请表...');
    db.run(`
        CREATE TABLE leave_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            days REAL NOT NULL,
            reason TEXT,
            status TEXT DEFAULT 'PENDING',
            approver_id INTEGER,
            approver_comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 请假申请表创建成功');
    });

    console.log('[5/6] 创建微信配置表...');
    db.run(`
        CREATE TABLE wechat_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT DEFAULT 'serverchan',
            api_key TEXT,
            webhook_url TEXT,
            enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 微信配置表创建成功');
    });

    console.log('[6/6] 插入默认数据...');

    // 插入默认用户
    const users = [
        { username: 'admin', password: 'admin123', name: '管理员', role: 'ADMIN' },
        { username: 'zhangsan', password: '123456', name: '张三', role: 'EMPLOYEE' },
        { username: 'lisi', password: '123456', name: '李四', role: 'EMPLOYEE' },
        { username: 'wangwu', password: '123456', name: '王五', role: 'EMPLOYEE' },
        { username: 'zhaoliu', password: '123456', name: '赵六', role: 'EMPLOYEE' },
        { username: 'sunqi', password: '123456', name: '孙七', role: 'EMPLOYEE' }
    ];

    const stmtUser = db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)');
    users.forEach(u => stmtUser.run(u.username, u.password, u.name, u.role));
    stmtUser.finalize();
    console.log('[OK] 默认用户创建成功 (6个)');

    // 插入默认微信配置
    db.run(`INSERT INTO wechat_config (provider, api_key, enabled) VALUES ('serverchan', 'SCT359275Tkk3wftrQnVAwazPBPOAWaMIR', 1)`, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 微信配置创建成功');
    });

    // 插入示例公文
    db.run(`
        INSERT INTO documents (title, content, type, status, priority, applicant_id)
        VALUES
        ('关于2024年度工作计划的通知', '请各部门于本周五前提交年度工作计划草案。', 'NOTICE', 'APPROVED', 'HIGH', 1),
        ('关于员工福利调整的申请', '建议提高员工餐补标准至每日50元。', 'PROPOSAL', 'PENDING', 'NORMAL', 2),
        ('关于办公室搬迁的通知', '市场部将于下周一搬迁至新办公区。', 'NOTICE', 'PENDING', 'LOW', 1)
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 示例公文创建成功 (3条)');
    });

    // 插入示例请假记录
    db.run(`
        INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id, approver_comment)
        VALUES
        (2, '年假', '2024-06-10', '2024-06-12', 3, '计划带家人去旅游', 'APPROVED', 1, '同意，好好休息！'),
        (3, '病假', '2024-06-05', '2024-06-05', 1, '发烧感冒', 'APPROVED', 1, '注意身体'),
        (4, '事假', '2024-06-15', '2024-06-16', 2, '家中装修需要监工', 'PENDING', NULL, NULL)
    `, (err) => {
        if (err) console.error('[ERROR]', err.message);
        else console.log('[OK] 示例请假记录创建成功 (3条)');
    });
});

// 等待所有操作完成
setTimeout(() => {
    console.log('\n========================================');
    console.log('[完成] SQLite 数据库初始化成功！');
    console.log('========================================');
    console.log('\n📋 默认账号：');
    console.log('   管理员: admin / admin123');
    console.log('   用户: zhangsan / 123456');
    console.log('\n🚀 启动服务: npm start');
    console.log('\n📝 数据库文件:', DB_PATH);
    db.close();
    process.exit(0);
}, 1500);