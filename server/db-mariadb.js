require('dotenv').config();
const mysql = require('mysql2/promise');

const STATUS = {
  ASSIGNED: 'ASSIGNED',
  ACTIVATED: 'ACTIVATED',
  ORPHAN_ASIA: 'ORPHAN_ASIA',
};

const DB_PATH = `${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'htadaorg_asia'}`;

let pool;

function poolConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'htadaorg_asia',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'htadaorg_asia',
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
    charset: 'utf8mb4',
    timezone: 'Z',
  };
}

async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool(poolConfig());
  await migrate();
  return pool;
}

async function getDb() {
  return getPool();
}

async function query(sql, params = {}) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = {}) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS offices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(64) NOT NULL DEFAULT '',
      city VARCHAR(128) NOT NULL DEFAULT '',
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_offices_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS representatives (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(64) NOT NULL DEFAULT '',
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reps_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS import_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('prep','asia') NOT NULL,
      source_file VARCHAR(512) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rows_read INT NOT NULL DEFAULT 0,
      upserted INT NOT NULL DEFAULT 0,
      activated INT NOT NULL DEFAULT 0,
      orphans INT NOT NULL DEFAULT 0,
      offices_touched INT NOT NULL DEFAULT 0,
      notes TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS phone_lines (
      phone VARCHAR(20) NOT NULL PRIMARY KEY,
      office_id INT NULL,
      representative_id INT NULL,
      item_code VARCHAR(128) NOT NULL DEFAULT '',
      invoice_nb VARCHAR(128) NOT NULL DEFAULT '',
      assigned_date DATE NULL,
      activation_date DATE NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'ASSIGNED',
      bundle_name VARCHAR(255) NOT NULL DEFAULT '',
      bundle_revenue VARCHAR(64) NOT NULL DEFAULT '',
      type_of_prod VARCHAR(128) NOT NULL DEFAULT '',
      dealer_msisdn VARCHAR(32) NOT NULL DEFAULT '',
      days_to_activate INT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_batch_id INT NULL,
      KEY idx_phone_lines_office (office_id),
      KEY idx_phone_lines_status (status),
      KEY idx_phone_lines_activation (activation_date),
      KEY idx_phone_lines_rep (representative_id),
      KEY idx_phone_lines_office_status (office_id, status),
      KEY idx_phone_lines_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS status_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      from_status VARCHAR(32) NULL,
      to_status VARCHAR(32) NOT NULL,
      changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      batch_id INT NULL,
      note VARCHAR(255) NULL,
      KEY idx_status_history_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(128) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','rep') NOT NULL,
      representative_id INT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_users_username (username),
      KEY idx_users_rep (representative_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(128) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_sessions_user (user_id),
      KEY idx_sessions_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS prep_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      representative_id INT NOT NULL,
      office_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL,
      note TEXT,
      status ENUM('PENDING','APPROVED','REJECTED','FULFILLED') NOT NULL DEFAULT 'PENDING',
      admin_note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME NULL,
      reviewed_by INT NULL,
      KEY idx_prep_requests_rep (representative_id),
      KEY idx_prep_requests_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of statements) {
    await pool.execute(sql);
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

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = Date.parse(fromDate);
  const b = Date.parse(toDate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

async function ensureOffice(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  await query(`INSERT IGNORE INTO offices (name) VALUES (:name)`, { name: clean });
  return queryOne(`SELECT id, name FROM offices WHERE name = :name`, { name: clean });
}

async function createBatch({ type, sourceFile }) {
  const p = await getPool();
  const [result] = await p.execute(
    `INSERT INTO import_batches (type, source_file) VALUES (:type, :source_file)`,
    { type, source_file: sourceFile || null }
  );
  return Number(result.insertId);
}

async function finishBatch(batchId, stats) {
  await query(
    `UPDATE import_batches SET
      rows_read = :rows_read, upserted = :upserted, activated = :activated,
      orphans = :orphans, offices_touched = :offices_touched, notes = :notes
     WHERE id = :id`,
    {
      id: batchId,
      rows_read: stats.rows_read || 0,
      upserted: stats.upserted || 0,
      activated: stats.activated || 0,
      orphans: stats.orphans || 0,
      offices_touched: stats.offices_touched || 0,
      notes: stats.notes || null,
    }
  );
}

async function addHistory({ phone, fromStatus, toStatus, batchId, note }) {
  await query(
    `INSERT INTO status_history (phone, from_status, to_status, batch_id, note)
     VALUES (:phone, :from_status, :to_status, :batch_id, :note)`,
    {
      phone,
      from_status: fromStatus || null,
      to_status: toStatus,
      batch_id: batchId || null,
      note: note || null,
    }
  );
}

async function getLine(phone) {
  return queryOne(
    `SELECT pl.*, o.name AS office_name
     FROM phone_lines pl
     LEFT JOIN offices o ON o.id = pl.office_id
     WHERE pl.phone = :phone`,
    { phone }
  );
}

async function upsertAssignedLine({
  phone,
  officeId,
  itemCode,
  invoiceNb,
  assignedDate,
  batchId,
}) {
  const existing = await queryOne(
    `SELECT phone, status, office_id, activation_date FROM phone_lines WHERE phone = :phone`,
    { phone }
  );

  if (!existing) {
    await query(
      `INSERT INTO phone_lines (
        phone, office_id, item_code, invoice_nb, assigned_date, status, last_batch_id
      ) VALUES (
        :phone, :office_id, :item_code, :invoice_nb, :assigned_date, :status, :batch_id
      )`,
      {
        phone,
        office_id: officeId,
        item_code: itemCode || '',
        invoice_nb: invoiceNb || '',
        assigned_date: assignedDate || null,
        status: STATUS.ASSIGNED,
        batch_id: batchId,
      }
    );
    await addHistory({
      phone,
      fromStatus: null,
      toStatus: STATUS.ASSIGNED,
      batchId,
      note: 'تجهيز للمكتب',
    });
    return { created: true, statusChanged: true };
  }

  const keepActivated = existing.status === STATUS.ACTIVATED && existing.activation_date;
  const nextStatus = keepActivated ? STATUS.ACTIVATED : STATUS.ASSIGNED;

  await query(
    `UPDATE phone_lines SET
      office_id = :office_id,
      item_code = CASE WHEN :item_code = '' THEN item_code ELSE :item_code END,
      invoice_nb = CASE WHEN :invoice_nb = '' THEN invoice_nb ELSE :invoice_nb END,
      assigned_date = COALESCE(:assigned_date, assigned_date),
      status = :status,
      days_to_activate = CASE
        WHEN activation_date IS NOT NULL AND :assigned_date IS NOT NULL
          THEN DATEDIFF(activation_date, :assigned_date)
        ELSE days_to_activate
      END,
      last_batch_id = :batch_id
     WHERE phone = :phone`,
    {
      phone,
      office_id: officeId,
      item_code: itemCode || '',
      invoice_nb: invoiceNb || '',
      assigned_date: assignedDate || null,
      status: nextStatus,
      batch_id: batchId,
    }
  );

  if (existing.status !== nextStatus) {
    await addHistory({
      phone,
      fromStatus: existing.status,
      toStatus: nextStatus,
      batchId,
      note: 'تحديث تجهيز',
    });
  }

  return { created: false, statusChanged: existing.status !== nextStatus };
}

async function applyAsiaActivation({
  phone,
  activationDate,
  bundleName,
  bundleRevenue,
  typeOfProd,
  dealerMsisdn,
  batchId,
}) {
  const existing = await queryOne(`SELECT * FROM phone_lines WHERE phone = :phone`, { phone });

  if (!existing) {
    await query(
      `INSERT INTO phone_lines (
        phone, office_id, activation_date, status, bundle_name, bundle_revenue,
        type_of_prod, dealer_msisdn, last_batch_id
      ) VALUES (
        :phone, NULL, :activation_date, :status, :bundle_name, :bundle_revenue,
        :type_of_prod, :dealer_msisdn, :batch_id
      )`,
      {
        phone,
        activation_date: activationDate || null,
        status: STATUS.ORPHAN_ASIA,
        bundle_name: bundleName || '',
        bundle_revenue: bundleRevenue || '',
        type_of_prod: typeOfProd || '',
        dealer_msisdn: dealerMsisdn || '',
        batch_id: batchId,
      }
    );
    await addHistory({
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

  await query(
    `UPDATE phone_lines SET
      activation_date = COALESCE(:activation_date, activation_date),
      bundle_name = CASE WHEN :bundle_name = '' THEN bundle_name ELSE :bundle_name END,
      bundle_revenue = CASE WHEN :bundle_revenue = '' THEN bundle_revenue ELSE :bundle_revenue END,
      type_of_prod = CASE WHEN :type_of_prod = '' THEN type_of_prod ELSE :type_of_prod END,
      dealer_msisdn = CASE WHEN :dealer_msisdn = '' THEN dealer_msisdn ELSE :dealer_msisdn END,
      status = :status,
      days_to_activate = :days,
      last_batch_id = :batch_id
     WHERE phone = :phone`,
    {
      phone,
      activation_date: activationDate || null,
      bundle_name: bundleName || '',
      bundle_revenue: bundleRevenue || '',
      type_of_prod: typeOfProd || '',
      dealer_msisdn: dealerMsisdn || '',
      status: STATUS.ACTIVATED,
      days,
      batch_id: batchId,
    }
  );

  if (fromStatus !== STATUS.ACTIVATED) {
    await addHistory({
      phone,
      fromStatus,
      toStatus: STATUS.ACTIVATED,
      batchId,
      note: 'تفعيل من ملف آسيا',
    });
  }

  return { orphan: false, activated: true, wasNewActivation: fromStatus !== STATUS.ACTIVATED };
}

async function getDbStats() {
  return queryOne(
    `SELECT
      (SELECT COUNT(*) FROM phone_lines) AS \`lines\`,
      (SELECT COUNT(*) FROM phone_lines WHERE status = 'ASSIGNED') AS unsold,
      (SELECT COUNT(*) FROM phone_lines WHERE status = 'ACTIVATED') AS activated,
      (SELECT COUNT(*) FROM phone_lines WHERE status = 'ORPHAN_ASIA') AS orphans,
      (SELECT COUNT(*) FROM offices) AS offices,
      (SELECT COUNT(*) FROM import_batches) AS batches,
      (SELECT MAX(created_at) FROM import_batches) AS last_import_at`
  );
}

async function listOffices({ q = '', page = 1, limit = 50 } = {}) {
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 100);
  const params = { limit: safeLimit, offset };
  let where = '';
  if (q) {
    where = 'WHERE o.name LIKE :q';
    params.q = `%${q}%`;
  }

  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM offices o ${where}`, params);
  const total = Number(totalRow?.c || 0);

  const rows = await query(
    `SELECT
      o.id, o.name, o.phone, o.city,
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
     LIMIT :limit OFFSET :offset`,
    params
  );

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    offices: rows,
  };
}

async function getOffice(id) {
  const office = await queryOne(
    `SELECT id, name, phone, city, notes, created_at FROM offices WHERE id = :id`,
    { id }
  );
  if (!office) return null;

  const stats = await queryOne(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END) AS activated,
      SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS unsold,
      ROUND(
        100.0 * SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 1
      ) AS sell_rate,
      MAX(activation_date) AS last_activation,
      ROUND(AVG(CASE WHEN days_to_activate IS NOT NULL THEN days_to_activate END), 1) AS avg_days_to_activate
     FROM phone_lines
     WHERE office_id = :id AND status != 'ORPHAN_ASIA'`,
    { id }
  );

  return { ...office, ...stats };
}

async function listOfficeLines(officeId, { status = 'all', page = 1, limit = 50, q = '' } = {}) {
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 200);
  const where = [`office_id = :office_id`, `status != 'ORPHAN_ASIA'`];
  const params = { office_id: officeId, limit: safeLimit, offset };

  if (status === 'unsold') where.push(`status = 'ASSIGNED'`);
  else if (status === 'activated') where.push(`status = 'ACTIVATED'`);

  if (q) {
    const digits = String(q).replace(/\D/g, '');
    if (digits && digits === String(q).trim()) {
      where.push(`phone LIKE :q`);
      params.q = `${digits}%`;
    } else {
      where.push(`(phone LIKE :q OR invoice_nb LIKE :q OR bundle_name LIKE :q)`);
      params.q = `%${q}%`;
    }
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = Number((await queryOne(`SELECT COUNT(*) AS c FROM phone_lines ${whereSql}`, params)).c);

  const rows = await query(
    `SELECT phone, item_code, invoice_nb, assigned_date, activation_date, status,
            bundle_name, type_of_prod, days_to_activate, updated_at
     FROM phone_lines
     ${whereSql}
     ORDER BY
       CASE status WHEN 'ASSIGNED' THEN 0 WHEN 'ACTIVATED' THEN 1 ELSE 2 END,
       CASE WHEN activation_date IS NULL THEN 1 ELSE 0 END,
       activation_date DESC,
       phone ASC
     LIMIT :limit OFFSET :offset`,
    params
  );

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

async function exportOfficeLines(officeId, { status = 'all' } = {}) {
  const where = [`office_id = :office_id`, `status != 'ORPHAN_ASIA'`];
  const params = { office_id: officeId };
  if (status === 'unsold') where.push(`status = 'ASSIGNED'`);
  else if (status === 'activated') where.push(`status = 'ACTIVATED'`);

  return query(
    `SELECT phone, item_code, invoice_nb, assigned_date, activation_date, status,
            bundle_name, bundle_revenue, type_of_prod, dealer_msisdn, days_to_activate
     FROM phone_lines
     WHERE ${where.join(' AND ')}
     ORDER BY status ASC, phone ASC`,
    params
  );
}

async function getLineDetail(phone) {
  const line = await getLine(phone);
  if (!line) return null;
  const history = await query(
    `SELECT from_status, to_status, changed_at, note, batch_id
     FROM status_history WHERE phone = :phone ORDER BY id DESC LIMIT 50`,
    { phone }
  );
  return { ...line, history };
}

async function searchLines({ q = '', page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const params = { q: `%${q}%`, limit: safeLimit, offset };

  const total = Number(
    (
      await queryOne(
        `SELECT COUNT(*) AS c FROM phone_lines pl
         LEFT JOIN offices o ON o.id = pl.office_id
         WHERE pl.phone LIKE :q OR IFNULL(o.name,'') LIKE :q OR pl.invoice_nb LIKE :q`,
        params
      )
    ).c
  );

  const rows = await query(
    `SELECT pl.phone, pl.status, pl.assigned_date, pl.activation_date, pl.days_to_activate,
            pl.bundle_name, o.name AS office_name, o.id AS office_id
     FROM phone_lines pl
     LEFT JOIN offices o ON o.id = pl.office_id
     WHERE pl.phone LIKE :q OR IFNULL(o.name,'') LIKE :q OR pl.invoice_nb LIKE :q
     ORDER BY pl.updated_at DESC
     LIMIT :limit OFFSET :offset`,
    params
  );

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

async function listBatches(limit = 20) {
  return query(`SELECT * FROM import_batches ORDER BY id DESC LIMIT :limit`, {
    limit: Math.min(Number(limit) || 20, 100),
  });
}

async function listRepresentatives({ q = '', page = 1, limit = 50 } = {}) {
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 100);
  const params = { limit: safeLimit, offset };
  let where = '';
  if (q) {
    where = `WHERE r.name LIKE :q OR r.phone LIKE :q`;
    params.q = `%${q}%`;
  }

  const total = Number((await queryOne(`SELECT COUNT(*) AS c FROM representatives r ${where}`, params)).c);

  const rows = await query(
    `SELECT
      r.id, r.name, r.phone, r.notes, r.created_at,
      IFNULL(s.lines_count, 0) AS lines_count,
      IFNULL(s.activated, 0) AS activated,
      IFNULL(s.unsold, 0) AS unsold
     FROM representatives r
     LEFT JOIN (
       SELECT representative_id,
         COUNT(*) AS lines_count,
         SUM(CASE WHEN status = 'ACTIVATED' THEN 1 ELSE 0 END) AS activated,
         SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS unsold
       FROM phone_lines WHERE representative_id IS NOT NULL
       GROUP BY representative_id
     ) s ON s.representative_id = r.id
     ${where}
     ORDER BY lines_count DESC, r.name ASC
     LIMIT :limit OFFSET :offset`,
    params
  );

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    representatives: rows,
  };
}

async function createRepresentative({ name, phone = '', notes = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم المندوب مطلوب');
  const p = await getPool();
  const [result] = await p.execute(
    `INSERT INTO representatives (name, phone, notes) VALUES (:name, :phone, :notes)`,
    { name: clean, phone: String(phone || '').trim(), notes: String(notes || '').trim() }
  );
  return queryOne(`SELECT * FROM representatives WHERE id = :id`, { id: result.insertId });
}

async function updateRepresentative(id, { name, phone = '', notes = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم المندوب مطلوب');
  await query(
    `UPDATE representatives SET name = :name, phone = :phone, notes = :notes WHERE id = :id`,
    { id, name: clean, phone: String(phone || '').trim(), notes: String(notes || '').trim() }
  );
  return queryOne(`SELECT * FROM representatives WHERE id = :id`, { id });
}

async function deleteRepresentative(id) {
  await query(`UPDATE phone_lines SET representative_id = NULL WHERE representative_id = :id`, { id });
  await query(`DELETE FROM users WHERE representative_id = :id`, { id });
  await query(`DELETE FROM prep_requests WHERE representative_id = :id`, { id });
  return query(`DELETE FROM representatives WHERE id = :id`, { id });
}

async function createPrepRequest({ representativeId, officeName, quantity, note = '' }) {
  const office = String(officeName || '').trim();
  const qty = Number(quantity);
  if (!office) throw new Error('اسم المكتب / نقطة البيع مطلوب');
  if (!Number.isFinite(qty) || qty < 1) throw new Error('الكمية يجب أن تكون رقمًا أكبر من صفر');

  const p = await getPool();
  const [result] = await p.execute(
    `INSERT INTO prep_requests (representative_id, office_name, quantity, note)
     VALUES (:representative_id, :office_name, :quantity, :note)`,
    {
      representative_id: representativeId,
      office_name: office,
      quantity: Math.floor(qty),
      note: String(note || '').trim(),
    }
  );
  return getPrepRequest(result.insertId);
}

async function getPrepRequest(id) {
  return queryOne(
    `SELECT pr.*, r.name AS representative_name, r.phone AS representative_phone
     FROM prep_requests pr
     JOIN representatives r ON r.id = pr.representative_id
     WHERE pr.id = :id`,
    { id }
  );
}

async function listPrepRequests({
  representativeId = null,
  status = 'all',
  page = 1,
  limit = 50,
} = {}) {
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 100);
  const where = [];
  const params = { limit: safeLimit, offset };

  if (representativeId) {
    where.push(`pr.representative_id = :rep_id`);
    params.rep_id = representativeId;
  }
  if (status && status !== 'all') {
    where.push(`pr.status = :status`);
    params.status = status;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (await queryOne(`SELECT COUNT(*) AS c FROM prep_requests pr ${whereSql}`, params)).c
  );

  const rows = await query(
    `SELECT pr.*, r.name AS representative_name, r.phone AS representative_phone
     FROM prep_requests pr
     JOIN representatives r ON r.id = pr.representative_id
     ${whereSql}
     ORDER BY
       CASE pr.status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'FULFILLED' THEN 2 ELSE 3 END,
       pr.id DESC
     LIMIT :limit OFFSET :offset`,
    params
  );

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

async function reviewPrepRequest(id, { status, adminNote = '', reviewedBy }) {
  const allowed = ['APPROVED', 'REJECTED', 'FULFILLED', 'PENDING'];
  if (!allowed.includes(status)) throw new Error('حالة غير صالحة');
  const existing = await getPrepRequest(id);
  if (!existing) throw new Error('الطلب غير موجود');

  await query(
    `UPDATE prep_requests
     SET status = :status, admin_note = :admin_note, reviewed_at = NOW(), reviewed_by = :reviewed_by
     WHERE id = :id`,
    {
      id,
      status,
      admin_note: String(adminNote || '').trim(),
      reviewed_by: reviewedBy || null,
    }
  );
  return getPrepRequest(id);
}

async function assignLinesToRepresentative({ representativeId, phones }) {
  const p = await getPool();
  const conn = await p.getConnection();
  let n = 0;
  try {
    await conn.beginTransaction();
    for (const phone of phones) {
      const [result] = await conn.execute(
        `UPDATE phone_lines SET representative_id = :rep_id WHERE phone = :phone`,
        { rep_id: representativeId, phone }
      );
      n += result.affectedRows;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return n;
}

async function updateOffice(id, { name, phone = '', city = '', notes = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('اسم المكتب مطلوب');
  await query(
    `UPDATE offices SET name = :name, phone = :phone, city = :city, notes = :notes WHERE id = :id`,
    {
      id,
      name: clean,
      phone: String(phone || '').trim(),
      city: String(city || '').trim(),
      notes: String(notes || '').trim(),
    }
  );
  return getOffice(id);
}

async function listAllLines({
  q = '',
  status = 'all',
  officeId = '',
  page = 1,
  limit = 50,
} = {}) {
  const { page: safePage, limit: safeLimit, offset } = paginate(page, limit, 200);
  const where = [];
  const params = { limit: safeLimit, offset };

  if (status === 'unsold') where.push(`pl.status = 'ASSIGNED'`);
  else if (status === 'activated') where.push(`pl.status = 'ACTIVATED'`);
  else if (status === 'orphan') where.push(`pl.status = 'ORPHAN_ASIA'`);

  if (officeId) {
    where.push(`pl.office_id = :office_id`);
    params.office_id = Number(officeId);
  }
  if (q) {
    const trimmed = String(q).trim();
    const digits = trimmed.replace(/\D/g, '');
    if (digits && digits === trimmed) {
      where.push(`pl.phone LIKE :q`);
      params.q = `${digits}%`;
    } else {
      where.push(
        `(pl.phone LIKE :q OR IFNULL(o.name,'') LIKE :q OR IFNULL(r.name,'') LIKE :q OR pl.invoice_nb LIKE :q)`
      );
      params.q = `%${trimmed}%`;
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (
      await queryOne(
        `SELECT COUNT(*) AS c
         FROM phone_lines pl
         LEFT JOIN offices o ON o.id = pl.office_id
         LEFT JOIN representatives r ON r.id = pl.representative_id
         ${whereSql}`,
        params
      )
    ).c
  );

  const rows = await query(
    `SELECT pl.phone, pl.status, pl.assigned_date, pl.activation_date, pl.days_to_activate,
            pl.item_code, pl.invoice_nb, pl.bundle_name,
            o.id AS office_id, o.name AS office_name,
            r.id AS representative_id, r.name AS representative_name
     FROM phone_lines pl
     LEFT JOIN offices o ON o.id = pl.office_id
     LEFT JOIN representatives r ON r.id = pl.representative_id
     ${whereSql}
     ORDER BY pl.updated_at DESC, pl.phone ASC
     LIMIT :limit OFFSET :offset`,
    params
  );

  return {
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    rows,
  };
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  STATUS,
  DB_PATH,
  getDb,
  getPool,
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
  query,
  queryOne,
};
