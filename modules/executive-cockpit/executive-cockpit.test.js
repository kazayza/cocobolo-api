// اختبارات مُحاكاة (stubbed) لقمرة القيادة التنفيذية — بلا قاعدة بيانات حية.
// تُستبدل core/database بذاكرة وهمية تنفّذ دلالات استعلامَي figures/pipeline
// من نص SQL نفسه (العمود المجموع يُقرأ من النص، وفلتر «Cancelled» ونطاق
// الفرع يُطبَّقان فقط إن وُجدا في النص) — فالاختبار يفشل لو رجع أيٌّ منهما.
// التشغيل: node --test modules/executive-cockpit/executive-cockpit.test.js
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-for-cockpit-stub-0123456789abc';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── الجهاز (fixture) ─────────────────────────────────────────
// موظف 1 ← فرع 1، موظف 2 ← فرع 2؛ مخزن 10 ← فرع 1، مخزن 20 ← فرع 2.
const EMP_BRANCH = { 1: 1, 2: 2 };
const WH_BRANCH = { 10: 1, 20: 2 };
const BRANCH_NAMES = { 1: 'الفرع الأول', 2: 'الفرع الثاني' };
const TX = [
  // بيع A: GrandTotal 1000 مقابل NetTotalAmount 900 وTotalAmount 950 —
  // الفروق مقصودة: أي عمود غير GrandTotal يعطي رقمًا مختلفًا.
  { Id: 1, Type: 'Sale', Grand: 1000, Net: 900, Total: 950, Paid: 400, Status: 'Open', Date: '2026-10-05', EmpId: 1, Wh: 10, RefType: null },
  { Id: 2, Type: 'Sale', Grand: 500, Net: 500, Total: 500, Paid: 500, Status: 'Paid', Date: '2026-10-06', EmpId: 2, Wh: 20, RefType: null },
  // بيع ملغاة: يجب ألا تدخل أي مجموع.
  { Id: 3, Type: 'Sale', Grand: 700, Net: 700, Total: 700, Paid: 100, Status: 'Cancelled', Date: '2026-10-06', EmpId: 1, Wh: 10, RefType: null },
  // بيع بلا موظف منشئ: إسنادها من المخزن (فرع 2).
  { Id: 8, Type: 'Sale', Grand: 250, Net: 250, Total: 250, Paid: 0, Status: 'Open', Date: '2026-10-06', EmpId: null, Wh: 20, RefType: null },
  // مرتجع بيع: GrandTotal 200 مقابل TotalAmount 150 وNetTotalAmount 180.
  { Id: 4, Type: 'SaleReturn', Grand: 200, Net: 180, Total: 150, Paid: 0, Status: 'Open', Date: '2026-10-07', EmpId: 1, Wh: 10, RefType: null },
  { Id: 5, Type: 'Purchase', Grand: 800, Net: 800, Total: 800, Paid: 0, Status: 'Open', Date: '2026-10-08', EmpId: 1, Wh: 10, RefType: null },
  // مشتريات مرآة: تُستبعد من إجمالي المشتريات.
  { Id: 6, Type: 'Purchase', Grand: 300, Net: 300, Total: 300, Paid: 0, Status: 'Open', Date: '2026-10-08', EmpId: 1, Wh: 10, RefType: 'MirrorOf:1' },
  { Id: 7, Type: 'PurchaseReturn', Grand: 50, Net: 50, Total: 50, Paid: 0, Status: 'Open', Date: '2026-10-09', EmpId: 1, Wh: 10, RefType: null },
];
const PAYMENTS = [
  { TxId: 1, Amount: 400, Date: '2026-10-08' },
  // دفعة على فاتورة ملغاة: تحصيلات بلازور بلا فلتر حالة فاتورة (D14) — تُحسب.
  { TxId: 3, Amount: 100, Date: '2026-10-08' },
];
const CASHBOXES = [
  { CashBoxID: 1, OpeningBalance: 100 },
  { CashBoxID: 2, OpeningBalance: 200 },
];
const CASHTX = [
  { Box: 1, Type: 'قبض', Amount: 1000, Date: '2026-10-05' },
  { Box: 1, Type: 'In', Amount: 200, Date: '2026-10-06' },
  { Box: 2, Type: 'قبض', Amount: 500, Date: '2026-10-06' },
  { Box: 1, Type: 'صرف', Amount: 300, Date: '2026-10-07' },
  { Box: 1, Type: 'Out', Amount: 50, Date: '2026-10-07' },
];

