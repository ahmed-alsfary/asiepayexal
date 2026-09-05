const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers || {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    showLogin();
    throw new Error(data?.error || "يجب تسجيل الدخول");
  }
  return { res, data };
}

const statusEl = $("status");
const globalStats = $("globalStats");
const officesBody = $("officesBody");
const officeFilter = $("officeFilter");
const officeDetail = $("officeDetail");
const officeTitle = $("officeTitle");
const officeStats = $("officeStats");
const linesBody = $("linesBody");
const pageInfo = $("pageInfo");
const prevPage = $("prevPage");
const nextPage = $("nextPage");
const busyOverlay = $("busyOverlay");
const busyText = $("busyText");
const busyTitle = $("busyTitle");
const busyDetail = $("busyDetail");
const dbSourceHint = $("dbSourceHint");
const batchesBody = $("batchesBody");
const repsBody = $("repsBody");
const numbersBody = $("numbersBody");
const numbersMeta = $("numbersMeta");
const numbersPageInfo = $("numbersPageInfo");
const loginScreen = $("loginScreen");
const appShell = $("appShell");

let currentUser = null;
let officesCache = [];
let currentOfficeId = null;
let currentStatus = "all";
let currentPage = 1;
let numbersPage = 1;
let officesPage = 1;
let repsPage = 1;
let requestsPage = 1;
let officesSearchTimer = null;
let progressTimer = null;
let cachedLineCount = 0;
let currentView = "home";

function showLogin() {
  currentUser = null;
  if (loginScreen) loginScreen.hidden = false;
  if (appShell) appShell.hidden = true;
  document.body.classList.remove("role-admin", "role-rep");
}

function showApp(user) {
  currentUser = user;
  if (loginScreen) loginScreen.hidden = true;
  if (appShell) appShell.hidden = false;
  document.body.classList.toggle("role-admin", user.role === "admin");
  document.body.classList.toggle("role-rep", user.role === "rep");
  $("userBadge").textContent =
    user.role === "admin"
      ? `أدمن · ${user.username}`
      : `مندوب · ${user.representative_name || user.username}`;
  showView(user.role === "rep" ? "requests" : "home");
}

function n(v) {
  return Number(v || 0).toLocaleString("en-US");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status) {
  if (status === "ACTIVATED") return "مفعّل / مباع";
  if (status === "ASSIGNED") return "غير مباع";
  if (status === "ORPHAN_ASIA") return "آسيا بلا تجهيز";
  return status || "—";
}

function statusClass(status) {
  if (status === "ACTIVATED") return "tag ok";
  if (status === "ASSIGNED") return "tag warn";
  return "tag";
}

