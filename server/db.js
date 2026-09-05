const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DB_DIR, 'asiepay.v2.db');

const STATUS = {
  ASSIGNED: 'ASSIGNED',
  ACTIVATED: 'ACTIVATED',
  ORPHAN_ASIA: 'ORPHAN_ASIA',
};

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS offices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS representatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('prep', 'asia')),
      source_file TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      rows_read INTEGER NOT NULL DEFAULT 0,
      upserted INTEGER NOT NULL DEFAULT 0,
      activated INTEGER NOT NULL DEFAULT 0,
      orphans INTEGER NOT NULL DEFAULT 0,
      offices_touched INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS phone_lines (
      phone TEXT PRIMARY KEY,
      office_id INTEGER REFERENCES offices(id),
      representative_id INTEGER REFERENCES representatives(id),
      item_code TEXT NOT NULL DEFAULT '',
      invoice_nb TEXT NOT NULL DEFAULT '',
      assigned_date TEXT,
      activation_date TEXT,
      status TEXT NOT NULL DEFAULT 'ASSIGNED',
      bundle_name TEXT NOT NULL DEFAULT '',
      bundle_revenue TEXT NOT NULL DEFAULT '',
      type_of_prod TEXT NOT NULL DEFAULT '',
      dealer_msisdn TEXT NOT NULL DEFAULT '',
      days_to_activate INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_batch_id INTEGER REFERENCES import_batches(id)
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      batch_id INTEGER REFERENCES import_batches(id),
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_phone_lines_office ON phone_lines(office_id);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_status ON phone_lines(status);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_activation ON phone_lines(activation_date);
    CREATE INDEX IF NOT EXISTS idx_status_history_phone ON status_history(phone);
  `);

  // soft migrations for existing DBs
  const officeCols = database.prepare(`PRAGMA table_info(offices)`).all().map((c) => c.name);
  if (!officeCols.includes('phone')) database.exec(`ALTER TABLE offices ADD COLUMN phone TEXT NOT NULL DEFAULT ''`);
  if (!officeCols.includes('city')) database.exec(`ALTER TABLE offices ADD COLUMN city TEXT NOT NULL DEFAULT ''`);
  if (!officeCols.includes('notes')) database.exec(`ALTER TABLE offices ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);

  const lineCols = database.prepare(`PRAGMA table_info(phone_lines)`).all().map((c) => c.name);
  if (!lineCols.includes('representative_id')) {
    database.exec(`ALTER TABLE phone_lines ADD COLUMN representative_id INTEGER REFERENCES representatives(id)`);
  }

  ensureIndexes(database);
  ensureAuthSchema(database);
}

function ensureAuthSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'rep')),
      representative_id INTEGER REFERENCES representatives(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prep_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      representative_id INTEGER NOT NULL REFERENCES representatives(id),
      office_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED')),
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_prep_requests_rep ON prep_requests(representative_id);
    CREATE INDEX IF NOT EXISTS idx_prep_requests_status ON prep_requests(status);
  `);
}

function ensureIndexes(database) {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_phone_lines_rep ON phone_lines(representative_id);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_office_status ON phone_lines(office_id, status);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_status_updated ON phone_lines(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_assigned ON phone_lines(assigned_date);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_updated ON phone_lines(updated_at);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_invoice ON phone_lines(invoice_nb);
    CREATE INDEX IF NOT EXISTS idx_phone_lines_bundle ON phone_lines(bundle_name);
    CREATE INDEX IF NOT EXISTS idx_offices_name ON offices(name);
    CREATE INDEX IF NOT EXISTS idx_reps_name ON representatives(name);
    CREATE INDEX IF NOT EXISTS idx_reps_phone ON representatives(phone);
    CREATE INDEX IF NOT EXISTS idx_batches_created ON import_batches(created_at);
    CREATE INDEX IF NOT EXISTS idx_batches_type ON import_batches(type);
    CREATE INDEX IF NOT EXISTS idx_history_changed ON status_history(changed_at);
  `);
  try {
    database.exec(`ANALYZE`);
  } catch {
    /* ignore */
  }
}

function paginate(page, limit, maxLimit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), maxLimit);
  const safePage = Math.max(Number(page) || 1, 1);
  return {
    limit: safeLimit,
    page: safePage,
    offset: (safePage - 1) * safeLimit,
  };
}

