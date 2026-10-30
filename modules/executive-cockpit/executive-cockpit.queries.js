// ════════════════════════════════════════════════════════════════════
//  لوحة القيادة التنفيذية — مرآة ExecutiveCockpitService.cs في بلازور.
//  التعريفات (بند 29):
//   • FiguresAsync:398-430 — المبيعات الإجمالية = Σ (NetTotalAmount ?? GrandTotal)
//     لبيع غير ملغاة في الفترة، مرتجعات البيع = Σ TotalAmount لمرتجع البيع،
//     المشتريات الصافية تستبعد المرآة (ReferenceType NOT LIKE 'MirrorOf:%')،
//     التحصيلات = Σ Payments المنضمة لبيع بتاريخ الدفعة (بلا فلتر حالة فاتورة)،
//     حركة الخزينة تقبل «قبض/صرف» و«In/Out» معًا.
//   • الصافي والمصروفات من قائمة الدخل نفسها (StatementAsync:474-488):
//     Net = NetProfit، Expenses = TotalOperatingExpenses شاملة الرواتب.
//     قائمة دخل بلازور لا تخصم المرتجعات من الإيراد ولا تقيّد المصروفات
//     بـ Posted (FinancialReportsService.cs:152,548) — محفوظ حرفيًا.
//   • نطاقات المقارنة ComputeRanges:272-310، نطاق الفرع BranchScopeAsync:339-370.
// ════════════════════════════════════════════════════════════════════
const { sql, connectDB } = require('../../core/database');
const {
  addDays, addMonths, addYears, cairoToday, money, intId,
} = require('../../shared/reporting.utils');
const fin = require('../reports/financial-reports.queries');

