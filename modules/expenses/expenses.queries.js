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

// ====================== مصروف عادي ======================
// ====================== مصروف عادي (معدل) ======================
async function createRegularExpense(expenseData, transaction) {
  try {
    // إضافة المصروف (بدون OUTPUT)
    await transaction.request()
      .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('amount', sql.Decimal(18, 2), expenseData.amount)
      .input('expenseDate', sql.DateTime, expenseData.expenseDate || new Date())
      .input('notes', sql.NVarChar(255), expenseData.notes || null)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .input('isAdvance', sql.Bit, false)
      .input('advanceMonths', sql.Int, null)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
      .query(`
        INSERT INTO Expenses (
          ExpenseName, ExpenseGroupID, CashBoxID, Amount, ExpenseDate,
          Notes, Torecipient, IsAdvance, AdvanceMonths, CreatedBy, CreatedAt
        )
        VALUES (
          @expenseName, @expenseGroupId, @cashBoxId, @amount, @expenseDate,
          @notes, @toRecipient, @isAdvance, @advanceMonths, @createdBy, GETDATE()
        );
      `);

    // جلب الـ ID بـ SCOPE_IDENTITY (آمن مع التريجر)
    const idResult = await transaction.request()
      .query('SELECT SCOPE_IDENTITY() AS ExpenseID');
      
    const expenseId = idResult.recordset[0].ExpenseID;

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

    return expenseId;
  } catch (err) {
    throw err;
  }
}