function ensureOffice(name) {
  const database = getDb();
  const clean = String(name || '').trim();
  if (!clean) return null;

  database
    .prepare(`INSERT INTO offices (name) VALUES (?) ON CONFLICT(name) DO NOTHING`)
    .run(clean);

  return database.prepare(`SELECT id, name FROM offices WHERE name = ?`).get(clean);
}

function createBatch({ type, sourceFile }) {
  const info = getDb()
    .prepare(
      `INSERT INTO import_batches (type, source_file) VALUES (@type, @source_file)`
    )
    .run({ type, source_file: sourceFile || null });
  return Number(info.lastInsertRowid);
}

function finishBatch(batchId, stats) {
  getDb()
    .prepare(
      `UPDATE import_batches SET
        rows_read = @rows_read,
        upserted = @upserted,
        activated = @activated,
        orphans = @orphans,
        offices_touched = @offices_touched,
        notes = @notes
       WHERE id = @id`
    )
    .run({
      id: batchId,
      rows_read: stats.rows_read || 0,
      upserted: stats.upserted || 0,
      activated: stats.activated || 0,
      orphans: stats.orphans || 0,
      offices_touched: stats.offices_touched || 0,
      notes: stats.notes || null,
    });
}

function addHistory({ phone, fromStatus, toStatus, batchId, note }) {
  getDb()
    .prepare(
      `INSERT INTO status_history (phone, from_status, to_status, batch_id, note)
       VALUES (@phone, @from_status, @to_status, @batch_id, @note)`
    )
    .run({
      phone,
      from_status: fromStatus || null,
      to_status: toStatus,
      batch_id: batchId || null,
      note: note || null,
    });
}

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = Date.parse(fromDate);
  const b = Date.parse(toDate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function getLine(phone) {
  return (
    getDb()
      .prepare(
        `SELECT pl.*, o.name AS office_name
         FROM phone_lines pl
         LEFT JOIN offices o ON o.id = pl.office_id
         WHERE pl.phone = ?`
      )
      .get(phone) || null
  );
}

function upsertAssignedLine({
  phone,
  officeId,
  itemCode,
  invoiceNb,
  assignedDate,
  batchId,
}) {
  const database = getDb();
  const existing = database
    .prepare(`SELECT phone, status, office_id, activation_date FROM phone_lines WHERE phone = ?`)
    .get(phone);

  if (!existing) {
    database
      .prepare(
        `INSERT INTO phone_lines (
          phone, office_id, item_code, invoice_nb, assigned_date, status, updated_at, last_batch_id
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run(
        phone,
        officeId,
        itemCode || '',
        invoiceNb || '',
        assignedDate || null,
        STATUS.ASSIGNED,
        batchId
      );
    addHistory({
      phone,
      fromStatus: null,
      toStatus: STATUS.ASSIGNED,
      batchId,
      note: 'تجهيز للمكتب',
    });
    return { created: true, statusChanged: true };
  }

  // Keep ACTIVATED if already activated; only refresh assignment fields
  const keepActivated = existing.status === STATUS.ACTIVATED && existing.activation_date;
  const nextStatus = keepActivated ? STATUS.ACTIVATED : STATUS.ASSIGNED;

  database
    .prepare(
      `UPDATE phone_lines SET
        office_id = @office_id,
        item_code = CASE WHEN @item_code = '' THEN item_code ELSE @item_code END,
        invoice_nb = CASE WHEN @invoice_nb = '' THEN invoice_nb ELSE @invoice_nb END,
        assigned_date = COALESCE(@assigned_date, assigned_date),
        status = @status,
        days_to_activate = CASE
          WHEN activation_date IS NOT NULL AND @assigned_date IS NOT NULL
            THEN CAST(julianday(activation_date) - julianday(@assigned_date) AS INTEGER)
          ELSE days_to_activate
        END,
        updated_at = datetime('now'),
        last_batch_id = @batch_id
       WHERE phone = @phone`
    )
    .run({
      phone,
      office_id: officeId,
      item_code: itemCode || '',
      invoice_nb: invoiceNb || '',
      assigned_date: assignedDate || null,
      status: nextStatus,
      batch_id: batchId,
    });

  if (existing.status !== nextStatus) {
    addHistory({
      phone,
      fromStatus: existing.status,
      toStatus: nextStatus,
      batchId,
      note: 'تحديث تجهيز',
    });
  }

  return { created: false, statusChanged: existing.status !== nextStatus };
}

function applyAsiaActivation({
  phone,
  activationDate,
  bundleName,
  bundleRevenue,
  typeOfProd,
  dealerMsisdn,
  batchId,
}) {
  const database = getDb();
  const existing = database
    .prepare(`SELECT * FROM phone_lines WHERE phone = ?`)
    .get(phone);

  if (!existing) {
    database
      .prepare(
        `INSERT INTO phone_lines (
          phone, office_id, activation_date, status, bundle_name, bundle_revenue,
          type_of_prod, dealer_msisdn, updated_at, last_batch_id
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run(
        phone,
        activationDate || null,
        STATUS.ORPHAN_ASIA,
        bundleName || '',
        bundleRevenue || '',
        typeOfProd || '',
        dealerMsisdn || '',
        batchId
      );
    addHistory({
      phone,
      fromStatus: null,
      toStatus: STATUS.ORPHAN_ASIA,
      batchId,
      note: 'تفعيل آسيا بدون تجهيز',
    });
    return { orphan: true, activated: false };
  }

  const days = daysBetween(existing.assigned_date, activationDate);
  const fromStatus = existing.status;

  database
    .prepare(
      `UPDATE phone_lines SET
        activation_date = COALESCE(@activation_date, activation_date),
        bundle_name = CASE WHEN @bundle_name = '' THEN bundle_name ELSE @bundle_name END,
        bundle_revenue = CASE WHEN @bundle_revenue = '' THEN bundle_revenue ELSE @bundle_revenue END,
        type_of_prod = CASE WHEN @type_of_prod = '' THEN type_of_prod ELSE @type_of_prod END,
        dealer_msisdn = CASE WHEN @dealer_msisdn = '' THEN dealer_msisdn ELSE @dealer_msisdn END,
        status = @status,
        days_to_activate = @days,
        updated_at = datetime('now'),
        last_batch_id = @batch_id
       WHERE phone = @phone`
    )
    .run({
      phone,
      activation_date: activationDate || null,
      bundle_name: bundleName || '',
      bundle_revenue: bundleRevenue || '',
      type_of_prod: typeOfProd || '',
      dealer_msisdn: dealerMsisdn || '',
      status: STATUS.ACTIVATED,
      days,
      batch_id: batchId,
    });

  if (fromStatus !== STATUS.ACTIVATED) {
    addHistory({
      phone,
      fromStatus,
      toStatus: STATUS.ACTIVATED,
      batchId,
      note: 'تفعيل من ملف آسيا',
    });
  }

  return { orphan: false, activated: true, wasNewActivation: fromStatus !== STATUS.ACTIVATED };
}

function getDbStats() {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM phone_lines) AS lines,
        (SELECT COUNT(*) FROM phone_lines WHERE status = 'ASSIGNED') AS unsold,
        (SELECT COUNT(*) FROM phone_lines WHERE status = 'ACTIVATED') AS activated,
        (SELECT COUNT(*) FROM phone_lines WHERE status = 'ORPHAN_ASIA') AS orphans,
        (SELECT COUNT(*) FROM offices) AS offices,
        (SELECT COUNT(*) FROM import_batches) AS batches,
        (SELECT MAX(created_at) FROM import_batches) AS last_import_at`
    )
    .get();
  return row;
}

function listOffices({ q = '', page = 1, limit = 50 } = {}) {
  const database = getDb();
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 100);
  const params = { limit: safeLimit, offset };
  let where = '';
  if (q) {
    where = 'WHERE o.name LIKE @q';
    params.q = `%${q}%`;
  }

  const total = database
    .prepare(
      `SELECT COUNT(*) AS c FROM offices o ${where}`
    )
    .get(params).c;

  const rows = database
    .prepare(
      `SELECT
        o.id,
        o.name,
        o.phone,
        o.city,
        IFNULL(s.total, 0) AS total,
        IFNULL(s.activated, 0) AS activated,
        IFNULL(s.unsold, 0) AS unsold,
        CASE WHEN IFNULL(s.total, 0) = 0 THEN NULL
          ELSE ROUND(100.0 * IFNULL(s.activated, 0) / s.total, 1)
        END AS sell_rate,
        s.last_activation,
        s.avg_days_to_activate
       FROM offices o
       LEFT JOIN (
         SELECT
           office_id,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END) AS activated,
           SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS unsold,
           MAX(activation_date) AS last_activation,
           ROUND(AVG(CASE WHEN days_to_activate IS NOT NULL THEN days_to_activate END), 1) AS avg_days_to_activate
         FROM phone_lines
         WHERE office_id IS NOT NULL AND status != 'ORPHAN_ASIA'
         GROUP BY office_id
       ) s ON s.office_id = o.id
       ${where}
       ORDER BY total DESC, o.name ASC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    offices: rows,
  };
}

