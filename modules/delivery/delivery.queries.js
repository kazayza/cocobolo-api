const crypto = require('crypto');
const { sql, connectDB } = require('../../core/database');
const policy = require('../../shared/authorization.policy');
const dates = require('../../shared/delivery-dates');

const ACTION_PERMISSION_REQUEST = 'DeliveryPermissionRequest';
const ACTION_PERMISSION_GRANTED = 'DeliveryPermissionGranted';
const ACTION_EVENT_RECORDED = 'DeliveryEventRecorded';
const ACTION_EVENT_VOIDED = 'DeliveryEventVoided';
const SQL_INT_MAX = 2147483647;

// ثوابت بلازور (SalesDeliveryStatusService.cs:18-19, 1404 + DeliveryProjection.cs):
// تسامح الكميات 0.0005 وتسامح النقود 0.01.
const QTY_EPSILON = 0.0005;
const MONEY_EPSILON = 0.01;
// حالات سجل الصيانة التي تُبقي الكمية «داخل الحلقة» (DeliveryOutcomesDto.cs)
const MAINTENANCE_IN_LOOP = ['Pending', 'InProgress', 'ReadyForRedelivery', 'Unrepairable'];
const MAINTENANCE_SETTLED = 'ClosedByCredit';

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round3(value) {
  return Math.round(num(value) * 1000) / 1000;
}

// تنسيق كمية كما في بلازور (0.###) لرسائل الأخطاء
function fmtQty(value) {
  return String(parseFloat(num(value).toFixed(3)));
}

function fmtMoney(value) {
  return num(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isMissingTableError(error) {
  return Boolean(error) && (error.number === 208 || /Invalid object name/i.test(String(error.message || '')));
}

// يربط قائمة معرّفات كمعاملات @prefix0..n ويعيد نص الـ IN (...).
function bindIdList(request, prefix, ids) {
  const placeholders = ids.map((id, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.Int, id);
    return `@${name}`;
  });
  return `(${placeholders.join(', ')})`;
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function assertId(value, label = 'المعرّف') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > SQL_INT_MAX) {
    throw Object.assign(new Error(`${label} غير صالح`), { statusCode: 400 });
  }
  return id;
}

function buildDeliveryStatusSql(alias = 't') {
  return `CASE
    WHEN ${alias}.IsDelivered = 1 THEN 'delivered'
    WHEN ${alias}.DeliveredNotes LIKE N'مرتجع:%' THEN 'returned'
    WHEN ${alias}.DueDate IS NOT NULL AND CAST(${alias}.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN 'overdue'
    WHEN ${alias}.DueDate IS NOT NULL AND CAST(${alias}.DueDate AS DATE) = CAST(GETDATE() AS DATE) THEN 'today'
    WHEN ${alias}.DueDate IS NOT NULL AND DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(${alias}.DueDate AS DATE)) BETWEEN 1 AND 3 THEN 'soon'
    ELSE 'upcoming'
  END`;
}

function buildWhere(request, filters = {}, { includeStatus = true } = {}) {
  const clauses = [
    `t.TransactionType = 'Sale'`,
    `(t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')`,
    `t.DueDate IS NOT NULL`,
  ];

  const dateColumn = filters.dateFilterType === 'invoice'
    ? 't.TransactionDate'
    : filters.dateFilterType === 'delivered'
      ? 't.DeliveredAt'
      : 't.DueDate';

  if (filters.dateFrom) {
    request.input('dateFrom', sql.Date, filters.dateFrom);
    clauses.push(`CAST(${dateColumn} AS DATE) >= @dateFrom`);
  }
  if (filters.dateTo) {
    request.input('dateTo', sql.Date, filters.dateTo);
    clauses.push(`CAST(${dateColumn} AS DATE) <= @dateTo`);
  }
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    clauses.push(`(
      p.PartyName LIKE @search OR p.Phone LIKE @search OR p.Phone2 LIKE @search
      OR t.ReferenceNumber LIKE @search
      OR CAST(t.TransactionID AS NVARCHAR(30)) LIKE @search
    )`);
  }
  if (filters.debt === 'remaining') {
    clauses.push(`ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) > 0`);
  } else if (filters.debt === 'settled') {
    clauses.push(`ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) <= 0`);
  }

  if (includeStatus) {
    const status = String(filters.status || 'all').toLowerCase();
    if (status === 'delivered') clauses.push(`t.IsDelivered = 1`);
    else if (status === 'returned') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND t.DeliveredNotes LIKE N'مرتجع:%'`);
    else if (status === 'overdue') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)`);
    else if (status === 'today') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)`);
    else if (status === 'soon') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) BETWEEN 1 AND 3`);
    else if (status === 'upcoming') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) > 3`);
    else if (status === 'pending') clauses.push(`ISNULL(t.IsDelivered, 0) = 0`);
  }

  return clauses.map((clause) => `(${clause})`).join(' AND ');
}

async function getDeliveries(filters = {}, auth = null) {
  const pool = await connectDB();
  const request = pool.request();
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 30), 1), 100);
  const offset = (page - 1) * limit;
  const where = buildWhere(request, filters);
  const statusSql = buildDeliveryStatusSql('t');

  const result = await request.query(`
    SELECT
      t.TransactionID, t.ReferenceNumber, t.TransactionDate, t.DueDate,
      ISNULL(t.IsDelivered, 0) AS IsDelivered, t.DeliveredAt, t.DeliveredNotes,
      t.PartyID, p.PartyName AS ClientName, p.Phone, p.Phone2, p.Address,
      t.EmpId, salesEmp.FullName AS SalesEmployeeName,
      t.DeliveryEmployeeId, COALESCE(deliveryEmp.FullName, t.DeliveryEmployeeName) AS DeliveryEmployeeName,
      t.GrandTotal, t.PaidAmount,
      ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
      DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) AS DaysRemaining,
      ${statusSql} AS DeliveryStatus,
      CASE WHEN permissionState.ActionType = N'${ACTION_PERMISSION_REQUEST}' THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS HasPendingPermissionRequest,
      permissionState.LoginName AS PermissionActionBy,
      permissionState.ActionDate AS PermissionActionAt,
      COUNT(*) OVER() AS TotalRows
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN Employees salesEmp ON t.EmpId = salesEmp.EmployeeID
    LEFT JOIN Employees deliveryEmp ON t.DeliveryEmployeeId = deliveryEmp.EmployeeID
    OUTER APPLY (
      SELECT TOP 1 a.ActionType, a.LoginName, a.ActionDate
      FROM [dbo].[Audit_Log] a
      WHERE a.TableName = N'Transactions'
        AND a.PrimaryKeyValue = CAST(t.TransactionID AS NVARCHAR(200))
        AND a.ActionType IN (N'${ACTION_PERMISSION_REQUEST}', N'${ACTION_PERMISSION_GRANTED}')
      ORDER BY a.AuditID DESC
    ) permissionState
    WHERE ${where}
    ORDER BY
      CASE WHEN t.IsDelivered = 1 THEN 2 ELSE 0 END,
      CASE WHEN t.DueDate IS NULL THEN 1 ELSE 0 END,
      t.DueDate, t.TransactionID DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `);

  await attachProgressAndSchedules(pool, result.recordset, auth);
  await attachSchedulePending(pool, result.recordset);

  return {
    rows: result.recordset,
    page,
    limit,
    total: result.recordset.length ? Number(result.recordset[0].TotalRows || 0) : 0,
  };
}

async function getDeliveryStats(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, filters, { includeStatus: false });
  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') THEN 1 ELSE 0 END), 0) AS Pending,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS Overdue,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS Today,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) BETWEEN 1 AND 3 THEN 1 ELSE 0 END), 0) AS Soon,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%') AND DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) > 3 THEN 1 ELSE 0 END), 0) AS Upcoming,
      COALESCE(SUM(CASE WHEN t.IsDelivered = 1 THEN 1 ELSE 0 END), 0) AS Delivered,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND t.DeliveredNotes LIKE N'مرتجع:%' THEN 1 ELSE 0 END), 0) AS Returned,
      COALESCE(SUM(ISNULL(t.GrandTotal, 0)), 0) AS TotalGrandTotal,
      COALESCE(SUM(ISNULL(t.PaidAmount, 0)), 0) AS TotalPaidAmount,
      COALESCE(SUM(ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0)), 0) AS TotalRemaining,
      COALESCE(SUM(CASE WHEN ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) > 0 THEN 1 ELSE 0 END), 0) AS WithRemainingCount
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE ${where}
  `);
  return result.recordset[0] || {};
}

async function getDeliveryDetails(value, auth = null) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  const headerResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        t.TransactionID, t.ReferenceNumber, t.TransactionDate, t.DueDate,
        t.TransactionType, t.InvoiceStatus, ISNULL(t.IsDelivered, 0) AS IsDelivered,
        t.DeliveredAt, t.DeliveredNotes, t.Notes,
        t.PartyID, p.PartyName AS ClientName, p.Phone, p.Phone2, p.Address,
        t.EmpId, salesEmp.FullName AS SalesEmployeeName,
        t.DeliveryEmployeeId, COALESCE(deliveryEmp.FullName, t.DeliveryEmployeeName) AS DeliveryEmployeeName,
        t.GrandTotal, t.PaidAmount,
        ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
        DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) AS DaysRemaining,
        ${buildDeliveryStatusSql('t')} AS DeliveryStatus,
        CASE WHEN permissionState.ActionType = N'${ACTION_PERMISSION_REQUEST}' THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS HasPendingPermissionRequest,
        permissionState.ActionType AS LastPermissionAction,
        permissionState.LoginName AS PermissionActionBy,
        permissionState.ActionDate AS PermissionActionAt
      FROM Transactions t
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      LEFT JOIN Employees salesEmp ON t.EmpId = salesEmp.EmployeeID
      LEFT JOIN Employees deliveryEmp ON t.DeliveryEmployeeId = deliveryEmp.EmployeeID
      OUTER APPLY (
        SELECT TOP 1 a.ActionType, a.LoginName, a.ActionDate
        FROM [dbo].[Audit_Log] a
        WHERE a.TableName = N'Transactions'
          AND a.PrimaryKeyValue = CAST(t.TransactionID AS NVARCHAR(200))
          AND a.ActionType IN (N'${ACTION_PERMISSION_REQUEST}', N'${ACTION_PERMISSION_GRANTED}')
        ORDER BY a.AuditID DESC
      ) permissionState
      WHERE t.TransactionID = @id
        AND t.TransactionType = 'Sale'
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
    `);
  const header = headerResult.recordset[0];
  if (!header) return null;

  const itemsResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT d.DetailID, d.ProductID, p.ProductName, d.Quantity,
             d.UnitPrice, d.TotalAmount, d.Notes, d.SelectedAlternativeID,
             d.DeliveryDate, d.DeliveryDateIsCustom,
             alt.AlternativeName, alt.SpecificationSummary
      FROM TransactionDetails d
      INNER JOIN Products p ON d.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives alt
        ON d.SelectedAlternativeID = alt.AlternativeID
      WHERE d.TransactionID = @id
      ORDER BY d.DetailID
    `);
  // تقدم كل بند من أحداث التسليم + موعده المعروض لهذا المستخدم + أحداث
  // الفاتورة (مرآة GetDeliveryDetailsAsync في بلازور). غياب جداول الأحداث
  // (SQL لم يُشغَّل) → تقدم صفري بلا انهيار، كما في بلازور.
  const products = itemsResult.recordset;
  let state = null;
  try {
    state = await loadDeliveryState(() => pool.request(), id);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
  const eventsData = await getDeliveryEvents(id);

  const seesReal = auth ? dates.canSeeRealDate(auth) : true;
  let totalDelivered = 0;
  let totalInLoop = 0;
  let totalSettled = 0;
  let totalInvoiced = 0;
  for (const product of products) {
    const detailId = Number(product.DetailID);
    const invoiced = num(product.Quantity);
    const delivered = state?.acceptedByDetail.get(detailId) || 0;
    const inLoop = state?.inLoopByDetail.get(detailId) || 0;
    const settled = state?.settledByDetail.get(detailId) || 0;
    const remaining = invoiced - delivered - settled;
    totalInvoiced += invoiced;
    totalDelivered += delivered;
    totalInLoop += inLoop;
    totalSettled += settled;

    const isCustom = Boolean(product.DeliveryDateIsCustom) && Boolean(product.DeliveryDate);
    const effective = dates.effectiveLineDate(product.DeliveryDate, isCustom, header.DueDate);
    const scheduled = dates.displayDate(effective, header.TransactionDate, seesReal);
    const lastDeliveryDate = state?.lastDateByDetail.get(detailId) || null;

    product.DeliveredQty = round3(delivered);
    product.InLoopQty = round3(inLoop);
    product.SettledQty = round3(settled);
    product.RemainingQty = round3(remaining);
    product.ScheduledDate = scheduled;
    product.ScheduledDateIsCustom = isCustom;
    product.IsScheduleOverdue = dates.isLineOverdue(scheduled, remaining);
    product.LastDeliveryDate = lastDeliveryDate;
    // تأخر الإنجاز عن المتفق عليه — حقائق فعلية لا تُخفى (بلازور: DeliveredLate)
    product.DeliveredLate = Boolean(
      lastDeliveryDate && header.DueDate
      && dates.dateOnly(lastDeliveryDate) > dates.dateOnly(header.DueDate),
    );
  }

  const totalRemaining = totalInvoiced - totalDelivered - totalSettled;
  const hasEvents = (state?.eventCount || 0) > 0;
  let progressStatus = 'pending';
  if (String(header.DeliveredNotes || '').startsWith('مرتجع:')) progressStatus = 'returned';
  else if (hasEvents && totalRemaining <= QTY_EPSILON) progressStatus = 'delivered';
  else if (hasEvents) progressStatus = 'partial';

  return {
    ...header,
    Products: products,
    Progress: {
      TotalInvoicedQty: round3(totalInvoiced),
      TotalDeliveredQty: round3(totalDelivered),
      TotalInLoopQty: round3(totalInLoop),
      TotalSettledQty: round3(totalSettled),
      TotalRemainingQty: round3(totalRemaining),
      TotalAwaitingQty: round3(totalRemaining - totalInLoop),
      EventCount: state?.eventCount || 0,
      HasEvents: hasEvents,
      IsPartiallyDelivered: hasEvents && totalRemaining > QTY_EPSILON,
      Status: progressStatus,
    },
    Events: eventsData.Events,
    Maintenance: eventsData.Maintenance,
    Charges: eventsData.Charges,
  };
}

