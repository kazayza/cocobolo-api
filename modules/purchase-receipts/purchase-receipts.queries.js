const { sql, connectDB } = require('../../core/database');

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

function receiptStatusSql(alias = 't') {
  return `CASE
    WHEN ${alias}.IsDelivered = 1 THEN N'تم الاستلام'
    WHEN ${alias}.DueDate IS NOT NULL AND CAST(${alias}.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'متأخر'
    ELSE N'بانتظار الاستلام'
  END`;
}

function buildWhere(request, filters = {}, { includeStatus = true } = {}) {
  const clauses = [
    `t.TransactionType = 'Purchase'`,
    `t.ReferenceType = 'PurchaseInvoice'`,
    `(t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')`,
  ];
  const dateColumn = filters.dateFilterType === 'InvoiceDate'
    ? 't.TransactionDate'
    : filters.dateFilterType === 'ReceivedDate'
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
      p.PartyName LIKE @search OR p.Phone LIKE @search
      OR w.WarehouseName LIKE @search OR t.ReferenceNumber LIKE @search
      OR CAST(t.TransactionID AS NVARCHAR(30)) LIKE @search
    )`);
  }
  if (includeStatus) {
    const status = String(filters.status || '').toLowerCase();
    if (status === 'received' || filters.status === 'تم الاستلام') clauses.push(`t.IsDelivered = 1`);
    else if (status === 'overdue' || filters.status === 'متأخر') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)`);
    else if (status === 'pending' || filters.status === 'بانتظار الاستلام') clauses.push(`ISNULL(t.IsDelivered, 0) = 0 AND (t.DueDate IS NULL OR CAST(t.DueDate AS DATE) >= CAST(GETDATE() AS DATE))`);
  }
  return clauses.map((clause) => `(${clause})`).join(' AND ');
}

async function getReceipts(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 30), 1), 100);
  const offset = (page - 1) * limit;
  const where = buildWhere(request, filters);
  const result = await request.query(`
    SELECT
      t.TransactionID, t.ReferenceNumber, t.TransactionDate,
      t.PartyID AS SupplierID, p.PartyName AS SupplierName, p.Phone AS SupplierPhone,
      t.WarehouseID, w.WarehouseName, t.DueDate,
      ISNULL(t.IsDelivered, 0) AS IsDelivered, t.DeliveredAt, t.DeliveredNotes,
      t.GrandTotal, t.PaidAmount,
      ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
      ISNULL(itemCounts.ItemsCount, 0) AS ItemsCount,
      CASE WHEN t.IsDelivered = 1 OR t.DueDate IS NULL THEN NULL
           ELSE DATEDIFF(DAY, CAST(GETDATE() AS DATE), CAST(t.DueDate AS DATE)) END AS DaysRemaining,
      ${receiptStatusSql('t')} AS ReceiptStatus,
      COUNT(*) OVER() AS TotalRows
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
    OUTER APPLY (
      SELECT COUNT(*) AS ItemsCount
      FROM TransactionDetails d
      WHERE d.TransactionID = t.TransactionID
    ) itemCounts
    WHERE ${where}
    ORDER BY CASE WHEN t.IsDelivered = 1 THEN 2 ELSE 0 END,
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

async function getStats(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, filters, { includeStatus: false });
  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND (t.DueDate IS NULL OR CAST(t.DueDate AS DATE) >= CAST(GETDATE() AS DATE)) THEN 1 ELSE 0 END), 0) AS PendingCount,
      COALESCE(SUM(CASE WHEN t.IsDelivered = 1 THEN 1 ELSE 0 END), 0) AS ReceivedCount,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 AND t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS OverdueCount,
      COALESCE(SUM(ISNULL(t.GrandTotal, 0)), 0) AS TotalGrandTotal,
      COALESCE(SUM(ISNULL(t.PaidAmount, 0)), 0) AS TotalPaidAmount,
      COALESCE(SUM(ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0)), 0) AS TotalRemaining
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
    WHERE ${where}
  `);
  return result.recordset[0] || {};
}

async function getReceiptById(value) {
  const id = assertId(value, 'معرّف فاتورة الشراء');
  const pool = await connectDB();
  const headerResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        t.TransactionID, t.ReferenceNumber, t.TransactionDate,
        t.PartyID AS SupplierID, p.PartyName AS SupplierName, p.Phone AS SupplierPhone,
        p.Address AS SupplierAddress,
        t.WarehouseID, w.WarehouseName, t.DueDate,
        ISNULL(t.IsDelivered, 0) AS IsDelivered, t.DeliveredAt, t.DeliveredNotes,
        t.InvoiceStatus, t.GrandTotal, t.PaidAmount,
        ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
        ${receiptStatusSql('t')} AS ReceiptStatus
      FROM Transactions t
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
      WHERE t.TransactionID = @id
        AND t.TransactionType = 'Purchase'
        AND t.ReferenceType = 'PurchaseInvoice'
        AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
    `);
  const header = headerResult.recordset[0];
  if (!header) return null;
  const itemsResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT d.DetailID, d.ProductID, p.ProductName, d.Quantity,
             d.UnitPrice, d.TotalAmount, d.Notes
      FROM TransactionDetails d
      INNER JOIN Products p ON d.ProductID = p.ProductID
      WHERE d.TransactionID = @id
      ORDER BY d.DetailID
    `);
  return { ...header, items: itemsResult.recordset };
}

