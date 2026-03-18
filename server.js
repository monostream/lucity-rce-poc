const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('pwned');
}).listen(process.env.PORT || 8080);
