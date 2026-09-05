const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const SESSION_DAYS = 7;
const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'Admin@123',
};

function ensureDefaultAdmin() {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (existing) return { created: false };

  const hash = bcrypt.hashSync(DEFAULT_ADMIN.password, 10);
  database
    .prepare(
      `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`
    )
    .run(DEFAULT_ADMIN.username, hash);

  return { created: true, ...DEFAULT_ADMIN };
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    representative_id: row.representative_id || null,
    representative_name: row.representative_name || null,
  };
}

function findUserByUsername(username) {
  return (
    getDb()
      .prepare(
        `SELECT u.*, r.name AS representative_name
         FROM users u
         LEFT JOIN representatives r ON r.id = u.representative_id
         WHERE u.username = ? AND u.active = 1`
      )
      .get(String(username || '').trim()) || null
  );
}

function findUserById(id) {
  return (
    getDb()
      .prepare(
        `SELECT u.*, r.name AS representative_name
         FROM users u
         LEFT JOIN representatives r ON r.id = u.representative_id
         WHERE u.id = ? AND u.active = 1`
      )
      .get(id) || null
  );
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  getDb()
    .prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, expires);
  return { token, expiresAt: expires };
}

function destroySession(token) {
  if (!token) return;
  getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

function getSessionUser(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT s.token, s.expires_at, u.id, u.username, u.role, u.representative_id, r.name AS representative_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN representatives r ON r.id = u.representative_id
       WHERE s.token = ? AND u.active = 1`
    )
    .get(token);
  if (!row) return null;
  if (String(row.expires_at) < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    destroySession(token);
    return null;
  }
  return publicUser(row);
}

function login(username, password) {
  const user = findUserByUsername(username);
  if (!user) return { error: 'بيانات الدخول غير صحيحة' };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return { error: 'بيانات الدخول غير صحيحة' };
  }
  const session = createSession(user.id);
  return { user: publicUser(user), ...session };
}

function createUserForRepresentative({
  representativeId,
  username,
  password,
}) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');
  if (!cleanUser || cleanPass.length < 4) {
    throw new Error('اسم المستخدم وكلمة مرور (4 أحرف على الأقل) مطلوبان لحساب المندوب');
  }
  const exists = getDb().prepare(`SELECT id FROM users WHERE username = ?`).get(cleanUser);
  if (exists) throw new Error('اسم المستخدم مستخدم مسبقاً');

  const hash = bcrypt.hashSync(cleanPass, 10);
  const info = getDb()
    .prepare(
      `INSERT INTO users (username, password_hash, role, representative_id)
       VALUES (?, ?, 'rep', ?)`
    )
    .run(cleanUser, hash, representativeId);
  return findUserById(info.lastInsertRowid);
}

function requireAuth(roles = null) {
  return (req, res, next) => {
    const token = req.cookies?.asiepay_session || '';
    const user = getSessionUser(token);
    if (!user) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    }
    if (roles && !roles.includes(user.role)) {
      return res.status(403).json({ error: 'غير مصرح' });
    }
    req.user = user;
    req.sessionToken = token;
    next();
  };
}

module.exports = {
  DEFAULT_ADMIN,
  ensureDefaultAdmin,
  login,
  logout: destroySession,
  getSessionUser,
  publicUser,
  createUserForRepresentative,
  requireAuth,
};
