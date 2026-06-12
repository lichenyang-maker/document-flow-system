const mysql = require('mysql2/promise');

async function initDatabase() {
    let connection;
    
    try {
        // 连接到MySQL
        connection = await mysql.createConnection({
            host: 'localhost',
            port: 3306,
            user: 'root',
            password: 'root',
            multipleStatements: true
        });
        
        console.log('[OK] Connected to MySQL');
        
        // 创建数据库
        await connection.query('CREATE DATABASE IF NOT EXISTS document_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        console.log('[OK] Database: document_flow');
        
        await connection.query('USE document_flow');
        
        // 创建用户表
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                name VARCHAR(100) NOT NULL,
                role VARCHAR(20) NOT NULL,
                department VARCHAR(100),
                email VARCHAR(100),
                phone VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('[OK] Table: users');
        
        // 创建公文表
        await connection.query(`
            CREATE TABLE IF NOT EXISTS documents (
                id INT PRIMARY KEY AUTO_INCREMENT,
                title VARCHAR(200) NOT NULL,
                content TEXT,
                type VARCHAR(50),
                status VARCHAR(20) DEFAULT 'DRAFT',
                creator_id INT NOT NULL,
                approver_id INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('[OK] Table: documents');
        
        // 创建审批记录表
        await connection.query(`
            CREATE TABLE IF NOT EXISTS approval_logs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                document_id INT NOT NULL,
                approver_id INT NOT NULL,
                action VARCHAR(20) NOT NULL,
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('[OK] Table: approval_logs');
        
        // 清空并插入默认用户
        await connection.query('DELETE FROM users');
        await connection.query(`
            INSERT INTO users (username, password, name, role, department, email, phone) VALUES
            ('admin', 'admin123', 'Administrator', 'ADMIN', 'IT', 'admin@company.com', '13800138000'),
            ('wangwu', '123456', 'Wang Wu (Tech Manager)', 'MANAGER', 'Technology', 'wangwu@company.com', '13800138010'),
            ('zhaoliu', '123456', 'Zhao Liu (Sales Manager)', 'MANAGER', 'Sales', 'zhaoliu@company.com', '13800138011'),
            ('sunqi', '123456', 'Sun Qi (HR Manager)', 'MANAGER', 'HR', 'sunqi@company.com', '13800138012'),
            ('zhouba', '123456', 'Zhou Ba (Finance Manager)', 'MANAGER', 'Finance', 'zhouba@company.com', '13800138013'),
            ('zhangsan', '123456', 'Zhang San', 'EMPLOYEE', 'Technology', 'zhangsan@company.com', '13800138101'),
            ('lisi', '123456', 'Li Si', 'EMPLOYEE', 'Technology', 'lisi@company.com', '13800138102'),
            ('wangjiu', '123456', 'Wang Jiu', 'EMPLOYEE', 'Sales', 'wangjiu@company.com', '13800138103'),
            ('zhengshi', '123456', 'Zheng Shi', 'EMPLOYEE', 'HR', 'zhengshi@company.com', '13800138104'),
            ('chenba', '123456', 'Chen Ba', 'EMPLOYEE', 'Finance', 'chenba@company.com', '13800138105')
        `);
        console.log('[OK] Users: 10 inserted');
        
        // 清空并插入示例公文
        await connection.query('DELETE FROM documents');
        await connection.query(`
            INSERT INTO documents (title, content, type, status, creator_id, approver_id) VALUES
            ('2026 Annual Work Summary Report', 'Overall this year...', 'Report', 'APPROVED', 6, 2),
            ('Equipment Purchase Request', 'Due to business needs...', 'Request', 'PENDING', 6, 2),
            ('Employee Training Plan', 'To improve skills...', 'Request', 'DRAFT', 7, 2)
        `);
        console.log('[OK] Documents: 3 inserted');
        
        console.log('\n========================================');
        console.log('  Database Setup Complete!');
        console.log('========================================');
        console.log('DB: document_flow');
        console.log('Connection: root / root');
        console.log('Admin: admin / admin123');
        console.log('Manager: wangwu / 123456');
        console.log('Employee: zhangsan / 123456');
        
    } catch (error) {
        console.error('[ERROR] ' + error.message);
    } finally {
        if (connection) await connection.end();
    }
}

initDatabase();
