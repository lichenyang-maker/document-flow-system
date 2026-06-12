const fs = require('fs');
const path = require('fs');

// Backup corrupted index
const orig = fs.readFileSync('D:/document-flow-system/index.html', 'utf8');
fs.writeFileSync('D:/document-flow-system/index.html.bak', orig);
console.log('Backed up corrupted index.html');

// Copy clean version
const clean = fs.readFileSync('D:/document-flow-system/docflow_advanced.html', 'utf8');
fs.writeFileSync('D:/document-flow-system/index.html', clean);
console.log('Replaced index.html with docflow_advanced.html (' + clean.length + ' chars)');
