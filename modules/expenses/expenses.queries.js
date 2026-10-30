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
    .query('SELECT CashBoxID, CashBoxName, Description, BranchID, IsActive FROM CashBoxes ORDER BY CashBoxName');
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
           AND MONTH(ExpenseDate) = MONTH(GETDATE())) as monthAmount,
        (SELECT ISNULL(SUM(Amount), 0) FROM Expenses 
         WHERE YEAR(ExpenseDate) = YEAR(DATEADD(MONTH,-1,GETDATE())) 
           AND MONTH(ExpenseDate) = MONTH(DATEADD(MONTH,-1,GETDATE()))) as prevMonthAmount
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
      e.AdvanceParentExpenseId, e.AdvanceMonthIndex, e.BranchID,
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

// ═══════════════════════════════════════════════════════════
// حرّاس بلازور — ExpenseService.SaveExpenseAsync:581 بنفس الترتيب والرسائل
// ═══════════════════════════════════════════════════════════
function guardError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function money2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

async function getCashBoxBalanceInTx(transaction, cashBoxId) {
  // تعريف ExpenseService.GetCashBoxBalanceAsync:828 حرفيًا: قبض − صرف من
  // الحركات فقط — الرصيد الافتتاحي المخزّن مستبعَد عمدًا (مرآة مقصودة).
  const result = await transaction.request()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`
      SELECT ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                             WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0) AS Balance
      FROM CashboxTransactions WHERE CashBoxID = @cashBoxId
    `);
  return money2(result.recordset[0]?.Balance || 0);
}

async function assertBranchAndCashbox(transaction, branchId, cashBoxId) {
  if (branchId == null || !(Number(branchId) > 0)) throw guardError('الفرع مطلوب');
  const cashResult = await transaction.request()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`SELECT CashBoxID, BranchID, IsActive FROM CashBoxes WHERE CashBoxID = @cashBoxId`);
  const cashbox = cashResult.recordset[0];
  if (!cashbox) throw guardError('الخزينة المحددة غير موجودة');
  if (!cashbox.IsActive) throw guardError('الخزينة المحددة غير نشطة');
  if (cashbox.BranchId == null) throw guardError('الخزينة المحددة غير مربوطة بفرع');
  if (Number(cashbox.BranchId) !== Number(branchId)) {
    throw guardError('لا يمكن اختيار خزينة من فرع مختلف عن فرع المصروف');
  }
  const branchResult = await transaction.request()
    .input('branchId', sql.Int, branchId)
    .query(`SELECT BranchID FROM Branches WHERE BranchID = @branchId AND ISNULL(IsActive, 0) = 1`);
  if (!branchResult.recordset[0]) throw guardError('الفرع المحدد غير موجود أو غير نشط');
}

// ====================== مصروف عادي ======================
async function createRegularExpense(expenseData, transaction) {
  await transaction.request()
    .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
    .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('branchId', sql.Int, expenseData.branchId)
    .input('amount', sql.Decimal(18, 2), expenseData.amount)
    .input('expenseDate', sql.DateTime, expenseData.expenseDate || new Date())
    .input('notes', sql.NVarChar(255), expenseData.notes || null)
    .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
    .input('isAdvance', sql.Bit, false)
    .input('advanceMonths', sql.Int, null)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO Expenses (
        ExpenseName, ExpenseGroupID, CashBoxID, BranchID, Amount, ExpenseDate,
        Notes, Torecipient, IsAdvance, AdvanceMonths,
        AdvanceParentExpenseId, AdvanceMonthIndex, CreatedBy, CreatedAt
      )
      VALUES (
        @expenseName, @expenseGroupId, @cashBoxId, @branchId, @amount, @expenseDate,
        @notes, @toRecipient, @isAdvance, @advanceMonths,
        NULL, NULL, @createdBy, GETDATE()
      );
    `);

  const idResult = await transaction.request()
    .query('SELECT SCOPE_IDENTITY() AS ExpenseID');
  const expenseId = idResult.recordset[0].ExpenseID;

  // حركة الخزينة بتاريخ المصروف نفسه (لا بتاريخ الإنشاء)
  await transaction.request()
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('referenceId', sql.Int, expenseId)
    .input('amount', sql.Decimal(18, 2), expenseData.amount)
    .input('expenseDate', sql.DateTime, expenseData.expenseDate || new Date())
    .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
        Amount, TransactionDate, Notes, CreatedBy, CreatedAt
      )
      VALUES (
        @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
        @amount, @expenseDate, @notes, @createdBy, GETDATE()
      )
    `);

  return expenseId;
}