function setStatus(text, tone = "ok") {
  if (!statusEl) return;
  statusEl.hidden = !text;
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setBusy(busy, title = "جاري الاستيراد", text = "") {
  if (!busyOverlay) return;
  if (busy) {
    busyOverlay.hidden = false;
    busyOverlay.removeAttribute("hidden");
    busyOverlay.style.display = "grid";
  } else {
    busyOverlay.hidden = true;
    busyOverlay.setAttribute("hidden", "");
    busyOverlay.style.display = "none";
    stopProgressPoll();
  }
  if (busyTitle) busyTitle.textContent = title;
  if (busyText) busyText.textContent = text || (busy ? title : "");
  if (!busy && busyDetail) busyDetail.textContent = "";
  ["importPrep", "importAsia"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
}

function stopProgressPoll() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function startProgressPoll() {
  stopProgressPoll();
  progressTimer = setInterval(async () => {
    try {
      const p = await (await fetch("/api/import/progress")).json();
      if (p.message) busyText.textContent = p.message;
      const parts = [];
      if (p.upserted) parts.push(`${n(p.upserted)} سطر`);
      if (p.offices) parts.push(`${n(p.offices)} مكتب`);
      if (p.activated) parts.push(`${n(p.activated)} تفعيل`);
      if (p.elapsedSec != null) parts.push(`${p.elapsedSec} ث`);
      if (busyDetail) busyDetail.textContent = parts.join(" · ");
    } catch {
      /* ignore */
    }
  }, 800);
}

function showView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach((el) => {
    el.hidden = el.id !== `view-${name}`;
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });

  if (name === "home") loadHome();
  if (name === "offices") loadOffices(1);
  if (name === "reps") loadReps(1);
  if (name === "numbers") loadNumbers(1);
}

async function loadHome() {
  await Promise.all([loadStats(), loadBatches()]);
}

async function loadStats() {
  const data = await (await fetch("/api/db/stats")).json();
  cachedLineCount = Number(data.lines || 0);
  dbSourceHint.textContent = cachedLineCount
    ? `من قاعدة البيانات · ${n(data.lines)} خط · آخر استيراد: ${data.last_import_at || "—"}`
    : "قاعدة البيانات فارغة — ارفع ملف التجهيز من تبويب رفع Excel";

  globalStats.innerHTML = [
    ["الخطوط", data.lines, "accent"],
    ["غير مباع", data.unsold, "warn"],
    ["مفعّل", data.activated, "ok"],
    ["المكاتب", data.offices, ""],
    ["يتيم آسيا", data.orphans, ""],
    ["الاستيرادات", data.batches, ""],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="stat" data-tone="${tone}"><strong>${n(value)}</strong><span>${label}</span></div>`
    )
    .join("");
}

async function loadBatches() {
  const data = await (await fetch("/api/db/batches?limit=10")).json();
  const rows = data.batches || [];
  if (!rows.length) {
    batchesBody.innerHTML = '<tr><td colspan="6" class="empty">لا عمليات بعد</td></tr>';
    return;
  }
  batchesBody.innerHTML = rows
    .map(
      (b) => `
      <tr>
        <td>${b.id}</td>
        <td>${b.type === "prep" ? "تجهيز" : "آسيا"}</td>
        <td>${escapeHtml(b.source_file || "—")}</td>
        <td>${n(b.upserted)}</td>
        <td>${n(b.activated)}</td>
        <td>${escapeHtml(b.created_at || "—")}</td>
      </tr>`
    )
    .join("");
}

function renderOffices(list) {
  if (!list.length) {
    officesBody.innerHTML = '<tr><td colspan="7" class="empty">لا توجد مكاتب</td></tr>';
    return;
  }
  officesBody.innerHTML = list
    .map((o) => {
      const rate = o.sell_rate == null ? 0 : Number(o.sell_rate);
      return `
      <tr class="clickable" data-office-id="${o.id}">
        <td class="office-name">${escapeHtml(o.name)}</td>
        <td>${n(o.total)}</td>
        <td>${n(o.activated)}</td>
        <td>${n(o.unsold)}</td>
        <td class="rate-cell">
          <div>${o.sell_rate == null ? "—" : `${o.sell_rate}%`}</div>
          <div class="rate-bar"><i style="width:${Math.min(rate, 100)}%"></i></div>
        </td>
        <td>${escapeHtml(o.last_activation || "—")}</td>
        <td>${o.avg_days_to_activate == null ? "—" : o.avg_days_to_activate}</td>
      </tr>`;
    })
    .join("");
}

async function loadOffices(page = 1) {
  officesPage = page;
  const params = new URLSearchParams({
    q: (officeFilter?.value || "").trim(),
    page: String(page),
    limit: "50",
  });
  const data = await (await fetch(`/api/offices?${params}`)).json();
  officesCache = data.offices || [];
  renderOffices(officesCache);
  const meta = $("officesMeta");
  if (meta) meta.textContent = `${n(data.total)} مكتب · صفحة ${data.page} من ${data.pages}`;
  const info = $("officesPageInfo");
  if (info) info.textContent = `${data.page} / ${data.pages}`;
  const prev = $("officesPrev");
  const next = $("officesNext");
  if (prev) prev.disabled = data.page <= 1;
  if (next) next.disabled = data.page >= data.pages;
}

function applyOfficeFilter() {
  clearTimeout(officesSearchTimer);
  officesSearchTimer = setTimeout(() => loadOffices(1), 250);
}

function openDrawer() {
  officeDetail.hidden = false;
  officeDetail.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  officeDetail.hidden = true;
  officeDetail.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  currentOfficeId = null;
}

async function openOffice(id, page = 1) {
  currentOfficeId = id;
  currentPage = page;
  openDrawer();
  const params = new URLSearchParams({ status: currentStatus, page: String(page), limit: "50" });
  const res = await fetch(`/api/offices/${id}/lines?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "فشل تحميل المكتب");

  officeTitle.textContent = data.office.name;
  officeStats.innerHTML = [
    ["المستلم", data.office.total, "accent"],
    ["مباع", data.office.activated, "ok"],
    ["غير مباع", data.office.unsold, "warn"],
    ["نسبة البيع", data.office.sell_rate == null ? "—" : `${data.office.sell_rate}%`, ""],
    ["آخر تفعيل", data.office.last_activation || "—", ""],
    ["متوسط الأيام", data.office.avg_days_to_activate ?? "—", ""],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="stat" data-tone="${tone}"><strong>${typeof value === "number" ? n(value) : escapeHtml(value)}</strong><span>${label}</span></div>`
    )
    .join("");

  linesBody.innerHTML =
    (data.rows || [])
      .map(
        (r) => `
      <tr>
        <td class="mono">${escapeHtml(r.phone)}</td>
        <td><span class="${statusClass(r.status)}">${statusLabel(r.status)}</span></td>
        <td>${escapeHtml(r.assigned_date || "—")}</td>
        <td>${escapeHtml(r.activation_date || "—")}</td>
        <td>${r.days_to_activate == null ? "—" : r.days_to_activate}</td>
        <td>${escapeHtml(r.bundle_name || "—")}</td>
      </tr>`
      )
      .join("") || '<tr><td colspan="6" class="empty">لا توجد خطوط</td></tr>';

  pageInfo.textContent = `${data.page} / ${data.pages} · ${n(data.total)}`;
  prevPage.disabled = data.page <= 1;
  nextPage.disabled = data.page >= data.pages;
  $("exportOffice").href = `/api/offices/${id}/export.csv?status=${encodeURIComponent(currentStatus)}`;
}

async function loadReps(page = 1) {
  repsPage = page;
  const params = new URLSearchParams({ page: String(page), limit: "50" });
  const data = await (await fetch(`/api/representatives?${params}`)).json();
  const rows = data.representatives || [];
  const info = $("repsPageInfo");
  if (info) info.textContent = `${data.page} / ${data.pages} · ${n(data.total)}`;
  const prev = $("repsPrev");
  const next = $("repsNext");
  if (prev) prev.disabled = data.page <= 1;
  if (next) next.disabled = data.page >= data.pages;

  if (!rows.length) {
    repsBody.innerHTML = '<tr><td colspan="7" class="empty">لا مندوبين بعد — أضف مندوباً أعلاه</td></tr>';
    return;
  }
  repsBody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="office-name">${escapeHtml(r.name)}</td>
        <td class="mono">${escapeHtml(r.phone || "—")}</td>
        <td>${n(r.lines_count)}</td>
        <td>${n(r.activated)}</td>
        <td>${n(r.unsold)}</td>
        <td>${escapeHtml(r.notes || "—")}</td>
        <td><button class="btn ghost danger-btn" data-del-rep="${r.id}" type="button">حذف</button></td>
      </tr>`
    )
    .join("");
}

async function loadNumbers(page = 1) {
  numbersPage = page;
  const params = new URLSearchParams({
    q: $("numbersQ").value.trim(),
    status: $("numbersStatus").value,
    page: String(page),
    limit: "50",
  });
  const data = await (await fetch(`/api/numbers?${params}`)).json();
  numbersMeta.textContent = `${n(data.total)} رقم من قاعدة البيانات`;
  numbersPageInfo.textContent = `${data.page} / ${data.pages}`;
  $("numbersPrev").disabled = data.page <= 1;
  $("numbersNext").disabled = data.page >= data.pages;

  if (!data.rows?.length) {
    numbersBody.innerHTML = '<tr><td colspan="7" class="empty">لا نتائج</td></tr>';
    return;
  }

  numbersBody.innerHTML = data.rows
    .map(
      (r) => `
      <tr class="${r.office_id ? "clickable" : ""}" data-office-id="${r.office_id || ""}">
        <td class="mono">${escapeHtml(r.phone)}</td>
        <td>${escapeHtml(r.office_name || "—")}</td>
        <td>${escapeHtml(r.representative_name || "—")}</td>
        <td><span class="${statusClass(r.status)}">${statusLabel(r.status)}</span></td>
        <td>${escapeHtml(r.assigned_date || "—")}</td>
        <td>${escapeHtml(r.activation_date || "—")}</td>
        <td>${r.days_to_activate == null ? "—" : r.days_to_activate}</td>
      </tr>`
    )
    .join("");
}

async function runImport(kind) {
  if (kind === "prep" && cachedLineCount > 1000) {
    const ok = window.confirm(
      `البيانات موجودة (${n(cachedLineCount)} خط).\nالرفع سيحدّث القاعدة وقد يستغرق 1–2 دقيقة. متابعة؟`
    );
    if (!ok) return;
  }

  const input = $(kind === "prep" ? "prepFile" : "asiaFile");
  if (!input.files[0]) {
    setStatus("اختر ملفاً أولاً", "err");
    return;
  }

  setBusy(
    true,
    kind === "prep" ? "حفظ التجهيز" : "حفظ آسيا",
    "تحليل الملف مرة واحدة وحفظه في قاعدة البيانات…"
  );
  startProgressPoll();

  try {
    const form = new FormData();
    form.append("file", input.files[0]);
    const res = await fetch(`/api/import/${kind}`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "فشل الاستيراد");
    setStatus(
      kind === "prep"
        ? `تم الحفظ: ${n(data.upserted)} خط · ${n(data.offices_touched)} مكتب`
        : `تم الحفظ: ${n(data.activated)} تفعيل · ${n(data.orphans)} بلا تجهيز`,
      "ok"
    );
    await loadStats();
  } catch (err) {
    setStatus(err.message || "حدث خطأ", "err");
  } finally {
    stopProgressPoll();
    setBusy(false);
  }
}

function bindFileInput(inputId, labelId) {
  const input = $(inputId);
  const label = $(labelId);
  const zone = input.closest(".dropzone");
  input.addEventListener("change", () => {
    if (input.files[0]) {
      label.textContent = input.files[0].name;
      zone.classList.add("has-file");
    }
  });
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});
document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.go));
});

