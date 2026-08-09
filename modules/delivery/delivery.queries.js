const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════
// جلب فواتير التسليم — مع فلاتر شاملة (بحث + تاريخ + حالة)
// ═══════════════════════════════════════════════════════════
async function getDeliveries({
  status = 'all',       // all | overdue | today | soon | upcoming | delivered
  search = null,        // اسم العميل
  dateFrom = null,      // تاريخ البدء
  dateTo = null,        // تاريخ النهاية
  dateFilterType = 'due', // due | invoice | delivered
}) {
  const pool = await connectDB();
  const request = pool.request();

  let query = `
    SELECT 
      t.TransactionID,
      t.TransactionDate,
      t.DueDate,
      t.IsDelivered,
      t.PartyID,
      p.PartyName AS ClientName,
      p.Phone,
      p.Phone2,
      p.Address,
      t.GrandTotal,
      t.PaidAmount,
      ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
      de.FullName AS DeliveryEmployeeName,
      DATEDIFF(DAY, GETDATE(), t.DueDate) AS DaysRemaining,
      CASE 
        WHEN t.IsDelivered = 1 THEN 'delivered'
        WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) < 0 THEN 'overdue'
        WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) = 0 THEN 'today'
        WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) <= 3 THEN 'soon'
        ELSE 'upcoming'
      END AS DeliveryStatus
    FROM Transactions t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN Employees de ON t.DeliveryEmployeeId = de.EmployeeID
    WHERE t.TransactionType = 'Sale'
      AND t.DueDate IS NOT NULL
  `;

  // ── فلتر الحالة ─────────────────────────────────────
  if (status === 'delivered') {
    query += ` AND t.IsDelivered = 1`;
  } else if (status === 'overdue') {
    query += ` AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND DATEDIFF(DAY, GETDATE(), t.DueDate) < 0`;
  } else if (status === 'today') {
    query += ` AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)`;
  } else if (status === 'soon') {
    query += ` AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND DATEDIFF(DAY, GETDATE(), t.DueDate) BETWEEN 1 AND 3`;
  } else if (status === 'upcoming') {
    query += ` AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND DATEDIFF(DAY, GETDATE(), t.DueDate) > 3`;
  } else {
    // all → كل الفواتير (معلقة + مسلمة)
    query += ` AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL OR t.IsDelivered = 1)`;
  }

  // ── فلترة التاريخ ────────────────────────────────────
  if (dateFrom) {
    const col = dateFilterType === 'invoice' ? 't.TransactionDate'
      : 't.DueDate';
    request.input('dateFrom', sql.DateTime, new Date(dateFrom));
    query += ` AND ${col} >= @dateFrom`;
  }
  if (dateTo) {
    const col = dateFilterType === 'invoice' ? 't.TransactionDate'
      : 't.DueDate';
    request.input('dateTo', sql.DateTime, new Date(dateTo));
    query += ` AND ${col} < DATEADD(DAY, 1, @dateTo)`;
  }

  // ── البحث بالعميل ────────────────────────────────────
  if (search && search.trim()) {
    request.input('search', sql.NVarChar(200), `%${search.trim()}%`);
    query += ` AND (p.PartyName LIKE @search OR p.Phone LIKE @search)`;
  }

  query += ` ORDER BY t.DueDate ASC`;

  const result = await request.query(query);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// إحصائيات شاملة (كل الحالات + المبالغ)
// ═══════════════════════════════════════════════════════════
async function getDeliveryStats({
  search = null,
  dateFrom = null,
  dateTo = null,
  dateFilterType = 'due',
} = {}) {
  const pool = await connectDB();
  const request = pool.request();

  let query = `
    SELECT 
      COUNT(*) AS TotalCount,
      SUM(CASE WHEN (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND DATEDIFF(DAY, GETDATE(), t.DueDate) < 0 THEN 1 ELSE 0 END) AS Overdue,
      SUM(CASE WHEN (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS Today,
      SUM(CASE WHEN (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND DATEDIFF(DAY, GETDATE(), t.DueDate) BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS Soon,
      SUM(CASE WHEN (t.IsDelivered = 0 OR t.IsDelivered IS NULL) AND DATEDIFF(DAY, GETDATE(), t.DueDate) > 3 THEN 1 ELSE 0 END) AS Upcoming,
      SUM(CASE WHEN t.IsDelivered = 1 THEN 1 ELSE 0 END) AS Delivered,
      SUM(ISNULL(t.GrandTotal, 0)) AS TotalGrandTotal,
      SUM(ISNULL(t.PaidAmount, 0)) AS TotalPaidAmount,
      SUM(ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0)) AS TotalRemaining
    FROM Transactions t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionType = 'Sale'
      AND t.DueDate IS NOT NULL
  `;

  if (dateFrom) {
    const col = dateFilterType === 'invoice' ? 't.TransactionDate'
      : 't.DueDate';
    request.input('dateFrom', sql.DateTime, new Date(dateFrom));
    query += ` AND ${col} >= @dateFrom`;
  }
  if (dateTo) {
    const col = dateFilterType === 'invoice' ? 't.TransactionDate'
      : 't.DueDate';
    request.input('dateTo', sql.DateTime, new Date(dateTo));
    query += ` AND ${col} < DATEADD(DAY, 1, @dateTo)`;
  }
  if (search && search.trim()) {
    request.input('search', sql.NVarChar(200), `%${search.trim()}%`);
    query += ` AND (p.PartyName LIKE @search OR p.Phone LIKE @search)`;
  }

  const result = await request.query(query);
  const s = result.recordset[0];
  // تحويل nulls إلى 0
  return {
    TotalCount: s?.TotalCount ?? 0,
    Overdue: s?.Overdue ?? 0,
    Today: s?.Today ?? 0,
    Soon: s?.Soon ?? 0,
    Upcoming: s?.Upcoming ?? 0,
    Delivered: s?.Delivered ?? 0,
    TotalGrandTotal: s?.TotalGrandTotal ?? 0,
    TotalPaidAmount: s?.TotalPaidAmount ?? 0,
    TotalRemaining: s?.TotalRemaining ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════
// تفاصيل فاتورة تسليم كاملة
// ═══════════════════════════════════════════════════════════
async function getDeliveryDetails(transactionId) {
  const pool = await connectDB();

  // معلومات الفاتورة
  const headerRes = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`
      SELECT 
        t.TransactionID,
        t.TransactionDate,
        t.DueDate,
        t.IsDelivered,
        t.TransactionType,
        t.Notes,
        t.PartyID,
        p.PartyName AS ClientName,
        p.Phone,
        p.Phone2,
        p.Address,
        t.DeliveryEmployeeId,
        de.FullName AS DeliveryEmployeeName,
        t.GrandTotal,
        t.PaidAmount,
        ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
        DATEDIFF(DAY, GETDATE(), t.DueDate) AS DaysRemaining,
        CASE 
          WHEN t.IsDelivered = 1 THEN 'delivered'
          WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) < 0 THEN 'overdue'
          WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) = 0 THEN 'today'
          WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) <= 3 THEN 'soon'
          ELSE 'upcoming'
        END AS DeliveryStatus
      FROM Transactions t
      LEFT JOIN Parties p ON t.PartyID = p.PartyID
      LEFT JOIN Employees de ON t.DeliveryEmployeeId = de.EmployeeID
      WHERE t.TransactionID = @id
    `);

  const header = headerRes.recordset[0];
  if (!header) return null;

  // المنتجات
  const itemsRes = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`
      SELECT 
        td.ProductID,
        td.ProductName,
        td.Quantity,
        td.UnitName,
        td.UnitPrice,
        td.TotalAmount
      FROM TransactionDetails td
      WHERE td.TransactionID = @id
    `);

  return {
    ...header,
    Products: itemsRes.recordset,
  };
}

// ═══════════════════════════════════════════════════════════
// تحديث حالة التسليم (مع تفاصيل)
// ═══════════════════════════════════════════════════════════
async function markAsDelivered({
  transactionId,
  deliveryEmployeeName = null,
  deliveredNotes = null,
}) {
  const pool = await connectDB();

  // لو المندوب اتحدد بالاسم → نجيب رقمه
  let deliveryEmployeeId = null;
  if (deliveryEmployeeName) {
    const empRes = await pool.request()
      .input('name', sql.NVarChar(200), deliveryEmployeeName)
      .query(`SELECT TOP 1 EmployeeID FROM Employees WHERE FullName = @name`);
    deliveryEmployeeId = empRes.recordset[0]?.EmployeeID ?? null;
  }

  const request = pool.request()
    .input('id', sql.Int, transactionId)
    .input('employeeId', sql.Int, deliveryEmployeeId)
    .input('notes', sql.NVarChar(1000), deliveredNotes || null);

  let query = `
    UPDATE Transactions 
    SET IsDelivered = 1
  `;
  if (deliveryEmployeeId) query += `, DeliveryEmployeeId = @employeeId`;
  if (deliveredNotes) query += `, Notes = @notes`;
  query += ` WHERE TransactionID = @id`;

  await request.query(query);
  return true;
}

// ═══════════════════════════════════════════════════════════
// الفواتير القريبة (للإشعارات)
// ═══════════════════════════════════════════════════════════
async function getUpcomingDeliveries() {
  const pool = await connectDB();

  const result = await pool.request().query(`
    SELECT 
      t.TransactionID,
      t.DueDate,
      t.PartyID,
      p.PartyName AS ClientName,
      p.Phone,
      DATEDIFF(DAY, GETDATE(), t.DueDate) AS DaysRemaining
    FROM Transactions t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionType = 'Sale'
      AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL)
      AND t.DueDate IS NOT NULL
      AND DATEDIFF(DAY, GETDATE(), t.DueDate) BETWEEN 0 AND 7
    ORDER BY t.DueDate ASC
  `);

  return result.recordset;
}

module.exports = {
  getDeliveries,
  getDeliveryStats,
  getDeliveryDetails,
  markAsDelivered,
  getUpcomingDeliveries,
};
