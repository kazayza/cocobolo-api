// اختبارات مُحاكاة (stubbed) لوحدة السلف — بلا أي قاعدة بيانات حية.
// تُستبدل وحدة core/database بذاكرة وهمية تنفذ دلالات الاستعلامات التي
// تستخدمها loans.queries (بما فيها فلاتر Payroll وCHARINDEX)، وتدعم
// المعاملات بلقطة/استرجاع حتى تُفحص الذرّية وعدم حدوث كتابات عند الرفض.
// التشغيل: node --test modules/loans/loans.test.js
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-for-loans-stub-0123456789abcdef';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── المخزن الوهمي ─────────────────────────────────────────────
const state = { store: null, writes: [], txLog: [] };
let nextLoanId; let nextInstId; let nextTxId;

function resetStore() {
  nextLoanId = 200; nextInstId = 2000; nextTxId = 9000;
  state.writes = []; state.txLog = [];
  state.store = {
    employees: [
      { EmployeeID: 1, FullName: 'أحمد اختبار', Department: 'الإنتاج', JobTitle: 'فني' },
    ],
    cashBoxes: [
      { CashBoxID: 10, CashBoxName: 'الخزينة الرئيسية', OpeningBalance: 1000 },
    ],
    loans: [
      {
        LoanId: 100, EmployeeId: 1, LoanAmount: 1200, MonthlyInstallment: 400,
        TotalInstallments: 3, PaidInstallments: 0, RemainingAmount: 1200,
        LoanDate: '2026-10-01', StartDeductionMonth: '2026-11', Status: 'Active',
        CashBoxId: 10, CashboxTransactionId: 500, Notes: 'ملحوظة السلفة',
        ApprovedBy: 'المدير', CreatedBy: 'admin', CreatedAt: '2026-10-01', LastUpdatedAt: null,
      },
    ],
    installments: [
      { InstallmentId: 1000, LoanId: 100, EmployeeId: 1, InstallmentNumber: 1, DeductionMonth: '2026-11', Amount: 400, Status: 'Pending', DeductionDate: null, Notes: null, PayrollId: 900, CreatedBy: 'admin', CreatedAt: '2026-10-01' },
      { InstallmentId: 1001, LoanId: 100, EmployeeId: 1, InstallmentNumber: 2, DeductionMonth: '2026-12', Amount: 400, Status: 'Pending', DeductionDate: null, Notes: null, PayrollId: null, CreatedBy: 'admin', CreatedAt: '2026-10-01' },
      { InstallmentId: 1002, LoanId: 100, EmployeeId: 1, InstallmentNumber: 3, DeductionMonth: '2027-01', Amount: 400, Status: 'Pending', DeductionDate: null, Notes: null, PayrollId: null, CreatedBy: 'admin', CreatedAt: '2026-10-01' },
    ],
    payrolls: [
      // صف راتب مرتبط بالقسط الأول لفحص PayrollMonth في التفاصيل — بلا خصم سلفة.
      { PayrollID: 900, EmployeeID: 1, PayrollMonth: '2026-11', PaymentStatus: 'غير مدفوع', LoanDeduction: 0, Notes: null },
    ],
    cashTx: [],
  };
}
resetStore();