function getOffice(id) {
  const database = getDb();
  const office = database
    .prepare(`SELECT id, name, phone, city, notes, created_at FROM offices WHERE id = ?`)
    .get(id);
  if (!office) return null;

  const stats = database
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END) AS activated,
        SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS unsold,
        ROUND(
          100.0 * SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*), 0),
          1
        ) AS sell_rate,
        MAX(activation_date) AS last_activation,
        ROUND(AVG(CASE WHEN days_to_activate IS NOT NULL THEN days_to_activate END), 1) AS avg_days_to_activate
       FROM phone_lines
       WHERE office_id = ? AND status != 'ORPHAN_ASIA'`
    )
    .get(id);

  return { ...office, ...stats };
}

function listOfficeLines(officeId, { status = 'all', page = 1, limit = 50, q = '' } = {}) {
  const database = getDb();
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 200);

  const where = [`office_id = @office_id`, `status != 'ORPHAN_ASIA'`];
  const params = { office_id: officeId, limit: safeLimit, offset };

  if (status === 'unsold') where.push(`status = 'ASSIGNED'`);
  else if (status === 'activated') where.push(`status = 'ACTIVATED'`);

  if (q) {
    const digits = String(q).replace(/\D/g, '');
    if (digits && digits === String(q).trim()) {
      where.push(`phone LIKE @q`);
      params.q = `${digits}%`;
    } else {
      where.push(`(phone LIKE @q OR invoice_nb LIKE @q OR bundle_name LIKE @q)`);
      params.q = `%${q}%`;
    }
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = database
    .prepare(`SELECT COUNT(*) AS c FROM phone_lines ${whereSql}`)
    .get(params).c;

  const rows = database
    .prepare(
      `SELECT phone, item_code, invoice_nb, assigned_date, activation_date, status,
              bundle_name, type_of_prod, days_to_activate, updated_at
       FROM phone_lines
       ${whereSql}
       ORDER BY
         CASE status WHEN 'ASSIGNED' THEN 0 WHEN 'ACTIVATED' THEN 1 ELSE 2 END,
         CASE WHEN activation_date IS NULL THEN 1 ELSE 0 END,
         activation_date DESC,
         phone ASC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