const TABLE_AR = {
  Transactions: 'الفواتير', TransactionDetails: 'بنود الفواتير', Products: 'المنتجات',
  StockLevels: 'المخزون', StockTransactions: 'حركات المخزون', Warehouses: 'المخازن', Branches: 'الفروع',
  Parties: 'العملاء والموردون', Employees: 'الموظفون', CrmTasks: 'المهام', CRM_Tasks: 'المهام',
  LeadsCRMs: 'العملاء المحتملون', LeadsCRM: 'العملاء المحتملون', LeadInteractions: 'تفاعلات العملاء المحتملين',
  SalesOpportunities: 'الفرص البيعية', Quotations: 'عروض الأسعار', Complaints: 'الشكاوى',
  Expenses: 'المصروفات', Payments: 'المدفوعات', Users: 'المستخدمون', Attendances: 'الحضور', Attendance: 'الحضور',
  AdditionalCharges: 'الرسوم الإضافية', DeliveryMaintenanceItems: 'صيانة التسليمات',
  EmployeeLoans: 'سلف الموظفين', LoanInstallments: 'أقساط السلف', CompanyInfo: 'بيانات الشركة',
};
const ACTION_AR = {
  Insert: 'إضافة', Add: 'إضافة', Create: 'إنشاء', Update: 'تعديل', Edit: 'تعديل', Delete: 'حذف',
  PermanentDelete: 'حذف نهائي', Cancel: 'إلغاء', Approve: 'اعتماد', Reject: 'رفض', Complete: 'إتمام',
  Receive: 'استلام', Apply: 'تطبيق', Import: 'استيراد', Process: 'معالجة', Convert: 'تحويل',
  UpdateDeliveryStatus: 'تحديث تسليم', DeliveryEventRecorded: 'تسجيل تسليمة', DeliveryEventVoided: 'إلغاء تسليمة',
  DeliveryPermissionGranted: 'منح إذن تسليم', DeliveryPermissionRequest: 'طلب إذن تسليم',
  MaintenanceStatusChanged: 'تغيير حالة صيانة', MaintenanceClosed: 'إغلاق بند صيانة',
  ModificationChargeCreated: 'رسوم تعديل: إنشاء', ModificationChargeApproved: 'رسوم تعديل: اعتماد',
  EditRequest: 'طلب تعديل', EditApprove: 'اعتماد طلب تعديل', EditReject: 'رفض طلب تعديل',
  ConvertToInvoice: 'تحويل لفاتورة', CCLog: 'تسجيل فيدباك', CCHide: 'إخفاء فيدباك',
};
const VERB_HINTS = [['permanentdelete', 'حذف نهائي'], ['assign', 'إسناد'], ['approve', 'اعتماد'], ['reject', 'رفض'], ['delete', 'حذف'], ['cancel', 'إلغاء'], ['convert', 'تحويل'], ['complete', 'إتمام'], ['insert', 'إضافة'], ['create', 'إنشاء'], ['update', 'تعديل'], ['edit', 'تعديل'], ['add', 'إضافة'], ['start', 'بدء'], ['import', 'استيراد'], ['process', 'معالجة'], ['apply', 'تطبيق'], ['receive', 'استلام'], ['revive', 'إحياء'], ['deduct', 'خصم'], ['split', 'تقسيم'], ['skip', 'تخطي']];
function normKey(s) { return String(s || '').replace(/_/g, '').trim().toLowerCase(); }
function describe(tableName, actionType) {
  const table = TABLE_AR[Object.keys(TABLE_AR).find((k) => normKey(k) === normKey(tableName)) || ''] || null;
  let action = ACTION_AR[Object.keys(ACTION_AR).find((k) => normKey(k) === normKey(actionType)) || ''];
  if (!action) {
    const key = normKey(actionType);
    action = (VERB_HINTS.find(([token]) => key.includes(token)) || [null, 'إجراء'])[1];
  }
  return table ? `${action} — ${table}` : action;
}
function toSqlDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function dstr(date) { return toSqlDate(date).toISOString().slice(0, 10); }
function formatMonth(date) { return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`; }
function humanizeWhen(value, now = new Date()) {
  if (!value) return 'لا يوجد نشاط';
  const when = new Date(value);
  const diffMinutes = Math.max(0, Math.floor((now - when) / 60000));
  if (diffMinutes < 1) return 'الآن';
  if (diffMinutes < 60) return `منذ ${diffMinutes} دقيقة`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'منذ يوم';
  if (days < 30) return `منذ ${days} أيام`;
  return when.toISOString().slice(0, 10).replaceAll('-', '/');
}
function pctNoAbs(cur, cmp) { // نسبة التوقع في بلازور بلا مقام مطلق (TrendAsync)
  if (!cmp) return 0;
  return Math.round(((cur - cmp) / cmp) * 1000) / 10;
}
function pctAbs(cur, cmp) { // ExecutiveKpiDto: المقام مطلق
  if (!cmp) return 0;
  return Math.round(((cur - cmp) / Math.abs(cmp)) * 1000) / 10;
}
function kpi(cur, prev, year) {
  return {
    Value: money(cur), PrevValue: money(prev), YearValue: money(year),
    PrevPct: pctAbs(cur, prev), YearPct: pctAbs(cur, year),
    HasPrevComparison: money(prev) !== 0, HasYearComparison: money(year) !== 0,
  };
}

// ─── نطاقات الفترة — ComputeRanges:272-310 ───
const PERIOD_KEYS = new Set(['today', 'week', 'month', 'quarter', 'year', 'custom']);
function rangeOf(period, today) {
  if (period === 'today') return [today, today];
  if (period === 'week') {
    const ws = addDays(today, -(((today.getUTCDay() - 6) + 7) % 7));
    return [ws, addDays(ws, 6)];
  }
  if (period === 'quarter') {
    const qm = Math.floor(today.getUTCMonth() / 3) * 3;
    const qs = new Date(Date.UTC(today.getUTCFullYear(), qm, 1));
    return [qs, addDays(addMonths(qs, 3), -1)];
  }
  if (period === 'year') return [new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), new Date(Date.UTC(today.getUTCFullYear(), 11, 31))];
  const ms = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return [ms, addDays(addMonths(ms, 1), -1)];
}
function periodLabelAr(period) {
  return { today: 'اليوم', week: 'هذا الأسبوع', quarter: 'ربع السنة', year: 'السنة' }[period] || 'هذا الشهر';
}
function computeRanges(period, customFrom, customTo) {
  const today = cairoToday();
  if (period === 'custom' && customFrom && customTo) {
    let from = toSqlDate(new Date(customFrom));
    let to = toSqlDate(new Date(customTo));
    if (to < from) [from, to] = [to, from];
    let toEff = to < today ? to : today;
    if (toEff < from) toEff = from;
    const naturalLen = Math.round((to - from) / 86400000) + 1;
    const elapsed = Math.round((toEff - from) / 86400000) + 1;
    const prevFrom = addDays(from, -naturalLen);
    const prevTo = addDays(prevFrom, elapsed - 1);
    const yearFrom = addYears(from, -1);
    const yearNaturalEnd = addDays(yearFrom, naturalLen - 1);
    let yearTo = addDays(yearFrom, elapsed - 1);
    if (yearTo > yearNaturalEnd) yearTo = yearNaturalEnd;
    return {
      from, toEff, prevFrom, prevTo, yearFrom, yearTo,
      label: `فترة مخصصة ${dstr(from).replaceAll('-', '/')} — ${dstr(to).replaceAll('-', '/')}`,
    };
  }
  const [fromN, toN] = rangeOf(period, today);
  const toEff = toN < today ? toN : today;
  const elapsed = Math.max(Math.round((toEff - fromN) / 86400000) + 1, 1);
  const shift = (f, sign) => (period === 'today' ? addDays(f, sign)
    : period === 'week' ? addDays(f, 7 * sign)
      : period === 'quarter' ? addMonths(f, 3 * sign)
        : period === 'year' ? addYears(f, sign) : addMonths(f, sign));
  const prevFrom = shift(fromN, -1);
  const prevNaturalEnd = addDays(shift(prevFrom, 1), -1);
  let prevTo = addDays(prevFrom, elapsed - 1);
  if (prevTo > prevNaturalEnd) prevTo = prevNaturalEnd;
  const yearFrom = addYears(fromN, -1);
  const yearNaturalEnd = addDays(shift(yearFrom, 1), -1);
  let yearTo = addDays(yearFrom, elapsed - 1);
  if (yearTo > yearNaturalEnd) yearTo = yearNaturalEnd;
  return { from: fromN, toEff, prevFrom, prevTo, yearFrom, yearTo, label: periodLabelAr(period) };
}

// ─── نطاق الفرع — BranchScopeAsync:339-370 ───
async function branchScope(pool, branchId) {
  if (!branchId) return { branchId: null, branchName: '', employeeIds: [], warehouseIds: [], cashBoxIds: [], scoped: false };
  const rows = await fin._internal.request(pool, [['branchId', sql.Int, branchId]], `
    SELECT (SELECT BranchNameAr FROM Branches WHERE BranchID = @branchId) AS BranchName,
      (SELECT STRING_AGG(CAST(EmployeeID AS NVARCHAR(12)), ',') FROM Employees WHERE BranchID = @branchId) AS EmpIds,
      (SELECT STRING_AGG(CAST(WarehouseID AS NVARCHAR(12)), ',') FROM Warehouses WHERE BranchID = @branchId) AS WhIds,
      (SELECT STRING_AGG(CAST(CashBoxID AS NVARCHAR(12)), ',') FROM CashBoxes WHERE BranchID = @branchId) AS BoxIds
  `);
  const parse = (v) => String(v || '').split(',').map((x) => Number(x)).filter(Number.isSafeInteger);
  const r = rows[0] || {};
  return {
    branchId, branchName: r.BranchName || '', employeeIds: parse(r.EmpIds),
    warehouseIds: parse(r.WhIds), cashBoxIds: parse(r.BoxIds), scoped: true,
  };
}
function inList(ids) { return ids.length ? ids.join(',') : 'NULL'; }
// إسناد فاتورة للفرع (نفس txScope قائمة الدخل) بصيغة @branchId
function txScopeSql(alias, scope) { return scope.scoped ? fin._internal.txScope(alias, true) : ''; }
function params(range, scope, extra = []) {
  return [
    ['fromDate', sql.Date, toSqlDate(range.from)],
    ['toDate', sql.Date, toSqlDate(range.to)],
    ['branchId', sql.Int, scope.branchId],
    ...extra,
  ];
}
async function safe(section, failed, fn, fallback) {
  try { return await fn(); } catch (error) {
    console.error(`executiveCockpit section ${section}:`, error.message);
    if (!failed.includes(section)) failed.push(section);
    return fallback;
  }
}

// ─── أرقام الفترة — FiguresAsync:398-430 ───
async function figures(pool, from, to, scope) {
  const range = { from, to };
  const rows = await fin._internal.request(pool, params(range, scope), `
    SELECT
      SalesGross = (SELECT ISNULL(SUM(ISNULL(t.NetTotalAmount, t.GrandTotal)), 0) FROM Transactions t
        WHERE t.TransactionType = 'Sale' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
          AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScopeSql('t', scope)}),
      SaleReturns = (SELECT ISNULL(SUM(ISNULL(t.TotalAmount, 0)), 0) FROM Transactions t
        WHERE t.TransactionType = 'SaleReturn' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
          AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScopeSql('t', scope)}),
      PurchasesGross = (SELECT ISNULL(SUM(ISNULL(t.GrandTotal, 0)), 0) FROM Transactions t
        WHERE t.TransactionType = 'Purchase' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
          AND (t.ReferenceType IS NULL OR t.ReferenceType NOT LIKE 'MirrorOf:%')
          AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScopeSql('t', scope)}),
      PurchaseReturns = (SELECT ISNULL(SUM(ISNULL(t.GrandTotal, 0)), 0) FROM Transactions t
        WHERE t.TransactionType = 'PurchaseReturn' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
          AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScopeSql('t', scope)}),
      Collected = (SELECT ISNULL(SUM(p.Amount), 0) FROM Payments p
        INNER JOIN Transactions t ON t.TransactionID = p.TransactionID
        WHERE t.TransactionType = 'Sale'
          AND p.PaymentDate >= @fromDate AND p.PaymentDate < DATEADD(DAY, 1, @toDate) ${txScopeSql('t', scope)}),
      CashIn = (SELECT ISNULL(SUM(ct.Amount), 0) FROM CashboxTransactions ct
        WHERE (ct.TransactionType = N'قبض' OR ct.TransactionType = 'In')
          AND ct.TransactionDate >= @fromDate AND ct.TransactionDate < DATEADD(DAY, 1, @toDate)
          ${scope.scoped ? `AND ct.CashBoxId IN (${inList(scope.cashBoxIds)})` : ''}),
      CashOut = (SELECT ISNULL(SUM(ct.Amount), 0) FROM CashboxTransactions ct
        WHERE (ct.TransactionType = N'صرف' OR ct.TransactionType = 'Out')
          AND ct.TransactionDate >= @fromDate AND ct.TransactionDate < DATEADD(DAY, 1, @toDate)
          ${scope.scoped ? `AND ct.CashBoxId IN (${inList(scope.cashBoxIds)})` : ''})
  `);
  const r = rows[0] || {};
  const f = {
    SalesGross: money(r.SalesGross), SaleReturns: money(r.SaleReturns),
    PurchasesGross: money(r.PurchasesGross), PurchaseReturns: money(r.PurchaseReturns),
    Collected: money(r.Collected), CashIn: money(r.CashIn), CashOut: money(r.CashOut),
  };
  f.SalesNet = money(f.SalesGross - f.SaleReturns);
  f.PurchasesNet = money(f.PurchasesGross - f.PurchaseReturns);
  f.CashNet = money(f.CashIn - f.CashOut);
  return f;
}

async function statement(pool, from, to, branchId) {
  return fin.getIncomeStatement(pool, { from, to, branchId }, { includeComparison: false, includeMonthlyTrend: false });
}

// ─── الاتجاه — TrendAsync:713 ───
async function trend(pool, scope) {
  const today = cairoToday();
  const trendStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const txRows = await fin._internal.request(pool, [
    ['trendStart', sql.Date, trendStart], ['branchId', sql.Int, scope.branchId],
  ], `
    SELECT YEAR(t.TransactionDate) AS Y, MONTH(t.TransactionDate) AS M, t.TransactionType AS T,
           ISNULL(SUM(t.GrandTotal), 0) AS Total
    FROM Transactions t
    WHERE t.TransactionType IN ('Sale', 'SaleReturn', 'Purchase', 'PurchaseReturn')
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND t.TransactionDate >= @trendStart
      AND (t.TransactionType <> 'Purchase' OR t.ReferenceType IS NULL OR t.ReferenceType NOT LIKE 'MirrorOf:%')
      ${txScopeSql('t', scope)}
    GROUP BY YEAR(t.TransactionDate), MONTH(t.TransactionDate), t.TransactionType
  `);
  const payRows = await fin._internal.request(pool, [
    ['trendStart', sql.Date, trendStart], ['branchId', sql.Int, scope.branchId],
  ], `
    SELECT YEAR(p.PaymentDate) AS Y, MONTH(p.PaymentDate) AS M, ISNULL(SUM(p.Amount), 0) AS Total
    FROM Payments p INNER JOIN Transactions t ON t.TransactionID = p.TransactionID
    WHERE t.TransactionType = 'Sale' AND p.PaymentDate >= @trendStart ${txScopeSql('t', scope)}
    GROUP BY YEAR(p.PaymentDate), MONTH(p.PaymentDate)
  `);
  const txMap = new Map(txRows.map((r) => [`${r.Y}-${r.M}-${r.T}`, Number(r.Total || 0)]));
  const payMap = new Map(payRows.map((r) => [`${r.Y}-${r.M}`, Number(r.Total || 0)]));
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    const m = addMonths(trendStart, i);
    const key = `${m.getUTCFullYear()}-${m.getUTCMonth() + 1}`;
    rows.push({
      Label: formatMonth(m),
      Sales: money((txMap.get(`${key}-Sale`) || 0) - (txMap.get(`${key}-SaleReturn`) || 0)),
      Collected: money(payMap.get(key) || 0),
      Purchases: money((txMap.get(`${key}-Purchase`) || 0) - (txMap.get(`${key}-PurchaseReturn`) || 0)),
    });
  }
  const monthSales = rows[11].Sales;
  const lastMonthSales = rows[10].Sales;
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  const forecast = money(Math.round((monthSales / Math.max(today.getUTCDate(), 1)) * daysInMonth));
  return { Trend: rows, Forecast: forecast, LastMonthSales: lastMonthSales, ForecastPct: pctNoAbs(forecast, lastMonthSales) };
}

// ─── الفريق + لوحة المدير العام — TeamAsync (نشطون فقط بقرار المالك) ───
async function team(pool, scope, today) {
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const auditFrom = addDays(today, -34);
  const [employeesResult, usersResult, auditsResult, attendanceResult, salesResult, tasksResult] = await Promise.all([
    fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
      SELECT EmployeeID, FullName, JobTitle, Status, BioEmployeeID, IsPermanentlyExempt
      FROM Employees WHERE EndDate IS NULL AND Status = N'نشط'
      ${scope.scoped ? 'AND BranchId = @branchId' : ''} ORDER BY FullName`),
    fin._internal.request(pool, [], 'SELECT Username, employeeID AS EmployeeID FROM Users WHERE employeeID IS NOT NULL'),
    fin._internal.request(pool, [['auditFrom', sql.DateTime, auditFrom]], `
      SELECT u.employeeID AS EmployeeID, a.LoginName, a.ActionDate, a.TableName, a.ActionType
      FROM [dbo].[Audit_Log] a INNER JOIN Users u ON a.LoginName = u.Username
      WHERE u.employeeID IS NOT NULL AND a.ActionDate >= @auditFrom`),
    fin._internal.request(pool, [['today', sql.Date, today]], `
      SELECT BiometricCode, LateMinutes FROM Attendance WHERE CAST(LogDate AS DATE) = @today`),
    fin._internal.request(pool, [['monthStart', sql.Date, monthStart], ['branchId', sql.Int, scope.branchId]], `
      SELECT EmpId AS EmployeeID, ISNULL(SUM(GrandTotal), 0) AS Total, ISNULL(SUM(PaidAmount), 0) AS Paid
      FROM Transactions t
      WHERE t.TransactionType = 'Sale' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
        AND t.TransactionDate >= @monthStart AND t.EmpId IS NOT NULL ${txScopeSql('t', scope)}
      GROUP BY EmpId`),
    fin._internal.request(pool, [], `
      SELECT AssignedTo, DueDate FROM CRM_Tasks WHERE Status = 'Pending'
      ${scope.scoped ? `AND AssignedTo IN (${inList(scope.employeeIds)})` : ''}`),
  ]);
  const loginByEmployee = new Map();
  for (const row of usersResult) {
    const id = Number(row.EmployeeID);
    if (!loginByEmployee.has(id)) loginByEmployee.set(id, row.Username);
  }
  const auditsByEmployee = new Map();
  for (const row of auditsResult) {
    const id = Number(row.EmployeeID);
    if (!auditsByEmployee.has(id)) auditsByEmployee.set(id, []);
    auditsByEmployee.get(id).push(row);
  }
  const attendanceByBio = new Map();
  for (const row of attendanceResult) {
    const key = Number(row.BiometricCode);
    const current = attendanceByBio.get(key);
    if (!current || Number(row.LateMinutes || 0) > Number(current.LateMinutes || 0)) attendanceByBio.set(key, row);
  }
  const salesByEmployee = new Map(salesResult.map((row) => [Number(row.EmployeeID), row]));
  const tasksByEmployee = new Map();
  for (const row of tasksResult) {
    const id = Number(row.AssignedTo || 0);
    if (!tasksByEmployee.has(id)) tasksByEmployee.set(id, []);
    tasksByEmployee.get(id).push(row);
  }
  const now = new Date();
  const rows = employeesResult.map((employee) => {
    const id = Number(employee.EmployeeID);
    const login = loginByEmployee.get(id) || null;
    const audits = auditsByEmployee.get(id) || [];
    const auditDates = audits.filter((r) => r.ActionDate).map((r) => new Date(r.ActionDate));
    const heat = [];
    for (let d = 6; d >= 0; d -= 1) {
      const day = addDays(today, -d);
      heat.push(auditDates.filter((date) => date.getUTCFullYear() === day.getUTCFullYear()
        && date.getUTCMonth() === day.getUTCMonth() && date.getUTCDate() === day.getUTCDate()).length);
    }
    const actionsToday = heat[6] || 0;
    const actionsMonth = auditDates.filter((date) => date >= addDays(today, -29)).length;
    const lastActivity = auditDates.length ? new Date(Math.max(...auditDates.map((d) => d.getTime()))) : null;
    let attendance = 'بلا تسجيل';
    if (employee.IsPermanentlyExempt === true || employee.IsPermanentlyExempt === 1) attendance = 'معفى من البصمة';
    else if (employee.BioEmployeeID != null && attendanceByBio.has(Number(employee.BioEmployeeID))) {
      attendance = Number(attendanceByBio.get(Number(employee.BioEmployeeID)).LateMinutes || 0) > 15 ? 'متأخر' : 'حاضر';
    }
    const sales = salesByEmployee.get(id) || {};
    const monthSales = money(sales.Total); const monthCollection = money(sales.Paid);
    const jobTitle = employee.JobTitle || '';
    const isSales = monthSales > 0 || jobTitle.includes('مبيعات') || jobTitle.includes('مندوب');
    const tasks = tasksByEmployee.get(id) || [];
    let status;
    if (!login) status = 'gray';
    else {
      const idleDays = lastActivity == null ? 999 : (now.getTime() - lastActivity.getTime()) / 86400000;
      status = idleDays >= 3 ? 'red' : actionsToday === 0 ? 'yellow' : 'green';
    }
    return {
      EmployeeId: id, FullName: employee.FullName || '', JobTitle: jobTitle || '—', Attendance: attendance,
      ActionsToday: actionsToday, ActionsMonth: actionsMonth, Heat7: heat, LastActivity: lastActivity,
      LastActivityText: humanizeWhen(lastActivity, now), MonthSales: monthSales, MonthCollection: monthCollection,
      TasksPending: tasks.length, TasksOverdue: tasks.filter((t) => t.DueDate && new Date(t.DueDate) < now).length,
      Status: status, IsSales: isSales, HrStatus: employee.Status || '—', HasAccount: Boolean(login),
      _login: login, _audits: audits,
    };
  });
  // لوحة المدير العام على مستوى الشركة (بلا فلتر فرع بطبيعتها)
  let gmEmployee = rows.find((e) => e.JobTitle.includes('مدير عام')) || rows.find((e) => e.JobTitle.includes('مدير عامًا')) || null;
  let gmLogin = gmEmployee?._login || null;
  let gmAudits = gmEmployee?._audits || [];
  let gmName = gmEmployee?.FullName || '';
  let gmLast = gmEmployee?.LastActivityText || '';
  if (!gmEmployee) {
    const gmRows = await fin._internal.request(pool, [], `
      SELECT TOP 1 e.EmployeeID, e.FullName, u.Username FROM Employees e
      LEFT JOIN Users u ON u.employeeID = e.EmployeeID
      WHERE e.EndDate IS NULL AND e.JobTitle LIKE N'%مدير عام%' ORDER BY e.FullName`);
    if (gmRows.length) {
      gmName = gmRows[0].FullName || ''; gmLogin = gmRows[0].Username || null;
      if (gmLogin) {
        gmAudits = await fin._internal.request(pool, [['login', sql.NVarChar(100), gmLogin]], `
          SELECT TOP 6 ActionDate, TableName, ActionType FROM [dbo].[Audit_Log]
          WHERE LoginName = @login ORDER BY ActionDate DESC`);
        const lastRows = gmAudits;
        gmLast = lastRows.length && lastRows[0].ActionDate ? humanizeWhen(lastRows[0].ActionDate, now) : 'لا يوجد نشاط';
      }
    }
  }
  const systemTeam = rows.filter((e) => e.HasAccount);
  const gm = {
    Found: Boolean(gmName),
    FullName: gmName,
    LastActivityText: gmName ? gmLast : '',
    ActionsWeek: gmEmployee
      ? gmAudits.filter((r) => r.ActionDate && new Date(r.ActionDate) >= addDays(today, -6)).length
      : gmAudits.length,
    Recent: (gmEmployee
      ? [...gmAudits].sort((a, b) => new Date(b.ActionDate) - new Date(a.ActionDate)).slice(0, 6)
      : gmAudits).map((r) => ({ When: humanizeWhen(r.ActionDate, now), What: describe(r.TableName, r.ActionType) })),
    PendingPrice: 0, EscalatedComplaints: 0,
    TeamSalesMonth: money(rows.reduce((s, r) => s + r.MonthSales, 0)),
    TeamActiveToday: systemTeam.filter((r) => r.ActionsToday > 0).length,
    TeamTotal: systemTeam.length,
  };
  const dormant = rows.filter((e) => e.Status === 'red').length;
  const publicRows = rows.map((e) => { const r = { ...e }; delete r._login; delete r._audits; return r; });
  return { Employees: publicRows, Gm: gm, Dormant: dormant };
}

