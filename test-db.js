const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

initSqlJs().then(function(SQL) {
    const DB_PATH = path.join(__dirname, 'document_flow.db');
    const db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

    console.log('✅ 数据库连接: ' + DB_PATH);
    console.log('');

    function query(sql, params) {
        const stmt = db.prepare(sql);
        stmt.bind(params || []);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    }

    function run(sql, params) {
        db.run(sql, params || []);
        return { changes: db.getRowsModified() };
    }

    // 测试 1: 查询统计
    console.log('=== 1. 查询统计 ===');
    let r = query(`SELECT 
      (SELECT COUNT(*) FROM users) as totalUsers,
      (SELECT COUNT(*) FROM documents) as totalDocs,
      (SELECT COUNT(*) FROM leave_requests) as totalLeave,
      (SELECT COUNT(*) FROM documents WHERE status='PENDING') + 
      (SELECT COUNT(*) FROM leave_requests WHERE status='PENDING') as pendingDocs`)[0];
    console.log('📊 用户: ' + r.totalUsers + '  公文: ' + r.totalDocs + '  请假: ' + r.totalLeave + '  待审: ' + r.pendingDocs);
    console.log('');

    // 测试 2: 新增公文
    console.log('=== 2. 新增公文 ===');
    const newDocTitle = '测试公文-' + Date.now();
    run(`INSERT INTO documents (title, content, type, priority, status, applicant_id, created_at) VALUES (?, ?, ?, ?, 'PENDING', 1, datetime('now'))`,
        [newDocTitle, '测试内容', 'NOTICE', 'NORMAL']);
    const docResult = query('SELECT last_insert_rowid() as id')[0];
    console.log('📄 公文插入成功, 标题: ' + newDocTitle);
    console.log('');

    // 测试 3: 新增请假
    console.log('=== 3. 新增请假 ===');
    run(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))`,
        [1, '年假', '2025-10-01', '2025-10-03', 3, '测试请假申请-' + Date.now()]);
    console.log('🏖️  请假插入成功');
    console.log('');

    // 测试 4: 审批公文
    console.log('=== 4. 审批刚创建的公文 ===');
    run(`UPDATE documents SET status = 'APPROVED', updated_at = datetime('now') WHERE title = ?`, [newDocTitle]);
    console.log('✅ 公文审批完成');
    console.log('');

    // 测试 5: 审批请假
    console.log('=== 5. 审批最新请假 ===');
    const latestLeave = query('SELECT id FROM leave_requests ORDER BY id DESC LIMIT 1')[0];
    run(`UPDATE leave_requests SET status = 'APPROVED', approver_id = 1, approver_comment = '测试审批', updated_at = datetime('now') WHERE id = ?`, [latestLeave.id]);
    console.log('✅ 请假审批完成 (ID: ' + latestLeave.id + ')');
    console.log('');

    // 保存到文件
    const data = db.export();
    fs.writeFileSync(DB_PATH, data);
    console.log('💾 数据已持久化到文件');

    // 测试 6: 最终状态验证
    console.log('');
    console.log('=== 6. 最终状态验证 ===');
    r = query(`SELECT 
      (SELECT COUNT(*) FROM users) as totalUsers,
      (SELECT COUNT(*) FROM documents) as totalDocs,
      (SELECT COUNT(*) FROM leave_requests) as totalLeave,
      (SELECT COUNT(*) FROM documents WHERE status='PENDING') + 
      (SELECT COUNT(*) FROM leave_requests WHERE status='PENDING') as pendingDocs`)[0];
    console.log('📊 用户: ' + r.totalUsers + '  公文: ' + r.totalDocs + '  请假: ' + r.totalLeave + '  待审: ' + r.pendingDocs);
    console.log('');

    console.log('=== 7. 最新5条公文 ===');
    const docs = query(`SELECT d.id, d.title, d.status, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id ORDER BY d.id DESC LIMIT 5`);
    docs.forEach(d => console.log('  - [' + d.status + '] ' + d.title + ' (申请人: ' + (d.applicant_name || '未知') + ')'));
    console.log('');

    console.log('=== 8. 请假详细统计 ===');
    const ls = query(`SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='APPROVED' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status='REJECTED' THEN 1 ELSE 0 END) as rejected FROM leave_requests`)[0];
    console.log('总计: ' + ls.total + '  待审: ' + ls.pending + '  通过: ' + ls.approved + '  驳回: ' + ls.rejected);
    console.log('');

    console.log('🎉 所有数据库操作测试完成！');
    console.log('💾 数据文件: ' + DB_PATH + ' (大小: ' + (fs.statSync(DB_PATH).size / 1024).toFixed(2) + ' KB)');

    db.close();
}).catch(function(err) {
    console.error('错误:', err);
});
