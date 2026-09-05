const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, queryOne, getPool } = require('./db');

const SESSION_DAYS = 7;
const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'Admin@123',
};

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

async function ensureDefaultAdmin() {
  await getPool();
  const existing = await queryOne(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existing) return { created: false };

  const hash = bcrypt.hashSync(DEFAULT_ADMIN.password, 10);
  await query(
    `INSERT INTO users (username, password_hash, role) VALUES (:username, :password_hash, 'admin')`,
    { username: DEFAULT_ADMIN.username, password_hash: hash }
  );

  return { created: true, ...DEFAULT_ADMIN };
}

async function findUserByUsername(username) {
  return queryOne(
    `SELECT u.*, r.name AS representative_name
     FROM users u
     LEFT JOIN representatives r ON r.id = u.representative_id
     WHERE u.username = :username AND u.active = 1`,
    { username: String(username || '').trim() }
  );
}

async function findUserById(id) {
  return queryOne(
    `SELECT u.*, r.name AS representative_name
     FROM users u
     LEFT JOIN representatives r ON r.id = u.representative_id
     WHERE u.id = :id AND u.active = 1`,
    { id }
  );
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (:token, :user_id, :expires_at)`,
    { token, user_id: userId, expires_at: expires }
  );
  return { token, expiresAt: expires };
}

async function destroySession(token) {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token = :token`, { token });
}

async function getSessionUser(token) {
  if (!token) return null;
  const row = await queryOne(
    `SELECT s.token, s.expires_at, u.id, u.username, u.role, u.representative_id, r.name AS representative_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN representatives r ON r.id = u.representative_id
     WHERE s.token = :token AND u.active = 1`,
    { token }
  );
  if (!row) return null;
  const expires = String(row.expires_at);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  // MySQL may return Date object
  const expiresStr =
    row.expires_at instanceof Date
      ? row.expires_at.toISOString().slice(0, 19).replace('T', ' ')
      : expires.slice(0, 19).replace('T', ' ');
  if (expiresStr < now) {
    await destroySession(token);
    return null;
  }
  return publicUser(row);
}

async function login(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return { error: 'بيانات الدخول غير صحيحة' };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return { error: 'بيانات الدخول غير صحيحة' };
  }
  const session = await createSession(user.id);
  return { user: publicUser(user), ...session };
}

async function createUserForRepresentative({ representativeId, username, password }) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');
  if (!cleanUser || cleanPass.length < 4) {
    throw new Error('اسم المستخدم وكلمة مرور (4 أحرف على الأقل) مطلوبان لحساب المندوب');
  }
  const exists = await queryOne(`SELECT id FROM users WHERE username = :username`, {
    username: cleanUser,
  });
  if (exists) throw new Error('اسم المستخدم مستخدم مسبقاً');

  const hash = bcrypt.hashSync(cleanPass, 10);
  const { getPool: gp } = require('./db');
  const p = await gp();
  const [result] = await p.execute(
    `INSERT INTO users (username, password_hash, role, representative_id)
     VALUES (:username, :password_hash, 'rep', :representative_id)`,
    { username: cleanUser, password_hash: hash, representative_id: representativeId }
  );
  return findUserById(result.insertId);
}

function requireAuth(roles = null) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.asiepay_session || '';
      const user = await getSessionUser(token);
      if (!user) {
        return res.status(401).json({ error: 'يجب تسجيل الدخول' });
      }
      if (roles && !roles.includes(user.role)) {
        return res.status(403).json({ error: 'غير مصرح' });
      }
      req.user = user;
      req.sessionToken = token;
      next();
    } catch (err) {
      next(err);
    }
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
