const { sql, connectDB } = require('../../core/database');
const {
  addDays,
  addMonths,
  addYears,
  rangeOfPeriod,
  previousRange,
  periodLabel,
  money,
  percentage,
  intId,
} = require('../../shared/reporting.utils');

const TABLE_AR = {
  Transactions: 'الفواتير',
  TransactionDetails: 'بنود الفواتير',
  Products: 'المنتجات',
  StockLevels: 'المخزون',
  Parties: 'العملاء والموردون',
  Employees: 'الموظفون',
  CrmTasks: 'المهام',
  CRM_Tasks: 'المهام',
  LeadsCRMs: 'العملاء المحتملون',
  LeadsCRM: 'العملاء المحتملون',
  Complaints: 'الشكاوى',
  Expenses: 'المصروفات',
  Users: 'المستخدمون',
  Attendances: 'الحضور',
  Attendance: 'الحضور',
};

const ACTION_AR = {
  Insert: 'إضافة',
  Update: 'تعديل',
  Delete: 'حذف',
  UpdateDeliveryStatus: 'تحديث تسليم',
  DeliveryPermissionGranted: 'منح إذن تسليم',
  DeliveryPermissionRequest: 'طلب إذن تسليم',
  Approve: 'اعتماد',
  Reject: 'رفض',
  Complete: 'إتمام',
  Receive: 'استلام',
  CCLog: 'تسجيل فيدباك',
  CCHide: 'إخفاء فيدباك',
};

function describe(tableName, actionType) {
  const action = ACTION_AR[actionType] || actionType || 'إجراء';
  const table = TABLE_AR[tableName] || tableName || '';
  return table ? `${action} — ${table}` : action;
}

function toSqlDate(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function formatMonth(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

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

// التعريفات الموحدة — بلازور ExecutiveCockpitService.cs:389 (FiguresAsync :403):
// المبيعات صافية بعد مرتجعات البيع، والمشتريات صافية بعد مرتجعات الشراء
// ومستبعدة منها فواتير المرآة، والمصروفات بالسطور المعترف بها فقط
// (FinancialReportsService.cs:548 — السلفة الأم مستبعدة وفروعها الشهرية معدودة).
async function getTotals(pool, from, to) {
  const result = await pool.request()
    .input('fromDate', sql.Date, toSqlDate(from))
    .input('toDate', sql.Date, toSqlDate(to))
    .query(`
      SELECT
        Sales = COALESCE((
          SELECT SUM(ISNULL(t.GrandTotal, 0)) FROM Transactions t
          WHERE t.TransactionType = 'Sale'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND t.TransactionDate >= @fromDate
            AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
        ), 0) - COALESCE((
          SELECT SUM(ISNULL(t.GrandTotal, 0)) FROM Transactions t
          WHERE t.TransactionType = 'SaleReturn'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND t.TransactionDate >= @fromDate
            AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
        ), 0),
        Collected = COALESCE((
          SELECT SUM(ISNULL(t.PaidAmount, 0)) FROM Transactions t
          WHERE t.TransactionType = 'Sale'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND t.TransactionDate >= @fromDate
            AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
        ), 0),
        Purchases = COALESCE((
          SELECT SUM(ISNULL(t.GrandTotal, 0)) FROM Transactions t
          WHERE t.TransactionType = 'Purchase'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND t.TransactionDate >= @fromDate
            AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
            AND (t.ReferenceType IS NULL OR t.ReferenceType NOT LIKE 'MirrorOf:%')
        ), 0) - COALESCE((
          SELECT SUM(ISNULL(t.GrandTotal, 0)) FROM Transactions t
          WHERE t.TransactionType = 'PurchaseReturn'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND t.TransactionDate >= @fromDate
            AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
        ), 0),
        Expenses = COALESCE((
          SELECT SUM(ISNULL(e.Amount, 0)) FROM Expenses e
          WHERE e.ExpenseDate >= @fromDate
            AND e.ExpenseDate < DATEADD(DAY, 1, @toDate)
            AND (ISNULL(e.IsAdvance, 0) <> 1 OR e.AdvanceParentExpenseId IS NOT NULL)
        ), 0)
    `);
  const row = result.recordset[0] || {};
  const totals = {
    Sales: money(row.Sales),
    Collected: money(row.Collected),
    Purchases: money(row.Purchases),
    Expenses: money(row.Expenses),
  };
  totals.Net = money(totals.Collected - totals.Purchases - totals.Expenses);
  return totals;
}

function kpi(current, previous, year) {
  return {
    Value: money(current),
    PrevValue: money(previous),
    YearValue: money(year),
    PrevPct: percentage(current, previous),
    YearPct: percentage(current, year),
  };
}

async function getTrend(pool, today) {
  const trendStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const result = await pool.request()
    .input('trendStart', sql.Date, trendStart)
    .query(`
      SELECT
        YEAR(t.TransactionDate) AS SaleYear,
        MONTH(t.TransactionDate) AS SaleMonth,
        COALESCE(SUM(CASE WHEN t.TransactionType = 'Sale' THEN ISNULL(t.GrandTotal, 0)
                          WHEN t.TransactionType = 'SaleReturn' THEN -ISNULL(t.GrandTotal, 0)
                          ELSE 0 END), 0) AS Sales,
        COALESCE(SUM(CASE WHEN t.TransactionType = 'Sale' THEN ISNULL(t.PaidAmount, 0) ELSE 0 END), 0) AS Collected,
        COALESCE(SUM(CASE WHEN t.TransactionType = 'Purchase'
                               AND (t.ReferenceType IS NULL OR t.ReferenceType NOT LIKE 'MirrorOf:%')
                          THEN ISNULL(t.GrandTotal, 0)
                          WHEN t.TransactionType = 'PurchaseReturn' THEN -ISNULL(t.GrandTotal, 0)
                          ELSE 0 END), 0) AS Purchases
      FROM Transactions t
      WHERE (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
        AND t.TransactionType IN ('Sale', 'SaleReturn', 'Purchase', 'PurchaseReturn')
        AND t.TransactionDate >= @trendStart
      GROUP BY YEAR(t.TransactionDate), MONTH(t.TransactionDate)
      ORDER BY SaleYear, SaleMonth
    `);
  const byMonth = new Map(result.recordset.map((row) => [
    `${row.SaleYear}-${row.SaleMonth}`,
    row,
  ]));
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    const date = addMonths(trendStart, index);
    const value = byMonth.get(`${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`) || {};
    rows.push({
      Label: formatMonth(date),
      Sales: money(value.Sales),
      Collected: money(value.Collected),
      Purchases: money(value.Purchases),
    });
  }
  return rows;
}

function isActiveEmployeeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'نشط' || normalized === 'active' || normalized === 'working';
}