// ─── الاستثناءات — ExceptionsAsync ───
async function exceptions(pool, scope, today) {
  const cutoff30 = addDays(today, -30);
  const rows = await fin._internal.request(pool, [
    ['today', sql.Date, today], ['cutoff30', sql.Date, cutoff30], ['branchId', sql.Int, scope.branchId],
  ], `
    SELECT
      Debts30 = (SELECT COUNT(*) FROM Transactions t WHERE t.TransactionType = 'Sale'
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled') AND t.GrandTotal > t.PaidAmount
        AND COALESCE(t.DueDate, t.TransactionDate) < @cutoff30 ${txScopeSql('t', scope)}),
      Debts30Amount = (SELECT ISNULL(SUM(t.GrandTotal - t.PaidAmount), 0) FROM Transactions t WHERE t.TransactionType = 'Sale'
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled') AND t.GrandTotal > t.PaidAmount
        AND COALESCE(t.DueDate, t.TransactionDate) < @cutoff30 ${txScopeSql('t', scope)}),
      LateDeliveries = (SELECT COUNT(*) FROM Transactions t WHERE t.TransactionType = 'Sale'
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled') AND ISNULL(t.IsDelivered, 0) = 0
        AND t.DueDate IS NOT NULL AND t.DueDate < @today ${txScopeSql('t', scope)}),
      PendingPrice = (SELECT COUNT(*) FROM PriceChangeRequests r WHERE r.Status = 'Pending'
        ${scope.scoped ? `AND EXISTS (SELECT 1 FROM Users u WHERE u.Username = r.RequestedBy AND u.EmployeeId IN (${inList(scope.employeeIds)}))` : ''}),
      NegativeStock = (SELECT COUNT(DISTINCT s.ProductID) FROM StockLevels s WHERE s.Quantity < 0
        ${scope.scoped ? `AND s.WarehouseId IN (${inList(scope.warehouseIds)})` : ''}),
      StalledLeads = (SELECT COUNT(*) FROM LeadsCRM l WHERE l.LeadStatus IN (N'جديد', N'تم الإسناد')
        AND l.CreatedAt < DATEADD(DAY, -10, @today)
        ${scope.scoped ? `AND l.AssignedEmployeeId IN (${inList(scope.employeeIds)})` : ''}),
      OpenComplaints = (SELECT COUNT(*) FROM Complaints c WHERE c.Status IS NULL OR c.Status NOT IN (4, 5)),
      EscalatedComplaints = (SELECT COUNT(*) FROM Complaints c WHERE c.Status = 6)
  `);
  const r = rows[0] || {};
  return {
    Exceptions: {
      Debts30: Number(r.Debts30 || 0), Debts30Amount: money(r.Debts30Amount),
      LateDeliveries: Number(r.LateDeliveries || 0), PendingPrice: Number(r.PendingPrice || 0),
      NegativeStock: Number(r.NegativeStock || 0), StalledLeads: Number(r.StalledLeads || 0),
      OpenComplaints: Number(r.OpenComplaints || 0),
    },
    Escalated: Number(r.EscalatedComplaints || 0),
  };
}

// ─── بنود بانتظار قرار — PendingAsync:1066 ───
async function pending(pool, scope) {
  const rows = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT
      InvoiceEdits = (SELECT COUNT(*) FROM Transactions t WHERE t.EditStatus = 1 ${txScopeSql('t', scope)}),
      ClosureApprovals = (SELECT COUNT(*) FROM OpportunityClosureApprovalRequests r WHERE r.Status = 'Pending'
        ${scope.scoped ? `AND EXISTS (SELECT 1 FROM Users u WHERE u.Username = r.RequestedBy AND u.EmployeeId IN (${inList(scope.employeeIds)}))` : ''}),
      PriceRequests = (SELECT COUNT(*) FROM PriceChangeRequests r WHERE r.Status = 'Pending'
        ${scope.scoped ? `AND EXISTS (SELECT 1 FROM Users u WHERE u.Username = r.RequestedBy AND u.EmployeeId IN (${inList(scope.employeeIds)}))` : ''})
  `);
  const r = rows[0] || {};
  // أذونات التسليم: آخر إجراء لكل فاتورة في Audit_Log (طلب بلا منح لاحق)
  const lastIds = await fin._internal.request(pool, [], `
    SELECT MAX(AuditID) AS MaxId FROM [dbo].[Audit_Log]
    WHERE TableName = 'Transactions' AND PrimaryKeyValue IS NOT NULL
      AND ActionType IN ('DeliveryPermissionRequest', 'DeliveryPermissionGranted')
    GROUP BY PrimaryKeyValue`);
  let deliveryPermits = 0;
  if (lastIds.length) {
    const idList = lastIds.map((x) => Number(x.MaxId)).filter(Number.isSafeInteger).join(',');
    const permitRows = await fin._internal.request(pool, [], `
      SELECT PrimaryKeyValue FROM [dbo].[Audit_Log]
      WHERE AuditID IN (${idList}) AND ActionType = 'DeliveryPermissionRequest'`);
    const keys = [...new Set(permitRows.map((x) => String(x.PrimaryKeyValue)))];
    if (!scope.scoped) deliveryPermits = keys.length;
    else {
      const txIds = keys.map((k) => Number(k)).filter((n) => Number.isSafeInteger(n) && n > 0);
      if (txIds.length) {
        const scopedRows = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
          SELECT COUNT(*) AS Cnt FROM Transactions t WHERE t.TransactionID IN (${txIds.join(',')}) ${txScopeSql('t', scope)}`);
        deliveryPermits = Number(scopedRows[0]?.Cnt || 0);
      }
    }
  }
  return {
    InvoiceEdits: Number(r.InvoiceEdits || 0), ClosureApprovals: Number(r.ClosureApprovals || 0),
    DeliveryPermits: deliveryPermits, PriceRequests: Number(r.PriceRequests || 0),
  };
}

// ─── التشغيل — OpsAsync ───
async function ops(pool, scope, today) {
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const rows = await fin._internal.request(pool, [['monthStart', sql.Date, monthStart], ['branchId', sql.Int, scope.branchId]], `
    SELECT
      FactoryOpen = (SELECT COUNT(*) FROM Transactions t INNER JOIN Parties p ON p.PartyID = t.PartyID
        WHERE p.PartyName = N'المصنع' AND t.TransactionType = 'Purchase'
          AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled') AND ISNULL(t.IsDelivered, 0) = 0 ${txScopeSql('t', scope)}),
      FactoryMonth = (SELECT COUNT(*) FROM Transactions t INNER JOIN Parties p ON p.PartyID = t.PartyID
        WHERE p.PartyName = N'المصنع' AND t.TransactionType = 'Purchase'
          AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled') AND t.DeliveredAt >= @monthStart ${txScopeSql('t', scope)}),
      OpenComplaints = (SELECT COUNT(*) FROM Complaints c WHERE c.Status IS NULL OR c.Status NOT IN (4, 5)),
      NewLeads = (SELECT COUNT(*) FROM LeadsCRM l WHERE l.CreatedAt >= @monthStart
        ${scope.scoped ? `AND l.AssignedEmployeeId IN (${inList(scope.employeeIds)})` : ''})
  `);
  const r = rows[0] || {};
  return {
    FactoryOpen: Number(r.FactoryOpen || 0), FactoryMonth: Number(r.FactoryMonth || 0),
    OpenComplaints: Number(r.OpenComplaints || 0), NewLeads: Number(r.NewLeads || 0),
  };
}