// ====================== مصروف مقدم ======================
async function createAdvanceExpense(expenseData, transaction) {
  try {
    const { advanceMonths, amount, expenseName, notes, toRecipient, expenseDate } = expenseData;
    const monthlyAmount = amount / advanceMonths;
    
    let firstExpenseId = null;

    // 1. إضافة حركة الخزينة (بدون OUTPUT)
    await transaction.request()
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(sql.MAX), 
        `مصروف مقدم - ${notes || ''} المستفيد: ${toRecipient || ''}`)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
          Amount, TransactionDate, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @cashBoxId, NULL, 0, 'AdvanceExpense', N'صرف',
          @amount, GETDATE(), @notes, @createdBy, GETDATE()
        );
      `);

    // جلب ID الحركة
    const transIdResult = await transaction.request()
      .query('SELECT SCOPE_IDENTITY() AS CashboxTransactionID');
    const cashTransId = transIdResult.recordset[0].CashboxTransactionID;

    // 2. إضافة الأقساط
    for (let i = 1; i <= advanceMonths; i++) {
      const monthDate = new Date(expenseDate || new Date());
      monthDate.setMonth(monthDate.getMonth() + (i - 1));
      
      await transaction.request()
        .input('expenseName', sql.NVarChar(100), `${expenseName} (قسط ${i}/${advanceMonths})`)
        .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
        .input('cashBoxId', sql.Int, expenseData.cashBoxId)
        .input('amount', sql.Decimal(18, 2), monthlyAmount)
        .input('expenseDate', sql.DateTime, monthDate)
        .input('notes', sql.NVarChar(255), 
          `${notes || ''} - قسط ${i} من ${advanceMonths}${toRecipient ? ' - المستفيد: ' + toRecipient : ''}`)
        .input('toRecipient', sql.NVarChar(100), toRecipient || null)
        .input('isAdvance', sql.Bit, true)
        .input('advanceMonths', sql.Int, advanceMonths)
        .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
        .query(`
          INSERT INTO Expenses (
            ExpenseName, ExpenseGroupID, CashBoxID, Amount, ExpenseDate,
            Notes, Torecipient, IsAdvance, AdvanceMonths, CreatedBy, CreatedAt
          )
          VALUES (
            @expenseName, @expenseGroupId, @cashBoxId, @amount, @expenseDate,
            @notes, @toRecipient, @isAdvance, @advanceMonths, @createdBy, GETDATE()
          );
        `);

      // جلب ID المصروف
      const expIdResult = await transaction.request()
        .query('SELECT SCOPE_IDENTITY() AS ExpenseID');
      const expenseId = expIdResult.recordset[0].ExpenseID;
      
      // حفظ الـ ID الأول
      if (i === 1) {
        firstExpenseId = expenseId;
        
        // تحديث حركة الخزينة
        await transaction.request()
          .input('cashTransId', sql.Int, cashTransId)
          .input('referenceId', sql.Int, expenseId)
          .query(`
            UPDATE CashboxTransactions 
            SET ReferenceID = @referenceId 
            WHERE CashboxTransactionID = @cashTransId
          `);
      }
    }

    return firstExpenseId;
  } catch (err) {
    throw err;
  }
}

// ====================== إضافة مصروف (الوظيفة الرئيسية) ======================
async function createExpense(expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const { isAdvance, advanceMonths } = expenseData;
    let expenseId;

    if (isAdvance && advanceMonths > 1) {
      // مصروف مقدم
      expenseId = await createAdvanceExpense(expenseData, transaction);
    } else {
      // مصروف عادي
      expenseId = await createRegularExpense(expenseData, transaction);
    }

    await transaction.commit();
    return expenseId;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ====================== تعديل مصروف ======================
async function updateExpense(id, expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // 1. جلب البيانات القديمة أولاً
    const oldExpenseResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT CashBoxID, Amount FROM Expenses WHERE ExpenseID = @id
      `);

    if (!oldExpenseResult.recordset[0]) {
      throw new Error('المصروف غير موجود');
    }

    const oldCashBoxId = oldExpenseResult.recordset[0].CashBoxID;
    const oldAmount = oldExpenseResult.recordset[0].Amount;
    const newCashBoxId = expenseData.cashBoxId;
    const newAmount = expenseData.amount;

    // 2. تعديل المصروف
    await transaction.request()
      .input('id', sql.Int, id)
      .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, newCashBoxId)
      .input('amount', sql.Decimal(18, 2), newAmount)
      .input('expenseDate', sql.DateTime, expenseData.expenseDate)
      .input('notes', sql.NVarChar(255), expenseData.notes || null)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .input('isAdvance', sql.Bit, expenseData.isAdvance || false)
      .input('advanceMonths', sql.Int, expenseData.advanceMonths || null)
      .query(`
        UPDATE Expenses SET
          ExpenseName = @expenseName, ExpenseGroupID = @expenseGroupId,
          CashBoxID = @cashBoxId, Amount = @amount, ExpenseDate = @expenseDate,
          Notes = @notes, Torecipient = @toRecipient, 
          IsAdvance = @isAdvance, AdvanceMonths = @advanceMonths
        WHERE ExpenseID = @id
      `);

    // 3. التعامل مع حركة الخزينة
    if (oldCashBoxId !== newCashBoxId || oldAmount !== newAmount) {
      // 3.1 حذف الحركة القديمة إذا اختلفت الخزينة أو المبلغ
      await transaction.request()
        .input('referenceId', sql.Int, id)
        .query(`
          DELETE FROM CashboxTransactions 
          WHERE ReferenceID = @referenceId AND ReferenceType IN ('Expense', 'AdvanceExpense')
        `);

      // 3.2 إضافة حركة جديدة
      await transaction.request()
        .input('cashBoxId', sql.Int, newCashBoxId)
        .input('referenceId', sql.Int, id)
        .input('amount', sql.Decimal(18, 2), newAmount)
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
    } else {
      // 3.3 تعديل الحركة الحالية إذا نفس الخزينة
      await transaction.request()
        .input('referenceId', sql.Int, id)
        .input('amount', sql.Decimal(18, 2), newAmount)
        .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
        .query(`
          UPDATE CashboxTransactions SET 
            Amount = @amount, Notes = @notes
          WHERE ReferenceID = @referenceId AND ReferenceType IN ('Expense', 'AdvanceExpense')
        `);
    }

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ====================== حذف مصروف ======================
async function deleteExpense(id) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // 1. حذف حركة الخزينة
    await transaction.request()
      .input('referenceId', sql.Int, id)
      .query(`
        DELETE FROM CashboxTransactions 
        WHERE ReferenceID = @referenceId AND ReferenceType IN ('Expense', 'AdvanceExpense')
      `);

    // 2. حذف المصروف
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

// جلب مجموعات حسب الأب
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

// جلب مصروف واحد بالـ ID
async function getExpenseById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT * FROM Expenses WHERE ExpenseID = @id
    `);
  return result.recordset[0];
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
  getExpenseGroupsByParent,
  getExpenseById
};