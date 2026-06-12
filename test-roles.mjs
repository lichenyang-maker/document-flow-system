const users = [
  { username: 'admin', password: 'admin123' },
  { username: 'zhangsan', password: '123456' }
];

async function test() {
  for (const u of users) {
    const r = await fetch('http://localhost:3000/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u)
    });
    const d = await r.json();
    console.log(`${u.username}:`, JSON.stringify(d.user));
  }
}
test();