// ─── الخزينة والفرص والفروع — PipelineAsync:1176 ───
async function pipeline(pool, ranges, scope, today) {
  const cashRows = await fin._internal.request(pool, [], `
    SELECT (SELECT ISNULL(SUM(OpeningBalance), 0) FROM CashBoxes ${scope.scoped ? `WHERE CashBoxId IN (${inList(scope.cashBoxIds)})` : ''})
      + (SELECT ISNULL(SUM(Amount), 0) FROM CashboxTransactions WHERE (TransactionType = N'قبض' OR TransactionType = 'In') ${scope.scoped ? `AND CashBoxId IN (${inList(scope.cashBoxIds)})` : ''})
      - (SELECT ISNULL(SUM(Amount), 0) FROM CashboxTransactions WHERE (TransactionType = N'صرف' OR TransactionType = 'Out') ${scope.scoped ? `AND CashBoxId IN (${inList(scope.cashBoxIds)})` : ''}) AS CashBalance`);
  const oppRows = await fin._internal.request(pool, [['today', sql.Date, today]], `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(ISNULL(ExpectedValue, 0)), 0) AS Value,
      SUM(CASE WHEN NextFollowUpDate IS NOT NULL AND NextFollowUpDate < @today THEN 1 ELSE 0 END) AS Stalled
    FROM SalesOpportunities WHERE ClosedAt IS NULL
    ${scope.scoped ? `AND EmployeeId IN (${inList(scope.employeeIds)})` : ''}`);
  let b2bPending = 0;
  try {
    const b2bRows = await fin._internal.request(pool, [], `
      SELECT COUNT(*) AS Cnt FROM B2BRequests WHERE Status IN ('New', 'UnderReview')`);
    b2bPending = Number(b2bRows[0]?.Cnt || 0);
  } catch { b2bPending = 0; }
  const branchRows = await fin._internal.request(pool, params(ranges, scope), `
    SELECT ISNULL(b.BranchNameAr, N'') AS Name, ISNULL(SUM(t.GrandTotal), 0) AS Value
    FROM Transactions t
    INNER JOIN Warehouses w ON w.WarehouseID = t.WarehouseID
    INNER JOIN Branches b ON b.BranchID = w.BranchID
    WHERE t.TransactionType = 'Sale' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
    GROUP BY b.BranchNameAr ORDER BY Value DESC`);
  const o = oppRows[0] || {};
  return {
    CashBalance: money(cashRows[0]?.CashBalance),
    PipelineOpen: Number(o.Cnt || 0), PipelineValue: money(o.Value), PipelineStalled: Number(o.Stalled || 0),
    B2bPending: b2bPending,
    BranchSales: branchRows.map((r) => ({ Name: r.Name, Value: money(r.Value) })),
  };
}

