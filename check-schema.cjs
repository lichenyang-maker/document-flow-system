const mysql = require('mysql2');
const conn = mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'root',
    charset: 'utf8mb4'
});

conn.query('DESCRIBE leave_system.leave_requests', (err, rows) => {
    if (err) console.error(err);
    else console.log(JSON.stringify(rows, null, 2));
    conn.end();
});
