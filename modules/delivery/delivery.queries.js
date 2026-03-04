const { sql, connectDB } = require('../../core/database');

// جلب الفواتير المعلقة مرتبة بالأقرب
async function getPendingDeliveries(status = 'all') {
  const pool = await connectDB();
  
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
      DATEDIFF(DAY, GETDATE(), t.DueDate) AS DaysRemaining,
      CASE 
        WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) < 0 THEN 'overdue'
        WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) = 0 THEN 'today'
        WHEN DATEDIFF(DAY, GETDATE(), t.DueDate) <= 3 THEN 'soon'
        ELSE 'upcoming'
      END AS DeliveryStatus
    FROM Transactions t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionType = 'Sale'
      AND (t.IsDelivered = 0 OR t.IsDelivered IS NULL)
      AND t.DueDate IS NOT NULL
  `;

  if (status === 'overdue') {
    query += ` AND DATEDIFF(DAY, GETDATE(), t.DueDate) < 0`;
  } else if (status === 'today') {
    query += ` AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)`;
  } else if (status === 'upcoming') {
    query += ` AND DATEDIFF(DAY, GETDATE(), t.DueDate) > 0`;
  }

  query += ` ORDER BY t.DueDate ASC`;

  const result = await pool.request().query(query);
  return result.recordset;
}

// تحديث حالة التسليم
async function markAsDelivered(transactionId) {
  const pool = await connectDB();
  
  await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`
      UPDATE Transactions 
      SET IsDelivered = 1
      WHERE TransactionID = @id
    `);
  
  return true;
}

// إحصائيات التسليم
async function getDeliveryStats() {
  const pool = await connectDB();
  
  const result = await pool.request().query(`
    SELECT 
      COUNT(*) AS TotalPending,
      SUM(CASE WHEN DATEDIFF(DAY, GETDATE(), DueDate) < 0 THEN 1 ELSE 0 END) AS Overdue,
      SUM(CASE WHEN CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS Today,
      SUM(CASE WHEN DATEDIFF(DAY, GETDATE(), DueDate) BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS Soon,
      SUM(CASE WHEN DATEDIFF(DAY, GETDATE(), DueDate) > 3 THEN 1 ELSE 0 END) AS Upcoming
    FROM Transactions
    WHERE TransactionType = 'Sale'
      AND (IsDelivered = 0 OR IsDelivered IS NULL)
      AND DueDate IS NOT NULL
  `);
  
  return result.recordset[0];
}
// جلب الفواتير اللي فاضل عليها 7 أيام أو أقل
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
  getPendingDeliveries,
  markAsDelivered,
  getDeliveryStats,
  getUpcomingDeliveries 
};