async function getDeliveryEmployees() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT EmployeeID, FullName, MobilePhone, JobTitle
    FROM Employees
    WHERE Status IN (N'نشط', N'Working', N'Active')
    ORDER BY FullName
  `);
  return result.recordset;
}

async function latestPermissionAction(transaction, id) {
  const result = await transaction.request()
    .input('key', sql.NVarChar(200), String(id))
    .query(`
      SELECT TOP 1 AuditID, ActionType, LoginName, ActionDate
      FROM [dbo].[Audit_Log] WITH (UPDLOCK, HOLDLOCK)
      WHERE TableName = N'Transactions' AND PrimaryKeyValue = @key
        AND ActionType IN (N'${ACTION_PERMISSION_REQUEST}', N'${ACTION_PERMISSION_GRANTED}')
      ORDER BY AuditID DESC
    `);
  return result.recordset[0] || null;
}

async function insertAudit(transaction, {
  id,
  action,
  username,
  oldData = null,
  newData = null,
}) {
  await transaction.request()
    .input('key', sql.NVarChar(200), String(id))
    .input('action', sql.NVarChar(100), action)
    .input('username', sql.NVarChar(100), username)
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (N'Transactions', @action, @key, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function resolveDeliveryEmployee(transaction, auth, requestedId, requestedName) {
  let employeeId = requestedId == null ? auth?.employeeId : assertId(requestedId, 'معرّف مندوب التسليم');
  let employeeName = String(requestedName || '').trim() || null;

  if (employeeId) {
    const result = await transaction.request()
      .input('employeeId', sql.Int, employeeId)
      .query(`SELECT FullName FROM Employees WHERE EmployeeID = @employeeId`);
    if (!result.recordset[0]) {
      throw Object.assign(new Error('مندوب التسليم غير موجود'), { statusCode: 400 });
    }
    employeeName = result.recordset[0].FullName;
  } else if (employeeName) {
    const result = await transaction.request()
      .input('name', sql.NVarChar(200), employeeName)
      .query(`SELECT TOP 1 EmployeeID, FullName FROM Employees WHERE FullName = @name`);
    employeeId = result.recordset[0]?.EmployeeID || null;
    employeeName = result.recordset[0]?.FullName || employeeName;
  }

  return { employeeId: employeeId || null, employeeName };
}

// تأكيد تسليم الفاتورة كاملة (المسار القائم): لم يعد يكتب IsDelivered
// مباشرة — يبني دفعة اكتمال بكل الكميات المتاحة مقبولة ويمر بمحرك
// الأحداث، فتصبح IsDelivered/DeliveredAt إسقاطًا من الأحداث وحده.
async function markAsDelivered(value, data, auth, { canOverrideRemaining = false } = {}) {
  void canOverrideRemaining; // البوابة تقرأ الصلاحية من auth عبر السياسة الموحدة
  const result = await recordDeliveryEvent(value, data, auth, { completeAll: true });
  return {
    TransactionID: result.TransactionID,
    ReferenceNumber: result.ReferenceNumber,
    PartyID: result.PartyID,
    PartyName: result.PartyName,
    RemainingAmount: result.RemainingAmount,
    DeliveryEmployeeId: result.DeliveryEmployeeId,
    DeliveryEmployeeName: result.DeliveryEmployeeName,
    DeliveryId: result.DeliveryId,
    CompletedInvoice: result.CompletedInvoice,
    courierUsername: result.courierUsername,
  };
}

// تعديل بيانات التسليم اليدوي — مرآة UpdateDeliveryStatusAsync الحالية
// في بلازور: «تم التسليم» مرفوضة من هذا المسار (التسليم أحداث بكميات
// البنود)، ويُعدَّل المندوب والملاحظات فقط — IsDelivered/DeliveredAt
// إسقاط أحداث لا يمسّه هذا المسار أبدًا.
async function updateDeliveryDetails(
  value,
  data,
  auth,
  { canOverrideRemaining = false } = {},
) {
  void canOverrideRemaining;
  const id = assertId(value, 'معرّف الفاتورة');
  const status = String(data.status || 'pending').toLowerCase();
  if (status === 'delivered') {
    throw Object.assign(
      new Error('تسجيل التسليم أصبح يتم من إجراء «تسليم» بكميات البنود (التسليم على دفعات) — برجاء استخدام تسجيل تسليمة.'),
      { statusCode: 400 },
    );
  }

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT TransactionID, TransactionType, InvoiceStatus, IsDelivered,
               DeliveredAt, DeliveredNotes, DeliveryEmployeeId, DeliveryEmployeeName
        FROM Transactions WITH (UPDLOCK, HOLDLOCK)
        WHERE TransactionID = @id
      `);
    const current = currentResult.recordset[0];
    if (!current || current.TransactionType !== 'Sale') {
      throw Object.assign(new Error('فاتورة البيع غير موجودة'), { statusCode: 404 });
    }
    if (current.InvoiceStatus === 'Cancelled') {
      throw Object.assign(new Error('لا يمكن تعديل تسليم فاتورة ملغية'), { statusCode: 409 });
    }

    const employee = await resolveDeliveryEmployee(
      transaction,
      auth,
      data.deliveryEmployeeId,
      data.deliveryEmployeeName,
    );
    // بقاء اسم المندوب نفسه مع معرّف مختلف يُبقي المعرّف الحالي
    // (قاعدة بلازور لمنع فقدان ربط المندوب عند إعادة الحفظ بالاسم)
    let employeeId = employee.employeeId;
    if (employee.employeeName && current.DeliveryEmployeeName
      && employee.employeeName.trim() === String(current.DeliveryEmployeeName).trim()
      && current.DeliveryEmployeeId) {
      employeeId = current.DeliveryEmployeeId;
    }

    const rawNotes = String(data.notes || data.deliveredNotes || '').trim();
    const notes = status === 'returned'
      ? `مرتجع: ${rawNotes || 'تم تسجيل الفاتورة كمرتجع'}`
      : (rawNotes || null);

    await transaction.request()
      .input('id', sql.Int, id)
      .input('employeeId', sql.Int, employeeId)
      .input('employeeName', sql.NVarChar(200), employee.employeeName)
      .input('notes', sql.NVarChar(1000), notes)
      .query(`
        UPDATE Transactions
        SET DeliveredNotes = @notes,
            DeliveryEmployeeId = COALESCE(@employeeId, DeliveryEmployeeId),
            DeliveryEmployeeName = COALESCE(@employeeName, DeliveryEmployeeName)
        WHERE TransactionID = @id
      `);
    await insertAudit(transaction, {
      id,
      action: 'UpdateDeliveryStatus',
      username: auth.username,
      oldData: current,
      newData: {
        RequestedStatus: status,
        DeliveryEmployeeId: employeeId,
        DeliveryEmployeeName: employee.employeeName,
        DeliveredNotes: notes,
      },
    });
    await transaction.commit();
    return {
      TransactionID: id,
      status,
      IsDelivered: Boolean(current.IsDelivered),
      DeliveredAt: current.DeliveredAt,
      DeliveryEmployeeId: employeeId,
      DeliveryEmployeeName: employee.employeeName,
      DeliveredNotes: notes,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function requestDeliveryPermission(value, auth) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT t.TransactionID, t.ReferenceNumber, t.TransactionType,
               t.InvoiceStatus, t.IsDelivered, t.GrandTotal, t.PaidAmount,
               p.PartyName
        FROM Transactions t WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN Parties p ON t.PartyID = p.PartyID
        WHERE t.TransactionID = @id
      `);
    const row = result.recordset[0];
    if (!row || row.TransactionType !== 'Sale') {
      throw Object.assign(new Error('فاتورة البيع غير موجودة'), { statusCode: 404 });
    }
    if (row.InvoiceStatus === 'Cancelled') throw Object.assign(new Error('الفاتورة ملغية'), { statusCode: 409 });
    if (row.IsDelivered === true || row.IsDelivered === 1) throw Object.assign(new Error('الفاتورة مسلّمة بالفعل'), { statusCode: 409 });
    const remaining = Number(row.GrandTotal || 0) - Number(row.PaidAmount || 0);
    if (remaining <= 0.005) throw Object.assign(new Error('لا يوجد مبلغ متبقٍ ويمكن التسليم مباشرة'), { statusCode: 409 });

    const latest = await latestPermissionAction(transaction, id);
    if (latest?.ActionType === ACTION_PERMISSION_REQUEST) {
      throw Object.assign(new Error('يوجد طلب إذن تسليم معلّق بالفعل'), { statusCode: 409 });
    }
    await insertAudit(transaction, {
      id,
      action: ACTION_PERMISSION_REQUEST,
      username: auth.username,
      newData: { RemainingAmount: remaining, RequestedBy: auth.username },
    });
    await transaction.commit();
    return { ...row, RemainingAmount: remaining };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function grantDeliveryPermission(value, auth) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT t.TransactionID, t.ReferenceNumber, t.TransactionType,
               t.InvoiceStatus, t.IsDelivered, t.GrandTotal, t.PaidAmount,
               p.PartyName
        FROM Transactions t WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN Parties p ON t.PartyID = p.PartyID
        WHERE t.TransactionID = @id
      `);
    const row = result.recordset[0];
    if (!row || row.TransactionType !== 'Sale') throw Object.assign(new Error('فاتورة البيع غير موجودة'), { statusCode: 404 });
    if (row.InvoiceStatus === 'Cancelled') throw Object.assign(new Error('الفاتورة ملغية'), { statusCode: 409 });
    if (row.IsDelivered === true || row.IsDelivered === 1) throw Object.assign(new Error('الفاتورة مسلّمة بالفعل'), { statusCode: 409 });
    const remaining = Number(row.GrandTotal || 0) - Number(row.PaidAmount || 0);
    if (remaining <= 0.005) throw Object.assign(new Error('لا يوجد مبلغ متبقٍ ولا تحتاج الفاتورة لإذن'), { statusCode: 409 });

    const latest = await latestPermissionAction(transaction, id);
    await insertAudit(transaction, {
      id,
      action: ACTION_PERMISSION_GRANTED,
      username: auth.username,
      oldData: latest,
      newData: { RemainingAmount: remaining, GrantedBy: auth.username },
    });
    await transaction.commit();
    return { ...row, RemainingAmount: remaining, RequestedBy: latest?.LoginName || null };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function getDailySheetLegacy(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, { ...filters, status: 'pending' });
  const result = await request.query(`
    SELECT TOP 500 t.TransactionID, t.ReferenceNumber, p.PartyName,
           p.Phone, p.Address, t.TransactionDate, t.DueDate,
           DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) AS DaysRemaining,
           ${buildDeliveryStatusSql('t')} AS DeliveryStatus,
           COALESCE(e.FullName, t.DeliveryEmployeeName) AS DeliveryEmployeeName
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN Employees e ON t.DeliveryEmployeeId = e.EmployeeID
    WHERE ${where}
    ORDER BY t.DueDate, t.TransactionID
  `);
  return result.recordset;
}

// Item 10 (Pkg2) — line-based daily sheet, mirror of Blazor
// SalesDeliveryStatusService.GetDailyDeliverySheetByLinesAsync
// (Services/SalesDeliveryStatusService.cs:2380): one row per
// (invoice x appointment); "due lines" = lines whose EFFECTIVE date
// (DeliveryScheduleResolver.EffectiveDate) is that day and not complete.
// filters.dateFrom/dateTo arrive ALREADY shifted to real dates by the
// controller (ShiftDueDateRange mirror), exactly as Blazor shifts the
// range inside the service before filtering on real effective dates.
async function getDailySheet(filters = {}, auth = null) {
  try {
    return await getDailySheetByLines(filters, auth);
  } catch (error) {
    if (isMissingTableError(error) || (error && (error.number === 207 || /Invalid column name/i.test(String(error.message || ''))))) {
      return getDailySheetLegacy(filters);
    }
    throw error;
  }
}

async function getDailySheetByLines(filters = {}, auth = null) {
  const pool = await connectDB();
  const seesReal = auth ? dates.canSeeRealDate(auth) : true;
  const buffer = dates.dateBufferDays();
  const candRequest = pool.request();
  let searchClause = '';
  if (filters.search && String(filters.search).trim()) {
    candRequest.input('sheetSearch', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    searchClause = `AND (p.PartyName LIKE @sheetSearch OR p.Phone LIKE @sheetSearch OR t.ReferenceNumber LIKE @sheetSearch)`;
  }
  const candResult = await candRequest.query(`
    SELECT TOP 500 t.TransactionID, t.ReferenceNumber, t.TransactionDate, t.DueDate,
           t.DeliveredNotes, p.PartyName, p.Phone, p.Address,
           COALESCE(e.FullName, t.DeliveryEmployeeName) AS DeliveryEmployeeName
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN Employees e ON t.DeliveryEmployeeId = e.EmployeeID
    WHERE t.TransactionType = 'Sale'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND ISNULL(t.IsDelivered, 0) = 0
      ${searchClause}
    ORDER BY t.TransactionID
  `);
  const candidates = candResult.recordset;
  if (!candidates.length) return [];
  const ids = candidates.map((c) => Number(c.TransactionID));
  const candById = new Map(candidates.map((c) => [Number(c.TransactionID), c]));

  const linesRequest = pool.request();
  const linesIn = bindIdList(linesRequest, 'shl', ids);
  const linesResult = await linesRequest.query(`
    SELECT td.TransactionID, td.DetailID, td.Quantity, td.DeliveryDate, td.DeliveryDateIsCustom,
           pr.ProductName
    FROM TransactionDetails td
    LEFT JOIN Products pr ON pr.ProductID = td.ProductID
    WHERE td.TransactionID IN ${linesIn}
    ORDER BY td.DetailID
  `);

  const acceptedByDetail = new Map();
  const settledByDetail = new Map();
  try {
    const accRequest = pool.request();
    const accIn = bindIdList(accRequest, 'sha', ids);
    const accResult = await accRequest.query(`
      SELECT idl.TransactionId, idi.TransactionDetailId, COALESCE(SUM(idi.AcceptedQty), 0) AS AcceptedQty
      FROM InvoiceDeliveryItems idi
      JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.IsVoided = 0 AND idl.TransactionId IN ${accIn}
      GROUP BY idl.TransactionId, idi.TransactionDetailId
    `);
    for (const row of accResult.recordset) acceptedByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.AcceptedQty));
    const setRequest = pool.request();
    const setIn = bindIdList(setRequest, 'shm', ids);
    const setResult = await setRequest.query(`
      SELECT TransactionId, TransactionDetailId, COALESCE(SUM(Quantity), 0) AS SettledQty
      FROM DeliveryMaintenanceItems
      WHERE IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}' AND TransactionId IN ${setIn}
      GROUP BY TransactionId, TransactionDetailId
    `);
    for (const row of setResult.recordset) settledByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.SettledQty));
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  const fromD = filters.dateFrom ? dates.dateOnly(filters.dateFrom) : null;
  const toD = filters.dateTo ? dates.dateOnly(filters.dateTo) : null;
  const groups = new Map();
  for (const line of linesResult.recordset) {
    const txId = Number(line.TransactionID);
    const cand = candById.get(txId);
    if (!cand) continue;
    const accepted = acceptedByDetail.get(`${txId}:${line.DetailID}`) || 0;
    const settled = settledByDetail.get(`${txId}:${line.DetailID}`) || 0;
    const remaining = num(line.Quantity) - accepted - settled;
    if (remaining <= QTY_EPSILON) continue;
    const isCustom = Boolean(line.DeliveryDateIsCustom) && Boolean(line.DeliveryDate);
    const effective = dates.effectiveLineDate(line.DeliveryDate, isCustom, cand.DueDate);
    if (!effective) continue;
    if (fromD && effective < fromD) continue;
    if (toD && effective > toD) continue;
    const key = `${txId}:${effective.toISOString().slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, { cand, realDate: effective, lines: [], remaining: 0, invoiced: 0, hasEvents: false });
    const g = groups.get(key);
    g.lines.push({ ProductName: line.ProductName || '', RemainingQty: round3(remaining), Quantity: num(line.Quantity) });
    g.remaining = round3(g.remaining + remaining);
    g.invoiced = round3(g.invoiced + num(line.Quantity));
    if (accepted > QTY_EPSILON) g.hasEvents = true;
  }

  const today = dates.todayOnly();
  const sheet = [];
  for (const g of groups.values()) {
    const display = dates.displayDate(g.realDate, g.cand.TransactionDate, seesReal, buffer);
    const isReturned = String(g.cand.DeliveredNotes || '').startsWith('مرتجع:');
    const overdue = !isReturned && dates.isLineOverdue(display, g.remaining);
    const status = isReturned ? 'returned' : overdue ? 'overdue' : g.hasEvents ? 'partial' : 'pending';
    sheet.push({
      TransactionID: Number(g.cand.TransactionID),
      ReferenceNumber: g.cand.ReferenceNumber,
      PartyName: g.cand.PartyName,
      Phone: g.cand.Phone,
      Address: g.cand.Address,
      TransactionDate: g.cand.TransactionDate,
      DueDate: display,
      DaysRemaining: display ? dates.diffDays(display, today) : null,
      DeliveryStatus: status,
      DeliveryEmployeeName: g.cand.DeliveryEmployeeName,
      IsPartial: g.hasEvents && !isReturned,
      TotalInvoicedQty: g.invoiced,
      TotalRemainingQty: g.remaining,
      DueLinesSummary: g.lines.map((l) => `${l.ProductName} × ${fmtQty(l.RemainingQty)}`).join('، '),
      DueLineCount: g.lines.length,
      DueLines: g.lines,
    });
  }
  sheet.sort((a, b) => {
    if (!a.DueDate) return 1;
    if (!b.DueDate) return -1;
    return (a.DueDate - b.DueDate) || (a.TransactionID - b.TransactionID);
  });
  return sheet.slice(0, 200);
}


// آخر إجراء تدقيق من أنواع محددة — تعميم لـ latestPermissionAction
// (بوابة التغطية في بلازور تبحث عن آخر منح فقط مهما تلاه من طلبات).
async function latestPermissionActionOf(transaction, id, actionTypes) {
  const request = transaction.request();
  request.input('key', sql.NVarChar(200), String(id));
  const placeholders = actionTypes.map((actionType, index) => {
    const name = `actionType${index}`;
    request.input(name, sql.NVarChar(100), actionType);
    return `@${name}`;
  });
  const result = await request.query(`
    SELECT TOP 1 AuditID, ActionType, LoginName, ActionDate
    FROM [dbo].[Audit_Log] WITH (UPDLOCK, HOLDLOCK)
    WHERE TableName = N'Transactions' AND PrimaryKeyValue = @key
      AND ActionType IN (${placeholders.join(', ')})
    ORDER BY AuditID DESC
  `);
  return result.recordset[0] || null;
}

// ════════════════════════════════════════════════════════════════════
// محرك أحداث التسليم — مرآة SalesDeliveryStatusService.RecordDeliveryAsync
// و DeliveryProjection.RecomputeAsync في بلازور: الأحداث في
// InvoiceDeliveries/InvoiceDeliveryItems هي مصدر الحقيقة الوحيد، و
// IsDelivered/DeliveredAt إسقاط اكتمال صارم يُعاد حسابه ولا يُكتب مباشرة.
// ════════════════════════════════════════════════════════════════════

// يلحق بصفوف القائمة: DeliveryProgress (كميات الأحداث) و Schedule
// (مجموعات مواعيد البنود بالتواريخ المعروضة لهذا المستخدم) — مرآة
// GetDeliveryProgressBatchAsync + GetLineScheduleSummariesBatchAsync.
// غياب جداول الأحداث → تقدم صفري بلا انهيار، كما في بلازور.
async function attachProgressAndSchedules(pool, rows, auth) {
  if (!rows.length) return;
  const ids = rows.map((r) => Number(r.TransactionID));

  const progressByTx = new Map();
  try {
    const progressRequest = pool.request();
    const inList = bindIdList(progressRequest, 'pid', ids);
    const progressResult = await progressRequest.query(`
      SELECT idl.TransactionId,
             COUNT(DISTINCT idl.DeliveryId) AS EventCount,
             MAX(idl.DeliveryDate) AS LastEventDate,
             COALESCE(SUM(idi.AcceptedQty), 0) AS TotalAccepted
      FROM InvoiceDeliveries idl
      LEFT JOIN InvoiceDeliveryItems idi ON idi.DeliveryId = idl.DeliveryId
      WHERE idl.IsVoided = 0 AND idl.TransactionId IN ${inList}
      GROUP BY idl.TransactionId
    `);
    for (const row of progressResult.recordset) {
      progressByTx.set(Number(row.TransactionId), row);
    }

    const settledRequest = pool.request();
    const settledIn = bindIdList(settledRequest, 'sid', ids);
    const settledResult = await settledRequest.query(`
      SELECT TransactionId, COALESCE(SUM(Quantity), 0) AS TotalSettled
      FROM DeliveryMaintenanceItems
      WHERE IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}' AND TransactionId IN ${settledIn}
      GROUP BY TransactionId
    `);
    for (const row of settledResult.recordset) {
      const entry = progressByTx.get(Number(row.TransactionId)) || {};
      entry.TotalSettled = row.TotalSettled;
      progressByTx.set(Number(row.TransactionId), entry);
    }

    const inLoopRequest = pool.request();
    const inLoopIn = bindIdList(inLoopRequest, 'lid', ids);
    const inLoopResult = await inLoopRequest.query(`
      SELECT TransactionId, COALESCE(SUM(Quantity), 0) AS TotalInLoop
      FROM DeliveryMaintenanceItems
      WHERE IsVoided = 0 AND Status IN (${MAINTENANCE_IN_LOOP.map((s) => `N'${s}'`).join(', ')})
        AND TransactionId IN ${inLoopIn}
      GROUP BY TransactionId
    `);
    for (const row of inLoopResult.recordset) {
      const entry = progressByTx.get(Number(row.TransactionId)) || {};
      entry.TotalInLoop = row.TotalInLoop;
      progressByTx.set(Number(row.TransactionId), entry);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  const linesRequest = pool.request();
  const linesIn = bindIdList(linesRequest, 'tid', ids);
  const linesResult = await linesRequest.query(`
    SELECT td.TransactionID, td.DetailID, td.Quantity,
           td.DeliveryDate, td.DeliveryDateIsCustom
    FROM TransactionDetails td
    WHERE td.TransactionID IN ${linesIn}
    ORDER BY td.DetailID
  `);
  const acceptedByDetail = new Map();
  const settledByDetail = new Map();
  try {
    const accRequest = pool.request();
    const accIn = bindIdList(accRequest, 'aid', ids);
    const accResult = await accRequest.query(`
      SELECT idl.TransactionId, idi.TransactionDetailId,
             COALESCE(SUM(idi.AcceptedQty), 0) AS AcceptedQty
      FROM InvoiceDeliveryItems idi
      JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.IsVoided = 0 AND idl.TransactionId IN ${accIn}
      GROUP BY idl.TransactionId, idi.TransactionDetailId
    `);
    for (const row of accResult.recordset) {
      acceptedByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.AcceptedQty));
    }
    const setRequest = pool.request();
    const setIn = bindIdList(setRequest, 'mid', ids);
    const setResult = await setRequest.query(`
      SELECT TransactionId, TransactionDetailId, COALESCE(SUM(Quantity), 0) AS SettledQty
      FROM DeliveryMaintenanceItems
      WHERE IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}' AND TransactionId IN ${setIn}
      GROUP BY TransactionId, TransactionDetailId
    `);
    for (const row of setResult.recordset) {
      settledByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.SettledQty));
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  const seesReal = auth ? dates.canSeeRealDate(auth) : true;
  const linesByTx = new Map();
  for (const line of linesResult.recordset) {
    const key = Number(line.TransactionID);
    if (!linesByTx.has(key)) linesByTx.set(key, []);
    linesByTx.get(key).push(line);
  }

  for (const row of rows) {
    const txId = Number(row.TransactionID);
    const lines = linesByTx.get(txId) || [];
    const totalInvoiced = lines.reduce((sum, l) => sum + num(l.Quantity), 0);
    const progress = progressByTx.get(txId) || {};
    const totalAccepted = num(progress.TotalAccepted);
    const totalSettled = num(progress.TotalSettled);
    const totalInLoop = num(progress.TotalInLoop);
    const totalRemaining = round3(totalInvoiced - totalAccepted - totalSettled);
    row.DeliveryProgress = {
      HasEvents: num(progress.EventCount) > 0,
      EventCount: num(progress.EventCount),
      TotalInvoicedQty: round3(totalInvoiced),
      TotalDeliveredQty: round3(totalAccepted),
      TotalInLoopQty: round3(totalInLoop),
      TotalSettledQty: round3(totalSettled),
      TotalRemainingQty: totalRemaining,
      IsPartiallyDelivered: num(progress.EventCount) > 0 && totalRemaining > QTY_EPSILON,
      LastEventDate: progress.LastEventDate || null,
    };

    const groups = new Map();
    let hasCustom = false;
    for (const line of lines) {
      const isCustom = Boolean(line.DeliveryDateIsCustom) && Boolean(line.DeliveryDate);
      if (isCustom) hasCustom = true;
      const effective = dates.effectiveLineDate(line.DeliveryDate, isCustom, row.DueDate);
      const shown = dates.displayDate(effective, row.TransactionDate, seesReal);
      const key = shown ? shown.toISOString().slice(0, 10) : 'null';
      if (!groups.has(key)) {
        groups.set(key, {
          DisplayDate: shown, LineCount: 0, PendingLineCount: 0, PendingQty: 0, HasOverdue: false,
        });
      }
      const group = groups.get(key);
      group.LineCount += 1;
      const accepted = acceptedByDetail.get(`${txId}:${line.DetailID}`) || 0;
      const settled = settledByDetail.get(`${txId}:${line.DetailID}`) || 0;
      const remaining = num(line.Quantity) - accepted - settled;
      if (remaining > QTY_EPSILON) {
        group.PendingLineCount += 1;
        group.PendingQty = round3(group.PendingQty + remaining);
        if (dates.isLineOverdue(shown, remaining)) group.HasOverdue = true;
      }
    }
    row.Schedule = {
      HasCustomDates: hasCustom,
      Groups: [...groups.values()].sort((a, b) => {
        if (!a.DisplayDate) return 1;
        if (!b.DisplayDate) return -1;
        return a.DisplayDate - b.DisplayDate;
      }),
    };
  }
}

// يحمّل بنود الفاتورة + المقبول/المسوّى/داخل الحلقة لكل بند + سجلات الصيانة
async function loadDeliveryState(requestFactory, transactionId) {
  const detailsResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT td.DetailID, td.ProductID, p.ProductName,
             td.Quantity AS InvoicedQty, td.UnitPrice, td.TotalAmount,
             td.DeliveryDate, td.DeliveryDateIsCustom
      FROM TransactionDetails td
      LEFT JOIN Products p ON p.ProductID = td.ProductID
      WHERE td.TransactionID = @txId
      ORDER BY td.DetailID
    `);
  const details = detailsResult.recordset;

  const acceptedResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT idi.TransactionDetailId, COALESCE(SUM(idi.AcceptedQty), 0) AS AcceptedQty
      FROM InvoiceDeliveryItems idi
      JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.TransactionId = @txId AND idl.IsVoided = 0
      GROUP BY idi.TransactionDetailId
    `);
  const acceptedByDetail = new Map(
    acceptedResult.recordset.map((r) => [Number(r.TransactionDetailId), num(r.AcceptedQty)]),
  );

  const maintenanceResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT MaintenanceId, DeliveryItemId, DeliveryId, TransactionDetailId,
             Quantity, Status, ReasonClass, IssueDescription, Billable
      FROM DeliveryMaintenanceItems
      WHERE TransactionId = @txId AND IsVoided = 0
    `);
  const settledByDetail = new Map();
  const inLoopByDetail = new Map();
  const maintenanceById = new Map();
  for (const record of maintenanceResult.recordset) {
    maintenanceById.set(Number(record.MaintenanceId), record);
    const detailId = Number(record.TransactionDetailId);
    if (record.Status === MAINTENANCE_SETTLED) {
      settledByDetail.set(detailId, (settledByDetail.get(detailId) || 0) + num(record.Quantity));
    } else if (MAINTENANCE_IN_LOOP.includes(record.Status)) {
      inLoopByDetail.set(detailId, (inLoopByDetail.get(detailId) || 0) + num(record.Quantity));
    }
  }

  const lastDateResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT idi.TransactionDetailId, MAX(idl.DeliveryDate) AS LastDeliveryDate
      FROM InvoiceDeliveryItems idi
      JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.TransactionId = @txId AND idl.IsVoided = 0
      GROUP BY idi.TransactionDetailId
    `);
  const lastDateByDetail = new Map(
    lastDateResult.recordset.map((r) => [Number(r.TransactionDetailId), r.LastDeliveryDate]),
  );

  const eventCountResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT COUNT(*) AS EventCount FROM InvoiceDeliveries
      WHERE TransactionId = @txId AND IsVoided = 0
    `);

  return {
    details,
    acceptedByDetail,
    settledByDetail,
    inLoopByDetail,
    maintenanceById,
    lastDateByDetail,
    eventCount: num(eventCountResult.recordset[0]?.EventCount),
  };
}