async function getEmployees(pool, today) {
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const auditFrom = addDays(today, -34);
  const [employeesResult, usersResult, auditsResult, attendanceResult, salesResult, tasksResult] = await Promise.all([
    pool.request().query(`
      SELECT EmployeeID, FullName, JobTitle, Status, EndDate, BioEmployeeID
      FROM Employees
      WHERE EndDate IS NULL
      ORDER BY FullName
    `),
    pool.request().query(`
      SELECT Username, employeeID AS EmployeeID
      FROM Users
      WHERE employeeID IS NOT NULL AND ISNULL(IsActive, 1) = 1
    `),
    pool.request()
      .input('auditFrom', sql.DateTime, auditFrom)
      .query(`
        SELECT u.employeeID AS EmployeeID, a.LoginName, a.ActionDate,
               a.TableName, a.ActionType
        FROM [dbo].[Audit_Log] a
        INNER JOIN Users u ON a.LoginName = u.Username
        WHERE u.employeeID IS NOT NULL AND a.ActionDate >= @auditFrom
      `),
    pool.request()
      .input('today', sql.Date, today)
      .query(`
        SELECT BiometricCode, LateMinutes
        FROM Attendance
        WHERE CAST(LogDate AS DATE) = @today
      `),
    pool.request()
      .input('monthStart', sql.Date, monthStart)
      .query(`
        SELECT EmpId AS EmployeeID,
               SUM(CASE WHEN TransactionType = 'Sale' THEN ISNULL(GrandTotal, 0)
                        ELSE -ISNULL(GrandTotal, 0) END) AS Total,
               SUM(ISNULL(PaidAmount, 0)) AS Paid
        FROM Transactions
        WHERE TransactionType IN ('Sale', 'SaleReturn')
          AND (InvoiceStatus IS NULL OR InvoiceStatus <> 'Cancelled')
          AND TransactionDate >= @monthStart
          AND EmpId IS NOT NULL
        GROUP BY EmpId
      `),
    pool.request().query(`
      SELECT AssignedTo, DueDate
      FROM CRM_Tasks
      WHERE IsActive = 1 AND Status = 'Pending'
    `),
  ]);

  const loginByEmployee = new Map();
  for (const row of usersResult.recordset) {
    if (!loginByEmployee.has(Number(row.EmployeeID))) {
      loginByEmployee.set(Number(row.EmployeeID), row.Username);
    }
  }
  const auditsByEmployee = new Map();
  for (const row of auditsResult.recordset) {
    const id = Number(row.EmployeeID);
    if (!auditsByEmployee.has(id)) auditsByEmployee.set(id, []);
    auditsByEmployee.get(id).push(row);
  }
  const attendanceByBio = new Map();
  for (const row of attendanceResult.recordset) {
    const key = Number(row.BiometricCode);
    const current = attendanceByBio.get(key);
    if (!current || Number(row.LateMinutes || 0) > Number(current.LateMinutes || 0)) {
      attendanceByBio.set(key, row);
    }
  }
  const salesByEmployee = new Map(
    salesResult.recordset.map((row) => [Number(row.EmployeeID), row]),
  );
  const tasksByEmployee = new Map();
  for (const row of tasksResult.recordset) {
    const id = Number(row.AssignedTo || 0);
    if (!tasksByEmployee.has(id)) tasksByEmployee.set(id, []);
    tasksByEmployee.get(id).push(row);
  }

  const now = new Date();
  const rows = employeesResult.recordset.map((employee) => {
    const id = Number(employee.EmployeeID);
    const login = loginByEmployee.get(id) || null;
    const audits = auditsByEmployee.get(id) || [];
    const auditDates = audits
      .filter((row) => row.ActionDate)
      .map((row) => new Date(row.ActionDate));
    const heat = [];
    for (let dayOffset = 6; dayOffset >= 0; dayOffset -= 1) {
      const day = addDays(today, -dayOffset);
      heat.push(auditDates.filter((date) =>
        date.getUTCFullYear() === day.getUTCFullYear()
        && date.getUTCMonth() === day.getUTCMonth()
        && date.getUTCDate() === day.getUTCDate()).length);
    }
    const actionsToday = heat[6] || 0;
    const actionsMonth = auditDates.filter((date) => date >= addDays(today, -29)).length;
    const lastActivity = auditDates.length
      ? new Date(Math.max(...auditDates.map((date) => date.getTime())))
      : null;
    let attendance = 'بلا تسجيل';
    const active = isActiveEmployeeStatus(employee.Status);
    if (!active) attendance = employee.Status || 'غير نشط';
    else if (employee.BioEmployeeID != null
      && attendanceByBio.has(Number(employee.BioEmployeeID))) {
      attendance = Number(attendanceByBio.get(Number(employee.BioEmployeeID)).LateMinutes || 0) > 15
        ? 'متأخر'
        : 'حاضر';
    }
    const sales = salesByEmployee.get(id) || {};
    const monthSales = money(sales.Total);
    const monthCollection = money(sales.Paid);
    const jobTitle = employee.JobTitle || '';
    const isSales = monthSales > 0 || jobTitle.includes('مبيعات') || jobTitle.includes('مندوب');
    const tasks = tasksByEmployee.get(id) || [];
    let status;
    if (!active) status = 'off';
    else if (!login) status = 'gray';
    else {
      const idleDays = lastActivity == null
        ? 999
        : (now.getTime() - lastActivity.getTime()) / 86400000;
      status = idleDays >= 3 ? 'red' : actionsToday === 0 ? 'yellow' : 'green';
    }
    return {
      EmployeeId: id,
      FullName: employee.FullName || '',
      JobTitle: jobTitle || '—',
      Attendance: attendance,
      ActionsToday: actionsToday,
      ActionsMonth: actionsMonth,
      Heat7: heat,
      LastActivity: lastActivity,
      LastActivityText: humanizeWhen(lastActivity, now),
      MonthSales: monthSales,
      MonthCollection: monthCollection,
      TasksPending: tasks.length,
      TasksOverdue: tasks.filter((task) => task.DueDate && new Date(task.DueDate) < now).length,
      Status: status,
      IsSales: isSales,
      HrStatus: employee.Status || '—',
      HasAccount: Boolean(login),
      LoginName: login,
      AuditRows: audits,
    };
  });
  return rows;
}