officeFilter?.addEventListener("input", applyOfficeFilter);
officesBody.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-office-id]");
  if (!tr) return;
  openOffice(Number(tr.dataset.officeId), 1).catch((err) => alert(err.message));
});
numbersBody.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-office-id]");
  if (!tr?.dataset.officeId) return;
  openOffice(Number(tr.dataset.officeId), 1).catch((err) => alert(err.message));
});

$("closeOffice").addEventListener("click", closeDrawer);
$("closeOfficeBackdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !officeDetail.hidden) closeDrawer();
});

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentStatus = btn.dataset.status;
    if (currentOfficeId) openOffice(currentOfficeId, 1);
  });
});

prevPage.addEventListener("click", () => currentOfficeId && openOffice(currentOfficeId, currentPage - 1));
nextPage.addEventListener("click", () => currentOfficeId && openOffice(currentOfficeId, currentPage + 1));

$("repForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/representatives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: $("repName").value,
      phone: $("repPhone").value,
      notes: $("repNotes").value,
    }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || "فشل الإضافة");
  e.target.reset();
  loadReps(1);
});

repsBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-rep]");
  if (!btn) return;
  if (!confirm("حذف المندوب؟")) return;
  await fetch(`/api/representatives/${btn.dataset.delRep}`, { method: "DELETE" });
  loadReps(repsPage);
});

