/*
  Oscar Software Team - P2P API v3
  Server-side only. Keep TURSO_AUTH_TOKEN in hosting environment variables.

  Required env:
    TURSO_DATABASE_URL (or TURSO_URL)
    TURSO_AUTH_TOKEN   (or TURSO_TOKEN)
  Optional:
    TELEGRAM_BOT_TOKEN
    ADMIN_KEY
    ALLOWED_ORIGIN
*/

const API_VERSION = '3.7.0';

export default {
  async fetch(request, env = {}) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = normalizeApiPath(url.pathname);

    try {
      // Health MUST work even when Turso is not configured. This makes deployment errors diagnosable.
      if (path === '/health' && request.method === 'GET') {
        return json(await health(env), 200, cors);
      }

      requireConfig(env);
      await ensureSchema(env);

      let out;
      if (path === '/payment-methods' && request.method === 'GET') {
        out = { payment_methods: await listPaymentMethods(env, true) };
      } else if (/^\/payment-methods\/[^/]+$/.test(path) && request.method === 'GET') {
        out = { payment_method: await getPaymentMethod(env, decodeURIComponent(path.split('/').pop()), true) };
      } else if (path === '/orders' && request.method === 'POST') {
        out = { order: await createOrder(request, env) };
      } else if (path === '/orders' && request.method === 'GET') {
        out = { orders: await listMyOrders(request, env) };
      } else if (/^\/orders\/[^/]+$/.test(path) && request.method === 'GET') {
        out = { order: await getMyOrder(request, env, decodeURIComponent(path.split('/').pop()), true) };
      } else if (/^\/orders\/[^/]+\/proof$/.test(path) && request.method === 'POST') {
        out = { order: await submitProof(request, env, decodeURIComponent(path.split('/')[2])) };
      } else if (path === '/notifications' && request.method === 'GET') {
        out = { notifications: await listNotifications(request, env) };
      } else if (path === '/admin/payment-methods' && request.method === 'GET') {
        requireAdmin(request, env); out = { payment_methods: await listPaymentMethods(env, false) };
      } else if (path === '/admin/payment-methods' && request.method === 'POST') {
        requireAdmin(request, env); out = { payment_method: await savePaymentMethod(request, env) };
      } else if (/^\/admin\/payment-methods\/[^/]+$/.test(path) && request.method === 'DELETE') {
        requireAdmin(request, env); out = { ok: await removePaymentMethod(env, decodeURIComponent(path.split('/').pop())) };
      } else if (path === '/admin/orders' && request.method === 'GET') {
        requireAdmin(request, env); out = { orders: await listAdminOrders(env) };
      } else if (/^\/admin\/orders\/[^/]+$/.test(path) && request.method === 'GET') {
        requireAdmin(request, env); out = { order: await adminOrder(env, decodeURIComponent(path.split('/').pop()), true) };
      } else if (/^\/admin\/orders\/[^/]+\/approve$/.test(path) && request.method === 'POST') {
        requireAdmin(request, env); out = { order: await reviewOrder(env, decodeURIComponent(path.split('/')[3]), 'approve', request) };
      } else if (/^\/admin\/orders\/[^/]+\/reject$/.test(path) && request.method === 'POST') {
        requireAdmin(request, env); out = { order: await reviewOrder(env, decodeURIComponent(path.split('/')[3]), 'reject', request) };
      } else if (/^\/admin\/orders\/[^/]+\/status$/.test(path) && request.method === 'POST') {
        requireAdmin(request, env); out = { order: await changeOrderStatus(env, decodeURIComponent(path.split('/')[3]), request) };
      } else {
        throw httpError(404, 'مسار P2P غير موجود');
      }

      return json(out, 200, cors);
    } catch (error) {
      console.error('P2P API:', error);
      const status = Number(error?.status) || 500;
      return json({
        ok: false,
        error: safeError(error),
        code: error?.code || (status >= 500 ? 'SERVER_ERROR' : 'REQUEST_ERROR'),
        version: API_VERSION
      }, status, cors);
    }
  }
};

function normalizeApiPath(pathname) {
  let p = String(pathname || '/').replace(/\/+$/, '') || '/';
  // Supports /api/orders, /api/p2p/orders and Netlify adapters.
  p = p.replace(/^\/api\/p2p(?=\/|$)/, '').replace(/^\/api(?=\/|$)/, '');
  if (!p.startsWith('/')) p = '/' + p;
  return p || '/';
}

