const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-owner-token']
}));
app.options('*', cors());
app.use(express.json());

// ─── DATABASE SETUP ────────────────────────────────────────
const db = new Database(path.join(__dirname, 'bookings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_ref TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT NOT NULL,
    vehicle     TEXT NOT NULL,
    journey_date TEXT NOT NULL,
    return_date  TEXT,
    pickup      TEXT NOT NULL,
    drop_loc    TEXT NOT NULL,
    notes       TEXT,
    total_amount REAL NOT NULL,
    advance_paid REAL NOT NULL,
    balance_due  REAL NOT NULL,
    payment_id   TEXT,
    status      TEXT DEFAULT 'pending',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS prices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_key TEXT UNIQUE NOT NULL,
    price       REAL NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS owner_sessions (
    token       TEXT PRIMARY KEY,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default prices if not exist
const vehicles = ['bus','tempo_ac','tempo_nonac','toffan_ac','toffan_nonac'];
vehicles.forEach(v => {
  const exists = db.prepare('SELECT id FROM prices WHERE vehicle_key = ?').get(v);
  if (!exists) db.prepare('INSERT INTO prices (vehicle_key, price) VALUES (?, 0)').run(v);
});

// ─── HELPERS ──────────────────────────────────────────────
function generateRef() {
  return 'SJ-' + Date.now().toString().slice(-6) + Math.random().toString(36).slice(2,5).toUpperCase();
}

function ownerAuth(req, res, next) {
  const token = req.headers['x-owner-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = db.prepare('SELECT token FROM owner_sessions WHERE token = ?').get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
  next();
}

// ─── PUBLIC ROUTES ────────────────────────────────────────

// Get all prices (public - customers need to see prices)
app.get('/api/prices', (req, res) => {
  const rows = db.prepare('SELECT vehicle_key, price FROM prices').all();
  const result = {};
  rows.forEach(r => result[r.vehicle_key] = r.price);
  res.json(result);
});

// Create booking
app.post('/api/bookings', (req, res) => {
  const { name, email, phone, vehicle, journey_date, return_date,
          pickup, drop_loc, notes, payment_id } = req.body;

  if (!name || !email || !phone || !vehicle || !journey_date || !pickup || !drop_loc) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const priceRow = db.prepare('SELECT price FROM prices WHERE vehicle_key = ?').get(vehicle);
  if (!priceRow || priceRow.price === 0) {
    return res.status(400).json({ error: 'Vehicle price not set. Please contact us directly.' });
  }

  const d1 = new Date(journey_date);
  const d2 = return_date ? new Date(return_date) : d1;
  const days = Math.max(1, (d2 - d1) / (1000 * 60 * 60 * 24));
  const total = priceRow.price * days;
  const advance = Math.ceil(total * 0.10);
  const balance = total - advance;
  const ref = generateRef();

  try {
    db.prepare(`
      INSERT INTO bookings (booking_ref, name, email, phone, vehicle, journey_date, return_date,
        pickup, drop_loc, notes, total_amount, advance_paid, balance_due, payment_id, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(ref, name, email, phone, vehicle, journey_date, return_date || null,
           pickup, drop_loc, notes || null, total, advance, balance,
           payment_id || null, payment_id ? 'confirmed' : 'pending');

    res.json({ success: true, booking_ref: ref, total, advance, balance });
  } catch (err) {
    res.status(500).json({ error: 'Booking failed: ' + err.message });
  }
});

// Verify Razorpay payment and confirm booking
app.post('/api/bookings/confirm-payment', (req, res) => {
  const { booking_ref, payment_id, razorpay_order_id, razorpay_signature } = req.body;

  // In production: verify signature using crypto
  // const secret = process.env.RAZORPAY_KEY_SECRET;
  // const body = razorpay_order_id + "|" + payment_id;
  // const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  // if (expectedSignature !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });

  db.prepare('UPDATE bookings SET payment_id = ?, status = ? WHERE booking_ref = ?')
    .run(payment_id, 'confirmed', booking_ref);

  res.json({ success: true, message: 'Booking confirmed!' });
});

// ─── OWNER AUTH ROUTES ────────────────────────────────────

// Owner login
app.post('/api/owner/login', (req, res) => {
  const { password } = req.body;
  const ownerPassword = process.env.OWNER_PASSWORD || 'admin123'; // Change in .env!

  if (password !== ownerPassword) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO owner_sessions (token) VALUES (?)').run(token);

  // Auto-expire old sessions (older than 24h)
  db.prepare("DELETE FROM owner_sessions WHERE created_at < datetime('now', '-24 hours')").run();

  res.json({ success: true, token });
});

// Owner logout
app.post('/api/owner/logout', ownerAuth, (req, res) => {
  db.prepare('DELETE FROM owner_sessions WHERE token = ?').run(req.headers['x-owner-token']);
  res.json({ success: true });
});

// ─── OWNER PROTECTED ROUTES ──────────────────────────────

// Update prices (OWNER ONLY)
app.post('/api/owner/prices', ownerAuth, (req, res) => {
  const { prices: newPrices } = req.body;
  if (!newPrices) return res.status(400).json({ error: 'No prices provided' });

  const update = db.prepare("UPDATE prices SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE vehicle_key = ?");
  Object.entries(newPrices).forEach(([key, val]) => {
    if (vehicles.includes(key)) update.run(parseFloat(val) || 0, key);
  });

  res.json({ success: true, message: 'Prices updated!' });
});

// Get all bookings (OWNER ONLY)
app.get('/api/owner/bookings', ownerAuth, (req, res) => {
  const { status, search } = req.query;
  let query = 'SELECT * FROM bookings';
  const params = [];

  if (status && status !== 'all') {
    query += ' WHERE status = ?';
    params.push(status);
  }
  if (search) {
    const s = `%${search}%`;
    query += (params.length ? ' AND' : ' WHERE') +
      ' (name LIKE ? OR phone LIKE ? OR booking_ref LIKE ?)';
    params.push(s, s, s);
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// Update booking status (OWNER ONLY)
app.patch('/api/owner/bookings/:ref', ownerAuth, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE bookings SET status = ? WHERE booking_ref = ?').run(status, req.params.ref);
  res.json({ success: true });
});

// Delete booking (OWNER ONLY)
app.delete('/api/owner/bookings/:ref', ownerAuth, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE booking_ref = ?').run(req.params.ref);
  res.json({ success: true });
});

// Dashboard stats (OWNER ONLY)
app.get('/api/owner/stats', ownerAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
  const confirmed = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed'").get().c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='pending'").get().c;
  const revenue = db.prepare("SELECT COALESCE(SUM(advance_paid),0) as s FROM bookings WHERE status='confirmed'").get().s;
  res.json({ total, confirmed, pending, revenue });
});

// ─── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ SwiftJourney backend running on http://localhost:${PORT}`);
  console.log(`🔑 Default owner password: ${process.env.OWNER_PASSWORD || 'admin123'} — Change in .env!`);
});
