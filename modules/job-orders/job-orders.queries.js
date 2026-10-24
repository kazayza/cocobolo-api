const { sql, connectDB } = require('../../core/database');

const intValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

function buildWhere(request, filters = {}, options = {}) {
  const clauses = [
    `(t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')`,
    `(
      t.TransactionType = 'Sale'
      OR (t.TransactionType = 'Purchase' AND t.ReferenceType = 'PurchaseInvoice')
    )`,
  ];
  if (filters.type === 'sale') clauses.push(`t.TransactionType = 'Sale'`);
  if (filters.type === 'purchase') clauses.push(`t.TransactionType = 'Purchase'`);
  if (filters.delivery === 'delivered') clauses.push('t.IsDelivered = 1');
  else if (filters.delivery !== 'all') clauses.push('ISNULL(t.IsDelivered, 0) = 0');
  if (filters.dueFrom) {
    request.input('dueFrom', sql.Date, filters.dueFrom);
    clauses.push('CAST(t.DueDate AS DATE) >= @dueFrom');
  }
  if (filters.dueTo) {
    request.input('dueTo', sql.Date, filters.dueTo);
    clauses.push('CAST(t.DueDate AS DATE) <= @dueTo');
  }
  if (filters.due === 'overdue') {
    clauses.push(`t.DueDate IS NOT NULL AND t.DueDate < CAST(GETDATE() AS DATE) AND ISNULL(t.IsDelivered, 0) = 0`);
  } else if (filters.due === 'today') {
    clauses.push(`CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)`);
  } else if (filters.due === 'week') {
    clauses.push(`t.DueDate >= CAST(GETDATE() AS DATE) AND t.DueDate < DATEADD(DAY, 7, CAST(GETDATE() AS DATE))`);
  }
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    clauses.push(`(
      t.ReferenceNumber LIKE @search OR p.PartyName LIKE @search
      OR p.Phone LIKE @search OR CAST(t.TransactionID AS NVARCHAR(30)) LIKE @search
    )`);
  }
  if (options.excludeProtectedAccountManager) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM Users creator
      WHERE creator.Username = t.CreatedBy AND creator.Role = N'AccountManager'
    )`);
  }
  return clauses.map((clause) => `(${clause})`).join(' AND ');
}

async function getJobOrders(filters = {}, options = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, filters, options);
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 30), 1), 100);
  const offset = (page - 1) * limit;
  const result = await request.query(`
    SELECT
      t.TransactionID, t.PartyID, t.ReferenceNumber, t.ReferenceType, t.TransactionType,
      t.TransactionDate, t.DueDate, ISNULL(t.IsDelivered, 0) AS IsDelivered,
      t.InvoiceStatus, t.EmpId, t.GrandTotal, t.CreatedBy,
      p.PartyName, p.Phone,
      CASE WHEN t.TransactionType = 'Purchase'
        THEN linkedCustomer.PartyName ELSE e.FullName END AS EmpName,
      linkedCustomer.PartyID AS LinkedCustomerID,
      linkedCustomer.PartyName AS LinkedCustomerName,
      linkedCustomer.Phone AS LinkedCustomerPhone,
      ISNULL(counts.ItemsCount, 0) AS ItemsCount,
      ISNULL(counts.AlternativeItemsCount, 0) AS AlternativeItemsCount,
      ISNULL(counts.MaxPeriodDays, 0) AS MaxPeriodDays,
      COUNT(*) OVER() AS TotalRows
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN Employees e ON t.EmpId = e.EmployeeID
    LEFT JOIN Parties linkedCustomer
      ON t.TransactionType = 'Purchase' AND t.EmpId = linkedCustomer.PartyID
    OUTER APPLY (
      SELECT COUNT(*) AS ItemsCount,
             SUM(CASE WHEN d.SelectedAlternativeID IS NOT NULL THEN 1 ELSE 0 END) AS AlternativeItemsCount,
             MAX(COALESCE(a.Period, pr.Period, 0)) AS MaxPeriodDays
      FROM TransactionDetails d
      INNER JOIN Products pr ON d.ProductID = pr.ProductID
      LEFT JOIN ProductFactoryAlternatives a
        ON d.SelectedAlternativeID = a.AlternativeID
      WHERE d.TransactionID = t.TransactionID
    ) counts
    WHERE ${where}
    ORDER BY CASE WHEN t.DueDate IS NULL THEN 1 ELSE 0 END,
             t.DueDate, t.TransactionDate DESC, t.TransactionID DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `);
  return {
    rows: result.recordset,
    page,
    limit,
    total: result.recordset.length
      ? Number(result.recordset[0].TotalRows || 0)
      : 0,
  };
}

async function getJobOrderStats(filters = {}, options = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, filters, options);
  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 THEN 1 ELSE 0 END) AS UndeliveredCount,
      SUM(CASE WHEN t.IsDelivered = 1 THEN 1 ELSE 0 END) AS DeliveredCount,
      SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND t.DueDate < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS OverdueCount,
      SUM(CASE WHEN alternativeOrders.TransactionID IS NOT NULL THEN 1 ELSE 0 END) AS WithAlternativesCount
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN (
      SELECT DISTINCT TransactionID
      FROM TransactionDetails
      WHERE SelectedAlternativeID IS NOT NULL
    ) alternativeOrders ON alternativeOrders.TransactionID = t.TransactionID
    WHERE ${where}
  `);
  return result.recordset[0] || {};
}

