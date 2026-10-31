// اختبارات مُحاكاة (stubbed) لوحدة المدفوعات — بلا أي قاعدة بيانات حية.
// تُستبدل وحدة core/database بذاكرة وهمية تنفذ دلالات الاستعلامات التي
// تستخدمها payments.queries وtransactions.queries (addPayment/
// getPayments) وclients.queries (getClientAdvances) وadditional-
// charges.queries (getReceipt)، وتدعم المعاملات بلقطة/استرجاع حتى
// تُفحص الذرّية وعدم حدوث كتابات عند الرفض.
// التشغيل: node --test modules/payments/payments.test.js
process.env.AUTH_JWT_SECRET = '<MASKED_SECRET_001>';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── المخزن الوهمي ─────────────────────────────────────────────
// تجهيزة الحساب (fixture arithmetic):
// - فاتورة بيع #1: إجمالي 1000، مدفوع 600 = دفعة 200 (نقدي،
//   2020-01-15) + دفعة 400 (بنكي، اليوم)؛ ودفعة Advance بقيمة 999
//   يجب أن تُستبعد من كل الأسطح (قائمة/سجل/تراكمي/إحصائيات).
// - فاتورة شراء #2: إجمالي 500، مدفوع 0، ودفعة نقدية 100 اليوم
//   بحركة «صرف» في خزينة الفرع #8 (تُستخدم لإحصائيات الشراء فقط؛
//   PaidAmount يبقى 0 في التجهيزة عمدًا لعزل الإحصائيات عن الإنشاء).
// - فاتورة بيع #4 ملغاة بمدفوع 100 لفحص حراس التعديل/الإضافة.
const state = { store: null, writes: [], txLog: [] };
let nextPaymentId;
let nextCashTxId;

const todayStr = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

function resetStore() {
  nextPaymentId = 100;
  nextCashTxId = 900;
  state.writes = [];
  state.txLog = [];
  state.store = {
    invoices: [
      { TransactionID: 1, ReferenceNumber: 'INV-2026-00001', TransactionType: 'Sale', GrandTotal: 1000, PaidAmount: 600, InvoiceStatus: 'PartiallyPaid', PartyID: 10, EmpId: 5 },
      { TransactionID: 2, ReferenceNumber: 'PRC-2026-00002', TransactionType: 'Purchase', GrandTotal: 500, PaidAmount: 0, InvoiceStatus: 'Open', PartyID: 20, EmpId: null },
      { TransactionID: 4, ReferenceNumber: 'INV-2026-00004', TransactionType: 'Sale', GrandTotal: 300, PaidAmount: 100, InvoiceStatus: 'Cancelled', PartyID: 10, EmpId: null },
    ],
    parties: [
      { PartyID: 10, PartyName: 'عميل اختبار', Phone: '0100', Phone2: null, Address: 'المنيل', City: 'القاهرة', Email: null, NationalID: null },
      { PartyID: 20, PartyName: 'مورد اختبار', Phone: '0200', Phone2: null, Address: null, City: null, Email: null, NationalID: null },
    ],
    employees: [{ EmployeeID: 5, FullName: 'موظف اختبار' }],
    cashBoxes: [
      { CashBoxID: 7, CashBoxName: 'الخزينة الرئيسية' },
      { CashBoxID: 8, CashBoxName: 'خزينة الفرع' },
    ],
    payments: [
      { PaymentID: 11, TransactionID: 1, PaymentDate: '2020-01-15', Amount: 200, PaymentMethod: 'Cash', Notes: 'دفعة أولى', CreatedBy: 'admin', CreatedAt: '2020-01-15' },
      { PaymentID: 12, TransactionID: 1, PaymentDate: todayStr(), Amount: 400, PaymentMethod: 'Bank', Notes: 'دفعة ثانية', CreatedBy: 'admin', CreatedAt: todayStr() },
      { PaymentID: 13, TransactionID: 1, PaymentDate: todayStr(), Amount: 999, PaymentMethod: 'Advance', Notes: 'مقدمة', CreatedBy: 'admin', CreatedAt: todayStr() },
      { PaymentID: 14, TransactionID: 2, PaymentDate: todayStr(), Amount: 100, PaymentMethod: 'Cash', Notes: 'سداد مورد', CreatedBy: 'admin', CreatedAt: todayStr() },
    ],
    cashTx: [
      { CashboxTransactionID: 501, CashBoxID: 7, PaymentID: 11, ReferenceID: 1, ReferenceType: 'SaleInvoice', TransactionType: 'قبض', Amount: 200, Notes: 'تحصيل', CreatedBy: 'admin' },
      { CashboxTransactionID: 502, CashBoxID: 7, PaymentID: 12, ReferenceID: 1, ReferenceType: 'SaleInvoice', TransactionType: 'قبض', Amount: 400, Notes: 'تحصيل', CreatedBy: 'admin' },
      { CashboxTransactionID: 503, CashBoxID: 8, PaymentID: 14, ReferenceID: 2, ReferenceType: 'PurchaseInvoice', TransactionType: 'صرف', Amount: 100, Notes: 'سداد', CreatedBy: 'admin' },
    ],
    charges: [
      { ChargeID: 31, PartyID: 10, ChargeType: 'Advance', ChargeDescription: 'دفعة مقدمة', ChargeAmount: 150, Status: 'Paid', TransactionID: null, AppliedToTransactionId: null, Notes: null, CreatedBy: 'admin', CreatedAt: '2026-10-01' },
      { ChargeID: 32, PartyID: 10, ChargeType: 'Advance', ChargeDescription: 'دفعة مطبقة', ChargeAmount: 80, Status: 'Applied', TransactionID: 1, AppliedToTransactionId: null, Notes: null, CreatedBy: 'admin', CreatedAt: '2026-10-02' },
      { ChargeID: 33, PartyID: 20, ChargeType: 'Advance', ChargeDescription: 'دفعة عميل آخر', ChargeAmount: 60, Status: 'Paid', TransactionID: null, AppliedToTransactionId: null, Notes: null, CreatedBy: 'admin', CreatedAt: '2026-10-03' },
      { ChargeID: 34, PartyID: 10, ChargeType: 'Inspection', ChargeDescription: 'رسوم معاينة', ChargeAmount: 250, Status: 'Paid', TransactionID: null, AppliedToTransactionId: null, Notes: null, CreatedBy: 'admin', CreatedAt: '2026-10-04' },
    ],
    audit: [],
  };
}
resetStore();

