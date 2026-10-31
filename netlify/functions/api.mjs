// TriAyam Stall Tracker - API (Netlify Function, Supabase Postgres storage). No npm dependencies.
import crypto from 'node:crypto';

const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const ROLES = ['Staff', 'Admin', 'SuperAdmin'];
const METHODS = ['UPI', 'Cash', 'Card'];
const STATUSES = ['Paid', 'Partial', 'Pending'];

const DEFAULT_BRAND = {
  name: 'TriAyam', accent: 'Ayam', badge: 'Stall POS', tagline: '3D Printing Studio & Services',
  invoiceName: 'TriAyam Studio', invoiceTagline: '3D Printing Studio & Prototyping Services',
  address: 'Talegaon Station, Pune, Maharashtra', phone: '', email: '', website: 'triayam.in',
  gstin: '', gstRate: 18, prefix: 'TA',
  footer: 'Thank you for visiting the TriAyam Stall!',
  footerSub: 'Visit triayam.in for custom 3D design & batch manufacturing', logo: ''
};

const DEFAULT_CATALOG = [
  ['3D Lithophane Lightbox', 'Lithophane', 799], ['Articulated Dragon / Animal', 'Articulated', 350],
  ['Customized 3D Keychain', 'Custom', 120], ['Mobile Stand / Holder', 'Utility', 250],
  ['Miniature Resin Figurine', 'Resin', 450], ['FDM Prototype Print (per gram)', 'FDM Printing', 15],
  ['Resin High-Detail Print', 'Resin', 600]
];

/* ---------------- helpers ---------------- */
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const enc = encodeURIComponent;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, min, max, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

function hashPw(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (e, k) => e ? reject(e) : resolve(`scrypt$${salt.toString('hex')}$${k.toString('hex')}`));
  });
}
function verifyPw(pw, stored) {
  return new Promise(resolve => {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt' || !s || !h) return resolve(false);
    crypto.scrypt(pw, Buffer.from(s, 'hex'), 64, (e, k) => {
      if (e) return resolve(false);
      const a = Buffer.from(h, 'hex');
      resolve(a.length === k.length && crypto.timingSafeEqual(a, k));
    });
  });
}
let dummyHash;
const getDummyHash = async () => dummyHash || (dummyHash = await hashPw('dummy-password'));

/* ---------------- Supabase (PostgREST) ---------------- */
function dbConfig() {
  const clean = v => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
  let url = clean(process.env.SUPABASE_URL);
  const key = clean(process.env.SUPABASE_SERVICE_KEY);
  if (url) {
    try { url = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).origin; } // drops any /rest/v1 or trailing path
    catch { throw httpErr(500, 'SUPABASE_URL is not a valid web address. It should look like https://abcdxyz.supabase.co'); }
  }
  if (!url || !key) throw httpErr(500, 'Server is not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify environment variables, then redeploy.');
  return { url, key };
}