async function getExceptionsAndOps(pool, today) {
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const cutoff30 = addDays(today, -30);
  const result = await pool.request()
    .input('today', sql.Date, today)
    .input('monthStart', sql.Date, monthStart)
    .input('cutoff30', sql.Date, cutoff30)
    .query(`
      SELECT
        Debts30 = COALESCE((
          SELECT COUNT(*) FROM Transactions t
          WHERE t.TransactionType = 'Sale'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND ISNULL(t.GrandTotal, 0) > ISNULL(t.PaidAmount, 0)
            AND COALESCE(t.DueDate, t.TransactionDate) < @cutoff30
        ), 0),
        Debts30Amount = COALESCE((
          SELECT SUM(ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0)) FROM Transactions t
          WHERE t.TransactionType = 'Sale'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND ISNULL(t.GrandTotal, 0) > ISNULL(t.PaidAmount, 0)
            AND COALESCE(t.DueDate, t.TransactionDate) < @cutoff30
        ), 0),
        LateDeliveries = COALESCE((
          SELECT COUNT(*) FROM Transactions t
          WHERE t.TransactionType = 'Sale'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND ISNULL(t.IsDelivered, 0) = 0
            AND t.DueDate IS NOT NULL AND t.DueDate < @today
        ), 0),
        PendingPrice = COALESCE((
          SELECT COUNT(*) FROM PriceChangeRequests r WHERE r.Status = N'Pending'
        ), 0),
        NegativeStock = COALESCE((
          SELECT COUNT(DISTINCT ProductID) FROM StockLevels WHERE Quantity < 0
        ), 0),
        StalledLeads = COALESCE((
          SELECT COUNT(*) FROM LeadsCRM l
          WHERE l.LeadStatus IN (N'جديد', N'تم الإسناد')
            AND l.CreatedAt < DATEADD(DAY, -10, @today)
        ), 0),
        OpenComplaints = COALESCE((
          SELECT COUNT(*) FROM Complaints c
          WHERE ISNULL(c.IsActive, 1) = 1 AND ISNULL(c.Status, 1) NOT IN (4, 5)
        ), 0),
        EscalatedComplaints = COALESCE((
          SELECT COUNT(*) FROM Complaints c
          WHERE ISNULL(c.IsActive, 1) = 1 AND c.Status = 6
        ), 0),
        FactoryOpen = COALESCE((
          SELECT COUNT(*) FROM Transactions t
          INNER JOIN Parties p ON t.PartyID = p.PartyID
          WHERE p.PartyName = N'المصنع' AND t.TransactionType = 'Purchase'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND ISNULL(t.IsDelivered, 0) = 0
        ), 0),
        FactoryMonth = COALESCE((
          SELECT COUNT(*) FROM Transactions t
          INNER JOIN Parties p ON t.PartyID = p.PartyID
          WHERE p.PartyName = N'المصنع' AND t.TransactionType = 'Purchase'
            AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
            AND t.DeliveredAt >= @monthStart
        ), 0),
        NewLeads = COALESCE((
          SELECT COUNT(*) FROM LeadsCRM l WHERE l.CreatedAt >= @monthStart
        ), 0)
    `);
  return result.recordset[0] || {};
}

