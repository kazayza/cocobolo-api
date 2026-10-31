// اختبارات مُحاكاة (stubbed) لمسار التقارير المالية — بلا قاعدة بيانات حية.
// تغطي: بوابات القوائم لكل قائمة (D19)، استبعاد الملغاة من لوحة المعلومات
// الرئيسية ولوحة CRM، شجرة مجموعة التسويق «اعلان»، المنشئين المحميين في
// اللوحة المالية فقط، وتحليلات المبيعات (بند 23).
// التشغيل: node --test modules/reports/reports-finance.test.js
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-secret-for-reports-stub-0123456789ab';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const state = { recorded: [], groups: [], expenses: [], dashTx: [], crmWonTx: [] };
function resetState() {
  state.recorded = [];
  state.groups = [];
  state.expenses = [];
  state.dashTx = [];
  state.crmWonTx = [];
}
resetState();

const PROTECTED_USERS = [{ Username: 'boss1' }, { Username: 'boss2' }];

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  state.recorded.push(text);

  // المنشئون المحميون
  if (text.includes("FROM Users WHERE Role = 'AccountManager'")) return { recordset: PROTECTED_USERS };
  // تحليلات المبيعات: بيانات السياق
  if (text.includes('FROM Branches')) return { recordset: [{ Id: 1, Name: 'الفرع الأول' }, { Id: 2, Name: 'الفرع الثاني' }] };
  if (text.includes('FROM Warehouses')) return { recordset: [{ Id: 10, BranchId: 1 }, { Id: 20, BranchId: 2 }] };
  if (text.includes('FROM Employees')) {
    return {
      recordset: [
        { Id: 1, Name: 'بائع أول', BranchId: 1 },
        { Id: 2, Name: 'بائع ثانٍ', BranchId: 2 },
      ],
    };
  }
  // تحليلات المبيعات: تواريخ فرص الفواتير + خريطة المالك + دورات البيع
  if (text.includes('GROUP BY TransactionID')) return { recordset: [{ TxId: 1, Dt: '2026-10-03' }] };
  if (text.includes('FROM SalesOpportunities') && text.includes('EmployeeID AS EmployeeId') && !text.includes('LostReasonId')) {
    return { recordset: [] }; // لا روابط فرص تتجاوز المنشئ هنا
  }
  if (text.includes('FROM Transactions WHERE TransactionID IN')) return { recordset: [{ TxId: 1, Dt: '2026-10-05' }] };
  if (text.includes('FROM Parties WHERE PartyID IN')) {
    return { recordset: [{ Id: 11, Name: 'عميل أ' }, { Id: 12, Name: 'عميل ب' }] };
  }
  if (text.includes('MIN(TransactionDate)')) return { recordset: [{ PartyId: 11, FirstBuy: '2026-09-10' }] };
  if (text.includes('FROM LostReasons')) return { recordset: [] };
  // تحليلات المبيعات: الفواتير والفرص
  if (text.includes('FROM Transactions t') && text.includes('NetTotalAmount')) {
    const exclProtected = text.includes('CreatedBy NOT IN');
    const rows = [
      { Id: 1, Date: '2026-10-05', Net: 1000, PartyId: 11, WarehouseId: 10, EmpId: 1, Status: 'Paid', RefNo: 'INV-1', Paid: 1000, PayMethod: 'Cash', CreatedBy: 'seller1' },
      { Id: 2, Date: '2026-10-06', Net: 500, PartyId: 12, WarehouseId: 20, EmpId: 2, Status: 'Open', RefNo: 'INV-2', Paid: 100, PayMethod: null, CreatedBy: 'boss1' },
      { Id: 3, Date: '2026-09-10', Net: 800, PartyId: 11, WarehouseId: 10, EmpId: 1, Status: 'Paid', RefNo: 'INV-0', Paid: 800, PayMethod: 'Bank', CreatedBy: 'seller1' },
    ].filter((r) => {
      const d = String(r.Date);
      const from = p.fromDate.toISOString().slice(0, 10);
      const to = p.toDate.toISOString().slice(0, 10);
      if (d < from || d > to) return false;
      if (exclProtected && r.CreatedBy === 'boss1') return false;
      return true;
    });
    return { recordset: rows };
  }
  if (text.includes('FROM SalesOpportunities') && text.includes('LostReasonId')) {
    const all = [
      { EmployeeId: 1, StageId: 3, TransactionId: 1, LostReasonId: null, CreatedAt: '2026-10-03' },
      { EmployeeId: 1, StageId: 4, TransactionId: null, LostReasonId: null, CreatedAt: '2026-10-04' },
    ];
    const from = p.fromDate.toISOString().slice(0, 10);
    const toEx = p.toDate.toISOString().slice(0, 10);
    return { recordset: all.filter((r) => String(r.CreatedAt) >= from && String(r.CreatedAt) < toEx) };
  }
  // مجموعات المصروفات (شجرة التسويق)
  if (text.includes('FROM ExpenseGroups')) return { recordset: state.groups };
  // لوحة CRM الكبيرة
  if (text.includes('@currentOpportunities')) {
    const listMatch = text.match(/ExpenseGroupID IN \(([\d,]+)\)/);
    const ids = listMatch ? listMatch[1].split(',').map(Number) : [];
    const sumExp = (from, to) => state.expenses
      .filter((e) => ids.includes(e.g) && e.d >= from && e.d <= to)
      .reduce((s, e) => s + e.amt, 0);
    const seg = text.slice(text.indexOf('الإيراد الفعلي'), text.indexOf('المحصل'));
    const excl = seg.includes("InvoiceStatus <> 'Cancelled'");
    const actual = state.crmWonTx
      .filter((t) => !excl || t.Status !== 'Cancelled')
      .reduce((s, t) => s + t.Grand, 0);
    return {
      recordset: [{
        currentOpportunities: 0, currentWon: 0, currentLost: 0,
        currentExpectedRevenue: 0, currentActualRevenue: actual, currentCollected: 0,
        currentConversion: 0, currentAvgCloseTime: 0,
        prevOpportunities: 0, prevWon: 0, prevLost: 0,
        prevExpectedRevenue: 0, prevActualRevenue: actual,
        prevConversion: 0, prevAvgCloseTime: 0,
        currentMarketingCost: sumExp(p.cStart instanceof Date ? p.cStart.toISOString().slice(0, 10) : String(p.cStart),
          p.cEnd instanceof Date ? p.cEnd.toISOString().slice(0, 10) : String(p.cEnd)),
        prevMarketingCost: sumExp(p.pStart instanceof Date ? p.pStart.toISOString().slice(0, 10) : String(p.pStart),
          p.pEnd instanceof Date ? p.pEnd.toISOString().slice(0, 10) : String(p.pEnd)),
        todayTasks: 0, overdueTasks: 0, openComplaints: 0,
        stagnantOpportunities: 0, overdueFollowUps: 0,
      }],
    };
  }
  // لوحة المعلومات الرئيسية: صف الإحصائيات
  if (text.includes('salesToday')) {
    const excl = text.includes("InvoiceStatus <> 'Cancelled'");
    const now = new Date();
    const sameDay = (d, ref) => d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
    const sameMonth = (d, ref) => d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
    const prevMonthRef = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const sum = (pred) => state.dashTx
      .filter((t) => t.Type === 'Sale' && pred(new Date(t.Date)) && (!excl || t.Status !== 'Cancelled'))
      .reduce((s, t) => s + t.Grand, 0);
    return {
      recordset: [{
        newClientsToday: 0, openOpportunities: 0, tasksToday: 0, unreadCount: 0,
        salesToday: sum((d) => sameDay(d, now)),
        salesMonth: sum((d) => sameMonth(d, now)),
        salesPrevMonth: sum((d) => sameMonth(d, prevMonthRef)),
      }],
    };
  }
  // اتجاه 7 أيام: العملاء/المهام فارغة، والمبيعات من الجهاز
  if (text.includes('FROM Parties')) return { recordset: [] };
  if (text.includes('FROM CRM_Tasks')) return { recordset: [] };
  if (text.includes('FROM Transactions')) {
    const excl = text.includes("InvoiceStatus <> 'Cancelled'");
    const byDay = new Map();
    for (const t of state.dashTx) {
      if (t.Type !== 'Sale' || (excl && t.Status === 'Cancelled')) continue;
      const key = String(t.Date).slice(0, 10);
      byDay.set(key, (byDay.get(key) || 0) + t.Grand);
    }
    return { recordset: [...byDay.entries()].map(([d, cnt]) => ({ d, cnt })) };
  }
  // اللوحة المالية: استعلامات عامة
  if (text.includes('FROM PersonalAccounts')) return { recordset: [] };
  if (text.includes('FROM FinancialSettings')) return { recordset: [] };
  if (text.includes('GROUP BY')) return { recordset: [] };
  return { recordset: [{}] };
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