// ─── أعمار الذمم — AgingAsync:1273 + Bucketize:1260 ───
const AGING_LABELS = ['حالي', '1–30 يوم', '31–60 يوم', '61–90 يوم', '+90 يوم'];
function bucketize(rows, today) {
  const buckets = AGING_LABELS.map((Label) => ({ Label, Amount: 0, Count: 0 }));
  for (const r of rows) {
    const eff = new Date(r.EffDate);
    const age = Math.floor((today - new Date(Date.UTC(eff.getUTCFullYear(), eff.getUTCMonth(), eff.getUTCDate()))) / 86400000);
    const idx = age <= 0 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : age <= 90 ? 3 : 4;
    buckets[idx].Amount += Number(r.Remaining || 0); buckets[idx].Count += 1;
  }
  for (const b of buckets) b.Amount = money(b.Amount);
  return buckets;
}
async function aging(pool, scope, today) {
  const recv = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT t.PartyID AS PartyId, (t.GrandTotal - t.PaidAmount) AS Remaining, COALESCE(t.DueDate, t.TransactionDate) AS EffDate
    FROM Transactions t WHERE t.TransactionType = 'Sale'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled') AND t.GrandTotal > t.PaidAmount ${txScopeSql('t', scope)}`);
  const pay = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT t.PartyID AS PartyId, (t.GrandTotal - t.PaidAmount) AS Remaining, COALESCE(t.DueDate, t.TransactionDate) AS EffDate
    FROM Transactions t WHERE t.TransactionType = 'Purchase'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND (t.ReferenceType IS NULL OR t.ReferenceType NOT LIKE 'MirrorOf:%') AND t.GrandTotal > t.PaidAmount ${txScopeSql('t', scope)}`);
  const byParty = new Map();
  for (const r of recv) byParty.set(Number(r.PartyId), (byParty.get(Number(r.PartyId)) || 0) + Number(r.Remaining || 0));
  const top = [...byParty.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  let topDebtors = [];
  if (top.length) {
    const names = await fin._internal.request(pool, [], `
      SELECT PartyID AS PartyId, PartyName FROM Parties WHERE PartyID IN (${top.map(([id]) => id).join(',')})`);
    const nameMap = new Map(names.map((n) => [Number(n.PartyId), n.PartyName]));
    topDebtors = top.map(([id, amount]) => ({ Name: nameMap.get(id) || '—', Amount: money(amount) }));
  }
  return {
    Receivables: bucketize(recv, today), Payables: bucketize(pay, today),
    TotalReceivables: money(recv.reduce((s, r) => s + Number(r.Remaining || 0), 0)),
    TotalPayables: money(pay.reduce((s, r) => s + Number(r.Remaining || 0), 0)),
    TopDebtors: topDebtors,
  };
}

// ─── عروض الأسعار — QuotationsAsync:1328 (الحالات QuotationDto.cs:242) ───
const QUOTATION_STATUSES = [['Draft', 'مسودة'], ['Sent', 'تم الإرسال'], ['Accepted', 'مقبول'], ['Rejected', 'مرفوض'], ['Converted', 'تحوّل لفاتورة'], ['Expired', 'منتهي الصلاحية']];
function quotationScopeSql(alias, scope) {
  if (!scope.scoped) return '';
  return ` AND ((${alias}.EmpId IN (SELECT EmployeeID AS EmployeeId FROM Employees WHERE BranchID = @branchId))
    OR (((${alias}.EmpId IS NULL OR NOT EXISTS (SELECT 1 FROM Employees ex WHERE ex.EmployeeID = ${alias}.EmpId AND ex.BranchID IS NOT NULL))
      AND ${alias}.WarehouseID IN (SELECT WarehouseID AS WarehouseId FROM Warehouses WHERE BranchID = @branchId))))`;
}
async function quotations(pool, ranges, scope, today) {
  const periodRows = await fin._internal.request(pool, params(ranges, scope), `
    SELECT q.Status, q.InvoiceID AS InvoiceId, ISNULL(q.GrandTotal, q.TotalAmount) AS Value
    FROM Quotations q WHERE q.QuotationDate >= @fromDate AND q.QuotationDate < DATEADD(DAY, 1, @toDate) ${quotationScopeSql('q', scope)}`);
  const dto = {
    ByStatus: [], PeriodCount: periodRows.length,
    PeriodValue: money(periodRows.reduce((s, r) => s + Number(r.Value || 0), 0)),
    ConvertedCount: 0, ConversionRate: 0, HasDecided: false,
    SentCount: 0, SentValue: 0, AcceptedNotConvertedCount: 0, AcceptedNotConvertedValue: 0, ExpiringSoonCount: 0,
  };
  for (const [status, label] of QUOTATION_STATUSES) {
    const rows = periodRows.filter((r) => r.Status === status);
    dto.ByStatus.push({ Label: label, Count: rows.length, Value: money(rows.reduce((s, r) => s + Number(r.Value || 0), 0)) });
  }
  const converted = periodRows.filter((r) => r.Status === 'Converted' || r.InvoiceId != null).length;
  const decided = converted
    + periodRows.filter((r) => r.Status === 'Rejected').length
    + periodRows.filter((r) => r.Status === 'Expired').length;
  dto.ConvertedCount = converted;
  dto.HasDecided = decided > 0;
  dto.ConversionRate = decided === 0 ? 0 : Math.round((converted * 1000) / decided) / 10;
  const sentRows = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT q.ValidUntil, ISNULL(q.GrandTotal, q.TotalAmount) AS Value FROM Quotations q
    WHERE q.Status = 'Sent' ${quotationScopeSql('q', scope)}`);
  dto.SentCount = sentRows.length;
  dto.SentValue = money(sentRows.reduce((s, r) => s + Number(r.Value || 0), 0));
  dto.ExpiringSoonCount = sentRows.filter((r) => {
    if (!r.ValidUntil) return false;
    const d = toSqlDate(new Date(r.ValidUntil));
    return d >= today && d <= addDays(today, 7);
  }).length;
  const acceptedRows = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT ISNULL(q.GrandTotal, q.TotalAmount) AS Value FROM Quotations q
    WHERE q.Status = 'Accepted' AND q.InvoiceID IS NULL ${quotationScopeSql('q', scope)}`);
  dto.AcceptedNotConvertedCount = acceptedRows.length;
  dto.AcceptedNotConvertedValue = money(acceptedRows.reduce((s, r) => s + Number(r.Value || 0), 0));
  return dto;
}

// ─── المخزون — InventoryAsync:1389 + StockService.GetStockValueAsync:859 ───
// قيمة المخزون: كمية > 0 في مخازن نشطة × تكلفة باقة Premium افتراضيًا
// (PurchasePrice ?? CClass ?? Elite)، والبيع SuggestedSalePrice بنفس السقوط.
async function inventory(pool, branchId, scope, today) {
  const valueRows = await fin._internal.request(pool, [['branchId', sql.Int, branchId]], `
    SELECT sl.ProductID AS ProductId, p.ProductName, sl.WarehouseID AS WarehouseId, w.WarehouseName, sl.Quantity,
      ISNULL(p.PurchasePrice, ISNULL(p.PurchasePriceCClass, ISNULL(p.PurchasePriceElite, 0))) AS UnitCost,
      ISNULL(p.SuggestedSalePrice, ISNULL(p.SuggestedSalePriceCClass, ISNULL(p.SuggestedSalePriceElite, 0))) AS UnitSale
    FROM StockLevels sl
    INNER JOIN Warehouses w ON w.WarehouseID = sl.WarehouseID AND ISNULL(w.IsActive, 1) = 1
    INNER JOIN Products p ON p.ProductID = sl.ProductID
    WHERE sl.Quantity > 0 ${branchId ? 'AND w.BranchId = @branchId' : ''}`);
  const dto = {
    TotalCostValue: money(valueRows.reduce((s, r) => s + Number(r.Quantity || 0) * Number(r.UnitCost || 0), 0)),
    TotalSaleValue: money(valueRows.reduce((s, r) => s + Number(r.Quantity || 0) * Number(r.UnitSale || 0), 0)),
    ProductsCount: new Set(valueRows.map((r) => Number(r.ProductId))).size,
    TotalQuantity: Math.trunc(valueRows.reduce((s, r) => s + Number(r.Quantity || 0), 0)),
    OutOfStockCount: 0, LowStockCount: 0, DeadStockCount: 0, DeadStockValue: 0,
    TopValueProducts: [], Warehouses: [],
  };
  const perProduct = new Map();
  for (const r of valueRows) {
    const id = Number(r.ProductId);
    if (!perProduct.has(id)) perProduct.set(id, { Name: r.ProductName || '', Qty: 0, Cost: 0 });
    const row = perProduct.get(id);
    row.Qty += Number(r.Quantity || 0); row.Cost += Number(r.Quantity || 0) * Number(r.UnitCost || 0);
  }
  dto.TopValueProducts = [...perProduct.values()].sort((a, b) => b.Cost - a.Cost).slice(0, 5)
    .map((r) => ({ Name: r.Name, Value: money(r.Cost) }));
  const perWarehouse = new Map();
  for (const r of valueRows) {
    const id = Number(r.WarehouseId);
    if (!perWarehouse.has(id)) perWarehouse.set(id, { WarehouseId: id, WarehouseName: r.WarehouseName || '', CostValue: 0, products: new Set() });
    const row = perWarehouse.get(id);
    row.CostValue += Number(r.Quantity || 0) * Number(r.UnitCost || 0); row.products.add(Number(r.ProductId));
  }
  dto.Warehouses = [...perWarehouse.values()].sort((a, b) => b.CostValue - a.CostValue).map((r) => ({
    WarehouseId: r.WarehouseId, WarehouseName: r.WarehouseName, CostValue: money(r.CostValue),
    SharePct: dto.TotalCostValue === 0 ? 0 : Math.round((r.CostValue * 1000) / dto.TotalCostValue) / 10,
    ProductsCount: r.products.size,
  }));
  const totalsRows = await fin._internal.request(pool, [], `
    SELECT ProductID AS ProductId, ISNULL(SUM(Quantity), 0) AS Total FROM StockLevels
    ${scope.scoped ? `WHERE WarehouseId IN (${inList(scope.warehouseIds)})` : ''} GROUP BY ProductId`);
  dto.OutOfStockCount = totalsRows.filter((r) => Number(r.Total) <= 0).length;
  dto.LowStockCount = totalsRows.filter((r) => Number(r.Total) >= 1 && Number(r.Total) <= 5).length;
  const cutoff = addDays(today, -90);
  const moveRows = await fin._internal.request(pool, [], `
    SELECT ProductID AS ProductId, MAX(ISNULL(TransactionDate, CreatedAt)) AS LastMove FROM StockTransactions
    ${scope.scoped ? `WHERE WarehouseID IN (${inList(scope.warehouseIds)})` : ''} GROUP BY ProductId`);
  const lastByProduct = new Map(moveRows.map((r) => [Number(r.ProductId), r.LastMove ? new Date(r.LastMove) : null]));
  let deadCount = 0; let deadValue = 0;
  for (const [id, row] of perProduct) {
    if (row.Qty <= 0) continue;
    const last = lastByProduct.get(id);
    if (!lastByProduct.has(id) || last == null || toSqlDate(last) < cutoff) { deadCount += 1; deadValue += row.Cost; }
  }
  dto.DeadStockCount = deadCount; dto.DeadStockValue = money(deadValue);
  return dto;
}

// ─── أوامر التشغيل — JobOrdersAsync:1489 ───
async function jobOrders(pool, ranges, scope, today) {
  const base = `FROM Transactions t
    WHERE (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND (t.TransactionType = 'Sale' OR (t.TransactionType = 'Purchase'
        AND (t.ReferenceType IS NULL OR t.ReferenceType NOT LIKE 'MirrorOf:%'))) ${txScopeSql('t', scope)}`;
  const rows = await fin._internal.request(pool, params(ranges, scope), `
    SELECT
      OpenCount = (SELECT COUNT(*) ${base} AND ISNULL(t.IsDelivered, 0) = 0),
      OpenSale = (SELECT COUNT(*) ${base} AND ISNULL(t.IsDelivered, 0) = 0 AND t.TransactionType = 'Sale'),
      OpenPurchase = (SELECT COUNT(*) ${base} AND ISNULL(t.IsDelivered, 0) = 0 AND t.TransactionType = 'Purchase'),
      DeliveredInPeriod = (SELECT COUNT(*) ${base} AND t.IsDelivered = 1 AND t.DeliveredAt >= @fromDate AND t.DeliveredAt < DATEADD(DAY, 1, @toDate)),
      WithAlternatives = (SELECT COUNT(*) ${base} AND ISNULL(t.IsDelivered, 0) = 0
        AND EXISTS (SELECT 1 FROM TransactionDetails d WHERE d.TransactionID = t.TransactionID AND d.SelectedAlternativeID IS NOT NULL))
  `);
  const overdueRows = await fin._internal.request(pool, [['today', sql.Date, today], ['branchId', sql.Int, scope.branchId]], `
    SELECT ISNULL(SUM(t.GrandTotal), 0) AS Value, COUNT(*) AS Cnt ${base}
      AND ISNULL(t.IsDelivered, 0) = 0 AND t.DueDate IS NOT NULL AND t.DueDate < @today`);
  const r = rows[0] || {};
  return {
    OpenCount: Number(r.OpenCount || 0), OpenSale: Number(r.OpenSale || 0), OpenPurchase: Number(r.OpenPurchase || 0),
    OverdueCount: Number(overdueRows[0]?.Cnt || 0), OverdueValue: money(overdueRows[0]?.Value),
    WithAlternativesCount: Number(r.WithAlternatives || 0), DeliveredInPeriod: Number(r.DeliveredInPeriod || 0),
  };
}

// ─── التسليمات — DeliveriesAsync:1546 ───
// المخطط من VwSalesDeliveryStatuses بـ DueDate؛ الاكتمال من أحداث التسليم
// (InvoiceDeliveries/Items): المقبول AcceptedQty + المُسوّى ClosedByCredit،
// وعند غياب تخزين الأحداث (208/207) تعود أرقام الـ View وحدها.
async function deliveries(pool, ranges, scope, today) {
  const dto = {
    Planned: 0, Delivered: 0, OnTime: 0, Late: 0, OnTimePct: 0, HasDelivered: false, Pending: 0,
    ReturnedInPeriod: 0, NotDeliveredInPeriod: 0, PartialInPeriod: 0, PartialOpenNow: 0,
    BatchEventsInPeriod: 0, BatchOnTimeEvents: 0, BatchPunctualityPct: 0, HasBatchEvents: false,
    OverdueNow: 0, OverdueAmount: 0, DueToday: 0, DueTomorrow: 0,
    EventsWithRemarksInPeriod: 0, ManufacturingDefectQtyInPeriod: 0, HandlingDamageQtyInPeriod: 0,
    MaintenanceBacklogRecords: 0, MaintenanceBacklogQty: 0, MaintenanceOldestAgeDays: null,
    PendingModificationChargesCount: 0, ApprovedUncollectedModificationAmount: 0, RepairCostInPeriod: 0,
  };
  const empFilter = scope.scoped ? `AND EmpId IN (${inList(scope.employeeIds)})` : '';
  const planned = await fin._internal.request(pool, params(ranges, scope), `
    SELECT TransactionID AS TransactionId, DueDate, DeliveryStatus, DeliveredAt, GrandTotal FROM VwSalesDeliveryStatuses
    WHERE DueDate IS NOT NULL AND DueDate >= @fromDate AND DueDate < DATEADD(DAY, 1, @toDate) ${empFilter}`);
  const openRows = await fin._internal.request(pool, [], `
    SELECT TransactionID AS TransactionId, DueDate, DeliveryStatus, GrandTotal FROM VwSalesDeliveryStatuses
    WHERE DueDate IS NOT NULL AND DeliveryStatus <> N'تم التسليم' AND DeliveryStatus <> N'مرتجع' ${empFilter}`);
  dto.Planned = planned.length;
  let progress = new Map();
  let completionDates = new Map();
  let eventsOk = false;
  let oc = null;
  try {
    const scopedRows = await fin._internal.request(pool, [], `
      SELECT TransactionID AS TransactionId, DeliveryStatus FROM VwSalesDeliveryStatuses WHERE 1 = 1 ${empFilter}`);
    const scopedIds = new Set(scopedRows.map((r) => Number(r.TransactionId)));
    const returnedIds = new Set(scopedRows.filter((r) => r.DeliveryStatus === 'مرتجع').map((r) => Number(r.TransactionId)));
    const [invoicedRows, deliveredRows, settledRows, eventRows] = await Promise.all([
      fin._internal.request(pool, [], 'SELECT TransactionId, ISNULL(SUM(Quantity), 0) AS Total FROM TransactionDetails GROUP BY TransactionId'),
      fin._internal.request(pool, [], `
        SELECT d.TransactionId, ISNULL(SUM(i.AcceptedQty), 0) AS Total
        FROM InvoiceDeliveryItems i INNER JOIN InvoiceDeliveries d ON d.DeliveryId = i.DeliveryId
        WHERE ISNULL(d.IsVoided, 0) = 0 GROUP BY d.TransactionId`),
      fin._internal.request(pool, [], `
        SELECT TransactionId, ISNULL(SUM(Quantity), 0) AS Total FROM DeliveryMaintenanceItems
        WHERE ISNULL(IsVoided, 0) = 0 AND Status = 'ClosedByCredit' GROUP BY TransactionId`),
      fin._internal.request(pool, [], `
        SELECT DeliveryId, TransactionId, DeliveryDate, CompletedInvoice FROM InvoiceDeliveries WHERE ISNULL(IsVoided, 0) = 0`),
    ]);
    const deliveredMap = new Map(deliveredRows.map((r) => [Number(r.TransactionId), Number(r.Total || 0)]));
    const settledMap = new Map(settledRows.map((r) => [Number(r.TransactionId), Number(r.Total || 0)]));
    const eventsByTx = new Map();
    for (const e of eventRows) {
      const id = Number(e.TransactionId);
      if (!eventsByTx.has(id)) eventsByTx.set(id, []);
      eventsByTx.get(id).push(e);
    }
    for (const inv of invoicedRows) {
      const id = Number(inv.TransactionId);
      const evts = eventsByTx.get(id) || [];
      const remaining = Number(inv.Total || 0) - (deliveredMap.get(id) || 0) - (settledMap.get(id) || 0);
      progress.set(id, {
        HasEvents: evts.length > 0,
        EffectiveStatus: evts.length === 0 ? 'جارى' : remaining <= 0.0005 ? 'تم التسليم' : 'جزئي',
        TotalRemainingQty: remaining,
      });
    }
    for (const [id, p] of progress) {
      if (p.EffectiveStatus !== 'تم التسليم') continue;
      const evts = eventsByTx.get(id) || [];
      const completing = [...evts].filter((e) => e.CompletedInvoice)
        .sort((a, b) => new Date(a.DeliveryDate) - new Date(b.DeliveryDate) || Number(a.DeliveryId) - Number(b.DeliveryId)).pop()
        || [...evts].sort((a, b) => new Date(a.DeliveryDate) - new Date(b.DeliveryDate) || Number(a.DeliveryId) - Number(b.DeliveryId)).pop();
      if (completing) completionDates.set(id, new Date(completing.DeliveryDate));
    }
    dto.PartialOpenNow = [...progress.entries()]
      .filter(([id, p]) => scopedIds.has(id) && p.EffectiveStatus === 'جزئي' && !returnedIds.has(id)).length;
    // دقة الدفعات: حدث الفترة منضبط إن خرج كل بنوده في/قبل موعده الفعّال
    const periodEvents = eventRows.filter((e) => {
      const d = toSqlDate(new Date(e.DeliveryDate));
      return d >= ranges.from && d <= ranges.toEff && scopedIds.has(Number(e.TransactionId));
    });
    if (periodEvents.length) {
      const evIds = periodEvents.map((e) => Number(e.DeliveryId));
      const itemRows = await fin._internal.request(pool, [], `
        SELECT DeliveryId, TransactionDetailId FROM InvoiceDeliveryItems WHERE DeliveryId IN (${evIds.join(',')})`);
      const detailIds = [...new Set(itemRows.map((r) => Number(r.TransactionDetailId)))];
      const lineRows = detailIds.length ? await fin._internal.request(pool, [], `
        SELECT DetailID AS DetailId, DeliveryDate, DeliveryDateIsCustom FROM TransactionDetails WHERE DetailID IN (${detailIds.join(',')})`) : [];
      const lineById = new Map(lineRows.map((r) => [Number(r.DetailId), r]));
      const txIds = [...new Set(periodEvents.map((e) => Number(e.TransactionId)))];
      const dueRows = await fin._internal.request(pool, [], `
        SELECT TransactionID AS TransactionId, DueDate FROM Transactions WHERE TransactionID IN (${txIds.join(',')})`);
      const dueByTx = new Map(dueRows.map((r) => [Number(r.TransactionId), r.DueDate]));
      const itemsByEvent = new Map();
      for (const it of itemRows) {
        const id = Number(it.DeliveryId);
        if (!itemsByEvent.has(id)) itemsByEvent.set(id, []);
        itemsByEvent.get(id).push(it);
      }
      let countable = 0; let onTime = 0;
      for (const e of periodEvents) {
        const its = itemsByEvent.get(Number(e.DeliveryId)) || [];
        if (!its.length) continue;
        let ok = true; let isCountable = true;
        for (const it of its) {
          const line = lineById.get(Number(it.TransactionDetailId));
          if (!line) { isCountable = false; break; }
          const eff = line.DeliveryDateIsCustom && line.DeliveryDate ? toSqlDate(new Date(line.DeliveryDate))
            : dueByTx.get(Number(e.TransactionId)) ? toSqlDate(new Date(dueByTx.get(Number(e.TransactionId)))) : null;
          if (!eff) { isCountable = false; break; }
          if (toSqlDate(new Date(e.DeliveryDate)) > eff) { ok = false; break; }
        }
        if (!isCountable) continue;
        countable += 1; if (ok) onTime += 1;
      }
      dto.BatchEventsInPeriod = countable; dto.BatchOnTimeEvents = onTime;
      dto.HasBatchEvents = countable > 0;
      dto.BatchPunctualityPct = countable === 0 ? 0 : Math.round((onTime * 1000) / countable) / 10;
    }
    // نتائج التسليم (كتلة فرعية آمنة مستقلة)
    try {
      oc = {
        EventsRemarks: 0, Manuf: 0, Handling: 0, BacklogRecords: 0, BacklogQty: 0,
        OldestAge: null, PendingCharges: 0, ApprovedUncollected: 0, RepairCost: 0,
      };
      const periodEvents2 = eventRows.filter((e) => {
        const d = toSqlDate(new Date(e.DeliveryDate));
        return d >= ranges.from && d <= ranges.toEff && scopedIds.has(Number(e.TransactionId));
      });
      if (periodEvents2.length) {
        const evIds = periodEvents2.map((e) => Number(e.DeliveryId));
        const ocItems = await fin._internal.request(pool, [], `
          SELECT DeliveryId, ReturnedManufacturingQty, ReturnedHandlingQty, ReturnedModificationQty
          FROM InvoiceDeliveryItems WHERE DeliveryId IN (${evIds.join(',')})`);
        oc.EventsRemarks = new Set(ocItems
          .filter((i) => Number(i.ReturnedManufacturingQty || 0) + Number(i.ReturnedHandlingQty || 0) + Number(i.ReturnedModificationQty || 0) > 0.0005)
          .map((i) => Number(i.DeliveryId))).size;
        oc.Manuf = ocItems.reduce((s, i) => s + Number(i.ReturnedManufacturingQty || 0), 0);
        oc.Handling = ocItems.reduce((s, i) => s + Number(i.ReturnedHandlingQty || 0), 0);
      }
      const backlog = await fin._internal.request(pool, [], `
        SELECT TransactionId, Quantity, CreatedAt FROM DeliveryMaintenanceItems
        WHERE ISNULL(IsVoided, 0) = 0 AND Status IN ('Pending', 'InProgress', 'ReadyForRedelivery', 'Unrepairable')`);
      const scopedBacklog = backlog.filter((r) => scopedIds.has(Number(r.TransactionId)));
      oc.BacklogRecords = scopedBacklog.length;
      oc.BacklogQty = scopedBacklog.reduce((s, r) => s + Number(r.Quantity || 0), 0);
      if (scopedBacklog.length) {
        const oldest = Math.min(...scopedBacklog.map((r) => new Date(r.CreatedAt).getTime()));
        oc.OldestAge = Math.floor((today - toSqlDate(new Date(oldest))) / 86400000);
      }
      const repairRows = await fin._internal.request(pool, params(ranges, scope), `
        SELECT TransactionId, ISNULL(RepairCost, 0) AS RepairCost FROM DeliveryMaintenanceItems
        WHERE ISNULL(IsVoided, 0) = 0 AND ClosedAt IS NOT NULL AND ClosedAt >= @fromDate AND ClosedAt < DATEADD(DAY, 1, @toDate)
          AND RepairCost IS NOT NULL`);
      oc.RepairCost = money(repairRows.filter((r) => scopedIds.has(Number(r.TransactionId)))
        .reduce((sum, r) => sum + Number(r.RepairCost || 0), 0));
      const chargeRows = await fin._internal.request(pool, [], `
        SELECT TransactionID AS TransactionId, Status, ISNULL(ChargeAmount, 0) AS ChargeAmount
        FROM AdditionalCharges
        WHERE ChargeType = 'Modification' AND SourceDeliveryId IS NOT NULL AND Status IN ('PendingApproval', 'Approved')`);
      for (const r of chargeRows) {
        if (!scopedIds.has(Number(r.TransactionId))) continue;
        if (r.Status === 'PendingApproval') oc.PendingCharges += 1;
        else oc.ApprovedUncollected = money(oc.ApprovedUncollected + Number(r.ChargeAmount || 0));
      }
    } catch { oc = null; /* غياب تخزين النتائج: الأرقام صفر */ }
    eventsOk = true;
  } catch (error) {
    const num = error.number || error.originalError?.info?.number;
    if (num !== 208 && num !== 207) throw error;
    eventsOk = false; progress = new Map(); completionDates = new Map(); oc = null;
    dto.PartialOpenNow = 0; dto.BatchEventsInPeriod = 0; dto.BatchOnTimeEvents = 0;
  }
  const hasProgress = (id) => eventsOk && progress.has(Number(id));
  const isCompleted = (row) => hasProgress(row.TransactionId)
    ? progress.get(Number(row.TransactionId)).EffectiveStatus === 'تم التسليم'
    : row.DeliveryStatus === 'تم التسليم';
  const deliveredRows = planned.filter((r) => isCompleted(r));
  const onTimeCount = deliveredRows.filter((r) => {
    const c = completionDates.get(Number(r.TransactionId)) || (r.DeliveredAt ? new Date(r.DeliveredAt) : null);
    return c && toSqlDate(c) <= toSqlDate(new Date(r.DueDate));
  }).length;
  dto.Delivered = deliveredRows.length;
  dto.OnTime = onTimeCount;
  dto.Late = deliveredRows.length - onTimeCount;
  dto.HasDelivered = dto.Delivered > 0;
  dto.OnTimePct = dto.Delivered === 0 ? 0 : Math.round((onTimeCount * 1000) / dto.Delivered) / 10;
  dto.Pending = planned.filter((r) => !isCompleted(r) && r.DeliveryStatus !== 'مرتجع').length;
  dto.ReturnedInPeriod = planned.filter((r) => r.DeliveryStatus === 'مرتجع').length;
  dto.NotDeliveredInPeriod = planned.filter((r) => r.DeliveryStatus !== 'مرتجع'
    && (hasProgress(r.TransactionId) ? !progress.get(Number(r.TransactionId)).HasEvents : r.DeliveryStatus !== 'تم التسليم')).length;
  dto.PartialInPeriod = planned.filter((r) => hasProgress(r.TransactionId)
    && progress.get(Number(r.TransactionId)).EffectiveStatus === 'جزئي').length;
  if (oc) {
    dto.EventsWithRemarksInPeriod = oc.EventsRemarks;
    dto.ManufacturingDefectQtyInPeriod = money(oc.Manuf);
    dto.HandlingDamageQtyInPeriod = money(oc.Handling);
    dto.MaintenanceBacklogRecords = oc.BacklogRecords;
    dto.MaintenanceBacklogQty = money(oc.BacklogQty);
    dto.MaintenanceOldestAgeDays = oc.OldestAge;
    dto.PendingModificationChargesCount = oc.PendingCharges;
    dto.ApprovedUncollectedModificationAmount = oc.ApprovedUncollected;
    dto.RepairCostInPeriod = oc.RepairCost;
  }
  const openNotCompleted = (row) => !hasProgress(row.TransactionId)
    || progress.get(Number(row.TransactionId)).EffectiveStatus !== 'تم التسليم';
  const overdue = openRows.filter((r) => toSqlDate(new Date(r.DueDate)) < today && openNotCompleted(r)
    && (!hasProgress(r.TransactionId) || progress.get(Number(r.TransactionId)).TotalRemainingQty > 0.0005));
  dto.OverdueNow = overdue.length;
  dto.OverdueAmount = money(overdue.reduce((s, r) => s + Number(r.GrandTotal || 0), 0));
  dto.DueToday = openRows.filter((r) => toSqlDate(new Date(r.DueDate)).getTime() === today.getTime() && openNotCompleted(r)).length;
  dto.DueTomorrow = openRows.filter((r) => toSqlDate(new Date(r.DueDate)).getTime() === addDays(today, 1).getTime() && openNotCompleted(r)).length;
  return dto;
}

// ─── التسويق — MarketingAsync:1841 عبر MarketingDashboardService ───
// الليدز من LeadsCRM بالفترة؛ العملاء = فرص المرحلة 3 المرتبطة بفواتير
// (BuildChannels:403 — عدّ الفرص لا جهات متميزة)؛ الإنفاق = مجموعات المصروفات
// تحت الجذر الذي اسمه يحوي «اعلان» (سقوطًا للمجموعة 29 — GetMarketingGroupIds:761)؛
// الحملات من AdSetName ثم AdName (BuildCampaigns:403)، والمصادر عبر FormId/Platform
// (LeadSourceId:791) إلى ContactSources. TopCampaignDeals يبقى 0 — بلازور لا يملؤه
// في هذا المسار (MarketingCampaignDto بلا Deals في BuildCampaigns).
function leadSourceId(lead) {
  const fid = Number.parseInt(lead.FormId, 10);
  if (Number.isSafeInteger(fid) && fid >= 1 && fid <= 20) return fid;
  const p = String(lead.Platform || '').trim().toLowerCase();
  if (['fb', 'facebook', 'فيسبوك'].includes(p)) return 2;
  if (['ig', 'instagram', 'انستجرام', 'انستا'].includes(p)) return 5;
  if (['google', 'جوجل'].includes(p)) return 7;
  if (['tiktok', 'تيك توك'].includes(p)) return 8;
  return null;
}
async function marketing(pool, ranges) {
  const leads = await fin._internal.request(pool, params(ranges, { branchId: null }), `
    SELECT LeadID AS LeadId, LeadStatus, IsConverted, FormId, Platform, AdSetName, AdName
    FROM LeadsCRM WHERE LeadDate >= @fromDate AND LeadDate < DATEADD(DAY, 1, @toDate)`);
  const opps = await fin._internal.request(pool, params(ranges, { branchId: null }), `
    SELECT OpportunityID AS OpportunityId, StageID AS StageId, TransactionID AS TransactionId, SourceID AS SourceId FROM SalesOpportunities
    WHERE CreatedAt >= @fromDate AND CreatedAt < DATEADD(DAY, 1, @toDate) AND ISNULL(IsActive, 1) = 1`);
  const customers = opps.filter((o) => Number(o.StageId) === 3 && o.TransactionId != null).length;
  const groups = await fin._internal.request(pool, [], `
    SELECT ExpenseGroupID AS ExpenseGroupId, ExpenseGroupName, ParentGroupID AS ParentGroupId FROM ExpenseGroups`);
  const root = groups.find((g) => String(g.ExpenseGroupName || '').includes('اعلان'));
  let groupIds;
  if (!root) groupIds = [29];
  else {
    groupIds = [];
    const collect = (id) => {
      if (groupIds.includes(id)) return;
      groupIds.push(id);
      for (const child of groups.filter((g) => Number(g.ParentGroupId) === id)) collect(Number(child.ExpenseGroupId));
    };
    collect(Number(root.ExpenseGroupId));
  }
  const spendRows = await fin._internal.request(pool, params(ranges, { branchId: null }), `
    SELECT ISNULL(SUM(Amount), 0) AS Total FROM Expenses
    WHERE ExpenseDate >= @fromDate AND ExpenseDate < DATEADD(DAY, 1, @toDate)
      AND ExpenseGroupID IN (${groupIds.join(',')})`);
  const spend = money(spendRows[0]?.Total);
  const leadsCount = leads.length;
  // المصادر
  let topSourceName = ''; let topSourceLeads = 0;
  try {
    const sources = await fin._internal.request(pool, [], `
      SELECT SourceID AS SourceId, SourceName, SourceNameAr FROM ContactSources WHERE ISNULL(IsActive, 1) = 1`);
    const counts = new Map();
    for (const lead of leads) {
      const sid = leadSourceId(lead);
      if (sid != null) counts.set(sid, (counts.get(sid) || 0) + 1);
    }
    for (const src of sources) {
      const c = counts.get(Number(src.SourceId)) || 0;
      if (c > topSourceLeads) { topSourceLeads = c; topSourceName = src.SourceNameAr || src.SourceName || ''; }
    }
  } catch { /* جدول المصادر غائب: الاسم يبقى فارغًا */ }
  const campaigns = new Map();
  for (const lead of leads) {
    const name = (lead.AdSetName && String(lead.AdSetName).trim()) || (lead.AdName && String(lead.AdName).trim()) || 'غير محدد';
    campaigns.set(name, (campaigns.get(name) || 0) + 1);
  }
  const topCampaign = [...campaigns.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    Leads: leadsCount, Customers: customers,
    ConversionPct: leadsCount === 0 ? 0 : Math.round((customers * 1000) / leadsCount) / 10,
    Spend: spend, CostPerLead: leadsCount > 0 ? money(spend / leadsCount) : 0,
    TopSourceName: topSourceName, TopSourceLeads: topSourceLeads,
    TopCampaignName: topCampaign ? topCampaign[0] : '', TopCampaignLeads: topCampaign ? topCampaign[1] : 0,
    TopCampaignDeals: 0,
  };
}

// ─── بوابة B2B — B2bAsync:1872 (الحالات B2Dtos.cs:19) ───
async function b2b(pool, ranges) {
  const dto = { RequestsInPeriod: 0, ConvertedInPeriod: 0, ConvertedValue: 0, PendingNow: 0, Companies: 0, ActiveUsers: 0, InactiveUsers: 0 };
  const periodRows = await fin._internal.request(pool, params(ranges, { branchId: null }), `
    SELECT Status, RelatedInvoiceId FROM B2BRequests
    WHERE CreatedAt >= @fromDate AND CreatedAt < DATEADD(DAY, 1, @toDate)`);
  dto.RequestsInPeriod = periodRows.length;
  const converted = periodRows.filter((r) => r.Status === 'Converted');
  dto.ConvertedInPeriod = converted.length;
  const invoiceIds = [...new Set(converted.map((r) => Number(r.RelatedInvoiceId)).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (invoiceIds.length) {
    const valueRows = await fin._internal.request(pool, [], `
      SELECT ISNULL(SUM(GrandTotal), 0) AS Total FROM Transactions WHERE TransactionID IN (${invoiceIds.join(',')})`);
    dto.ConvertedValue = money(valueRows[0]?.Total);
  }
  const pendingRows = await fin._internal.request(pool, [], `
    SELECT COUNT(*) AS Cnt FROM B2BRequests WHERE Status IN ('New', 'UnderReview')`);
  dto.PendingNow = Number(pendingRows[0]?.Cnt || 0);
  const userRows = await fin._internal.request(pool, [], 'SELECT PartyId, IsActive FROM B2BPortalUsers');
  dto.Companies = new Set(userRows.map((r) => Number(r.PartyId))).size;
  dto.ActiveUsers = userRows.filter((r) => r.IsActive === true || r.IsActive === 1).length;
  dto.InactiveUsers = userRows.length - dto.ActiveUsers;
  return dto;
}

// ─── الموارد البشرية — HrAsync:1916 ───
async function hr(pool, ranges, scope, today) {
  const employees = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT Status, BioEmployeeID, IsPermanentlyExempt FROM Employees WHERE EndDate IS NULL
    ${scope.scoped ? 'AND BranchId = @branchId' : ''}`);
  const active = employees.filter((e) => e.Status === 'نشط');
  const dto = {
    ActiveEmployees: active.length,
    OnLeaveCount: employees.filter((e) => e.Status === 'بالإجازة').length,
    ExemptCount: active.filter((e) => e.IsPermanentlyExempt === true || e.IsPermanentlyExempt === 1).length,
    PresentToday: 0, LateToday: 0, AbsentToday: 0, AttendancePct: 0,
    PayrollMonthCost: 0, PayrollMonthLabel: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`,
    ActiveLoansCount: 0, ActiveLoansRemaining: 0, NewLoansInPeriod: 0, NewLoansAmountInPeriod: 0,
  };
  // أساس الحضور: نشط + كود بصمة + غير معفى نهائيًا؛ التأخير > 15 دقيقة
  const basis = active.filter((e) => e.BioEmployeeID != null && !(e.IsPermanentlyExempt === true || e.IsPermanentlyExempt === 1));
  const attRows = await fin._internal.request(pool, [['today', sql.Date, today]], `
    SELECT BiometricCode, MAX(ISNULL(LateMinutes, 0)) AS MaxLate FROM Attendance
    WHERE CAST(LogDate AS DATE) = @today GROUP BY BiometricCode`);
  const basisCodes = new Set(basis.map((e) => Number(e.BioEmployeeID)));
  const present = attRows.filter((r) => basisCodes.has(Number(r.BiometricCode)));
  dto.PresentToday = present.length;
  dto.LateToday = present.filter((r) => Number(r.MaxLate || 0) > 15).length;
  dto.AbsentToday = Math.max(basis.length - dto.PresentToday, 0);
  dto.AttendancePct = basis.length === 0 ? 0 : Math.round((dto.PresentToday * 1000) / basis.length) / 10;
  const payrollRows = await fin._internal.request(pool, [['branchId', sql.Int, scope.branchId]], `
    SELECT ISNULL(SUM(ISNULL(p.NetSalary, p.BasicSalary + ISNULL(p.Allowances, 0) - ISNULL(p.Deductions, 0))), 0) AS Total
    FROM Payrolls p WHERE p.PayrollMonth = '${dto.PayrollMonthLabel}'
    ${scope.scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = p.EmployeeID AND e.BranchId = @branchId)' : ''}`);
  dto.PayrollMonthCost = money(payrollRows[0]?.Total);
  const loanRows = await fin._internal.request(pool, params(ranges, scope), `
    SELECT
      ActiveCount = (SELECT COUNT(*) FROM EmployeeLoans l WHERE l.Status = 'Active'
        ${scope.scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}),
      ActiveRemaining = (SELECT ISNULL(SUM(l.RemainingAmount), 0) FROM EmployeeLoans l WHERE l.Status = 'Active'
        ${scope.scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}),
      NewCount = (SELECT COUNT(*) FROM EmployeeLoans l WHERE l.Status <> 'Cancelled' AND l.LoanDate >= @fromDate AND l.LoanDate < DATEADD(DAY, 1, @toDate)
        ${scope.scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}),
      NewAmount = (SELECT ISNULL(SUM(l.LoanAmount), 0) FROM EmployeeLoans l WHERE l.Status <> 'Cancelled' AND l.LoanDate >= @fromDate AND l.LoanDate < DATEADD(DAY, 1, @toDate)
        ${scope.scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''})
  `);
  const lr = loanRows[0] || {};
  dto.ActiveLoansCount = Number(lr.ActiveCount || 0);
  dto.ActiveLoansRemaining = money(lr.ActiveRemaining);
  dto.NewLoansInPeriod = Number(lr.NewCount || 0);
  dto.NewLoansAmountInPeriod = money(lr.NewAmount);
  return dto;
}

