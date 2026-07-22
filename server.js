// Account Health Monitor — zero-dependency Node server
// Serves the dashboard + a tiny JSON API backed by a file store.
// On Railway: attach a Volume mounted at /app/data so assessments persist across deploys.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_FILE = path.join(__dirname, 'seed-accounts.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // First run: seed from CMT account list
    const accounts = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const data = { accounts, assessments: {}, updatedAt: null };
    saveData(data);
    return data;
  }
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- API ----
  if (url.pathname === '/api/data' && req.method === 'GET') {
    return json(res, 200, loadData());
  }

  if (url.pathname === '/api/assessment' && req.method === 'POST') {
    try {
      const body = await readBody(req); // { accountId, values, notes, assessedBy }
      const data = loadData();
      const id = String(body.accountId);
      const existing = data.assessments[id] || { history: [] };
      existing.values = body.values || {};
      existing.notes = body.notes || {};
      existing.assessedBy = body.assessedBy || existing.assessedBy || '';
      existing.checkinDate = body.checkinDate !== undefined ? body.checkinDate : (existing.checkinDate || '');
      existing.checkinType = body.checkinType !== undefined ? body.checkinType : (existing.checkinType || '');
      existing.qstLast = body.qstLast !== undefined ? body.qstLast : (existing.qstLast || '');
      existing.qstNext = body.qstNext !== undefined ? body.qstNext : (existing.qstNext || '');
      existing.updatedAt = new Date().toISOString();

      // Snapshot: upsert one entry per day
      if (typeof body.score === 'number') {
        const today = existing.updatedAt.slice(0, 10);
        existing.history = (existing.history || []).filter((h) => h.date !== today);
        existing.history.push({ date: today, score: body.score, band: body.band || '' });
        existing.history.sort((a, b) => a.date.localeCompare(b.date));
        if (existing.history.length > 104) existing.history = existing.history.slice(-104);
      }

      data.assessments[id] = existing;
      data.updatedAt = existing.updatedAt;
      saveData(data);
      return json(res, 200, { ok: true, assessment: existing });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/accounts' && req.method === 'POST') {
    // Add an account manually (e.g., new account not yet in the seed)
    try {
      const body = await readBody(req);
      if (!body.name || !String(body.name).trim()) return json(res, 400, { ok: false, error: 'name required' });
      const data = loadData();
      const id = 'local-' + Date.now();
      data.accounts.push({ id, name: String(body.name).trim(), serviceLines: body.serviceLines || '', cmtHealth: '' });
      saveData(data);
      return json(res, 200, { ok: true, id });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // ---- Static: single-file app — every non-API GET serves index.html ----
  const candidates = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')];
  const serve = (i) => {
    if (i >= candidates.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('index.html is missing from the deployment — make sure it was uploaded to the repo.');
    }
    fs.readFile(candidates[i], (err, content) => {
      if (err) return serve(i + 1);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
  };
  serve(0);
});

server.listen(PORT, () => console.log(`Account Health Monitor running on :${PORT}`));
