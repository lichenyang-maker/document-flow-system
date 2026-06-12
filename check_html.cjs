const fs = require('fs');
const path = require('path');

const files = ['docflow_advanced.html', 'docflow_pro.html', 'docflow_ai.html', 'docflow.html'];
for (const f of files) {
    const p = path.join('D:/document-flow-system', f);
    const c = fs.readFileSync(p, 'utf8');
    const hasCorrupt = c.includes('=@%') || c.includes('=@') || c.includes('<<?') || c.includes('=@%');
    console.log(f + ':');
    console.log('  Size:', c.length, 'chars');
    console.log('  Has corrupt:', hasCorrupt);
    console.log('  DOCTYPE:', c.includes('<!DOCTYPE'));
    console.log('  First 100:', c.slice(0, 100).replace(/\n/g, ' '));
    console.log();
}
