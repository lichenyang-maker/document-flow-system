const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function test() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT,
        type TEXT DEFAULT 'NORMAL',
        priority TEXT DEFAULT 'NORMAL',
        status TEXT DEFAULT 'PENDING',
        applicant_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
    )`);

    // 模拟 server-sqlite.js 中的 run 函数
    function saveDB() {
        try {
            fs.writeFileSync(path.join(__dirname, '_test_temp.db'), Buffer.from(db.export()));
        } catch (e) { console.log('saveDB error:', e.message); }
    }
    function query(sql, params = []) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
    }
    function run_original(sql, params = []) {
        db.run(sql, params);
        saveDB();
        return { lastID: db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] || 0, changes: db.getRowsModified() };
    }

    console.log('=== 测试原 server-sqlite.js 中的 run 函数 ===');
    const r1 = run_original(`INSERT INTO documents (title, content, type, priority, status, applicant_id) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
        ['测试文档', '测试内容', 'NOTICE', 'NORMAL', 1]);
    console.log('返回值:', r1);

    // 查询刚插入的记录
    const rows = query('SELECT id, title, status, applicant_id FROM documents ORDER BY id');
    console.log('\n数据库中的记录:');
    rows.forEach(row => console.log('  ', row));
}

test().catch(console.error);