async function receivePurchase(value, data, auth) {
  const id = assertId(value, 'معرّف فاتورة الشراء');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const headerResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT t.TransactionID, t.ReferenceNumber, t.TransactionType,
               t.ReferenceType, t.InvoiceStatus, t.IsDelivered,
               t.DeliveredAt, t.DeliveredNotes, t.WarehouseID,
               t.PartyID, p.PartyName, w.WarehouseName
        FROM Transactions t WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN Parties p ON t.PartyID = p.PartyID
        INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
        WHERE t.TransactionID = @id
      `);
    const header = headerResult.recordset[0];
    if (!header || header.TransactionType !== 'Purchase') {
      throw Object.assign(new Error('فاتورة الشراء غير موجودة'), { statusCode: 404 });
    }
    if (header.ReferenceType !== 'PurchaseInvoice') {
      throw Object.assign(new Error('فاتورة الشراء المرآة لا تُستلم يدويًا'), { statusCode: 409 });
    }
    if (header.InvoiceStatus === 'Cancelled') {
      throw Object.assign(new Error('لا يمكن استلام فاتورة شراء ملغية'), { statusCode: 409 });
    }
    if (header.IsDelivered === true || header.IsDelivered === 1) {
      throw Object.assign(new Error('تم استلام هذه الفاتورة بالفعل'), { statusCode: 409 });
    }

    const detailsResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT DetailID, ProductID, Quantity, UnitPrice
        FROM TransactionDetails WITH (UPDLOCK, HOLDLOCK)
        WHERE TransactionID = @id
        ORDER BY DetailID
      `);
    if (!detailsResult.recordset.length) {
      throw Object.assign(new Error('لا توجد أصناف داخل فاتورة الشراء'), { statusCode: 409 });
    }

    for (const item of detailsResult.recordset) {
      const quantity = Math.round(Number(item.Quantity || 0));
      if (quantity <= 0) continue;
      const unitPrice = Number(item.UnitPrice || 0);
      await transaction.request()
        .input('productId', sql.Int, item.ProductID)
        .input('warehouseId', sql.Int, header.WarehouseID)
        .input('quantity', sql.Int, quantity)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          IF EXISTS (
            SELECT 1 FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
            WHERE ProductID = @productId AND WarehouseID = @warehouseId
          )
            UPDATE StockLevels
            SET Quantity = Quantity + @quantity, LastUpdatedAt = GETDATE()
            WHERE ProductID = @productId AND WarehouseID = @warehouseId;
          ELSE
            INSERT INTO StockLevels
              (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedBy, CreatedAt)
            VALUES
              (@productId, @warehouseId, @quantity, GETDATE(), @username, GETDATE());
        `);
      await transaction.request()
        .input('productId', sql.Int, item.ProductID)
        .input('warehouseId', sql.Int, header.WarehouseID)
        .input('quantity', sql.Int, quantity)
        .input('referenceId', sql.Int, id)
        .input('unitPrice', sql.Decimal(18, 2), unitPrice)
        .input('total', sql.Decimal(18, 2), Number((quantity * unitPrice).toFixed(2)))
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          INSERT INTO StockTransactions
            (ProductID, WarehouseID, TransactionType, Quantity, TransactionDate,
             ReferenceID, ReferenceType, UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt)
          VALUES
            (@productId, @warehouseId, N'In', @quantity, GETDATE(),
             @referenceId, N'PurchaseInvoiceReceipt', @unitPrice, @total,
             N'استلام فاتورة شراء وإدخال المخزون', @username, GETDATE())
        `);
    }

    const notes = String(data.notes || '').trim() || 'تم الاستلام وإدخال الأصناف إلى المخزون';
    await transaction.request()
      .input('id', sql.Int, id)
      .input('notes', sql.NVarChar(1000), notes)
      .query(`
        UPDATE Transactions
        SET IsDelivered = 1, DeliveredAt = GETDATE(), DeliveredNotes = @notes
        WHERE TransactionID = @id
      `);
    await transaction.request()
      .input('key', sql.NVarChar(200), String(id))
      .input('username', sql.NVarChar(100), auth.username)
      .input('oldData', sql.NVarChar(sql.MAX), JSON.stringify({
        IsDelivered: header.IsDelivered,
        DeliveredAt: header.DeliveredAt,
        DeliveredNotes: header.DeliveredNotes,
      }))
      .input('newData', sql.NVarChar(sql.MAX), JSON.stringify({
        IsDelivered: true,
        WarehouseID: header.WarehouseID,
        ItemsCount: detailsResult.recordset.length,
        Notes: notes,
      }))
      .query(`
        INSERT INTO [dbo].[Audit_Log]
          (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
           ActionDate, LoginName, AppName, AccessUserName)
        VALUES
          (N'Transactions', N'ReceivePurchaseInvoice', @key, @oldData, @newData,
           GETDATE(), @username, N'COCOBOLO Flutter', @username)
      `);

    await transaction.commit();
    return {
      TransactionID: id,
      ReferenceNumber: header.ReferenceNumber,
      PartyID: header.PartyID,
      SupplierName: header.PartyName,
      WarehouseID: header.WarehouseID,
      WarehouseName: header.WarehouseName,
      ItemsCount: detailsResult.recordset.length,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

module.exports = {
  getReceipts,
  getStats,
  getReceiptById,
  receivePurchase,
};
