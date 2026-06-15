var fs = require('fs');
var c = fs.readFileSync('d:/document-flow-system/server-sqlite.js', 'utf8');

var marker = "app.get('/feishu-chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feishu-chat.html')));";

var routes = "app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));\n" +
"app.get('/feishu-chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feishu-chat.html')));\n" +
"app.get('/leave', (req, res) => res.sendFile(path.join(__dirname, 'leave.html')));\n" +
"app.get('/docflow', (req, res) => res.sendFile(path.join(__dirname, 'docflow.html')));\n" +
"app.get('/docflow-pro', (req, res) => res.sendFile(path.join(__dirname, 'docflow_pro.html')));\n" +
"app.get('/docflow-advanced', (req, res) => res.sendFile(path.join(__dirname, 'docflow_advanced.html')));\n" +
"app.get('/docflow-ai', (req, res) => res.sendFile(path.join(__dirname, 'docflow_ai.html')));\n";

if (c.indexOf('/docflow-pro') !== -1) {
  console.log('Already patched');
  process.exit(0);
}

c = c.replace(marker, routes);
fs.writeFileSync('d:/document-flow-system/server-sqlite.js', c, 'utf8');
console.log('OK - routes added');
