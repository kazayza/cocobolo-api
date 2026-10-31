// اختبارات مُحاكاة (stubbed) لوحدة الخزينة — بلا أي قاعدة بيانات حية.
// تُستبدل وحدة core/database بذاكرة وهمية تنفذ دلالات الاستعلامات التي
// تستخدمها cashbox.queries في المسارات المفحوصة، وتدعم المعاملات
// بلقطة/استرجاع حتى تُفحص الذرّية وعدم حدوث كتابات عند الرفض.
// التشغيل: node --test modules/cashbox/cashbox.test.js
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-for-cashbox-stub-0123456789abcdef';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── المخزن الوهمي ─────────────────────────────────────────────
const state = { store: null, writes: [] };
let nextBoxId; let nextTxId;

function resetStore() {
  nextBoxId = 100; nextTxId = 9000;
  state.writes = [];
  state.store = {
    branches: [{ BranchID: 1, BranchNameAr: 'الفرع الرئيسي', IsActive: 1 }],
    boxes: [
      { CashBoxID: 10, CashBoxName: 'الخزينة الرئيسية', Description: null, BranchID: 1, OpeningBalance: 1000, OpeningDate: '2026-01-01', CashBoxKind: 'Cash', Icon: 'AttachMoney', Color: '#10b981', IsActive: 1, IsDefault: 1, CreatedBy: 'admin', CreatedAt: '2026-01-01' },
    ],
    cashTx: [],
    personalAccounts: [],
    audit: [],
  };
}
resetStore();