// DeliveryProjection.RecomputeAsync: يعيد حساب IsDelivered/DeliveredAt
// ولقطة المندوب من الأحداث غير الملغاة. الاكتمال = حدث واحد على الأقل ولا
// كمية مفتوحة (مفوترة − مقبولة − مسوّاة بائتمان ≤ 0.0005)، وختم الاكتمال =
// تاريخ الحدث المُكمل (آخر دفعة)، فإن اكتملت بالتسوية وحدها فآخر إغلاق ائتماني.
async function recomputeDeliveryProjection(requestFactory, transactionId) {
  const invoicedResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`SELECT COALESCE(SUM(Quantity), 0) AS Total FROM TransactionDetails WHERE TransactionID = @txId`);
  const totalInvoiced = num(invoicedResult.recordset[0]?.Total);

  const acceptedResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT COALESCE(SUM(idi.AcceptedQty), 0) AS Total
      FROM InvoiceDeliveryItems idi
      JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.TransactionId = @txId AND idl.IsVoided = 0
    `);
  const totalAccepted = num(acceptedResult.recordset[0]?.Total);

  const settledResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT COALESCE(SUM(Quantity), 0) AS Total FROM DeliveryMaintenanceItems
      WHERE TransactionId = @txId AND IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}'
    `);
  const totalSettled = num(settledResult.recordset[0]?.Total);

  const eventsResult = await requestFactory()
    .input('txId', sql.Int, transactionId)
    .query(`
      SELECT DeliveryId, DeliveryDate, DeliveryEmployeeId, DeliveryEmployeeName, CompletedInvoice
      FROM InvoiceDeliveries
      WHERE TransactionId = @txId AND IsVoided = 0
      ORDER BY DeliveryDate, DeliveryId
    `);
  const events = eventsResult.recordset;

  const openQty = totalInvoiced - totalAccepted - totalSettled;
  const completed = events.length > 0 && openQty <= QTY_EPSILON;

  let deliveredAt = null;
  if (completed) {
    const completing = [...events].reverse().find((e) => Boolean(e.CompletedInvoice));
    if (completing) {
      deliveredAt = completing.DeliveryDate;
    } else {
      const settleResult = await requestFactory()
        .input('txId', sql.Int, transactionId)
        .query(`
          SELECT MAX(ClosedAt) AS LastSettle FROM DeliveryMaintenanceItems
          WHERE TransactionId = @txId AND IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}'
            AND ClosedAt IS NOT NULL
        `);
      deliveredAt = settleResult.recordset[0]?.LastSettle
        || events[events.length - 1]?.DeliveryDate
        || null;
    }
  }

  const lastEvent = events[events.length - 1];
  const updateRequest = requestFactory()
    .input('txId', sql.Int, transactionId)
    .input('isDelivered', sql.Bit, completed ? 1 : 0)
    .input('deliveredAt', sql.DateTime2, deliveredAt ? new Date(deliveredAt) : null);
  let courierClause = '';
  if (lastEvent) {
    updateRequest
      .input('empId', sql.Int, lastEvent.DeliveryEmployeeId ?? null)
      .input('empName', sql.NVarChar(150), lastEvent.DeliveryEmployeeName ?? null);
    courierClause = ', DeliveryEmployeeId = @empId, DeliveryEmployeeName = @empName';
  }
  await updateRequest.query(`
    UPDATE Transactions
    SET IsDelivered = @isDelivered, DeliveredAt = @deliveredAt${courierClause}
    WHERE TransactionID = @txId
  `);

  return {
    totalInvoiced: round3(totalInvoiced),
    totalAccepted: round3(totalAccepted),
    totalSettled: round3(totalSettled),
    openQty: round3(openQty),
    completed,
    deliveredAt,
  };
}

function lineUnitValue(detail) {
  const qty = num(detail.InvoicedQty);
  if (qty <= 0) return 0;
  const total = detail.TotalAmount != null ? num(detail.TotalAmount) : qty * num(detail.UnitPrice);
  return total / qty;
}

// رسالة رفض بوابة التغطية: بالأرقام لمن يرى المبالغ، وبالحالة فقط لمن لا
// يراها (قاعدة المالك: المندوب لا يرى أي رقم في أي مكان).
function coverageRejectionMessage(auth, values) {
  if (!policy.delivery.canSeeAmounts(auth)) {
    return 'المدفوع لا يغطي قيمة هذه الدفعة — برجاء سداد الفرق أو إرسال طلب إذن تسليم من زر «طلب إذن».';
  }
  return `لا يمكن تسليم هذه الدفعة: المدفوع (${fmtMoney(values.paidAmount)} ج) لا يغطي قيمة المسلَّم سابقًا (${fmtMoney(values.previousValue)} ج) + قيمة هذه الدفعة (${fmtMoney(values.batchValue)} ج). برجاء سداد الفرق أو إرسال طلب إذن تسليم.`;
}

// CheckBatchCoverageGateAsync في بلازور: مسددة بالكامل تمر دائمًا، وإلا
// المدفوع + 0.01 ≥ قيمة المقبول سابقًا + قيمة هذه الدفعة، وإلا موافقة
// ضمنية لمن له تجاوز المتبقي أو إذن ممنوح سابق في سجل التدقيق.
async function checkBatchCoverageGate(transaction, invoice, detailsById, acceptedByDetail, batchItems, auth) {
  const remaining = num(invoice.GrandTotal) - num(invoice.PaidAmount);
  if (remaining <= 0) return { passed: true, approvalNote: null };

  let previousValue = 0;
  let batchValue = 0;
  for (const detail of detailsById.values()) {
    previousValue += (acceptedByDetail.get(Number(detail.DetailID)) || 0) * lineUnitValue(detail);
  }
  for (const item of batchItems) {
    const detail = detailsById.get(item.transactionDetailId);
    if (detail) batchValue += item.acceptedQty * lineUnitValue(detail);
  }

  if (num(invoice.PaidAmount) + MONEY_EPSILON >= previousValue + batchValue) {
    return { passed: true, approvalNote: null };
  }

  if (policy.delivery.canOverrideRemaining(auth)) {
    return {
      passed: true,
      approvalNote: `تم التسليم بموافقة ${auth.username} رغم أن المدفوع لا يغطي قيمة الدفعة`,
    };
  }

  const grant = await latestPermissionActionOf(transaction, invoice.TransactionID, [ACTION_PERMISSION_GRANTED]);
  if (grant) {
    return {
      passed: true,
      approvalNote: `تم التسليم بناءً على إذن مسبق من ${grant.LoginName} بتاريخ ${new Date(grant.ActionDate).toISOString().slice(0, 10)}`,
    };
  }

  throw Object.assign(new Error(coverageRejectionMessage(auth, {
    paidAmount: invoice.PaidAmount, previousValue, batchValue,
  })), { statusCode: 409, code: 'DELIVERY_PERMISSION_REQUIRED' });
}

