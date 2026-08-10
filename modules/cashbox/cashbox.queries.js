const { sql, connectDB } = require('../../core/database');

// جلب كل الخزائن
async function getAllCashboxes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        c.CashBoxID, c.CashBoxName, c.Description,
        c.CreatedBy, c.CreatedAt,
        ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      ORDER BY c.CashBoxName
    `);
  return result.recordset;
}


// جلب خزينة بالـ ID
async function getCashboxById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        c.*,
        ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      WHERE c.CashBoxID = @id
    `);
  return result.recordset[0] || null;
}

// جلب حركات الخزينة
async function getCashboxTransactions(cashboxId = null, startDate = null, endDate = null, transactionType = null, referenceType = null) {
  const pool = await connectDB();

  let query = `
    SELECT 
      ct.CashboxTransactionID, ct.CashBoxID, ct.PaymentID,
      ct.ReferenceID, ct.ReferenceType, ct.TransactionType,
      ct.Amount, ct.TransactionDate, ct.Notes,
      ct.CreatedBy, ct.CreatedAt,
      c.CashBoxName
    FROM CashboxTransactions ct
    INNER JOIN CashBoxes c ON ct.CashBoxID = c.CashBoxID
    WHERE 1=1
  `;

  const request = pool.request();

  if (cashboxId) {
    query += ` AND ct.CashBoxID = @cashboxId`;
    request.input('cashboxId', sql.Int, cashboxId);
  }

  if (startDate) {
    query += ` AND CAST(ct.TransactionDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }

  if (endDate) {
    query += ` AND CAST(ct.TransactionDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }

  if (transactionType) {
    query += ` AND ct.TransactionType = @transactionType`;
    request.input('transactionType', sql.NVarChar(20), transactionType);
  }
  
  if (referenceType) {
  query += ` AND ct.ReferenceType = @referenceType`;
  request.input('referenceType', sql.NVarChar(20), referenceType);
  }

  query += ` ORDER BY ct.TransactionDate DESC, ct.CashboxTransactionID DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// ملخص الخزينة
async function getCashboxSummary(cashboxId = null) {
  const pool = await connectDB();
  const request = pool.request();

  let whereClause = '';
  if (cashboxId) {
    whereClause = 'WHERE CashBoxID = @cashboxId';
    request.input('cashboxId', sql.Int, cashboxId);
  }

  const result = await request.query(`
    SELECT 
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS TotalIn,
      ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS TotalOut,
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0) AS Balance
    FROM CashboxTransactions
    ${whereClause}
  `);
  return result.recordset[0];
}

// إنشاء خزينة جديدة
async function createCashbox(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('cashBoxName', sql.NVarChar(100), data.cashBoxName)
    .input('description', sql.NVarChar(255), data.description || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO CashBoxes (CashBoxName, Description, CreatedBy, CreatedAt)
      OUTPUT INSERTED.CashBoxID
      VALUES (@cashBoxName, @description, @createdBy, GETDATE())
    `);
  return result.recordset[0].CashBoxID;
}

// تعديل خزينة
async function updateCashbox(id, data) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('cashBoxName', sql.NVarChar(100), data.cashBoxName)
    .input('description', sql.NVarChar(255), data.description || null)
    .input('lastUpdatedBy', sql.NVarChar(50), data.lastUpdatedBy)
    .query(`
      UPDATE CashBoxes SET
        CashBoxName = @cashBoxName, Description = @description,
        LastUpdatedBy = @lastUpdatedBy, LastUpdatedAt = GETDATE()
      WHERE CashBoxID = @id
    `);
  return true;
}

// إضافة حركة خزينة
async function createTransaction(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('cashBoxId', sql.Int, data.cashBoxId)
    .input('paymentId', sql.Int, data.paymentId || null)
    .input('referenceId', sql.Int, data.referenceId || null)
    .input('referenceType', sql.NVarChar(20), data.referenceType || null)
    .input('transactionType', sql.NVarChar(20), data.transactionType)
    .input('amount', sql.Decimal(18, 2), data.amount)
    .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, PaymentID, ReferenceID, ReferenceType,
        TransactionType, Amount, TransactionDate, Notes,
        CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.CashboxTransactionID
      VALUES (
        @cashBoxId, @paymentId, @referenceId, @referenceType,
        @transactionType, @amount, GETDATE(), @notes,
        @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].CashboxTransactionID;
}