function boxBalance(boxId) {
  const s = state.store;
  const box = s.boxes.find((b) => b.CashBoxID === boxId);
  let bal = box ? Number(box.OpeningBalance || 0) : 0;
  for (const t of s.cashTx.filter((x) => x.CashBoxID === boxId)) {
    if (t.TransactionType === 'قبض') bal += Number(t.Amount);
    else if (t.TransactionType === 'صرف') bal -= Number(t.Amount);
  }
  return bal;
}

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const s = state.store;

  // سجل التدقيق
  if (text.includes('INSERT INTO [dbo].[Audit_Log]')) {
    s.audit.push({ table: p.table, action: p.action, key: p.key, username: p.username, oldData: p.oldData, newData: p.newData });
    state.writes.push({ type: 'audit' });
    return { recordset: [] };
  }
  // التحقق من الفرع النشط
  if (text.includes('FROM Branches')) {
    const b = s.branches.find((x) => x.BranchID === p.branchId && x.IsActive === 1);
    return { recordset: b ? [{ BranchID: b.BranchID }] : [] };
  }
  // إنشاء خزينة
  if (text.includes('INSERT INTO CashBoxes')) {
    const box = {
      CashBoxID: nextBoxId++, CashBoxName: p.cashBoxName, Description: p.description,
      BranchID: p.branchId, OpeningBalance: p.openingBalance, OpeningDate: p.openingDate,
      CashBoxKind: p.cashBoxKind, Icon: p.icon, Color: p.color,
      IsActive: p.isActive ? 1 : 0, IsDefault: p.isDefault ? 1 : 0,
      CreatedBy: p.createdBy, CreatedAt: '2026-10-30',
    };
    s.boxes.push(box);
    state.writes.push({ type: 'insert-box', box });
    return { recordset: [{ CashBoxID: box.CashBoxID }] };
  }
  // إلغاء الافتراضية عن الباقي
  if (text.includes('UPDATE CashBoxes SET IsDefault = 0')) {
    for (const b of s.boxes) if (b.CashBoxID !== p.id) b.IsDefault = 0;
    return { recordset: [] };
  }
  // جلب خزينة بقفل (تعديل/حذف)
  if (text.includes('SELECT * FROM CashBoxes WITH (UPDLOCK')) {
    const box = s.boxes.find((b) => b.CashBoxID === p.id);
    return { recordset: box ? [box] : [] };
  }
  // عد حركات خزينة (حارس الحذف)
  if (text.includes('SELECT COUNT(*) AS C FROM CashboxTransactions')) {
    return { recordset: [{ C: s.cashTx.filter((t) => t.CashBoxID === p.id).length }] };
  }
  // حذف خزينة
  if (text.includes('DELETE FROM CashBoxes')) {
    s.boxes = s.boxes.filter((b) => b.CashBoxID !== p.id);
    state.writes.push({ type: 'delete-box', id: p.id });
    return { recordset: [] };
  }
  // الرصيد داخل معاملة (التعريف الموحد)
  if (text.includes('AS Balance') && text.includes('FROM CashboxTransactions')) {
    return { recordset: [{ Balance: boxBalance(p.cashBoxId) }] };
  }
  // إدراج حركة خزينة
  if (text.includes('INSERT INTO CashboxTransactions')) {
    const row = {
      CashboxTransactionID: nextTxId++, CashBoxID: p.cashBoxId,
      PaymentID: p.paymentId ?? null, ReferenceID: p.referenceId ?? null,
      ReferenceType: p.referenceType, TransactionType: p.transactionType,
      Amount: p.amount, TransactionDate: p.transactionDate, Notes: p.notes ?? null,
      CreatedBy: p.createdBy, CreatedAt: '2026-10-30',
    };
    s.cashTx.push(row);
    state.writes.push({ type: 'insert-tx', row });
    return { recordset: [{ CashboxTransactionID: row.CashboxTransactionID }] };
  }
  // حركة مفردة بالمعرف
  if (text.includes('WHERE ct.CashboxTransactionID = @id')) {
    const t = s.cashTx.find((x) => x.CashboxTransactionID === p.id);
    if (!t) return { recordset: [] };
    const box = s.boxes.find((b) => b.CashBoxID === t.CashBoxID);
    return { recordset: [{ ...t, CashBoxName: box ? box.CashBoxName : '', CashBoxColor: box ? box.Color : null }] };
  }
  // الذمم: مجاميع خام لكل حساب شخصي (الحساب نفسه في cashbox.queries)
  if (text.includes('FROM PersonalAccounts')) {
    const rows = s.personalAccounts.map((a) => {
      let loansIn = 0; let loansOut = 0;
      for (const t of s.cashTx.filter((x) => x.ReferenceType === 'Loan' && x.ReferenceID === a.PersonalAccountId)) {
        if (t.TransactionType === 'قبض') loansIn += Number(t.Amount);
        else if (t.TransactionType === 'صرف') loansOut += Number(t.Amount);
      }
      return {
        PersonalAccountId: a.PersonalAccountId, AccountName: a.AccountName,
        AccountType: a.AccountType, OpeningBalance: a.OpeningBalance,
        OpeningType: a.OpeningType, LoansIn: loansIn, LoansOut: loansOut,
      };
    });
    return { recordset: rows };
  }
  // لوحة كاملة: الإحصائيات الرئيسية (اليوم/الشهر تقويميان في الاستعلام)
  if (text.includes('TodayIn')) {
    const activeOnly = text.includes('cb.IsActive = 1') || text.includes('WHERE IsActive = 1');
    const activeIds = new Set(s.boxes.filter((b) => b.IsActive === 1).map((b) => b.CashBoxID));
    let total = 0;
    for (const b of s.boxes) {
      if (activeOnly && b.IsActive !== 1) continue;
      total += Number(b.OpeningBalance || 0);
    }
    for (const t of s.cashTx) {
      if (activeOnly && !activeIds.has(t.CashBoxID)) continue;
      if (t.TransactionType === 'قبض') total += Number(t.Amount);
      else if (t.TransactionType === 'صرف') total -= Number(t.Amount);
    }
    const now = new Date();
    const sameDay = (d) => d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const sameMonth = (d) => d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    let todayIn = 0; let todayOut = 0; let monthIn = 0; let monthOut = 0;
    for (const t of s.cashTx) {
      const d = new Date(t.TransactionDate);
      if (t.TransactionType === 'قبض') { if (sameDay(d)) todayIn += Number(t.Amount); if (sameMonth(d)) monthIn += Number(t.Amount); }
      if (t.TransactionType === 'صرف') { if (sameDay(d)) todayOut += Number(t.Amount); if (sameMonth(d)) monthOut += Number(t.Amount); }
    }
    return { recordset: [{ TotalBalance: total, TodayIn: todayIn, TodayOut: todayOut, MonthIn: monthIn, MonthOut: monthOut }] };
  }
  // إحصائيات الداشبورد (نقطة dashboard/stats)
  if (text.includes('AS TransactionCount')) {
    const activeOnly = text.includes('cb.IsActive = 1') || text.includes('WHERE IsActive = 1');
    const activeIds = new Set(s.boxes.filter((b) => b.IsActive === 1).map((b) => b.CashBoxID));
    let total = 0;
    for (const b of s.boxes) {
      if (activeOnly && b.IsActive !== 1) continue;
      total += Number(b.OpeningBalance || 0);
    }
    for (const t of s.cashTx) {
      if (activeOnly && !activeIds.has(t.CashBoxID)) continue;
      if (t.TransactionType === 'قبض') total += Number(t.Amount);
      else if (t.TransactionType === 'صرف') total -= Number(t.Amount);
    }
    // نافذة الفترة: الشهر التقويمي عند وجود DATEFROMPARTS، وإلا نافذة منزلقة شهر
    const now = new Date();
    const inPeriod = text.includes('DATEFROMPARTS')
      ? (d) => d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      : (d) => d >= new Date(now.getTime() - 30 * 864e5);
    let totalIn = 0; let totalOut = 0; let count = 0; let inCount = 0; let outCount = 0;
    for (const t of s.cashTx) {
      if (!inPeriod(new Date(t.TransactionDate))) continue;
      count += 1;
      if (t.TransactionType === 'قبض') { totalIn += Number(t.Amount); inCount += 1; }
      if (t.TransactionType === 'صرف') { totalOut += Number(t.Amount); outCount += 1; }
    }
    return { recordset: [{ TotalBalance: total, TotalIn: totalIn, TotalOut: totalOut, TransactionCount: count, InCount: inCount, OutCount: outCount }] };
  }
  // عدد الخزن
  if (text.includes('COUNT(*) AS Total')) {
    return { recordset: [{ Total: s.boxes.length, Active: s.boxes.filter((b) => b.IsActive === 1).length }] };
  }
  // قائمة الخزن بأرصدتها (داخل اللوحة الكاملة)
  if (text.includes('TransactionsCount')) {
    const rows = s.boxes.map((b) => {
      let totalIn = 0; let totalOut = 0; let count = 0;
      for (const t of s.cashTx.filter((x) => x.CashBoxID === b.CashBoxID)) {
        count += 1;
        if (t.TransactionType === 'قبض') totalIn += Number(t.Amount);
        else if (t.TransactionType === 'صرف') totalOut += Number(t.Amount);
      }
      return {
        ...b, TotalIn: totalIn, TotalOut: totalOut, TransactionsCount: count,
        CurrentBalance: Number(b.OpeningBalance || 0) + totalIn - totalOut,
      };
    });
    return { recordset: rows };
  }
  // آخر 30 يوم / تفصيل الأنواع / آخر الحركات — غير مفحوصة هنا
  if (text.includes('DATEADD(DAY, -29') || text.includes('GROUP BY ReferenceType') || text.includes('SELECT TOP 10')) {
    return { recordset: [] };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 160)}`);
}

class FakeRequest {
  constructor() { this.params = {}; }
  input(name, _type, value) { this.params[name] = value; return this; }
  async query(text) { return executeQuery(text, this.params); }
}
class FakeTransaction {
  constructor(_pool) { this.snapshot = null; }
  request() { return new FakeRequest(); }
  async begin() { this.snapshot = structuredClone(state.store); }
  async commit() { this.snapshot = null; }
  async rollback() { if (this.snapshot) state.store = this.snapshot; this.snapshot = null; }
}
const fakePool = { request: () => new FakeRequest() };
function NVarCharFn() { return 'NVarChar'; }
NVarCharFn.MAX = -1;
const fakeSql = {
  Int: 'Int', NVarChar: NVarCharFn, Decimal: () => 'Decimal', Date: 'Date',
  DateTime: 'DateTime', DateTime2: 'DateTime2', Bit: 'Bit', MAX: -1,
  Transaction: FakeTransaction, Request: FakeRequest,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const q = require('./cashbox.queries');
const ctrl = require('./cashbox.controller');

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
const auditRows = (table, action) => state.store.audit.filter((a) => a.table === table && a.action === action);

// ── #24 الذمم — الحساب من CashBoxService.cs:900-953 ─────────────
// لكل حساب: الرصيد = (افتتاحي Credit ‏+ / Debit ‏−) + (Loan قبض − Loan صرف)
//   A: ‏+1000 + (500 − 200) = 1300        (دائن)
//   B: ‏−400  + (100 − 300) = −600        (مدين 600)
//   C: ‏0     + (250 − 250) = 0           (يُستبعد من الأعلى)
//   D: ‏+50   + 0           = 50          (دائن)
//   E: ‏−2000 + 0           = −2000       (مدين 2000)
//   F: ‏+10   + 0           = 10          (دائن)
// الدائنون = 1300 + 50 + 10 = 1360 · المدينون = 600 + 2000 = 2600
// الأعلى 5 بترتيب |الرصيد| تنازليًا: E(2000) A(1300) B(600) D(50) F(10)
test('dashboard personal accounts: signed opening + Loan movements, creditors/debtors, Top-5 non-zero', async () => {
  resetStore();
  state.store.personalAccounts = [
    { PersonalAccountId: 1, AccountName: 'حساب A', AccountType: 'عميل', OpeningBalance: 1000, OpeningType: 'Credit' },
    { PersonalAccountId: 2, AccountName: 'حساب B', AccountType: 'مورد', OpeningBalance: 400, OpeningType: 'Debit' },
    { PersonalAccountId: 3, AccountName: 'حساب C', AccountType: 'عميل', OpeningBalance: 0, OpeningType: 'Credit' },
    { PersonalAccountId: 4, AccountName: 'حساب D', AccountType: 'عميل', OpeningBalance: 50, OpeningType: 'Credit' },
    { PersonalAccountId: 5, AccountName: 'حساب E', AccountType: 'مورد', OpeningBalance: 2000, OpeningType: 'Debit' },
    { PersonalAccountId: 6, AccountName: 'حساب F', AccountType: 'عميل', OpeningBalance: 10, OpeningType: 'Credit' },
  ];
  const loan = (refId, type, amount) => state.store.cashTx.push({
    CashboxTransactionID: nextTxId++, CashBoxID: 10, ReferenceType: 'Loan',
    ReferenceID: refId, TransactionType: type, Amount: amount,
    TransactionDate: new Date(), Notes: null, CreatedBy: 'admin',
  });
  loan(1, 'قبض', 500); loan(1, 'صرف', 200);
  loan(2, 'قبض', 100); loan(2, 'صرف', 300);
  loan(3, 'قبض', 250); loan(3, 'صرف', 250);

  const d = await q.getFullDashboard();
  assert.equal(d.TotalCreditors, 1360);
  assert.equal(d.TotalDebtors, 2600);
  assert.ok(Array.isArray(d.TopPersonalAccounts));
  assert.deepEqual(d.TopPersonalAccounts.map((a) => a.PersonalAccountId), [5, 1, 2, 4, 6]);
  assert.deepEqual(d.TopPersonalAccounts.map((a) => a.CurrentBalance), [-2000, 1300, -600, 50, 10]);
  assert.equal(d.TopPersonalAccounts[1].AccountName, 'حساب A');
});

// ── #22 الإجمالي يستبعد الخزن المعطلة ────────────────────────────
test('dashboard totals exclude an inactive box (opening + movements)', async () => {
  resetStore();
  state.store.boxes.push({
    CashBoxID: 11, CashBoxName: 'خزينة معطلة', Description: null, BranchID: 1,
    OpeningBalance: 5000, OpeningDate: '2026-01-01', CashBoxKind: 'Cash',
    Icon: 'AttachMoney', Color: '#10b981', IsActive: 0, IsDefault: 0,
    CreatedBy: 'admin', CreatedAt: '2026-01-01',
  });
  state.store.cashTx.push({
    CashboxTransactionID: nextTxId++, CashBoxID: 11, ReferenceType: 'ManualReceipt',
    ReferenceID: null, TransactionType: 'قبض', Amount: 500,
    TransactionDate: new Date(), Notes: null, CreatedBy: 'admin',
  });
  // النشطة فقط: افتتاحي 1000 ولا حركات عليها — المعطلة (5000+500) خارج الإجمالي
  const full = await q.getFullDashboard();
  assert.equal(full.TotalBalance, 1000);
  const stats = await q.getDashboardStats('month');
  assert.equal(stats.TotalBalance, 1000);
});

// ── #22 الشهر التقويمي: حركة أول الشهر تدخل وحركة قبل 31 يومًا لا تدخل ──
test('dashboard stats month = calendar month from the 1st', async () => {
  resetStore();
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 12);
  const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 864e5);
  const mk = (date, amount) => state.store.cashTx.push({
    CashboxTransactionID: nextTxId++, CashBoxID: 10, ReferenceType: 'ManualReceipt',
    ReferenceID: null, TransactionType: 'قبض', Amount: amount,
    TransactionDate: date, Notes: null, CreatedBy: 'admin',
  });
  mk(firstOfMonth, 700);
  mk(thirtyOneDaysAgo, 900); // في الشهر السابق دائمًا (قبل 31 يومًا)
  const stats = await q.getDashboardStats('month');
  assert.equal(stats.TotalIn, 700);
});

// ── #4 الفرع إلزامي عند الإنشاء ──────────────────────────────────
test('createCashbox without branchId → 400 «الفرع مطلوب» and zero writes', async () => {
  resetStore();
  await assert.rejects(
    q.createCashbox({ cashBoxName: 'خزينة بلا فرع', createdBy: 'admin' }),
    (e) => e.statusCode === 400 && e.message === 'الفرع مطلوب',
  );
  assert.equal(state.store.boxes.length, 1);
  assert.equal(state.store.audit.length, 0);
  assert.equal(state.writes.length, 0);
});

// ── #6 الحذف: رفض مع حركات + نجاح نظيف + تدقيق ───────────────────
test('deleteCashbox: refused when transactions exist; clean delete succeeds with audit', async () => {
  resetStore();
  state.store.cashTx.push({
    CashboxTransactionID: nextTxId++, CashBoxID: 10, ReferenceType: 'ManualReceipt',
    ReferenceID: null, TransactionType: 'قبض', Amount: 10,
    TransactionDate: new Date(), Notes: null, CreatedBy: 'admin',
  });
  await assert.rejects(
    q.deleteCashbox(10, 'admin'),
    (e) => e.statusCode === 400 && e.message === 'لا يمكن حذف خزينة بها حركات. عطّلها بدلاً من ذلك.',
  );
  assert.ok(state.store.boxes.some((b) => b.CashBoxID === 10));

  resetStore();
  state.store.boxes.push({
    CashBoxID: 12, CashBoxName: 'خزينة فارغة', Description: null, BranchID: 1,
    OpeningBalance: 0, OpeningDate: '2026-01-01', CashBoxKind: 'Cash',
    Icon: 'AttachMoney', Color: '#10b981', IsActive: 1, IsDefault: 0,
    CreatedBy: 'admin', CreatedAt: '2026-01-01',
  });
  assert.equal(await q.deleteCashbox(12, 'admin'), true);
  assert.ok(!state.store.boxes.some((b) => b.CashBoxID === 12));
  assert.equal(auditRows('CashBoxes', 'Delete').length, 1);
  assert.equal(auditRows('CashBoxes', 'Delete')[0].username, 'admin');
});

// ── #21 المسار الإرثي: صرف فوق الرصيد ومبلغ سالب ونوع مرجع مجهول ──
test('legacy POST /transactions: over-balance صرف, negative amount, unknown ref type → rejected, zero writes', async () => {
  resetStore(); // رصيد الخزينة 10 = 1000
  await assert.rejects(
    q.createTransaction({ cashBoxId: 10, transactionType: 'صرف', amount: 1500, createdBy: 'admin' }),
    (e) => e.statusCode === 400 && e.message.includes('الرصيد غير كافي'),
  );
  assert.equal(state.store.cashTx.length, 0);
  assert.equal(state.store.audit.length, 0);

  await assert.rejects(
    q.createTransaction({ cashBoxId: 10, transactionType: 'قبض', amount: -5, createdBy: 'admin' }),
    (e) => e.statusCode === 400 && e.message.includes('أكبر من صفر'),
  );
  assert.equal(state.store.cashTx.length, 0);

  await assert.rejects(
    q.createTransaction({ cashBoxId: 10, transactionType: 'قبض', amount: 10, referenceType: 'SomethingInvented', createdBy: 'admin' }),
    (e) => e.statusCode === 400 && e.message.includes('نوع المرجع غير معروف'),
  );
  assert.equal(state.store.cashTx.length, 0);

  // مسار سليم: قبض بلا نوع مرجع → ManualReceipt + تدقيق Insert
  const id = await q.createTransaction({ cashBoxId: 10, transactionType: 'قبض', amount: 250, createdBy: 'admin' });
  assert.ok(id > 0);
  assert.equal(state.store.cashTx.length, 1);
  assert.equal(state.store.cashTx[0].ReferenceType, 'ManualReceipt');
  assert.equal(auditRows('CashboxTransactions', 'Insert').length, 1);
});

// ── #30 التدقيق: إنشاء خزينة + صرف يدوي ──────────────────────────
test('audit rows written on box create and on a manual صرف', async () => {
  resetStore();
  const newId = await q.createCashbox({ cashBoxName: 'خزينة جديدة', branchId: 1, createdBy: 'admin' });
  assert.ok(newId >= 100);
  const inserts = auditRows('CashBoxes', 'Insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].key, String(newId));
  assert.equal(inserts[0].username, 'admin');

  await q.createManualOperation({ operationType: 'ManualPayment', cashBoxId: 10, amount: 200, createdBy: 'admin' });
  const manual = auditRows('CashboxTransactions', 'Manual');
  assert.equal(manual.length, 1);
  assert.equal(manual[0].username, 'admin');
  const tx = state.store.cashTx.find((t) => t.ReferenceType === 'ManualPayment');
  assert.ok(tx && tx.TransactionType === 'صرف' && Number(tx.Amount) === 200);
});

// ── #34 انتحال المنشئ في الجسم يُتجاهل ───────────────────────────
test('createdBy spoof in body is ignored — stored value = token username', async () => {
  resetStore();
  const res = mockRes();
  await ctrl.create(
    { body: { cashBoxName: 'خزينة المنتحل', branchId: 1, createdBy: 'mallory' }, auth: { username: 'admin' } },
    res,
  );
  assert.equal(res.statusCode, 200);
  const box = state.store.boxes.find((b) => b.CashBoxName === 'خزينة المنتحل');
  assert.ok(box);
  assert.equal(box.CreatedBy, 'admin');

  const res2 = mockRes();
  await ctrl.createTransaction(
    { body: { cashBoxId: 10, transactionType: 'قبض', amount: 40, createdBy: 'mallory' }, auth: { username: 'admin' } },
    res2,
  );
  assert.equal(res2.statusCode, 200);
  const tx = state.store.cashTx.find((t) => Number(t.Amount) === 40);
  assert.ok(tx);
  assert.equal(tx.CreatedBy, 'admin');
});

// ── #11 التطبيع العربي (مرآة StringExtensions.NormalizeArabic) ────
test('normalizeArabic mirrors Blazor StringExtensions exactly', () => {
  assert.equal(q.normalizeArabic('أحمد إبراهيم آمنة'), 'احمد ابراهيم امنه');
  assert.equal(q.normalizeArabic('فاطمة موسى'), 'فاطمه موسي');
  assert.equal(q.normalizeArabic('مؤمن رؤوف سائل'), 'مءمن رءوف ساءل');
  assert.equal(q.normalizeArabic(null), '');
});

// ── #13 حركة مفردة مع إثراء مصدرها ───────────────────────────────
test('getTransactionById returns the enriched single transaction', async () => {
  resetStore();
  state.store.cashTx.push({
    CashboxTransactionID: 777, CashBoxID: 10, PaymentID: null, ReferenceID: null,
    ReferenceType: 'ManualReceipt', TransactionType: 'قبض', Amount: 90,
    TransactionDate: new Date(), Notes: 'سند', CreatedBy: 'admin', CreatedAt: '2026-10-30',
  });
  const tx = await q.getTransactionById(777);
  assert.ok(tx);
  assert.equal(tx.CashBoxName, 'الخزينة الرئيسية');
  assert.equal(tx.SourceTitle, 'سند قبض يدوي');
  assert.equal(tx.SourceUrl, '/cashbox/transactions');
  assert.equal(await q.getTransactionById(424242), null);
});