const policies = require('../../shared/authorization.policy');
const fin = require('./financial-reports.queries');
const crm = require('./reports.queries');
const dash = require('../dashboard/dashboard.queries');
const sa = require('./sales-analytics.queries');

const auth = (role, ...claims) => ({ role, claims: new Set(claims) });

// ── بوابات القوائم (D19) ─────────────────────────────────────
test('statement gates matrix: real Blazor literals only, per-statement', () => {
  const R = policies.reports;
  // حامل frmCashBoxDashboard:View يمر بالقوائم الثلاث كلها (كما في بلازور)
  const cash = auth('User', 'frmCashBoxDashboard:View');
  assert.equal(R.canViewIncomeStatement(cash), true);
  assert.equal(R.canViewCashFlow(cash), true);
  assert.equal(R.canViewBalanceSheet(cash), true);
  // حامل frm_CashFlowNew:View يمر بالتدفقات فقط
  const cf = auth('User', 'frm_CashFlowNew:View');
  assert.equal(R.canViewCashFlow(cf), true);
  assert.equal(R.canViewIncomeStatement(cf), false);
  assert.equal(R.canViewBalanceSheet(cf), false);
  // حامل frmIncomeStatement:View يمر بالدخل والميزانية لا التدفقات
  const inc = auth('User', 'frmIncomeStatement:View');
  assert.equal(R.canViewIncomeStatement(inc), true);
  assert.equal(R.canViewBalanceSheet(inc), true);
  assert.equal(R.canViewCashFlow(inc), false);
  // rpt_IncomeStatement للميزانية فقط
  const rpt = auth('User', 'rpt_IncomeStatement:View');
  assert.equal(R.canViewBalanceSheet(rpt), true);
  assert.equal(R.canViewIncomeStatement(rpt), false);
  // الاسم المخترع القديم ميت: لا يفتح أي بوابة
  const invented = auth('User', 'frm_IncomeStatement:View');
  assert.equal(R.canViewIncomeStatement(invented), false);
  assert.equal(R.canViewBalanceSheet(invented), false);
  const inventedCf = auth('User', 'frm_CashFlowStatement:View');
  assert.equal(R.canViewCashFlow(inventedCf), false);
  // Admin يمر بالكل
  const admin = auth('Admin');
  assert.equal(R.canViewIncomeStatement(admin), true);
  assert.equal(R.canViewCashFlow(admin), true);
  assert.equal(R.canViewBalanceSheet(admin), true);
  // بوابة لوحة CRM/تحليلات المبيعات وبوابة /debug
  assert.equal(R.canViewSalesAnalytics(auth('SalesManager')), true);
  assert.equal(R.canViewSalesAnalytics(auth('User', 'frm_SalesAnalytics:View')), true);
  assert.equal(R.canViewSalesAnalytics(auth('User')), false);
  assert.equal(R.canViewExecutiveCockpit(auth('User', 'frm_ExecutiveCockpit:View')), true);
  assert.equal(R.canViewExecutiveCockpit(auth('User')), false);
});