// ─── نقطة الدخول — GetCockpitAsync/ComputeCockpitAsync ───
async function getCockpit({ period = 'month', branchId = null, from = null, to = null } = {}) {
  const pool = await connectDB();
  const today = cairoToday();
  const ranges = computeRanges(period, from, to);
  const scope = await branchScope(pool, branchId);
  const failed = [];
  const emptyFig = { SalesGross: 0, SaleReturns: 0, PurchasesGross: 0, PurchaseReturns: 0, Collected: 0, CashIn: 0, CashOut: 0, SalesNet: 0, PurchasesNet: 0, CashNet: 0 };
  const figs = await safe('kpis', failed, async () => ({
    cur: await figures(pool, ranges.from, ranges.toEff, scope),
    prev: await figures(pool, ranges.prevFrom, ranges.prevTo, scope),
    year: await figures(pool, ranges.yearFrom, ranges.yearTo, scope),
  }), { cur: emptyFig, prev: emptyFig, year: emptyFig });
  const stmts = await safe('profit', failed, async () => ({
    cur: await statement(pool, ranges.from, ranges.toEff, branchId),
    prev: await statement(pool, ranges.prevFrom, ranges.prevTo, branchId),
    year: await statement(pool, ranges.yearFrom, ranges.yearTo, branchId),
  }), { cur: null, prev: null, year: null });
  const trendRes = await safe('trend', failed, () => trend(pool, scope), { Trend: [], Forecast: 0, LastMonthSales: 0, ForecastPct: 0 });
  const teamRes = await safe('team', failed, () => team(pool, scope, today), { Employees: [], Gm: { Found: false, FullName: '', LastActivityText: '', ActionsWeek: 0, Recent: [], PendingPrice: 0, EscalatedComplaints: 0, TeamSalesMonth: 0, TeamActiveToday: 0, TeamTotal: 0 }, Dormant: 0 });
  const excRes = await safe('exceptions', failed, () => exceptions(pool, scope, today), {
    Exceptions: { Debts30: 0, Debts30Amount: 0, LateDeliveries: 0, PendingPrice: 0, NegativeStock: 0, StalledLeads: 0, OpenComplaints: 0 }, Escalated: 0,
  });
  const pendRes = await safe('pending', failed, () => pending(pool, scope), { InvoiceEdits: 0, ClosureApprovals: 0, DeliveryPermits: 0, PriceRequests: excRes.Exceptions.PendingPrice });
  const opsRes = await safe('ops', failed, () => ops(pool, scope, today), { FactoryOpen: 0, FactoryMonth: 0, OpenComplaints: 0, NewLeads: 0 });
  const pipeRes = await safe('pipeline', failed, () => pipeline(pool, ranges, scope, today), { CashBalance: 0, PipelineOpen: 0, PipelineValue: 0, PipelineStalled: 0, B2bPending: 0, BranchSales: [] });
  const agingRes = await safe('aging', failed, () => aging(pool, scope, today), {
    Receivables: AGING_LABELS.map((Label) => ({ Label, Amount: 0, Count: 0 })),
    Payables: AGING_LABELS.map((Label) => ({ Label, Amount: 0, Count: 0 })),
    TotalReceivables: 0, TotalPayables: 0, TopDebtors: [],
  });
  const quotRes = await safe('quotations', failed, () => quotations(pool, ranges, scope, today), {
    ByStatus: [], PeriodCount: 0, PeriodValue: 0, ConvertedCount: 0, ConversionRate: 0, HasDecided: false,
    SentCount: 0, SentValue: 0, AcceptedNotConvertedCount: 0, AcceptedNotConvertedValue: 0, ExpiringSoonCount: 0,
  });
  const invRes = await safe('inventory', failed, () => inventory(pool, branchId, scope, today), {
    TotalCostValue: 0, TotalSaleValue: 0, ProductsCount: 0, TotalQuantity: 0, OutOfStockCount: 0, LowStockCount: 0,
    DeadStockCount: 0, DeadStockValue: 0, TopValueProducts: [], Warehouses: [],
  });
  const jobRes = await safe('joborders', failed, () => jobOrders(pool, ranges, scope, today), {
    OpenCount: 0, OpenSale: 0, OpenPurchase: 0, OverdueCount: 0, OverdueValue: 0, WithAlternativesCount: 0, DeliveredInPeriod: 0,
  });
  const delRes = await safe('deliveries', failed, () => deliveries(pool, ranges, scope, today), {
    Planned: 0, Delivered: 0, OnTime: 0, Late: 0, OnTimePct: 0, HasDelivered: false, Pending: 0, ReturnedInPeriod: 0,
    NotDeliveredInPeriod: 0, PartialInPeriod: 0, PartialOpenNow: 0, BatchEventsInPeriod: 0, BatchOnTimeEvents: 0,
    BatchPunctualityPct: 0, HasBatchEvents: false, OverdueNow: 0, OverdueAmount: 0, DueToday: 0, DueTomorrow: 0,
    EventsWithRemarksInPeriod: 0, ManufacturingDefectQtyInPeriod: 0, HandlingDamageQtyInPeriod: 0,
    MaintenanceBacklogRecords: 0, MaintenanceBacklogQty: 0, MaintenanceOldestAgeDays: null,
    PendingModificationChargesCount: 0, ApprovedUncollectedModificationAmount: 0, RepairCostInPeriod: 0,
  });
  const mktRes = await safe('marketing', failed, () => marketing(pool, ranges), {
    Leads: 0, Customers: 0, ConversionPct: 0, Spend: 0, CostPerLead: 0, TopSourceName: '', TopSourceLeads: 0,
    TopCampaignName: '', TopCampaignLeads: 0, TopCampaignDeals: 0,
  });
  const b2bRes = await safe('b2b', failed, () => b2b(pool, ranges), {
    RequestsInPeriod: 0, ConvertedInPeriod: 0, ConvertedValue: 0, PendingNow: 0, Companies: 0, ActiveUsers: 0, InactiveUsers: 0,
  });
  const hrRes = await safe('hr', failed, () => hr(pool, ranges, scope, today), {
    ActiveEmployees: 0, PresentToday: 0, LateToday: 0, AbsentToday: 0, AttendancePct: 0, ExemptCount: 0, OnLeaveCount: 0,
    PayrollMonthCost: 0, PayrollMonthLabel: '', ActiveLoansCount: 0, ActiveLoansRemaining: 0, NewLoansInPeriod: 0, NewLoansAmountInPeriod: 0,
  });

  const priceForDecisions = failed.includes('pending') ? excRes.Exceptions.PendingPrice : pendRes.PriceRequests;
  const decisions = priceForDecisions + excRes.Escalated + teamRes.Dormant
    + pendRes.InvoiceEdits + pendRes.ClosureApprovals + pendRes.DeliveryPermits;
  teamRes.Gm.PendingPrice = excRes.Exceptions.PendingPrice;
  teamRes.Gm.EscalatedComplaints = excRes.Escalated;
  const cur = figs.cur; const prev = figs.prev;
  const salesPct = prev.SalesNet === 0 ? null : Math.round(((cur.SalesNet - prev.SalesNet) / Math.abs(prev.SalesNet)) * 1000) / 10;
  const story = failed.includes('kpis')
    ? `${ranges.label}: تعذّر تحميل المؤشرات المالية لهذه الفترة.`
    : `${ranges.label}${scope.scoped ? ` — فرع ${scope.branchName}` : ''}: المبيعات (صافي بعد المرتجعات) ${Math.round(cur.SalesNet).toLocaleString('en-US')} ج`
      + (salesPct != null ? ` (${salesPct >= 0 ? '+' : ''}${salesPct}% عن الفترة السابقة)` : '')
      + ` — تحصيلات الفترة ${Math.round(cur.Collected).toLocaleString('en-US')} ج — `
      + `الفريق: ${teamRes.Employees.filter((e) => e.ActionsToday > 0).length} نشط من ${teamRes.Employees.length}`
      + (teamRes.Dormant > 0 ? ` — ${teamRes.Dormant} موظف ساكن يحتاج قرارًا` : '')
      + (decisions > 0 ? ` — ${decisions} بند في انتظارك.` : ' — لا بنود معلقة.');
  const s = stmts.cur;
  const miniPl = s ? {
    Loaded: true, NetRevenue: s.NetRevenue, Cogs: s.CostOfGoodsSold, GrossProfit: s.GrossProfit,
    GrossProfitMargin: s.GrossProfitMargin, OperatingExpenses: s.TotalOperatingExpenses,
    PayrollExpense: s.PayrollExpense, NetProfit: s.NetProfit, NetProfitMargin: s.NetProfitMargin,
    TargetMarginPct: s.ProfitTarget.CurrentTargetPercentage, NextTargetMarginPct: s.ProfitTarget.NextTargetPercentage,
    TargetAchievementPct: s.ProfitTarget.AchievementPercentage, TargetStatus: s.ProfitTarget.Status, TargetMessage: s.ProfitTarget.Message,
  } : {
    Loaded: false, NetRevenue: 0, Cogs: 0, GrossProfit: 0, GrossProfitMargin: 0, OperatingExpenses: 0,
    PayrollExpense: 0, NetProfit: 0, NetProfitMargin: 0, TargetMarginPct: 0, NextTargetMarginPct: 0,
    TargetAchievementPct: 0, TargetStatus: '', TargetMessage: '',
  };
  return {
    Sales: kpi(cur.SalesNet, prev.SalesNet, figs.year.SalesNet),
    Collected: kpi(cur.Collected, prev.Collected, figs.year.Collected),
    Purchases: kpi(cur.PurchasesNet, prev.PurchasesNet, figs.year.PurchasesNet),
    Expenses: kpi(stmts.cur?.TotalOperatingExpenses ?? 0, stmts.prev?.TotalOperatingExpenses ?? 0, stmts.year?.TotalOperatingExpenses ?? 0),
    Net: kpi(stmts.cur?.NetProfit ?? 0, stmts.prev?.NetProfit ?? 0, stmts.year?.NetProfit ?? 0),
    CashNet: kpi(cur.CashNet, prev.CashNet, figs.year.CashNet),
    SaleReturns: cur.SaleReturns, PurchaseReturns: cur.PurchaseReturns,
    Aging: agingRes, MiniPl: miniPl,
    Quotations: quotRes, Inventory: invRes, JobOrders: jobRes, Deliveries: delRes,
    Marketing: mktRes, B2bBlock: b2bRes, Hr: hrRes,
    PendingInvoiceEdits: pendRes.InvoiceEdits, PendingClosureApprovals: pendRes.ClosureApprovals,
    PendingDeliveryPermits: pendRes.DeliveryPermits,
    FailedSections: failed,
    Trend: trendRes.Trend, Employees: teamRes.Employees, Gm: teamRes.Gm,
    Exceptions: excRes.Exceptions, Ops: opsRes,
    CashBalance: pipeRes.CashBalance, PipelineOpen: pipeRes.PipelineOpen, PipelineValue: pipeRes.PipelineValue,
    PipelineStalled: pipeRes.PipelineStalled, B2bPending: pipeRes.B2bPending, BranchSales: pipeRes.BranchSales,
    Period: period, PeriodKey: period, PeriodLabel: ranges.label,
    RangeFrom: dstr(ranges.from), RangeTo: dstr(ranges.toEff),
    BranchId: scope.branchId, BranchName: scope.branchName,
    BranchIgnoredSections: scope.scoped ? ['marketing', 'b2b', 'gm', 'complaints'] : [],
    Story: story, DecisionsPending: decisions, DormantCount: teamRes.Dormant,
    ForecastValue: trendRes.Forecast, LastMonthSales: trendRes.LastMonthSales, ForecastVsLastPct: trendRes.ForecastPct,
    GeneratedAt: new Date().toISOString(),
  };
}