function corsHeaders(env, req) {
  const configured = String(env.ALLOWED_ORIGIN || '*').trim();
  const origin = req.headers.get('Origin') || '';
  const allow = configured === '*' ? '*' : (origin === configured ? origin : configured);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Owner-Key,X-Telegram-Init-Data,X-Admin-Name,X-Checkout-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  };
}

function json(value, status, headers) {
  return new Response(JSON.stringify(value), { status, headers });
}

function httpError(status, message, code = '') {
  const e = new Error(message); e.status = status; e.code = code; return e;
}

function safeError(error) {
  const message = String(error?.message || 'حدث خطأ في نظام الدفع');
  return message.length > 600 ? message.slice(0, 600) : message;
}

function getConfig(env) {
  const rawUrl = String(env.TURSO_DATABASE_URL || env.TURSO_URL || '').trim();
  const token = String(env.TURSO_AUTH_TOKEN || env.TURSO_TOKEN || '').trim();
  if (!rawUrl || !token) return null;
  const base = rawUrl.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw httpError(500, 'رابط Turso غير صحيح في إعدادات الاستضافة', 'BAD_TURSO_URL');
  return { endpoint: base + '/v2/pipeline', token };
}

function requireConfig(env) {
  const cfg = getConfig(env);
  if (!cfg) throw httpError(503, 'نظام الدفع غير مهيأ على الاستضافة: أضف TURSO_DATABASE_URL و TURSO_AUTH_TOKEN ثم أعد النشر.', 'P2P_NOT_CONFIGURED');
  return cfg;
}

async function health(env) {
  const configured = !!getConfig(env);
  if (!configured) return { ok: true, service: 'Oscar P2P', version: API_VERSION, configured: false, database: false };
  try {
    const [r] = await sql(env, [{ sql: 'SELECT 1 AS ok' }]);
    return { ok: true, service: 'Oscar P2P', version: API_VERSION, configured: true, database: Number(r.rows?.[0]?.ok) === 1 };
  } catch (e) {
    return { ok: true, service: 'Oscar P2P', version: API_VERSION, configured: true, database: false, database_error: safeError(e) };
  }
}

function sqlArg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'float', value: String(value) };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  return { type: 'text', value: String(value) };
}

function decodeSqlValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer' || v.type === 'float') return Number(v.value);
  return v.value ?? v.base64 ?? null;
}

async function sql(env, statements) {
  const cfg = requireConfig(env);
  if (!Array.isArray(statements) || !statements.length) return [];

  const requests = statements.map(s => ({
    type: 'execute',
    stmt: {
      sql: String(s.sql || ''),
      ...(Array.isArray(s.args) ? { args: s.args.map(sqlArg) } : {})
    }
  }));
  requests.push({ type: 'close' });

  let response;
  try {
    response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests })
    });
  } catch (e) {
    throw httpError(502, 'تعذر الاتصال بقاعدة Turso. تحقق من رابط القاعدة والاتصال.', 'TURSO_NETWORK');
  }

  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch {}

  if (!response.ok) {
    const detail = body?.error?.message || body?.message || raw || response.statusText || 'Bad Request';
    throw httpError(502, `Turso (${response.status}): ${String(detail).slice(0, 350)}`, 'TURSO_HTTP');
  }
  if (!body || !Array.isArray(body.results)) {
    throw httpError(502, 'استجابة Turso غير مكتملة', 'TURSO_BAD_RESPONSE');
  }

  const output = [];
  for (let i = 0; i < statements.length; i++) {
    const result = body.results[i];
    if (!result) throw httpError(502, 'استجابة ناقصة من Turso', 'TURSO_BAD_RESPONSE');
    if (result.type === 'error') {
      throw httpError(500, result.error?.message || 'خطأ SQL في قاعدة Turso', 'TURSO_SQL');
    }
    const data = result.response?.result || { cols: [], rows: [] };
    const cols = (data.cols || []).map(c => c.name);
    output.push({
      rows: (data.rows || []).map(row => Object.fromEntries(row.map((v, j) => [cols[j], decodeSqlValue(v)]))),
      affected: Number(data.affected_row_count || 0)
    });
  }
  return output;
}