// ====================== مصروف مقدم ======================
// مرآة كتلة المقدم في SaveExpenseAsync: الأصل Amount=0 وAdvanceMonthIndex=0،
// والأشهر i=1..N بقسط مقرب لمنزلتين وآخر شهر يمتص فرق التقريب، وحركة خزينة
// واحدة على الأصل بنوع مرجع 'Expense'.
async function createAdvanceExpense(expenseData, transaction) {
  const months = Number(expenseData.advanceMonths);
  const total = money2(expenseData.amount);
  const baseDate = expenseData.expenseDate ? new Date(expenseData.expenseDate) : new Date();

  await transaction.request()
    .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
    .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('branchId', sql.Int, expenseData.branchId)
    .input('expenseDate', sql.DateTime, baseDate)
    .input('notes', sql.NVarChar(255), expenseData.notes || null)
    .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
    .input('advanceMonths', sql.Int, months)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO Expenses (
        ExpenseName, ExpenseGroupID, CashBoxID, BranchID, Amount, ExpenseDate,
        Notes, Torecipient, IsAdvance, AdvanceMonths,
        AdvanceParentExpenseId, AdvanceMonthIndex, CreatedBy, CreatedAt
      )
      VALUES (
        @expenseName, @expenseGroupId, @cashBoxId, @branchId, 0, @expenseDate,
        @notes, @toRecipient, 1, @advanceMonths,
        NULL, 0, @createdBy, GETDATE()
      );
    `);
  const parentResult = await transaction.request()
    .query('SELECT SCOPE_IDENTITY() AS ExpenseID');
  const parentId = parentResult.recordset[0].ExpenseID;

  const monthlyAmount = money2(total / months);
  const difference = money2(total - monthlyAmount * months);
  for (let i = 1; i <= months; i++) {
    const monthDate = new Date(baseDate);
    monthDate.setMonth(monthDate.getMonth() + (i - 1));
    const amount = i === months ? money2(monthlyAmount + difference) : monthlyAmount;
    await transaction.request()
      .input('expenseName', sql.NVarChar(100), `${expenseData.expenseName} - شهر ${i}/${months}`)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('branchId', sql.Int, expenseData.branchId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, monthDate)
      .input('notes', sql.NVarChar(255), `الشهر رقم ${i} من المصروف المقدم`)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .input('advanceMonths', sql.Int, months)
      .input('parentId', sql.Int, parentId)
      .input('monthIndex', sql.Int, i)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
      .query(`
        INSERT INTO Expenses (
          ExpenseName, ExpenseGroupID, CashBoxID, BranchID, Amount, ExpenseDate,
          Notes, Torecipient, IsAdvance, AdvanceMonths,
          AdvanceParentExpenseId, AdvanceMonthIndex, CreatedBy, CreatedAt
        )
        VALUES (
          @expenseName, @expenseGroupId, @cashBoxId, @branchId, @amount, @expenseDate,
          @notes, @toRecipient, 1, @advanceMonths,
          @parentId, @monthIndex, @createdBy, GETDATE()
        );
      `);
  }

  // خصم واحد من الخزينة على الأصل بالمبلغ الكلي وبتاريخ المصروف
  await transaction.request()
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('referenceId', sql.Int, parentId)
    .input('amount', sql.Decimal(18, 2), total)
    .input('expenseDate', sql.DateTime, baseDate)
    .input('notes', sql.NVarChar(sql.MAX), `مصروف مقدم: ${expenseData.expenseName} (${months} شهور)`)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
        Amount, TransactionDate, Notes, CreatedBy, CreatedAt
      )
      VALUES (
        @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
        @amount, @expenseDate, @notes, @createdBy, GETDATE()
      )
    `);

  return parentId;
}