function exportOfficeLines(officeId, { status = 'all' } = {}) {
  const database = getDb();
  const where = [`office_id = @office_id`, `status != 'ORPHAN_ASIA'`];
  const params = { office_id: officeId };

  if (status === 'unsold') where.push(`status = 'ASSIGNED'`);
  else if (status === 'activated') where.push(`status = 'ACTIVATED'`);

  return database
    .prepare(
      `SELECT phone, item_code, invoice_nb, assigned_date, activation_date, status,
              bundle_name, bundle_revenue, type_of_prod, dealer_msisdn, days_to_activate
       FROM phone_lines
       WHERE ${where.join(' AND ')}
       ORDER BY status ASC, phone ASC`
    )
    .all(params);
}

function getLineDetail(phone) {
  const line = getLine(phone);
  if (!line) return null;
  const history = getDb()
    .prepare(
      `SELECT from_status, to_status, changed_at, note, batch_id
       FROM status_history
       WHERE phone = ?
       ORDER BY id DESC
       LIMIT 50`
    )
    .all(phone);
  return { ...line, history };
}

function searchLines({ q = '', page = 1, limit = 50 } = {}) {
  const database = getDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const params = { q: `%${q}%`, limit: safeLimit, offset };

  const total = database
    .prepare(
      `SELECT COUNT(*) AS c
       FROM phone_lines pl
       LEFT JOIN offices o ON o.id = pl.office_id
       WHERE pl.phone LIKE @q OR IFNULL(o.name,'') LIKE @q OR pl.invoice_nb LIKE @q`
    )
    .get(params).c;

  const rows = database
    .prepare(
      `SELECT pl.phone, pl.status, pl.assigned_date, pl.activation_date, pl.days_to_activate,
              pl.bundle_name, o.name AS office_name, o.id AS office_id
       FROM phone_lines pl
       LEFT JOIN offices o ON o.id = pl.office_id
       WHERE pl.phone LIKE @q OR IFNULL(o.name,'') LIKE @q OR pl.invoice_nb LIKE @q
       ORDER BY pl.updated_at DESC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

function listBatches(limit = 20) {
  return getDb()
    .prepare(`SELECT * FROM import_batches ORDER BY id DESC LIMIT ?`)
    .all(Math.min(Number(limit) || 20, 100));
}

function listRepresentatives({ q = '', page = 1, limit = 50 } = {}) {
  const database = getDb();
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 100);
  const params = { limit: safeLimit, offset };
  let where = '';
  if (q) {
    where = `WHERE r.name LIKE @q OR r.phone LIKE @q`;
    params.q = `%${q}%`;
  }

  const total = database
    .prepare(`SELECT COUNT(*) AS c FROM representatives r ${where}`)
    .get(params).c;

  const rows = database
    .prepare(
      `SELECT
        r.id, r.name, r.phone, r.notes, r.created_at,
        IFNULL(s.lines_count, 0) AS lines_count,
        IFNULL(s.activated, 0) AS activated,
        IFNULL(s.unsold, 0) AS unsold
       FROM representatives r
       LEFT JOIN (
         SELECT
           representative_id,
           COUNT(*) AS lines_count,
           SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END) AS activated,
           SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS unsold
         FROM phone_lines
         WHERE representative_id IS NOT NULL
         GROUP BY representative_id
       ) s ON s.representative_id = r.id
       ${where}
       ORDER BY lines_count DESC, r.name ASC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    representatives: rows,
  };
}