async function getEmployeeTimeline(value) {
  const employeeId = intId(value, { optional: false, label: 'معرّف الموظف' });
  const pool = await connectDB();
  const userResult = await fin._internal.request(pool, [['employeeId', sql.Int, employeeId]], `
    SELECT TOP 1 Username FROM Users WHERE employeeID = @employeeId ORDER BY UserID`);
  const username = userResult[0]?.Username;
  if (!username) return [];
  const [auditResult, invoiceResult] = await Promise.all([
    fin._internal.request(pool, [['username', sql.NVarChar(100), username]], `
      SELECT TOP 20 ActionDate AS [When], TableName, ActionType FROM [dbo].[Audit_Log]
      WHERE LoginName = @username AND ActionDate IS NOT NULL ORDER BY ActionDate DESC, AuditID DESC`),
    fin._internal.request(pool, [['username', sql.NVarChar(100), username]], `
      SELECT TOP 10 TransactionDate AS [When], TransactionType, ReferenceNumber, GrandTotal
      FROM Transactions WHERE CreatedBy = @username ORDER BY TransactionDate DESC, TransactionID DESC`),
  ]);
  const rows = [
    ...auditResult.map((row) => ({ When: row.When, What: describe(row.TableName, row.ActionType), Kind: 'audit' })),
    ...invoiceResult.map((row) => ({
      When: row.When,
      What: `${row.TransactionType === 'Sale' ? 'فاتورة بيع' : 'فاتورة شراء'} ${row.ReferenceNumber || ''} — ${Math.round(Number(row.GrandTotal || 0)).toLocaleString('en-US')} ج`,
      Kind: 'invoice',
    })),
  ];
  return rows.sort((a, b) => new Date(b.When) - new Date(a.When)).slice(0, 25);
}