let schemaPromise = null;
async function ensureSchema(env) {
  if (schemaPromise) return schemaPromise;
  const schema = [
    `CREATE TABLE IF NOT EXISTS oscar_store_records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection,id))`,
    `CREATE INDEX IF NOT EXISTS idx_oscar_store_records_collection ON oscar_store_records(collection,updated_at)`,
    `CREATE TABLE IF NOT EXISTS p2p_orders (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, telegram_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, currency TEXT NOT NULL, payment_method_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_p2p_orders_owner ON p2p_orders(owner_key,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_p2p_orders_telegram ON p2p_orders(telegram_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_p2p_orders_status ON p2p_orders(status,created_at)`,
    `CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, unit_price REAL NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, subtotal REAL NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,
    `CREATE TABLE IF NOT EXISTS payment_methods (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT, description TEXT, payment_details TEXT NOT NULL, instructions TEXT, status TEXT NOT NULL DEFAULT 'active', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_payment_methods_status_sort ON payment_methods(status,sort_order,created_at)`,
    `CREATE TABLE IF NOT EXISTS payment_proofs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, user_id TEXT, payment_method_id TEXT NOT NULL, sender_account_name TEXT NOT NULL, proof_image TEXT NOT NULL, status TEXT NOT NULL, rejection_reason TEXT, submitted_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_payment_proofs_order ON payment_proofs(order_id)`,
    `CREATE TABLE IF NOT EXISTS p2p_notifications (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, telegram_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_p2p_notifications_owner ON p2p_notifications(owner_key,created_at)`,
    `CREATE TABLE IF NOT EXISTS p2p_checkout_keys (checkout_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, order_id TEXT NOT NULL, created_at TEXT NOT NULL)`
  ];
  schemaPromise = sql(env, schema.map(statement => ({ sql: statement }))).then(() => true).catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}

function requireAdmin(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const turso = String(env.TURSO_AUTH_TOKEN || env.TURSO_TOKEN || '').trim();
  const adminKey = String(env.ADMIN_KEY || '').trim();
  if (!token || (token !== turso && (!adminKey || token !== adminKey))) throw httpError(401, 'غير مصرح للإدارة', 'ADMIN_UNAUTHORIZED');
}

async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw httpError(400, 'بيانات الطلب غير صحيحة', 'INVALID_JSON'); }
}

function today() { return new Date().toISOString().slice(0, 10); }
function isActive(row) { const d = today(); return !!row && row.active !== false && (!row.start || row.start <= d) && (!row.end || row.end >= d); }
function discount(amount, type, value) { return Math.min(Number(amount) || 0, Math.max(0, type === 'percent' ? (Number(amount) || 0) * (Number(value) || 0) / 100 : Number(value) || 0)); }
function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function productPrice(product, offers) {
  let d = 0;
  if (isActive(product)) d = discount(product.price, product.discountType, product.discountValue);
  for (const offer of offers || []) {
    const hit = isActive(offer) && (offer.scope === 'all' || (offer.scope === 'category' && offer.target === product.category) || (offer.scope === 'products' && String(offer.target || '').split(',').map(x => x.trim()).includes(product.id)));
    if (hit) d = Math.max(d, discount(product.price, offer.discountType, offer.discountValue));
  }
  return round(Math.max(0, Number(product.price || 0) - d));
}

async function records(env, collection) {
  const [r] = await sql(env, [{ sql: 'SELECT id,payload FROM oscar_store_records WHERE collection=? ORDER BY updated_at DESC', args: [collection] }]);
  return r.rows.map(x => { try { return JSON.parse(x.payload); } catch { return null; } }).filter(Boolean);
}
async function record(env, collection, id) {
  const [r] = await sql(env, [{ sql: 'SELECT payload FROM oscar_store_records WHERE collection=? AND id=? LIMIT 1', args: [collection, id] }]);
  if (!r.rows[0]) return null;
  try { return JSON.parse(r.rows[0].payload); } catch { return null; }
}
async function putRecord(env, collection, row) {
  await sql(env, [{ sql: 'INSERT INTO oscar_store_records(collection,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at', args: [collection, row.id, JSON.stringify(row), new Date().toISOString()] }]);
}

async function listPaymentMethods(env, activeOnly = true) {
  const statement = activeOnly
    ? { sql: "SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods WHERE status='active' ORDER BY sort_order ASC,created_at ASC" }
    : { sql: 'SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods ORDER BY sort_order ASC,created_at ASC' };
  const [r] = await sql(env, [statement]); return r.rows;
}
async function getPaymentMethod(env, id, activeOnly = true) {
  const statement = activeOnly
    ? { sql: "SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods WHERE id=? AND status='active' LIMIT 1", args: [id] }
    : { sql: 'SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods WHERE id=? LIMIT 1', args: [id] };
  const [r] = await sql(env, [statement]);
  if (!r.rows[0]) throw httpError(404, 'طريقة الدفع غير موجودة أو غير مفعلة');
  return r.rows[0];
}
async function savePaymentMethod(req, env) {
  const b = await readJson(req), name = String(b.name || '').trim(), details = String(b.payment_details || '').trim();
  if (!name) throw httpError(400, 'اسم طريقة الدفع مطلوب');
  if (!details) throw httpError(400, 'بيانات الدفع مطلوبة');
  const id = String(b.id || ('PM-' + crypto.randomUUID())), now = new Date().toISOString(), status = b.status === 'disabled' ? 'disabled' : 'active', sort = Math.max(0, Number(b.sort_order) || 0);
  const [current] = await sql(env, [{ sql: 'SELECT created_at FROM payment_methods WHERE id=? LIMIT 1', args: [id] }]);
  const created = current.rows[0]?.created_at || now;
  await sql(env, [{
    sql: 'INSERT INTO payment_methods(id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image=excluded.image,description=excluded.description,payment_details=excluded.payment_details,instructions=excluded.instructions,status=excluded.status,sort_order=excluded.sort_order,updated_at=excluded.updated_at',
    args: [id, name, String(b.image || ''), String(b.description || ''), details, String(b.instructions || ''), status, sort, created, now]
  }]);
  return getPaymentMethod(env, id, false);
}
async function removePaymentMethod(env, id) { await sql(env, [{ sql: 'DELETE FROM payment_methods WHERE id=?', args: [id] }]); return true; }

async function validateTelegram(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData), hash = params.get('hash'); if (!hash) return null;
    params.delete('hash');
    const authDate = Number(params.get('auth_date') || 0); if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 7 * 86400) return null;
    const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
    const enc = new TextEncoder();
    const key1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = new Uint8Array(await crypto.subtle.sign('HMAC', key1, enc.encode(botToken)));
    const key2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key2, enc.encode(dataCheck)));
    const calc = Array.from(sig, b => b.toString(16).padStart(2, '0')).join(''); if (calc !== hash) return null;
    const u = JSON.parse(params.get('user') || 'null'); if (!u?.id) return null;
    return { telegram_id: String(u.id), telegram_username: u.username || '', first_name: u.first_name || '', last_name: u.last_name || '', full_name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id), photo_url: u.photo_url || '', language_code: u.language_code || '', verified: true };
  } catch { return null; }
}
async function actor(req, env, body = null) {
  const owner = String(req.headers.get('X-Owner-Key') || '').trim();
  if (owner.length < 32) throw httpError(401, 'هوية جلسة العميل غير متاحة. أعد فتح المتجر وحاول مجدداً.', 'OWNER_MISSING');
  const verified = await validateTelegram(req.headers.get('X-Telegram-Init-Data') || '', String(env.TELEGRAM_BOT_TOKEN || ''));
  const local = body?.local_user || {};
  const telegram = verified || ((!env.TELEGRAM_BOT_TOKEN && (local.telegram_id || local.telegram?.telegram_id)) ? { ...(local.telegram || local), verified: false } : null);
  return { owner_key: owner, telegram, telegram_id: telegram?.telegram_id || null, local_user: local };
}

function orderId() {
  const d = new Date(), date = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('');
  return `ST-${date}-${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

async function existingCheckout(env, checkoutKey, ownerKey) {
  if (!checkoutKey) return null;
  const [r] = await sql(env, [{ sql: 'SELECT order_id FROM p2p_checkout_keys WHERE checkout_key=? AND owner_key=? LIMIT 1', args: [checkoutKey, ownerKey] }]);
  if (!r.rows[0]) return null;
  const [o] = await sql(env, [{ sql: 'SELECT payload FROM p2p_orders WHERE id=? LIMIT 1', args: [r.rows[0].order_id] }]);
  return o.rows[0] ? parsePayload(o.rows[0].payload) : null;
}

async function createOrder(req, env) {
  const body = await readJson(req), a = await actor(req, env, body);
  const checkoutKey = String(req.headers.get('X-Checkout-Key') || body.checkout_key || '').trim().slice(0, 120);
  const previous = await existingCheckout(env, checkoutKey, a.owner_key);
  if (previous) return previous;

  const ids = [...new Set((Array.isArray(body.product_ids) ? body.product_ids : []).map(String).filter(Boolean))];
  if (!ids.length) throw httpError(400, 'السلة فارغة');
  if (ids.length > 30) throw httpError(400, 'عدد المنتجات في الطلب كبير جداً');

  const [products, offers, coupons, settingsRows] = await Promise.all([records(env, 'products'), records(env, 'offers'), records(env, 'coupons'), records(env, 'settings')]);
  const selected = ids.map(id => products.find(p => String(p.id) === id && p.status === 'active'));
  if (selected.some(x => !x)) throw httpError(409, 'أحد التطبيقات في السلة غير منشور حالياً. حدّث السلة وحاول مجدداً.');

  const subtotal = round(selected.reduce((s, p) => s + productPrice(p, offers), 0));
  let coupon = null;
  const code = String(body.coupon_code || '').trim().toUpperCase();
  if (code) {
    coupon = coupons.find(c => String(c.code || '').toUpperCase() === code);
    if (!coupon || !isActive(coupon)) throw httpError(400, 'كوبون الخصم غير صالح أو منتهي');
    if (Number(coupon.min || 0) > subtotal) throw httpError(400, 'الطلب لا يصل للحد الأدنى للكوبون');
    if (Number(coupon.maxUses || 0) > 0 && Number(coupon.used || 0) >= Number(coupon.maxUses)) throw httpError(400, 'تم استهلاك الحد الأقصى للكوبون');
  }

  const items = selected.map(p => { const unit = productPrice(p, offers); return { product_id: String(p.id), product_name: String(p.name || 'تطبيق'), sku: p.sku || '', unit_price: unit, quantity: 1, subtotal: unit }; });
  const original = round(selected.reduce((s, p) => s + Number(p.price || 0), 0));
  const productDiscount = round(original - subtotal), couponDiscount = round(coupon ? discount(subtotal, coupon.discountType, coupon.discountValue) : 0), total = round(subtotal - couponDiscount);
  const settings = settingsRows.find(x => x.id === 'store') || {}, currency = settings.currency || '₪', now = new Date().toISOString(), id = orderId();
  const customer = a.telegram
    ? { name: a.telegram.full_name, username: a.telegram.telegram_username || '', auth_provider: 'telegram' }
    : { name: String(a.local_user?.name || 'عميل'), username: String(a.local_user?.username || ''), phone: String(a.local_user?.phone || ''), email: String(a.local_user?.email || ''), auth_provider: a.local_user?.auth_provider || 'local' };
  const order = { id, customer, telegram: a.telegram, items, original, subtotal, product_discount: productDiscount, coupon_discount: couponDiscount, total, currency, coupon: coupon?.code || '', status: 'pending_payment', payment_method_id: '', payment_method_name: '', rejection_reason: '', created_at: now, updated_at: now };

  const statements = [{ sql: 'INSERT INTO p2p_orders(id,owner_key,telegram_id,payload,status,total,currency,payment_method_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', args: [id, a.owner_key, a.telegram_id, JSON.stringify(order), order.status, total, currency, '', now, now] }];
  items.forEach((item, i) => statements.push({ sql: 'INSERT INTO order_items(id,order_id,product_id,product_name,unit_price,quantity,subtotal) VALUES(?,?,?,?,?,?,?)', args: [id + '-' + (i + 1), id, item.product_id, item.product_name, item.unit_price, item.quantity, item.subtotal] }));
  if (checkoutKey) statements.push({ sql: 'INSERT OR IGNORE INTO p2p_checkout_keys(checkout_key,owner_key,order_id,created_at) VALUES(?,?,?,?)', args: [checkoutKey, a.owner_key, id, now] });
  await sql(env, statements);

  if (coupon) { coupon.used = (Number(coupon.used) || 0) + 1; await putRecord(env, 'coupons', coupon); }
  return order;
}

async function listMyOrders(req, env) {
  const a = await actor(req, env), q = a.telegram_id
    ? { sql: 'SELECT payload FROM p2p_orders WHERE owner_key=? OR telegram_id=? ORDER BY created_at DESC LIMIT 200', args: [a.owner_key, a.telegram_id] }
    : { sql: 'SELECT payload FROM p2p_orders WHERE owner_key=? ORDER BY created_at DESC LIMIT 200', args: [a.owner_key] };
  const [r] = await sql(env, [q]); return r.rows.map(x => parsePayload(x.payload)).filter(Boolean);
}
async function getMyOrder(req, env, id, proof = false) {
  const a = await actor(req, env), q = a.telegram_id
    ? { sql: 'SELECT payload FROM p2p_orders WHERE id=? AND (owner_key=? OR telegram_id=?) LIMIT 1', args: [id, a.owner_key, a.telegram_id] }
    : { sql: 'SELECT payload FROM p2p_orders WHERE id=? AND owner_key=? LIMIT 1', args: [id, a.owner_key] };
  const [r] = await sql(env, [q]); if (!r.rows[0]) throw httpError(404, 'الطلب غير موجود'); return hydrate(env, parsePayload(r.rows[0].payload), proof);
}
function parsePayload(v) { try { return JSON.parse(v); } catch { return null; } }
async function getProof(env, id, includeImage = true) {
  const [r] = await sql(env, [{ sql: 'SELECT * FROM payment_proofs WHERE order_id=? LIMIT 1', args: [id] }]);
  if (!r.rows[0]) return null; const p = { ...r.rows[0] }; if (!includeImage) delete p.proof_image; return p;
}
async function hydrate(env, order, includeImage) { if (!order) return null; const p = await getProof(env, order.id, includeImage); if (p) { order.payment_proof = p; order.rejection_reason = p.rejection_reason || order.rejection_reason || ''; } return order; }

async function submitProof(req, env, id) {
  const body = await readJson(req), a = await actor(req, env, body), order = await getMyOrder(req, env, id, false);
  if (!['pending_payment', 'payment_rejected'].includes(order.status)) throw httpError(409, 'لا يمكن رفع إثبات لهذا الطلب في حالته الحالية');
  const method = await getPaymentMethod(env, String(body.payment_method_id || ''), true).catch(() => { throw httpError(400, 'طريقة الدفع غير متاحة'); });
  const sender = String(body.sender_account_name || '').trim(), img = String(body.proof_image || '');
  if (!sender) throw httpError(400, 'اسم الحساب المحول منه مطلوب');
  if (!/^data:image\/(?:webp|jpeg|png);base64,/i.test(img)) throw httpError(400, 'صورة إثبات الدفع مطلوبة');
  if (img.length > 3_200_000) throw httpError(413, 'صورة إثبات الدفع كبيرة جداً');

  const now = new Date().toISOString(), proofId = 'PF-' + crypto.randomUUID();
  order.status = 'payment_review'; order.payment_method_id = method.id; order.payment_method_name = method.name; order.rejection_reason = ''; order.updated_at = now;
  await sql(env, [
    { sql: "INSERT INTO payment_proofs(id,order_id,user_id,payment_method_id,sender_account_name,proof_image,status,rejection_reason,submitted_at,reviewed_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(order_id) DO UPDATE SET payment_method_id=excluded.payment_method_id,sender_account_name=excluded.sender_account_name,proof_image=excluded.proof_image,status='payment_review',rejection_reason=NULL,submitted_at=excluded.submitted_at,reviewed_at=NULL,reviewed_by=NULL", args: [proofId, id, a.telegram_id || a.owner_key, method.id, sender, img, 'payment_review', null, now] },
    { sql: 'UPDATE p2p_orders SET payload=?,status=?,payment_method_id=?,updated_at=? WHERE id=?', args: [JSON.stringify(order), 'payment_review', method.id, now, id] }
  ]);
  return hydrate(env, order, true);
}

async function listAdminOrders(env) {
  const [r] = await sql(env, [{ sql: 'SELECT payload FROM p2p_orders ORDER BY created_at DESC LIMIT 1000' }]);
  const out = []; for (const x of r.rows) { const o = parsePayload(x.payload); if (o) { const p = await getProof(env, o.id, false); if (p) o.payment_proof = p; out.push(o); } } return out;
}
async function adminOrder(env, id, withProof) {
  const [r] = await sql(env, [{ sql: 'SELECT payload FROM p2p_orders WHERE id=? LIMIT 1', args: [id] }]); if (!r.rows[0]) throw httpError(404, 'الطلب غير موجود'); return hydrate(env, parsePayload(r.rows[0].payload), withProof);
}
async function notify(env, order, title, body) {
  await sql(env, [{ sql: 'INSERT INTO p2p_notifications(id,owner_key,telegram_id,title,body,created_at,read_at) SELECT ?,owner_key,telegram_id,?,?,?,NULL FROM p2p_orders WHERE id=?', args: ['NT-' + crypto.randomUUID(), title, body, new Date().toISOString(), order.id] }]);
}
async function reviewOrder(env, id, mode, req) {
  const order = await adminOrder(env, id, false); if (order.status !== 'payment_review') throw httpError(409, 'الطلب ليس قيد مراجعة الدفع');
  const now = new Date().toISOString(), admin = req.headers.get('X-Admin-Name') || 'admin';
  if (mode === 'approve') {
    order.status = 'payment_approved'; order.approved_by = admin; order.approved_at = now; order.rejection_reason = ''; order.updated_at = now;
    await sql(env, [
      { sql: 'UPDATE payment_proofs SET status=?,rejection_reason=NULL,reviewed_at=?,reviewed_by=? WHERE order_id=?', args: ['payment_approved', now, admin, id] },
      { sql: 'UPDATE p2p_orders SET payload=?,status=?,updated_at=? WHERE id=?', args: [JSON.stringify(order), 'payment_approved', now, id] }
    ]); await notify(env, order, 'تم قبول الدفع', 'تم قبول الدفع للطلب رقم ' + id);
  } else {
    const b = await readJson(req), reason = String(b.reason || '').trim(); if (!reason) throw httpError(400, 'سبب الرفض مطلوب');
    order.status = 'payment_rejected'; order.rejection_reason = reason; order.rejected_by = admin; order.rejected_at = now; order.updated_at = now;
    await sql(env, [
      { sql: 'UPDATE payment_proofs SET status=?,rejection_reason=?,reviewed_at=?,reviewed_by=? WHERE order_id=?', args: ['payment_rejected', reason, now, admin, id] },
      { sql: 'UPDATE p2p_orders SET payload=?,status=?,updated_at=? WHERE id=?', args: [JSON.stringify(order), 'payment_rejected', now, id] }
    ]); await notify(env, order, 'تم رفض إثبات الدفع', 'الطلب ' + id + ': ' + reason);
  }
  return hydrate(env, order, true);
}
async function changeOrderStatus(env, id, req) {
  const body = await readJson(req), status = String(body.status || ''); if (!['processing', 'completed', 'cancelled'].includes(status)) throw httpError(400, 'الحالة غير مسموحة');
  const order = await adminOrder(env, id, false), old = order.status;
  if (status === 'processing' && old !== 'payment_approved') throw httpError(409, 'يجب قبول الدفع أولاً');
  if (status === 'completed' && old !== 'processing') throw httpError(409, 'حوّل الطلب إلى قيد التنفيذ أولاً');
  if (old === 'completed') throw httpError(409, 'الطلب مكتمل بالفعل');
  const now = new Date().toISOString(); order.status = status; order.updated_at = now;
  await sql(env, [{ sql: 'UPDATE p2p_orders SET payload=?,status=?,updated_at=? WHERE id=?', args: [JSON.stringify(order), status, now, id] }]);
  if (status === 'completed') for (const item of order.items || []) { const p = await record(env, 'products', item.product_id); if (p) { p.purchases = Math.max(0, Number(p.purchases || 0) + 1); await putRecord(env, 'products', p); } }
  await notify(env, order, 'تحديث حالة الطلب', 'حالة الطلب ' + id + ' الآن: ' + ({ processing: 'قيد التنفيذ', completed: 'مكتمل', cancelled: 'ملغي' }[status] || status));
  return hydrate(env, order, true);
}
async function listNotifications(req, env) {
  const a = await actor(req, env), q = a.telegram_id
    ? { sql: 'SELECT id,title,body,created_at FROM p2p_notifications WHERE owner_key=? OR telegram_id=? ORDER BY created_at DESC LIMIT 100', args: [a.owner_key, a.telegram_id] }
    : { sql: 'SELECT id,title,body,created_at FROM p2p_notifications WHERE owner_key=? ORDER BY created_at DESC LIMIT 100', args: [a.owner_key] };
  const [r] = await sql(env, [q]); return r.rows;
}
