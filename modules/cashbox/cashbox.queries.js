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
          SELECT SUM(CASE WHEN TransactionType = N'إيداع' OR TransactionType = N'تحصيل' THEN Amount ELSE -Amount END)
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
          SELECT SUM(CASE WHEN TransactionType = N'إيداع' OR TransactionType = N'تحصيل' THEN Amount ELSE -Amount END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      WHERE c.CashBoxID = @id
    `);
  return result.recordset[0] || null;
}

// جلب حركات الخزينة
async function getCashboxTransactions(cashboxId = null, startDate = null, endDate = null, transactionType = null) {
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
      ISNULL(SUM(CASE WHEN TransactionType = N'إيداع' OR TransactionType = N'تحصيل' THEN Amount ELSE 0 END), 0) AS TotalIn,
      ISNULL(SUM(CASE WHEN TransactionType = N'صرف' OR TransactionType = N'سحب' THEN Amount ELSE 0 END), 0) AS TotalOut,
      ISNULL(SUM(CASE WHEN TransactionType = N'إيداع' OR TransactionType = N'تحصيل' THEN Amount ELSE -Amount END), 0) AS Balance
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

// تصدير الدوال
module.exports = {
  getAllCashboxes,
  getCashboxById,
  getCashboxTransactions,
  getCashboxSummary,
  createCashbox,
  updateCashbox,
  createTransaction
};