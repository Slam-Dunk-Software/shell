// Load .env
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
} catch {}

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// PORT: APP_COLOR — accent color for the PWA icon (default: gold)
const APP_COLOR = process.env.APP_COLOR || '#c9a84c';

// Generate a solid-color PNG (no dependencies)
function solidPng(hex, size = 180) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeB = Buffer.from(type);
    const lenB = Buffer.allocUnsafe(4); lenB.writeUInt32BE(data.length);
    const crcB = Buffer.allocUnsafe(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([lenB, typeB, data, crcB]);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const row = Buffer.allocUnsafe(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x++) { row[1 + x*3] = r; row[2 + x*3] = g; row[3 + x*3] = b; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconPng = solidPng(APP_COLOR);

// PORT: WEBTERM_TOKEN — required PIN/token for the auth gate (4-digit or longer)
const TOKEN = process.env.WEBTERM_TOKEN;
if (!TOKEN) { console.error('WEBTERM_TOKEN not set — refusing to start'); process.exit(1); }

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '4444');

// PORT: SSH_KEY — path to the SSH private key used to connect to localhost
// Create a dedicated key: ssh-keygen -t ed25519 -f ~/.ssh/webterm_key -N ""
// Then authorize it: cat ~/.ssh/webterm_key.pub >> ~/.ssh/authorized_keys
const SSH_KEY  = process.env.SSH_KEY  || path.join(os.homedir(), '.ssh', 'webterm_key');
const SSH_USER = process.env.SSH_USER || os.userInfo().username;

// PORT: TMUX_SESSION — tmux session name to attach to (created if it doesn't exist)
const TMUX_SESSION = process.env.TMUX_SESSION || 'main';

// PORT: TLS_CERT / TLS_KEY — paths to TLS cert and key files
// If both are set, the server runs HTTPS; otherwise plain HTTP.
// Example (self-signed): openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY  = process.env.TLS_KEY;
const useTls   = !!(TLS_CERT && TLS_KEY);

const app = express();
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : http.createServer(app);

// Per-IP brute-force tracking with Fibonacci lockout
const loginState = new Map();

function getState(ip) {
  return loginState.get(ip) || { failures: 0, lockedUntil: 0, fibA: 1, fibB: 1 };
}

function recordFailure(ip) {
  const s = getState(ip);
  s.failures++;
  if (s.failures >= 3) {
    const wait = s.fibA;
    [s.fibA, s.fibB] = [s.fibB, s.fibA + s.fibB];
    s.lockedUntil = Date.now() + wait * 1000;
    s.failures = 0;
  }
  loginState.set(ip, s);
}

function recordSuccess(ip) { loginState.delete(ip); }

const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, cb) => {
    const ip = req.socket.remoteAddress;
    const s = getState(ip);
    if (Date.now() < s.lockedUntil) { cb(false, 429, 'Too Many Attempts'); return; }
    const token = new URL(req.url, 'https://localhost').searchParams.get('token');
    if (token === TOKEN) { recordSuccess(ip); cb(true); }
    else { recordFailure(ip); cb(false, 401, 'Unauthorized'); }
  },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/palette.json', (_req, res) => res.sendFile(path.join(__dirname, 'palette.json')));
app.get('/apple-touch-icon.png', (_req, res) => {
  res.set('Content-Type', 'image/png').send(iconPng);
});
app.get('/manifest.json', (_req, res) => res.json({
  name: 'webterm',
  short_name: 'webterm',
  start_url: '/',
  display: 'standalone',
  background_color: '#0d0d0d',
  theme_color: '#0d0d0d',
  icons: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
}));

wss.on('connection', (clientWs) => {
  console.log('browser connected');

  const ssh = new Client();
  let stream = null;
  let cols = 220, rows = 50;
  const pending = [];

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        cols = msg.cols; rows = msg.rows;
        stream?.setWindow(rows, cols, 0, 0);
      } else if (msg.type === 'data') {
        if (stream) stream.write(msg.data);
        else pending.push(msg.data);
      }
    } catch { /* ignore */ }
  });

  ssh.on('ready', () => {
    const cmd = `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color tmux -u new-session -A -s ${TMUX_SESSION}`;
    ssh.exec(cmd, { pty: { term: 'xterm-256color', cols, rows }, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }, (err, sh) => {
      if (err) {
        console.error('shell error:', err.message);
        clientWs.send('\r\n\x1b[31m[shell failed: ' + err.message + ']\x1b[0m\r\n');
        clientWs.close();
        return;
      }

      stream = sh;
      pending.forEach(d => stream.write(d));
      pending.length = 0;

      sh.on('data', (data) => {
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(data);
      });
      sh.stderr.on('data', (data) => {
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(data);
      });
      sh.on('close', () => {
        console.log('shell closed');
        if (clientWs.readyState === clientWs.OPEN) clientWs.close();
        ssh.end();
      });
    });
  });

  ssh.on('error', (err) => {
    console.error('ssh error:', err.message);
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send('\r\n\x1b[31m[ssh error: ' + err.message + ']\x1b[0m\r\n');
      clientWs.close();
    }
  });

  clientWs.on('close', () => {
    console.log('browser disconnected');
    stream?.close();
    ssh.end();
  });

  ssh.connect({
    host: '127.0.0.1',
    port: 22,
    username: SSH_USER,
    privateKey: fs.readFileSync(SSH_KEY),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[webterm] listening on ${useTls ? 'https' : 'http'}://${HOST}:${PORT}`);
  console.log(`[webterm] ssh user: ${SSH_USER}, key: ${SSH_KEY}, session: ${TMUX_SESSION}`);
});