const inv = (id) => state.store.invoices.find((t) => t.TransactionID === id);
const pay = (id) => state.store.payments.find((p) => p.PaymentID === id);
const party = (id) => state.store.parties.find((p) => p.PartyID === id) || {};
const cashFor = (paymentId) => state.store.cashTx.find((c) => c.PaymentID === paymentId);
const boxName = (boxId) => (state.store.cashBoxes.find((b) => b.CashBoxID === boxId) || {}).CashBoxName || null;

function joinedPaymentRow(p) {
  const t = inv(p.TransactionID);
  const ct = cashFor(p.PaymentID);
  return {
    PaymentID: p.PaymentID, PaymentDate: p.PaymentDate, Amount: p.Amount,
    PaymentMethod: p.PaymentMethod, Notes: p.Notes, CreatedBy: p.CreatedBy, CreatedAt: p.CreatedAt,
    TransactionID: t.TransactionID, InvoiceReferenceNumber: t.ReferenceNumber,
    TransactionType: t.TransactionType, InvoiceGrandTotal: t.GrandTotal,
    InvoicePaidAmount: t.PaidAmount, PartyID: t.PartyID, EmpId: t.EmpId,
    PartyName: party(t.PartyID).PartyName, PartyPhone: party(t.PartyID).Phone,
    CustomerAddress: party(t.PartyID).Address, CustomerCity: party(t.PartyID).City,
    CustomerEmail: party(t.PartyID).Email, CustomerNationalId: party(t.PartyID).NationalID,
    EmpName: t.TransactionType === 'Purchase'
      ? (party(t.EmpId).PartyName || null)
      : ((state.store.employees.find((e) => e.EmployeeID === t.EmpId) || {}).FullName || null),
    CashBoxID: ct ? ct.CashBoxID : null, CashBoxName: ct ? boxName(ct.CashBoxID) : null,
  };
}

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const s = state.store;

  // سجل التدقيق
  if (text.includes('INSERT INTO [dbo].[Audit_Log]')) {
    s.audit.push({ TableName: p.tableName, ActionType: p.actionType, PrimaryKey: p.primaryKey, OldData: p.oldData, NewData: p.newData, Username: p.username });
    state.writes.push({ type: 'audit' });
    return { recordset: [] };
  }
  // حذف حركة خزينة الدفعة (إلغاء)
  if (text.includes('DELETE FROM CashboxTransactions WHERE PaymentID')) {
    s.cashTx = s.cashTx.filter((c) => c.PaymentID !== p.paymentId);
    state.writes.push({ type: 'delete-cashTx', paymentId: p.paymentId });
    return { recordset: [] };
  }
  // حذف الدفعة (إلغاء)
  if (text.includes('DELETE FROM Payments WHERE PaymentID')) {
    s.payments = s.payments.filter((x) => x.PaymentID !== p.paymentId);
    state.writes.push({ type: 'delete-payment', paymentId: p.paymentId });
    return { recordset: [] };
  }
  // تحديث حركة الخزينة في مكانها (تعديل دفعة)
  if (text.includes('UPDATE CashboxTransactions') && text.includes('SET CashBoxID')) {
    for (const c of s.cashTx.filter((x) => x.PaymentID === p.paymentId)) {
      c.CashBoxID = p.cashBoxId; c.Amount = p.amount; c.Notes = p.notes;
    }
    state.writes.push({ type: 'update-cashTx', paymentId: p.paymentId });
    return { recordset: [] };
  }
  // تحديث الدفعة (تعديل)
  if (text.includes('UPDATE Payments') && text.includes('LastModifiedBy')) {
    const row = pay(p.paymentId);
    if (row) { row.Amount = p.amount; row.PaymentMethod = p.paymentMethod; row.Notes = p.notes; }
    state.writes.push({ type: 'update-payment', paymentId: p.paymentId });
    return { recordset: [] };
  }
  // إعادة حساب الفاتورة (المفتاح id أو transactionId بحسب الاستعلام)
  if (text.includes('UPDATE Transactions SET PaidAmount')) {
    const row = inv(p.id ?? p.transactionId);
    if (row) { row.PaidAmount = p.paidAmount; row.InvoiceStatus = p.status; }
    state.writes.push({ type: 'update-invoice-paid', id: p.id ?? p.transactionId });
    return { recordset: [] };
  }
  // إدراج دفعة (addPayment)
  if (text.includes('INSERT INTO Payments')) {
    const row = {
      PaymentID: nextPaymentId++, TransactionID: p.transactionId,
      PaymentDate: p.paymentDate || todayStr(), Amount: p.amount,
      PaymentMethod: p.paymentMethod, Notes: p.notes ?? null,
      CreatedBy: p.createdBy, CreatedAt: todayStr(),
    };
    s.payments.push(row);
    state.writes.push({ type: 'insert-payment', row });
    return { recordset: [{ PaymentID: row.PaymentID }] };
  }
  // إدراج حركة خزينة (addPayment) — الاتجاه حرفي في نص الاستعلام
  if (text.includes('INSERT INTO CashboxTransactions')) {
    const row = {
      CashboxTransactionID: nextCashTxId++, CashBoxID: p.cashBoxId,
      PaymentID: p.paymentId, ReferenceID: p.transactionId,
      ReferenceType: text.includes('SaleInvoice') ? 'SaleInvoice' : 'PurchaseInvoice',
      TransactionType: text.includes("N'قبض'") ? 'قبض' : 'صرف',
      Amount: p.amount, Notes: p.notes, CreatedBy: p.createdBy,
    };
    s.cashTx.push(row);
    state.writes.push({ type: 'insert-cashTx', row });
    return { recordset: [] };
  }
  // تحميل دفعة مقفلة (إلغاء/تعديل)
  if (text.includes('FROM Payments WITH (UPDLOCK')) {
    const row = pay(p.id);
    return { recordset: row ? [{ ...row }] : [] };
  }
  // تحميل فاتورة مقفلة (إلغاء/تعديل/addPayment)
  if (text.includes('FROM Transactions WITH (UPDLOCK')) {
    const row = inv(p.id);
    return { recordset: row ? [{ ...row }] : [] };
  }
  // نوع فاتورة (بوابات)
  if (text.includes('SELECT TransactionID, TransactionType, InvoiceStatus FROM Transactions')) {
    const row = inv(p.id);
    return { recordset: row ? [{ TransactionID: row.TransactionID, TransactionType: row.TransactionType, InvoiceStatus: row.InvoiceStatus }] : [] };
  }
  // نوع فاتورة دفعة (بوابة التعديل)
  if (text.includes('SELECT t.TransactionType, t.InvoiceStatus')) {
    const row = pay(p.id);
    if (!row) return { recordset: [] };
    const t = inv(row.TransactionID);
    return { recordset: [{ TransactionType: t.TransactionType, InvoiceStatus: t.InvoiceStatus }] };
  }
  // قائمة المدفوعات (COUNT OVER)
  if (text.includes('COUNT(*) OVER()')) {
    let rows = s.payments
      .filter((x) => inv(x.TransactionID).TransactionType === p.type && x.PaymentMethod !== 'Advance')
      .map(joinedPaymentRow);
    if (p.search) {
      const needle = String(p.search).replace(/%/g, '');
      rows = rows.filter((r) => (r.InvoiceReferenceNumber || '').includes(needle)
        || (r.PartyName || '').includes(needle) || (r.PartyPhone || '').includes(needle));
    }
    if (p.method) rows = rows.filter((r) => r.PaymentMethod === p.method);
    if (p.partyId) rows = rows.filter((r) => r.PartyID === p.partyId);
    if (p.cashBoxId) rows = rows.filter((r) => r.CashBoxID === p.cashBoxId);
    if (p.from) rows = rows.filter((r) => new Date(r.PaymentDate) >= new Date(p.from));
    if (p.to) rows = rows.filter((r) => new Date(r.PaymentDate) < new Date(p.to));
    rows.sort((a, b) => String(b.PaymentDate).localeCompare(String(a.PaymentDate)) || b.PaymentID - a.PaymentID);
    const total = rows.length;
    const m = text.match(/OFFSET (\d+) ROWS FETCH NEXT (\d+)/);
    const off = m ? Number(m[1]) : 0; const ps = m ? Number(m[2]) : total;
    return { recordset: rows.slice(off, off + ps).map((r) => ({ ...r, TotalRows: total })) };
  }
  // التراكمي: كل دفعات الفواتير المطلوبة
  if (text.includes('SELECT PaymentID, TransactionID, Amount FROM Payments')) {
    const m = text.match(/TransactionID IN \(([^)]+)\)/);
    const ids = m ? m[1].split(',').map((x) => Number(x.trim())) : [];
    const rows = s.payments
      .filter((x) => ids.includes(x.TransactionID) && x.PaymentMethod !== 'Advance')
      .sort((a, b) => String(a.PaymentDate).localeCompare(String(b.PaymentDate)) || a.PaymentID - b.PaymentID)
      .map((x) => ({ PaymentID: x.PaymentID, TransactionID: x.TransactionID, Amount: x.Amount }));
    return { recordset: rows };
  }
  // إحصائيات: صفوف خام
  if (text.includes('SELECT p.PaymentID, p.Amount, p.PaymentDate, p.PaymentMethod')) {
    let rows = s.payments.filter((x) => inv(x.TransactionID).TransactionType === p.type && x.PaymentMethod !== 'Advance');
    if (p.from) rows = rows.filter((r) => new Date(r.PaymentDate) >= new Date(p.from));
    if (p.to) rows = rows.filter((r) => new Date(r.PaymentDate) < new Date(p.to));
    return { recordset: rows.map((x) => ({ PaymentID: x.PaymentID, Amount: x.Amount, PaymentDate: x.PaymentDate, PaymentMethod: x.PaymentMethod })) };
  }
  // إحصائيات: تفصيل الخزينة
  if (text.includes('GROUP BY ct.CashBoxID')) {
    const groups = new Map();
    for (const c of s.cashTx) {
      const pm = pay(c.PaymentID);
      if (!pm || pm.PaymentMethod === 'Advance') continue;
      if (inv(pm.TransactionID).TransactionType !== p.type) continue;
      const g = groups.get(c.CashBoxID) || { CashBoxID: c.CashBoxID, CashBoxName: boxName(c.CashBoxID), Count: 0, Total: 0 };
      g.Count += 1; g.Total += Number(c.Amount);
      groups.set(c.CashBoxID, g);
    }
    return { recordset: [...groups.values()] };
  }
  // سجل دفعات فاتورة (transactions.getPayments)
  if (text.includes('FROM Payments p') && text.includes('@transactionId')) {
    const t = inv(p.transactionId);
    const rows = s.payments
      .filter((x) => x.TransactionID === p.transactionId && x.PaymentMethod !== 'Advance')
      .sort((a, b) => String(b.PaymentDate).localeCompare(String(a.PaymentDate)))
      .map((x) => ({ ...joinedPaymentRow(x), GrandTotal: t.GrandTotal }));
    // الشكل الذي تتوقعه الاستعلامات: أعمدة الدفعة + GrandTotal + الخزينة
    return {
      recordset: rows.map((r) => ({
        PaymentID: r.PaymentID, PaymentDate: r.PaymentDate, Amount: r.Amount,
        PaymentMethod: r.PaymentMethod, Notes: r.Notes, CreatedBy: r.CreatedBy,
        CreatedAt: r.CreatedAt, GrandTotal: r.GrandTotal,
        CashBoxID: r.CashBoxID, CashBoxName: r.CashBoxName,
      })),
    };
  }
  // دفعة واحدة (سند/عرض)
  if (text.includes('WHERE p.PaymentID = @id')) {
    const row = pay(p.id);
    return { recordset: row ? [joinedPaymentRow(row)] : [] };
  }
  // بيانات الشركة
  if (text.includes('FROM CompanyInfo')) {
    return { recordset: [{ CompanyName: 'COCOBOLO TEST', Phone1: '123', Phone2: null, Address: 'القاهرة', TaxNumber: '999', InfoEmail: null, LogoPath: null }] };
  }
  // تحليل الشرائح: رأس الفاتورة
  if (text.includes('SELECT TransactionID, ReferenceNumber, GrandTotal, PaidAmount FROM Transactions')) {
    const row = inv(p.id);
    return { recordset: row ? [{ TransactionID: row.TransactionID, ReferenceNumber: row.ReferenceNumber, GrandTotal: row.GrandTotal, PaidAmount: row.PaidAmount }] : [] };
  }
  // دفعات العميل المقدمة (clients)
  if (text.includes('FROM AdditionalCharges c') && text.includes('c.PartyID = @partyId')) {
    let rows = s.charges.filter((c) => c.PartyID === p.partyId);
    if (text.includes('AND c.TransactionID IS NULL')) rows = rows.filter((c) => c.TransactionID == null);
    rows = [...rows].sort((a, b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)));
    return {
      recordset: rows.map((c) => ({
        ChargeID: c.ChargeID, ChargeId: c.ChargeID, PartyId: c.PartyID,
        ChargeType: c.ChargeType, ChargeDescription: c.ChargeDescription,
        ChargeAmount: c.ChargeAmount, RemainingAmount: c.ChargeAmount,
        Notes: c.Notes, CreatedBy: c.CreatedBy, CreatedAt: c.CreatedAt,
        IsApplied: c.TransactionID == null ? 0 : 1,
        AppliedToTransactionId: c.TransactionID,
        AppliedToReferenceNumber: c.TransactionID ? inv(c.TransactionID).ReferenceNumber : null,
      })),
    };
  }
  // رسم واحد (additional-charges getCharge → getReceipt)
  if (text.includes('FROM AdditionalCharges c') && text.includes('WHERE c.ChargeID = @id')) {
    const c = s.charges.find((x) => x.ChargeID === p.id);
    if (!c) return { recordset: [] };
    return {
      recordset: [{
        ...c, PartyName: party(c.PartyID).PartyName, PartyPhone: party(c.PartyID).Phone,
        PartyAddress: party(c.PartyID).Address, PartyCity: party(c.PartyID).City, PartyEmail: party(c.PartyID).Email,
        TransactionRef: c.TransactionID ? inv(c.TransactionID).ReferenceNumber : null,
        AppliedToTransactionRef: null, CashboxTransactionID: null, CashBoxID: null,
        CashBoxName: null, ReceiptDate: c.CreatedAt, IsLocked: 0, IsDeliveryModification: 0,
        QuotationID: null, SourceDeliveryId: null,
      }],
    };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 160)}`);
}

class FakeRequest {
  constructor(_txOrPool) { this.params = {}; }
  input(name, _type, value) { this.params[name] = value; return this; }
  async query(text) { return executeQuery(text, this.params); }
}
class FakeTransaction {
  constructor(_pool) { this.snapshot = null; }
  async begin() { this.snapshot = structuredClone(state.store); state.txLog.push('begin'); }
  async commit() { this.snapshot = null; state.txLog.push('commit'); }
  async rollback() { if (this.snapshot) state.store = this.snapshot; this.snapshot = null; state.txLog.push('rollback'); }
  request() { return new FakeRequest(this); }
}
const fakePool = { request: () => new FakeRequest(null) };
const fakeSql = {
  Int: 'Int', DateTime: 'DateTime', Date: 'Date', Bit: 'Bit', MAX: 'MAX',
  NVarChar: () => 'NVarChar', VarChar: () => 'VarChar', Decimal: () => 'Decimal',
  Transaction: FakeTransaction, Request: FakeRequest,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const notifPath = require.resolve('../notifications/notifications.queries');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: { createNotificationSmart: async () => {}, createNotification: async () => {} },
};

const q = require('./payments.queries');
const ctrl = require('./payments.controller');
const txq = require('../transactions/transactions.queries');
const clientsQ = require('../clients/clients.queries');
const chargesQ = require('../additional-charges/additional-charges.queries');
const policies = require('../../shared/authorization.policy');

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
const auth = (role, claims = []) => ({ userId: 1, username: 'tester', role, claims: new Set(claims) });

// ── القائمة: استبعاد Advance + النسبة التراكمية ────────────────────
test('list: excludes Advance; cumulative % per payment within its invoice', async () => {
  resetStore();
  const data = await q.getPayments({ type: 'Sale' });
  assert.equal(data.totalCount, 2); // 200 + 400 فقط؛ Advance ‏999 مستبعدة
  const byId = new Map(data.items.map((i) => [i.PaymentID, i]));
  assert.ok(!byId.has(13));
  // تراكمي: الأولى 200/1000 = 20%، والثانية (200+400)/1000 = 60%
  assert.equal(byId.get(11).Percentage, 20);
  assert.equal(byId.get(12).Percentage, 60);
  assert.equal(byId.get(12).ReceiptNumber, `RCV-${new Date().getFullYear()}-00012`);
  assert.equal(byId.get(12).CashBoxName, 'الخزينة الرئيسية');
  assert.equal(byId.get(12).PartyName, 'عميل اختبار');
});

test('list: method filter + purchase tab', async () => {
  resetStore();
  const cash = await q.getPayments({ type: 'Sale', method: 'Cash' });
  assert.deepEqual(cash.items.map((i) => i.PaymentID), [11]);
  const purchases = await q.getPayments({ type: 'Purchase' });
  assert.deepEqual(purchases.items.map((i) => i.PaymentID), [14]);
  assert.equal(purchases.items[0].Percentage, 20); // 100/500
});

// ── الإحصائيات بالطريقة والخزينة ───────────────────────────────────
test('stats: totals/today/month + by-method + by-cashbox, Advance excluded', async () => {
  resetStore();
  const sale = await q.getStats({ type: 'Sale' });
  assert.equal(sale.TotalCount, 2);
  assert.equal(sale.TotalAmount, 600);
  assert.equal(sale.TodayCount, 1); // دفعة اليوم البنكية فقط
  assert.equal(sale.TodayAmount, 400);
  assert.equal(sale.MonthCount, 1);
  assert.equal(sale.MonthAmount, 400);
  const methods = Object.fromEntries(sale.MethodBreakdown.map((m) => [m.PaymentMethod, m]));
  assert.equal(methods.Cash.Total, 200);
  assert.equal(methods.Bank.Total, 400);
  assert.equal(methods.Bank.PaymentMethodAr, 'تحويل بنكى');
  assert.deepEqual(sale.CashBoxBreakdown, [
    { CashBoxId: 7, CashBoxName: 'الخزينة الرئيسية', Count: 2, Total: 600 },
  ]);
  const purchase = await q.getStats({ type: 'Purchase' });
  assert.equal(purchase.TotalAmount, 100);
  assert.deepEqual(purchase.CashBoxBreakdown, [
    { CashBoxId: 8, CashBoxName: 'خزينة الفرع', Count: 1, Total: 100 },
  ]);
});

// ── إلغاء دفعة: حذف الحركة + إعادة الحساب ذرّيًا ───────────────────
test('cancel: deletes payment + its cashbox movement and recomputes PaidAmount/status atomically', async () => {
  resetStore();
  // قبل: مدفوع 600 (200+400) وحالة PartiallyPaid؛ إلغاء الـ400 يعيد
  // المدفوع إلى 200 ويبقي الحالة PartiallyPaid ويحذف الحركة 502.
  const r = await q.cancelPayment(12, 'خطأ في التحصيل', 'admin');
  assert.equal(r.newPaidAmount, 200);
  assert.equal(pay(12), undefined);
  assert.equal(cashFor(12), undefined);
  assert.equal(inv(1).PaidAmount, 200);
  assert.equal(inv(1).InvoiceStatus, 'PartiallyPaid');
  assert.ok(state.txLog.includes('commit'));
  const audit = state.store.audit.find((a) => a.ActionType === 'Cancel');
  assert.ok(audit);
  assert.equal(JSON.parse(audit.NewData).Reason, 'خطأ في التحصيل');
});

test('cancel controller: reason is required (400, zero writes)', async () => {
  resetStore();
  const res = mockRes();
  await ctrl.remove({ params: { id: '12' }, body: {}, auth: auth('Admin') }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(pay(12));
  assert.equal(state.writes.length, 0);
});

// ── بوابة الإلغاء: Delete فقط (مصفوفة بلازور) ──────────────────────
test('cancel gate matrix: frm_Payments:Delete holder passes; AccountManager WITHOUT the claim fails', () => {
  assert.equal(policies.payments.canDelete(auth('Admin')), true);
  assert.equal(policies.payments.canDelete(auth('User', ['frm_Payments:Delete'])), true);
  assert.equal(policies.payments.canDelete(auth('AccountManager')), false);
  assert.equal(policies.payments.canDelete(auth('Account')), false);
  // مدير الحسابات ينشئ/يعدّل بالدور، لكنه لا يلغي بلا الادعاء
  assert.equal(policies.payments.canCreate(auth('AccountManager'), false), true);
  assert.equal(policies.payments.canEdit(auth('AccountManager'), true), true);
  // Sales للبيع فقط، وB2B مستبعد من الكتابة
  assert.equal(policies.payments.canCreate(auth('Sales'), false), true);
  assert.equal(policies.payments.canCreate(auth('Sales'), true), false);
  assert.equal(policies.payments.canCreate(auth('B2B', ['frm_Payments:Add']), false), false);
  assert.equal(policies.payments.canView(auth('User', ['frm_Payments:View'])), true);
  assert.equal(policies.payments.canView(auth('AccountManager')), false);
});

// ── تعديل دفعة: الحد = المتبقي + القديمة ───────────────────────────
test('edit cap = current remaining + old amount: accept at cap, reject above', async () => {
  resetStore();
  // فاتورة #1: متبقي حالي 400 + مبلغ الدفعة #11 القديم 200 = حد 600.
  const ok = await q.updatePayment(11, { amount: 600, cashBoxId: 8, paymentMethod: 'Visa', notes: 'تعديل' }, 'admin');
  assert.equal(ok.newPaidAmount, 1000); // 600 − 200 + 600
  assert.equal(inv(1).InvoiceStatus, 'Paid');
  assert.equal(pay(11).Amount, 600);
  // حركة الخزينة قائمة وتُحدَّث في مكانها: نفس الصف 501 بخزينة/مبلغ جديدين
  const movement = cashFor(11);
  assert.equal(movement.CashboxTransactionID, 501);
  assert.equal(movement.CashBoxID, 8);
  assert.equal(movement.Amount, 600);

  resetStore();
  await assert.rejects(
    q.updatePayment(11, { amount: 601, cashBoxId: 7 }, 'admin'),
    (e) => e.statusCode === 400,
  );
  assert.equal(pay(11).Amount, 200); // لا كتابة بعد الرفض (استرجاع)
  assert.equal(inv(1).PaidAmount, 600);
});

test('edit: cancelled invoice is refused', async () => {
  resetStore();
  state.store.payments.push({ PaymentID: 15, TransactionID: 4, PaymentDate: todayStr(), Amount: 100, PaymentMethod: 'Cash', Notes: null, CreatedBy: 'admin', CreatedAt: todayStr() });
  await assert.rejects(
    q.updatePayment(15, { amount: 50, cashBoxId: 7 }, 'admin'),
    (e) => e.statusCode === 400 && /ملغية/.test(e.message),
  );
});

// ── السند: الترقيم + التفقيط من خوارزمية بلازور ────────────────────
test('receipt numbers RCV-/PMT- and tafqeet sample from the Blazor algorithm', async () => {
  assert.equal(q.generateReceiptNumber(7, 'Sale', '2026-03-01'), 'RCV-2026-00007');
  assert.equal(q.generateReceiptNumber(7, 'Purchase', '2026-03-01'), 'PMT-2026-00007');
  // 1234.56 ببلازور: ألف و مائتان و أربعة و ثلاثون جنيه و ستة و خمسون قرشاً
  assert.equal(
    q.convertNumberToArabicWords(1234.56),
    'ألف و مائتان و أربعة و ثلاثون جنيه و ستة و خمسون قرشاً فقط لا غير',
  );
  assert.equal(q.convertNumberToArabicWords(0), 'صفر جنيه فقط لا غير');
  assert.equal(q.convertNumberToArabicWords(200), 'مائتان جنيه فقط لا غير');
  resetStore();
  const receipt = await q.getReceipt(11);
  assert.equal(receipt.ReceiptNumber, 'RCV-2020-00011');
  assert.equal(receipt.ReceiptTypeAr, 'سند قبض');
  assert.equal(receipt.AmountInWords, 'مائتان جنيه فقط لا غير');
  const purchaseReceipt = await q.getReceipt(14);
  assert.equal(purchaseReceipt.ReceiptTypeAr, 'سند صرف');
  assert.ok(purchaseReceipt.ReceiptNumber.startsWith('PMT-'));
});

// ── تحليل الشرائح 70/20/10 ─────────────────────────────────────────
test('analysis: 70/20/10 tiers with paid allocation and full-pay description', async () => {
  resetStore();
  const a = await q.getAnalysis(1, 400);
  assert.equal(a.GrandTotal, 1000);
  assert.equal(a.PaidBefore, 600);
  assert.equal(a.Remaining, 400);
  assert.deepEqual(a.Tiers.map((t) => [t.Amount, t.AmountPaid, t.Status]), [
    [700, 600, 'Partial'], [200, 0, 'Pending'], [100, 0, 'Pending'],
  ]);
  // 400 = المتبقي كله: تخصيص 100 للأولى + 200 للثانية + 100 للثالثة
  assert.deepEqual(a.CurrentPaymentAnalysis.Allocations.map((x) => x.AmountAllocated), [100, 200, 100]);
  assert.equal(a.CurrentPaymentAnalysis.Description, ' ستسدد الفاتورة بالكامل بهذه الدفعة');
});

// ── addPayment: الخزينة/الطريقة/الاتجاه ────────────────────────────
test('create without cashBoxId → 400 «يرجى اختيار الخزينة» with ZERO writes', async () => {
  resetStore();
  await assert.rejects(
    txq.addPayment({ transactionId: 1, amount: 100, createdBy: 'admin' }),
    (e) => e.statusCode === 400 && e.message.includes('يرجى اختيار الخزينة'),
  );
  assert.equal(state.writes.length, 0);
  assert.equal(state.store.payments.length, 4);
  assert.equal(inv(1).PaidAmount, 600);
});

test("paymentMethod 'Advance' (or unknown) → 400 with zero writes", async () => {
  resetStore();
  await assert.rejects(
    txq.addPayment({ transactionId: 1, amount: 100, cashBoxId: 7, paymentMethod: 'Advance', createdBy: 'admin' }),
    (e) => e.statusCode === 400,
  );
  await assert.rejects(
    txq.addPayment({ transactionId: 1, amount: 100, cashBoxId: 7, paymentMethod: 'Cheque', createdBy: 'admin' }),
    (e) => e.statusCode === 400,
  );
  assert.equal(state.writes.filter((w) => w.type === 'insert-payment').length, 0);
});

test('purchase-invoice payment writes a صرف movement; sale writes قبض', async () => {
  resetStore();
  const pid = await txq.addPayment({ transactionId: 2, amount: 100, cashBoxId: 8, paymentMethod: 'Bank', createdBy: 'admin' });
  const movement = cashFor(pid);
  assert.equal(movement.TransactionType, 'صرف');
  assert.equal(movement.ReferenceType, 'PurchaseInvoice');
  assert.equal(inv(2).PaidAmount, 100);
  assert.equal(inv(2).InvoiceStatus, 'PartiallyPaid');

  const pid2 = await txq.addPayment({ transactionId: 1, amount: 100, cashBoxId: 7, createdBy: 'admin' });
  assert.equal(cashFor(pid2).TransactionType, 'قبض');
  assert.equal(cashFor(pid2).ReferenceType, 'SaleInvoice');
  assert.equal(pay(pid2).PaymentMethod, 'Cash'); // الافتراضي عند الغياب
});

// ── سجل دفعات الفاتورة: استبعاد Advance + اسم الخزينة + النسبة ─────
test('invoice history: excludes Advance, joins CashBoxName, per-payment percentage', async () => {
  resetStore();
  const rows = await txq.getPayments(1);
  assert.deepEqual(rows.map((r) => r.PaymentID).sort(), [11, 12]);
  const first = rows.find((r) => r.PaymentID === 11);
  assert.equal(first.CashBoxName, 'الخزينة الرئيسية');
  assert.equal(first.Percentage, 20); // 200/1000 — نسبة الدفعة نفسها (سجل بلازور)
  assert.equal(rows.find((r) => r.PaymentID === 12).Percentage, 40);
});

// ── دفعات العميل المقدمة ───────────────────────────────────────────
test("clients advances: only that customer's unapplied advances, with remaining amounts", async () => {
  resetStore();
  const rows = await clientsQ.getClientAdvances(10, { unappliedOnly: true });
  assert.deepEqual(rows.map((r) => r.ChargeID).sort(), [31, 34]);
  const adv = rows.find((r) => r.ChargeID === 31);
  assert.equal(adv.ChargeAmount, 150);
  assert.equal(adv.RemainingAmount, 150);
  assert.equal(adv.IsApplied, 0);
  const all = await clientsQ.getClientAdvances(10, { unappliedOnly: false });
  assert.deepEqual(all.map((r) => r.ChargeID).sort(), [31, 32, 34]);
});

// ── إيصال الرسوم الإضافية: التفقيط + العنوان/التصنيف ────────────────
test('additional-charge receipt: tafqeet + title/category mirror Blazor', async () => {
  resetStore();
  const receipt = await chargesQ.getReceipt(34); // رسوم معاينة 250
  assert.equal(receipt.ReceiptNumber, 'INS-2026-000034');
  assert.equal(receipt.ReceiptTitle, 'إيصال استلام رسوم معاينة');
  assert.equal(receipt.ReceiptCategoryLabel, 'رسوم معاينة');
  assert.equal(receipt.ReceiptTypeAr, 'سند قبض');
  assert.equal(receipt.AmountInWords, 'مائتان و خمسون جنيه فقط لا غير');
});
