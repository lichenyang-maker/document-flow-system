const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

async function test() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // 建表
    db.run(`CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('表已创建');

    // 方式 1: 使用 db.run + db.exec 获取 last_insert_rowid
    db.run(`INSERT INTO test_items (name) VALUES ('测试1')`);
    const r1 = db.exec("SELECT last_insert_rowid() as id")[0];
    console.log('方式 1 (db.run + db.exec): id =', r1?.values[0]?.[0]);

    // 方式 2: 使用 prepare + step + last_insert_rowid via query
    const stmt = db.prepare(`INSERT INTO test_items (name) VALUES (?)`);
    stmt.bind(['测试2']);
    stmt.step();
    stmt.free();
    const r2 = db.exec("SELECT last_insert_rowid() as id")[0];
    console.log('方式 2 (prepare+step + db.exec): id =', r2?.values[0]?.[0]);

    // 方式 3: 使用 query 函数
    function query(sql, params = []) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
    }

    query(`INSERT INTO test_items (name) VALUES (?)`, ['测试3']);
    const r3 = query('SELECT last_insert_rowid() as id')[0];
    console.log('方式 3 (query INSERT + query SELECT): id =', r3?.id);

    // 方式 4: 直接查询最大 ID
    query(`INSERT INTO test_items (name) VALUES (?)`, ['测试4']);
    const r4 = query('SELECT MAX(id) as id FROM test_items')[0];
    console.log('方式 4 (SELECT MAX): id =', r4?.id);

    // 查询所有记录
    const all = query('SELECT id, name FROM test_items ORDER BY id');
    console.log('\n所有记录:');
    all.forEach(row => console.log(`  id=${row.id}, name=${row.name}`));

    // 检查 getRowsModified
    console.log('\ngetRowsModified():', db.getRowsModified());

    // 关键测试: 在 db.run 后立即查询 last_insert_rowid
    console.log('\n--- 关键测试 ---');
    db.run(`INSERT INTO test_items (name) VALUES ('关键测试')`);
    const lastId1 = query('SELECT last_insert_rowid() as id')[0]?.id;
    console.log('db.run 后 query(last_insert_rowid):', lastId1);

    const stmt2 = db.prepare(`INSERT INTO test_items (name) VALUES (?)`);
    stmt2.bind(['关键测试2']);
    stmt2.step();
    stmt2.free();
    const lastId2 = query('SELECT last_insert_rowid() as id')[0]?.id;
    console.log('prepare+step 后 query(last_insert_rowid):', lastId2);
}

test().catch(console.error);
