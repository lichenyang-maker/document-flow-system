const fs = require('fs');
const html = fs.readFileSync('d:/document-flow-system/public/chat.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const js = match[1];
const lines = js.split('\n');

console.log('行 10 原始内容 (char codes):');
const line10 = lines[9];
for (let k = 0; k < line10.length; k++) {
  const code = line10.charCodeAt(k);
  process.stdout.write(`${code},`);
}
console.log('\n');

console.log('行 11 原始内容 (char codes):');
const line11 = lines[10];
for (let k = 0; k < line11.length; k++) {
  const code = line11.charCodeAt(k);
  process.stdout.write(`${code},`);
}
console.log('\n');

console.log('行 12 原始内容 (char codes):');
const line12 = lines[11];
for (let k = 0; k < line12.length; k++) {
  const code = line12.charCodeAt(k);
  process.stdout.write(`${code},`);
}
console.log('\n');