test('routes wiring: statements gated per-statement, financial-dashboard authenticate-only, /dashboard + /sales-analytics gated, /debug gated', () => {
  const reportsRouter = require('./reports.routes');
  const dashRouter = require('../dashboard/dashboard.routes');
  const handlers = (router, path, method = 'get') => {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    return layer ? layer.route.stack.length : 0;
  };
  assert.equal(handlers(reportsRouter, '/income-statement'), 2);
  assert.equal(handlers(reportsRouter, '/balance-sheet'), 2);
  assert.equal(handlers(reportsRouter, '/cash-flow'), 2);
  assert.equal(handlers(reportsRouter, '/financial-dashboard'), 1); // [Authorize] فقط — تطابق بلازور
  assert.equal(handlers(reportsRouter, '/dashboard'), 2);
  assert.equal(handlers(reportsRouter, '/sales-analytics'), 2);
  assert.equal(handlers(reportsRouter, '/sales-analytics/filters'), 2);
  assert.equal(handlers(dashRouter, '/debug'), 2);
  assert.equal(handlers(dashRouter, '/'), 1);
});

// ── لوحة المعلومات الرئيسية: استبعاد الملغاة (بند 19) ─────────
test('home dashboard: cancelled invoices change nothing in sales sums or 7-day trend', async () => {
  resetState();
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const prev15 = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  state.dashTx = [
    { Type: 'Sale', Grand: 300, Status: 'Open', Date: iso(now) },
    { Type: 'Sale', Grand: 200, Status: 'Paid', Date: iso(now) },
    { Type: 'Sale', Grand: 999, Status: 'Cancelled', Date: iso(now) },
    { Type: 'Sale', Grand: 100, Status: 'Open', Date: iso(prev15) },
    { Type: 'Sale', Grand: 500, Status: 'Cancelled', Date: iso(prev15) },
  ];
  const stats = await dash.getDashboardStats(1, 'admin', 'Admin', null);
  assert.equal(stats.salesToday, 500); // 300 + 200 — الملغاة 999 خارجًا
  assert.equal(stats.salesMonth, 500);
  assert.equal(stats.salesPrevMonth, 100); // الملغاة 500 خارجًا
  const trends = await dash.getDashboardTrends(1, 'admin', 'Admin', null);
  assert.equal(trends.salesTrend7.split(',').at(-1), '500');
});

