const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { importPrepFile } = require('./importPrep');
const { importAsiaFile } = require('./importAsia');
const {
  getDb,
  DB_PATH,
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
  updateOffice,
  listAllLines,
  createPrepRequest,
  listPrepRequests,
  reviewPrepRequest,
} = require('./db');
const { normalizePhone } = require('./phone');
const {
  startProgress,
  updateProgress,
  finishProgress,
  failProgress,
  getProgress,
} = require('./progress');
const {
  ensureDefaultAdmin,
  login,
  logout,
  requireAuth,
  createUserForRepresentative,
  DEFAULT_ADMIN,
} = require('./auth');

const ROOT = path.join(__dirname, '..');
const UPLOADS = path.join(ROOT, 'uploads');
const PUBLIC = path.join(ROOT, 'public');

const LOCAL_PREP = path.join(ROOT, 'تجهيز كامل.xlsx');
const LOCAL_ASIA = path.join(
  ROOT,
  'QualityActivationBundleReport_U3632_R10201_085926_20260905.csv'
);

for (const dir of [UPLOADS]) fs.mkdirSync(dir, { recursive: true });
getDb();
const adminSeed = ensureDefaultAdmin();
if (adminSeed.created) {
  console.log(`Default admin created → username: ${DEFAULT_ADMIN.username} / password: ${DEFAULT_ADMIN.password}`);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\u0600-\u06FF-]+/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 },
});

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(PUBLIC));

const adminOnly = requireAuth(['admin']);
const anyUser = requireAuth(['admin', 'rep']);

