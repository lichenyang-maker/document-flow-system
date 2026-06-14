const initSqlJs = require('sql.js');
const fs = require('fs');

async function test() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    // 建表
    db.run(`CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT DEFAULT 'hello',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('=== 测试不同的 INSERT 方式 ===');

    // 模拟当前的 query 函数
    function query(sql, params = []) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
    }

    // 方式 1: db.run 无参数
    db.run(`INSERT INTO test_items (name, value) VALUES ('test1', 'val1')`);
    const r1 = query('SELECT last_insert_rowid() as id, MAX(id) as max_id FROM test_items')[0];
    console.log('方式1: db.run(无参数)');
    console.log('   last_insert_rowid:', r1.id, 'MAX(id):', r1.max_id);

    // 方式 方式 2: db.run 带参数 (sql.js 支持)
    db.run(`INSERT INTO test_items (name, value) VALUES ('test2', 'val2')`);
    const r2 = query('SELECT last_insert_rowid() as id, MAX(id) as max_id FROM test_items')[0];
    console.log('方式2: db.run 再次测试');
    console.log('   last_insert_rowid():', r2.id, 'MAX(id):', r2.max_id);

    // 方式 3: prepare + bind + step (sql.js 推荐)
    const stmt3 = db.prepare(`INSERT INTO test_items (name, value) VALUES (?, ?)`);
    stmt3.bind(['test3', 'val3']);
    stmt3.step();
    stmt3.free();
    const r3 = query('SELECT last_insert_rowid() as id, MAX(id) as max_id FROM test_items')[0];
    console.log('方式3: prepare+bind+step');
    console.log('   last_insert_rowid():', r3.id, 'MAX(id):', r3.max_id);

    // 方式 4: 当前 server-sqlite.js 中的 run() 函数方式
    const stmt4 = db.prepare(`INSERT INTO test_items (name, value) VALUES (?, ?)`);
    stmt4.bind(['test4', 'val4']);
    stmt4.step();
    stmt4.free();
    // 模拟 saveDB() 中的 db.export() - 但不做 INSERT
    const exported = db.export();  // 模拟 saveDB() 中的操作
    const r4 = query('SELECT last_insert_rowid() as id, MAX(id) as max_id FROM test_items')[0];
    console.log('方式4: prepare+bind+step + db.export()');
    console.log('   last_insert_rowid():', r4.id, 'MAX(id):', r4.max_id);

    // 查询所有记录
    console.log('\n=== 数据库中的所有记录:');
    const all = query('SELECT id, name, value, created_at FROM test_items ORDER BY id');
    all.forEach(row => console.log('   id:', row.id, 'name:', row.name));

    console.log('\n=== 关键测试: 模拟 run() 函数 ===');

    function saveDB() {
        try {
            fs.writeFileSync('_test_temp2.db', Buffer.from(db.export()));
        } catch (e) { console.log('saveDB error:', e.message); }
    }

    // 模拟改进后的 run() 函数
    function run(sql, params = []) {
        if (params && params.length > 0) {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            stmt.step();
            stmt.free();
        } else {
            db.run(sql);
        }
        saveDB();
        const lastRow = query('SELECT last_insert_rowid() as id')[0];
        return { lastID: lastRow?.id || 0, changes: db.getRowsModified() };
    }

    const result1 = run(`INSERT INTO test_items (name, value) VALUES ('test5-run', 'val5')`);
    console.log('run() 函数无参数:');
    console.log('   返回:', result1);

    const result2 = run(`INSERT INTO test_items (name, value) VALUES (?, ?)`, ['test6-bind', 'val6']);
    console.log('run() 函数有参数:');
    console.log('   返回:', result2);
}

test().catch(console.error);