// معاينة بوابة التغطية لدفعة مقترحة — مرآة GetBatchCoverageAsync:
// الأرقام تُحجب عمن لا يرى المبالغ وتبقى الحالة (يغطي/لا يغطي) فقط.
async function getBatchCoverage(value, rawItems, auth) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();

  const invoiceResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT TransactionID, TransactionType, InvoiceStatus, IsDelivered, GrandTotal, PaidAmount
      FROM Transactions WHERE TransactionID = @id
    `);
  const invoice = invoiceResult.recordset[0];
  if (!invoice) throw Object.assign(new Error('الفاتورة غير موجودة.'), { statusCode: 404 });

  const state = await loadDeliveryState(() => pool.request(), id);
  const detailsById = new Map(state.details.map((d) => [Number(d.DetailID), d]));

  const batchItems = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const detailId = Number(raw.transactionDetailId ?? raw.TransactionDetailId ?? raw.detailId ?? raw.DetailID);
    const quantity = num(raw.quantity ?? raw.Quantity);
    if (!detailsById.has(detailId) || quantity <= 0) continue;
    const returnedTotal = num(raw.returnedManufacturingQty) + num(raw.returnedHandlingQty)
      + num(raw.returnedModificationQty);
    const acceptedQty = raw.acceptedQty != null || raw.AcceptedQty != null
      ? num(raw.acceptedQty ?? raw.AcceptedQty)
      : (returnedTotal <= QTY_EPSILON ? quantity : 0);
    batchItems.push({ transactionDetailId: detailId, acceptedQty });
  }

  let previousValue = 0;
  let batchValue = 0;
  for (const detail of state.details) {
    previousValue += (state.acceptedByDetail.get(Number(detail.DetailID)) || 0) * lineUnitValue(detail);
  }
  for (const item of batchItems) {
    batchValue += item.acceptedQty * lineUnitValue(detailsById.get(item.transactionDetailId));
  }

  const paidAmount = num(invoice.PaidAmount);
  const remainingAmount = num(invoice.GrandTotal) - paidAmount;
  const totalRequired = previousValue + batchValue;
  const covered = remainingAmount <= 0 || paidAmount + MONEY_EPSILON >= totalRequired;
  const canSeeAmounts = policy.delivery.canSeeAmounts(auth);

  return {
    TransactionID: id,
    Covered: covered,
    RequiresPermission: !covered,
    PaidAmount: canSeeAmounts ? paidAmount : null,
    RemainingAmount: canSeeAmounts ? remainingAmount : null,
    PreviousDeliveredValue: canSeeAmounts ? Math.round(previousValue * 100) / 100 : null,
    ThisBatchValue: canSeeAmounts ? Math.round(batchValue * 100) / 100 : null,
    TotalRequired: canSeeAmounts ? Math.round(totalRequired * 100) / 100 : null,
    Message: covered
      ? 'المدفوع يغطي قيمة هذه الدفعة — يمكن التسليم دون إذن إضافي.'
      : coverageRejectionMessage(auth, { paidAmount, previousValue, batchValue }),
  };
}

// أحداث الفاتورة وبنودها وسجلات الصيانة ورسوم التعديل المولودة منها —
// تواريخ الأحداث حقائق فعلية تُعاد كما هي دون أي إخفاء.
async function getDeliveryEvents(value) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  try {
    const eventsResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT DeliveryId, TransactionId, DeliveryDate, DeliveryEmployeeId,
               DeliveryEmployeeName, Notes, RecordedBy, RecordedAt, IsVoided,
               VoidedBy, VoidedAt, VoidReason, CompletedInvoice, IsLegacy
        FROM InvoiceDeliveries
        WHERE TransactionId = @id
        ORDER BY DeliveryDate DESC, DeliveryId DESC
      `);
    const itemsResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT idi.DeliveryItemId, idi.DeliveryId, idi.TransactionDetailId,
               p.ProductName, idi.Quantity, idi.AcceptedQty,
               idi.ReturnedManufacturingQty, idi.ReturnedHandlingQty,
               idi.ReturnedModificationQty, idi.DispositionNotes, idi.MaintenanceId
        FROM InvoiceDeliveryItems idi
        JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
        LEFT JOIN TransactionDetails td ON td.DetailID = idi.TransactionDetailId
        LEFT JOIN Products p ON p.ProductID = td.ProductID
        WHERE idl.TransactionId = @id
        ORDER BY idi.DeliveryItemId
      `);
    const maintenanceResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT MaintenanceId, DeliveryItemId, DeliveryId, TransactionDetailId,
               Quantity, ReasonClass, IssueDescription, Status, Billable,
               AdditionalChargeId, IsVoided, CreatedAt, ClosedAt
        FROM DeliveryMaintenanceItems
        WHERE TransactionId = @id
        ORDER BY MaintenanceId
      `);
    const chargesResult = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT ChargeID, ChargeAmount, Status, ChargeDescription, SourceDeliveryId
        FROM AdditionalCharges
        WHERE TransactionID = @id AND SourceDeliveryId IS NOT NULL
        ORDER BY ChargeID
      `);

    const itemsByEvent = new Map();
    for (const item of itemsResult.recordset) {
      const key = Number(item.DeliveryId);
      if (!itemsByEvent.has(key)) itemsByEvent.set(key, []);
      itemsByEvent.get(key).push(item);
    }
    const events = eventsResult.recordset.map((event) => ({
      ...event,
      Items: itemsByEvent.get(Number(event.DeliveryId)) || [],
    }));
    return {
      Events: events,
      Maintenance: maintenanceResult.recordset,
      Charges: chargesResult.recordset,
    };
  } catch (error) {
    if (isMissingTableError(error)) return { Events: [], Maintenance: [], Charges: [] };
    throw error;
  }
}

// ════════════════════════════════════════════════════════════════════
// تسجيل تسليمة (حدث) — مرآة RecordDeliveryAsync كاملة: تصرفات البنود،
// بوابة تغطية الدفعة، سجلات الصيانة ورسوم التعديل المولودة، إغلاق روابط
// إعادة التسليم، ثم إعادة حساب الإسقاط — كل ذلك في معاملة SERIALIZABLE.
// ════════════════════════════════════════════════════════════════════
function normalizeRecordItem(raw = {}) {
  const pick = (...keys) => {
    for (const key of keys) if (raw[key] != null) return raw[key];
    return null;
  };
  const quantity = num(pick('quantity', 'Quantity'));
  const returnedManufacturingQty = num(pick('returnedManufacturingQty', 'ReturnedManufacturingQty'));
  const returnedHandlingQty = num(pick('returnedHandlingQty', 'ReturnedHandlingQty'));
  const returnedModificationQty = num(pick('returnedModificationQty', 'ReturnedModificationQty'));
  const returnedTotal = returnedManufacturingQty + returnedHandlingQty + returnedModificationQty;
  const acceptedRaw = pick('acceptedQty', 'AcceptedQty');
  const agreedRaw = pick('agreedModificationPrice', 'AgreedModificationPrice');
  const maintenanceRaw = pick('maintenanceId', 'MaintenanceId');
  const notesRaw = pick('dispositionNotes', 'DispositionNotes');
  return {
    transactionDetailId: intValue(pick('transactionDetailId', 'TransactionDetailId', 'detailId', 'DetailID')),
    quantity,
    acceptedQty: acceptedRaw != null ? num(acceptedRaw) : (returnedTotal <= QTY_EPSILON ? quantity : 0),
    returnedManufacturingQty,
    returnedHandlingQty,
    returnedModificationQty,
    dispositionNotes: notesRaw ? String(notesRaw).trim() || null : null,
    agreedModificationPrice: agreedRaw != null ? num(agreedRaw) : null,
    maintenanceId: maintenanceRaw ? intValue(maintenanceRaw) || null : null,
  };
}

async function recordDeliveryEvent(value, data = {}, auth, options = {}) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  const username = auth?.username || 'System';
  const completeAll = options.completeAll === true;

  // تاريخ التسليم: اليوم افتراضيًا ولا يقبل المستقبل (بلازور)
  const deliveryDateRaw = data.deliveryDate ?? data.DeliveryDate;
  const deliveryDate = deliveryDateRaw ? new Date(deliveryDateRaw) : new Date();
  if (Number.isNaN(deliveryDate.getTime())) {
    throw Object.assign(new Error('تاريخ التسليم غير صالح.'), { statusCode: 400 });
  }
  if (dates.dateOnly(deliveryDate) > dates.todayOnly()) {
    throw Object.assign(new Error('تاريخ التسليم لا يمكن أن يكون في المستقبل.'), { statusCode: 400 });
  }

  // معرّف الحدث لمنع التكرار عند إعادة الإرسال (EventGuid في بلازور)
  let eventGuid = data.eventGuid ?? data.EventGuid;
  if (!eventGuid || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(eventGuid))) {
    eventGuid = crypto.randomUUID();
  }

  let rawItems = null;
  if (!completeAll) {
    const sourceItems = data.items ?? data.Items;
    rawItems = (Array.isArray(sourceItems) ? sourceItems : [])
      .map(normalizeRecordItem)
      .filter((item) => item.quantity > 0);
    if (!rawItems.length) {
      throw Object.assign(new Error('برجاء إدخال كمية تسليم واحدة على الأقل في هذه الدفعة.'), { statusCode: 400 });
    }
    for (const item of rawItems) {
      if (item.transactionDetailId <= 0) {
        throw Object.assign(new Error('أحد بنود التسليمة غير صالح.'), { statusCode: 400 });
      }
      if (item.acceptedQty < 0 || item.returnedManufacturingQty < 0
        || item.returnedHandlingQty < 0 || item.returnedModificationQty < 0) {
        throw Object.assign(new Error('كميات التسليمة لا يمكن أن تكون سالبة.'), { statusCode: 400 });
      }
      if (item.agreedModificationPrice != null && item.agreedModificationPrice < 0) {
        throw Object.assign(new Error('سعر التعديل المتفق عليه لا يمكن أن يكون سالبًا.'), { statusCode: 400 });
      }
    }
  }

  // منع التكرار قبل المعاملة — نجاح صامت كما في بلازور
  const preExisting = await pool.request()
    .input('guid', sql.UniqueIdentifier, eventGuid)
    .query('SELECT DeliveryId, CompletedInvoice FROM InvoiceDeliveries WHERE EventGuid = @guid');
  if (preExisting.recordset[0]) {
    return {
      success: true,
      alreadyRecorded: true,
      message: 'تم تسجيل هذه التسليمة مسبقًا.',
      DeliveryId: preExisting.recordset[0].DeliveryId,
      TransactionID: id,
      CompletedInvoice: Boolean(preExisting.recordset[0].CompletedInvoice),
    };
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const factory = () => transaction.request();
  try {
    const dup = await factory()
      .input('guid', sql.UniqueIdentifier, eventGuid)
      .query('SELECT DeliveryId, CompletedInvoice FROM InvoiceDeliveries WHERE EventGuid = @guid');
    if (dup.recordset[0]) {
      await transaction.commit();
      return {
        success: true,
        alreadyRecorded: true,
        message: 'تم تسجيل هذه التسليمة مسبقًا.',
        DeliveryId: dup.recordset[0].DeliveryId,
        TransactionID: id,
        CompletedInvoice: Boolean(dup.recordset[0].CompletedInvoice),
      };
    }

    const invoiceResult = await factory()
      .input('id', sql.Int, id)
      .query(`
        SELECT t.TransactionID, t.ReferenceNumber, t.TransactionType, t.TransactionDate,
               t.DueDate, t.InvoiceStatus, t.IsDelivered, t.DeliveredNotes,
               t.PartyID, p.PartyName, t.GrandTotal, t.PaidAmount
        FROM Transactions t WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN Parties p ON t.PartyID = p.PartyID
        WHERE t.TransactionID = @id
      `);
    const invoice = invoiceResult.recordset[0];
    if (!invoice) throw Object.assign(new Error('الفاتورة غير موجودة في قاعدة البيانات.'), { statusCode: 404 });
    if (invoice.InvoiceStatus === 'Cancelled') {
      throw Object.assign(new Error('لا يمكن تسجيل تسليمة لفاتورة ملغية.'), { statusCode: 409 });
    }
    // حارس البيع فقط كما في بلازور حرفيًا
    if (invoice.TransactionType !== 'Sale') {
      throw Object.assign(new Error('تسجيل التسليمات متاح لفواتير البيع فقط.'), { statusCode: 400 });
    }
    if (String(invoice.DeliveredNotes || '').startsWith('مرتجع:')) {
      throw Object.assign(new Error('لا يمكن تسجيل تسليمة لفاتورة مرتجعة — غيّر حالتها من تعديل التسليم أولًا.'), { statusCode: 409 });
    }

    // المندوب إلزامي (معرّف أو اسم) كما في بلازور — الحل داخل المعاملة
    const employee = await resolveDeliveryEmployee(
      transaction,
      auth,
      data.deliveryEmployeeId ?? data.DeliveryEmployeeId,
      data.deliveryEmployeeName ?? data.DeliveryEmployeeName,
    );
    if (!employee.employeeId && !employee.employeeName) {
      throw Object.assign(new Error('برجاء اختيار مندوب التسليم.'), { statusCode: 400 });
    }

    const state = await loadDeliveryState(factory, id);
    const detailsById = new Map(state.details.map((d) => [Number(d.DetailID), d]));

    let items;
    if (completeAll) {
      // مسار «تأكيد التسليم» القائم: دفعة واحدة بكل المتاح مقبولًا
      items = [];
      for (const detail of state.details) {
        const detailId = Number(detail.DetailID);
        const available = num(detail.InvoicedQty)
          - (state.acceptedByDetail.get(detailId) || 0)
          - (state.settledByDetail.get(detailId) || 0)
          - (state.inLoopByDetail.get(detailId) || 0);
        if (available > QTY_EPSILON) {
          items.push({
            transactionDetailId: detailId,
            quantity: round3(available),
            acceptedQty: round3(available),
            returnedManufacturingQty: 0,
            returnedHandlingQty: 0,
            returnedModificationQty: 0,
            dispositionNotes: null,
            agreedModificationPrice: null,
            maintenanceId: null,
          });
        }
      }
      if (!items.length) {
        if (invoice.IsDelivered) {
          throw Object.assign(new Error('تم تسليم هذه الفاتورة بالفعل.'), { statusCode: 409 });
        }
        throw Object.assign(new Error('لا توجد كميات متاحة للتسليم الآن — الكميات المتبقية داخل الصيانة/المرتجعات أو مسوّاة.'), { statusCode: 409 });
      }
    } else {
      items = rawItems;
      for (const item of items) {
        const detail = detailsById.get(item.transactionDetailId);
        const name = detail?.ProductName || `صنف ${item.transactionDetailId}`;
        const returnedTotal = item.returnedManufacturingQty + item.returnedHandlingQty
          + item.returnedModificationQty;
        if (Math.abs(item.acceptedQty + returnedTotal - item.quantity) > QTY_EPSILON) {
          throw Object.assign(new Error(`كميات بند «${name}» غير مكتملة: المقبول (${fmtQty(item.acceptedQty)}) + المرتجع (${fmtQty(returnedTotal)}) يجب أن يساوي كمية الدفعة (${fmtQty(item.quantity)}).`), { statusCode: 400 });
        }
        if (returnedTotal > QTY_EPSILON && !item.dispositionNotes) {
          throw Object.assign(new Error(`برجاء كتابة ملاحظة التصرف لبند «${name}» عند وجود مرتجع في الدفعة.`), { statusCode: 400 });
        }
      }
    }

    // بوابة التغطية قبل فحص الكميات — ترتيب بلازور نفسه
    const gate = await checkBatchCoverageGate(transaction, invoice, detailsById, state.acceptedByDetail, items, auth);

    // فحص الكميات المتاحة (تراكميًا داخل الدفعة لبند واحد مكرر)
    const usedMaintenance = new Set();
    const attemptedByDetail = new Map();
    for (const item of items) {
      const detail = detailsById.get(item.transactionDetailId);
      if (!detail) throw Object.assign(new Error('أحد بنود التسليمة غير موجود في الفاتورة.'), { statusCode: 400 });
      const detailId = item.transactionDetailId;
      if (item.maintenanceId) {
        if (usedMaintenance.has(item.maintenanceId)) {
          throw Object.assign(new Error('سجل الصيانة نفسه مستخدم مرتين في الدفعة نفسها.'), { statusCode: 400 });
        }
        usedMaintenance.add(item.maintenanceId);
        const record = state.maintenanceById.get(item.maintenanceId);
        if (!record || Number(record.TransactionDetailId) !== detailId) {
          throw Object.assign(new Error(`سجل الصيانة المربوط ببند «${detail.ProductName}» غير موجود.`), { statusCode: 400 });
        }
        if (record.Status !== 'ReadyForRedelivery') {
          throw Object.assign(new Error(`سجل الصيانة لبند «${detail.ProductName}» ليس جاهزًا لإعادة التسليم بعد.`), { statusCode: 400 });
        }
        if (item.quantity > num(record.Quantity) + QTY_EPSILON) {
          throw Object.assign(new Error(`الكمية المعاد تسليمها لبند «${detail.ProductName}» تتجاوز كمية سجل الصيانة.`), { statusCode: 400 });
        }
      } else {
        const attempted = (attemptedByDetail.get(detailId) || 0) + item.quantity;
        attemptedByDetail.set(detailId, attempted);
        const available = num(detail.InvoicedQty)
          - (state.acceptedByDetail.get(detailId) || 0)
          - (state.settledByDetail.get(detailId) || 0)
          - (state.inLoopByDetail.get(detailId) || 0);
        if (attempted > available + QTY_EPSILON) {
          throw Object.assign(new Error(`كمية التسليم لبند «${detail.ProductName}» (${fmtQty(attempted)}) تتجاوز المتاح (${fmtQty(Math.max(available, 0))}) — المفوتر ${fmtQty(detail.InvoicedQty)} والمسلَّم المقبول ${fmtQty(state.acceptedByDetail.get(detailId) || 0)}.`), { statusCode: 400 });
        }
      }
    }

    const batchAccepted = items.reduce((sum, i) => sum + i.acceptedQty, 0);
    const totalAcceptedBefore = [...state.acceptedByDetail.values()].reduce((a, b) => a + b, 0);
    const totalSettled = [...state.settledByDetail.values()].reduce((a, b) => a + b, 0);
    const totalInvoiced = state.details.reduce((sum, d) => sum + num(d.InvoicedQty), 0);
    const completes = (totalInvoiced - (totalAcceptedBefore + batchAccepted) - totalSettled) <= QTY_EPSILON;

    const rawNotes = String(data.deliveredNotes || data.notes || data.Notes || '').trim();
    const eventNotes = [rawNotes || null, gate.approvalNote].filter(Boolean).join(' — ') || null;

    const eventResult = await factory()
      .input('txId', sql.Int, id)
      .input('date', sql.DateTime2, deliveryDate)
      .input('empId', sql.Int, employee.employeeId)
      .input('empName', sql.NVarChar(150), employee.employeeName)
      .input('notes', sql.NVarChar(500), eventNotes ? String(eventNotes).slice(0, 500) : null)
      .input('user', sql.NVarChar(100), username)
      .input('completed', sql.Bit, completes ? 1 : 0)
      .input('guid', sql.UniqueIdentifier, eventGuid)
      .query(`
        INSERT INTO InvoiceDeliveries
          (TransactionId, DeliveryDate, DeliveryEmployeeId, DeliveryEmployeeName,
           Notes, RecordedBy, RecordedAt, IsVoided, CompletedInvoice, IsLegacy, EventGuid)
        OUTPUT INSERTED.DeliveryId
        VALUES (@txId, @date, @empId, @empName, @notes, @user, GETDATE(), 0, @completed, 0, @guid)
      `);
    const deliveryId = eventResult.recordset[0].DeliveryId;

    let totalReturned = 0;
    const createdCharges = [];
    for (const item of items) {
      const detail = detailsById.get(item.transactionDetailId);
      const itemResult = await factory()
        .input('deliveryId', sql.Int, deliveryId)
        .input('detailId', sql.Int, item.transactionDetailId)
        .input('qty', sql.Decimal(18, 3), item.quantity)
        .input('accepted', sql.Decimal(18, 3), item.acceptedQty)
        .input('mfg', sql.Decimal(18, 3), item.returnedManufacturingQty)
        .input('handling', sql.Decimal(18, 3), item.returnedHandlingQty)
        .input('mod', sql.Decimal(18, 3), item.returnedModificationQty)
        .input('notes', sql.NVarChar(500), item.dispositionNotes)
        .input('maintenanceId', sql.Int, item.maintenanceId)
        .query(`
          INSERT INTO InvoiceDeliveryItems
            (DeliveryId, TransactionDetailId, Quantity, AcceptedQty,
             ReturnedManufacturingQty, ReturnedHandlingQty, ReturnedModificationQty,
             DispositionNotes, MaintenanceId)
          OUTPUT INSERTED.DeliveryItemId
          VALUES (@deliveryId, @detailId, @qty, @accepted, @mfg, @handling, @mod, @notes, @maintenanceId)
        `);
      const deliveryItemId = itemResult.recordset[0].DeliveryItemId;
      totalReturned += item.returnedManufacturingQty + item.returnedHandlingQty + item.returnedModificationQty;

      // نتائج التسليم: كل شريحة مرتجعة تولّد سجل صيانة «قيد الانتظار»،
      // وشريحة التعديل تولّد أولًا رسم تعديل معلّق الموافقة (بلازور 11.4)
      const slices = [
        { qty: item.returnedManufacturingQty, reasonClass: 'ManufacturingDefect', billable: false },
        { qty: item.returnedHandlingQty, reasonClass: 'HandlingDamage', billable: false },
        { qty: item.returnedModificationQty, reasonClass: 'CustomerModification', billable: true },
      ];
      for (const slice of slices) {
        if (slice.qty <= QTY_EPSILON) continue;
        let chargeId = null;
        if (slice.reasonClass === 'CustomerModification') {
          const price = item.agreedModificationPrice != null && item.agreedModificationPrice > 0
            ? item.agreedModificationPrice : null;
          const chargeResult = await factory()
            .input('txId', sql.Int, id)
            .input('partyId', sql.Int, invoice.PartyID)
            .input('desc', sql.NVarChar(255), item.dispositionNotes ? item.dispositionNotes.slice(0, 255) : null)
            .input('amount', sql.Decimal(18, 2), price)
            .input('sourceDeliveryId', sql.Int, deliveryId)
            .input('notes', sql.NVarChar(255), `رسوم تعديل من تسليمة — ${detail.ProductName || ''}`.slice(0, 255))
            .input('user', sql.NVarChar(50), String(username).slice(0, 50))
            .query(`
              INSERT INTO AdditionalCharges
                (TransactionID, PartyID, ChargeType, ChargeDescription, ChargeAmount,
                 Status, SourceDeliveryId, Notes, CreatedBy, CreatedAt)
              OUTPUT INSERTED.ChargeID
              VALUES (@txId, @partyId, 'Modification', @desc, @amount,
                      'PendingApproval', @sourceDeliveryId, @notes, @user, GETDATE())
            `);
          chargeId = chargeResult.recordset[0].ChargeID;
          createdCharges.push(chargeId);
        }
        await factory()
          .input('itemId', sql.Int, deliveryItemId)
          .input('deliveryId', sql.Int, deliveryId)
          .input('txId', sql.Int, id)
          .input('detailId', sql.Int, item.transactionDetailId)
          .input('qty', sql.Decimal(18, 3), slice.qty)
          .input('reasonClass', sql.NVarChar(30), slice.reasonClass)
          .input('issue', sql.NVarChar(500), item.dispositionNotes)
          .input('billable', sql.Bit, slice.billable ? 1 : 0)
          .input('chargeId', sql.Int, chargeId)
          .input('user', sql.NVarChar(100), username)
          .query(`
            INSERT INTO DeliveryMaintenanceItems
              (DeliveryItemId, DeliveryId, TransactionId, TransactionDetailId, Quantity,
               ReasonClass, IssueDescription, Status, Billable, AdditionalChargeId,
               CreatedAt, StatusBy, IsVoided)
            VALUES (@itemId, @deliveryId, @txId, @detailId, @qty,
                    @reasonClass, @issue, 'Pending', @billable, @chargeId,
                    GETDATE(), @user, 0)
          `);
      }

      // إغلاق رابط إعادة التسليم: قبول يعيد توزيع سجل الصيانة كما في بلازور
      if (item.maintenanceId) {
        const linked = state.maintenanceById.get(item.maintenanceId);
        const unaddressed = round3(num(linked.Quantity) - item.quantity);
        if (item.acceptedQty > QTY_EPSILON) {
          if (unaddressed > QTY_EPSILON) {
            await factory()
              .input('itemId', sql.Int, linked.DeliveryItemId)
              .input('deliveryId', sql.Int, linked.DeliveryId)
              .input('txId', sql.Int, id)
              .input('detailId', sql.Int, item.transactionDetailId)
              .input('qty', sql.Decimal(18, 3), unaddressed)
              .input('reasonClass', sql.NVarChar(30), linked.ReasonClass)
              .input('issue', sql.NVarChar(500), linked.IssueDescription)
              .input('billable', sql.Bit, linked.Billable ? 1 : 0)
              .input('user', sql.NVarChar(100), username)
              .input('resolution', sql.NVarChar(500), `أُعيد منه ${fmtQty(item.acceptedQty)} للعميل وبقي ${fmtQty(unaddressed)} جاهزًا لإعادة التسليم`)
              .query(`
                INSERT INTO DeliveryMaintenanceItems
                  (DeliveryItemId, DeliveryId, TransactionId, TransactionDetailId, Quantity,
                   ReasonClass, IssueDescription, Status, Billable, AdditionalChargeId,
                   CreatedAt, StatusBy, ResolutionNotes, IsVoided)
                VALUES (@itemId, @deliveryId, @txId, @detailId, @qty,
                        @reasonClass, @issue, 'ReadyForRedelivery', @billable, NULL,
                        GETDATE(), @user, @resolution, 0)
              `);
          }
          await factory()
            .input('mid', sql.Int, item.maintenanceId)
            .input('qty', sql.Decimal(18, 3), item.acceptedQty)
            .input('user', sql.NVarChar(100), username)
            .query(`
              UPDATE DeliveryMaintenanceItems
              SET Quantity = @qty, Status = 'Redelivered', ClosedAt = GETDATE(),
                  StatusBy = @user, ResolutionNotes = N'أُعيد تسليمه وقُبل عند العميل'
              WHERE MaintenanceId = @mid
            `);
        } else if (unaddressed > QTY_EPSILON) {
          await factory()
            .input('mid', sql.Int, item.maintenanceId)
            .input('qty', sql.Decimal(18, 3), unaddressed)
            .query('UPDATE DeliveryMaintenanceItems SET Quantity = @qty WHERE MaintenanceId = @mid');
        } else {
          await factory()
            .input('mid', sql.Int, item.maintenanceId)
            .input('user', sql.NVarChar(100), username)
            .query(`
              UPDATE DeliveryMaintenanceItems
              SET IsVoided = 1, VoidedBy = @user, VoidedAt = GETDATE(),
                  VoidReason = N'أُعيد كامل الكمية كمرتجع عند إعادة التسليم فأُغلق السجل',
                  StatusBy = @user
              WHERE MaintenanceId = @mid
            `);
        }
      }
    }

    const projection = await recomputeDeliveryProjection(factory, id);

    await insertAudit(transaction, {
      id,
      action: ACTION_EVENT_RECORDED,
      username,
      newData: {
        DeliveryId: deliveryId,
        Lines: items.length,
        CompletedInvoice: projection.completed,
        EventGuid: eventGuid,
      },
    });

    await transaction.commit();

    let courierUsername = null;
    if (employee.employeeId) {
      try {
        const userResult = await pool.request()
          .input('employeeId', sql.Int, employee.employeeId)
          .query('SELECT TOP 1 Username FROM Users WHERE employeeID = @employeeId AND IsActive = 1 ORDER BY UserID');
        courierUsername = userResult.recordset[0]?.Username || null;
      } catch {
        courierUsername = null;
      }
    }

    return {
      success: true,
      message: projection.completed
        ? 'تم تسجيل التسليمة واكتمل تسليم الفاتورة بالكامل.'
        : `تم تسجيل التسليمة — مفتوح ${fmtQty(projection.openQty)} من ${fmtQty(projection.totalInvoiced)}.`,
      DeliveryId: deliveryId,
      TransactionID: id,
      ReferenceNumber: invoice.ReferenceNumber,
      PartyID: invoice.PartyID,
      PartyName: invoice.PartyName,
      RemainingAmount: num(invoice.GrandTotal) - num(invoice.PaidAmount),
      DeliveryEmployeeId: employee.employeeId,
      DeliveryEmployeeName: employee.employeeName,
      CompletedInvoice: projection.completed,
      OpenQty: projection.openQty,
      TotalInvoicedQty: projection.totalInvoiced,
      TotalReturnedQty: round3(totalReturned),
      CreatedChargeIds: createdCharges,
      courierUsername,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

// ════════════════════════════════════════════════════════════════════
// إلغاء حدث تسليم — مرآة VoidDeliveryEventAsync: مدير/مدير حسابات فقط
// وسبب إلزامي، مع حراس سجلات الصيانة والرسوم المولودة من الحدث.
// ════════════════════════════════════════════════════════════════════
async function voidDeliveryEvent(value, deliveryId, data = {}, auth) {
  const id = assertId(value, 'معرّف الفاتورة');
  const eventId = assertId(deliveryId, 'معرّف التسليمة');
  if (!policy.delivery.canOverrideRemaining(auth)) {
    throw Object.assign(new Error('إلغاء التسليمات متاح للمدير ومدير الحسابات فقط.'), { statusCode: 403 });
  }
  const reason = String(data.reason ?? data.Reason ?? '').trim();
  if (!reason) throw Object.assign(new Error('سبب الإلغاء إلزامي.'), { statusCode: 400 });
  const username = auth?.username || 'System';

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const factory = () => transaction.request();
  try {
    const invoiceResult = await factory()
      .input('id', sql.Int, id)
      .query('SELECT TransactionID FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id');
    if (!invoiceResult.recordset[0]) {
      throw Object.assign(new Error('الفاتورة غير موجودة.'), { statusCode: 404 });
    }

    const eventResult = await factory()
      .input('eventId', sql.Int, eventId)
      .input('txId', sql.Int, id)
      .query(`
        SELECT DeliveryId, IsVoided FROM InvoiceDeliveries WITH (UPDLOCK, HOLDLOCK)
        WHERE DeliveryId = @eventId AND TransactionId = @txId
      `);
    const event = eventResult.recordset[0];
    if (!event) throw Object.assign(new Error('التسليمة غير موجودة.'), { statusCode: 404 });
    if (event.IsVoided) throw Object.assign(new Error('هذه التسليمة ملغاة من قبل.'), { statusCode: 409 });

    const linkedResult = await factory()
      .input('eventId', sql.Int, eventId)
      .query('SELECT COUNT(*) AS Cnt FROM InvoiceDeliveryItems WHERE DeliveryId = @eventId AND MaintenanceId IS NOT NULL');
    if (num(linkedResult.recordset[0]?.Cnt) > 0) {
      throw Object.assign(new Error('لا يمكن إلغاء تسليمة إعادة تسليم مرتبطة بسجل صيانة.'), { statusCode: 409 });
    }

    const bornResult = await factory()
      .input('eventId', sql.Int, eventId)
      .query('SELECT MaintenanceId, Status FROM DeliveryMaintenanceItems WHERE DeliveryId = @eventId AND IsVoided = 0');
    if (bornResult.recordset.some((r) => r.Status !== 'Pending')) {
      throw Object.assign(new Error('لا يمكن إلغاء هذه التسليمة: توجد سجلات صيانة/مرتجعات ناتجة عنها تجاوزت مرحلة الانتظار — عالِجها أو ألغِها أولًا ثم أعد المحاولة.'), { statusCode: 409 });
    }

    const chargesResult = await factory()
      .input('eventId', sql.Int, eventId)
      .query('SELECT ChargeID, Status FROM AdditionalCharges WHERE SourceDeliveryId = @eventId');
    if (chargesResult.recordset.some((r) => ['Approved', 'Paid', 'Applied'].includes(r.Status))) {
      throw Object.assign(new Error('لا يمكن إلغاء هذه التسليمة: رسم التعديل الناتج عنها تمت الموافقة عليه أو تحصيله — عالِجه أولًا من شاشة الفاتورة.'), { statusCode: 409 });
    }

    await factory()
      .input('eventId', sql.Int, eventId)
      .input('user', sql.NVarChar(100), username)
      .query(`
        UPDATE DeliveryMaintenanceItems
        SET IsVoided = 1, VoidedBy = @user, VoidedAt = GETDATE(),
            VoidReason = N'أُلغي حدث التسليم المصدر'
        WHERE DeliveryId = @eventId AND IsVoided = 0
      `);

    await factory()
      .input('eventId', sql.Int, eventId)
      .query(`
        UPDATE AdditionalCharges
        SET Status = 'Rejected',
            Notes = LEFT(CASE WHEN ISNULL(Notes, '') = '' THEN N'رُفض تلقائيًا: أُلغي حدث التسليم المصدر'
                              ELSE Notes + N' — رُفض تلقائيًا: أُلغي حدث التسليم المصدر' END, 255)
        WHERE SourceDeliveryId = @eventId AND Status = 'PendingApproval'
      `);

    await factory()
      .input('eventId', sql.Int, eventId)
      .input('user', sql.NVarChar(100), username)
      .input('reason', sql.NVarChar(500), reason.slice(0, 500))
      .query(`
        UPDATE InvoiceDeliveries
        SET IsVoided = 1, VoidedBy = @user, VoidedAt = GETDATE(), VoidReason = @reason
        WHERE DeliveryId = @eventId
      `);

    const projection = await recomputeDeliveryProjection(factory, id);

    await insertAudit(transaction, {
      id,
      action: ACTION_EVENT_VOIDED,
      username,
      oldData: { DeliveryId: eventId },
      newData: { Reason: reason, CompletedInvoice: projection.completed },
    });

    await transaction.commit();
    return {
      success: true,
      message: 'تم إلغاء التسليمة وإعادة حساب حالة الفاتورة.',
      TransactionID: id,
      DeliveryId: eventId,
      CompletedInvoice: projection.completed,
      OpenQty: projection.openQty,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

// ════════════════════════════════════════════════════════════════════
// المواعيد القادمة — مرآة GetUpcomingAppointmentsAsync في بلازور:
// (فاتورة × تاريخ بند فعّال) لا صفوف فواتير؛ النافذة على التاريخ
// المعروض لهذا المستخدم، والحقيقي لا يخرج إلا لمن يراه أصلًا.
// DueDate في الرد = المعروض دائمًا (توافق مع شكل الرد القائم).
// التجميع الداخلي يبقي التاريخ الحقيقي دائمًا (RealDate) — والمصدّرات
// هي من تصفّره لغير المستثنين قبل الإخراج.
// ════════════════════════════════════════════════════════════════════
async function collectUpcomingAppointments(auth = null, withinDays = 7) {
  const pool = await connectDB();
  const parsedWithin = Number(withinDays);
  const within = Number.isInteger(parsedWithin) && parsedWithin >= 0 ? parsedWithin : 7;
  const buffer = dates.dateBufferDays();
  const seesReal = auth ? dates.canSeeRealDate(auth) : true;
  const today = dates.todayOnly();
  const windowFrom = dates.addDays(today, -buffer);
  const windowTo = dates.addDays(today, within + buffer);

  const candidatesResult = await pool.request()
    .input('from', sql.Date, windowFrom)
    .input('to', sql.Date, windowTo)
    .query(`
      SELECT t.TransactionID, t.ReferenceNumber, t.TransactionDate, t.DueDate,
             t.PartyID, p.PartyName AS ClientName, p.Phone
      FROM Transactions t
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      WHERE t.TransactionType = 'Sale'
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
        AND ISNULL(t.IsDelivered, 0) = 0
        AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%')
        AND (
          (t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) BETWEEN @from AND @to)
          OR EXISTS (
            SELECT 1 FROM TransactionDetails td
            WHERE td.TransactionID = t.TransactionID
              AND td.DeliveryDateIsCustom = 1 AND td.DeliveryDate IS NOT NULL
              AND CAST(td.DeliveryDate AS DATE) BETWEEN @from AND @to
          )
        )
    `);
  const candidates = candidatesResult.recordset;
  if (!candidates.length) return [];

  const ids = candidates.map((c) => Number(c.TransactionID));
  const candidateById = new Map(candidates.map((c) => [Number(c.TransactionID), c]));

  const linesRequest = pool.request();
  const linesIn = bindIdList(linesRequest, 'uid', ids);
  const linesResult = await linesRequest.query(`
    SELECT TransactionID, DetailID, Quantity, DeliveryDate, DeliveryDateIsCustom
    FROM TransactionDetails
    WHERE TransactionID IN ${linesIn}
  `);

  const acceptedByDetail = new Map();
  const settledByDetail = new Map();
  try {
    const accRequest = pool.request();
    const accIn = bindIdList(accRequest, 'uaid', ids);
    const accResult = await accRequest.query(`
      SELECT idl.TransactionId, idi.TransactionDetailId,
             COALESCE(SUM(idi.AcceptedQty), 0) AS AcceptedQty
      FROM InvoiceDeliveryItems idi
      JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.IsVoided = 0 AND idl.TransactionId IN ${accIn}
      GROUP BY idl.TransactionId, idi.TransactionDetailId
    `);
    for (const row of accResult.recordset) {
      acceptedByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.AcceptedQty));
    }
    const setRequest = pool.request();
    const setIn = bindIdList(setRequest, 'umid', ids);
    const setResult = await setRequest.query(`
      SELECT TransactionId, TransactionDetailId, COALESCE(SUM(Quantity), 0) AS SettledQty
      FROM DeliveryMaintenanceItems
      WHERE IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}' AND TransactionId IN ${setIn}
      GROUP BY TransactionId, TransactionDetailId
    `);
    for (const row of setResult.recordset) {
      settledByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.SettledQty));
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  const groups = new Map();
  for (const line of linesResult.recordset) {
    const txId = Number(line.TransactionID);
    const candidate = candidateById.get(txId);
    if (!candidate) continue;
    const accepted = acceptedByDetail.get(`${txId}:${line.DetailID}`) || 0;
    const settled = settledByDetail.get(`${txId}:${line.DetailID}`) || 0;
    const remaining = num(line.Quantity) - accepted - settled;
    if (remaining <= QTY_EPSILON) continue;

    const isCustom = Boolean(line.DeliveryDateIsCustom) && Boolean(line.DeliveryDate);
    const effective = dates.effectiveLineDate(line.DeliveryDate, isCustom, candidate.DueDate);
    if (!effective) continue;
    if (effective < windowFrom || effective > windowTo) continue;

    const key = `${txId}:${effective.toISOString().slice(0, 10)}`;
    if (!groups.has(key)) {
      groups.set(key, { candidate, realDate: effective, lineCount: 0, remainingQty: 0 });
    }
    const group = groups.get(key);
    group.lineCount += 1;
    group.remainingQty = round3(group.remainingQty + remaining);
  }

  const lastDay = dates.addDays(today, within);
  const appointments = [];
  for (const group of groups.values()) {
    const shown = dates.displayDate(group.realDate, group.candidate.TransactionDate, seesReal, buffer);
    if (!shown || shown < today || shown > lastDay) continue;
    appointments.push({
      TransactionID: Number(group.candidate.TransactionID),
      ReferenceNumber: group.candidate.ReferenceNumber,
      DueDate: shown,
      PartyID: group.candidate.PartyID,
      ClientName: group.candidate.ClientName,
      Phone: group.candidate.Phone,
      DaysRemaining: dates.diffDays(shown, today),
      DisplayDate: shown,
      RealDate: group.realDate,
      DueLineCount: group.lineCount,
      RemainingQty: group.remainingQty,
    });
  }

  appointments.sort((a, b) => (a.DisplayDate - b.DisplayDate)
    || String(a.ClientName || '').localeCompare(String(b.ClientName || '')));
  return { appointments, seesReal };
}

async function getUpcomingDeliveries(auth = null, withinDays = 7) {
  const { appointments, seesReal } = await collectUpcomingAppointments(auth, withinDays);
  if (!seesReal) {
    for (const appointment of appointments) appointment.RealDate = null;
  }
  return appointments;
}

// ترتيب الموعد بين مواعيد فاتورته — مرآة «موعد X من N» في قائمة بلازور
// (SalesDeliveryStatus.razor:731-732, 823): مجموعات الفاتورة هي تواريخ
// بنودها الفعّالة المميزة مرتبة زمنيًا (نفس تجميع المواعيد أعلاه)،
// والترتيب موضع تاريخ هذا الموعد بينها (1-based).
async function loadAppointmentOrdinals(pool, headersByTx) {
  const ordinals = new Map();
  const ids = [...headersByTx.keys()];
  if (!ids.length) return ordinals;

  const request = pool.request();
  const inList = bindIdList(request, 'oid', ids);
  const result = await request.query(`
    SELECT TransactionID, DeliveryDate, DeliveryDateIsCustom
    FROM TransactionDetails
    WHERE TransactionID IN ${inList}
  `);

  const datesByTx = new Map();
  for (const line of result.recordset) {
    const txId = Number(line.TransactionID);
    const header = headersByTx.get(txId);
    if (!header) continue;
    const isCustom = Boolean(line.DeliveryDateIsCustom) && Boolean(line.DeliveryDate);
    const effective = dates.effectiveLineDate(line.DeliveryDate, isCustom, header.DueDate);
    if (!effective) continue;
    if (!datesByTx.has(txId)) datesByTx.set(txId, new Set());
    datesByTx.get(txId).add(effective.toISOString().slice(0, 10));
  }

  for (const [txId, dateSet] of datesByTx) {
    const sorted = [...dateSet].sort();
    const perTx = new Map();
    sorted.forEach((iso, index) => perTx.set(iso, { index: index + 1, count: sorted.length }));
    ordinals.set(txId, perTx);
  }
  return ordinals;
}

// ════════════════════════════════════════════════════════════════════
// مواعيد رئيسية التطبيق — مرآة قسم «التسليمات القادمة — 10 أيام» في
// رئيسية بلازور (Home.razor:594, 3190): نافذة 10 أيام ثابتة على
// التواريخ المعروضة لهذا المستخدم، وسقف العرض 12 موعدًا مع العدد
// الكلي. لا مبالغ هنا إطلاقًا كما في DTO بلازور (كميات فقط)، والتاريخ
// الحقيقي لا يخرج إلا لمن يراه أصلًا.
// ════════════════════════════════════════════════════════════════════
const HOME_UPCOMING_WINDOW_DAYS = 10;
const HOME_UPCOMING_CAP = 12;

async function getHomeUpcomingDeliveries(auth) {
  const { appointments, seesReal } = await collectUpcomingAppointments(auth, HOME_UPCOMING_WINDOW_DAYS);
  const total = appointments.length;
  const page = appointments.slice(0, HOME_UPCOMING_CAP);

  if (page.length) {
    const pool = await connectDB();
    const txIds = [...new Set(page.map((a) => Number(a.TransactionID)))];
    const headerRequest = pool.request();
    const headerIn = bindIdList(headerRequest, 'hid', txIds);
    const headerResult = await headerRequest.query(`
      SELECT TransactionID, DueDate FROM Transactions WHERE TransactionID IN ${headerIn}
    `);
    const headersByTx = new Map(
      headerResult.recordset.map((row) => [Number(row.TransactionID), row]),
    );
    const ordinals = await loadAppointmentOrdinals(pool, headersByTx);
    const today = dates.todayOnly();

    for (const appointment of page) {
      const txId = Number(appointment.TransactionID);
      const iso = appointment.RealDate
        ? dates.dateOnly(appointment.RealDate)?.toISOString().slice(0, 10)
        : null;
      const ordinal = iso ? ordinals.get(txId)?.get(iso) : null;
      appointment.AppointmentIndex = ordinal ? ordinal.index : null;
      appointment.AppointmentCount = ordinal ? ordinal.count : null;
      appointment.IsDueToday = dates.diffDays(appointment.DisplayDate, today) === 0;
      appointment.Status = appointment.IsDueToday ? 'today' : 'upcoming';
      if (!seesReal) appointment.RealDate = null;
    }
  }

  return { appointments: page, total, windowDays: HOME_UPCOMING_WINDOW_DAYS };
}


// ════════════════════════════════════════════════════════════════════
// Local role/claim predicates mirroring Blazor DeliveryPermissions.cs
// for maintenance + schedule-change (shared policy file is not edited
// by this cluster; these mirror exactly):
//  CanViewMaintenance        DeliveryPermissions.cs — Admin/AccountManager/
//                            ProductionManager/FactoryManager/DeliveryOfficer
//                            or claim frmDeliveryMaintenance:View
//  CanTransitionMaintenance  Admin/ProductionManager/FactoryManager or :Edit
//  CanCloseByReplacement     transition roles + AccountManager
//  CanCloseByCredit          Admin/AccountManager only (also gates Cancel)
//  CanReclassifyMaintenance  Admin/AccountManager/ProductionManager
//  CanSeeRepairCost          Admin/AccountManager/ProductionManager/FactoryManager
//  CanRequestScheduleChange  DeliveryOfficer/ProductionManager ONLY (roles)
//  CanDecideScheduleChange   Admin/AccountManager only
// ════════════════════════════════════════════════════════════════════
function _normRole(value) { return String(value || '').toLowerCase().replace(/[\s_-]+/g, ''); }
function _isRole(auth, ...roles) { const c = _normRole(auth?.role); return roles.some((r) => c === _normRole(r)); }
function _hasClaim(auth, claim) { return auth?.claims instanceof Set && auth.claims.has(claim); }
const maintPerms = {
  canView: (a) => _isRole(a, 'Admin', 'AccountManager', 'ProductionManager', 'FactoryManager', 'DeliveryOfficer') || _hasClaim(a, 'frmDeliveryMaintenance:View'),
  canTransition: (a) => _isRole(a, 'Admin', 'ProductionManager', 'FactoryManager') || _hasClaim(a, 'frmDeliveryMaintenance:Edit'),
  canCloseByReplacement: (a) => maintPerms.canTransition(a) || _isRole(a, 'AccountManager'),
  canCloseByCredit: (a) => _isRole(a, 'Admin', 'AccountManager'),
  canReclassify: (a) => _isRole(a, 'Admin', 'AccountManager', 'ProductionManager'),
  canSeeRepairCost: (a) => _isRole(a, 'Admin', 'AccountManager', 'ProductionManager', 'FactoryManager'),
  canRequestSchedule: (a) => _isRole(a, 'DeliveryOfficer', 'ProductionManager'),
  canDecideSchedule: (a) => _isRole(a, 'Admin', 'AccountManager'),
};
const MAINT_TERMINAL = ['Redelivered', 'ClosedByReplacement', 'ClosedByCredit', 'Cancelled'];
const MISSING_SCHEDULE_MSG = 'جداول طلبات تعديل المواعيد غير مهيأة بعد — برجاء تشغيل سكربت delivery-schedule-requests.sql أولًا.';
function isMissingStorageError(error) {
  return Boolean(error) && (error.number === 208 || error.number === 207 || /Invalid object name|Invalid column name/i.test(String(error.message || '')));
}
async function insertAuditFor(transaction, { table, key, action, username, oldData = null, newData = null }) {
  await transaction.request()
    .input('tbl', sql.NVarChar(100), table)
    .input('key', sql.NVarChar(200), String(key))
    .input('action', sql.NVarChar(100), action)
    .input('username', sql.NVarChar(100), username)
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .query(`
      INSERT INTO [dbo].[Audit_Log] (TableName, ActionType, PrimaryKeyValue, OldData, NewData, ActionDate, LoginName, AppName, AccessUserName)
      VALUES (@tbl, @action, @key, @oldData, @newData, GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

// ── Item 5 (Pkg2): delivery maintenance queue — mirror of Blazor
// DeliveryMaintenanceService.GetQueueAsync (Services/DeliveryMaintenanceService.cs:55):
// non-voided, in-loop only unless includeTerminal, ordered in-loop first
// (oldest first) then terminal by ClosedAt desc, cap 500. Repair cost is
// nulled for roles outside CanSeeRepairCost; charge amount is nulled for
// users without CanSeeAmounts (app amount rule).
async function getMaintenanceQueue(filters = {}, auth = null) {
  const pool = await connectDB();
  try {
    const request = pool.request();
    const clauses = ['m.IsVoided = 0'];
    if (!filters.includeTerminal) {
      clauses.push(`m.Status IN (${MAINTENANCE_IN_LOOP.map((x) => `N'${x}'`).join(', ')})`);
    }
    if (filters.status) { request.input('mStatus', sql.NVarChar(30), String(filters.status)); clauses.push('m.Status = @mStatus'); }
    if (filters.reasonClass) { request.input('mReason', sql.NVarChar(30), String(filters.reasonClass)); clauses.push('m.ReasonClass = @mReason'); }
    if (filters.search && String(filters.search).trim()) {
      request.input('mSearch', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
      clauses.push('(t.ReferenceNumber LIKE @mSearch OR p.PartyName LIKE @mSearch OR pr.ProductName LIKE @mSearch)');
    }
    const result = await request.query(`
      SELECT TOP 1000 m.MaintenanceId, m.DeliveryItemId, m.DeliveryId, m.TransactionId, m.TransactionDetailId,
             m.Quantity, m.ReasonClass, m.IssueDescription, m.Status, m.Billable, m.AdditionalChargeId,
             m.RepairCost, m.RepairCostNotes, m.HandledByEmployeeId, m.CreatedAt, m.StartedAt, m.ReadyAt,
             m.ClosedAt, m.StatusBy, m.ResolutionNotes, m.IsVoided,
             t.ReferenceNumber AS TransactionRef, p.PartyName,
             pr.ProductName, e.FullName AS HandledByEmployeeName,
             ac.Status AS ChargeStatus, ac.ChargeAmount
      FROM DeliveryMaintenanceItems m
      INNER JOIN Transactions t ON t.TransactionID = m.TransactionId
      LEFT JOIN Parties p ON p.PartyID = t.PartyID
      LEFT JOIN TransactionDetails td ON td.DetailID = m.TransactionDetailId
      LEFT JOIN Products pr ON pr.ProductID = td.ProductID
      LEFT JOIN Employees e ON e.EmployeeID = m.HandledByEmployeeId
      LEFT JOIN AdditionalCharges ac ON ac.ChargeID = m.AdditionalChargeId
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.CreatedAt
    `);
    const canCost = auth ? maintPerms.canSeeRepairCost(auth) : false;
    const canAmounts = auth ? policy.delivery.canSeeAmounts(auth) : false;
    const rows = result.recordset.map((r) => {
      const copy = { ...r };
      if (!canCost) { copy.RepairCost = null; copy.RepairCostNotes = null; }
      if (!canAmounts) copy.ChargeAmount = null;
      copy.IsTerminal = MAINT_TERMINAL.includes(copy.Status);
      copy.IsInLoop = MAINTENANCE_IN_LOOP.includes(copy.Status);
      copy.AgeDays = copy.CreatedAt ? Math.max(0, Math.floor((dates.todayOnly() - dates.dateOnly(copy.CreatedAt)) / 86400000)) : 0;
      return copy;
    });
    rows.sort((a, b) => {
      const ta = a.IsTerminal ? 1 : 0; const tb = b.IsTerminal ? 1 : 0;
      if (ta !== tb) return ta - tb;
      if (!a.IsTerminal) return new Date(a.CreatedAt) - new Date(b.CreatedAt);
      return new Date(b.ClosedAt || 0) - new Date(a.ClosedAt || 0);
    });
    return rows.slice(0, 500);
  } catch (error) {
    if (isMissingStorageError(error)) return [];
    throw error;
  }
}

// Mirror of DeliveryMaintenanceService transitions (StartAsync:214,
// MarkReadyAsync:237, MarkUnrepairableAsync:268, CloseByReplacementAsync:288,
// CloseByCreditAsync:312, CancelAsync:359, ReclassifyAsync:383).
async function transitionMaintenance(maintenanceId, action, data = {}, auth) {
  const id = assertId(maintenanceId, 'معرّف سجل الصيانة');
  const username = auth?.username || 'System';
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const factory = () => transaction.request();
  try {
    const cur = await factory().input('mid', sql.Int, id).query(`
      SELECT MaintenanceId, TransactionId, TransactionDetailId, Quantity, ReasonClass, Status, Billable, IsVoided
      FROM DeliveryMaintenanceItems WITH (UPDLOCK, HOLDLOCK) WHERE MaintenanceId = @mid
    `);
    const rec = cur.recordset[0];
    if (!rec) throw Object.assign(new Error('سجل الصيانة غير موجود.'), { statusCode: 404 });
    if (rec.IsVoided) throw Object.assign(new Error('سجل الصيانة ملغي.'), { statusCode: 409 });
    if (MAINT_TERMINAL.includes(rec.Status)) {
      throw Object.assign(new Error(`سجل الصيانة منتهٍ بحالة «${rec.Status}» — لا انتقالات بعدها.`), { statusCode: 409 });
    }
    const oldStatus = rec.Status;
    const oldClass = rec.ReasonClass;
    let newStatus = oldStatus;
    let auditAction = 'MaintenanceStatusChanged';
    const sets = ['StatusBy = @user'];
    const req = factory();
    req.input('mid', sql.Int, id).input('user', sql.NVarChar(100), username);

    if (action === 'start') {
      if (!maintPerms.canTransition(auth)) throw Object.assign(new Error('بدء الصيانة متاح لمدير الإنتاج ومدير المصنع والمدير.'), { statusCode: 403 });
      if (oldStatus !== 'Pending') throw Object.assign(new Error('بدء الصيانة من حالة «بانتظار الصيانة» فقط.'), { statusCode: 409 });
      newStatus = 'InProgress'; sets.push('Status = @newStatus', 'StartedAt = GETDATE()');
      if (data.handledByEmployeeId) { req.input('handledBy', sql.Int, assertId(data.handledByEmployeeId, 'معرّف العامل')); sets.push('HandledByEmployeeId = @handledBy'); }
    } else if (action === 'ready') {
      if (!maintPerms.canTransition(auth)) throw Object.assign(new Error('تعليم الجاهزية متاح لمدير الإنتاج ومدير المصنع والمدير.'), { statusCode: 403 });
      if (!['Pending', 'InProgress'].includes(oldStatus)) throw Object.assign(new Error('الجاهزية من «بانتظار الصيانة» أو «قيد الصيانة» فقط.'), { statusCode: 409 });
      if (data.repairCost != null) {
        if (!maintPerms.canSeeRepairCost(auth)) throw Object.assign(new Error('إدخال تكلفة الإصلاح متاح لأدوار الإدارة والحسابات والإنتاج والمصنع فقط.'), { statusCode: 403 });
        if (num(data.repairCost) < 0) throw Object.assign(new Error('تكلفة الإصلاح لا يمكن أن تكون سالبة.'), { statusCode: 400 });
        req.input('repairCost', sql.Decimal(18, 2), num(data.repairCost)); sets.push('RepairCost = @repairCost');
      }
      if (data.repairCostNotes) { req.input('repairNotes', sql.NVarChar(500), String(data.repairCostNotes).slice(0, 500)); sets.push('RepairCostNotes = @repairNotes'); }
      if (data.handledByEmployeeId) { req.input('handledBy', sql.Int, assertId(data.handledByEmployeeId, 'معرّف العامل')); sets.push('HandledByEmployeeId = @handledBy'); }
      newStatus = 'ReadyForRedelivery'; sets.push('Status = @newStatus', 'ReadyAt = GETDATE()');
    } else if (action === 'unrepairable') {
      if (!maintPerms.canTransition(auth)) throw Object.assign(new Error('تعليم التعذّر متاح لمدير الإنتاج ومدير المصنع والمدير.'), { statusCode: 403 });
      newStatus = 'Unrepairable'; sets.push('Status = @newStatus');
      if (data.notes) { req.input('resNotes', sql.NVarChar(500), String(data.notes).slice(0, 500)); sets.push('ResolutionNotes = @resNotes'); }
    } else if (action === 'close-replacement') {
      if (!maintPerms.canCloseByReplacement(auth)) throw Object.assign(new Error('الإغلاق باستبدال متاح للمصنع/الإنتاج/المدير ومدير الحسابات.'), { statusCode: 403 });
      if (oldStatus !== 'Unrepairable') throw Object.assign(new Error('الإغلاق باستبدال يأتي بعد تعليم «تعذّر إصلاحه» (قرار لكل حالة — D11).'), { statusCode: 409 });
      newStatus = 'ClosedByReplacement'; sets.push('Status = @newStatus', 'ClosedAt = GETDATE()'); auditAction = 'MaintenanceClosed';
      if (data.notes) { req.input('resNotes', sql.NVarChar(500), String(data.notes).slice(0, 500)); sets.push('ResolutionNotes = @resNotes'); }
    } else if (action === 'close-credit') {
      if (!maintPerms.canCloseByCredit(auth)) throw Object.assign(new Error('الإغلاق بردّ نهائي/رصيد متاح للمدير ومدير الحسابات فقط (قرار مالي الأثر).'), { statusCode: 403 });
      if (oldStatus !== 'Unrepairable') throw Object.assign(new Error('الإغلاق بردّ نهائي يأتي بعد تعليم «تعذّر إصلاحه» (قرار لكل حالة — D11).'), { statusCode: 409 });
      newStatus = 'ClosedByCredit'; sets.push('Status = @newStatus', 'ClosedAt = GETDATE()'); auditAction = 'MaintenanceClosed';
      if (data.notes) { req.input('resNotes', sql.NVarChar(500), String(data.notes).slice(0, 500)); sets.push('ResolutionNotes = @resNotes'); }
    } else if (action === 'cancel') {
      if (!maintPerms.canCloseByCredit(auth)) throw Object.assign(new Error('إلغاء طلب الصيانة متاح للمدير ومدير الحسابات.'), { statusCode: 403 });
      const reason = String(data.reason || '').trim();
      if (!reason) throw Object.assign(new Error('سبب الإلغاء إلزامي.'), { statusCode: 400 });
      newStatus = 'Cancelled'; sets.push('Status = @newStatus', 'ClosedAt = GETDATE()');
      req.input('resNotes', sql.NVarChar(500), reason.slice(0, 500)); sets.push('ResolutionNotes = @resNotes');
    } else if (action === 'reclassify') {
      if (!maintPerms.canReclassify(auth)) throw Object.assign(new Error('إعادة تصنيف العيب متاحة للمدير ومدير الحسابات ومدير الإنتاج فقط (D12).'), { statusCode: 403 });
      const reason = String(data.reason || '').trim();
      if (!reason) throw Object.assign(new Error('سبب إعادة التصنيف إلزامي — التصنيف يوزّع المسؤولية بين المصنع وعمالة التسليم.'), { statusCode: 400 });
      const newClass = String(data.newClass || data.reasonClass || '');
      if (!['ManufacturingDefect', 'HandlingDamage', 'CustomerModification'].includes(newClass)) throw Object.assign(new Error('تصنيف غير معروف.'), { statusCode: 400 });
      if (oldClass === newClass) throw Object.assign(new Error('السجل مصنّف بهذا التصنيف أصلًا.'), { statusCode: 409 });
      req.input('newClass', sql.NVarChar(30), newClass);
      req.input('billable', sql.Bit, newClass === 'CustomerModification' ? 1 : 0);
      sets.push('ReasonClass = @newClass', 'Billable = @billable');
      await req.query(`UPDATE DeliveryMaintenanceItems SET ${sets.join(', ')} WHERE MaintenanceId = @mid`);
      // D12: before/after audit with mandatory reason
      await insertAuditFor(transaction, {
        table: 'DeliveryMaintenanceItems', key: id, action: 'MaintenanceReclassified', username,
        oldData: { ReasonClass: oldClass },
        newData: { ReasonClass: newClass, Reason: reason, TransactionId: rec.TransactionId, Quantity: rec.Quantity },
      });
      await transaction.commit();
      return { success: true, message: `أُعيد تصنيف الرجوع من «${oldClass}» إلى «${newClass}» ووثّق السبب في التدقيق.`, MaintenanceId: id, TransactionId: rec.TransactionId, Status: oldStatus, ReasonClass: newClass };
    } else {
      throw Object.assign(new Error('إجراء صيانة غير معروف.'), { statusCode: 400 });
    }

    req.input('newStatus', sql.NVarChar(30), newStatus);
    await req.query(`UPDATE DeliveryMaintenanceItems SET ${sets.join(', ')} WHERE MaintenanceId = @mid`);
    if (action === 'close-credit') {
      await recomputeDeliveryProjection(factory, rec.TransactionId);
    }
    await insertAuditFor(transaction, {
      table: 'DeliveryMaintenanceItems', key: id, action: auditAction, username,
      oldData: { Status: oldStatus },
      newData: { Status: newStatus, Quantity: rec.Quantity, ReasonClass: rec.ReasonClass, TransactionId: rec.TransactionId },
    });
    await transaction.commit();
    return { success: true, message: 'تم تحديث سجل الصيانة.', MaintenanceId: id, TransactionId: rec.TransactionId, Status: newStatus, PreviousStatus: oldStatus };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    if (isMissingStorageError(error)) throw Object.assign(new Error('تخزين نتائج التسليم غير مهيأ بعد — برجاء تشغيل سكربت delivery-outcomes.sql.'), { statusCode: 400 });
    throw error;
  }
}

// ── Item 6 (Pkg2): schedule-change requests — mirror of Blazor patch
// delivery-schedule-requests (SalesDeliveryStatusService Create/Decide/
// Withdraw/Get + DeliveryPermissions CanRequest/CanDecide). Reads degrade
// to empty on missing tables (208/207); writes throw the SQL-need message.
async function getScheduleChangeRequests(value, auth = null) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  try {
    const result = await pool.request().input('id', sql.Int, id).query(`
      SELECT r.Id, r.TransactionId, r.RequesterUserName, r.RequesterName, r.Reason, r.ProposedDueDate,
             r.Status, r.CreatedAt, r.DecidedBy, r.DecidedAt, r.DecisionNote
      FROM DeliveryScheduleChangeRequests r WHERE r.TransactionId = @id
      ORDER BY r.CreatedAt DESC, r.Id DESC
    `);
    const requests = result.recordset;
    if (!requests.length) return [];
    const reqIds = requests.map((r) => Number(r.Id));
    const linesRequest = pool.request();
    const linesIn = bindIdList(linesRequest, 'scl', reqIds);
    const linesResult = await linesRequest.query(`
      SELECT l.Id, l.RequestId, l.TransactionDetailId, l.ProposedDate, l.ProposedIsCustom, pr.ProductName
      FROM DeliveryScheduleChangeRequestLines l
      LEFT JOIN TransactionDetails td ON td.DetailID = l.TransactionDetailId
      LEFT JOIN Products pr ON pr.ProductID = td.ProductID
      WHERE l.RequestId IN ${linesIn} ORDER BY l.Id
    `);
    const byReq = new Map();
    for (const line of linesResult.recordset) {
      const k = Number(line.RequestId);
      if (!byReq.has(k)) byReq.set(k, []);
      byReq.get(k).push(line);
    }
    for (const r of requests) r.Lines = byReq.get(Number(r.Id)) || [];
    return requests;
  } catch (error) {
    if (isMissingStorageError(error)) return [];
    throw error;
  }
}

async function createScheduleChangeRequest(value, data = {}, auth) {
  if (!maintPerms.canRequestSchedule(auth)) {
    throw Object.assign(new Error('طلب تعديل مواعيد التسليم متاح لمسئول التسليمات ومدير الإنتاج فقط.'), { statusCode: 403 });
  }
  const id = assertId(value, 'معرّف الفاتورة');
  const reason = String(data.reason || '').trim();
  if (!reason) throw Object.assign(new Error('سبب طلب تعديل المواعيد إلزامي.'), { statusCode: 400 });
  const rawLines = Array.isArray(data.lines) ? data.lines : [];
  const lineMap = new Map();
  for (const l of rawLines) {
    const detailId = intValue(l.transactionDetailId ?? l.TransactionDetailId);
    if (detailId > 0) lineMap.set(detailId, l);
  }
  const inputLines = [...lineMap.values()].map((l) => {
    const norm = dates.normalizeLineDate(l.proposedDate ?? l.ProposedDate, Boolean(l.proposedIsCustom ?? l.ProposedIsCustom));
    return { transactionDetailId: intValue(l.transactionDetailId ?? l.TransactionDetailId), proposedDate: norm.date, proposedIsCustom: norm.isCustom };
  });
  const proposedDueDate = data.proposedDueDate ? dates.dateOnly(data.proposedDueDate) : null;
  if (!proposedDueDate && inputLines.length === 0) {
    throw Object.assign(new Error('برجاء إدخال تعديل واحد على الأقل: تاريخ كلي جديد للفاتورة أو موعد جديد لبند.'), { statusCode: 400 });
  }
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const factory = () => transaction.request();
  try {
    const txResult = await factory().input('id', sql.Int, id).query(`
      SELECT TransactionID, ReferenceNumber, TransactionType, InvoiceStatus, IsDelivered, PartyID
      FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id
    `);
    const inv = txResult.recordset[0];
    if (!inv) throw Object.assign(new Error('الفاتورة غير موجودة.'), { statusCode: 404 });
    if (inv.InvoiceStatus === 'Cancelled') throw Object.assign(new Error('لا يمكن طلب تعديل مواعيد لفاتورة ملغية.'), { statusCode: 409 });
    if (inv.TransactionType !== 'Sale') throw Object.assign(new Error('طلبات تعديل المواعيد متاحة لفواتير البيع فقط.'), { statusCode: 400 });
    if (inv.IsDelivered) throw Object.assign(new Error('الفاتورة مكتملة التسليم — لا حاجة لتعديل مواعيدها.'), { statusCode: 409 });

    const pending = await factory().input('id', sql.Int, id).query(`
      SELECT TOP 1 Id FROM DeliveryScheduleChangeRequests WHERE TransactionId = @id AND Status = 'Pending'
    `);
    if (pending.recordset[0]) throw Object.assign(new Error('يوجد طلب تعديل مواعيد معلّق بالفعل لهذه الفاتورة — بانتظار قرار المدير أو مدير الحسابات.'), { statusCode: 409 });

    const detailsResult = await factory().input('id', sql.Int, id).query(`
      SELECT DetailID FROM TransactionDetails WHERE TransactionID = @id
    `);
    const detailIds = new Set(detailsResult.recordset.map((d) => Number(d.DetailID)));
    if (inputLines.some((l) => !detailIds.has(l.transactionDetailId))) {
      throw Object.assign(new Error('أحد البنود المقترحة لا يخص هذه الفاتورة.'), { statusCode: 400 });
    }
    // Completed lines cannot be rescheduled (open = invoiced - accepted - settled)
    try {
      const state = await loadDeliveryState(factory, id);
      for (const l of inputLines) {
        const detail = state.details.find((d) => Number(d.DetailID) === l.transactionDetailId);
        if (!detail) continue;
        const open = num(detail.InvoicedQty) - (state.acceptedByDetail.get(l.transactionDetailId) || 0) - (state.settledByDetail.get(l.transactionDetailId) || 0);
        if (open <= QTY_EPSILON) throw Object.assign(new Error(`البند «${detail.ProductName}» اكتمل تسليمه — لا يمكن تعديل موعده.`), { statusCode: 409 });
      }
      if (state.eventCount > 0) {
        const totalOpen = state.details.reduce((sum, d) => sum + num(d.InvoicedQty) - (state.acceptedByDetail.get(Number(d.DetailID)) || 0) - (state.settledByDetail.get(Number(d.DetailID)) || 0), 0);
        if (totalOpen <= QTY_EPSILON) throw Object.assign(new Error('الفاتورة مكتملة التسليم — لا حاجة لتعديل مواعيدها.'), { statusCode: 409 });
      }
    } catch (error) {
      if (!isMissingStorageError(error)) throw error;
    }

    const requesterName = auth.fullName || auth.username;
    const insertResult = await factory()
      .input('id', sql.Int, id)
      .input('user', sql.NVarChar(100), auth.username)
      .input('name', sql.NVarChar(150), requesterName)
      .input('reason', sql.NVarChar(1000), reason.slice(0, 1000))
      .input('due', sql.Date, proposedDueDate)
      .query(`
        INSERT INTO DeliveryScheduleChangeRequests (TransactionId, RequesterUserName, RequesterName, Reason, ProposedDueDate, Status, CreatedAt)
        OUTPUT INSERTED.Id
        VALUES (@id, @user, @name, @reason, @due, 'Pending', GETDATE())
      `);
    const requestId = insertResult.recordset[0].Id;
    for (const l of inputLines) {
      await factory()
        .input('rid', sql.Int, requestId)
        .input('detailId', sql.Int, l.transactionDetailId)
        .input('pdate', sql.Date, l.proposedDate)
        .input('pcustom', sql.Bit, l.proposedIsCustom ? 1 : 0)
        .query(`
          INSERT INTO DeliveryScheduleChangeRequestLines (RequestId, TransactionDetailId, ProposedDate, ProposedIsCustom)
          VALUES (@rid, @detailId, @pdate, @pcustom)
        `);
    }
    await insertAudit(transaction, {
      id, action: 'DeliveryScheduleChangeRequested', username: auth.username,
      newData: { RequestId: requestId, Reason: reason, ProposedDueDate: proposedDueDate, Lines: inputLines },
    });
    await transaction.commit();
    return { success: true, message: 'تم إرسال طلب تعديل المواعيد للمدير ومدير الحسابات — سيصلك إشعار عند البتّ فيه.', RequestId: requestId, TransactionID: id, ReferenceNumber: inv.ReferenceNumber };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    if (isMissingStorageError(error)) throw Object.assign(new Error(MISSING_SCHEDULE_MSG), { statusCode: 400 });
    throw error;
  }
}

async function withdrawScheduleChangeRequest(requestId, auth) {
  const rid = assertId(requestId, 'معرّف الطلب');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const factory = () => transaction.request();
  try {
    const result = await factory().input('rid', sql.Int, rid).query(`
      SELECT Id, TransactionId, RequesterUserName, Status FROM DeliveryScheduleChangeRequests WITH (UPDLOCK, HOLDLOCK) WHERE Id = @rid
    `);
    const reqRow = result.recordset[0];
    if (!reqRow) throw Object.assign(new Error('الطلب غير موجود.'), { statusCode: 404 });
    if (String(reqRow.RequesterUserName).toLowerCase() !== String(auth.username).toLowerCase()) {
      throw Object.assign(new Error('سحب الطلب متاح لصاحبه فقط.'), { statusCode: 403 });
    }
    if (reqRow.Status !== 'Pending') throw Object.assign(new Error('لا يمكن سحب طلب سبق البتّ فيه.'), { statusCode: 409 });
    await factory().input('rid', sql.Int, rid).query(`UPDATE DeliveryScheduleChangeRequests SET Status = 'Withdrawn' WHERE Id = @rid`);
    await insertAudit(transaction, { id: reqRow.TransactionId, action: 'DeliveryScheduleChangeWithdrawn', username: auth.username, newData: { RequestId: rid } });
    await transaction.commit();
    return { success: true, message: 'تم سحب طلب تعديل المواعيد.', RequestId: rid, TransactionID: reqRow.TransactionId };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    if (isMissingStorageError(error)) throw Object.assign(new Error(MISSING_SCHEDULE_MSG), { statusCode: 400 });
    throw error;
  }
}

async function getScheduleChangeApprovalData(requestId, auth) {
  if (!maintPerms.canDecideSchedule(auth)) {
    throw Object.assign(new Error('شاشة الاعتماد متاحة للمدير ومدير الحسابات فقط.'), { statusCode: 403 });
  }
  const rid = assertId(requestId, 'معرّف الطلب');
  const pool = await connectDB();
  try {
    const reqResult = await pool.request().input('rid', sql.Int, rid).query(`
      SELECT r.Id, r.TransactionId, r.RequesterUserName, r.RequesterName, r.Reason, r.ProposedDueDate,
             r.Status, r.CreatedAt, r.DecidedBy, r.DecidedAt, r.DecisionNote,
             t.ReferenceNumber, t.DueDate AS CurrentDueDate, t.TransactionDate, p.PartyName
      FROM DeliveryScheduleChangeRequests r
      INNER JOIN Transactions t ON t.TransactionID = r.TransactionId
      LEFT JOIN Parties p ON p.PartyID = t.PartyID
      WHERE r.Id = @rid
    `);
    const reqRow = reqResult.recordset[0];
    if (!reqRow) return null;
    const linesResult = await pool.request().input('rid', sql.Int, rid).query(`
      SELECT l.TransactionDetailId, l.ProposedDate, l.ProposedIsCustom, pr.ProductName
      FROM DeliveryScheduleChangeRequestLines l
      LEFT JOIN TransactionDetails td ON td.DetailID = l.TransactionDetailId
      LEFT JOIN Products pr ON pr.ProductID = td.ProductID
      WHERE l.RequestId = @rid ORDER BY l.Id
    `);
    reqRow.Lines = linesResult.recordset;
    const detailsResult = await pool.request().input('id', sql.Int, reqRow.TransactionId).query(`
      SELECT td.DetailID, td.Quantity, td.DeliveryDate, td.DeliveryDateIsCustom, pr.ProductName
      FROM TransactionDetails td LEFT JOIN Products pr ON pr.ProductID = td.ProductID
      WHERE td.TransactionID = @id ORDER BY td.DetailID
    `);
    let state = null;
    try { state = await loadDeliveryState(() => pool.request(), reqRow.TransactionId); } catch (error) { if (!isMissingStorageError(error)) throw error; }
    // Approval screen shows REAL current schedule (deciders see real dates)
    reqRow.CurrentLines = detailsResult.recordset.map((d) => {
      const isCustom = Boolean(d.DeliveryDateIsCustom) && Boolean(d.DeliveryDate);
      const open = state ? num(d.Quantity) - (state.acceptedByDetail.get(Number(d.DetailID)) || 0) - (state.settledByDetail.get(Number(d.DetailID)) || 0) : num(d.Quantity);
      return {
        TransactionDetailId: Number(d.DetailID), ProductName: d.ProductName || '',
        CurrentDate: dates.effectiveLineDate(d.DeliveryDate, isCustom, reqRow.CurrentDueDate),
        CurrentIsCustom: isCustom, RemainingQty: round3(open),
      };
    });
    return { Request: reqRow, PartyName: reqRow.PartyName, ReferenceNumber: reqRow.ReferenceNumber, CurrentDueDate: reqRow.CurrentDueDate, CurrentLines: reqRow.CurrentLines };
  } catch (error) {
    if (isMissingStorageError(error)) throw Object.assign(new Error(MISSING_SCHEDULE_MSG), { statusCode: 400 });
    throw error;
  }
}

async function decideScheduleChangeRequest(requestId, data = {}, auth) {
  if (!maintPerms.canDecideSchedule(auth)) {
    throw Object.assign(new Error('البتّ في طلبات تعديل المواعيد متاح للمدير ومدير الحسابات فقط.'), { statusCode: 403 });
  }
  const rid = assertId(requestId, 'معرّف الطلب');
  const approve = data.approve === true;
  const note = data.note ? String(data.note).trim() : null;
  if (!approve && !note) throw Object.assign(new Error('سبب الرفض إلزامي عند رفض طلب تعديل المواعيد.'), { statusCode: 400 });
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const factory = () => transaction.request();
  try {
    const reqResult = await factory().input('rid', sql.Int, rid).query(`
      SELECT Id, TransactionId, RequesterUserName, Status FROM DeliveryScheduleChangeRequests WITH (UPDLOCK, HOLDLOCK) WHERE Id = @rid
    `);
    const reqRow = reqResult.recordset[0];
    if (!reqRow) throw Object.assign(new Error('الطلب غير موجود.'), { statusCode: 404 });
    if (reqRow.Status !== 'Pending') throw Object.assign(new Error('هذا الطلب سبق البتّ فيه — لا يمكن اعتماده أو رفضه مرة أخرى.'), { statusCode: 409 });
    const invResult = await factory().input('id', sql.Int, reqRow.TransactionId).query(`
      SELECT TransactionID, ReferenceNumber, InvoiceStatus, DueDate, EmpId FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id
    `);
    const invoice = invResult.recordset[0];
    if (!invoice) throw Object.assign(new Error('الفاتورة غير موجودة.'), { statusCode: 404 });
    if (invoice.InvoiceStatus === 'Cancelled') throw Object.assign(new Error('الفاتورة أُلغيت بعد تقديم الطلب — لا يمكن البتّ في الطلب الآن؛ يمكن لصاحبه سحبه.'), { statusCode: 409 });

    if (!approve) {
      await factory().input('rid', sql.Int, rid).input('user', sql.NVarChar(100), auth.username).input('note', sql.NVarChar(1000), note.slice(0, 1000)).query(`
        UPDATE DeliveryScheduleChangeRequests SET Status = 'Rejected', DecidedBy = @user, DecidedAt = GETDATE(), DecisionNote = @note WHERE Id = @rid
      `);
      await insertAudit(transaction, { id: reqRow.TransactionId, action: 'DeliveryScheduleChangeRejected', username: auth.username, newData: { RequestId: rid, Reason: note } });
      await transaction.commit();
      return { success: true, message: 'تم رفض طلب تعديل المواعيد وإشعار صاحبه بسبب الرفض.', RequestId: rid, TransactionID: reqRow.TransactionId, ReferenceNumber: invoice.ReferenceNumber, RequesterUserName: reqRow.RequesterUserName, DecisionNote: note, Approved: false };
    }

    const proposalLines = await factory().input('rid', sql.Int, rid).query(`
      SELECT TransactionDetailId, ProposedDate, ProposedIsCustom FROM DeliveryScheduleChangeRequestLines WHERE RequestId = @rid
    `);
    const proposalIds = new Set(proposalLines.recordset.map((l) => Number(l.TransactionDetailId)));
    const finalMap = new Map();
    for (const l of (Array.isArray(data.finalLines) ? data.finalLines : [])) {
      const detailId = intValue(l.transactionDetailId ?? l.TransactionDetailId);
      if (detailId > 0) finalMap.set(detailId, l);
    }
    // Default finals = proposal when the decider sent none for a line
    if (finalMap.size === 0 && !data.finalDueDate) {
      for (const p of proposalLines.recordset) {
        finalMap.set(Number(p.TransactionDetailId), { finalDate: p.ProposedDate, finalIsCustom: p.ProposedIsCustom });
      }
    }
    const finals = [...finalMap.entries()].map(([detailId, l]) => ({ transactionDetailId: detailId, ...dates.normalizeLineDate(l.finalDate ?? l.FinalDate, Boolean(l.finalIsCustom ?? l.FinalIsCustom)) }));
    // normalizeLineDate returns {date, isCustom}; adapt keys
    const finalLinesNorm = finals.map((f) => ({ transactionDetailId: f.transactionDetailId, date: f.date, isCustom: f.isCustom }));
    if (finalLinesNorm.some((l) => !proposalIds.has(l.transactionDetailId))) {
      throw Object.assign(new Error('أحد بنود القرار لم يكن ضمن بنود الطلب الأصلي — أعد فتح الطلب.'), { statusCode: 400 });
    }
    const finalDueDate = data.finalDueDate ? dates.dateOnly(data.finalDueDate) : null;
    if (!finalDueDate && finalLinesNorm.length === 0) {
      throw Object.assign(new Error('لا توجد قيم نهائية لتطبيقها — حدّد تاريخًا كليًا أو بندًا واحدًا على الأقل.'), { statusCode: 400 });
    }
    const detailsResult = await factory().input('id', sql.Int, reqRow.TransactionId).query(`
      SELECT DetailID, DeliveryDate, DeliveryDateIsCustom FROM TransactionDetails WHERE TransactionID = @id
    `);
    const detailById = new Map(detailsResult.recordset.map((d) => [Number(d.DetailID), d]));
    if (finalLinesNorm.some((l) => !detailById.has(l.transactionDetailId))) {
      throw Object.assign(new Error('أحد بنود الطلب لم يعد ضمن بنود الفاتورة الحالية — لا يمكن تطبيق القرار.'), { statusCode: 400 });
    }
    const headerBefore = invoice.DueDate;
    const lineChanges = [];
    if (finalDueDate) {
      await factory().input('id', sql.Int, reqRow.TransactionId).input('due', sql.Date, finalDueDate).query(`
        UPDATE Transactions SET DueDate = @due WHERE TransactionID = @id
      `);
    }
    for (const f of finalLinesNorm) {
      const d = detailById.get(f.transactionDetailId);
      if (dates.dateOnly(d.DeliveryDate)?.getTime() === (f.date ? f.date.getTime() : undefined) && Boolean(d.DeliveryDateIsCustom) === f.isCustom) continue;
      lineChanges.push({ DetailId: f.transactionDetailId, BeforeDate: d.DeliveryDate, BeforeCustom: Boolean(d.DeliveryDateIsCustom), AfterDate: f.date, AfterCustom: f.isCustom });
      await factory().input('detailId', sql.Int, f.transactionDetailId).input('ddate', sql.Date, f.date).input('dcustom', sql.Bit, f.isCustom ? 1 : 0).query(`
        UPDATE TransactionDetails SET DeliveryDate = @ddate, DeliveryDateIsCustom = @dcustom WHERE DetailID = @detailId
      `);
    }
    await factory().input('rid', sql.Int, rid).input('user', sql.NVarChar(100), auth.username).input('note', sql.NVarChar(1000), note ? note.slice(0, 1000) : null).query(`
      UPDATE DeliveryScheduleChangeRequests SET Status = 'Approved', DecidedBy = @user, DecidedAt = GETDATE(), DecisionNote = @note WHERE Id = @rid
    `);
    await insertAudit(transaction, {
      id: reqRow.TransactionId, action: 'DeliveryScheduleChangeApproved', username: auth.username,
      oldData: { DueDate: headerBefore, Lines: lineChanges.map((c) => ({ DetailId: c.DetailId, Date: c.BeforeDate, IsCustom: c.BeforeCustom })) },
      newData: { RequestId: rid, DueDate: finalDueDate || headerBefore, Lines: lineChanges.map((c) => ({ DetailId: c.DetailId, Date: c.AfterDate, IsCustom: c.AfterCustom })) },
    });
    await transaction.commit();
    let salesUsername = null;
    if (invoice.EmpId) {
      try {
        const su = await pool.request().input('empId', sql.Int, invoice.EmpId).query('SELECT TOP 1 Username FROM Users WHERE employeeID = @empId AND IsActive = 1 ORDER BY UserID');
        salesUsername = su.recordset[0]?.Username || null;
      } catch (_) { salesUsername = null; }
    }
    return { success: true, message: 'تم اعتماد الطلب وتطبيق المواعيد النهائية على الفاتورة وبنودها.', RequestId: rid, TransactionID: reqRow.TransactionId, ReferenceNumber: invoice.ReferenceNumber, RequesterUserName: reqRow.RequesterUserName, DecisionNote: note, Approved: true, salesUsername };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    if (isMissingStorageError(error)) throw Object.assign(new Error(MISSING_SCHEDULE_MSG), { statusCode: 400 });
    throw error;
  }
}

// Attach pending schedule-change chip state to list rows (batch, degrades
// to no chip when the schedule-request tables are missing).
async function attachSchedulePending(pool, rows) {
  if (!rows.length) return;
  try {
    const ids = rows.map((r) => Number(r.TransactionID));
    const request = pool.request();
    const inList = bindIdList(request, 'scp', ids);
    const result = await request.query(`
      SELECT Id, TransactionId, RequesterUserName, RequesterName, CreatedAt
      FROM DeliveryScheduleChangeRequests
      WHERE Status = 'Pending' AND TransactionId IN ${inList}
      ORDER BY CreatedAt DESC, Id DESC
    `);
    const byTx = new Map();
    for (const row of result.recordset) {
      const k = Number(row.TransactionId);
      if (!byTx.has(k)) byTx.set(k, row);
    }
    for (const row of rows) {
      const pending = byTx.get(Number(row.TransactionID));
      row.HasPendingScheduleChangeRequest = Boolean(pending);
      row.ScheduleChangeRequestId = pending ? Number(pending.Id) : null;
      row.ScheduleChangeRequestedBy = pending ? (pending.RequesterName || pending.RequesterUserName) : null;
      row.ScheduleChangeRequestedAt = pending ? pending.CreatedAt : null;
    }
  } catch (error) {
    if (!isMissingStorageError(error)) throw error;
    for (const row of rows) { row.HasPendingScheduleChangeRequest = false; row.ScheduleChangeRequestId = null; }
  }
}

// Mirror of Blazor GetAppointmentsDueOnAsync (SalesDeliveryStatusService.cs:893):
// open appointments whose DISPLAY date for the given class equals target.
async function getAppointmentsDueOn(targetDisplayedDate, seesRealDate) {
  const pool = await connectDB();
  const target = dates.dateOnly(targetDisplayedDate);
  if (!target) return [];
  const buffer = dates.dateBufferDays();
  const windowFrom = dates.addDays(target, -1);
  const windowTo = dates.addDays(target, buffer + 2);
  const candResult = await pool.request().input('from', sql.Date, windowFrom).input('to', sql.Date, windowTo).query(`
    SELECT t.TransactionID, t.ReferenceNumber, t.TransactionDate, t.DueDate, t.PartyID, p.PartyName AS ClientName
    FROM Transactions t INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionType = 'Sale' AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND ISNULL(t.IsDelivered, 0) = 0 AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%')
      AND ((t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) BETWEEN @from AND @to)
        OR EXISTS (SELECT 1 FROM TransactionDetails td WHERE td.TransactionID = t.TransactionID
          AND td.DeliveryDateIsCustom = 1 AND td.DeliveryDate IS NOT NULL AND CAST(td.DeliveryDate AS DATE) BETWEEN @from AND @to))
  `);
  const candidates = candResult.recordset;
  if (!candidates.length) return [];
  const ids = candidates.map((c) => Number(c.TransactionID));
  const candById = new Map(candidates.map((c) => [Number(c.TransactionID), c]));
  const linesRequest = pool.request();
  const linesIn = bindIdList(linesRequest, 'duo', ids);
  const linesResult = await linesRequest.query(`
    SELECT TransactionID, DetailID, Quantity, DeliveryDate, DeliveryDateIsCustom FROM TransactionDetails WHERE TransactionID IN ${linesIn}
  `);
  const acceptedByDetail = new Map(); const settledByDetail = new Map();
  try {
    const accRequest = pool.request(); const accIn = bindIdList(accRequest, 'dua', ids);
    const accResult = await accRequest.query(`
      SELECT idl.TransactionId, idi.TransactionDetailId, COALESCE(SUM(idi.AcceptedQty), 0) AS AcceptedQty
      FROM InvoiceDeliveryItems idi JOIN InvoiceDeliveries idl ON idl.DeliveryId = idi.DeliveryId
      WHERE idl.IsVoided = 0 AND idl.TransactionId IN ${accIn} GROUP BY idl.TransactionId, idi.TransactionDetailId
    `);
    for (const row of accResult.recordset) acceptedByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.AcceptedQty));
    const setRequest = pool.request(); const setIn = bindIdList(setRequest, 'dus', ids);
    const setResult = await setRequest.query(`
      SELECT TransactionId, TransactionDetailId, COALESCE(SUM(Quantity), 0) AS SettledQty FROM DeliveryMaintenanceItems
      WHERE IsVoided = 0 AND Status = '${MAINTENANCE_SETTLED}' AND TransactionId IN ${setIn} GROUP BY TransactionId, TransactionDetailId
    `);
    for (const row of setResult.recordset) settledByDetail.set(`${row.TransactionId}:${row.TransactionDetailId}`, num(row.SettledQty));
  } catch (error) { if (!isMissingTableError(error)) throw error; }
  const groups = new Map();
  for (const line of linesResult.recordset) {
    const txId = Number(line.TransactionID); const cand = candById.get(txId); if (!cand) continue;
    const remaining = num(line.Quantity) - (acceptedByDetail.get(`${txId}:${line.DetailID}`) || 0) - (settledByDetail.get(`${txId}:${line.DetailID}`) || 0);
    if (remaining <= QTY_EPSILON) continue;
    const isCustom = Boolean(line.DeliveryDateIsCustom) && Boolean(line.DeliveryDate);
    const effective = dates.effectiveLineDate(line.DeliveryDate, isCustom, cand.DueDate);
    if (!effective || effective < windowFrom || effective > windowTo) continue;
    const key = `${txId}:${effective.toISOString().slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, { cand, realDate: effective, lineCount: 0, remainingQty: 0 });
    const g = groups.get(key); g.lineCount += 1; g.remainingQty = round3(g.remainingQty + remaining);
  }
  const out = [];
  for (const g of groups.values()) {
    const shown = dates.displayDate(g.realDate, g.cand.TransactionDate, seesRealDate, buffer);
    if (!shown || shown.getTime() !== target.getTime()) continue;
    out.push({
      TransactionID: Number(g.cand.TransactionID), ReferenceNumber: g.cand.ReferenceNumber,
      PartyName: g.cand.ClientName, RealDate: g.realDate, DisplayDate: shown,
      DueLineCount: g.lineCount, RemainingQty: g.remainingQty,
    });
  }
  out.sort((a, b) => String(a.PartyName || '').localeCompare(String(b.PartyName || '')));
  return out;
}


module.exports = {
  ACTION_PERMISSION_REQUEST,
  ACTION_PERMISSION_GRANTED,
  ACTION_EVENT_RECORDED,
  ACTION_EVENT_VOIDED,
  getDeliveries,
  getDeliveryStats,
  getDeliveryDetails,
  getDeliveryEmployees,
  getDeliveryEvents,
  getBatchCoverage,
  recordDeliveryEvent,
  voidDeliveryEvent,
  markAsDelivered,
  updateDeliveryDetails,
  requestDeliveryPermission,
  grantDeliveryPermission,
  getDailySheet,
  getUpcomingDeliveries,
  getHomeUpcomingDeliveries,
  maintPerms,
  getMaintenanceQueue,
  transitionMaintenance,
  getScheduleChangeRequests,
  createScheduleChangeRequest,
  withdrawScheduleChangeRequest,
  getScheduleChangeApprovalData,
  decideScheduleChangeRequest,
  getAppointmentsDueOn,
};
