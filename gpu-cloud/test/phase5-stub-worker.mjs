// phase5-stub-worker.mjs — TEST-STUB Worker (D1 callbacks) for the §15
// installed-unit tests. Listens on 127.0.0.1 only, no auth (loopback test
// stub). GET /internal/d1-read -> {jobs: [], scenes: [], rateLimits: []};
// POST /internal/d1-apply -> {requestId, results: []}. Started by the
// installed test file; never a production component.
import http from 'node:http';

const port = Number(process.argv[2] ?? '18099');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/internal/d1-read') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jobs: [], scenes: [], rateLimits: [] }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/internal/d1-apply') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let requestId = null;
      try { requestId = JSON.parse(body).requestId ?? null; } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requestId, results: [] }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`stub-worker listening on 127.0.0.1:${port}`);
});