// ── لوحة CRM: الإيراد الفعلي بلا ملغاة + شجرة التسويق (بند 21) ──
const CRM_DATES = { cStart: '2026-10-01', cEnd: '2026-10-31', pStart: '2026-09-01', pEnd: '2026-09-30', diffDays: 31 };
function seedCrm() {
  resetState();
  state.crmWonTx = [
    { Grand: 1000, Status: 'Open' },
    { Grand: 400, Status: 'Cancelled' },
  ];
  state.expenses = [
    { g: 5, amt: 100, d: '2026-10-10' },
    { g: 6, amt: 50, d: '2026-10-11' },
    { g: 7, amt: 25, d: '2026-10-12' },
    { g: 9, amt: 999, d: '2026-10-10' },
    { g: 29, amt: 777, d: '2026-10-10' },
    { g: 5, amt: 40, d: '2026-09-10' },
  ];
}

test('CRM marketing tree: group whose name contains «اعلان» + all descendants; group 9 ignored', async () => {
  seedCrm();
  state.groups = [
    { ExpenseGroupID: 9, ExpenseGroupName: 'تسويق عام', ParentGroupID: null },
    { ExpenseGroupID: 5, ExpenseGroupName: 'اعلانات ممولة', ParentGroupID: null },
    { ExpenseGroupID: 6, ExpenseGroupName: 'حملات', ParentGroupID: 5 },
    { ExpenseGroupID: 7, ExpenseGroupName: 'سوشيال', ParentGroupID: 6 },
    { ExpenseGroupID: 29, ExpenseGroupName: 'مجموعة قديمة', ParentGroupID: null },
  ];
  assert.deepEqual((await crm._test.getMarketingGroupIds(fakePool)).sort((a, b) => a - b), [5, 6, 7]);
  const kpi = await crm._test.getKPIs(fakePool, CRM_DATES, {});
  assert.equal(kpi.currentMarketingCost, 175); // 100 + 50 + 25 (الشجرة) — لا 999 ولا 777
  assert.equal(kpi.prevMarketingCost, 40);
  assert.equal(kpi.currentActualRevenue, 1000); // الملغاة 400 مستبعدة
  assert.equal(kpi.prevActualRevenue, 1000);
});

