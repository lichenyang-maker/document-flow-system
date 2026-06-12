const mysql = require('mysql2');

const connection = mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'root',
    database: 'document_flow'
});

connection.connect((err) => {
    if (err) {
        console.log('[ERROR] Connect:', err.message);
        return;
    }
    console.log('[OK] MySQL Connected');
    
    connection.query('SELECT COUNT(*) as c FROM users', (err, results) => {
        if (err) {
            console.log('[ERROR] Query:', err.message);
        } else {
            console.log('[OK] Users:', results[0].c);
        }
        connection.end();
    });
});
