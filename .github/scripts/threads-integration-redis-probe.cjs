'use strict';

const net = require('node:net');

const mode = process.argv[2];
if (!['ping', 'clients'].includes(mode)) {
  console.error('Usage: node threads-integration-redis-probe.cjs <ping|clients>');
  process.exit(2);
}

const command = mode === 'ping'
  ? '*1\r\n$4\r\nPING\r\n'
  : '*2\r\n$4\r\nINFO\r\n$7\r\nclients\r\n';
const socket = net.createConnection({ host: '127.0.0.1', port: 6379 });
let received = Buffer.alloc(0);
let finished = false;

function finish(error, value) {
  if (finished) return;
  finished = true;
  socket.destroy();
  if (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(String(value) + '\n');
}

socket.setTimeout(5000, () => finish(new Error('Redis probe timed out.')));
socket.once('error', (error) => finish(error));
socket.once('connect', () => socket.write(command));
socket.on('data', (chunk) => {
  received = Buffer.concat([received, chunk]);

  if (mode === 'ping') {
    if (received.length < 7) return;
    if (received.subarray(0, 7).toString() !== '+PONG\r\n') {
      finish(new Error('Redis returned an unexpected PING response.'));
      return;
    }
    finish(null, 'PONG');
    return;
  }

  const headerEnd = received.indexOf('\r\n');
  if (headerEnd < 0 || received[0] !== 0x24) return;
  const bodyLength = Number(received.subarray(1, headerEnd).toString());
  if (!Number.isInteger(bodyLength) || bodyLength < 0) {
    finish(new Error('Redis returned an invalid INFO response.'));
    return;
  }
  const bodyStart = headerEnd + 2;
  if (received.length < bodyStart + bodyLength + 2) return;
  const info = received.subarray(bodyStart, bodyStart + bodyLength).toString();
  const match = info.match(/^connected_clients:(\d+)$/m);
  if (!match) {
    finish(new Error('Redis INFO clients response did not include connected_clients.'));
    return;
  }
  finish(null, match[1]);
});

