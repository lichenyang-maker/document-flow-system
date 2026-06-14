const initSqlJs = require("sql.js");
const fs = require("fs");
(async () => {
    const SQL = await initSqlJs();
    const buf = fs.readFileSync("document_flow.db");
    if (!buf || buf.length === 0) { console.log("DB file empty"); return; }
    const db = new SQL.Database(buf);
    const stmt = db.prepare("SELECT * FROM users");
    console.log("=== 所有用户 ===");
    while (stmt.step()) {
        const row = stmt.getAsObject();
        console.log(JSON.stringify(row));
    }
    stmt.free();
    db.close();
})().catch(e => console.error(e.message));
