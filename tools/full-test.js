var http = require('http');

function testPage(path) {
  return new Promise(function(ok) {
    http.get({ hostname: 'localhost', port: 3000, path: path }, function(res) {
      var b = ''; res.on('data', function(c) { b += c; }); res.on('end', function() {
        ok({ status: res.statusCode, len: b.length, html: b });
      });
    });
  });
}

function api(method, path, body, token) {
  return new Promise(function(ok) {
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: 'localhost', port: 3000, path: path, method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    var r = http.request(opts, function(res) {
      var b = ''; res.on('data', function(c) { b += c; }); res.on('end', function() {
        ok({ status: res.statusCode, data: JSON.parse(b) });
      });
    });
    if (data) r.write(data);
    r.end();
  });
}

(async function() {
  // 1. Check pages load
  var pages = ['/', '/docflow-pro', '/docflow-advanced', '/leave'];
  for (var i = 0; i < pages.length; i++) {
    var p = await testPage(pages[i]);
    console.log(pages[i] + ': ' + p.status + ' ' + p.len + 'b');
  }

  // 2. Login and API test
  var login = await api('POST', '/api/public/login', { username: 'admin', password: 'admin123' });
  console.log('Login: ' + login.status + ' ok=' + login.data.success + ' token=' + (login.data.token ? login.data.token.substr(0, 10) + '...' : 'none'));
  var t = login.data.token;

  var docs = await api('GET', '/api/docs', null, t);
  console.log('/api/docs: ' + docs.status + ' count=' + (docs.data ? docs.data.length : 0));

  var leave = await api('GET', '/api/leave', null, t);
  console.log('/api/leave: ' + leave.status + ' count=' + (leave.data ? leave.data.length : 0));

  console.log('ALL PASS');
})();