// ─── اللقطات — ExecutiveCockpitSnapshotService.cs (Save:60/List:92/Get:131) ───
// الجدول dbo.ExecutiveCockpitSnapshots (executive-cockpit-snapshot-table.sql)؛
// غيابه لا يكسر اللوحة أبدًا: Available=false، والحفظ يرد 409.
async function snapshotsAvailable(pool) {
  try {
    const rows = await fin._internal.request(pool, [], `
      SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ExecutiveCockpitSnapshots'
        AND schema_id = SCHEMA_ID('dbo')) THEN 1 ELSE 0 END AS Available`);
    return Number(rows[0]?.Available || 0) === 1;
  } catch { return false; }
}
async function listSnapshots() {
  const pool = await connectDB();
  if (!(await snapshotsAvailable(pool))) return { Available: false, Items: [] };
  const rows = await fin._internal.request(pool, [], `
    SELECT TOP 30 SnapshotId, CreatedAt, PeriodKey, PeriodLabel, BranchId, BranchName, CreatedBy
    FROM dbo.ExecutiveCockpitSnapshots ORDER BY CreatedAt DESC`);
  return {
    Available: true,
    Items: rows.map((r) => ({
      SnapshotId: Number(r.SnapshotId), CreatedAt: r.CreatedAt, PeriodKey: r.PeriodKey || '',
      PeriodLabel: r.PeriodLabel || '', BranchId: r.BranchId ?? null, BranchName: r.BranchName || '', CreatedBy: r.CreatedBy || '',
    })),
  };
}
async function getSnapshot(id) {
  const pool = await connectDB();
  if (!(await snapshotsAvailable(pool))) return null;
  const snapshotId = Number(id);
  if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) return null;
  const rows = await fin._internal.request(pool, [['id', sql.BigInt, snapshotId]], `
    SELECT SnapshotId, CreatedAt, PeriodKey, PeriodLabel, BranchId, BranchName, CreatedBy, PayloadJson
    FROM dbo.ExecutiveCockpitSnapshots WHERE SnapshotId = @id`);
  const r = rows[0];
  if (!r || !r.PayloadJson) return null;
  let data;
  try { data = JSON.parse(r.PayloadJson); } catch { return null; }
  return {
    Meta: {
      SnapshotId: Number(r.SnapshotId), CreatedAt: r.CreatedAt, PeriodKey: r.PeriodKey || '',
      PeriodLabel: r.PeriodLabel || '', BranchId: r.BranchId ?? null, BranchName: r.BranchName || '', CreatedBy: r.CreatedBy || '',
    },
    Data: data,
  };
}
async function saveSnapshot(dto, userName) {
  const pool = await connectDB();
  if (!(await snapshotsAvailable(pool))) {
    throw Object.assign(new Error('جدول اللقطات غير موجود — شغّل executive-cockpit-snapshot-table.sql مرة واحدة'), {
      statusCode: 409, code: 'SNAPSHOTS_TABLE_MISSING',
    });
  }
  await fin._internal.request(pool, [
    ['periodKey', sql.NVarChar(20), dto.PeriodKey || 'month'],
    ['periodLabel', sql.NVarChar(200), dto.PeriodLabel || ''],
    ['branchId', sql.Int, dto.BranchId ?? null],
    ['branchName', sql.NVarChar(100), dto.BranchName || null],
    ['createdBy', sql.NVarChar(256), String(userName || '')],
    ['payload', sql.NVarChar(sql.MAX), JSON.stringify(dto)],
  ], `
    INSERT INTO dbo.ExecutiveCockpitSnapshots (CreatedAt, PeriodKey, PeriodLabel, BranchId, BranchName, CreatedBy, PayloadJson)
    VALUES (SYSDATETIME(), @periodKey, @periodLabel, @branchId, @branchName, @createdBy, @payload)`);
  return true;
}

module.exports = {
  getCockpit, getEmployeeTimeline, listSnapshots, getSnapshot, saveSnapshot, PERIOD_KEYS,
  _test: { computeRanges, bucketize, leadSourceId },
};
