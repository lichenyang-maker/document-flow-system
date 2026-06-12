const endpoints = [
  'http://localhost:3000/api/public/leave/stats',
  'http://localhost:3000/api/public/leave/list',
  'http://localhost:3000/api/public/users',
  'http://localhost:3000/api/documents'
];

async function test() {
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      console.log(`✅ ${url.split('/').pop()}:`, JSON.stringify(data).slice(0, 200));
    } catch(e) {
      console.log(`❌ ${url.split('/').pop()}:`, e.message);
    }
  }
}
test();