async function getJobOrderById(id) {
  const pool = await connectDB();
  const headerResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        t.TransactionID, t.PartyID, t.ReferenceNumber, t.ReferenceType, t.TransactionType,
        t.TransactionDate, t.DueDate, ISNULL(t.IsDelivered, 0) AS IsDelivered,
        t.InvoiceStatus, t.EmpId, t.GrandTotal, t.Notes, t.CreatedBy,
        t.EditBy, t.EditStatus,
        p.PartyName, p.Phone, p.Address,
        CASE WHEN t.TransactionType = 'Purchase'
          THEN linkedCustomer.PartyName ELSE e.FullName END AS EmpName,
        linkedCustomer.PartyID AS LinkedCustomerID,
        linkedCustomer.PartyName AS LinkedCustomerName,
        linkedCustomer.Phone AS LinkedCustomerPhone,
        w.WarehouseName
      FROM Transactions t
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      LEFT JOIN Employees e ON t.EmpId = e.EmployeeID
      LEFT JOIN Parties linkedCustomer
        ON t.TransactionType = 'Purchase' AND t.EmpId = linkedCustomer.PartyID
      LEFT JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
      WHERE t.TransactionID = @id
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
        AND (
          t.TransactionType = 'Sale'
          OR (t.TransactionType = 'Purchase' AND t.ReferenceType = 'PurchaseInvoice')
        )
    `);
  const header = headerResult.recordset[0];
  if (!header) return null;

  const itemsResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        d.DetailID, d.ProductID, d.Quantity, d.Notes, d.PricingTier,
        d.SelectedAlternativeID,
        pr.ProductName, pr.ProductDescription,
        pr.ManufacturingDescription AS BaseManufacturingDescription,
        pr.Period AS BasePeriod, pr.PdfPath,
        CASE WHEN pr.PDFFile IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS HasOldPdf,
        alt.AlternativeName, alt.SpecificationSummary,
        alt.ManufacturingDescription AS AlternativeManufacturingDescription,
        alt.Period AS AlternativePeriod,
        altImage.ImagePath AS AlternativeImagePath,
        productImage.ProductImagesID AS MainImageId
      FROM TransactionDetails d
      INNER JOIN Products pr ON d.ProductID = pr.ProductID
      LEFT JOIN ProductFactoryAlternatives alt
        ON d.SelectedAlternativeID = alt.AlternativeID
      OUTER APPLY (
        SELECT TOP 1 ai.ImagePath
        FROM ProductFactoryAlternativeImages ai
        WHERE ai.AlternativeID = d.SelectedAlternativeID
        ORDER BY ISNULL(ai.IsPrimary, 0) DESC, ai.AlternativeImageID
      ) altImage
      OUTER APPLY (
        SELECT TOP 1 pi.ProductImagesID
        FROM ProductImages pi
        WHERE pi.ProductID = d.ProductID
        ORDER BY pi.CreatedAt DESC, pi.ProductImagesID DESC
      ) productImage
      WHERE d.TransactionID = @id
      ORDER BY d.DetailID
    `);

  return {
    ...header,
    items: itemsResult.recordset.map((item) => ({
      ...item,
      ProductDescription:
        item.SpecificationSummary || item.ProductDescription,
      ManufacturingDescription:
        item.AlternativeManufacturingDescription
        || item.BaseManufacturingDescription,
      Period: item.AlternativePeriod ?? item.BasePeriod,
    })),
  };
}

async function updateDueDate(id, dueDate, notes, username) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT TransactionID, DueDate, IsDelivered, ReferenceNumber,
               PartyID, CreatedBy
        FROM Transactions WITH (UPDLOCK, HOLDLOCK)
        WHERE TransactionID = @id
          AND (
            TransactionType = 'Sale'
            OR (TransactionType = 'Purchase' AND ReferenceType = 'PurchaseInvoice')
          )
      `);
    const current = currentResult.recordset[0];
    if (!current) {
      throw Object.assign(new Error('الفاتورة غير موجودة'), { statusCode: 404 });
    }
    if (current.IsDelivered === true || current.IsDelivered === 1) {
      throw Object.assign(
        new Error('لا يمكن تعديل تاريخ التسليم بعد تسليم الفاتورة'),
        { statusCode: 400 },
      );
    }
    await transaction.request()
      .input('id', sql.Int, id)
      .input('dueDate', sql.DateTime, dueDate ? new Date(dueDate) : null)
      .query('UPDATE Transactions SET DueDate = @dueDate WHERE TransactionID = @id');
    await transaction.request()
      .input('key', sql.NVarChar(100), String(id))
      .input('oldData', sql.NVarChar(sql.MAX), JSON.stringify({ DueDate: current.DueDate }))
      .input('newData', sql.NVarChar(sql.MAX), JSON.stringify({ DueDate: dueDate, Notes: notes || null }))
      .input('username', sql.NVarChar(100), username)
      .query(`
        INSERT INTO [dbo].[Audit_Log]
          (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
           ActionDate, LoginName, AppName, AccessUserName)
        VALUES
          (N'Transactions', N'DueDate', @key, @oldData, @newData,
           GETDATE(), @username, N'COCOBOLO Flutter', @username)
      `);
    await transaction.commit();
    return current;
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function getCompanyInfo() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT TOP 1 CompanyName, Address, Phone1, LogoPath
    FROM CompanyInfo
    ORDER BY CompanyID
  `);
  return result.recordset[0] || null;
}

module.exports = {
  getJobOrders,
  getJobOrderStats,
  getJobOrderById,
  updateDueDate,
  getCompanyInfo,
};
