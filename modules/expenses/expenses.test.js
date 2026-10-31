// اختبارات مُحاكاة (stubbed) لوحدة المصروفات — بلا أي قاعدة بيانات حية.
// تُستبدل وحدة core/database بذاكرة وهمية تنفّذ دلالات الاستعلامات التي
// تستخدمها expenses.queries، وتدعم المعاملات بلقطة/استرجاع حتى تُفحص
// الذرّية وعدم حدوث أي كتابة عند الرفض.
// التشغيل: node --test modules/expenses/expenses.test.js
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-for-expenses-stub-0123456789abcdef';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── أدوات التاريخ (تواريخ نسبية لليوم الحالي حتى لا تشيخ الثوابت) ──
const pad = (n) => String(n).padStart(2, '0');
function ds(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function mk(d) { return ds(d).slice(0, 7); }
function shiftMonth(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  return mk(new Date(y, m - 1 + delta, 1));
}
const NOW = new Date();
const TODAY = ds(NOW);
const CUR = mk(NOW);
const PREV = shiftMonth(CUR, -1);
const DAY_OF_MONTH = NOW.getDate();

// ── المخزن الوهمي ─────────────────────────────────────────────
// الثوابت المرجعية (حسابها اليدوي في تعليقات الاختبارات):
//  - عائلة مقدم: أصل (id=1, Amount=0, AdvanceMonths=3, AdvanceMonthIndex=0)
//    + 3 أشهر فرعية × 100 = 300 (قسط = round2(300/3)=100، فرق التقريب 0).
//  - عادية: اليوم 50 (وقود/مجموعة2)، الشهر الحالي 200 (صيانة/مجموعة3)،
//    الشهر السابق 100 (مجموعة2) + 300 (مجموعة3).
//  - المعترف به = 7 صفوف، إجماليها 300+50+200+100+300 = 950.
const state = { store: null, writes: [], txLog: [] };
let nextExpenseId; let nextGroupId; let nextTxId; let lastIdentity;

function baseExpense(partial) {
  return {
    ExpenseGroupID: 2, CashBoxID: 10, BranchID: 1, Notes: null, Torecipient: null,
    IsAdvance: false, AdvanceMonths: null, AdvanceParentExpenseId: null,
    AdvanceMonthIndex: null, CreatedBy: 'admin', CreatedAt: TODAY,
    ...partial,
  };
}

function resetStore() {
  nextExpenseId = 100; nextGroupId = 50; nextTxId = 9000; lastIdentity = null;
  state.writes = []; state.txLog = [];
  const childDate = (i) => ds(new Date(NOW.getFullYear(), NOW.getMonth() + i, 1));
  state.store = {
    branches: [{ BranchID: 1, BranchNameAr: 'الفرع الرئيسي', IsActive: 1 }],
    groups: [
      { ExpenseGroupID: 1, ExpenseGroupName: 'تشغيل', ParentGroupID: null, CreatedBy: 'admin', CreatedAt: TODAY },
      { ExpenseGroupID: 2, ExpenseGroupName: 'وقود', ParentGroupID: 1, CreatedBy: 'admin', CreatedAt: TODAY },
      { ExpenseGroupID: 3, ExpenseGroupName: 'صيانة', ParentGroupID: null, CreatedBy: 'admin', CreatedAt: TODAY },
      { ExpenseGroupID: 4, ExpenseGroupName: 'فرعية فارغة', ParentGroupID: 3, CreatedBy: 'admin', CreatedAt: TODAY },
    ],
    cashBoxes: [
      { CashBoxID: 10, CashBoxName: 'الخزينة الرئيسية', Description: '', BranchID: 1, OpeningBalance: 1000, Color: null, IsDefault: 1, IsActive: 1 },
      { CashBoxID: 11, CashBoxName: 'خزينة فرعية', Description: '', BranchID: 1, OpeningBalance: 0, Color: null, IsDefault: 0, IsActive: 1 },
      { CashBoxID: 12, CashBoxName: 'خزينة موقوفة', Description: '', BranchID: 1, OpeningBalance: 0, Color: null, IsDefault: 0, IsActive: 0 },
    ],
    expenses: [
      baseExpense({ ExpenseID: 1, ExpenseName: 'إيجار مقدم', ExpenseDate: TODAY, Amount: 0, IsAdvance: true, AdvanceMonths: 3, AdvanceMonthIndex: 0 }),
      baseExpense({ ExpenseID: 2, ExpenseName: 'إيجار مقدم - شهر 1/3', ExpenseDate: TODAY, Amount: 100, IsAdvance: true, AdvanceMonths: 3, AdvanceParentExpenseId: 1, AdvanceMonthIndex: 1 }),
      baseExpense({ ExpenseID: 3, ExpenseName: 'إيجار مقدم - شهر 2/3', ExpenseDate: childDate(1), Amount: 100, IsAdvance: true, AdvanceMonths: 3, AdvanceParentExpenseId: 1, AdvanceMonthIndex: 2 }),
      baseExpense({ ExpenseID: 4, ExpenseName: 'إيجار مقدم - شهر 3/3', ExpenseDate: childDate(2), Amount: 100, IsAdvance: true, AdvanceMonths: 3, AdvanceParentExpenseId: 1, AdvanceMonthIndex: 3 }),
      baseExpense({ ExpenseID: 5, ExpenseName: 'وقود سيارات', ExpenseDate: TODAY, Amount: 50, Torecipient: 'محطة وقود', Notes: 'بنزين' }),
      baseExpense({ ExpenseID: 6, ExpenseName: 'صيانة مولد', ExpenseDate: `${CUR}-02`, Amount: 200, ExpenseGroupID: 3 }),
      baseExpense({ ExpenseID: 7, ExpenseName: 'وقود نقل', ExpenseDate: `${PREV}-05`, Amount: 100 }),
      baseExpense({ ExpenseID: 8, ExpenseName: 'صيانة دورية', ExpenseDate: `${PREV}-06`, Amount: 300, ExpenseGroupID: 3 }),
    ],
    // قبض 100000 حتى يجتاز إنشاء الاختبارات حارس الرصيد (قبض − صرف)
    cashTx: [
      { CashboxTransactionID: 1, CashBoxID: 10, TransactionType: 'قبض', ReferenceType: 'Manual', ReferenceID: null, Amount: 100000, TransactionDate: TODAY, Notes: null, CreatedBy: 'admin' },
    ],
    audit: [],
  };
}
resetStore();

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const s = state.store;

  if (text.includes('INSERT INTO [dbo].[Audit_Log]')) {
    const row = {
      TableName: p.table, ActionType: p.action, PrimaryKeyValue: p.key,
      LoginName: p.username, OldData: p.oldData, NewData: p.newData,
    };
    s.audit.push(row);
    state.writes.push({ type: 'audit', row });
    return { recordset: [] };
  }
  if (text.includes('INSERT INTO CashboxTransactions')) {
    const row = {
      CashboxTransactionID: nextTxId++, CashBoxID: p.cashBoxId,
      TransactionType: text.includes("N'صرف'") ? 'صرف' : 'قبض',
      ReferenceType: 'Expense', ReferenceID: p.referenceId, Amount: p.amount,
      TransactionDate: p.expenseDate, Notes: p.notes, CreatedBy: p.createdBy,
    };
    s.cashTx.push(row);
    state.writes.push({ type: 'insert-cashTx', row });
    return { recordset: [] };
  }
  if (text.includes('INSERT INTO Expenses')) {
    let row;
    if (text.includes('@parentId')) {
      row = baseExpense({
        ExpenseID: nextExpenseId++, ExpenseName: p.expenseName, ExpenseGroupID: p.expenseGroupId,
        CashBoxID: p.cashBoxId, BranchID: p.branchId, Amount: p.amount, ExpenseDate: ds(new Date(p.expenseDate)),
        Notes: p.notes, Torecipient: p.toRecipient, IsAdvance: true, AdvanceMonths: p.advanceMonths,
        AdvanceParentExpenseId: p.parentId, AdvanceMonthIndex: p.monthIndex, CreatedBy: p.createdBy,
      });
    } else if (text.includes('1, @advanceMonths')) {
      row = baseExpense({
        ExpenseID: nextExpenseId++, ExpenseName: p.expenseName, ExpenseGroupID: p.expenseGroupId,
        CashBoxID: p.cashBoxId, BranchID: p.branchId, Amount: 0, ExpenseDate: ds(new Date(p.expenseDate)),
        Notes: p.notes, Torecipient: p.toRecipient, IsAdvance: true, AdvanceMonths: p.advanceMonths,
        AdvanceMonthIndex: 0, CreatedBy: p.createdBy,
      });
    } else {
      row = baseExpense({
        ExpenseID: nextExpenseId++, ExpenseName: p.expenseName, ExpenseGroupID: p.expenseGroupId,
        CashBoxID: p.cashBoxId, BranchID: p.branchId, Amount: p.amount, ExpenseDate: ds(new Date(p.expenseDate)),
        Notes: p.notes, Torecipient: p.toRecipient, CreatedBy: p.createdBy,
      });
    }
    s.expenses.push(row);
    lastIdentity = row.ExpenseID;
    state.writes.push({ type: 'insert-expense', row });
    return { recordset: [] };
  }
  if (text.includes('SELECT SCOPE_IDENTITY() AS ExpenseID')) {
    return { recordset: [{ ExpenseID: lastIdentity }] };
  }
  if (text.includes('INSERT INTO ExpenseGroups')) {
    const row = {
      ExpenseGroupID: nextGroupId++, ExpenseGroupName: p.name,
      ParentGroupID: p.parentId, CreatedBy: p.createdBy, CreatedAt: TODAY,
    };
    s.groups.push(row);
    state.writes.push({ type: 'insert-group', row });
    return { recordset: [{ ExpenseGroupID: row.ExpenseGroupID }] };
  }
  if (text.includes('UPDATE Expenses SET')) {
    const e = s.expenses.find((x) => x.ExpenseID === p.id);
    if (e) {
      Object.assign(e, {
        ExpenseName: p.expenseName, ExpenseGroupID: p.expenseGroupId, CashBoxID: p.cashBoxId,
        BranchID: p.branchId, Amount: p.amount, ExpenseDate: ds(new Date(p.expenseDate)),
        Notes: p.notes, Torecipient: p.toRecipient, IsAdvance: false,
        AdvanceMonths: null, AdvanceMonthIndex: null,
      });
      state.writes.push({ type: 'update-expense', id: p.id });
    }
    return { recordset: [] };
  }
  if (text.includes('UPDATE ExpenseGroups SET')) {
    const g = s.groups.find((x) => x.ExpenseGroupID === p.id);
    if (g) { g.ExpenseGroupName = p.name; g.ParentGroupID = p.parentId; state.writes.push({ type: 'update-group', id: p.id }); }
    return { recordset: [] };
  }
  if (text.includes('DELETE FROM CashboxTransactions')) {
    const before = s.cashTx.length;
    if (text.includes("ReferenceType = 'Expense'")) {
      s.cashTx = s.cashTx.filter((t) => !(t.ReferenceType === 'Expense' && t.ReferenceID === p.parentId));
    } else if (text.includes("'AdvanceExpense'")) {
      s.cashTx = s.cashTx.filter((t) => !(t.ReferenceType === 'AdvanceExpense'
        && s.expenses.some((e) => e.ExpenseID === t.ReferenceID
          && (e.ExpenseID === p.parentId || e.AdvanceParentExpenseId === p.parentId))));
    } else {
      s.cashTx = s.cashTx.filter((t) => !(t.ReferenceID === p.referenceId
        && (t.ReferenceType === 'Expense' || t.ReferenceType === 'AdvanceExpense')));
    }
    if (s.cashTx.length !== before) state.writes.push({ type: 'delete-cashTx' });
    return { recordset: [] };
  }
  if (text.includes('DELETE FROM Expenses')) {
    s.expenses = s.expenses.filter((e) => !(e.ExpenseID === p.parentId || e.AdvanceParentExpenseId === p.parentId));
    state.writes.push({ type: 'delete-expenses' });
    return { recordset: [] };
  }
  if (text.includes('DELETE FROM ExpenseGroups')) {
    s.groups = s.groups.filter((g) => g.ExpenseGroupID !== p.id);
    state.writes.push({ type: 'delete-group', id: p.id });
    return { recordset: [] };
  }
  if (text.includes('SELECT * FROM Expenses')) {
    const e = s.expenses.find((x) => x.ExpenseID === p.id);
    return { recordset: e ? [{ ...e, BranchID: e.BranchID, CashBoxID: e.CashBoxID }] : [] };
  }
  if (text.includes('FROM CashBoxes') && text.includes('BranchID AS BranchId, IsActive')) {
    const box = s.cashBoxes.find((c) => c.CashBoxID === p.cashBoxId);
    return { recordset: box ? [{ CashBoxID: box.CashBoxID, BranchId: box.BranchID, IsActive: box.IsActive }] : [] };
  }
  if (text.includes('SELECT BranchID FROM Branches')) {
    const b = s.branches.find((x) => x.BranchID === p.branchId && x.IsActive === 1);
    return { recordset: b ? [{ BranchID: b.BranchID }] : [] };
  }
  if (text.includes('FROM CashboxTransactions') && text.includes('AS Balance')) {
    let balance = 0;
    for (const t of s.cashTx.filter((x) => x.CashBoxID === p.cashBoxId)) {
      balance += t.TransactionType === 'قبض' ? Number(t.Amount) : -Number(t.Amount);
    }
    return { recordset: [{ Balance: balance }] };
  }
  if (text.includes('FROM Expenses e') && text.includes('LEFT JOIN ExpenseGroups')) {
    const rows = s.expenses.map((e) => {
      const g = s.groups.find((x) => x.ExpenseGroupID === e.ExpenseGroupID);
      const box = s.cashBoxes.find((x) => x.CashBoxID === e.CashBoxID);
      const br = s.branches.find((x) => x.BranchID === e.BranchID);
      return {
        ...e, BranchId: e.BranchID, BranchName: br ? br.BranchNameAr : null,
        ExpenseGroupName: g ? g.ExpenseGroupName : null,
        CashBoxName: box ? box.CashBoxName : null,
      };
    });
    return { recordset: rows };
  }
  if (text.includes('CreatedBy, CreatedAt FROM ExpenseGroups')) {
    return { recordset: s.groups.map((g) => ({ ...g })) };
  }
  if (text.includes('SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID FROM ExpenseGroups WHERE')) {
    const g = s.groups.find((x) => x.ExpenseGroupID === p.id);
    return { recordset: g ? [{ ExpenseGroupID: g.ExpenseGroupID, ExpenseGroupName: g.ExpenseGroupName, ParentGroupID: g.ParentGroupID }] : [] };
  }
  if (text.includes('SELECT ExpenseGroupID FROM ExpenseGroups WHERE')) {
    const g = s.groups.find((x) => x.ExpenseGroupID === p.parentId);
    return { recordset: g ? [{ ExpenseGroupID: g.ExpenseGroupID }] : [] };
  }
  if (text.includes('SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID FROM ExpenseGroups')) {
    const g = s.groups.find((x) => x.ExpenseGroupID === p.id);
    return { recordset: g ? [{ ...g }] : [] };
  }
  if (text.includes('COUNT(*) AS C FROM Expenses')) {
    return { recordset: [{ C: s.expenses.filter((e) => e.ExpenseGroupID === p.id).length }] };
  }
  if (text.includes('COUNT(*) AS C FROM ExpenseGroups')) {
    return { recordset: [{ C: s.groups.filter((g) => g.ParentGroupID === p.id).length }] };
  }
  if (text.includes('FROM CashBoxes c')) {
    const rows = s.cashBoxes.filter((c) => c.IsActive === 1).map((c) => {
      let net = 0;
      for (const t of s.cashTx.filter((x) => x.CashBoxID === c.CashBoxID)) {
        net += t.TransactionType === 'قبض' ? Number(t.Amount) : -Number(t.Amount);
      }
      const br = s.branches.find((x) => x.BranchID === c.BranchID);
      return {
        CashBoxID: c.CashBoxID, CashBoxName: c.CashBoxName, Description: c.Description,
        BranchId: c.BranchID, BranchName: br ? br.BranchNameAr : null, Color: c.Color,
        IsDefault: c.IsDefault, IsActive: c.IsActive,
        CurrentBalance: Number(c.OpeningBalance || 0) + net,
      };
    });
    return { recordset: rows };
  }
  if (text.includes('ExpenseGroups G')) {
    const rows = s.groups.map((g) => {
      const pg = s.groups.find((x) => x.ExpenseGroupID === g.ParentGroupID);
      return {
        ExpenseGroupID: g.ExpenseGroupID, ExpenseGroupName: g.ExpenseGroupName,
        ParentGroupName: pg ? pg.ExpenseGroupName : null,
      };
    }).filter((r) => !p.parentGroupName || r.ParentGroupName === p.parentGroupName);
    return { recordset: rows };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 160)}`);
}

class FakeRequest {
  constructor() { this.params = {}; }
  input(name, _type, value) { this.params[name] = value; return this; }
  async query(text) { return executeQuery(text, this.params); }
}
class FakeTransaction {
  constructor() { this.snapshot = null; }
  request() { return new FakeRequest(); }
  async begin() { this.snapshot = structuredClone(state.store); state.txLog.push('begin'); }
  async commit() { this.snapshot = null; state.txLog.push('commit'); }
  async rollback() { if (this.snapshot) state.store = this.snapshot; this.snapshot = null; state.txLog.push('rollback'); }
}
const fakePool = { request: () => new FakeRequest() };
const fakeSql = {
  Int: 'Int', NVarChar: () => 'NVarChar', Decimal: () => 'Decimal', DateTime: 'DateTime',
  Date: 'Date', Bit: 'Bit', MAX: 'MAX', Transaction: FakeTransaction, Request: FakeRequest,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const notifCalls = [];
const notifPath = require.resolve('../notifications/notifications.queries');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: { createNotificationSmart: async (n) => { notifCalls.push(n); } },
};

const q = require('./expenses.queries');
const ctrl = require('./expenses.controller');

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    send(body) { this.body = body; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
  };
}

// ── القائمة: استبعاد رؤوس المقدم افتراضيًا ────────────────────
test('list: advance parent excluded by default; sub-months shown; opt-out includes parent', async () => {
  resetStore();
  const def = await q.getAllExpenses(q.parseFilter({}));
  // المعترف به 7 صفوف؛ الرأس (Amount=0) لو دخل لصار العدّ 8
  assert.equal(def.totalCount, 7);
  assert.ok(!def.items.some((i) => i.ExpenseID === 1));
  assert.ok(def.items.some((i) => i.ExpenseID === 2 && i.AdvanceParentExpenseId === 1));
  const all = await q.getAllExpenses(q.parseFilter({ excludeAdvanceHeaders: 'false' }));
  assert.equal(all.totalCount, 8);
  assert.ok(all.items.some((i) => i.ExpenseID === 1 && i.IsAdvance && i.AdvanceMonths === 3));
  // الصفوف تحمل الفرع ومسار المجموعة الكامل
  const row5 = def.items.find((i) => i.ExpenseID === 5);
  assert.equal(row5.BranchName, 'الفرع الرئيسي');
  assert.equal(row5.FullGroupPath, 'تشغيل > وقود');
});

test('list: pagination page/pageSize + amount sort', async () => {
  resetStore();
  const page2 = await q.getAllExpenses(q.parseFilter({ page: '2', pageSize: '3' }));
  assert.equal(page2.totalCount, 7);
  assert.equal(page2.items.length, 3);
  assert.equal(page2.pageNumber, 2);
  const byAmount = await q.getAllExpenses(q.parseFilter({ sortBy: 'Amount', pageSize: '2' }));
  assert.deepEqual(byAmount.items.map((i) => i.Amount), [300, 200]);
});

test('list: Arabic-normalized search over name/notes/recipient/group-path', async () => {
  resetStore();
  // «صيانه» بالهاء تطابق «صيانة» بالتاء المربوطة بعد التطبيع
  const byName = await q.getAllExpenses(q.parseFilter({ search: 'صيانه' }));
  assert.deepEqual(byName.items.map((i) => i.ExpenseID).sort(), [6, 8]);
  // البحث في مسار المجموعة: «تشغيل» هي الأب لمجموعة «وقود»
  const byPath = await q.getAllExpenses(q.parseFilter({ search: 'تشغيل' }));
  assert.deepEqual(byPath.items.map((i) => i.ExpenseID).sort(), [2, 3, 4, 5, 7]);
  const byRecipient = await q.getAllExpenses(q.parseFilter({ search: 'محطة' }));
  assert.deepEqual(byRecipient.items.map((i) => i.ExpenseID), [5]);
});

test('list: amount-range + cashbox + branch + parent-group filters honored', async () => {
  resetStore();
  state.store.expenses.push(baseExpense({
    ExpenseID: 9, ExpenseName: 'مبلغ كبير', ExpenseDate: TODAY, Amount: 999, CashBoxID: 11,
  }));
  const ranged = await q.getAllExpenses(q.parseFilter({ amountFrom: '500' }));
  assert.deepEqual(ranged.items.map((i) => i.ExpenseID), [9]);
  const ranged2 = await q.getAllExpenses(q.parseFilter({ amountFrom: '90', amountTo: '210' }));
  assert.deepEqual(ranged2.items.map((i) => i.ExpenseID).sort((a, b) => a - b), [2, 3, 4, 6, 7]);
  const byBox = await q.getAllExpenses(q.parseFilter({ cashBoxId: '11' }));
  assert.deepEqual(byBox.items.map((i) => i.ExpenseID), [9]);
  const byParent = await q.getAllExpenses(q.parseFilter({ parentGroupId: '1' }));
  // المجموعة الأم 1 تشمل ابنتها 2 وكل مصروفاتها (بما فيها المضاف 9 بمجموعة 2)
  assert.deepEqual(byParent.items.map((i) => i.ExpenseID).sort((a, b) => a - b), [2, 3, 4, 5, 7, 9]);
  const byBranch = await q.getAllExpenses(q.parseFilter({ branchId: '99' }));
  assert.equal(byBranch.totalCount, 0);
});

// ── الإحصائيات: GetStatsAsync على الفلتر ──────────────────────
test('summary: advance headers excluded from counts; today/period/year/total + group breakdown follow the filter', async () => {
  resetStore();
  const s = await q.getExpensesSummary(q.parseFilter({}));
  // الإجمالي: 7 صفوف معترف بها بمجموع 950 (الرأس مستبعد من العدّ)
  assert.equal(s.totalCount, 7);
  assert.equal(s.totalAmount, 950);
  // اليوم: شهر فرعي اليوم (100) + وقود اليوم (50) = 150، صفّان
  assert.equal(s.todayAmount, 150);
  assert.equal(s.todayCount, 2);
  // الفترة بلا نطاق تاريخ = الشهر الحالي: 100 + 50 + 200 = 350، 3 صفوف
  assert.equal(s.monthAmount, 350);
  assert.equal(s.monthCount, 3);
  // تفصيل المجموعات يتبع الفلتر الكامل: وقود 450 (5 صفوف)، صيانة 500 (صفّان)
  const fuel = s.groupBreakdown.find((g) => g.ExpenseGroupID === 2);
  const maint = s.groupBreakdown.find((g) => g.ExpenseGroupID === 3);
  assert.equal(fuel.Total, 450); assert.equal(fuel.Count, 5); assert.equal(fuel.Percentage, 47.4);
  assert.equal(maint.Total, 500); assert.equal(maint.Count, 2); assert.equal(maint.Percentage, 52.6);
  // بفلتر مجموعة: كل الكروت تنحصر فيها
  const scoped = await q.getExpensesSummary(q.parseFilter({ groupId: '3' }));
  assert.equal(scoped.totalCount, 2);
  assert.equal(scoped.totalAmount, 500);
  assert.equal(scoped.monthAmount, 200);
});

// ── الداشبورد: تعريفات بلازور العشرة ──────────────────────────
test('dashboard: growth/daily-average/active-advances from Blazor formulas', async () => {
  resetStore();
  const d = await q.getExpenseDashboard();
  // الشهر الحالي = شهر مقدم فرعي (100) + 50 + 200 = 350
  assert.equal(d.CurrentMonthAmount, 350);
  // الشهر السابق = 100 + 300 = 400
  assert.equal(d.PreviousMonthAmount, 400);
  // النمو = round1((350 − 400) / 400 × 100) = −12.5
  assert.equal(d.MonthOverMonthGrowth, -12.5);
  // المتوسط اليومي = round2(350 / يوم الشهر الحالي)
  assert.equal(d.DailyAverage, Math.round((350 / DAY_OF_MONTH) * 100) / 100);
  // المقدمات النشطة: رأس واحد AdvanceMonths=3>1، ومجموع أشهره = 100×3 = 300
  assert.equal(d.ActiveAdvanceExpensesCount, 1);
  assert.equal(d.ActiveAdvanceExpensesAmount, 300);
  // اتجاه 12 شهرًا: آخر نقطة = الشهر الحالي 350، وقبلها الشهر السابق 400
  assert.equal(d.MonthlyTrends.length, 12);
  assert.equal(d.MonthlyTrends[11].TotalAmount, 350);
  assert.equal(d.MonthlyTrends[10].TotalAmount, 400);
  // الاتجاه اليومي: طوله أيام الشهر، وبند اليوم = 150 (100+50)
  const daysInMonth = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0).getDate();
  assert.equal(d.DailyTrend.length, daysInMonth);
  assert.equal(d.DailyTrend[DAY_OF_MONTH - 1].Amount, 150);
  // أعلى مصروفات الشهر فردية لا مجمّعة بالاسم: أولها صيانة مولد 200
  assert.equal(d.TopExpenses[0].ExpenseName, 'صيانة مولد');
  assert.equal(d.TopExpenses[0].Amount, 200);
  // باريتو: تراكمي ينتهي عند مجموع نسب السنة (قد يتجاوز/ينقص 100 بالتقريب)
  assert.ok(d.ParetoAnalysis.length >= 2);
  assert.equal(d.ParetoAnalysis[0].Percentage + d.ParetoAnalysis[1].Percentage,
    d.ParetoAnalysis[1].CumulativePercentage);
  // التباين: موجود لكل مجموعة ظهرت في الشهر الحالي أو الثلاثة السابقة
  assert.ok(d.VarianceAnalysis.some((v) => v.GroupName === 'وقود'));
});

// ── الملخص الشهري: صفرية الفجوات + التغيّر ────────────────────
test('monthly summary: zero-fills the gap month and computes change %', async () => {
  resetStore();
  state.store.expenses = [
    baseExpense({ ExpenseID: 21, ExpenseName: 'أ', ExpenseDate: `${shiftMonth(CUR, -3)}-10`, Amount: 100 }),
    baseExpense({ ExpenseID: 22, ExpenseName: 'ب', ExpenseDate: `${shiftMonth(CUR, -1)}-10`, Amount: 300 }),
  ];
  const from = `${shiftMonth(CUR, -3)}-01`;
  // نهاية النطاق = آخر يوم في الشهر الأخير (كما يضبط تقرير بلازور DateTo)
  const [ty, tm] = shiftMonth(CUR, -1).split('-').map(Number);
  const to = ds(new Date(ty, tm, 0));
  const r = await q.getMonthlySummary(q.parseFilter({ dateFrom: from, dateTo: to }));
  // 3 شهور متصلة: 100، فجوة صفرية، 300
  assert.equal(r.Months.length, 3);
  assert.deepEqual(r.Months.map((m) => m.Total), [100, 0, 300]);
  assert.equal(r.Months[1].Count, 0);
  // تغيّر الفجوة = (0−100)/100 = −100%؛ وتغيّر الشهر الأخير: سابقه 0 والمبلغ > 0 ⇒ 100%
  assert.equal(r.Months[1].ChangePercent, -100);
  assert.equal(r.Months[2].ChangePercent, 100);
  assert.equal(r.Months[0].HasPrevious, false);
  // الإجمالي العام 400، العدد 2، متوسط الشهر = round2(400/3) = 133.33
  assert.equal(r.GrandTotal, 400);
  assert.equal(r.TotalCount, 2);
  assert.equal(r.MonthlyAverage, 133.33);
});

// ── الخزائن: نشطة فقط + الرصيد الموحّد ────────────────────────
test('cashboxes: active only, with branch name and unified balance incl. OpeningBalance', async () => {
  resetStore();
  const boxes = await q.getCashboxes();
  assert.deepEqual(boxes.map((b) => b.CashBoxID), [10, 11]); // الموقوفة 12 مستبعدة
  const main = boxes.find((b) => b.CashBoxID === 10);
  assert.equal(main.BranchName, 'الفرع الرئيسي');
  // الرصيد الموحّد = افتتاحي 1000 + قبض 100000 = 101000
  assert.equal(main.CurrentBalance, 101000);
  assert.equal(main.IsDefault, true);
});

// ── هوية المنشئ من التوكن + التدقيق على الإنشاء ───────────────
test('create: body createdBy spoof ignored — token username wins in row, notification and audit', async () => {
  resetStore();
  notifCalls.length = 0;
  const res = mockRes();
  await ctrl.create({
    body: {
      expenseName: 'اختبار انتحال', expenseGroupId: 2, cashBoxId: 10, branchId: 1,
      amount: 500, expenseDate: TODAY, notes: '', toRecipient: '', createdBy: 'mallory',
    },
    auth: { username: 'admin' },
  }, res);
  assert.equal(res.body.success, true);
  const created = state.store.expenses.find((e) => e.ExpenseName === 'اختبار انتحال');
  assert.ok(created);
  assert.equal(created.CreatedBy, 'admin');
  assert.equal(notifCalls[0].createdBy, 'admin');
  const audit = state.store.audit.find((a) => a.TableName === 'Expenses' && a.ActionType === 'Insert');
  assert.ok(audit);
  assert.equal(audit.LoginName, 'admin');
  assert.equal(audit.PrimaryKeyValue, String(created.ExpenseID));
  // حركة خزينة واحدة بصرف 500 على المصروف الجديد
  const moves = state.store.cashTx.filter((t) => t.ReferenceID === created.ExpenseID);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].Amount, 500);
});

// ── المجموعات: الحذف المرفوض لا يكتب شيئًا ────────────────────
test('group delete refused with children and with expenses — and writes NOTHING', async () => {
  resetStore();
  const auditBefore = state.store.audit.length;
  const groupsBefore = state.store.groups.length;
  // بلازور يفحص المصروفات أولًا ثم الأبناء (DeleteExpenseGroupAsync)
  await assert.rejects(q.deleteExpenseGroup(1, 'admin'),
    (e) => e.message === 'لا يمكن حذف مجموعة بها مجموعات فرعية');
  await assert.rejects(q.deleteExpenseGroup(2, 'admin'),
    (e) => e.message === 'لا يمكن حذف مجموعة بها مصروفات');
  assert.equal(state.store.groups.length, groupsBefore);
  assert.equal(state.store.audit.length, auditBefore);
  assert.equal(state.writes.filter((w) => w.type === 'delete-group').length, 0);
});

test('group delete of an empty leaf succeeds with an audit row', async () => {
  resetStore();
  await q.deleteExpenseGroup(4, 'admin');
  assert.ok(!state.store.groups.some((g) => g.ExpenseGroupID === 4));
  const audit = state.store.audit.find((a) => a.TableName === 'ExpenseGroups' && a.ActionType === 'Delete');
  assert.ok(audit);
  assert.equal(audit.PrimaryKeyValue, '4');
});

test('group reparent: self/descendant/nonexistent rejected with Blazor messages; valid move works', async () => {
  resetStore();
  await assert.rejects(q.updateExpenseGroup(1, { expenseGroupName: 'تشغيل', parentGroupId: 1 }, 'admin'),
    (e) => e.message === 'لا يمكن جعل المجموعة أبًا لنفسها');
  // 2 حفيد/ابن مباشر للمجموعة 1 — جعله أبًا لها دورة
  await assert.rejects(q.updateExpenseGroup(1, { expenseGroupName: 'تشغيل', parentGroupId: 2 }, 'admin'),
    (e) => e.message.includes('سينشئ دورة في الشجرة'));
  await assert.rejects(q.updateExpenseGroup(1, { expenseGroupName: 'تشغيل', parentGroupId: 999 }, 'admin'),
    (e) => e.message === 'المجموعة الأم المحددة غير موجودة');
  assert.equal(state.store.groups.find((g) => g.ExpenseGroupID === 1).ParentGroupID, null);
  await q.updateExpenseGroup(4, { expenseGroupName: 'فرعية فارغة', parentGroupId: 2 }, 'admin');
  assert.equal(state.store.groups.find((g) => g.ExpenseGroupID === 4).ParentGroupID, 2);
});

test('group create: nonexistent parent rejected; created group carries token CreatedBy + audit', async () => {
  resetStore();
  await assert.rejects(
    q.createExpenseGroup({ expenseGroupName: 'يتيمة', parentGroupId: 999, createdBy: 'admin' }),
    (e) => e.message === 'المجموعة الأم المحددة غير موجودة');
  const id = await q.createExpenseGroup({ expenseGroupName: 'جديدة', parentGroupId: 1, createdBy: 'admin' });
  const g = state.store.groups.find((x) => x.ExpenseGroupID === id);
  assert.equal(g.CreatedBy, 'admin');
  assert.ok(state.store.audit.some((a) => a.TableName === 'ExpenseGroups' && a.ActionType === 'Insert'
    && a.PrimaryKeyValue === String(id)));
});

// ── عقد المجموعات الكامل + DTO التعديل + الاقتراحات ───────────
test('groups contract: children/expense counts and recognized totals; edit DTO defaults AdvanceMonths to 1', async () => {
  resetStore();
  const groups = await q.getExpenseGroups();
  const fuel = groups.find((g) => g.ExpenseGroupID === 2);
  // وقود: مصروفات معترف بها = 3 أشهر فرعية + وقود سيارات + وقود نقل = 5، مجموعها 450
  assert.equal(fuel.ExpensesCount, 5);
  assert.equal(fuel.TotalAmount, 450);
  assert.equal(fuel.ParentGroupName, 'تشغيل');
  const ops = groups.find((g) => g.ExpenseGroupID === 1);
  assert.equal(ops.ChildrenCount, 1);

  const dto = await q.getExpenseById(5);
  assert.equal(dto.AdvanceMonths, 1); // غائب في الصف ⇒ افتراضي 1
  assert.equal(dto.ExpenseName, 'وقود سيارات');
  assert.equal(dto.Recipient, 'محطة وقود');
  assert.ok(!('IsAdvance' in dto && dto.IsAdvance !== false));
});

test('name suggestions: original expenses only — no advance parents or children', async () => {
  resetStore();
  const names = await q.getNameSuggestions();
  const list = names.map((n) => n.ExpenseName);
  assert.ok(list.includes('وقود سيارات'));
  assert.ok(!list.includes('إيجار مقدم'));
  assert.ok(!list.some((n) => n.includes('شهر')));
  const fuel = names.find((n) => n.ExpenseName === 'وقود سيارات');
  assert.equal(fuel.ExpenseGroupID, 2);
  assert.equal(fuel.FullGroupPath, 'تشغيل > وقود');
});

// ── التصدير CSV ───────────────────────────────────────────────
test('export detailed: CSV with BOM, Blazor columns and a total row', async () => {
  resetStore();
  const res = mockRes();
  await ctrl.exportDetailed({ query: {}, auth: { username: 'admin' } }, res);
  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.ok(res.body.startsWith('﻿'));
  const lines = res.body.split('\r\n');
  assert.equal(lines[0], '﻿التاريخ,الفرع,اسم المصروف / البيان,المجموعة / النوع,الخزينة,المستلم,المبلغ,ملاحظات');
  assert.ok(lines.some((l) => l.includes('الإجمالي الكلي:') && l.includes('950')));
});

// ── المسارات ──────────────────────────────────────────────────
test('routes: group/report/export routes registered before /:id', () => {
  const router = require('./expenses.routes');
  const entries = router.stack.filter((l) => l.route).map((l) => ({
    path: l.route.path, methods: Object.keys(l.route.methods),
  }));
  const idx = (path, method) => entries.findIndex((e) => e.path === path && e.methods.includes(method));
  assert.ok(idx('/:id', 'get') > idx('/groups', 'get'));
  assert.ok(idx('/:id', 'get') > idx('/monthly-summary', 'get'));
  assert.ok(idx('/:id', 'get') > idx('/print-data', 'get'));
  assert.ok(idx('/groups/:id', 'put') >= 0);
  assert.ok(idx('/groups/:id', 'delete') >= 0);
  assert.ok(idx('/export/detailed', 'get') >= 0);
  assert.ok(idx('/export/monthly', 'get') >= 0);
  assert.ok(idx('/name-suggestions', 'get') >= 0);
});
