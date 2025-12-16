const { sql, connectDB } = require('../../core/database');

// جلب كل العمولات
async function getAllCommissions(filters = {}) {
  const pool = await connectDB();
  const { employeeId, year, month } = filters;

  let query = `
    SELECT 
      c.AssignmentID, c.TransactionID, c.EmployeeID,
      c.CommissionMonth, c.CommissionYear,
      c.TransactionAmount, c.CommissionRate, c.CommissionAmount,
      c.ApprovedBy, c.ApprovedAt, c.CreatedBy, c.CreatedAt,
      e.FullName AS EmployeeName,
      t.TransactionDate, t.GrandTotal,
      p.PartyName AS ClientName
    FROM CommissionAssignments c
    INNER JOIN Employees e ON c.EmployeeID = e.EmployeeID
    INNER JOIN Transactions t ON c.TransactionID = t.TransactionID
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE 1=1
  `;

  const request = pool.request();

  if (employeeId) {
    query += ` AND c.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }

  if (year) {
    query += ` AND c.CommissionYear = @year`;
    request.input('year', sql.Int, year);
  }

  if (month) {
    query += ` AND c.CommissionMonth = @month`;
    request.input('month', sql.Int, month);
  }

  query += ` ORDER BY c.CommissionYear DESC, c.CommissionMonth DESC, c.CreatedAt DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب ملخص العمولات لموظف
async function getEmployeeCommissionsSummary(employeeId, year = null) {
  const pool = await connectDB();
  const request = pool.request()
    .input('employeeId', sql.Int, employeeId);

  let whereClause = 'WHERE EmployeeID = @employeeId';
  if (year) {
    whereClause += ' AND CommissionYear = @year';
    request.input('year', sql.Int, year);
  }

  const result = await request.query(`
    SELECT 
      COUNT(*) as totalTransactions,
      ISNULL(SUM(TransactionAmount), 0) as totalSalesAmount,
      ISNULL(SUM(CommissionAmount), 0) as totalCommission,
      ISNULL(SUM(CASE WHEN ApprovedAt IS NOT NULL THEN CommissionAmount ELSE 0 END), 0) as approvedCommission,
      ISNULL(SUM(CASE WHEN ApprovedAt IS NULL THEN CommissionAmount ELSE 0 END), 0) as pendingCommission
    FROM CommissionAssignments
    ${whereClause}
  `);
  return result.recordset[0];
}

// جلب ملخص العمولات الشهري
async function getMonthlyCommissionsSummary(year, month) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('year', sql.Int, year)
    .input('month', sql.Int, month)
    .query(`
      SELECT 
        e.EmployeeID, e.FullName,
        COUNT(c.AssignmentID) as transactionsCount,
        ISNULL(SUM(c.TransactionAmount), 0) as totalSales,
        ISNULL(SUM(c.CommissionAmount), 0) as totalCommission
      FROM Employees e
      LEFT JOIN CommissionAssignments c ON e.EmployeeID = c.EmployeeID
        AND c.CommissionYear = @year AND c.CommissionMonth = @month
      WHERE e.Status = N'نشط'
      GROUP BY e.EmployeeID, e.FullName
      ORDER BY totalCommission DESC
    `);
  return result.recordset;
}

// إضافة عمولة
async function createCommission(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('transactionId', sql.Int, data.transactionId)
    .input('employeeId', sql.Int, data.employeeId)
    .input('commissionMonth', sql.Int, data.commissionMonth)
    .input('commissionYear', sql.Int, data.commissionYear)
    .input('transactionAmount', sql.Decimal(18, 2), data.transactionAmount || null)
    .input('commissionRate', sql.Decimal(8, 4), data.commissionRate)
    .input('commissionAmount', sql.Decimal(18, 2), data.commissionAmount || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO CommissionAssignments (
        TransactionID, EmployeeID, CommissionMonth, CommissionYear,
        TransactionAmount, CommissionRate, CommissionAmount,
        CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.AssignmentID
      VALUES (
        @transactionId, @employeeId, @commissionMonth, @commissionYear,
        @transactionAmount, @commissionRate, @commissionAmount,
        @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].AssignmentID;
}

// اعتماد عمولة
async function approveCommission(id, approvedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('approvedBy', sql.NVarChar(50), approvedBy)
    .query(`
      UPDATE CommissionAssignments 
      SET ApprovedBy = @approvedBy, ApprovedAt = GETDATE()
      WHERE AssignmentID = @id
    `);
  return true;
}

// اعتماد كل عمولات شهر
async function approveMonthlyCommissions(year, month, approvedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('year', sql.Int, year)
    .input('month', sql.Int, month)
    .input('approvedBy', sql.NVarChar(50), approvedBy)
    .query(`
      UPDATE CommissionAssignments 
      SET ApprovedBy = @approvedBy, ApprovedAt = GETDATE()
      WHERE CommissionYear = @year AND CommissionMonth = @month AND ApprovedAt IS NULL
    `);
  return true;
}

// حذف عمولة
async function deleteCommission(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM CommissionAssignments WHERE AssignmentID = @id');
  return true;
}

// تصدير الدوال
module.exports = {
  getAllCommissions,
  getEmployeeCommissionsSummary,
  getMonthlyCommissionsSummary,
  createCommission,
  approveCommission,
  approveMonthlyCommissions,
  deleteCommission
};