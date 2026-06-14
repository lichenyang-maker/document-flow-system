const initSqlJs = require('sql.js');

async function test() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run(`CREATE TABLE test2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT DEFAULT 'hello',
        status TEXT DEFAULT 'PENDING'
    )`);

    console.log('=== 测试 db.run 的参数绑定 ===');

    // 测试 1: db.run(sql, paramsArray) — 这是要测试的
    try {
        db.run(`INSERT INTO test2 (name) VALUES (?)`, ['测试-params']);
        console.log('测试 1 - db.run(sql, paramsArray): 成功');
        const id1 = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
        console.log('  id:', id1);
    } catch (e) {
        console.log('测试 1 - db.run(sql, paramsArray): 失败 -', e.message);
    }

    // 测试 2: db.run(sql) 不带参数
    try {
        db.run(`INSERT INTO test2 (name) VALUES ('测试-string')`);
        console.log('测试 2 - db.run(sql, 字符串内插): 成功');
        const id2 = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
        console.log('  id:', id2);
    } catch (e) {
        console.log('测试 2 - db.run(sql, 字符串内插): 失败 -', e.message);
    }

    // 测试 3: 使用 prepare+bind+step (推荐方式)
    try {
        const stmt = db.prepare(`INSERT INTO test2 (name, status) VALUES (?, ?)`);
        stmt.bind(['测试-prepare', 'APPROVED']);
        stmt.step();
        stmt.free();
        console.log('测试 3 - prepare+bind+step: 成功');
        const id3 = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
        console.log('  id:', id3);
    } catch (e) {
        console.log('测试 3 - prepare+bind+step: 失败 -', e.message);
    }

    // 测试 4: 多个参数
    try {
        db.run(`INSERT INTO test2 (name, value, status) VALUES (?, ?, ?)`, ['多参数', 'testvalue', 'REJECTED']);
        console.log('测试 4 - db.run 多参数: 成功');
        const id4 = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0];
        console.log('  id:', id4);
    } catch (e) {
        console.log('测试 4 - db.run 多参数: 失败 -', e.message);
    }

    // 查看所有数据
    console.log('\n=== 最终数据 ===');
    const rows = db.exec('SELECT id, name, value, status FROM test2');
    if (rows.length > 0) {
        rows[0].values.forEach(row => {
            console.log('  id:', row[0], 'name:', row[1], 'value:', row[2], 'status:', row[3]);
        });
    }
}

test().catch(console.error);
