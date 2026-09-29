const http = require('http');
const net = require('net');

const FRONTEND_PORT = 4201;
const BACKEND_PORT = 3000;
const PROXY_PORT = 4200;

function targetPort(pathname, request) {
  const isAccountProtectionDocument =
    pathname === '/account-protection' &&
    request.method === 'GET' &&
    String(request.headers.accept || '').includes('text/html');
  return pathname === '/user/self' ||
    pathname.startsWith('/account-protection/') ||
    (pathname === '/account-protection' && !isAccountProtectionDocument)
    ? BACKEND_PORT
    : FRONTEND_PORT;
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const port = targetPort(pathname, request);
  const upstream = http.request({
    hostname: '127.0.0.1',
    port,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${port}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end('E2E upstream unavailable');
  });
  request.pipe(upstream);
});

server.on('upgrade', (request, clientSocket, head) => {
  const upstream = net.connect(FRONTEND_PORT, '127.0.0.1', () => {
    const headers = { ...request.headers, host: `127.0.0.1:${FRONTEND_PORT}` };
    const headerLines = Object.entries(headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headerLines}\r\n\r\n`);
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  upstream.on('error', () => clientSocket.destroy());
});

server.listen(PROXY_PORT, '127.0.0.1');