function setSessionCookie(res, token) {
  res.cookie('asiepay_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

app.post('/api/auth/login', (req, res) => {
  try {
    const result = login(req.body?.username, req.body?.password);
    if (result.error) return res.status(401).json({ error: result.error });
    setSessionCookie(res, result.token);
    res.json({ user: result.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  logout(req.cookies?.asiepay_session);
  res.clearCookie('asiepay_session');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const { getSessionUser } = require('./auth');
  const user = getSessionUser(req.cookies?.asiepay_session);
  if (!user) return res.status(401).json({ error: 'غير مسجل' });
  res.json({ user });
});

app.get('/api/local-files', anyUser, (_req, res) => {
  res.json({
    prep: fs.existsSync(LOCAL_PREP) ? path.basename(LOCAL_PREP) : null,
    asia: fs.existsSync(LOCAL_ASIA) ? path.basename(LOCAL_ASIA) : null,
  });
});

app.get('/api/db/stats', anyUser, (_req, res) => {
  try {
    res.json(getDbStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/db/batches', adminOnly, (req, res) => {
  try {
    res.json({ batches: listBatches(req.query.limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/offices', anyUser, (req, res) => {
  try {
    res.json(
      listOffices({
        q: req.query.q || '',
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/offices/:id', adminOnly, (req, res) => {
  try {
    const office = updateOffice(Number(req.params.id), req.body || {});
    if (!office) return res.status(404).json({ error: 'المكتب غير موجود' });
    res.json(office);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/representatives', adminOnly, (req, res) => {
  try {
    res.json(
      listRepresentatives({
        q: req.query.q || '',
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/representatives', adminOnly, (req, res) => {
  try {
    const body = req.body || {};
    const row = createRepresentative(body);
    let loginUser = null;
    if (body.username && body.password) {
      loginUser = createUserForRepresentative({
        representativeId: row.id,
        username: body.username,
        password: body.password,
      });
    }
    res.status(201).json({
      ...row,
      login: loginUser
        ? { username: loginUser.username, role: loginUser.role }
        : null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/representatives/:id', adminOnly, (req, res) => {
  try {
    const row = updateRepresentative(Number(req.params.id), req.body || {});
    if (!row) return res.status(404).json({ error: 'المندوب غير موجود' });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/representatives/:id', adminOnly, (req, res) => {
  try {
    deleteRepresentative(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/numbers', anyUser, (req, res) => {
  try {
    res.json(
      listAllLines({
        q: req.query.q || '',
        status: req.query.status || 'all',
        officeId: req.query.officeId || '',
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prep-requests', anyUser, (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    res.json(
      listPrepRequests({
        representativeId: isAdmin ? null : req.user.representative_id,
        status: req.query.status || 'all',
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prep-requests', anyUser, (req, res) => {
  try {
    if (req.user.role !== 'rep' || !req.user.representative_id) {
      return res.status(403).json({ error: 'طلبات التجهيز للمندوبين فقط' });
    }
    const row = createPrepRequest({
      representativeId: req.user.representative_id,
      officeName: req.body?.office_name || req.body?.officeName,
      quantity: req.body?.quantity,
      note: req.body?.note,
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/prep-requests/:id', adminOnly, (req, res) => {
  try {
    const row = reviewPrepRequest(Number(req.params.id), {
      status: req.body?.status,
      adminNote: req.body?.admin_note || req.body?.adminNote,
      reviewedBy: req.user.id,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/offices/:id', anyUser, (req, res) => {
  try {
    const office = getOffice(Number(req.params.id));
    if (!office) return res.status(404).json({ error: 'المكتب غير موجود' });
    res.json(office);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/offices/:id/lines', anyUser, (req, res) => {
  try {
    const office = getOffice(Number(req.params.id));
    if (!office) return res.status(404).json({ error: 'المكتب غير موجود' });
    const result = listOfficeLines(Number(req.params.id), {
      status: req.query.status || 'all',
      page: req.query.page,
      limit: req.query.limit,
      q: req.query.q || '',
    });
    res.json({ office, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/offices/:id/export.csv', anyUser, (req, res) => {
  try {
    const office = getOffice(Number(req.params.id));
    if (!office) return res.status(404).json({ error: 'المكتب غير موجود' });

    const status = req.query.status || 'all';
    const rows = exportOfficeLines(Number(req.params.id), { status });
    const header = [
      'phone',
      'status',
      'assigned_date',
      'activation_date',
      'days_to_activate',
      'item_code',
      'invoice_nb',
      'bundle_name',
      'bundle_revenue',
      'type_of_prod',
      'dealer_msisdn',
      'office',
    ];

    const escape = (v) => {
      const s = v == null ? '' : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.phone,
          row.status,
          row.assigned_date,
          row.activation_date,
          row.days_to_activate,
          row.item_code,
          row.invoice_nb,
          row.bundle_name,
          row.bundle_revenue,
          row.type_of_prod,
          row.dealer_msisdn,
          office.name,
        ]
          .map(escape)
          .join(',')
      );
    }

    const safeName = `office_${office.id}_${status}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
    res.send(`\uFEFF${lines.join('\n')}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lines/search', anyUser, (req, res) => {
  try {
    res.json(
      searchLines({
        q: req.query.q || '',
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lines/:phone', anyUser, (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const line = getLineDetail(phone);
    if (!line) return res.status(404).json({ error: 'الخط غير موجود' });
    res.json(line);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/import/progress', adminOnly, (_req, res) => {
  res.json(getProgress());
});

app.post('/api/import/prep', adminOnly, upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file?.path || (req.body.useLocal === '1' ? LOCAL_PREP : null);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(400).json({ error: 'ملف التجهيز غير موجود' });
    }
    startProgress(
      'prep',
      'قراءة ملف التجهيز وربط كل رقم بمكتبه (~900 ألف سطر، قد يستغرق 1–2 دقيقة)'
    );
    const result = await importPrepFile(filePath, {
      onProgress: (p) => {
        updateProgress({
          stage: 'prep',
          upserted: p.upserted || 0,
          offices: p.offices || 0,
          message: `تجهيز: تم ربط ${Number(p.upserted || 0).toLocaleString('en-US')} خط · ${Number(p.offices || 0).toLocaleString('en-US')} مكتب`,
        });
        console.log('[prep]', p);
      },
    });
    finishProgress(
      `اكتمل التجهيز: ${Number(result.upserted).toLocaleString('en-US')} خط`
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    failProgress(err.message || 'فشل استيراد التجهيز');
    res.status(500).json({ error: err.message || 'فشل استيراد التجهيز' });
  }
});

app.post('/api/import/prep-local', adminOnly, async (_req, res) => {
  try {
    if (!fs.existsSync(LOCAL_PREP)) {
      return res.status(400).json({ error: 'ملف التجهيز المحلي غير موجود' });
    }
    startProgress(
      'prep',
      'قراءة ملف التجهيز المحلي وربط كل رقم بمكتبه (~900 ألف سطر، قد يستغرق 1–2 دقيقة)'
    );
    const result = await importPrepFile(LOCAL_PREP, {
      onProgress: (p) => {
        updateProgress({
          stage: 'prep',
          upserted: p.upserted || 0,
          offices: p.offices || 0,
          message: `تجهيز: تم ربط ${Number(p.upserted || 0).toLocaleString('en-US')} خط · ${Number(p.offices || 0).toLocaleString('en-US')} مكتب`,
        });
        console.log('[prep]', p);
      },
    });
    finishProgress(
      `اكتمل التجهيز: ${Number(result.upserted).toLocaleString('en-US')} خط`
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    failProgress(err.message || 'فشل استيراد التجهيز');
    res.status(500).json({ error: err.message || 'فشل استيراد التجهيز' });
  }
});

app.post('/api/import/asia', adminOnly, upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file?.path || (req.body.useLocal === '1' ? LOCAL_ASIA : null);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(400).json({ error: 'ملف آسيا غير موجود' });
    }
    startProgress('asia', 'مطابقة أرقام آسيا مع الخطوط المسلَّمة للمكاتب');
    const result = await importAsiaFile(filePath, {
      onProgress: (p) => {
        updateProgress({
          stage: 'asia',
          upserted: p.upserted || 0,
          activated: p.activated || 0,
          orphans: p.orphans || 0,
          message: `آسيا: ${Number(p.activated || 0).toLocaleString('en-US')} تفعيل · ${Number(p.orphans || 0).toLocaleString('en-US')} بلا تجهيز`,
        });
        console.log('[asia]', p);
      },
    });
    finishProgress(
      `اكتملت مطابقة آسيا: ${Number(result.activated).toLocaleString('en-US')} تفعيل`
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    failProgress(err.message || 'فشل استيراد آسيا');
    res.status(500).json({ error: err.message || 'فشل استيراد آسيا' });
  }
});

app.post('/api/import/asia-local', adminOnly, async (_req, res) => {
  try {
    if (!fs.existsSync(LOCAL_ASIA)) {
      return res.status(400).json({ error: 'ملف آسيا المحلي غير موجود' });
    }
    startProgress('asia', 'مطابقة ملف آسيا المحلي مع الخطوط (~6 آلاف سطر)');
    const result = await importAsiaFile(LOCAL_ASIA, {
      onProgress: (p) => {
        updateProgress({
          stage: 'asia',
          upserted: p.upserted || 0,
          activated: p.activated || 0,
          orphans: p.orphans || 0,
          message: `آسيا: ${Number(p.activated || 0).toLocaleString('en-US')} تفعيل · ${Number(p.orphans || 0).toLocaleString('en-US')} بلا تجهيز`,
        });
        console.log('[asia]', p);
      },
    });
    finishProgress(
      `اكتملت مطابقة آسيا: ${Number(result.activated).toLocaleString('en-US')} تفعيل`
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    failProgress(err.message || 'فشل استيراد آسيا');
    res.status(500).json({ error: err.message || 'فشل استيراد آسيا' });
  }
});

const PORT = process.env.PORT || 3847;
app.listen(PORT, () => {
  console.log(`AsiePay Office Tracker on http://localhost:${PORT}`);
  console.log(`SQLite: ${DB_PATH}`);
});
