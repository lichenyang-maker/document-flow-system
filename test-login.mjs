fetch('http://localhost:3000/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
}).then(async r => {
  const t = await r.text();
  console.log('Status:', r.status);
  console.log('Body:', t);
});