function inRange(dateStr, p) {
  const from = p.fromDate.toISOString().slice(0, 10);
  const to = p.toDate.toISOString().slice(0, 10);
  return dateStr >= from && dateStr <= to;
}
function attributedBranch(tx) {
  const eb = tx.EmpId != null ? EMP_BRANCH[tx.EmpId] : undefined;
  if (eb != null) return eb;
  return tx.Wh != null ? WH_BRANCH[tx.Wh] : null;
}
function sumField(rows, field) {
  return rows.reduce((s, r) => s + (field === 'NetTotalAmount' ? (r.Net ?? r.Grand) : r[field === 'GrandTotal' ? 'Grand' : 'Total']), 0);
}

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const exclCancelled = text.includes("InvoiceStatus <> 'Cancelled'");
  const scopedTx = text.includes('EmpId IN (SELECT EmployeeID');
  const branchId = p.branchId;
  const txFilter = (tx) => inRange(tx.Date, p)
    && (!exclCancelled || tx.Status !== 'Cancelled')
    && (!scopedTx || attributedBranch(tx) === branchId);

  // figures(): استعلام الأرقام الموحّد
  if (text.includes('SalesGross =')) {
    const colFor = (alias) => {
      const m = text.match(new RegExp(`${alias} = \\(SELECT ISNULL\\(SUM\\(ISNULL\\(t\\.(\\w+)`));
      return m ? m[1] : 'GrandTotal';
    };
    const sumType = (type, extra) => sumField(
      TX.filter((tx) => tx.Type === type && txFilter(tx) && (!extra || extra(tx))),
      colFor(type === 'Sale' ? 'SalesGross' : type === 'SaleReturn' ? 'SaleReturns' : type === 'Purchase' ? 'PurchasesGross' : 'PurchaseReturns'),
    );
    const mirrorOk = (tx) => !text.includes("NOT LIKE 'MirrorOf:%'") || !(tx.RefType || '').startsWith('MirrorOf:');
    const collected = PAYMENTS
      .filter((pay) => {
        const tx = TX.find((t) => t.Id === pay.TxId);
        return tx && tx.Type === 'Sale' && inRange(pay.Date, p)
          && (!scopedTx || attributedBranch(tx) === branchId);
      })
      .reduce((s, pay) => s + pay.Amount, 0);
    const cashInList = text.match(/ct\.CashBoxID IN \(([\d,]+)\)/);
    const cashFilter = (ct) => inRange(ct.Date, p) && (!cashInList || cashInList[1].split(',').map(Number).includes(ct.Box));
    const cashSum = (types) => CASHTX.filter((ct) => types.includes(ct.Type) && cashFilter(ct)).reduce((s, ct) => s + ct.Amount, 0);
    return {
      recordset: [{
        SalesGross: sumType('Sale'),
        SaleReturns: sumType('SaleReturn'),
        PurchasesGross: sumType('Purchase', mirrorOk),
        PurchaseReturns: sumType('PurchaseReturn'),
        Collected: collected,
        CashIn: cashSum(['قبض', 'In']),
        CashOut: cashSum(['صرف', 'Out']),
      }],
    };
  }
  // pipeline(): رصيد الخزينة
  if (text.includes('AS CashBalance')) {
    const lists = [...text.matchAll(/CashBoxID IN \(([\d,]+)\)/g)].map((m) => m[1].split(',').map(Number));
    const boxes = lists.length ? CASHBOXES.filter((b) => lists[0].includes(b.CashBoxID)) : CASHBOXES;
    const boxIds = new Set(boxes.map((b) => b.CashBoxID));
    const opening = boxes.reduce((s, b) => s + b.OpeningBalance, 0);
    const inn = CASHTX.filter((ct) => ['قبض', 'In'].includes(ct.Type) && boxIds.has(ct.Box)).reduce((s, ct) => s + ct.Amount, 0);
    const out = CASHTX.filter((ct) => ['صرف', 'Out'].includes(ct.Type) && boxIds.has(ct.Box)).reduce((s, ct) => s + ct.Amount, 0);
    return { recordset: [{ CashBalance: opening + inn - out }] };
  }
  // pipeline(): الفرص
  if (text.includes('FROM SalesOpportunities')) {
    return { recordset: [{ Cnt: 0, Value: 0, Stalled: 0 }] };
  }
  // pipeline(): طلبات B2B — غياب الجدول محاكًى (الدالة تلتقط الخطأ داخليًا)
  if (text.includes('FROM B2BRequests')) throw new Error('Invalid object name B2BRequests');
  // pipeline(): مبيعات الفروع
  if (text.includes('BranchNameAr')) {
    const byBranch = new Map();
    for (const tx of TX) {
      if (tx.Type !== 'Sale' || !txFilter(tx)) continue;
      const b = WH_BRANCH[tx.Wh];
      byBranch.set(b, (byBranch.get(b) || 0) + tx.Grand);
    }
    const rows = [...byBranch.entries()]
      .map(([b, v]) => ({ Name: BRANCH_NAMES[b], Value: v }))
      .sort((a, b) => b.Value - a.Value);
    return { recordset: rows };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 140)}`);
}

class FakeRequest {
  constructor() { this.params = {}; }
  input(name, _type, value) { this.params[name] = value; return this; }
  async query(text) { return executeQuery(text, this.params); }
}
const fakePool = { request: () => new FakeRequest() };
const fakeSql = {
  Int: 'Int', BigInt: 'BigInt', Date: 'Date', DateTime: 'DateTime',
  NVarChar: () => 'NVarChar', Decimal: () => 'Decimal', MAX: -1,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };
const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const q = require('./executive-cockpit.queries');
const FROM = new Date(Date.UTC(2026, 9, 1));
const TO = new Date(Date.UTC(2026, 9, 31));
const UNSCOPED = { branchId: null, branchName: '', employeeIds: [], warehouseIds: [], cashBoxIds: [], scoped: false };
const BRANCH1 = { branchId: 1, branchName: 'الفرع الأول', employeeIds: [1], warehouseIds: [10], cashBoxIds: [1], scoped: true };

// الحساب من ExecutiveCockpitService.cs:403-432:
// SalesGross = Σ GrandTotal بيع غير ملغاة = 1000 + 500 + 250 = 1750
//   (العمود الخاطئ السابق NetTotalAmount ?? GrandTotal كان يعطي 900+500+250 = 1650)
// SaleReturns = Σ GrandTotal مرتجع بيع = 200
//   (العمود الخاطئ السابق TotalAmount كان يعطي 150)
// SalesNet = 1750 − 200 = 1550
// PurchasesGross = 800 (المرآة 300 مستبعدة)، PurchaseReturns = 50، الصافي 750
// Collected = 400 + 100 (دفعة الملغاة تُحسب — D14 بلا فلتر حالة) = 500
// CashIn = 1000 + 200 + 500 = 1700، CashOut = 300 + 50 = 350، CashNet = 1350
test('figures: SalesGross/SaleReturns on GrandTotal per Blazor arithmetic', async () => {
  const f = await q._test.figures(fakePool, FROM, TO, UNSCOPED);
  assert.equal(f.SalesGross, 1750);
  assert.equal(f.SaleReturns, 200);
  assert.equal(f.SalesNet, 1550);
  assert.equal(f.PurchasesGross, 800);
  assert.equal(f.PurchaseReturns, 50);
  assert.equal(f.PurchasesNet, 750);
  assert.equal(f.Collected, 500);
  assert.equal(f.CashIn, 1700);
  assert.equal(f.CashOut, 350);
  assert.equal(f.CashNet, 1350);
});

test('figures scoped to branch 1: attribution by creator-employee then warehouse; cash limited to branch boxes', async () => {
  const f = await q._test.figures(fakePool, FROM, TO, BRANCH1);
  assert.equal(f.SalesGross, 1000); // A فقط — B للفرع 2، والملغاة مستبعدة، وبلا-الموظف من مخزن الفرع 2
  assert.equal(f.SaleReturns, 200);
  assert.equal(f.SalesNet, 800);
  assert.equal(f.PurchasesGross, 800);
  assert.equal(f.Collected, 500); // دفعتا A والملغاة (كلتاهما منسوبتان للفرع 1 بموظف المنشئ)
  assert.equal(f.CashIn, 1200); // صندوق 1 فقط: 1000 قبض + 200 In
  assert.equal(f.CashOut, 350);
  assert.equal(f.CashNet, 850);
});

test('pipeline branch strip: unscoped returns all branches; branch selected returns only that branch (item 11)', async () => {
  const all = await q._test.pipeline(fakePool, { from: FROM, to: TO }, UNSCOPED, TO);
  assert.deepEqual(all.BranchSales, [
    { Name: 'الفرع الأول', Value: 1000 },
    { Name: 'الفرع الثاني', Value: 750 }, // B 500 + بلا-موظف 250
  ]);
  assert.equal(all.CashBalance, 1650); // (100+200) + 1700 − 350

  const scoped = await q._test.pipeline(fakePool, { from: FROM, to: TO }, BRANCH1, TO);
  assert.deepEqual(scoped.BranchSales, [{ Name: 'الفرع الأول', Value: 1000 }]);
  assert.equal(scoped.CashBalance, 950); // صندوق 1: 100 + 1200 − 350
});