async function getCashPipelineBranches(pool, from, to, today) {
  const [summaryResult, b2bResult, pipelineResult, branchResult] = await Promise.all([
    pool.request().query(`
      SELECT CashBalance =
        COALESCE((SELECT SUM(ISNULL(OpeningBalance, 0)) FROM CashBoxes), 0)
        + COALESCE((SELECT SUM(ISNULL(Amount, 0)) FROM CashboxTransactions WHERE TransactionType = N'قبض'), 0)
        - COALESCE((SELECT SUM(ISNULL(Amount, 0)) FROM CashboxTransactions WHERE TransactionType = N'صرف'), 0)
    `),
    pool.request().query(`
      IF OBJECT_ID(N'dbo.B2BRequests', N'U') IS NULL
        SELECT CAST(0 AS int) AS B2bPending;
      ELSE
        EXEC sys.sp_executesql
          N'SELECT COUNT(*) AS B2bPending FROM dbo.B2BRequests WHERE Status IN (N''New'', N''UnderReview'')';
    `),
    pool.request()
      .input('today', sql.Date, today)
      .query(`
        SELECT ExpectedValue, NextFollowUpDate
        FROM SalesOpportunities
        WHERE ClosedAt IS NULL
      `),
    pool.request()
      .input('fromDate', sql.Date, from)
      .input('toDate', sql.Date, to)
      .query(`
        SELECT COALESCE(b.BranchNameAr, b.BranchNameEn, N'غير محدد') AS Name,
               SUM(CASE WHEN t.TransactionType = 'Sale' THEN ISNULL(t.GrandTotal, 0)
                        ELSE -ISNULL(t.GrandTotal, 0) END) AS Value
        FROM Transactions t
        INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
        INNER JOIN Branches b ON w.BranchID = b.BranchID
        WHERE t.TransactionType IN ('Sale', 'SaleReturn')
          AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
          AND t.TransactionDate >= @fromDate
          AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
        GROUP BY b.BranchNameAr, b.BranchNameEn
        ORDER BY Value DESC
      `),
  ]);
  const opportunities = pipelineResult.recordset;
  return {
    CashBalance: money(summaryResult.recordset[0]?.CashBalance),
    B2bPending: Number(b2bResult.recordset[0]?.B2bPending || 0),
    PipelineOpen: opportunities.length,
    PipelineValue: money(opportunities.reduce(
      (sum, row) => sum + Number(row.ExpectedValue || 0),
      0,
    )),
    PipelineStalled: opportunities.filter((row) =>
      row.NextFollowUpDate && new Date(row.NextFollowUpDate) < today).length,
    BranchSales: branchResult.recordset.map((row) => ({
      Name: row.Name,
      Value: money(row.Value),
    })),
  };
}