const UNPAID = ['قيد المراجعة', 'معتمد', 'غير مدفوع'];

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const s = state.store;

  // ValidateTargetMonth: حالات راتب الشهر الهدف (باستثناء OFFPAYROLL والملغي/المرفوض)
  if (text.includes('FROM Payroll') && text.includes('CHARINDEX')) {
    const rows = s.payrolls
      .filter((r) => r.EmployeeID === p.empId && r.PayrollMonth === p.targetMonth
        && !(r.Notes && r.Notes.includes('[OFFPAYROLL]'))
        && r.PaymentStatus !== 'ملغي' && r.PaymentStatus !== 'مرفوض')
      .map((r) => ({ PaymentStatus: r.PaymentStatus }));
    return { recordset: rows };
  }
  // GetUnpaidPayrollBlock
  if (text.includes('FROM Payroll') && text.includes('LoanDeduction')) {
    const exists = s.payrolls.some((r) => r.EmployeeID === p.empId && r.PayrollMonth === p.month
      && Number(r.LoanDeduction || 0) > 0 && UNPAID.includes(r.PaymentStatus));
    return { recordset: exists ? [{ PayrollID: 1 }] : [] };
  }
  // تفاصيل: سلفة + اسم الخزينة
  if (text.includes('LEFT JOIN CashBoxes')) {
    const loan = s.loans.find((l) => l.LoanId === p.loanId);
    if (!loan) return { recordset: [] };
    const emp = s.employees.find((e) => e.EmployeeID === loan.EmployeeId) || {};
    const box = s.cashBoxes.find((c) => c.CashBoxID === loan.CashBoxId);
    return {
      recordset: [{
        LoanId: loan.LoanId, EmployeeId: loan.EmployeeId,
        EmployeeName: emp.FullName, Department: emp.Department, JobTitle: emp.JobTitle,
        LoanAmount: loan.LoanAmount, MonthlyInstallment: loan.MonthlyInstallment,
        TotalInstallments: loan.TotalInstallments, PaidInstallments: loan.PaidInstallments,
        PaidAmount: loan.LoanAmount - loan.RemainingAmount, RemainingAmount: loan.RemainingAmount,
        LoanDate: loan.LoanDate, StartDeductionMonth: loan.StartDeductionMonth, Status: loan.Status,
        CashBoxId: loan.CashBoxId, CashBoxName: box ? box.CashBoxName : null,
        Notes: loan.Notes, ApprovedBy: loan.ApprovedBy, CreatedBy: loan.CreatedBy, CreatedAt: loan.CreatedAt,
      }],
    };
  }
  // تفاصيل: أقساط + شهر الراتب
  if (text.includes('LEFT JOIN Payroll')) {
    const rows = s.installments
      .filter((i) => i.LoanId === p.loanId)
      .sort((a, b) => a.InstallmentNumber - b.InstallmentNumber)
      .map((i) => {
        const pr = s.payrolls.find((r) => r.PayrollID === i.PayrollId);
        return {
          InstallmentId: i.InstallmentId, LoanId: i.LoanId, EmployeeId: i.EmployeeId,
          InstallmentNumber: i.InstallmentNumber, DeductionMonth: i.DeductionMonth,
          Amount: i.Amount, Status: i.Status, DeductionDate: i.DeductionDate,
          Notes: i.Notes, PayrollMonth: pr ? pr.PayrollMonth : null,
        };
      });
    return { recordset: rows };
  }
  // قسط + سلفته
  if (text.includes('INNER JOIN EmployeeLoans') && text.includes('LoanInstallments i')) {
    const inst = s.installments.find((i) => i.InstallmentId === p.instId);
    if (!inst) return { recordset: [] };
    const loan = s.loans.find((l) => l.LoanId === inst.LoanId);
    return {
      recordset: [{
        InstallmentId: inst.InstallmentId, LoanId: inst.LoanId, EmployeeId: inst.EmployeeId,
        InstallmentNumber: inst.InstallmentNumber, DeductionMonth: inst.DeductionMonth,
        Amount: inst.Amount, Status: inst.Status, Notes: inst.Notes,
        LoanStatus: loan.Status, StartDeductionMonth: loan.StartDeductionMonth,
      }],
    };
  }
  // آخر قسط
  if (text.includes('FROM LoanInstallments') && text.includes('TOP 1')) {
    const rows = s.installments.filter((i) => i.LoanId === p.loanId)
      .sort((a, b) => b.InstallmentNumber - a.InstallmentNumber);
    return { recordset: rows.length ? [{ InstallmentId: rows[0].InstallmentId, InstallmentNumber: rows[0].InstallmentNumber, DeductionMonth: rows[0].DeductionMonth }] : [] };
  }
  // موظف (إنشاء)
  if (text.includes('SELECT EmployeeID, FullName FROM Employees')) {
    const emp = s.employees.find((e) => e.EmployeeID === p.empId);
    return { recordset: emp ? [{ EmployeeID: emp.EmployeeID, FullName: emp.FullName }] : [] };
  }
  // رصيد افتتاحي
  if (text.includes('SELECT OpeningBalance FROM CashBoxes')) {
    const box = s.cashBoxes.find((c) => c.CashBoxID === p.cashBoxId);
    return { recordset: box ? [{ OpeningBalance: box.OpeningBalance }] : [] };
  }
  // مجاميع حركات الخزينة
  if (text.includes('FROM CashboxTransactions') && text.includes('SUM')) {
    let inflow = 0; let outflow = 0;
    for (const t of s.cashTx.filter((x) => x.CashBoxID === p.cashBoxId)) {
      if (t.TransactionType === 'قبض') inflow += Number(t.Amount); else outflow += Number(t.Amount);
    }
    return { recordset: [{ Inflow: inflow, Outflow: outflow }] };
  }
  // إنشاء سلفة
  if (text.includes('INSERT INTO EmployeeLoans')) {
    const loan = {
      LoanId: nextLoanId++, EmployeeId: p.empId, LoanAmount: p.amount,
      TotalInstallments: p.total, MonthlyInstallment: p.monthly, RemainingAmount: p.remaining,
      PaidInstallments: 0, LoanDate: '2026-10-30', StartDeductionMonth: p.month, Status: 'Active',
      CashBoxId: p.cashBoxId, CashboxTransactionId: null, Notes: p.notes,
      ApprovedBy: null, CreatedBy: p.user, CreatedAt: '2026-10-30', LastUpdatedAt: null,
    };
    s.loans.push(loan);
    state.writes.push({ type: 'insert-loan', loan });
    return { recordset: [{ LoanId: loan.LoanId }] };
  }
  // إدراج قسط
  if (text.includes('INSERT INTO LoanInstallments')) {
    const row = {
      InstallmentId: nextInstId++, LoanId: p.loanId, EmployeeId: p.empId,
      InstallmentNumber: p.num, DeductionMonth: p.month ?? p.m, Amount: p.amt,
      Status: 'Pending', DeductionDate: null, Notes: p.notes ?? null,
      PayrollId: null, CreatedBy: p.user, CreatedAt: '2026-10-30',
    };
    s.installments.push(row);
    state.writes.push({ type: 'insert-installment', row });
    return { recordset: [] };
  }
  // حركة خزينة
  if (text.includes('INSERT INTO CashboxTransactions')) {
    const row = {
      CashboxTransactionID: nextTxId++, CashBoxID: p.cashBoxId,
      TransactionType: text.includes("N'قبض'") ? 'قبض' : 'صرف',
      ReferenceType: text.includes('LoanCancel') ? 'LoanCancel' : 'Loan',
      ReferenceID: p.referenceId, Amount: p.amount, Notes: p.notes, CreatedBy: p.user,
    };
    s.cashTx.push(row);
    state.writes.push({ type: 'insert-cashTx', row });
    return { recordset: text.includes('OUTPUT') ? [{ CashboxTransactionID: row.CashboxTransactionID }] : [] };
  }
  // إلغاء: جلب السلفة
  if (text.includes('SELECT LoanId, Status, LoanAmount, CashBoxId FROM EmployeeLoans')) {
    const loan = s.loans.find((l) => l.LoanId === p.loanId);
    return { recordset: loan ? [{ LoanId: loan.LoanId, Status: loan.Status, LoanAmount: loan.LoanAmount, CashBoxId: loan.CashBoxId }] : [] };
  }
  // إلغاء: عد الأقساط المخصومة
  if (text.includes('COUNT(*) AS C FROM LoanInstallments')) {
    const c = s.installments.filter((i) => i.LoanId === p.loanId && i.Status === 'Deducted').length;
    return { recordset: [{ C: c }] };
  }
  // تحديث سلفة (يتضمن تحديث الإلغاء المركّب)
  if (text.includes('UPDATE EmployeeLoans')) {
    const loan = s.loans.find((l) => l.LoanId === p.loanId);
    if (loan) {
      if (text.includes('TotalInstallments = TotalInstallments + 1')) {
        loan.TotalInstallments += 1; loan.LastUpdatedAt = 'NOW';
        state.writes.push({ type: 'update-loan-total', loanId: loan.LoanId });
      } else if (text.includes('CashboxTransactionId')) {
        loan.CashboxTransactionId = p.txId;
        state.writes.push({ type: 'update-loan-txlink', loanId: loan.LoanId });
      } else if (text.includes("Status = 'Cancelled'")) {
        loan.Status = 'Cancelled'; loan.RemainingAmount = 0; loan.LastUpdatedAt = 'NOW';
        for (const i of s.installments.filter((x) => x.LoanId === loan.LoanId && x.Status === 'Pending')) i.Status = 'Skipped';
        state.writes.push({ type: 'cancel-loan', loanId: loan.LoanId });
      } else if (text.includes('LastUpdatedAt')) {
        loan.LastUpdatedAt = 'NOW';
        state.writes.push({ type: 'update-loan-ts', loanId: loan.LoanId });
      }
    }
    return { recordset: [] };
  }
  // تحديث قسط مفرد
  if (text.includes('UPDATE LoanInstallments')) {
    const inst = s.installments.find((i) => i.InstallmentId === p.instId);
    if (inst) {
      if (/Status = 'Skipped'/.test(text)) inst.Status = 'Skipped';
      let m;
      if ((m = text.match(/Amount = @(\w+)/))) inst.Amount = p[m[1]];
      if ((m = text.match(/DeductionMonth = @(\w+)/))) inst.DeductionMonth = p[m[1]];
      if ((m = text.match(/Notes = @(\w+)/))) inst.Notes = p[m[1]];
      state.writes.push({ type: 'update-installment', instId: inst.InstallmentId });
    }
    return { recordset: [] };
  }
  // قائمة السلف: فلاتر getLoans بدلالات SQL نفسها — الحالة مطابقة حرفية
  // (تُتخطى عند الغياب أو 'all')، والشهر = شهر بداية الخصم أو أي قسط
  // في الشهر (تطابق بلازور GetLoansAsync:52-57)، ثم ترتيب وتصفح.
  if (text.includes('FROM EmployeeLoans l') && (text.includes('OFFSET') || text.includes('COUNT(*) AS Total'))) {
    const suf = text.includes('COUNT(*) AS Total') ? '2' : '';
    const st = p[`status${suf}`]; const srch = p[`search${suf}`]; const mon = p[`month${suf}`]; const br = p[`branchId${suf}`];
    let rows = s.loans.map((l) => {
      const e = s.employees.find((x) => x.EmployeeID === l.EmployeeId) || {};
      return {
        LoanId: l.LoanId, EmployeeId: l.EmployeeId, LoanAmount: l.LoanAmount,
        TotalInstallments: l.TotalInstallments, MonthlyInstallment: l.MonthlyInstallment,
        RemainingAmount: l.RemainingAmount, PaidInstallments: l.PaidInstallments,
        StartDeductionMonth: l.StartDeductionMonth, Status: l.Status,
        LoanDate: l.LoanDate, Notes: l.Notes,
        EmployeeName: e.FullName, Department: e.Department, JobTitle: e.JobTitle,
        BranchID: e.BranchID ?? null, EmployeeStatus: 'Active', BranchName: null,
        __start: l.StartDeductionMonth,
      };
    });
    if (st && st !== 'all') rows = rows.filter((r) => r.Status === st);
    if (srch) {
      const needle = srch.replace(/%/g, '');
      rows = rows.filter((r) => (r.EmployeeName || '').includes(needle) || (r.Department || '').includes(needle) || (r.JobTitle || '').includes(needle));
    }
    if (mon) rows = rows.filter((r) => r.__start === mon || s.installments.some((i) => i.LoanId === r.LoanId && i.DeductionMonth === mon));
    if (br) rows = rows.filter((r) => r.BranchID === br);
    if (text.includes('COUNT(*) AS Total')) return { recordset: [{ Total: rows.length }] };
    const mOff = text.match(/OFFSET (\d+) ROWS FETCH NEXT (\d+)/);
    const off = mOff ? Number(mOff[1]) : 0; const ps = mOff ? Number(mOff[2]) : rows.length;
    return { recordset: rows.slice(off, off + ps).map(({ __start, ...r }) => r) };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 160)}`);
}

class FakeRequest {
  constructor(txOrPool) { this.params = {}; }
  input(name, _type, value) { this.params[name] = value; return this; }
  async query(text) { return executeQuery(text, this.params); }
}
class FakeTransaction {
  constructor(_pool) { this.__isTx = true; this.snapshot = null; }
  async begin() { this.snapshot = structuredClone(state.store); state.txLog.push('begin'); }
  async commit() { this.snapshot = null; state.txLog.push('commit'); }
  async rollback() { if (this.snapshot) state.store = this.snapshot; this.snapshot = null; state.txLog.push('rollback'); }
}
const fakePool = { request: () => new FakeRequest(null) };
const fakeSql = {
  Int: 'Int', NVarChar: () => 'NVarChar', Decimal: () => 'Decimal', DateTime: 'DateTime',
  Transaction: FakeTransaction, Request: FakeRequest,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

// حقن البديل في ذاكرة الوحدات قبل تحميل أي وحدة تعتمد على قاعدة البيانات
const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const notifPath = require.resolve('../notifications/notifications.queries');
require.cache[notifPath] = { id: notifPath, filename: notifPath, loaded: true, exports: { createNotificationSmart: async () => {} } };

const q = require('./loans.queries');
const ctrl = require('./loans.controller');
const policies = require('../../shared/authorization.policy');

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
const loan = () => state.store.loans.find((l) => l.LoanId === 100);
const inst = (id) => state.store.installments.find((i) => i.InstallmentId === id);

// ── التفاصيل ─────────────────────────────────────────────────
test('detail shape: Loan fields + PaidAmount + CashBoxName + Installments ordered with PayrollMonth', async () => {
  resetStore();
  loan().RemainingAmount = 800; loan().PaidInstallments = 1;
  inst(1000).Status = 'Deducted';
  const d = await q.getLoanDetail(100);
  assert.ok(d && d.Loan && Array.isArray(d.Installments));
  const L = d.Loan;
  for (const k of ['LoanId', 'EmployeeId', 'EmployeeName', 'Department', 'JobTitle', 'LoanAmount', 'MonthlyInstallment', 'TotalInstallments', 'PaidInstallments', 'PaidAmount', 'RemainingAmount', 'LoanDate', 'StartDeductionMonth', 'Status', 'CashBoxId', 'CashBoxName', 'Notes', 'ApprovedBy', 'CreatedBy', 'CreatedAt']) {
    assert.ok(k in L, `missing Loan.${k}`);
  }
  assert.equal(L.PaidAmount, 400); // 1200 − 800
  assert.equal(L.CashBoxName, 'الخزينة الرئيسية');
  assert.equal(L.EmployeeName, 'أحمد اختبار');
  assert.deepEqual(d.Installments.map((i) => i.InstallmentNumber), [1, 2, 3]);
  for (const k of ['InstallmentId', 'LoanId', 'EmployeeId', 'InstallmentNumber', 'DeductionMonth', 'Amount', 'Status', 'DeductionDate', 'Notes', 'PayrollMonth']) {
    assert.ok(k in d.Installments[0], `missing Installment.${k}`);
  }
  assert.equal(d.Installments[0].PayrollMonth, '2026-11');
  assert.equal(d.Installments[1].PayrollMonth, null);
  assert.equal(await q.getLoanDetail(999), null);
});

test('detail missing loan → controller 404 «السلفة غير موجودة»', async () => {
  resetStore();
  const res = mockRes();
  await ctrl.getById({ params: { id: '999' }, auth: { username: 'admin' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, 'السلفة غير موجودة');
});

// ── التأجيل ──────────────────────────────────────────────────
test('skip: default month = after LAST installment; old Skipped + notes replaced; TotalInstallments +1', async () => {
  resetStore();
  const r = await q.skipInstallment(1000, { reason: 'ظرف طارئ' }, 'admin');
  assert.equal(r.newMonth, '2027-02'); // آخر قسط 2027-01
  assert.equal(r.message, 'تم تأجيل القسط إلى شهر 2027-02');
  assert.equal(inst(1000).Status, 'Skipped');
  assert.equal(inst(1000).Notes, 'ظرف طارئ');
  const created = state.store.installments.find((i) => i.InstallmentNumber === 4);
  assert.ok(created);
  assert.equal(created.DeductionMonth, '2027-02');
  assert.equal(created.Amount, 400);
  assert.equal(created.Status, 'Pending');
  assert.equal(loan().TotalInstallments, 4);
  assert.ok(state.txLog.includes('commit'));
});

test('skip: explicit targetMonth honored; bad format → 400; same month → 400; before loan start → 400', async () => {
  resetStore();
  const r = await q.skipInstallment(1001, { targetMonth: '2027-06' }, 'admin');
  assert.equal(r.newMonth, '2027-06');

  resetStore();
  await assert.rejects(q.skipInstallment(1001, { targetMonth: '2026-8' }, 'admin'),
    (e) => e.statusCode === 400 && e.message.includes('صيغة الشهر غير صحيحة'));

  resetStore();
  await assert.rejects(q.skipInstallment(1001, { targetMonth: '2026-12' }, 'admin'),
    (e) => e.statusCode === 400 && e.message === 'الشهر المختار هو نفس شهر القسط الحالي');

  resetStore();
  await assert.rejects(q.skipInstallment(1001, { targetMonth: '2026-10' }, 'admin'),
    (e) => e.statusCode === 400 && e.message.includes('لا يمكن نقل القسط لشهر قبل بداية خصم السلفة (2026-11)'));
});

// ── حرّاس الراتب ─────────────────────────────────────────────
test('unpaid-payroll block (current month, LoanDeduction>0) → 409 for skip, split and update-with-month', async () => {
  const seedBlock = () => {
    state.store.payrolls.push({ PayrollID: 950, EmployeeID: 1, PayrollMonth: '2026-11', PaymentStatus: 'قيد المراجعة', LoanDeduction: 400, Notes: null });
  };
  resetStore(); seedBlock();
  await assert.rejects(q.skipInstallment(1000, {}, 'admin'),
    (e) => e.statusCode === 409 && e.message.includes('هذا القسط داخل راتب شهر 2026-11'));
  assert.equal(inst(1000).Status, 'Pending');

  resetStore(); seedBlock();
  await assert.rejects(q.splitInstallment(1000, { amountToKeep: 100 }, 'admin'),
    (e) => e.statusCode === 409 && e.message.includes('هذا القسط داخل راتب شهر 2026-11'));
  assert.equal(inst(1000).Amount, 400);

  resetStore();
  state.store.payrolls.push({ PayrollID: 951, EmployeeID: 1, PayrollMonth: '2026-12', PaymentStatus: 'معتمد', LoanDeduction: 400, Notes: null });
  await assert.rejects(q.updateInstallment(1001, { newMonth: '2027-05' }, 'admin'),
    (e) => e.statusCode === 409 && e.message.includes('هذا القسط داخل راتب شهر 2026-12'));
  assert.equal(inst(1001).DeductionMonth, '2026-12');
});

test('update amount-only does NOT consult the unpaid-payroll block (Blazor checks it only on month change)', async () => {
  resetStore();
  state.store.payrolls.push({ PayrollID: 952, EmployeeID: 1, PayrollMonth: '2026-12', PaymentStatus: 'قيد المراجعة', LoanDeduction: 400, Notes: null });
  const r = await q.updateInstallment(1001, { newAmount: 300 }, 'admin');
  assert.equal(r.message, 'تم تعديل القسط بنجاح');
  assert.equal(inst(1001).Amount, 300);
});

test('target month Paid payroll → 409; calculated-unpaid target → 409', async () => {
  resetStore();
  state.store.payrolls.push({ PayrollID: 960, EmployeeID: 1, PayrollMonth: '2027-03', PaymentStatus: 'مدفوع', LoanDeduction: 0, Notes: null });
  await assert.rejects(q.skipInstallment(1000, { targetMonth: '2027-03' }, 'admin'),
    (e) => e.statusCode === 409 && e.message.includes('راتب شهر 2027-03 تم صرفه بالفعل'));

  resetStore();
  state.store.payrolls.push({ PayrollID: 961, EmployeeID: 1, PayrollMonth: '2027-03', PaymentStatus: 'غير مدفوع', LoanDeduction: 0, Notes: null });
  await assert.rejects(q.splitInstallment(1000, { amountToKeep: 100, targetMonth: '2027-03' }, 'admin'),
    (e) => e.statusCode === 409 && e.message.includes('راتب شهر 2027-03 محسوب وغير مصروف'));
});

test('target month exclusions: [OFFPAYROLL] rows and Cancelled/Rejected payrolls do not block', async () => {
  resetStore();
  state.store.payrolls.push({ PayrollID: 970, EmployeeID: 1, PayrollMonth: '2027-04', PaymentStatus: 'مدفوع', LoanDeduction: 0, Notes: 'دفعة [OFFPAYROLL] جانبية' });
  state.store.payrolls.push({ PayrollID: 971, EmployeeID: 1, PayrollMonth: '2027-04', PaymentStatus: 'مرفوض', LoanDeduction: 0, Notes: null });
  const r = await q.skipInstallment(1000, { targetMonth: '2027-04' }, 'admin');
  assert.equal(r.newMonth, '2027-04');
});

// ── التجزئة ──────────────────────────────────────────────────
test('split: preserves sum exactly, carried = own month + 1, number = last + 1, notes appended/carried', async () => {
  resetStore();
  inst(1001).Notes = 'ملحوظة قديمة';
  const r = await q.splitInstallment(1001, { amountToKeep: 150.25, reason: 'تخفيف هذا الشهر' }, 'admin');
  assert.equal(r.keptAmount, 150.25);
  assert.equal(r.carriedAmount, 249.75);
  assert.equal(r.newMonth, '2027-01'); // شهر القسط نفسه (2026-12) + 1 — لا شهر آخر قسط
  assert.equal(inst(1001).Amount, 150.25);
  assert.equal(inst(1001).Notes, 'ملحوظة قديمة\nتخفيف هذا الشهر');
  const carried = state.store.installments.find((i) => i.InstallmentNumber === 4);
  assert.equal(carried.Amount, 249.75);
  assert.equal(carried.DeductionMonth, '2027-01');
  assert.equal(carried.Notes, 'مُرحّل من تجزئة القسط رقم 2');
  assert.equal(Number(inst(1001).Amount) + Number(carried.Amount), 400);
  assert.equal(loan().TotalInstallments, 4);
});

test('split: blank reason leaves notes unchanged; keep<=0 → 400; keep>=amount → 400', async () => {
  resetStore();
  inst(1001).Notes = 'ثابتة';
  await q.splitInstallment(1001, { amountToKeep: 100, reason: '' }, 'admin');
  assert.equal(inst(1001).Notes, 'ثابتة');

  resetStore();
  await assert.rejects(q.splitInstallment(1001, { amountToKeep: 0 }, 'admin'), (e) => e.statusCode === 400);
  await assert.rejects(q.splitInstallment(1001, { amountToKeep: 400 }, 'admin'),
    (e) => e.statusCode === 400 && e.message.includes('التجزئة تتطلب مبلغًا أقل'));
});

// ── التعديل ──────────────────────────────────────────────────
test('update: amount round2 with no knock-on; notes replaced only when key present; month change works', async () => {
  resetStore();
  await q.updateInstallment(1001, { newAmount: 350.126, notes: '', notesPresent: true }, 'admin');
  assert.equal(inst(1001).Amount, 350.13);
  assert.equal(inst(1001).Notes, '');
  assert.equal(loan().RemainingAmount, 1200); // لا أثر متسلسل — كما في بلازور

  resetStore();
  inst(1001).Notes = 'أصلية';
  await q.updateInstallment(1001, { newAmount: 300 }, 'admin');
  assert.equal(inst(1001).Notes, 'أصلية'); // بلا مفتاح notes لا مساس

  resetStore();
  await q.updateInstallment(1001, { newMonth: '2027-05' }, 'admin');
  assert.equal(inst(1001).DeductionMonth, '2027-05');

  resetStore();
  await assert.rejects(q.updateInstallment(1001, { newAmount: 0 }, 'admin'), (e) => e.statusCode === 400);
  await assert.rejects(q.updateInstallment(1001, { newMonth: 'x' }, 'admin'), (e) => e.statusCode === 400);
});

test('update on non-Active loan → 409 «السلفة غير نشطة»', async () => {
  resetStore();
  loan().Status = 'Completed';
  await assert.rejects(q.updateInstallment(1001, { newAmount: 300 }, 'admin'),
    (e) => e.statusCode === 409 && e.message === 'السلفة غير نشطة');
});

test('non-Pending installment → 409 for skip, split and update; missing → 404', async () => {
  for (const op of ['skip', 'split', 'update']) {
    resetStore();
    inst(1001).Status = 'Deducted';
    const call = op === 'skip' ? q.skipInstallment(1001, {}, 'admin')
      : op === 'split' ? q.splitInstallment(1001, { amountToKeep: 100 }, 'admin')
        : q.updateInstallment(1001, { newAmount: 100 }, 'admin');
    await assert.rejects(call, (e) => e.statusCode === 409, op);
  }
  resetStore();
  await assert.rejects(q.skipInstallment(4242, {}, 'admin'), (e) => e.statusCode === 404);
  await assert.rejects(q.splitInstallment(4242, { amountToKeep: 1 }, 'admin'), (e) => e.statusCode === 404);
  await assert.rejects(q.updateInstallment(4242, { newAmount: 1 }, 'admin'), (e) => e.statusCode === 404);
});

// ── الإنشاء والخزينة الإلزامية ────────────────────────────────
test('create without cashBoxId → controller 400 «يرجى اختيار الخزينة» and queries-level rejection', async () => {
  resetStore();
  const res = mockRes();
  await ctrl.create({
    body: { employeeId: 1, amount: 500, totalInstallments: 2, startMonth: '2027-01' },
    auth: { username: 'admin' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'يرجى اختيار الخزينة');

  await assert.rejects(
    q.create({ employeeId: 1, amount: 500, totalInstallments: 2, startMonth: '2027-01' }, 'admin'),
    (e) => e.message === 'يرجى اختيار الخزينة',
  );
});

test('create with insufficient cashbox balance → error and ZERO writes', async () => {
  resetStore();
  state.store.cashBoxes[0].OpeningBalance = 100;
  const currentMonth = new Date().toISOString().slice(0, 7);
  await assert.rejects(
    q.create({ employeeId: 1, amount: 5000, totalInstallments: 5, startMonth: currentMonth, cashBoxId: 10 }, 'admin'),
    (e) => e.message.includes('رصيد الخزينة (100.00 جـ) أقل من قيمة السلفة (5000.00 جـ)'),
  );
  assert.equal(state.store.loans.length, 1); // السلفة الأصلية فقط
  assert.equal(state.store.installments.length, 3);
  assert.equal(state.store.cashTx.length, 0);
  assert.equal(state.writes.filter((w) => w.type.startsWith('insert')).length, 0);
});

test('create happy path: loan + N installments + exactly ONE صرف/Loan movement, atomically committed', async () => {
  resetStore();
  state.store.cashBoxes[0].OpeningBalance = 10000;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const r = await q.create({ employeeId: 1, amount: 1000, totalInstallments: 3, startMonth: currentMonth, cashBoxId: 10, notes: 'سلفة اختبار' }, 'admin');
  const newLoan = state.store.loans.find((l) => l.LoanId === r.loanId);
  assert.ok(newLoan);
  assert.equal(newLoan.Status, 'Active');
  assert.equal(newLoan.CashBoxId, 10);
  const parts = state.store.installments.filter((i) => i.LoanId === r.loanId).sort((a, b) => a.InstallmentNumber - b.InstallmentNumber);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((i) => i.Amount), [333.33, 333.33, 333.34]);
  assert.equal(parts.reduce((s2, i) => s2 + i.Amount, 0).toFixed(2), '1000.00');
  assert.ok(parts.every((i) => i.Status === 'Pending'));
  const moves = state.store.cashTx.filter((t) => t.ReferenceID === r.loanId);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].TransactionType, 'صرف');
  assert.equal(moves[0].ReferenceType, 'Loan');
  assert.equal(moves[0].Amount, 1000);
  assert.equal(newLoan.CashboxTransactionId, moves[0].CashboxTransactionID);
  assert.ok(state.txLog.includes('commit'));
  assert.ok(!state.txLog.includes('rollback'));
});

test('create with unknown cashbox → «الخزينة غير موجودة» and no writes', async () => {
  resetStore();
  const currentMonth = new Date().toISOString().slice(0, 7);
  await assert.rejects(
    q.create({ employeeId: 1, amount: 100, totalInstallments: 1, startMonth: currentMonth, cashBoxId: 777 }, 'admin'),
    (e) => e.message === 'الخزينة غير موجودة',
  );
  assert.equal(state.writes.filter((w) => w.type.startsWith('insert')).length, 0);
});

// ── الصلاحية والمسارات ───────────────────────────────────────
test('policy loans.canEdit mirrors canCreate/canCancel roles with frmEmployeeLoans:Edit', () => {
  const withClaims = (...cs) => ({ role: 'User', claims: new Set(cs) });
  assert.equal(policies.loans.canEdit({ role: 'Admin', claims: new Set() }), true);
  assert.equal(policies.loans.canEdit({ role: 'HrManager', claims: new Set() }), true);
  assert.equal(policies.loans.canEdit({ role: 'AccountManager', claims: new Set() }), true);
  assert.equal(policies.loans.canEdit({ role: 'AccountsManager', claims: new Set() }), true);
  assert.equal(policies.loans.canEdit(withClaims('frmEmployeeLoans:Edit')), true);
  assert.equal(policies.loans.canEdit(withClaims('frmEmployeeLoans:Add')), false);
  assert.equal(policies.loans.canEdit(withClaims('frmEmployeeLoans:Delete')), false);
  assert.equal(policies.loans.canEdit({ role: 'Sales', claims: new Set() }), false);
});

test('routes: GET /:id registered after specific GETs; installment mutation routes exist', () => {
  const router = require('./loans.routes');
  const entries = router.stack.filter((l) => l.route).map((l) => ({
    path: l.route.path, methods: Object.keys(l.route.methods),
  }));
  const idx = (path, method) => entries.findIndex((e) => e.path === path && e.methods.includes(method));
  assert.ok(idx('/:id', 'get') > idx('/stats', 'get'));
  assert.ok(idx('/:id', 'get') > idx('/installments', 'get'));
  assert.ok(idx('/:id', 'get') > idx('/statement/:employeeId', 'get'));
  assert.ok(idx('/:id', 'get') > idx('/employees-lookup', 'get'));
  assert.ok(idx('/installments/:id/skip', 'post') >= 0);
  assert.ok(idx('/installments/:id/split', 'post') >= 0);
  assert.ok(idx('/installments/:id/update', 'post') >= 0);
});

// ── قائمة السلف: النطاق الافتراضي وفلتر «منتهية» وشهر بلازور ─────────
function seedListLoans() {
  resetStore();
  // سلفة منتهية بدأت في يناير ولها قسط وحيد في مارس (اكتملت به)
  state.store.loans.push({
    LoanId: 101, EmployeeId: 1, LoanAmount: 900, MonthlyInstallment: 900,
    TotalInstallments: 1, PaidInstallments: 1, RemainingAmount: 0,
    LoanDate: '2026-01-05', StartDeductionMonth: '2026-01', Status: 'Completed',
    CashBoxId: 10, CashboxTransactionId: 501, Notes: null,
    ApprovedBy: 'المدير', CreatedBy: 'admin', CreatedAt: '2026-01-05', LastUpdatedAt: '2026-03-30',
  });
  state.store.installments.push({
    InstallmentId: 1010, LoanId: 101, EmployeeId: 1, InstallmentNumber: 1,
    DeductionMonth: '2026-03', Amount: 900, Status: 'Deducted',
    DeductionDate: '2026-03-28', Notes: null, PayrollId: null,
    CreatedBy: 'admin', CreatedAt: '2026-01-05',
  });
  // سلفة ملغية بدأت في مايو
  state.store.loans.push({
    LoanId: 102, EmployeeId: 1, LoanAmount: 600, MonthlyInstallment: 300,
    TotalInstallments: 2, PaidInstallments: 0, RemainingAmount: 0,
    LoanDate: '2026-05-02', StartDeductionMonth: '2026-05', Status: 'Cancelled',
    CashBoxId: 10, CashboxTransactionId: 502, Notes: null,
    ApprovedBy: null, CreatedBy: 'admin', CreatedAt: '2026-05-02', LastUpdatedAt: '2026-05-03',
  });
}

test('list: no filters → ALL loans of every status (no implicit month/status restriction)', async () => {
  seedListLoans();
  const r = await q.getLoans({});
  assert.equal(r.totalCount, 3);
  assert.deepEqual(r.items.map((i) => i.Status).sort(), ['Active', 'Cancelled', 'Completed']);
});

test('list: status=Completed returns exactly the completed loans (stored EN literal)', async () => {
  seedListLoans();
  const r = await q.getLoans({ status: 'Completed' });
  assert.equal(r.totalCount, 1);
  assert.equal(r.items[0].LoanId, 101);
  assert.equal(r.items[0].Status, 'Completed');
  const a = await q.getLoans({ status: 'Active' });
  assert.deepEqual(a.items.map((i) => i.LoanId), [100]);
  const all = await q.getLoans({ status: 'all' });
  assert.equal(all.totalCount, 3);
});

test('list: month filter matches via installment month too (Blazor OR semantics)', async () => {
  seedListLoans();
  // سلفة 101 بدأت 2026-01 لكن قسطها في 2026-03 — لا تظهر إلا بدلالة بلازور
  const byInst = await q.getLoans({ month: '2026-03' });
  assert.deepEqual(byInst.items.map((i) => i.LoanId), [101]);
  // شهر البداية نفسه يطابق أيضًا
  const byStart = await q.getLoans({ month: '2026-11' });
  assert.deepEqual(byStart.items.map((i) => i.LoanId), [100]);
  // دمج «منتهية» مع شهر لا يخصها = فارغ فعلًا (لا قيد ضمني آخر)
  const none = await q.getLoans({ status: 'Completed', month: '2026-11' });
  assert.equal(none.totalCount, 0);
});