async function sb(method, path, opts = {}) {
  const { url, key } = dbConfig();
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // legacy JWT-style keys; new sb_secret_ keys use apikey only
  if (opts.prefer) headers.Prefer = opts.prefer;
  let res;
  try {
    res = await fetch(url + '/rest/v1' + path, {
      method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    console.error('Supabase unreachable:', e.message);
    throw httpErr(502, 'Database is unreachable. Check SUPABASE_URL and try again.');
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* not json */ } }
  if (!res.ok) {
    console.error('Supabase error', method, path.split('?')[0], res.status, text.slice(0, 400));
    const code = data && typeof data === 'object' ? data.code : undefined;
    const detail = `HTTP ${res.status}${code ? ' ' + code : ''}${data && data.message ? ': ' + String(data.message).slice(0, 160) : ''}`;
    let msg;
    if (code === '42501') msg = 'Database permission problem: run supabase/fix-grants.sql in the Supabase SQL Editor.';
    else if (code === 'PGRST205' || code === '42P01') msg = 'Database tables are missing: run supabase/schema.sql in the Supabase SQL Editor.';
    else if (res.status === 401 || (res.status === 403 && !code)) msg = 'Database rejected the key: check SUPABASE_SERVICE_KEY in Netlify.';
    else if (res.status === 404 && !code) msg = 'Database address not found: check SUPABASE_URL in Netlify.';
    else if (res.status === 503 || res.status === 540 || res.status === 521) msg = 'Database is not responding: the Supabase project may be paused. Open the Supabase dashboard and click Restore.';
    else msg = 'Database error';
    const err = httpErr(500, `${msg} (${detail})`);
    err.pg = code;
    throw err;
  }
  return data;
}

async function selectAll(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await sb('GET', `${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/* ---------------- row mappers ---------------- */
const txFromRow = r => ({
  id: r.id, invoiceNo: r.invoice_no, executive: r.executive, version: r.version,
  customerName: r.customer_name, customerPhone: r.customer_phone, dateTime: r.date_time,
  items: r.items || [], subtotal: Number(r.subtotal), discount: Number(r.discount), total: Number(r.total),
  amountPaid: Number(r.amount_paid), gstRate: Number(r.gst_rate),
  paymentMethod: r.payment_method, paymentStatus: r.payment_status, txnRef: r.txn_ref
});
const txToRow = t => ({
  customer_name: t.customerName, customer_phone: t.customerPhone, date_time: t.dateTime, items: t.items,
  subtotal: t.subtotal, discount: t.discount, total: t.total, amount_paid: t.amountPaid, gst_rate: t.gstRate,
  payment_method: t.paymentMethod, payment_status: t.paymentStatus, txn_ref: t.txnRef
});
const catFromRow = r => ({ id: r.id, name: r.name, category: r.category, price: Number(r.price) });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active !== false });
const isAdminLevel = u => u.role === 'SuperAdmin' || u.role === 'Admin';
const canManage = (actor, target) => isAdminLevel(actor) && !(target.role === 'SuperAdmin' && actor.role !== 'SuperAdmin');

async function getBrand() {
  const rows = await sb('GET', '/brand?id=eq.1&select=data');
  return { ...DEFAULT_BRAND, ...((rows[0] && rows[0].data) || {}) };
}

/* ---------------- business rules ---------------- */
function buildTxn(input, base, gstRateForNew) {
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 50).map(i => ({
    name: str(i && i.name, 120) || 'Custom Non-Listed Model',
    qty: Math.round(num(i && i.qty, 1, 100000, 1)),
    price: round2(num(i && i.price, 0, 10000000, 0))
  }));
  if (!items.length) throw httpErr(400, 'At least one item is required');
  const phone = str(input.customerPhone, 10);
  if (!/^\d{10}$/.test(phone)) throw httpErr(400, 'Enter a valid 10-digit mobile number');
  const customerName = str(input.customerName, 80);
  if (!customerName) throw httpErr(400, 'Customer name is required');
  const dateTime = str(input.dateTime, 16);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateTime)) throw httpErr(400, 'Invalid date/time');
  const paymentMethod = METHODS.includes(input.paymentMethod) ? input.paymentMethod : 'UPI';
  const paymentStatus = STATUSES.includes(input.paymentStatus) ? input.paymentStatus : 'Paid';

  const subtotal = round2(items.reduce((a, i) => a + i.qty * i.price, 0));
  const discount = round2(Math.min(Math.max(Number(input.discount) || 0, 0), subtotal));
  const total = round2(subtotal - discount);
  let amountPaid = 0;
  if (paymentStatus === 'Paid') amountPaid = total;
  else if (paymentStatus === 'Partial') {
    amountPaid = round2(num(input.amountPaid, 0, total, 0));
    if (amountPaid <= 0 || amountPaid >= total) throw httpErr(400, 'For partial payment, enter an amount between 0 and the total');
  }
  return {
    customerName, customerPhone: phone, dateTime, items, subtotal, discount, total, amountPaid,
    gstRate: base ? base.gstRate : gstRateForNew, paymentMethod, paymentStatus, txnRef: str(input.txnRef, 120)
  };
}

/* ---------------- auth ---------------- */
async function ensureSeed() {
  const rows = await sb('GET', '/app_users?select=id&limit=1');
  if (rows.length) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || pw.length < 6) {
    throw httpErr(500, 'No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (min 6 characters) in Netlify environment variables, then redeploy.');
  }
  await sb('POST', '/app_users?on_conflict=email', {
    body: { name: 'TriAyam Admin', email, password_hash: await hashPw(pw), role: 'SuperAdmin', active: true },
    prefer: 'resolution=ignore-duplicates,return=minimal'
  });
  const cat = await sb('GET', '/catalog?select=id&limit=1');
  if (!cat.length) {
    await sb('POST', '/catalog', {
      body: DEFAULT_CATALOG.map(([name, category, price]) => ({ name, category, price })), prefer: 'return=minimal'
    });
  }
}

async function checkRate(key) {
  const rows = await sb('GET', `/login_attempts?key=eq.${key}&select=count,until`);
  const a = rows[0];
  if (a && new Date(a.until) > new Date() && a.count >= 8) throw httpErr(429, 'Too many attempts. Try again in a few minutes.');
}
async function noteFail(key) {
  const rows = await sb('GET', `/login_attempts?key=eq.${key}&select=count,until`);
  const a = rows[0];
  const live = a && new Date(a.until) > new Date();
  await sb('POST', '/login_attempts?on_conflict=key', {
    body: { key, count: live ? a.count + 1 : 1, until: live ? a.until : new Date(Date.now() + 15 * 60 * 1000).toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal'
  });
}

async function authenticate(req) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const key = sha(m[1]);
  const rows = await sb('GET', `/sessions?key_hash=eq.${key}&select=exp,user:app_users(id,name,email,role,active,password_hash)`);
  const s = rows[0];
  if (!s || !s.user) return null;
  if (new Date(s.exp) < new Date()) { await sb('DELETE', `/sessions?key_hash=eq.${key}`, { prefer: 'return=minimal' }); return null; }
  if (s.user.active === false) return null;
  return { user: s.user, key };
}

const purgeSessions = (userId, exceptKey) =>
  sb('DELETE', `/sessions?user_id=eq.${userId}${exceptKey ? `&key_hash=neq.${exceptKey}` : ''}`, { prefer: 'return=minimal' });

async function activeSupers() {
  const rows = await sb('GET', '/app_users?role=eq.SuperAdmin&active=eq.true&select=id');
  return rows.length;
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw httpErr(413, 'Request too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw httpErr(400, 'Invalid JSON'); }
}

/* ---------------- routes ---------------- */
async function route(req, context) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const method = req.method;

  if (method === 'GET' && p === '/api/health') return json(200, { ok: true });

  if (method === 'GET' && p === '/api/public-brand') {
    const { name, accent, badge, logo } = await getBrand();
    return json(200, { name, accent, badge, logo });
  }

  if (method === 'POST' && p === '/api/login') {
    const b = await readBody(req);
    const email = str(b.email, 120).toLowerCase();
    const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const rk = sha(ip + '|' + email);
    await Promise.all([checkRate(rk), ensureSeed()]);
    const rows = await sb('GET', `/app_users?email=eq.${enc(email)}&select=*&limit=1`);
    const user = rows[0];
    const ok = await verifyPw(String(b.password ?? ''), user ? user.password_hash : await getDummyHash());
    if (!user || !ok) { await noteFail(rk); throw httpErr(401, 'Invalid credentials provided.'); }
    if (user.active === false) throw httpErr(403, 'This account has been deactivated.');
    const token = crypto.randomBytes(32).toString('hex');
    await Promise.all([
      sb('DELETE', `/login_attempts?key=eq.${rk}`, { prefer: 'return=minimal' }),
      sb('DELETE', `/sessions?exp=lt.${enc(new Date().toISOString())}`, { prefer: 'return=minimal' }),
      sb('POST', '/sessions', {
        body: { key_hash: sha(token), user_id: user.id, exp: new Date(Date.now() + SESSION_MS).toISOString() },
        prefer: 'return=minimal'
      })
    ]);
    return json(200, { token, me: publicUser(user) });
  }

  // Start the database reads these routes need at the same time as the session check (saves a round trip).
  let prefetch = null;
  if (req.headers.get('authorization')) {
    if (method === 'GET' && p === '/api/bootstrap') prefetch = sb('GET', '/app_meta?id=eq.1&select=rev');
    else if (method === 'POST' && p === '/api/transactions') prefetch = getBrand();
    if (prefetch) prefetch.catch(() => {});
  }
  const auth = await authenticate(req);
  if (!auth) throw httpErr(401, 'Please sign in.');
  const me = auth.user;
  const requireAdmin = () => { if (!isAdminLevel(me)) throw httpErr(403, 'Admin access required'); };
  const requireSuper = () => { if (me.role !== 'SuperAdmin') throw httpErr(403, 'Super Admin access required'); };

  if (method === 'POST' && p === '/api/logout') {
    await sb('DELETE', `/sessions?key_hash=eq.${auth.key}`, { prefer: 'return=minimal' });
    return json(200, { ok: true });
  }

  if (method === 'GET' && p === '/api/bootstrap') {
    const since = parseInt(url.searchParams.get('since'), 10);
    const meta = await prefetch;
    const rev = Number(meta[0] && meta[0].rev);
    if (since === rev) return json(200, { unchanged: true, rev, me: publicUser(me) });
    const [brand, catalog, txns, users] = await Promise.all([
      getBrand(),
      selectAll('/catalog?select=*&order=created_at.asc,id.asc'),
      selectAll('/transactions?select=*&order=date_time.desc,created_at.desc,id.asc'),
      isAdminLevel(me) ? selectAll('/app_users?select=id,name,email,role,active&order=created_at.asc,id.asc') : Promise.resolve([])
    ]);
    return json(200, {
      rev, me: publicUser(me), brand, catalog: catalog.map(catFromRow),
      transactions: txns.map(txFromRow), users: users.map(publicUser)
    });
  }

  if (method === 'POST' && p === '/api/me/password') {
    const b = await readBody(req);
    if (!(await verifyPw(String(b.current ?? ''), me.password_hash))) throw httpErr(400, 'Current password is incorrect.');
    if (String(b.next ?? '').length < 6) throw httpErr(400, 'Password must be at least 6 characters.');
    await sb('PATCH', `/app_users?id=eq.${me.id}`, { body: { password_hash: await hashPw(String(b.next)) }, prefer: 'return=minimal' });
    await purgeSessions(me.id, auth.key);
    return json(200, { ok: true });
  }

  /* brand (Super Admin only) */
  if (method === 'PUT' && p === '/api/brand') {
    requireSuper();
    const b = await readBody(req);
    const next = {
      name: str(b.name, 40), accent: str(b.accent, 40), badge: str(b.badge, 20), tagline: str(b.tagline, 80),
      invoiceName: str(b.invoiceName, 60), invoiceTagline: str(b.invoiceTagline, 80), address: str(b.address, 200),
      phone: str(b.phone, 30), email: str(b.email, 80), website: str(b.website, 80),
      gstin: str(b.gstin, 20).toUpperCase(), gstRate: round2(num(b.gstRate, 0, 100, 0)),
      prefix: str(b.prefix, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INV',
      footer: str(b.footer, 120), footerSub: str(b.footerSub, 160)
    };
    if (!next.name) throw httpErr(400, 'Brand name is required.');
    const logo = typeof b.logo === 'string' ? b.logo : '';
    if (logo && !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw httpErr(400, 'Invalid logo image');
    if (logo.length > 1.5 * 1024 * 1024) throw httpErr(400, 'Logo is too large');
    next.logo = logo;
    await sb('POST', '/brand?on_conflict=id', { body: { id: 1, data: next }, prefer: 'resolution=merge-duplicates,return=minimal' });
    return json(200, { brand: { ...DEFAULT_BRAND, ...next } });
  }

  /* catalog */
  if (method === 'POST' && p === '/api/catalog') {
    const b = await readBody(req);
    const item = { name: str(b.name, 120), category: str(b.category, 60), price: round2(num(b.price, 0, 10000000, 0)) };
    if (!item.name || !item.category) throw httpErr(400, 'Name and category are required');
    const rows = await sb('POST', '/catalog', { body: item, prefer: 'return=representation' });
    return json(200, { item: catFromRow(rows[0]) });
  }
  let m = p.match(/^\/api\/catalog\/([0-9a-f-]{36})$/);
  if (m) {
    if (method === 'PUT') {
      const b = await readBody(req);
      const item = { name: str(b.name, 120), category: str(b.category, 60), price: round2(num(b.price, 0, 10000000, 0)) };
      if (!item.name || !item.category) throw httpErr(400, 'Name and category are required');
      const rows = await sb('PATCH', `/catalog?id=eq.${m[1]}`, { body: item, prefer: 'return=representation' });
      if (!rows.length) throw httpErr(404, 'Catalog item not found');
      return json(200, { item: catFromRow(rows[0]) });
    }
    if (method === 'DELETE') {
      requireAdmin();
      await sb('DELETE', `/catalog?id=eq.${m[1]}`, { prefer: 'return=minimal' });
      return json(200, { ok: true });
    }
  }

  /* transactions */
  if (method === 'POST' && p === '/api/transactions') {
    const b = await readBody(req);
    const brand = await prefetch;
    const data = buildTxn(b, null, brand.gstRate);
    for (let attempt = 0; attempt < 4; attempt++) {
      const seq = await sb('POST', '/rpc/next_counter', { body: {} });
      const invoiceNo = `${brand.prefix || 'INV'}-${new Date().getFullYear()}-${seq}`;
      try {
        const rows = await sb('POST', '/transactions', {
          body: { ...txToRow(data), invoice_no: invoiceNo, executive: me.name, version: 1 }, prefer: 'return=representation'
        });
        return json(200, { transaction: txFromRow(rows[0]) });
      } catch (e) {
        if (e.pg !== '23505') throw e; // invoice number clash: take the next number
      }
    }
    throw httpErr(500, 'Could not allocate an invoice number. Please try again.');
  }
  m = p.match(/^\/api\/transactions\/([0-9a-f-]{36})$/);
  if (m) {
    requireAdmin();
    const found = await sb('GET', `/transactions?id=eq.${m[1]}&select=*`);
    if (!found.length) throw httpErr(404, 'Transaction not found (it may have been deleted on another device)');
    const cur = txFromRow(found[0]);
    if (method === 'PUT') {
      const b = await readBody(req);
      if (b.version !== undefined && Number(b.version) !== cur.version) {
        throw httpErr(409, 'This record was changed on another device. The latest data has been loaded - please re-apply your edit.');
      }
      const data = buildTxn(b, cur);
      const rows = await sb('PATCH', `/transactions?id=eq.${cur.id}&version=eq.${cur.version}`, {
        body: { ...txToRow(data), version: cur.version + 1 }, prefer: 'return=representation'
      });
      if (!rows.length) throw httpErr(409, 'This record was changed on another device. The latest data has been loaded - please re-apply your edit.');
      return json(200, { transaction: txFromRow(rows[0]) });
    }
    if (method === 'DELETE') {
      await sb('DELETE', `/transactions?id=eq.${cur.id}`, { prefer: 'return=minimal' });
      return json(200, { ok: true });
    }
  }

  /* one-time import from the old browser-only version */
  if (method === 'POST' && p === '/api/import') {
    requireSuper();
    const b = await readBody(req);
    const brand = await getBrand();
    const existing = new Set((await selectAll('/transactions?select=invoice_no&order=invoice_no.asc')).map(r => r.invoice_no));
    const rows = [];
    let maxSeq = 0;
    for (const old of (Array.isArray(b.transactions) ? b.transactions : []).slice(0, 20000)) {
      try {
        const invoiceNo = str(old.invoiceNo, 40);
        if (!invoiceNo || existing.has(invoiceNo)) continue;
        const paid = Number(old.amountPaid);
        const gst = Number(old.gstRate);
        const data = buildTxn({
          ...old, amountPaid: Number.isFinite(paid) ? paid : (old.paymentStatus === 'Paid' ? old.total : 0)
        }, null, Number.isFinite(gst) ? gst : 18);
        rows.push({ ...txToRow(data), invoice_no: invoiceNo, executive: str(old.executive, 80) || 'Imported', version: 1 });
        existing.add(invoiceNo);
        const mm = invoiceNo.match(/(\d+)$/);
        if (mm) maxSeq = Math.max(maxSeq, parseInt(mm[1], 10));
      } catch { /* skip invalid legacy row */ }
    }
    let addedTx = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const res = await sb('POST', '/transactions?on_conflict=invoice_no', {
        body: rows.slice(i, i + 200), prefer: 'resolution=ignore-duplicates,return=representation'
      });
      addedTx += res.length;
    }
    if (maxSeq) await sb('POST', '/rpc/bump_counter', { body: { min_val: maxSeq } });

    const names = new Set((await selectAll('/catalog?select=name&order=name.asc')).map(r => r.name));
    const cats = [];
    for (const c of (Array.isArray(b.catalog) ? b.catalog : []).slice(0, 2000)) {
      const name = str(c && c.name, 120);
      if (!name || names.has(name)) continue;
      cats.push({ name, category: str(c.category, 60) || 'Custom', price: round2(num(c.price, 0, 10000000, 0)) });
      names.add(name);
    }
    if (cats.length) await sb('POST', '/catalog', { body: cats, prefer: 'return=minimal' });
    void brand;
    return json(200, { addedTransactions: addedTx, addedCatalog: cats.length });
  }

  /* users (Admin / Super Admin) */
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    requireAdmin();
    if (method === 'POST' && p === '/api/users') {
      const b = await readBody(req);
      const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), role = b.role;
      if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw httpErr(400, 'Valid name and email are required');
      if (!ROLES.includes(role) || (role === 'SuperAdmin' && me.role !== 'SuperAdmin')) throw httpErr(403, 'You cannot assign that role.');
      if (String(b.password ?? '').length < 6) throw httpErr(400, 'Password must be at least 6 characters.');
      try {
        const rows = await sb('POST', '/app_users', {
          body: { name, email, password_hash: await hashPw(String(b.password)), role, active: true }, prefer: 'return=representation'
        });
        return json(200, { user: publicUser(rows[0]) });
      } catch (e) {
        if (e.pg === '23505') throw httpErr(409, 'A user with this email already exists.');
        throw e;
      }
    }
    m = p.match(/^\/api\/users\/([0-9a-f-]{36})$/);
    if (m) {
      const rows = await sb('GET', `/app_users?id=eq.${m[1]}&select=id,name,email,role,active`);
      const target = rows[0];
      if (!target) throw httpErr(404, 'User not found');
      if (!canManage(me, target)) throw httpErr(403, 'Access denied');
      if (method === 'PUT') {
        const b = await readBody(req);
        const patch = {};
        if (b.password !== undefined) {
          if (String(b.password).length < 6) throw httpErr(400, 'Password must be at least 6 characters.');
          patch.password_hash = await hashPw(String(b.password));
        }
        if (b.active !== undefined) {
          if (target.id === me.id) throw httpErr(400, 'You cannot deactivate your own account.');
          if (!b.active && target.role === 'SuperAdmin' && target.active !== false && (await activeSupers()) <= 1) {
            throw httpErr(400, 'At least one active Super Admin is required.');
          }
          patch.active = !!b.active;
        }
        if (Object.keys(patch).length) {
          await sb('PATCH', `/app_users?id=eq.${target.id}`, { body: patch, prefer: 'return=minimal' });
          if (patch.password_hash !== undefined || patch.active === false) await purgeSessions(target.id);
        }
        return json(200, { user: publicUser({ ...target, ...(patch.active !== undefined ? { active: patch.active } : {}) }) });
      }
      if (method === 'DELETE') {
        if (target.id === me.id) throw httpErr(400, 'You cannot delete your own account.');
        if (target.role === 'SuperAdmin' && target.active !== false && (await activeSupers()) <= 1) {
          throw httpErr(400, 'At least one active Super Admin is required.');
        }
        await sb('DELETE', `/app_users?id=eq.${target.id}`, { prefer: 'return=minimal' }); // sessions cascade
        return json(200, { ok: true });
      }
    }
  }

  throw httpErr(404, 'Not found');
}

export default async (req, context) => {
  try {
    return await route(req, context);
  } catch (e) {
    if (e && e.status) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Server error' });
  }
};

export const config = { path: '/api/*' };
