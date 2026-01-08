const { sql, connectDB } = require('../../core/database');

// جلب مجموعات المصروفات
async function getExpenseGroups() {
  const pool = await connectDB();
  const result = await pool.request()
    .query('SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID FROM ExpenseGroups ORDER BY ExpenseGroupName');
  return result.recordset;
}

// جلب الخزائن
async function getCashboxes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query('SELECT CashBoxID, CashBoxName, Description FROM CashBoxes ORDER BY CashBoxName');
  return result.recordset;
}

// ملخص المصروفات
async function getExpensesSummary() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
        SELECT 
        COUNT(*) as totalCount,
        ISNULL(SUM(Amount), 0) as totalAmount,
        (SELECT COUNT(*) FROM Expenses WHERE CAST(ExpenseDate AS DATE) = CAST(GETDATE() AS DATE)) as todayCount,
        (SELECT ISNULL(SUM(Amount), 0) FROM Expenses WHERE CAST(ExpenseDate AS DATE) = CAST(GETDATE() AS DATE)) as todayAmount,
        (SELECT ISNULL(SUM(Amount), 0) FROM Expenses 
         WHERE YEAR(ExpenseDate) = YEAR(GETDATE()) 
           AND MONTH(ExpenseDate) = MONTH(GETDATE())) as monthAmount
      FROM Expenses
    `);
  return result.recordset[0];
}

// جلب كل المصروفات مع الفلترة
async function getAllExpenses(search = '', groupId = null, startDate = null, endDate = null) {
  const pool = await connectDB();

  let query = `
    SELECT 
      e.ExpenseID, e.ExpenseName, e.ExpenseDate, e.Amount,
      e.Notes, e.Torecipient, e.IsAdvance, e.AdvanceMonths,
      e.CreatedBy, e.CreatedAt,
      eg.ExpenseGroupID, eg.ExpenseGroupName,
      cb.CashBoxID, cb.CashBoxName
    FROM Expenses e
    INNER JOIN ExpenseGroups eg ON e.ExpenseGroupID = eg.ExpenseGroupID
    INNER JOIN CashBoxes cb ON e.CashBoxID = cb.CashBoxID
    WHERE 1=1
  `;

  const request = pool.request();

  if (search && search.trim() !== '') {
    query += ` AND (e.ExpenseName LIKE @search OR e.Torecipient LIKE @search)`;
    request.input('search', sql.NVarChar, `%${search}%`);
  }

  if (groupId && groupId !== '' && groupId !== '0') {
    query += ` AND e.ExpenseGroupID = @groupId`;
    request.input('groupId', sql.Int, groupId);
  }

  if (startDate) {
    query += ` AND CAST(e.ExpenseDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }

  if (endDate) {
    query += ` AND CAST(e.ExpenseDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }

  query += ` ORDER BY e.ExpenseDate DESC, e.ExpenseID DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// إضافة مصروف جديد
async function createExpense(expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // إضافة المصروف
    const expenseResult = await transaction.request()
      .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('amount', sql.Decimal(18, 2), expenseData.amount)
      .input('expenseDate', sql.DateTime, expenseData.expenseDate || new Date())
      .input('notes', sql.NVarChar(255), expenseData.notes || null)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .input('isAdvance', sql.Bit, expenseData.isAdvance || false)
      .input('advanceMonths', sql.Int, expenseData.advanceMonths || null)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
      .query(`
        INSERT INTO Expenses (
          ExpenseName, ExpenseGroupID, CashBoxID, Amount, ExpenseDate,
          Notes, Torecipient, IsAdvance, AdvanceMonths, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.ExpenseID
        VALUES (
          @expenseName, @expenseGroupId, @cashBoxId, @amount, @expenseDate,
          @notes, @toRecipient, @isAdvance, @advanceMonths, @createdBy, GETDATE()
        )
      `);

    const expenseId = expenseResult.recordset[0].ExpenseID;

    // إضافة حركة الخزينة
    await transaction.request()
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('referenceId', sql.Int, expenseId)
      .input('amount', sql.Decimal(18, 2), expenseData.amount)
      .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
          Amount, TransactionDate, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
          @amount, GETDATE(), @notes, @createdBy, GETDATE()
        )
      `);

    await transaction.commit();
    return expenseId;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// تعديل مصروف
async function updateExpense(id, expenseData) {
  const pool = await connectDB();

  // تعديل المصروف
  await pool.request()
    .input('id', sql.Int, id)
    .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
    .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
    .input('amount', sql.Decimal(18, 2), expenseData.amount)
    .input('expenseDate', sql.DateTime, expenseData.expenseDate)
    .input('notes', sql.NVarChar(255), expenseData.notes || null)
    .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
    .input('isAdvance', sql.Bit, expenseData.isAdvance || false)
    .input('advanceMonths', sql.Int, expenseData.advanceMonths || null)
    .query(`
      UPDATE Expenses SET
        ExpenseName = @expenseName, ExpenseGroupID = @expenseGroupId,
        Amount = @amount, ExpenseDate = @expenseDate, Notes = @notes,
        Torecipient = @toRecipient, IsAdvance = @isAdvance, AdvanceMonths = @advanceMonths
      WHERE ExpenseID = @id
    `);

  // تعديل حركة الخزينة
  await pool.request()
    .input('referenceId', sql.Int, id)
    .input('amount', sql.Decimal(18, 2), expenseData.amount)
    .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
    .query(`
      UPDATE CashboxTransactions SET Amount = @amount, Notes = @notes
      WHERE ReferenceID = @referenceId AND ReferenceType = 'Expense'
    `);

  return true;
}

// حذف مصروف
async function deleteExpense(id) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // حذف حركة الخزينة
    await transaction.request()
      .input('referenceId', sql.Int, id)
      .query(`DELETE FROM CashboxTransactions WHERE ReferenceID = @referenceId AND ReferenceType = 'Expense'`);

    // حذف المصروف
    await transaction.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM Expenses WHERE ExpenseID = @id');

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function getExpenseGroupsByParent(parentGroupName = null) {
  const pool = await connectDB();
  
  let query = `
    SELECT 
      G.ExpenseGroupID,
      G.ExpenseGroupName,
      PG.ExpenseGroupName AS ParentGroupName
    FROM 
      ExpenseGroups G
      LEFT JOIN ExpenseGroups PG ON G.ParentGroupID = PG.ExpenseGroupID
    WHERE 1=1
  `;
  
  const request = pool.request();
  
  if (parentGroupName && parentGroupName !== '' && parentGroupName !== 'الكل') {
    query += ` AND PG.ExpenseGroupName = @parentGroupName`;
    request.input('parentGroupName', sql.NVarChar, parentGroupName);
  }
  
  query += ` ORDER BY G.ExpenseGroupName`;
  
  const result = await request.query(query);
  return result.recordset;
}



// تصدير الدوال
module.exports = {
  getExpenseGroups,
  getCashboxes,
  getExpensesSummary,
  getAllExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseGroupsByParent
};