test('CRM marketing fallback: no name match → group 29 only', async () => {
  seedCrm();
  state.groups = [
    { ExpenseGroupID: 9, ExpenseGroupName: 'تسويق', ParentGroupID: null },
    { ExpenseGroupID: 29, ExpenseGroupName: 'أخرى', ParentGroupID: null },
  ];
  assert.deepEqual(await crm._test.getMarketingGroupIds(fakePool), [29]);
  const kpi = await crm._test.getKPIs(fakePool, CRM_DATES, {});
  assert.equal(kpi.currentMarketingCost, 777);
  assert.equal(kpi.prevMarketingCost, 0);
});

// ── المنشئون المحميون (بند 4) ────────────────────────────────
test('protected creators: determinate source = Users with Role AccountManager; authorized viewers get empty list', async () => {
  resetState();
  assert.deepEqual(await fin._internal.getProtectedCreators(fakePool, auth('Sales')), ['boss1', 'boss2']);
  assert.deepEqual(await fin._internal.getProtectedCreators(fakePool, auth('AccountManager')), []);
  assert.deepEqual(await fin._internal.getProtectedCreators(fakePool, auth('Account')), []);
  assert.deepEqual(await fin._internal.getProtectedCreators(fakePool, auth('Admin')), []);
  assert.equal(fin._internal.protectedSql('t', []), '');
  assert.ok(fin._internal.protectedSql('t', ['boss1']).includes("t.CreatedBy NOT IN (N'boss1')"));
});

test('financial dashboard: exclusion applies to dashboard sections only — income statement itself stays all-inclusive', async () => {
  resetState();
  const range = { from: new Date(Date.UTC(2026, 9, 1)), to: new Date(Date.UTC(2026, 9, 31)), branchId: null, cashBoxId: null };
  const dto = await fin.getFinancialDashboard(fakePool, range, auth('Sales'));
  assert.equal(dto.HiddenProtectedSales, true);
  const joined = state.recorded.join('\n');
  const findQ = (needle) => state.recorded.find((t) => t.includes(needle)) || '';
  // النسب (التحصيل + إجمالي المستحقات) والترند وأعلى المنتجات: الاستبعاد حاضر
  assert.ok(findQ('AS Invoiced').includes("CreatedBy NOT IN (N'boss1'"), 'ratios');
  // استعلامات «AS Revenue» تتشابه بين ملخص قائمة الدخل والترند الموحّد:
  // الترند (اللوحة) مستبعِد، وملخص الدخل غير مستبعِد — الاثنان معًا هما الإثبات.
  const revenueQueries = state.recorded.filter((t) => t.includes('AS Revenue FROM Transactions t'));
  assert.ok(revenueQueries.some((t) => t.includes("CreatedBy NOT IN (N'boss1'")), 'trend revenue excluded');
  assert.ok(revenueQueries.some((t) => !t.includes('CreatedBy NOT IN')), 'income summary not excluded');
  assert.ok(findQ('OrdersCount').includes("CreatedBy NOT IN (N'boss1'"), 'top products');
  // قائمة الدخل نفسها: بلا أي استبعاد (FinancialReportsService.cs:22-24)
  assert.ok(!findQ('AS TotalRevenue').includes('CreatedBy NOT IN'), 'income statement');
  // أعلى العملاء وملخص الذمم: بلازور لا يستبعد فيهما — محفوظ
  assert.ok(!findQ('AS TotalPaid').includes('CreatedBy NOT IN'), 'top customers');
  assert.ok(joined.includes('boss1')); // القائمة استُخدمت فعلًا في مكان ما
});