async function getCockpit(rawPeriod) {
  const pool = await connectDB();
  const { period, from, to, today } = rangeOfPeriod(rawPeriod);
  const previous = previousRange(from, to);
  const [current, previousTotals, yearTotals, trend, employees, exceptionRow, extra] = await Promise.all([
    getTotals(pool, from, to),
    getTotals(pool, previous.from, previous.to),
    getTotals(pool, addYears(from, -1), addYears(to, -1)),
    getTrend(pool, today),
    getEmployees(pool, today),
    getExceptionsAndOps(pool, today),
    getCashPipelineBranches(pool, from, to, today),
  ]);

  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const monthPoint = trend[trend.length - 1] || {};
  const previousMonthPoint = trend[trend.length - 2] || {};
  const monthSales = money(monthPoint.Sales);
  const lastMonthSales = money(previousMonthPoint.Sales);
  const daysInMonth = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  const dayOfMonth = Math.max(today.getUTCDate(), 1);
  const forecast = money(Math.round((monthSales / dayOfMonth) * daysInMonth));
  const forecastPct = percentage(forecast, lastMonthSales);

  const dormant = employees.filter((employee) => employee.Status === 'red');
  const generalManager = employees.find((employee) =>
    employee.JobTitle.includes('مدير عام') || employee.JobTitle.includes('مدير عامًا'));
  const systemTeam = employees.filter((employee) =>
    employee.Status !== 'off' && employee.HasAccount);
  const gmRecent = generalManager
    ? [...generalManager.AuditRows]
      .sort((a, b) => new Date(b.ActionDate) - new Date(a.ActionDate))
      .slice(0, 6)
      .map((row) => ({
        When: humanizeWhen(row.ActionDate),
        What: describe(row.TableName, row.ActionType),
      }))
    : [];
  const gm = {
    Found: Boolean(generalManager),
    FullName: generalManager?.FullName || '',
    LastActivityText: generalManager?.LastActivityText || '',
    ActionsWeek: generalManager
      ? generalManager.AuditRows.filter((row) =>
        row.ActionDate && new Date(row.ActionDate) >= addDays(today, -6)).length
      : 0,
    Recent: gmRecent,
    PendingPrice: Number(exceptionRow.PendingPrice || 0),
    EscalatedComplaints: Number(exceptionRow.EscalatedComplaints || 0),
    TeamSalesMonth: money(employees.reduce((sum, row) => sum + row.MonthSales, 0)),
    TeamActiveToday: systemTeam.filter((row) => row.ActionsToday > 0).length,
    TeamTotal: systemTeam.length,
  };
  const decisions = Number(exceptionRow.PendingPrice || 0)
    + Number(exceptionRow.EscalatedComplaints || 0)
    + dormant.length;
  const salesPct = percentage(current.Sales, previousTotals.Sales);
  const story = `${periodLabel(period)}: المبيعات ${Math.round(current.Sales).toLocaleString('en-US')} ج (${salesPct >= 0 ? '+' : ''}${salesPct}% عن الفترة السابقة) — المحصّل من فواتير الفترة ${Math.round(current.Collected).toLocaleString('en-US')} ج — الفريق: ${employees.filter((row) => row.ActionsToday > 0).length} نشط من ${employees.length}${dormant.length ? ` — ${dormant.length} موظف ساكن يحتاج قرارًا` : ''}${decisions ? ` — ${decisions} بند في انتظارك.` : ' — لا بنود معلقة.'}`;

  const publicEmployees = employees.map((employee) => {
    const row = { ...employee };
    delete row.LoginName;
    delete row.AuditRows;
    return row;
  });

  return {
    Sales: kpi(current.Sales, previousTotals.Sales, yearTotals.Sales),
    Collected: kpi(current.Collected, previousTotals.Collected, yearTotals.Collected),
    Purchases: kpi(current.Purchases, previousTotals.Purchases, yearTotals.Purchases),
    Expenses: kpi(current.Expenses, previousTotals.Expenses, yearTotals.Expenses),
    Net: kpi(current.Net, previousTotals.Net, yearTotals.Net),
    Trend: trend,
    Employees: publicEmployees,
    Gm: gm,
    Exceptions: {
      Debts30: Number(exceptionRow.Debts30 || 0),
      Debts30Amount: money(exceptionRow.Debts30Amount),
      LateDeliveries: Number(exceptionRow.LateDeliveries || 0),
      PendingPrice: Number(exceptionRow.PendingPrice || 0),
      NegativeStock: Number(exceptionRow.NegativeStock || 0),
      StalledLeads: Number(exceptionRow.StalledLeads || 0),
      OpenComplaints: Number(exceptionRow.OpenComplaints || 0),
    },
    Ops: {
      FactoryOpen: Number(exceptionRow.FactoryOpen || 0),
      FactoryMonth: Number(exceptionRow.FactoryMonth || 0),
      OpenComplaints: Number(exceptionRow.OpenComplaints || 0),
      NewLeads: Number(exceptionRow.NewLeads || 0),
    },
    ...extra,
    Period: period,
    PeriodLabel: periodLabel(period),
    Story: story,
    DecisionsPending: decisions,
    DormantCount: dormant.length,
    ForecastValue: forecast,
    LastMonthSales: lastMonthSales,
    ForecastVsLastPct: forecastPct,
    GeneratedAt: new Date().toISOString(),
    MonthStart: monthStart.toISOString(),
  };
}

