// اختبارات مُحاكاة (stubbed) لوحدة دفعات خارج الراتب — بلا قاعدة حية.
// تُستبدل core/database بذاكرة وهمية تنفّذ دلالات الاستعلامات المستخدمة
// (بما فيها CHARINDEX الحرفي للوسم [OFFPAYROLL] — لا دلالات LIKE)،
// وتدعم المعاملات بلقطة/استرجاع لفحص الذرّية وعدم الكتابة عند الرفض.
// التشغيل: node --test modules/off-payroll/off-payroll.test.js
process.env.AUTH_JWT_SECRET = 'offpayroll-tests-'.padEnd(40, 'k');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const state = { store: null, txLog: [] };
let nextRunId; let nextPayrollId; let nextDetailId; let nextInstId; let nextCashTxId;

function netOf(p) {
  return (Number(p.BasicSalary || 0) + Number(p.BonusInPayroll || 0)) - Number(p.Deductions || 0);
}

function resetStore() {
  nextRunId = 60; nextPayrollId = 600; nextDetailId = 700; nextInstId = 3000; nextCashTxId = 9000;
  state.txLog = [];
  state.store = {
    employees: [{ EmployeeID: 1, FullName: 'أحمد اختبار', Department: 'الإنتاج', JobTitle: 'فني' }],
    cashBoxes: [{ CashBoxID: 10, CashBoxName: 'الخزينة الرئيسية', OpeningBalance: 1000 }],
    runs: [{ RunID: 50, PayrollMonth: '2026-10', Status: 'PendingReview', Notes: '[OFFPAYROLL] دفعة خارج الراتب للموظف أحمد اختبار', TotalEmployees: 1, TotalGross: 1000, TotalDeductions: 0, TotalNet: 1000, CreatedBy: 'admin', CreatedAt: '2026-10-05' }],
    payrolls: [
      // دفعة خارج راتب بشكل بلازور: أساسي صفر والمبلغ في البند المنفصل
      {
        PayrollID: 500, EmployeeID: 1, PayrollMonth: '2026-10', BasicSalary: 0, BonusInPayroll: 0,
        Allowances: 0, Deductions: 0, LoanDeduction: 0, PaymentStatus: 'معتمد', PaymentDate: null,
        CashboxTransactionID: null, PayrollRunID: 50, CreatedBy: 'admin', CreatedAt: '2026-10-05',
        Notes: '[OFFPAYROLL]\n[نوع العملية] مكافأة منفصلة\n[الموظف] أحمد اختبار\n[الوصف] مكافأة أداء\n[المبلغ] 1000.00 جـ',
      },
      // راتب شهري عادي ملحوظته فيها أحرف لاتينية (اسم مستخدم) — فخّ نمط
      // LIKE القديم: لا يجوز أن يظهر في أي سطح خارج راتب
      {
        PayrollID: 501, EmployeeID: 1, PayrollMonth: '2026-10', BasicSalary: 6000, BonusInPayroll: 0,
        Allowances: 0, Deductions: 500, LoanDeduction: 0, PaymentStatus: 'قيد المراجعة', PaymentDate: null,
        CashboxTransactionID: null, PayrollRunID: null, CreatedBy: 'admin', CreatedAt: '2026-10-06',
        Notes: 'راتب شهري — prepared by payroll admin (Oct)',
      },
    ],
    details: [
      { PayrollDetailID: 70, PayrollID: 500, DetailType: 'BonusSeparate', DetailDescription: 'مكافأة أداء', Amount: 1000, IsDeduction: 0, PaymentType: 'Separate', CashboxTransactionID: null, CreatedBy: 'admin', CreatedAt: '2026-10-05' },
    ],
    loans: [
      { LoanId: 100, EmployeeId: 1, LoanAmount: 1200, TotalInstallments: 3, PaidInstallments: 1, RemainingAmount: 800, Status: 'Active', LastUpdatedAt: null },
    ],
    installments: [
      { InstallmentId: 1000, LoanId: 100, EmployeeId: 1, InstallmentNumber: 1, DeductionMonth: '2026-11', Amount: 400, Status: 'Pending', DeductionDate: null, Notes: null },
      { InstallmentId: 1001, LoanId: 100, EmployeeId: 1, InstallmentNumber: 2, DeductionMonth: '2026-12', Amount: 400, Status: 'Pending', DeductionDate: null, Notes: null },
      { InstallmentId: 1002, LoanId: 100, EmployeeId: 1, InstallmentNumber: 3, DeductionMonth: '2027-01', Amount: 400, Status: 'Pending', DeductionDate: null, Notes: null },
    ],
    cashTx: [],
    audit: [],
  };
}
resetStore();

