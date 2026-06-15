// ============================================================
//  db-helper.js - 数据库操作封装
//  提供 dbAll / dbGet / dbRun 及业务查询函数
// ============================================================
'use strict';

/**
 * 初始化 db-helper，绑定 server 中的 db 实例
 * @param {Object} db     - sql.js Database 实例
 * @param {Function} saveDB - 持久化函数
 */
function initDBHelper(db, saveDB) {
    // ---------- 底层封装 ----------
    function dbAll(sql, params = []) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
    }

    function dbGet(sql, params = []) {
        const rows = dbAll(sql, params);
        return rows.length > 0 ? rows[0] : null;
    }

    function dbRun(sql, params = []) {
        if (params && params.length > 0) {
            const stmt = db.prepare(sql);
            stmt.bind(params);
            stmt.step();
            stmt.free();
        } else {
            db.run(sql);
        }
        // 必须在 saveDB 之前获取 lastID
        let lastId = 0;
        try {
            const lr = db.exec('SELECT last_insert_rowid() as id')[0];
            if (lr && lr.values && lr.values[0]) lastId = lr.values[0][0];
        } catch (e) { lastId = 0; }
        const changes = db.getRowsModified();
        if (saveDB) saveDB();
        return { lastID: lastId, changes: changes };
    }

    // ---------- 用户相关 ----------
    function getUserById(id) {
        try {
            return dbGet('SELECT id, username, name, role, department FROM users WHERE id = ?', [id]);
        } catch (e) {
            return dbGet('SELECT id, username, name, role FROM users WHERE id = ?', [id]);
        }
    }

    function getUserByName(name) {
        try {
            return dbGet('SELECT id, username, name, role, department FROM users WHERE name = ?', [name]);
        } catch (e) {
            return dbGet('SELECT id, username, name, role FROM users WHERE name = ?', [name]);
        }
    }

    function getUserByFeishuId(feishuOpenId) {
        const map = dbGet('SELECT system_user_id FROM feishu_user_map WHERE feishu_open_id = ?', [feishuOpenId]);
        if (!map) return null;
        return getUserById(map.system_user_id);
    }

    function getFeishuIdByUserId(systemUserId) {
        const map = dbGet('SELECT feishu_open_id FROM feishu_user_map WHERE system_user_id = ?', [systemUserId]);
        return map ? map.feishu_open_id : null;
    }

    function getAdmins() {
        return dbAll('SELECT id, username, name, role FROM users WHERE role IN (?, ?, ?)', ['ADMIN', 'SALES', 'ENGINEER']);
    }

    // 获取审批人列表（业务员+管理员+工程师）
    function getApprovers(department) {
        if (department) {
            const deptPrefix = department.replace(/[0-9]+级$/, '');
            return dbAll(
                `SELECT id, name, role FROM users WHERE role IN ('SALES', 'ADMIN') OR (role = 'ENGINEER' AND department LIKE ?)`,
                ['%' + deptPrefix + '%']
            );
        }
        return dbAll('SELECT id, name, role FROM users WHERE role IN (?, ?, ?)', ['ADMIN', 'SALES', 'ENGINEER']);
    }

    // 获取某部门的人员列表
    function getTeachersByDepartment(department) {
        if (!department) return dbAll("SELECT id, name, role FROM users WHERE role = 'ENGINEER'");
        const deptPrefix = department.replace(/[0-9]+级$/, '');
        return dbAll(
            "SELECT id, name, role, department FROM users WHERE role = 'ENGINEER' AND department LIKE ?",
            ['%' + deptPrefix + '%']
        );
    }

    function getTeacherById(teacherId) {
        return dbGet("SELECT id, name, role, department FROM users WHERE id = ? AND role = 'ENGINEER'", [teacherId]);
    }

    // 获取指定审批人待审批的请假列表
    function getPendingLeavesForTeacher(teacherId) {
        return dbAll(
            `SELECT l.*, u.name as user_name, u.department as user_dept 
             FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id 
             WHERE l.approver_id = ? AND l.status = 'PENDING' 
             ORDER BY l.created_at DESC LIMIT 10`,
            [teacherId]
        );
    }

    // ---------- 飞书绑定 ----------
    function bindFeishuUser(feishuOpenId, systemUserId) {
        const exist = dbGet('SELECT id FROM feishu_user_map WHERE feishu_open_id = ?', [feishuOpenId]);
        if (exist) {
            dbRun('UPDATE feishu_user_map SET system_user_id = ? WHERE feishu_open_id = ?', [systemUserId, feishuOpenId]);
        } else {
            dbRun('INSERT INTO feishu_user_map (feishu_open_id, system_user_id) VALUES (?, ?)', [feishuOpenId, systemUserId]);
        }
    }

    function unbindFeishuUser(feishuOpenId) {
        dbRun('DELETE FROM feishu_user_map WHERE feishu_open_id = ?', [feishuOpenId]);
    }

    // ---------- 请假相关 ----------
    function createLeaveRequest(userId, type, startDate, endDate, days, reason, feishuChatId, feishuMsgId, course) {
        try {
            return dbRun(
                `INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, course, status, feishu_chat_id, feishu_msg_id) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
                [userId, type, startDate || '', endDate || '', days, reason || '', course || '', feishuChatId || '', feishuMsgId || '']
            );
        } catch (e) {
            // 兼容旧库（无 course / feishu 列）
            return dbRun(
                `INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status) 
                 VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
                [userId, type, startDate || '', endDate || '', days, reason || '']
            );
        }
    }

    function getPendingLeaveInChat(chatId) {
        return dbGet(
            `SELECT l.*, u.name as user_name FROM leave_requests l 
             LEFT JOIN users u ON l.user_id = u.id 
             WHERE l.feishu_chat_id = ? AND l.status = 'PENDING' 
             ORDER BY l.created_at DESC LIMIT 1`,
            [chatId]
        );
    }

    function approveLeave(leaveId, approverId, comment) {
        return dbRun(
            `UPDATE leave_requests SET status = 'APPROVED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
            [approverId, comment || '已批准', leaveId]
        );
    }

    function rejectLeave(leaveId, approverId, comment) {
        return dbRun(
            `UPDATE leave_requests SET status = 'REJECTED', approver_id = ?, approver_comment = ?, updated_at = datetime('now') WHERE id = ?`,
            [approverId, comment || '不予批准', leaveId]
        );
    }

    function getLeaveById(leaveId) {
        return dbGet(
            `SELECT l.*, u.name as user_name FROM leave_requests l LEFT JOIN users u ON l.user_id = u.id WHERE l.id = ?`,
            [leaveId]
        );
    }

    function getMyLeaves(userId, limit = 10) {
        return dbAll(
            `SELECT l.*, u.name as approver_name FROM leave_requests l 
             LEFT JOIN users u ON l.approver_id = u.id 
             WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT ?`,
            [userId, limit]
        );
    }

    function getLeaveBalance(userId) {
        const year = new Date().getFullYear();
        const b = dbGet('SELECT * FROM leave_balance WHERE user_id = ? AND year = ?', [userId, year]);
        if (b) {
            return {
                year: year,
                annual: { total: b.annual_days, used: b.used_days, remaining: b.annual_days - b.used_days },
                sick: { total: b.sick_days, used: b.sick_used, remaining: b.sick_days - b.sick_used },
                personal: { total: b.personal_days, used: b.personal_used, remaining: b.personal_days - b.personal_used }
            };
        }
        return {
            year: year,
            annual: { total: 10, used: 0, remaining: 10 },
            sick: { total: 5, used: 0, remaining: 5 },
            personal: { total: 3, used: 0, remaining: 3 }
        };
    }

    function countLeavesInRange(userId, startDate, endDate, onlyApproved) {
        let sql = 'SELECT COALESCE(SUM(days), 0) as total_days, COUNT(*) as count FROM leave_requests WHERE 1=1';
        const params = [];
        if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
        if (onlyApproved) { sql += ' AND status = ?'; params.push('APPROVED'); }
        // 修复：检查日期重叠，而非仅start_date
        if (startDate && endDate) {
            sql += ' AND start_date <= ? AND end_date >= ?';
            params.push(endDate, startDate);
        } else {
            if (startDate) { sql += ' AND start_date >= ?'; params.push(startDate); }
            if (endDate) { sql += ' AND start_date <= ?'; params.push(endDate); }
        }
        const r = dbGet(sql, params);
        return { days: (r && r.total_days) || 0, count: (r && r.count) || 0 };
    }

    // ---------- 公文相关 ----------
    function createDocument(title, content, type, priority, applicantId) {
        return dbRun(
            `INSERT INTO documents (title, content, type, priority, status, applicant_id) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
            [title, content || '', type || 'NOTICE', priority || 'NORMAL', applicantId]
        );
    }

    function approveDocument(docId, approverId, comment) {
        dbRun(`UPDATE documents SET status = 'APPROVED', updated_at = datetime('now') WHERE id = ?`, [docId]);
        dbRun(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'APPROVE', ?)`, [docId, approverId, comment || '']);
    }

    function rejectDocument(docId, approverId, comment) {
        dbRun(`UPDATE documents SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?`, [docId]);
        dbRun(`INSERT INTO approvals (doc_id, approver_id, action, comment) VALUES (?, ?, 'REJECT', ?)`, [docId, approverId, comment || '']);
    }

    function getDocumentById(docId) {
        return dbGet(
            `SELECT d.*, u.name as applicant_name FROM documents d 
             LEFT JOIN users u ON d.applicant_id = u.id WHERE d.id = ?`,
            [docId]
        );
    }

    function getPendingDocs(limit = 10) {
        return dbAll(
            `SELECT d.*, u.name as applicant_name FROM documents d 
             LEFT JOIN users u ON d.applicant_id = u.id 
             WHERE d.status = 'PENDING' ORDER BY d.created_at DESC LIMIT ?`,
            [limit]
        );
    }

    function getDocumentsList(status, limit = 20) {
        let sql = 'SELECT d.*, u.name as applicant_name FROM documents d LEFT JOIN users u ON d.applicant_id = u.id';
        const params = [];
        if (status && status !== 'all') { sql += ' WHERE d.status = ?'; params.push(status.toUpperCase()); }
        sql += ' ORDER BY d.created_at DESC LIMIT ?';
        params.push(limit);
        return dbAll(sql, params);
    }

    function getDocStats() {
        const total = dbGet('SELECT COUNT(*) as c FROM documents')?.c || 0;
        const pending = dbGet("SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'")?.c || 0;
        const approved = dbGet("SELECT COUNT(*) as c FROM documents WHERE status = 'APPROVED'")?.c || 0;
        const rejected = dbGet("SELECT COUNT(*) as c FROM documents WHERE status = 'REJECTED'")?.c || 0;
        const byType = dbAll('SELECT type, COUNT(*) as count FROM documents GROUP BY type ORDER BY count DESC');
        return { total, pending, approved, rejected, byType };
    }

    // ---------- 通知相关 ----------
    function createNotification(userId, channel, title, content, status) {
        try {
            dbRun('INSERT INTO notifications (user_id, channel, title, content, status) VALUES (?, ?, ?, ?, ?)',
                [userId, channel, title, content, status || 'SENT']);
        } catch (e) { /* 表可能不存在，忽略 */ }
    }

    // ---------- 系统概览 ----------
    function getSystemOverview() {
        const totalUsers = dbGet('SELECT COUNT(*) as c FROM users')?.c || 0;
        const totalDocs = dbGet('SELECT COUNT(*) as c FROM documents')?.c || 0;
        const totalLeave = dbGet('SELECT COUNT(*) as c FROM leave_requests')?.c || 0;
        const pendingDocs = dbGet("SELECT COUNT(*) as c FROM documents WHERE status = 'PENDING'")?.c || 0;
        const pendingLeave = dbGet("SELECT COUNT(*) as c FROM leave_requests WHERE status = 'PENDING'")?.c || 0;
        const admins = dbAll('SELECT id, name, role FROM users WHERE role = ?', ['ADMIN']);
        return { totalUsers, totalDocs, totalLeave, pendingDocs, pendingLeave, admins };
    }

    // ---------- 周/月范围 ----------
    function getWeekRange(date) {
        const d = new Date(date || Date.now());
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);
        const fmt = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
        return { start: fmt(monday), end: fmt(sunday) };
    }

    function getMonthRange(date) {
        const d = new Date(date || Date.now());
        const year = d.getFullYear();
        const month = d.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const fmt = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
        return { start: fmt(firstDay), end: fmt(lastDay) };
    }

    return {
        // 底层
        dbAll, dbGet, dbRun,
        // 用户
        getUserById, getUserByName, getUserByFeishuId, getFeishuIdByUserId, getAdmins, getApprovers,
        getTeachersByDepartment, getTeacherById, getPendingLeavesForTeacher,
        // 飞书
        bindFeishuUser, unbindFeishuUser,
        // 请假
        createLeaveRequest, getPendingLeaveInChat, getLeaveById, approveLeave, rejectLeave,
        getMyLeaves, getLeaveBalance, countLeavesInRange,
        // 公文
        createDocument, approveDocument, rejectDocument, getDocumentById,
        getPendingDocs, getDocumentsList, getDocStats,
        // 通知
        createNotification,
        // 系统
        getSystemOverview, getWeekRange, getMonthRange
    };
}

module.exports = { initDBHelper };