async function getEmployeeTimeline(value) {
  const employeeId = intId(value, { optional: false, label: 'معرّف الموظف' });
  const pool = await connectDB();
  const userResult = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT TOP 1 Username FROM Users
      WHERE employeeID = @employeeId AND ISNULL(IsActive, 1) = 1
      ORDER BY UserID
    `);
  const username = userResult.recordset[0]?.Username;
  if (!username) return [];

  const [auditResult, invoiceResult] = await Promise.all([
    pool.request()
      .input('username', sql.NVarChar(100), username)
      .query(`
        SELECT TOP 20 ActionDate AS [When], TableName, ActionType
        FROM [dbo].[Audit_Log]
        WHERE LoginName = @username AND ActionDate IS NOT NULL
        ORDER BY ActionDate DESC, AuditID DESC
      `),
    pool.request()
      .input('username', sql.NVarChar(100), username)
      .query(`
        SELECT TOP 10 TransactionDate AS [When], TransactionType,
               ReferenceNumber, GrandTotal
        FROM Transactions
        WHERE CreatedBy = @username
        ORDER BY TransactionDate DESC, TransactionID DESC
      `),
  ]);
  const rows = [
    ...auditResult.recordset.map((row) => ({
      When: row.When,
      What: describe(row.TableName, row.ActionType),
      Kind: 'audit',
    })),
    ...invoiceResult.recordset.map((row) => ({
      When: row.When,
      What: `${row.TransactionType === 'Sale' ? 'فاتورة بيع' : 'فاتورة شراء'} ${row.ReferenceNumber || ''} — ${Math.round(Number(row.GrandTotal || 0)).toLocaleString('en-US')} ج`,
      Kind: 'invoice',
    })),
  ];
  return rows
    .sort((a, b) => new Date(b.When) - new Date(a.When))
    .slice(0, 25);
}

module.exports = {
  getCockpit,
  getEmployeeTimeline,
};