function createRepresentative({ name, phone = '', notes = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم المندوب مطلوب');
  const info = getDb()
    .prepare(
      `INSERT INTO representatives (name, phone, notes) VALUES (?, ?, ?)`
    )
    .run(clean, String(phone || '').trim(), String(notes || '').trim());
  return getDb().prepare(`SELECT * FROM representatives WHERE id = ?`).get(info.lastInsertRowid);
}

function updateRepresentative(id, { name, phone = '', notes = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم المندوب مطلوب');
  getDb()
    .prepare(
      `UPDATE representatives SET name = ?, phone = ?, notes = ? WHERE id = ?`
    )
    .run(clean, String(phone || '').trim(), String(notes || '').trim(), id);
  return getDb().prepare(`SELECT * FROM representatives WHERE id = ?`).get(id);
}

function deleteRepresentative(id) {
  getDb().prepare(`UPDATE phone_lines SET representative_id = NULL WHERE representative_id = ?`).run(id);
  getDb().prepare(`DELETE FROM users WHERE representative_id = ?`).run(id);
  getDb().prepare(`DELETE FROM prep_requests WHERE representative_id = ?`).run(id);
  return getDb().prepare(`DELETE FROM representatives WHERE id = ?`).run(id);
}

function createPrepRequest({ representativeId, officeName, quantity, note = '' }) {
  const office = String(officeName || '').trim();
  const qty = Number(quantity);
  if (!office) throw new Error('اسم المكتب / نقطة البيع مطلوب');
  if (!Number.isFinite(qty) || qty < 1) throw new Error('الكمية يجب أن تكون رقمًا أكبر من صفر');

  const info = getDb()
    .prepare(
      `INSERT INTO prep_requests (representative_id, office_name, quantity, note)
       VALUES (?, ?, ?, ?)`
    )
    .run(representativeId, office, Math.floor(qty), String(note || '').trim());

  return getPrepRequest(info.lastInsertRowid);
}

function getPrepRequest(id) {
  return (
    getDb()
      .prepare(
        `SELECT pr.*, r.name AS representative_name, r.phone AS representative_phone
         FROM prep_requests pr
         JOIN representatives r ON r.id = pr.representative_id
         WHERE pr.id = ?`
      )
      .get(id) || null
  );
}

function listPrepRequests({
  representativeId = null,
  status = 'all',
  page = 1,
  limit = 50,
} = {}) {
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 100);
  const where = [];
  const params = { limit: safeLimit, offset };

  if (representativeId) {
    where.push(`pr.representative_id = @rep_id`);
    params.rep_id = representativeId;
  }
  if (status && status !== 'all') {
    where.push(`pr.status = @status`);
    params.status = status;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM prep_requests pr ${whereSql}`)
    .get(params).c;

  const rows = getDb()
    .prepare(
      `SELECT pr.*, r.name AS representative_name, r.phone AS representative_phone
       FROM prep_requests pr
       JOIN representatives r ON r.id = pr.representative_id
       ${whereSql}
       ORDER BY
         CASE pr.status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'FULFILLED' THEN 2 ELSE 3 END,
         pr.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

function reviewPrepRequest(id, { status, adminNote = '', reviewedBy }) {
  const allowed = ['APPROVED', 'REJECTED', 'FULFILLED', 'PENDING'];
  if (!allowed.includes(status)) throw new Error('حالة غير صالحة');
  const existing = getPrepRequest(id);
  if (!existing) throw new Error('الطلب غير موجود');

  getDb()
    .prepare(
      `UPDATE prep_requests
       SET status = ?, admin_note = ?, reviewed_at = datetime('now'), reviewed_by = ?
       WHERE id = ?`
    )
    .run(status, String(adminNote || '').trim(), reviewedBy || null, id);

  return getPrepRequest(id);
}

function assignLinesToRepresentative({ representativeId, phones }) {
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE phone_lines SET representative_id = ?, updated_at = datetime('now') WHERE phone = ?`
  );
  const run = database.transaction((list) => {
    let n = 0;
    for (const phone of list) {
      const info = stmt.run(representativeId, phone);
      n += info.changes;
    }
    return n;
  });
  return run(phones);
}

function updateOffice(id, { name, phone = '', city = '', notes = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم المكتب مطلوب');
  getDb()
    .prepare(
      `UPDATE offices SET name = ?, phone = ?, city = ?, notes = ? WHERE id = ?`
    )
    .run(clean, String(phone || '').trim(), String(city || '').trim(), String(notes || '').trim(), id);
  return getOffice(id);
}

function listAllLines({
  q = '',
  status = 'all',
  officeId = '',
  page = 1,
  limit = 50,
} = {}) {
  const database = getDb();
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 200);
  const where = [];
  const params = { limit: safeLimit, offset };

  if (status === 'unsold') where.push(`pl.status = 'ASSIGNED'`);
  else if (status === 'activated') where.push(`pl.status = 'ACTIVATED'`);
  else if (status === 'orphan') where.push(`pl.status = 'ORPHAN_ASIA'`);

  if (officeId) {
    where.push(`pl.office_id = @office_id`);
    params.office_id = Number(officeId);
  }
  if (q) {
    const trimmed = String(q).trim();
    const digits = trimmed.replace(/\D/g, '');
    if (digits && digits === trimmed) {
      // prefix search uses phone PK efficiently
      where.push(`pl.phone LIKE @q`);
      params.q = `${digits}%`;
    } else {
      where.push(
        `(pl.phone LIKE @q OR IFNULL(o.name,'') LIKE @q OR IFNULL(r.name,'') LIKE @q OR pl.invoice_nb LIKE @q)`
      );
      params.q = `%${trimmed}%`;
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = database
    .prepare(
      `SELECT COUNT(*) AS c
       FROM phone_lines pl
       LEFT JOIN offices o ON o.id = pl.office_id
       LEFT JOIN representatives r ON r.id = pl.representative_id
       ${whereSql}`
    )
    .get(params).c;

  const rows = database
    .prepare(
      `SELECT pl.phone, pl.status, pl.assigned_date, pl.activation_date, pl.days_to_activate,
              pl.item_code, pl.invoice_nb, pl.bundle_name,
              o.id AS office_id, o.name AS office_name,
              r.id AS representative_id, r.name AS representative_name
       FROM phone_lines pl
       LEFT JOIN offices o ON o.id = pl.office_id
       LEFT JOIN representatives r ON r.id = pl.representative_id
       ${whereSql}
       ORDER BY pl.updated_at DESC, pl.phone ASC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  STATUS,
  DB_PATH,
  getDb,
  ensureOffice,
  createBatch,
  finishBatch,
  upsertAssignedLine,
  applyAsiaActivation,
  getDbStats,
  listOffices,
  getOffice,
  listOfficeLines,
  exportOfficeLines,
  getLineDetail,
  searchLines,
  listBatches,
  listRepresentatives,
  createRepresentative,
  updateRepresentative,
  deleteRepresentative,
  assignLinesToRepresentative,
  updateOffice,
  listAllLines,
  createPrepRequest,
  getPrepRequest,
  listPrepRequests,
  reviewPrepRequest,
  daysBetween,
  closeDb,
};
