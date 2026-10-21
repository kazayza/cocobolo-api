const { sql, connectDB } = require('../../core/database');

const ACTION_PERMISSION_REQUEST = 'DeliveryPermissionRequest';
const ACTION_PERMISSION_GRANTED = 'DeliveryPermissionGranted';
const SQL_INT_MAX = 2147483647;

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

async function getDeliveries(filters = {}) {
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

async function getDeliveryDetails(value) {
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
             alt.AlternativeName, alt.SpecificationSummary
      FROM TransactionDetails d
      INNER JOIN Products p ON d.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives alt
        ON d.SelectedAlternativeID = alt.AlternativeID
      WHERE d.TransactionID = @id
      ORDER BY d.DetailID
    `);
  return { ...header, Products: itemsResult.recordset };
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

async function markAsDelivered(value, data, auth, { canOverrideRemaining = false } = {}) {
  const id = assertId(value, 'معرّف الفاتورة');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT t.TransactionID, t.ReferenceNumber, t.TransactionType,
               t.InvoiceStatus, t.IsDelivered, t.DeliveredAt, t.DeliveredNotes,
               t.DeliveryEmployeeId, t.DeliveryEmployeeName,
               t.PartyID, p.PartyName,
               t.GrandTotal, t.PaidAmount
        FROM Transactions t WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN Parties p ON t.PartyID = p.PartyID
        WHERE t.TransactionID = @id
      `);
    const current = currentResult.recordset[0];
    if (!current || current.TransactionType !== 'Sale') {
      throw Object.assign(new Error('فاتورة البيع غير موجودة'), { statusCode: 404 });
    }
    if (current.InvoiceStatus === 'Cancelled') {
      throw Object.assign(new Error('لا يمكن تسليم فاتورة ملغية'), { statusCode: 409 });
    }
    if (current.IsDelivered === true || current.IsDelivered === 1) {
      throw Object.assign(new Error('تم تسليم هذه الفاتورة بالفعل'), { statusCode: 409 });
    }

    const remaining = Number(current.GrandTotal || 0) - Number(current.PaidAmount || 0);
    let approvalNote = null;
    if (remaining > 0.005) {
      if (canOverrideRemaining) {
        approvalNote = `تم التسليم بموافقة ${auth.username} رغم وجود مبلغ متبقٍ`;
      } else {
        const latest = await latestPermissionAction(transaction, id);
        if (!latest || latest.ActionType !== ACTION_PERMISSION_GRANTED) {
          throw Object.assign(
            new Error('لا يمكن التسليم لوجود مبلغ متبقٍ. اطلب إذن التسليم أولًا.'),
            { statusCode: 409, code: 'DELIVERY_PERMISSION_REQUIRED' },
          );
        }
        approvalNote = `تم التسليم بإذن ${latest.LoginName || 'الإدارة'} رغم وجود مبلغ متبقٍ`;
      }
    }

    const employee = await resolveDeliveryEmployee(
      transaction,
      auth,
      data.deliveryEmployeeId,
      data.deliveryEmployeeName,
    );
    const rawNotes = String(data.deliveredNotes || data.notes || '').trim();
    const notes = [rawNotes || null, approvalNote].filter(Boolean).join(' — ') || null;

    await transaction.request()
      .input('id', sql.Int, id)
      .input('employeeId', sql.Int, employee.employeeId)
      .input('employeeName', sql.NVarChar(200), employee.employeeName)
      .input('notes', sql.NVarChar(1000), notes)
      .query(`
        UPDATE Transactions
        SET IsDelivered = 1,
            DeliveredAt = GETDATE(),
            DeliveredNotes = @notes,
            DeliveryEmployeeId = COALESCE(@employeeId, DeliveryEmployeeId),
            DeliveryEmployeeName = COALESCE(@employeeName, DeliveryEmployeeName)
        WHERE TransactionID = @id
      `);

    await insertAudit(transaction, {
      id,
      action: 'UpdateDeliveryStatus',
      username: auth.username,
      oldData: {
        IsDelivered: current.IsDelivered,
        DeliveredAt: current.DeliveredAt,
        DeliveredNotes: current.DeliveredNotes,
        DeliveryEmployeeId: current.DeliveryEmployeeId,
      },
      newData: {
        IsDelivered: true,
        DeliveryEmployeeId: employee.employeeId,
        DeliveryEmployeeName: employee.employeeName,
        DeliveredNotes: notes,
        RemainingAtDelivery: remaining,
      },
    });

    await transaction.commit();
    return {
      TransactionID: id,
      ReferenceNumber: current.ReferenceNumber,
      PartyID: current.PartyID,
      PartyName: current.PartyName,
      RemainingAmount: remaining,
      DeliveryEmployeeId: employee.employeeId,
      DeliveryEmployeeName: employee.employeeName,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function updateDeliveryDetails(
  value,
  data,
  auth,
  { canOverrideRemaining = false } = {},
) {
  const id = assertId(value, 'معرّف الفاتورة');
  const status = String(data.status || 'pending').toLowerCase();
  if (status === 'delivered') {
    return markAsDelivered(id, data, auth, { canOverrideRemaining });
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
    const rawNotes = String(data.notes || data.deliveredNotes || '').trim();
    const notes = status === 'returned'
      ? `مرتجع: ${rawNotes || 'تم تسجيل الفاتورة كمرتجع'}`
      : (rawNotes || null);

    await transaction.request()
      .input('id', sql.Int, id)
      .input('employeeId', sql.Int, employee.employeeId)
      .input('employeeName', sql.NVarChar(200), employee.employeeName)
      .input('notes', sql.NVarChar(1000), notes)
      .query(`
        UPDATE Transactions
        SET IsDelivered = 0,
            DeliveredAt = NULL,
            DeliveredNotes = @notes,
            DeliveryEmployeeId = @employeeId,
            DeliveryEmployeeName = @employeeName
        WHERE TransactionID = @id
      `);
    await insertAudit(transaction, {
      id,
      action: 'UpdateDeliveryStatus',
      username: auth.username,
      oldData: current,
      newData: {
        RequestedStatus: status,
        DeliveryEmployeeId: employee.employeeId,
        DeliveryEmployeeName: employee.employeeName,
        DeliveredNotes: notes,
      },
    });
    await transaction.commit();
    return { TransactionID: id, status };
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

async function getDailySheet(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, { ...filters, status: 'pending' });
  const result = await request.query(`
    SELECT TOP 500 t.TransactionID, t.ReferenceNumber, p.PartyName,
           p.Phone, p.Address, t.DueDate,
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

async function getUpcomingDeliveries() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT TOP 200 t.TransactionID, t.ReferenceNumber, t.DueDate,
           t.PartyID, p.PartyName AS ClientName, p.Phone,
           DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) AS DaysRemaining
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionType = 'Sale'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND ISNULL(t.IsDelivered, 0) = 0
      AND t.DueDate IS NOT NULL
      AND DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) BETWEEN 0 AND 7
    ORDER BY t.DueDate, t.TransactionID
  `);
  return result.recordset;
}

module.exports = {
  ACTION_PERMISSION_REQUEST,
  ACTION_PERMISSION_GRANTED,
  getDeliveries,
  getDeliveryStats,
  getDeliveryDetails,
  getDeliveryEmployees,
  markAsDelivered,
  updateDeliveryDetails,
  requestDeliveryPermission,
  grantDeliveryPermission,
  getDailySheet,
  getUpcomingDeliveries,
};