// تحويل بين خزينتين
async function createTransfer(data) {
  const pool = await connectDB();
  const transaction = pool.transaction();
  
  try {
    await transaction.begin();
    
    // صرف من الخزنة المصدر
    const result1 = await transaction.request()
      .input('cashBoxIdFrom', sql.Int, data.cashBoxIdFrom)
      .input('referenceType', sql.NVarChar(20), 'Transfer')
      .input('transactionType', sql.NVarChar(20), 'صرف')
      .input('amount', sql.Decimal(18, 2), data.amount)
      .input('notesFrom', sql.NVarChar(sql.MAX), data.notes + ' (تحويل إلى خزنة: ' + data.cashBoxToName + ')')
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, ReferenceType, TransactionType, Amount, 
          TransactionDate, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.CashboxTransactionID
        VALUES (
          @cashBoxIdFrom, @referenceType, @transactionType, @amount,
          GETDATE(), @notesFrom, @createdBy, GETDATE()
        )
      `);
    
    // قبض في الخزنة المستقبلة
    const result2 = await transaction.request()
      .input('cashBoxIdTo', sql.Int, data.cashBoxIdTo)
      .input('referenceType', sql.NVarChar(20), 'Transfer')
      .input('transactionType', sql.NVarChar(20), 'قبض')
      .input('amount', sql.Decimal(18, 2), data.amount)
      .input('notesTo', sql.NVarChar(sql.MAX), data.notes + ' (تحويل من خزنة: ' + data.cashBoxFromName + ')')
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, ReferenceType, TransactionType, Amount,
          TransactionDate, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.CashboxTransactionID
        VALUES (
          @cashBoxIdTo, @referenceType, @transactionType, @amount,
          GETDATE(), @notesTo, @createdBy, GETDATE()
        )
      `);
    
    await transaction.commit();
    
    return {
      transactionIdFrom: result1.recordset[0].CashboxTransactionID,
      transactionIdTo: result2.recordset[0].CashboxTransactionID
    };
    
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ══════════════════════════════════════════
// ✅ دوال داشبورد الخزينة
// ══════════════════════════════════════════

// إحصائيات عامة
async function getDashboardStats(period = 'month') {
  const pool = await connectDB();
  
  let dateCondition = '';
  switch (period) {
    case 'today':
      dateCondition = "AND CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE)";
      break;
    case 'week':
      dateCondition = "AND TransactionDate >= DATEADD(DAY, -7, GETDATE())";
      break;
    case 'month':
      dateCondition = "AND TransactionDate >= DATEADD(MONTH, -1, GETDATE())";
      break;
    case 'year':
      dateCondition = "AND TransactionDate >= DATEADD(YEAR, -1, GETDATE())";
      break;
    default:
      dateCondition = "";
  }

  const result = await pool.request().query(`
    SELECT 
      -- إجمالي الرصيد الحالي (كل الخزائن)
      (SELECT ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END), 0) 
       FROM CashboxTransactions) AS TotalBalance,
      
      -- إجمالي القبض للفترة
      (SELECT ISNULL(SUM(Amount), 0) 
       FROM CashboxTransactions 
       WHERE TransactionType = N'قبض' ${dateCondition}) AS TotalIn,
      
      -- إجمالي الصرف للفترة
      (SELECT ISNULL(SUM(Amount), 0) 
       FROM CashboxTransactions 
       WHERE TransactionType = N'صرف' ${dateCondition}) AS TotalOut,
      
      -- عدد الحركات للفترة
      (SELECT COUNT(*) 
       FROM CashboxTransactions 
       WHERE 1=1 ${dateCondition}) AS TransactionCount,
      
      -- عدد حركات القبض
      (SELECT COUNT(*) 
       FROM CashboxTransactions 
       WHERE TransactionType = N'قبض' ${dateCondition}) AS InCount,
      
      -- عدد حركات الصرف
      (SELECT COUNT(*) 
       FROM CashboxTransactions 
       WHERE TransactionType = N'صرف' ${dateCondition}) AS OutCount
  `);

  return result.recordset[0];
}

// بيانات الرسم البياني (آخر X أيام)
async function getChartData(days = 7) {
  const pool = await connectDB();

  const result = await pool.request()
    .input('days', sql.Int, days)
    .query(`
      WITH DateRange AS (
        SELECT CAST(DATEADD(DAY, -@days + 1, GETDATE()) AS DATE) AS Date
        UNION ALL
        SELECT DATEADD(DAY, 1, Date)
        FROM DateRange
        WHERE Date < CAST(GETDATE() AS DATE)
      )
      SELECT 
        FORMAT(d.Date, 'MM/dd') AS Label,
        d.Date,
        ISNULL((SELECT SUM(Amount) FROM CashboxTransactions 
                WHERE TransactionType = N'قبض' 
                AND CAST(TransactionDate AS DATE) = d.Date), 0) AS TotalIn,
        ISNULL((SELECT SUM(Amount) FROM CashboxTransactions 
                WHERE TransactionType = N'صرف' 
                AND CAST(TransactionDate AS DATE) = d.Date), 0) AS TotalOut
      FROM DateRange d
      ORDER BY d.Date
      OPTION (MAXRECURSION 365)
    `);

  return result.recordset;
}

// توزيع المصروفات حسب النوع
async function getDistribution(period = 'month') {
  const pool = await connectDB();

  let dateCondition = '';
  switch (period) {
    case 'today':
      dateCondition = "AND CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE)";
      break;
    case 'week':
      dateCondition = "AND TransactionDate >= DATEADD(DAY, -7, GETDATE())";
      break;
    case 'month':
      dateCondition = "AND TransactionDate >= DATEADD(MONTH, -1, GETDATE())";
      break;
    case 'year':
      dateCondition = "AND TransactionDate >= DATEADD(YEAR, -1, GETDATE())";
      break;
  }

  const result = await pool.request().query(`
    SELECT 
      ReferenceType,
      COUNT(*) AS Count,
      SUM(Amount) AS Total
    FROM CashboxTransactions
    WHERE TransactionType = N'صرف' ${dateCondition}
    GROUP BY ReferenceType
    ORDER BY Total DESC
  `);

  return result.recordset;
}

// رصيد كل خزنة
async function getCashboxBalances() {
  const pool = await connectDB();

  const result = await pool.request().query(`
    SELECT 
      c.CashBoxID,
      c.CashBoxName,
      ISNULL((SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END)
              FROM CashboxTransactions 
              WHERE CashBoxID = c.CashBoxID), 0) AS Balance
    FROM CashBoxes c
    ORDER BY Balance DESC
  `);

  return result.recordset;
}

// آخر الحركات
async function getRecentTransactions(limit = 5) {
  const pool = await connectDB();

  const result = await pool.request()
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        ct.CashboxTransactionID,
        ct.TransactionType,
        ct.Amount,
        ct.TransactionDate,
        ct.ReferenceType,
        c.CashBoxName
      FROM CashboxTransactions ct
      INNER JOIN CashBoxes c ON ct.CashBoxID = c.CashBoxID
      ORDER BY ct.TransactionDate DESC, ct.CashboxTransactionID DESC
    `);

  return result.recordset;
}

// مقارنة شهرية (الشهر الحالي vs السابق)
async function getMonthlyComparison() {
  const pool = await connectDB();

  const result = await pool.request().query(`
    SELECT 
      -- الشهر الحالي
      (SELECT ISNULL(SUM(Amount), 0) FROM CashboxTransactions 
       WHERE TransactionType = N'قبض' 
       AND MONTH(TransactionDate) = MONTH(GETDATE()) 
       AND YEAR(TransactionDate) = YEAR(GETDATE())) AS CurrentMonthIn,
       
      (SELECT ISNULL(SUM(Amount), 0) FROM CashboxTransactions 
       WHERE TransactionType = N'صرف' 
       AND MONTH(TransactionDate) = MONTH(GETDATE()) 
       AND YEAR(TransactionDate) = YEAR(GETDATE())) AS CurrentMonthOut,
      
      -- الشهر السابق
      (SELECT ISNULL(SUM(Amount), 0) FROM CashboxTransactions 
       WHERE TransactionType = N'قبض' 
       AND MONTH(TransactionDate) = MONTH(DATEADD(MONTH, -1, GETDATE())) 
       AND YEAR(TransactionDate) = YEAR(DATEADD(MONTH, -1, GETDATE()))) AS LastMonthIn,
       
      (SELECT ISNULL(SUM(Amount), 0) FROM CashboxTransactions 
       WHERE TransactionType = N'صرف' 
       AND MONTH(TransactionDate) = MONTH(DATEADD(MONTH, -1, GETDATE())) 
       AND YEAR(TransactionDate) = YEAR(DATEADD(MONTH, -1, GETDATE()))) AS LastMonthOut
  `);

  return result.recordset[0];
}

// ═══════════════════════════════════════════════════════════
// 📊 الداشبورد الكامل (مطابق لبلازور)
// ═══════════════════════════════════════════════════════════
async function getFullDashboard() {
  const pool = await connectDB();

  // 1. الإحصائيات الرئيسية
  const statsRes = await pool.request().query(`
    SELECT
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END), 0) AS TotalBalance,
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' AND CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) THEN Amount ELSE 0 END), 0) AS TodayIn,
      ISNULL(SUM(CASE WHEN TransactionType = N'صرف' AND CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) THEN Amount ELSE 0 END), 0) AS TodayOut,
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' AND YEAR(TransactionDate) = YEAR(GETDATE()) AND MONTH(TransactionDate) = MONTH(GETDATE()) THEN Amount ELSE 0 END), 0) AS MonthIn,
      ISNULL(SUM(CASE WHEN TransactionType = N'صرف' AND YEAR(TransactionDate) = YEAR(GETDATE()) AND MONTH(TransactionDate) = MONTH(GETDATE()) THEN Amount ELSE 0 END), 0) AS MonthOut
    FROM CashboxTransactions
  `);
  const stats = statsRes.recordset[0] || {};

  // 2. عدد الخزن
  const boxesCountRes = await pool.request().query(`
    SELECT COUNT(*) AS Total, SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END) AS Active
    FROM CashBoxes
  `);
  const boxesCount = boxesCountRes.recordset[0] || {};

  // 3. كل الخزن بأرصدتها
  const boxesRes = await pool.request().query(`
    SELECT
      c.CashBoxID, c.CashBoxName, c.Description,
      c.CashBoxKind, c.Icon, c.Color, c.OpeningBalance,
      c.IsActive, c.IsDefault,
      ISNULL((SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END)
              FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID), 0) AS CurrentBalance,
      ISNULL((SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END)
              FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID), 0) AS TotalIn,
      ISNULL((SELECT SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END)
              FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID), 0) AS TotalOut,
      (SELECT COUNT(*) FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID) AS TransactionsCount
    FROM CashBoxes c
    ORDER BY c.IsDefault DESC, c.CashBoxName
  `);

  // 4. آخر 30 يوم حركة يومية
  const last30Res = await pool.request().query(`
    SELECT
      CAST(TransactionDate AS DATE) AS Date,
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS [In],
      ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS [Out]
    FROM CashboxTransactions
    WHERE TransactionDate >= DATEADD(DAY, -29, CAST(GETDATE() AS DATE))
    GROUP BY CAST(TransactionDate AS DATE)
    ORDER BY CAST(TransactionDate AS DATE)
  `);

  // 5. توزيع الأنواع (ReferenceType)
  const breakdownRes = await pool.request().query(`
    SELECT
      ISNULL(ReferenceType, N'أخرى') AS ReferenceType,
      COUNT(*) AS Count,
      ISNULL(SUM(Amount), 0) AS Total
    FROM CashboxTransactions
    GROUP BY ReferenceType
    ORDER BY SUM(Amount) DESC
  `);

  // 6. آخر الحركات
  const recentRes = await pool.request().query(`
    SELECT TOP 10
      ct.CashboxTransactionID, ct.CashBoxID, ct.TransactionDate,
      ct.TransactionType, ct.Amount, ct.Notes, ct.CreatedBy,
      c.CashBoxName
    FROM CashboxTransactions ct
    INNER JOIN CashBoxes c ON ct.CashBoxID = c.CashBoxID
    ORDER BY ct.TransactionDate DESC
  `);

  // 7. دائنون/مدينون (الحسابات الشخصية لو موجودة)
  let creditors = 0, debtors = 0;
  try {
    const accRes = await pool.request().query(`
      SELECT ISNULL(SUM(CASE WHEN Balance > 0 THEN Balance ELSE 0 END), 0) AS Creditors,
             ISNULL(SUM(CASE WHEN Balance < 0 THEN ABS(Balance) ELSE 0 END), 0) AS Debtors
      FROM PersonalAccounts
    `);
    creditors = accRes.recordset[0]?.Creditors || 0;
    debtors = accRes.recordset[0]?.Debtors || 0;
  } catch (e) {
    // جدول الحسابات الشخصية مش موجود — نتجاهل
  }

  return {
    TotalBalance: stats.TotalBalance ?? 0,
    TodayIn: stats.TodayIn ?? 0,
    TodayOut: stats.TodayOut ?? 0,
    TodayNet: (stats.TodayIn ?? 0) - (stats.TodayOut ?? 0),
    MonthIn: stats.MonthIn ?? 0,
    MonthOut: stats.MonthOut ?? 0,
    MonthNet: (stats.MonthIn ?? 0) - (stats.MonthOut ?? 0),
    CashBoxesCount: boxesCount.Total ?? 0,
    ActiveCashBoxesCount: boxesCount.Active ?? 0,
    CashBoxes: boxesRes.recordset,
    Last30Days: last30Res.recordset,
    TypeBreakdown: breakdownRes.recordset,
    RecentTransactions: recentRes.recordset,
    TotalCreditors: creditors,
    TotalDebtors: debtors,
  };
}

// تصدير الدوال
module.exports = {
  getAllCashboxes,
  getFullDashboard,
  getCashboxById,
  getCashboxTransactions,
  getCashboxSummary,
  createCashbox,
  updateCashbox,
  createTransaction,
  createTransfer,
   getDashboardStats,
  getChartData,
  getDistribution,
  getCashboxBalances,
  getRecentTransactions,
  getMonthlyComparison
};