const marker = (notes) => !!notes && notes.includes('[OFFPAYROLL]');

function filteredPayrolls(p) {
  const s = state.store;
  let rows = s.payrolls.filter((r) => marker(r.Notes));
  if (p.month) rows = rows.filter((r) => r.PayrollMonth === p.month);
  if (p.employeeId) rows = rows.filter((r) => r.EmployeeID === p.employeeId);
  if (p.status) rows = rows.filter((r) => r.PaymentStatus === p.status);
  if (p.paymentType) rows = rows.filter((r) => s.details.some((d) => d.PayrollID === r.PayrollID && d.PaymentType === 'Separate' && d.DetailType === p.paymentType));
  if (p.search) {
    const needle = p.search.replace(/%/g, '');
    rows = rows.filter((r) => {
      const e = s.employees.find((x) => x.EmployeeID === r.EmployeeID) || {};
      return (e.FullName || '').includes(needle) || (e.Department || '').includes(needle)
        || (r.Notes || '').includes(needle)
        || s.details.some((d) => d.PayrollID === r.PayrollID && ((d.DetailDescription || '').includes(needle) || (d.DetailType || '').includes(needle)));
    });
  }
  return rows;
}

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const s = state.store;

  // ── إدراجات ──
  if (text.includes('INSERT INTO PayrollRuns')) {
    const run = { RunID: nextRunId++, PayrollMonth: p.month, Status: 'PendingReview', Notes: p.notes, TotalEmployees: 1, TotalGross: p.amount, TotalDeductions: 0, TotalNet: p.amount, CreatedBy: p.user, CreatedAt: 'NOW' };
    s.runs.push(run);
    return { recordset: [{ RunID: run.RunID }] };
  }
  if (text.includes('INSERT INTO PayrollDetails')) {
    const d = { PayrollDetailID: nextDetailId++, PayrollID: p.payrollId, DetailType: p.detailType, DetailDescription: p.description, Amount: p.amount, IsDeduction: 0, PaymentType: 'Separate', CashboxTransactionID: null, CreatedBy: p.user, CreatedAt: 'NOW' };
    s.details.push(d);
    return { recordset: [] };
  }
  if (text.includes('INSERT INTO Payroll (')) {
    const row = {
      PayrollID: nextPayrollId++, EmployeeID: p.empId, PayrollMonth: p.month, BasicSalary: 0, BonusInPayroll: 0,
      Allowances: 0, Deductions: 0, LoanDeduction: 0, PaymentStatus: 'قيد المراجعة', PaymentDate: null,
      CashboxTransactionID: null, PayrollRunID: p.runId, CreatedBy: p.user, CreatedAt: 'NOW', Notes: p.notes,
    };
    s.payrolls.push(row);
    return { recordset: [{ PayrollID: row.PayrollID }] };
  }
  if (text.includes('INSERT INTO CashboxTransactions')) {
    const row = { CashboxTransactionID: nextCashTxId++, CashBoxID: p.cashBoxId, TransactionType: 'صرف', ReferenceType: text.includes('@referenceType') ? p.referenceType : 'Payroll', ReferenceID: p.referenceId, Amount: p.amount, Notes: p.notes, CreatedBy: p.createdBy };
    s.cashTx.push(row);
    return { recordset: [{ CashboxTransactionID: row.CashboxTransactionID }] };
  }
  if (text.includes('INSERT INTO LoanInstallments')) {
    const row = { InstallmentId: nextInstId++, LoanId: p.loanId, EmployeeId: p.employeeId, InstallmentNumber: p.number, DeductionMonth: p.month, Amount: p.amount, Status: 'Pending', DeductionDate: null, Notes: p.notes };
    s.installments.push(row);
    return { recordset: [] };
  }
  if (text.includes('INSERT INTO Audit_Log')) {
    s.audit.push({ id: p.id, user: p.user, text });
    return { recordset: [] };
  }

  // ── تحميل صف راتب (مشترك: المقاصة + محرك الرفض/الإلغاء) ──
  if (text.includes('SELECT p.*, e.FullName AS EmployeeName')) {
    const row = s.payrolls.find((r) => r.PayrollID === p.id);
    if (!row) return { recordset: [] };
    const e = s.employees.find((x) => x.EmployeeID === row.EmployeeID) || {};
    return { recordset: [{ ...row, NetSalary: netOf(row), EmployeeName: e.FullName }] };
  }
  // ── وجود الموظف عند الإنشاء ──
  if (text.includes('SELECT EmployeeID, FullName FROM Employees')) {
    const e = s.employees.find((x) => x.EmployeeID === p.empId);
    return { recordset: e ? [e] : [] };
  }
  // ── قائمة خارج الراتب (OUTER APPLY) وعدّها ──
  if (text.includes('OUTER APPLY')) {
    let rows = filteredPayrolls(p).map((r) => {
      const e = s.employees.find((x) => x.EmployeeID === r.EmployeeID) || {};
      const seps = s.details.filter((d) => d.PayrollID === r.PayrollID && d.PaymentType === 'Separate');
      const first = seps[0];
      return {
        PayrollID: r.PayrollID, EmployeeID: r.EmployeeID, PayrollMonth: r.PayrollMonth,
        PaymentStatus: r.PaymentStatus, Notes: r.Notes, CreatedBy: r.CreatedBy,
        RequestedAt: r.CreatedAt, PaidAt: r.PaymentDate,
        EmployeeName: e.FullName, Department: e.Department, JobTitle: e.JobTitle,
        PaymentType: first?.DetailType ?? null, Description: first?.DetailDescription ?? null,
        Amount: seps.reduce((sum, d) => sum + Number(d.Amount), 0),
      };
    });
    rows = rows.slice().sort((a, b) => String(b.RequestedAt).localeCompare(String(a.RequestedAt)));
    const mOff = text.match(/OFFSET (\d+) ROWS FETCH NEXT (\d+)/);
    if (mOff) rows = rows.slice(Number(mOff[1]), Number(mOff[1]) + Number(mOff[2]));
    return { recordset: rows };
  }
  if (text.includes('COUNT(*) AS Total') && text.includes('FROM Payroll p')) {
    return { recordset: [{ Total: filteredPayrolls(p).length }] };
  }
  // ── إحصاءات: عدّادات ثم مجموع البنود ──
  if (text.includes('ReviewCount')) {
    const rows = filteredPayrolls(p);
    const count = (st) => rows.filter((r) => r.PaymentStatus === st).length;
    return { recordset: [{ ReviewCount: count('قيد المراجعة'), ApprovedCount: count('معتمد'), PaidCount: count('مدفوع'), RejectedCount: count('مرفوض'), CancelledCount: count('ملغي') }] };
  }
  if (text.includes('TotalAmount') && text.includes('PayrollDetails')) {
    const rows = filteredPayrolls(p);
    const total = rows.reduce((sum, r) => sum + s.details.filter((d) => d.PayrollID === r.PayrollID && d.PaymentType === 'Separate').reduce((x, d) => x + Number(d.Amount), 0), 0);
    return { recordset: [{ TotalAmount: total }] };
  }
  // ── أقساط المقاصة IN (...) — قبل فرع الأقساط المعلّقة (نفس الجدول) ──
  if (text.includes('WHERE li.InstallmentId IN')) {
    const ids = Object.keys(p).filter((k) => /^id\d+$/.test(k)).map((k) => p[k]);
    const rows = s.installments.filter((i) => ids.includes(i.InstallmentId)).map((i) => ({ ...i, LoanStatus: s.loans.find((l) => l.LoanId === i.LoanId)?.Status }));
    return { recordset: rows };
  }
  // ── أقساط معلّقة ──
  if (text.includes('FROM LoanInstallments li')) {
    const rows = s.installments
      .filter((i) => i.EmployeeId === p.employeeId && i.Status === 'Pending' && s.loans.find((l) => l.LoanId === i.LoanId)?.Status === 'Active')
      .sort((a, b) => a.DeductionMonth.localeCompare(b.DeductionMonth) || a.InstallmentNumber - b.InstallmentNumber)
      .map((i) => ({ ...i }));
    return { recordset: rows };
  }
  // ── بنود منفصلة غير مدفوعة (مسارا الصرف) ──
  if (text.includes('FROM PayrollDetails') && text.includes('CashboxTransactionID IS NULL')) {
    return { recordset: s.details.filter((d) => d.PayrollID === p.payrollId && d.PaymentType === 'Separate' && d.CashboxTransactionID == null).map((d) => ({ ...d })) };
  }
  // ── حارس الراتب المحسوب (باستثناء [OFFPAYROLL] بـ CHARINDEX) ──
  if (text.includes('SELECT TOP 1 PayrollID FROM Payroll') && text.includes('LoanDeduction')) {
    const blocked = s.payrolls.some((r) => r.EmployeeID === p.employeeId && r.PayrollMonth === p.month
      && Number(r.LoanDeduction || 0) > 0
      && ['قيد المراجعة', 'معتمد', 'غير مدفوع'].includes(r.PaymentStatus)
      && !marker(r.Notes));
    return { recordset: blocked ? [{ PayrollID: 1 }] : [] };
  }
  // ── رصيد الخزينة ──
  if (text.includes('SELECT OpeningBalance FROM CashBoxes')) {
    const box = s.cashBoxes.find((b) => b.CashBoxID === p.cashBoxId);
    return { recordset: box ? [{ OpeningBalance: box.OpeningBalance }] : [] };
  }
  if (text.includes('FROM CashboxTransactions') && text.includes('SUM(CASE WHEN')) {
    let inflow = 0; let outflow = 0;
    for (const t of s.cashTx.filter((x) => x.CashBoxID === p.cashBoxId)) {
      if (t.TransactionType === 'قبض') inflow += Number(t.Amount); else outflow += Number(t.Amount);
    }
    return { recordset: [{ Inflow: inflow, Outflow: outflow }] };
  }
  if (text.includes('SELECT MAX(InstallmentNumber)')) {
    const nums = s.installments.filter((i) => i.LoanId === p.loanId).map((i) => i.InstallmentNumber);
    return { recordset: [{ MaxNumber: nums.length ? Math.max(...nums) : 0 }] };
  }
  // ── تحديثات ──
  if (text.includes('UPDATE Payroll SET CashboxTransactionID')) {
    const row = s.payrolls.find((r) => r.PayrollID === p.id); if (row) row.CashboxTransactionID = p.txId;
    return { recordset: [] };
  }
  if (text.includes('UPDATE PayrollDetails SET CashboxTransactionID')) {
    const d = s.details.find((x) => x.PayrollDetailID === p.detailId); if (d) d.CashboxTransactionID = p.txId;
    return { recordset: [] };
  }
  if (text.includes('UPDATE LoanInstallments')) {
    const inst = s.installments.find((i) => i.InstallmentId === p.installmentId);
    if (inst) {
      if (text.includes('Amount = @amount')) inst.Amount = p.amount;
      inst.Status = 'PaidExternal'; inst.DeductionDate = 'NOW'; inst.Notes = p.notes;
    }
    return { recordset: [] };
  }
  if (text.includes('UPDATE EmployeeLoans SET TotalInstallments')) {
    const loan = s.loans.find((l) => l.LoanId === p.loanId); if (loan) loan.TotalInstallments += 1;
    return { recordset: [] };
  }
  if (text.includes('UPDATE EmployeeLoans') && text.includes('PaidInstallments = PaidInstallments + 1')) {
    const loan = s.loans.find((l) => l.LoanId === p.loanId);
    if (loan) {
      loan.PaidInstallments += 1; loan.RemainingAmount -= Number(p.amount); loan.LastUpdatedAt = 'NOW';
      if (loan.RemainingAmount <= 0 || loan.PaidInstallments >= loan.TotalInstallments) { loan.Status = 'Completed'; loan.RemainingAmount = 0; }
    }
    return { recordset: [] };
  }
  if (text.includes('UPDATE Payroll') && text.includes("PaymentStatus = N'مدفوع'")) {
    const row = s.payrolls.find((r) => r.PayrollID === p.id);
    if (row) { row.PaymentStatus = 'مدفوع'; row.PaymentDate = 'NOW'; row.Notes = p.notes; }
    return { recordset: [] };
  }
  if (text.includes('SELECT PaymentStatus FROM Payroll WHERE PayrollRunID')) {
    return { recordset: s.payrolls.filter((r) => r.PayrollRunID === p.runId).map((r) => ({ PaymentStatus: r.PaymentStatus })) };
  }
  if (text.includes('UPDATE PayrollRuns SET Status')) {
    const run = s.runs.find((r) => r.RunID === p.runId); if (run) run.Status = p.status;
    return { recordset: [] };
  }
  if (text.includes('UPDATE Payroll SET PaymentStatus = @status')) {
    const row = s.payrolls.find((r) => r.PayrollID === p.id);
    if (row) { row.PaymentStatus = p.status; row.Notes = p.notes; if (text.includes('PaymentDate')) row.PaymentDate = 'NOW'; }
    return { recordset: [] };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 160)}`);
}

class FakeRequest {
  constructor(_tx) { this.params = {}; }
  input(name, _type, value) { this.params[name] = value; return this; }
  async query(text) { return executeQuery(text, this.params); }
}
class FakeTransaction {
  constructor(_pool) { this.snapshot = null; }
  async begin() { this.snapshot = structuredClone(state.store); state.txLog.push('begin'); }
  async commit() { this.snapshot = null; state.txLog.push('commit'); }
  async rollback() { if (this.snapshot) state.store = this.snapshot; this.snapshot = null; state.txLog.push('rollback'); }
}
const fakePool = { request: () => new FakeRequest(null) };
const fakeSql = {
  Int: 'Int', NVarChar: () => 'NVarChar', Decimal: () => 'Decimal', DateTime: 'DateTime', MAX: 'MAX',
  Transaction: FakeTransaction, Request: FakeRequest,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const notifPath = require.resolve('../notifications/notifications.queries');
require.cache[notifPath] = { id: notifPath, filename: notifPath, loaded: true, exports: { createNotificationSmart: async () => {} } };

const q = require('./off-payroll.queries');
const ctrl = require('./off-payroll.controller');
const payrollEngine = require('../payroll/payroll.queries');
const policies = require('../../shared/authorization.policy');

const ADMIN = { username: 'admin', role: 'Admin' };
const payrollRow = (id) => state.store.payrolls.find((r) => r.PayrollID === id);
const inst = (id) => state.store.installments.find((i) => i.InstallmentId === id);
const loan = () => state.store.loans.find((l) => l.LoanId === 100);

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

// ── الحراسة الساكنة: لا نمط LIKE للوسم في أي ملف محرك ──
test('static: no LIKE pattern for [OFFPAYROLL] remains in off-payroll/payroll queries; CHARINDEX used', () => {
  for (const rel of ['./off-payroll.queries.js', '../payroll/payroll.queries.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!src.includes("LIKE '%[OFFPAYROLL]%'"), rel);
    assert.ok(!src.includes("NOT LIKE '%' + @marker"), rel);
    assert.ok(src.includes('CHARINDEX'), rel);
  }
});

// ── الإنشاء بشكل بلازور ──
test('create: run + zero-basic payroll + ONE Separate detail, effective month = referenceMonth', async () => {
  resetStore();
  const res = mockRes();
  await ctrl.create({
    body: { employeeId: 1, amount: 750, paymentType: 'CommissionSeparate', paymentMonth: '2026-10', referenceMonth: '2026-09', description: 'عمولة عملية', reason: 'تحقيق هدف' },
    auth: { username: 'admin' },
  }, res);
  assert.equal(res.statusCode, 201);
  const id = res.body.data.payrollId;
  assert.equal(res.body.data.month, '2026-09');
  const row = payrollRow(id);
  assert.equal(row.BasicSalary, 0);
  assert.equal(row.PayrollMonth, '2026-09');
  assert.equal(row.PaymentStatus, 'قيد المراجعة');
  assert.ok(row.Notes.startsWith('[OFFPAYROLL]'));
  assert.ok(row.Notes.includes('[نوع العملية] عمولة منفصلة'));
  assert.ok(row.Notes.includes('[السبب] تحقيق هدف'));
  const run = state.store.runs.find((r) => r.RunID === row.PayrollRunID);
  assert.ok(run && run.Notes.includes('[OFFPAYROLL]') && run.TotalNet === 750);
  const det = state.store.details.filter((d) => d.PayrollID === id);
  assert.equal(det.length, 1);
  assert.equal(det[0].PaymentType, 'Separate');
  assert.equal(det[0].DetailType, 'CommissionSeparate');
  assert.equal(det[0].Amount, 750);
  assert.ok(state.txLog.includes('commit'));
});

test('create validation: negative amount / missing description / bad type / bad month → 400, zero writes', async () => {
  const cases = [
    { employeeId: 1, amount: -50, paymentType: 'BonusSeparate', paymentMonth: '2026-10', description: 'س' },
    { employeeId: 1, amount: 50, paymentType: 'BonusSeparate', paymentMonth: '2026-10', description: '  ' },
    { employeeId: 1, amount: 50, paymentType: 'AnythingElse', paymentMonth: '2026-10', description: 'س' },
    { employeeId: 1, amount: 50, paymentType: 'BonusSeparate', paymentMonth: '2026-13', description: 'س' },
    { employeeId: 999, amount: 50, paymentType: 'BonusSeparate', paymentMonth: '2026-10', description: 'س' },
  ];
  for (const body of cases) {
    resetStore();
    const before = state.store.payrolls.length;
    const res = mockRes();
    await ctrl.create({ body, auth: { username: 'admin' } }, res);
    assert.ok(res.statusCode >= 400, JSON.stringify(body));
    assert.equal(state.store.payrolls.length, before);
  }
});

// ── القائمة والإحصاء ──
test('list: marker rows only — monthly payroll with Latin-letter notes excluded; Amount/Type/Description from Separate detail', async () => {
  resetStore();
  const { items, totalCount } = await q.getList({});
  assert.equal(totalCount, 1);
  assert.equal(items[0].PayrollID, 500);
  assert.equal(items[0].Amount, 1000);
  assert.equal(items[0].PaymentType, 'BonusSeparate');
  assert.equal(items[0].Description, 'مكافأة أداء');
  const stats = await q.getStats({});
  assert.equal(stats.TotalAmount, 1000); // لا SUM(NetSalary) — صافي بلازور صفر
  assert.equal(stats.ApprovedCount, 1);
  assert.equal(stats.ReviewCount, 0);
});

test('pending installments: Pending of Active loans only, ordered by month then number', async () => {
  resetStore();
  const items = await q.getPendingInstallments(1);
  assert.deepEqual(items.map((i) => i.InstallmentId), [1000, 1001, 1002]);
  inst(1001).Status = 'Deducted';
  const after = await q.getPendingInstallments(1);
  assert.deepEqual(after.map((i) => i.InstallmentId), [1000, 1002]);
});

// ── المقاصة: كاملة ──
test('allocation full: cash movement = payment − alloc only; installment PaidExternal; loan updated; payment Paid', async () => {
  resetStore();
  const r = await q.payWithAllocations(500, 10, [{ installmentId: 1000, amount: 400 }], ADMIN);
  assert.equal(r.paymentAmount, 1000);
  assert.equal(r.cashAmount, 600);
  assert.equal(r.loanAllocation, 400);
  assert.equal(state.store.cashTx.length, 1);
  assert.equal(state.store.cashTx[0].Amount, 600);
  assert.equal(state.store.cashTx[0].ReferenceType, 'Payroll');
  assert.equal(payrollRow(500).CashboxTransactionID, state.store.cashTx[0].CashboxTransactionID);
  assert.equal(state.store.details[0].CashboxTransactionID, state.store.cashTx[0].CashboxTransactionID);
  assert.equal(inst(1000).Status, 'PaidExternal');
  assert.ok(inst(1000).Notes.includes('مقاصة مقابل الدفعة خارج الراتب رقم 500'));
  assert.equal(loan().PaidInstallments, 2);
  assert.equal(loan().RemainingAmount, 400);
  assert.equal(payrollRow(500).PaymentStatus, 'مدفوع');
  assert.ok(payrollRow(500).Notes.includes('نقدي 600.00 + مقاصة سلف 400.00'));
  assert.equal(payrollRow(500).LoanDeduction, 0); // لا LoanDeduction على صف خارج الراتب أبدًا
  assert.ok(state.store.audit.some((a) => a.text.includes('OffPayrollAllocation')));
  assert.ok(state.txLog.includes('commit'));
});

// ── المقاصة: جزئية بالتقسيم ──
test('allocation partial: installment split — paid part PaidExternal at alloc amount, remainder new Pending, TotalInstallments +1', async () => {
  resetStore();
  const r = await q.payWithAllocations(500, 10, [{ installmentId: 1001, amount: 150 }], ADMIN);
  assert.equal(r.cashAmount, 850);
  assert.equal(inst(1001).Status, 'PaidExternal');
  assert.equal(inst(1001).Amount, 150);
  const rest = state.store.installments.find((i) => i.InstallmentNumber === 4);
  assert.ok(rest);
  assert.equal(rest.Amount, 250);
  assert.equal(rest.Status, 'Pending');
  assert.equal(rest.DeductionMonth, '2026-12');
  assert.ok(rest.Notes.includes('المتبقي بعد مقاصة جزئية'));
  assert.equal(loan().TotalInstallments, 4);
  assert.equal(loan().RemainingAmount, 650);
});

// ── المقاصة: الحراس ──
test('allocation guard: installment inside calculated-unpaid payroll month → refusal, zero writes', async () => {
  resetStore();
  state.store.payrolls.push({
    PayrollID: 510, EmployeeID: 1, PayrollMonth: '2026-11', BasicSalary: 6000, BonusInPayroll: 0,
    Allowances: 0, Deductions: 900, LoanDeduction: 400, PaymentStatus: 'معتمد', PaymentDate: null,
    CashboxTransactionID: null, PayrollRunID: null, CreatedBy: 'admin', CreatedAt: '2026-10-07', Notes: null,
  });
  await assert.rejects(q.payWithAllocations(500, 10, [{ installmentId: 1000, amount: 400 }], ADMIN),
    (e) => e.message.includes('داخل راتب شهر 2026-11'));
  assert.equal(inst(1000).Status, 'Pending');
  assert.equal(state.store.cashTx.length, 0);
  assert.equal(payrollRow(500).PaymentStatus, 'معتمد');
  assert.ok(state.txLog.includes('rollback'));
});

test('allocation guards: over payment total → refusal; insufficient cash balance (cash part only) → refusal; non-reviewer → 403', async () => {
  resetStore();
  await assert.rejects(
    q.payWithAllocations(500, 10, [{ installmentId: 1000, amount: 400 }, { installmentId: 1001, amount: 400 }, { installmentId: 1002, amount: 400 }], ADMIN),
    (e) => e.message.includes('أكبر من قيمة الدفعة'),
  );
  resetStore();
  state.store.cashBoxes[0].OpeningBalance = 100; // النقدي المطلوب 600
  await assert.rejects(q.payWithAllocations(500, 10, [{ installmentId: 1000, amount: 400 }], ADMIN),
    (e) => e.message.includes('أقل من المطلوب للصرف النقدي'));
  assert.equal(state.store.cashTx.length, 0);
  resetStore();
  await assert.rejects(q.payWithAllocations(500, 10, [{ installmentId: 1000, amount: 400 }], { username: 'x', role: 'Sales' }),
    (e) => e.statusCode === 403);
  // تخصيص أكبر من قيمة القسط نفسه
  resetStore();
  await assert.rejects(q.payWithAllocations(500, 10, [{ installmentId: 1000, amount: 401 }], ADMIN),
    (e) => e.message.includes('أكبر من قيمته'));
});

// ── الرفض والإلغاء عبر المحرك ──
test('reject with reason and cancel via engine; cancel of Paid refused', async () => {
  resetStore();
  await payrollEngine.rejectPayroll(500, ADMIN, 'غير مستحقة');
  assert.equal(payrollRow(500).PaymentStatus, 'مرفوض');
  assert.ok(payrollRow(500).Notes.includes('غير مستحقة'));

  resetStore();
  const r = await payrollEngine.cancelPayroll(500, ADMIN);
  assert.equal(r.status, 'ملغي');
  assert.equal(payrollRow(500).PaymentStatus, 'ملغي');

  resetStore();
  payrollRow(500).PaymentStatus = 'مدفوع';
  await assert.rejects(payrollEngine.cancelPayroll(500, ADMIN),
    (e) => e.message.includes('لا يمكن إلغاء'));
});

// ── بوابات السياسة ──
test('policy offPayroll: canEnter mirrors Blazor view set; canReviewOrPay = payroll mutate set', () => {
  const withClaims = (...cs) => ({ role: 'User', claims: new Set(cs) });
  assert.equal(policies.offPayroll.canEnter({ role: 'Admin', claims: new Set() }), true);
  assert.equal(policies.offPayroll.canEnter({ role: 'HrManager', claims: new Set() }), true);
  assert.equal(policies.offPayroll.canEnter({ role: 'Accountant', claims: new Set() }), true);
  assert.equal(policies.offPayroll.canEnter(withClaims('frm_PayrollPayment:View')), true);
  assert.equal(policies.offPayroll.canEnter(withClaims('frm_Payroll:View')), true);
  assert.equal(policies.offPayroll.canEnter({ role: 'Sales', claims: new Set() }), false);
  assert.equal(policies.offPayroll.canEnter({ role: 'GeneralManager', claims: new Set() }), false);
  assert.equal(policies.offPayroll.canReviewOrPay({ role: 'AccountManager', claims: new Set() }), true);
  assert.equal(policies.offPayroll.canReviewOrPay({ role: 'Accountant', claims: new Set() }), false);
});

test('routes: off-payroll endpoints registered incl. reject/cancel/pending-installments', () => {
  const router = require('./off-payroll.routes');
  const entries = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  for (const e of ['GET /', 'GET /pending-installments/:employeeId', 'POST /', 'POST /:id/approve', 'POST /:id/reject', 'POST /:id/cancel', 'POST /:id/pay']) {
    assert.ok(entries.includes(e), e);
  }
});
