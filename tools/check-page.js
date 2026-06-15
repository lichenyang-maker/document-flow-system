var http = require('http');
http.get({hostname:'localhost',port:3000,path:'/'}, function(res) {
  var b = ''; res.on('data', function(c) { b += c; }); res.on('end', function() {
    var hasIsAdmin = b.indexOf('isAdmin = false') !== -1;
    var hasPublicLogin = b.indexOf('api/public/login') !== -1;
    console.log('isAdmin init: ' + (hasIsAdmin ? 'OK' : 'MISSING'));
    console.log('login path: ' + (hasPublicLogin ? 'OK' : 'MISSING'));
    console.log('Page size: ' + b.length + ' bytes');
    if (!hasIsAdmin) console.log('!!! Browser cache issue - need Ctrl+F5 !!!');
    else console.log('Page is up to date');
  });
});