$("numbersSearchBtn").addEventListener("click", () => loadNumbers(1));
$("numbersQ").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadNumbers(1);
});
$("numbersStatus").addEventListener("change", () => loadNumbers(1));
$("numbersPrev").addEventListener("click", () => loadNumbers(numbersPage - 1));
$("numbersNext").addEventListener("click", () => loadNumbers(numbersPage + 1));

$("officesPrev")?.addEventListener("click", () => loadOffices(officesPage - 1));
$("officesNext")?.addEventListener("click", () => loadOffices(officesPage + 1));
$("repsPrev")?.addEventListener("click", () => loadReps(repsPage - 1));
$("repsNext")?.addEventListener("click", () => loadReps(repsPage + 1));

$("importPrep").addEventListener("click", () => runImport("prep"));
$("importAsia").addEventListener("click", () => runImport("asia"));
bindFileInput("prepFile", "prepFileName");
bindFileInput("asiaFile", "asiaFileName");

$("busyClose")?.addEventListener("click", () => {
  setBusy(false);
  setStatus("تم إغلاق شاشة الاستيراد. إذا كان الرفع ما زال على السيرفر سيكمل في الخلفية.", "ok");
});

// تأكد أن الشاشة ليست عالقة عند فتح الصفحة
setBusy(false);

showView("home");