// ====================== إضافة مصروف (الوظيفة الرئيسية) ======================
async function createExpense(expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const branchId = Number(expenseData.branchId ?? expenseData.BranchId) || null;
    const amount = money2(expenseData.amount);
    if (!String(expenseData.expenseName || '').trim()) throw guardError('اسم المصروف مطلوب');
    if (!(amount > 0)) throw guardError('المبلغ يجب أن يكون أكبر من صفر');
    if (!expenseData.cashBoxId) throw guardError('الخزينة مطلوبة');
    if (!expenseData.expenseGroupId) throw guardError('مجموعة المصروف مطلوبة');
    await assertBranchAndCashbox(transaction, branchId, expenseData.cashBoxId);

    const isAdvance = Boolean(expenseData.isAdvance);
    const months = Number(expenseData.advanceMonths) || 0;
    if (isAdvance) {
      if (months < 1) throw guardError('عدد الشهور يجب أن يكون على الأقل 1');
      if (months > 60) throw guardError('الحد الأقصى لعدد الشهور هو 60 شهر');
    }

    // حارس الرصيد عند الإنشاء: الرصيد (قبض − صرف) يغطي كامل المبلغ
    const balance = await getCashBoxBalanceInTx(transaction, expenseData.cashBoxId);
    if (balance < amount) {
      throw guardError(`رصيد الخزينة غير كافي. المتاح: ${balance.toFixed(2)}`);
    }

    const data = { ...expenseData, branchId, amount };
    // التقسيم فقط عندما تكون الشهور أكثر من شهر واحد
    const expenseId = isAdvance && months > 1
      ? await createAdvanceExpense(data, transaction)
      : await createRegularExpense(data, transaction);

    await transaction.commit();
    return expenseId;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ====================== تعديل مصروف ======================
async function updateExpense(id, expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const existingResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM Expenses WHERE ExpenseID = @id`);
    const existing = existingResult.recordset[0];
    if (!existing) throw guardError('المصروف غير موجود', 404);

    // منع تعديل عائلة المقدم — رسائل بلازور حرفيًا
    if (existing.AdvanceParentExpenseId != null) {
      throw guardError('هذا شهر فرعي من مصروف مقدم - لا يمكن تعديله. عدّل الأصل أو احذفه.');
    }
    if (existing.IsAdvance && Number(existing.AdvanceMonthIndex) === 0) {
      throw guardError('لا يمكن تعديل مصروف مقدم بعد الحفظ. احذفه وأنشئ واحد جديد.');
    }

    const branchId = Number(expenseData.branchId ?? expenseData.BranchId ?? existing.BranchId) || null;
    const amount = money2(expenseData.amount);
    if (!String(expenseData.expenseName || '').trim()) throw guardError('اسم المصروف مطلوب');
    if (!(amount > 0)) throw guardError('المبلغ يجب أن يكون أكبر من صفر');
    if (!expenseData.cashBoxId) throw guardError('الخزينة مطلوبة');
    if (!expenseData.expenseGroupId) throw guardError('مجموعة المصروف مطلوبة');
    await assertBranchAndCashbox(transaction, branchId, expenseData.cashBoxId);

    // حارس الرصيد عند التعديل: الزيادة فقط، أو كامل المبلغ عند تغيير الخزينة
    const oldAmount = money2(existing.Amount);
    const cashBoxChanged = Number(existing.CashBoxID) !== Number(expenseData.cashBoxId);
    const requiredAmount = cashBoxChanged ? amount : Math.max(amount - oldAmount, 0);
    if (requiredAmount > 0) {
      const balance = await getCashBoxBalanceInTx(transaction, expenseData.cashBoxId);
      if (balance < requiredAmount) {
        throw guardError(cashBoxChanged
          ? `رصيد الخزينة غير كافي. الخزينة الجديدة هتدفع المبلغ كامل (${requiredAmount.toFixed(2)}) والمتاح: ${balance.toFixed(2)}`
          : `رصيد الخزينة غير كافي. قيمة الزيادة المطلوبة: ${requiredAmount.toFixed(2)} والمتاح: ${balance.toFixed(2)}`);
      }
    }

    const expenseDate = expenseData.expenseDate ? new Date(expenseData.expenseDate) : existing.ExpenseDate;
    await transaction.request()
      .input('id', sql.Int, id)
      .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('branchId', sql.Int, branchId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, expenseDate)
      .input('notes', sql.NVarChar(255), expenseData.notes || null)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .query(`
        UPDATE Expenses SET
          ExpenseName = @expenseName, ExpenseGroupID = @expenseGroupId,
          CashBoxID = @cashBoxId, BranchID = @branchId,
          Amount = @amount, ExpenseDate = @expenseDate,
          Notes = @notes, Torecipient = @toRecipient,
          IsAdvance = 0, AdvanceMonths = NULL, AdvanceMonthIndex = NULL
        WHERE ExpenseID = @id
      `);

    // استبدال حركة الخزينة بالكامل بالمبلغ الجديد وبتاريخ المصروف
    await transaction.request()
      .input('referenceId', sql.Int, id)
      .query(`
        DELETE FROM CashboxTransactions
        WHERE ReferenceID = @referenceId AND ReferenceType IN ('Expense', 'AdvanceExpense')
      `);
    await transaction.request()
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('referenceId', sql.Int, id)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, expenseDate)
      .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy || existing.CreatedBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
          Amount, TransactionDate, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
          @amount, @expenseDate, @notes, @createdBy, GETDATE()
        )
      `);

    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ====================== حذف مصروف ======================
// مرآة DeleteExpenseAsync:839 — حذف أي صف من العائلة يحذف الأصل وكل الأشهر
// وحركة خزينة الأصل.
async function deleteExpense(id) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const existingResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT ExpenseID, AdvanceParentExpenseId FROM Expenses WHERE ExpenseID = @id`);
    const existing = existingResult.recordset[0];
    if (!existing) throw guardError('المصروف غير موجود', 404);
    const parentId = existing.AdvanceParentExpenseId ?? existing.ExpenseID;

    await transaction.request()
      .input('parentId', sql.Int, parentId)
      .query(`
        DELETE FROM CashboxTransactions
        WHERE ReferenceType = 'Expense' AND ReferenceID = @parentId
      `);
    // تنظيف إرثي: حركات 'AdvanceExpense' القديمة كانت تشير لأول شهر فرعي
    await transaction.request()
      .input('parentId', sql.Int, parentId)
      .query(`
        DELETE FROM CashboxTransactions
        WHERE ReferenceType = 'AdvanceExpense'
          AND ReferenceID IN (
            SELECT ExpenseID FROM Expenses
            WHERE ExpenseID = @parentId OR AdvanceParentExpenseId = @parentId
          )
      `);
    await transaction.request()
      .input('parentId', sql.Int, parentId)
      .query(`
        DELETE FROM Expenses
        WHERE ExpenseID = @parentId OR AdvanceParentExpenseId = @parentId
      `);

    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
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



// ═══════════════════════════════════════════════════════════
// 📊 داشبورد المصروفات الكامل
// ═══════════════════════════════════════════════════════════
async function getExpenseDashboard() {
  const pool = await connectDB();

  // 1. الملخص
  const summary = await getExpensesSummary();

  // 2. آخر 30 يوم
  const last30Res = await pool.request().query(`
    SELECT
      CAST(ExpenseDate AS DATE) AS Date,
      ISNULL(SUM(Amount), 0) AS Total
    FROM Expenses
    WHERE ExpenseDate >= DATEADD(DAY, -29, CAST(GETDATE() AS DATE))
    GROUP BY CAST(ExpenseDate AS DATE)
    ORDER BY CAST(ExpenseDate AS DATE)
  `);

  // 3. توزيع المجموعات (الشهر الحالي)
  const breakdownRes = await pool.request().query(`
    SELECT TOP 8
      ISNULL(g.ExpenseGroupName, N'غير مصنف') AS GroupName,
      ISNULL(SUM(e.Amount), 0) AS Total,
      COUNT(*) AS Count
    FROM Expenses e
    LEFT JOIN ExpenseGroups g ON e.ExpenseGroupID = g.ExpenseGroupID
    WHERE YEAR(e.ExpenseDate) = YEAR(GETDATE())
      AND MONTH(e.ExpenseDate) = MONTH(GETDATE())
    GROUP BY g.ExpenseGroupName
    ORDER BY SUM(e.Amount) DESC
  `);

  // 4. آخر المصروفات
  const recentRes = await pool.request().query(`
    SELECT TOP 8
      e.ExpenseID, e.ExpenseName, e.ExpenseDate, e.Amount,
      e.Notes, e.CreatedBy,
      g.ExpenseGroupName
    FROM Expenses e
    LEFT JOIN ExpenseGroups g ON e.ExpenseGroupID = g.ExpenseGroupID
    ORDER BY e.ExpenseDate DESC
  `);

  // 5. أعلى 5 مصروفات هذا الشهر
  const topRes = await pool.request().query(`
    SELECT TOP 5
      e.ExpenseName,
      ISNULL(SUM(e.Amount), 0) AS Total
    FROM Expenses e
    WHERE YEAR(e.ExpenseDate) = YEAR(GETDATE())
      AND MONTH(e.ExpenseDate) = MONTH(GETDATE())
    GROUP BY e.ExpenseName
    ORDER BY SUM(e.Amount) DESC
  `);

  return {
    summary,
    last30Days: last30Res.recordset,
    breakdown: breakdownRes.recordset,
    recent: recentRes.recordset,
    topExpenses: topRes.recordset,
  };
}

// ═══════════════════════════════════════════════════════════
// إنشاء مجموعة مصروفات
// ═══════════════════════════════════════════════════════════
async function createExpenseGroup({ expenseGroupName, parentGroupId = null }) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('name', sql.NVarChar(200), expenseGroupName)
    .input('parentId', sql.Int, parentGroupId)
    .query(`
      INSERT INTO ExpenseGroups (ExpenseGroupName, ParentGroupID)
      OUTPUT INSERTED.ExpenseGroupID
      VALUES (@name, @parentId)
    `);
  return result.recordset[0]?.ExpenseGroupID || null;
}

// تصدير الدوال
module.exports = {
  getExpenseGroups,
  getCashboxes,
  getExpensesSummary,
  getExpenseDashboard,
  getAllExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseGroupsByParent,
  createExpenseGroup,
  getExpenseById
};