// ── تحليلات المبيعات (بند 23) ────────────────────────────────
test('sales analytics: Blazor figures with protected-creator exclusion and team conversion', async () => {
  resetState();
  const filter = sa.parseFilter({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  const dto = await sa.getSalesAnalytics(fakePool, filter, auth('SalesManager'));
  // فاتورة boss1 (500) مستبعدة: المشاهد SalesManager لا يرى فواتير مديري الحسابات
  assert.equal(dto.HiddenAccountManagerSales, true);
  assert.equal(dto.UserCanSeeAccountManagerInvoices, false);
  assert.equal(dto.TotalAmount, 1000);
  assert.equal(dto.PrevTotalAmount, 800);
  assert.equal(dto.TotalGrowthPct, 25);
  assert.equal(dto.InvoiceCount, 1);
  assert.equal(dto.Customers, 1);
  assert.equal(dto.AvgInvoice, 1000);
  // فرص الفريق: 2 (واحدة مغلقة بوصل فاتورة، واحدة خاسرة)
  assert.equal(dto.TeamOpportunities, 2);
  assert.equal(dto.TeamWonDeals, 1);
  assert.equal(dto.TeamConversionRate, 50);
  assert.equal(dto.TeamLostOpportunities, 1);
  assert.equal(dto.TeamInProgress, 0);
  // التحصيل
  assert.equal(dto.CollectionRate, 100);
  assert.equal(dto.CollectedAmount, 1000);
  assert.equal(dto.OutstandingAmount, 0);
  // طرق الدفع بالتسميات العربية لبلازور
  assert.deepEqual(dto.PaymentMethods, [{ Label: 'نقدي', Value: 1000 }]);
  // الموظف الأول: مبيعاته ودورة بيعه (فرصة 3 أكتوبر ← فاتورة 5 أكتوبر = يومان)
  assert.equal(dto.Employees.length, 1);
  assert.equal(dto.Employees[0].EmpId, 1);
  assert.equal(dto.Employees[0].SalesAmount, 1000);
  assert.equal(dto.Employees[0].AvgCycleDays, 2);
  assert.equal(dto.Employees[0].Invoices.length, 1);
  // عميل عائد (أول شراء في سبتمبر) ولا جدد
  assert.equal(dto.NewCustomers, 0);
  assert.equal(dto.ReturningCustomers, 1);
  // الترند: 31 يومًا بخطوة يومية
  assert.equal(dto.TrendLabels.length, 31);
  assert.equal(dto.TrendCurrent.reduce((s, v) => s + v, 0), 1000);
  assert.equal(dto.ScopeFromDate, null); // جلسة الـ API بلا CrmAccessFrom
});

test('sales analytics helpers: trend buckets and branch/employee matching', () => {
  const from = new Date(Date.UTC(2026, 9, 1));
  const trend = sa._test.buildTrend(
    [{ Date: '2026-10-01', Net: 100 }, { Date: '2026-10-03', Net: 50 }],
    from, [], new Date(Date.UTC(2026, 8, 24)), 7,
  );
  assert.deepEqual(trend.current, [100, 0, 50, 0, 0, 0, 0]);
  const ctx = { warehouseBranch: new Map([[10, 1], [20, 2]]) };
  const sale = { Id: 9, WarehouseId: 10, EmpId: 5 };
  const ownerMap = new Map([[9, 5]]);
  assert.equal(sa._test.matches(sale, { branchId: 1, employeeId: null, invoiceStatus: null }, ctx, ownerMap), true);
  assert.equal(sa._test.matches(sale, { branchId: 2, employeeId: null, invoiceStatus: null }, ctx, ownerMap), false);
  assert.equal(sa._test.matches(sale, { branchId: null, employeeId: 7, invoiceStatus: null }, ctx, ownerMap), false);
  assert.equal(sa._test.payMethodLabel('InstaPay'), 'انستاباي');
  assert.equal(sa._test.payMethodLabel('Whatever'), 'أخرى');
});
