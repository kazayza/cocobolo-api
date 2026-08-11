const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════
// 👤 الحسابات الشخصية (مطابق لمنطق بلازور PersonalAccountService)
// الحركات بتتسجل في CashboxTransactions بنوع ReferenceType='Loan'
// ═══════════════════════════════════════════════════════════

const ACCOUNT_TYPES = {
  Owner: 'صاحب الشركة / مالك',
  Investor: 'مستثمر / شريك',
  Lender: 'مقرض',
  Employee: 'موظف (سلفة)',
  Other: 'أخرى',
};

const TYPE_COLORS = {
  Owner: '#d4af37',
  Investor: '#8b5cf6',
  Lender: '#3b82f6',
  Employee: '#10b981',
  Other: '#6b7280',
};

// ═══════════════════════════════════════════════════════════
// حساب الرصيد الحالي (نفس BuildAccountDtoAsync في بلازور)
// ═══════════════════════════════════════════════════════════
async function computeAccountStats(pool, account) {
  const res = await pool.request()
    .input('refId', sql.Int, account.PersonalAccountId)
    .query(`
      SELECT
        ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS TotalIn,
        ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS TotalOut,
        COUNT(*) AS TxCount,
        MAX(TransactionDate) AS LastDate
      FROM CashboxTransactions
      WHERE ReferenceType = 'Loan' AND ReferenceID = @refId
    `);
  const s = res.recordset[0] || { TotalIn: 0, TotalOut: 0, TxCount: 0, LastDate: null };
  const totalIn = s.TotalIn ?? 0;
  const totalOut = s.TotalOut ?? 0;
  const openingDebit = account.OpeningType === 'Debit' ? account.OpeningBalance : 0;
  const openingCredit = account.OpeningType === 'Credit' ? account.OpeningBalance : 0;
  const balance = (openingCredit - openingDebit) + (totalIn - totalOut);

  return {
    TotalIn: totalIn,
    TotalOut: totalOut,
    CurrentBalance: balance,
    TransactionsCount: s.TxCount ?? 0,
    LastTransactionDate: s.LastDate || null,
    AccountTypeAr: ACCOUNT_TYPES[account.AccountType] || account.AccountType || 'أخرى',
    AccountTypeColor: TYPE_COLORS[account.AccountType] || '#6b7280',
    BalanceStatus:
      balance > 0 ? 'له على الشركة' :
      balance < 0 ? 'عليه للشركة' : 'مسوى',
  };
}

// ═══════════════════════════════════════════════════════════
// قائمة الحسابات + إحصائيات
// ═══════════════════════════════════════════════════════════
async function getAccounts(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let where = ' WHERE 1=1';

  const search = (filters.search || '').trim();
  if (search) {
    where += ` AND (a.AccountName LIKE @search OR ISNULL(a.Phone,'') LIKE @search OR ISNULL(a.NationalId,'') LIKE @search)`;
    request.input('search', sql.NVarChar(200), `%${search}%`);
  }
  if (filters.accountType) {
    where += ` AND a.AccountType = @type`;
    request.input('type', sql.NVarChar(50), filters.accountType);
  }
  if (filters.isActive !== undefined && filters.isActive !== null && filters.isActive !== '') {
    const active = filters.isActive === 'true' || filters.isActive === true || filters.isActive === 1;
    where += ` AND a.IsActive = @active`;
    request.input('active', sql.Bit, active ? 1 : 0);
  }

  const totalRes = await request.query(`SELECT COUNT(*) AS Total FROM PersonalAccounts a${where}`);
  const total = totalRes.recordset[0]?.Total || 0;

  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit, 10) || 25));
  const offset = (page - 1) * limit;

  const listRes = await request
    .input('pageSize', sql.Int, limit)
    .input('offset', sql.Int, offset)
    .query(`
      SELECT a.*
      FROM PersonalAccounts a
      ${where}
      ORDER BY a.IsActive DESC, a.AccountName
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `);

  const accounts = [];
  for (const a of listRes.recordset) {
    const stats = await computeAccountStats(pool, a);
    accounts.push({
      PersonalAccountId: a.PersonalAccountId,
      AccountName: a.AccountName,
      AccountType: a.AccountType,
      AccountTypeAr: stats.AccountTypeAr,
      AccountTypeColor: stats.AccountTypeColor,
      Phone: a.Phone,
      Email: a.Email,
      NationalId: a.NationalId,
      Notes: a.Notes,
      IsActive: !!a.IsActive,
      OpeningBalance: a.OpeningBalance,
      OpeningType: a.OpeningType,
      TotalIn: stats.TotalIn,
      TotalOut: stats.TotalOut,
      CurrentBalance: stats.CurrentBalance,
      BalanceStatus: stats.BalanceStatus,
      TransactionsCount: stats.TransactionsCount,
      LastTransactionDate: stats.LastTransactionDate,
      CreatedBy: a.CreatedBy,
      CreatedAt: a.CreatedAt,
    });
  }

  // فلتر الرصيد (Positive/Negative/Zero) — بعد الحساب
  let filtered = accounts;
  if (filters.balanceFilter && filters.balanceFilter !== 'All') {
    if (filters.balanceFilter === 'Positive') filtered = accounts.filter(a => a.CurrentBalance > 0);
    else if (filters.balanceFilter === 'Negative') filtered = accounts.filter(a => a.CurrentBalance < 0);
    else if (filters.balanceFilter === 'Zero') filtered = accounts.filter(a => a.CurrentBalance === 0);
  }

  // الإحصائيات الكلية (من كل الحسابات النشطة)
  const statsRes = await pool.request().query(`
    SELECT
      ISNULL(SUM(CASE WHEN (ISNULL(OpeningBalance,0) * (CASE WHEN OpeningType='Debit' THEN -1 ELSE 1 END)) > 0 THEN 1 ELSE 0 END), 0) AS dummy
    FROM PersonalAccounts WHERE IsActive = 1
  `);

  return {
    data: filtered,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ═══════════════════════════════════════════════════════════
// إحصائيات كل الحسابات (دائنون/مدينون)
// ═══════════════════════════════════════════════════════════
async function getTotals() {
  const pool = await connectDB();
  const res = await pool.request().query(`
    SELECT a.PersonalAccountId, a.OpeningBalance, a.OpeningType
    FROM PersonalAccounts a WHERE ISNULL(a.IsActive, 1) = 1
  `);

  let totalCreditors = 0;
  let totalDebtors = 0;
  for (const a of res.recordset) {
    const stats = await computeAccountStats(pool, a);
    const bal = stats.CurrentBalance;
    if (bal > 0) totalCreditors += bal;
    else if (bal < 0) totalDebtors += Math.abs(bal);
  }

  return {
    TotalCreditors: totalCreditors,
    TotalDebtors: totalDebtors,
    Net: totalDebtors - totalCreditors,
    NetLabel: totalDebtors >= totalCreditors ? 'لصالحكم' : 'عليكم',
  };
}

// ═══════════════════════════════════════════════════════════
// حساب واحد + كشف حساب
// ═══════════════════════════════════════════════════════════
async function getAccountById(id) {
  const pool = await connectDB();
  const res = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT * FROM PersonalAccounts WHERE PersonalAccountId = @id');
  const a = res.recordset[0];
  if (!a) return null;

  const stats = await computeAccountStats(pool, a);
  return {
    PersonalAccountId: a.PersonalAccountId,
    AccountName: a.AccountName,
    AccountType: a.AccountType,
    AccountTypeAr: stats.AccountTypeAr,
    AccountTypeColor: stats.AccountTypeColor,
    Phone: a.Phone,
    Email: a.Email,
    NationalId: a.NationalId,
    Notes: a.Notes,
    IsActive: !!a.IsActive,
    OpeningBalance: a.OpeningBalance,
    OpeningDate: a.OpeningDate,
    OpeningType: a.OpeningType,
    TotalIn: stats.TotalIn,
    TotalOut: stats.TotalOut,
    CurrentBalance: stats.CurrentBalance,
    BalanceStatus: stats.BalanceStatus,
    TransactionsCount: stats.TransactionsCount,
    LastTransactionDate: stats.LastTransactionDate,
    CreatedBy: a.CreatedBy,
    CreatedAt: a.CreatedAt,
  };
}

// كشف حساب (نفس GetStatementAsync في بلازور)
async function getStatement(accountId, from = null, to = null) {
  const pool = await connectDB();
  const account = await getAccountById(accountId);
  if (!account) return null;

  const request = pool.request();
  let where = ` ReferenceType = 'Loan' AND ReferenceID = @accountId`;
  request.input('accountId', sql.Int, accountId);

  // الرصيد الافتتاحي عند بداية الفترة
  let openingAtStart =
    (account.OpeningType === 'Credit' ? account.OpeningBalance : 0) -
    (account.OpeningType === 'Debit' ? account.OpeningBalance : 0);

  if (from) {
    const before = await request
      .input('fromDate', sql.Date, from)
      .query(`
        SELECT
          ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS InAmt,
          ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS OutAmt
        FROM CashboxTransactions
        WHERE ${where} AND TransactionDate < @fromDate
      `);
    const b = before.recordset[0] || { InAmt: 0, OutAmt: 0 };
    openingAtStart += (b.InAmt - b.OutAmt);
  }

  let whereDate = '';
  if (from) {
    whereDate += ' AND TransactionDate >= @fromDate2';
    request.input('fromDate2', sql.Date, from);
  }
  if (to) {
    whereDate += ' AND TransactionDate <= DATEADD(DAY, 1, @toDate)';
    request.input('toDate', sql.Date, to);
  }

  const txRes = await request.query(`
    SELECT
      ct.CashboxTransactionID, ct.TransactionDate, ct.TransactionType,
      ct.Amount, ct.Notes, ct.CreatedBy, ct.CashBoxID,
      c.CashBoxName
    FROM CashboxTransactions ct
    LEFT JOIN CashBoxes c ON ct.CashBoxID = c.CashBoxID
    WHERE ${where}${whereDate}
    ORDER BY ct.TransactionDate ASC, ct.CashboxTransactionID ASC
  `);

  let running = openingAtStart;
  const transactions = [];
  for (const t of txRes.recordset) {
    const amountIn = t.TransactionType === 'قبض' ? t.Amount : 0;
    const amountOut = t.TransactionType === 'صرف' ? t.Amount : 0;
    running += (amountIn - amountOut);
    transactions.push({
      CashboxTransactionId: t.CashboxTransactionID,
      TransactionDate: t.TransactionDate,
      Description: amountIn > 0 ? 'قرض دخل من الحساب' : 'تسديد قرض للحساب',
      AmountIn: amountIn,
      AmountOut: amountOut,
      RunningBalance: running,
      CashBoxName: t.CashBoxName,
      Notes: t.Notes,
      CreatedBy: t.CreatedBy,
    });
  }

  return {
    Account: account,
    FromDate: from,
    ToDate: to,
    OpeningBalanceAtStart: openingAtStart,
    ClosingBalanceAtEnd: running,
    Transactions: transactions,
  };
}

// ═══════════════════════════════════════════════════════════
// إنشاء / تعديل / حذف حساب
// ═══════════════════════════════════════════════════════════
async function createAccount(data, userName = 'System') {
  const pool = await connectDB();
  if (!data.accountName || !data.accountName.trim()) {
    return { success: false, message: 'اسم الحساب مطلوب' };
  }

  const result = await pool.request()
    .input('accountName', sql.NVarChar(200), String(data.accountName).trim())
    .input('accountType', sql.NVarChar(50), data.accountType || 'Other')
    .input('phone', sql.NVarChar(50), data.phone || null)
    .input('email', sql.NVarChar(200), data.email || null)
    .input('nationalId', sql.NVarChar(50), data.nationalId || null)
    .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
    .input('openingBalance', sql.Decimal(18, 2), parseFloat(data.openingBalance || 0))
    .input('openingDate', sql.Date, data.openingDate ? new Date(data.openingDate) : new Date())
    .input('openingType', sql.NVarChar(20), data.openingType || 'Credit')
    .input('createdBy', sql.NVarChar(100), userName)
    .query(`
      DECLARE @ids TABLE (id INT);
      INSERT INTO PersonalAccounts (
        AccountName, AccountType, Phone, Email, NationalId, Notes,
        OpeningBalance, OpeningDate, OpeningType, IsActive,
        CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.PersonalAccountId INTO @ids
      VALUES (
        @accountName, @accountType, @phone, @email, @nationalId, @notes,
        @openingBalance, @openingDate, @openingType, 1,
        @createdBy, GETDATE()
      );
      SELECT id FROM @ids;
    `);

  const id = result.recordset[0]?.id;
  return { success: true, accountId: id, message: 'تم إنشاء الحساب بنجاح' };
}

async function updateAccount(id, data, userName = 'System') {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .input('accountName', sql.NVarChar(200), String(data.accountName || '').trim())
    .input('accountType', sql.NVarChar(50), data.accountType || 'Other')
    .input('phone', sql.NVarChar(50), data.phone || null)
    .input('email', sql.NVarChar(200), data.email || null)
    .input('nationalId', sql.NVarChar(50), data.nationalId || null)
    .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
    .input('openingBalance', sql.Decimal(18, 2), parseFloat(data.openingBalance || 0))
    .input('openingDate', sql.Date, data.openingDate ? new Date(data.openingDate) : null)
    .input('openingType', sql.NVarChar(20), data.openingType || 'Credit')
    .input('isActive', sql.Bit, data.isActive === false || data.isActive === 0 ? 0 : 1)
    .input('updatedBy', sql.NVarChar(100), userName)
    .query(`
      UPDATE PersonalAccounts SET
        AccountName = @accountName,
        AccountType = @accountType,
        Phone = @phone,
        Email = @email,
        NationalId = @nationalId,
        Notes = @notes,
        OpeningBalance = @openingBalance,
        OpeningDate = ISNULL(@openingDate, OpeningDate),
        OpeningType = @openingType,
        IsActive = @isActive,
        LastUpdatedBy = @updatedBy,
        LastUpdatedAt = GETDATE()
      WHERE PersonalAccountId = @id
    `);

  return { success: true, message: 'تم تحديث الحساب بنجاح' };
}

async function deleteAccount(id, userName = 'System') {
  const pool = await connectDB();
  // منع الحذف لو فيه حركات مسجلة — نعمل تعطيل بدل الحذف
  const txRes = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT COUNT(*) AS Cnt FROM CashboxTransactions
      WHERE ReferenceType = 'Loan' AND ReferenceID = @id
    `);

  if ((txRes.recordset[0]?.Cnt || 0) > 0) {
    // فيه حركات → تعطيل فقط
    await pool.request()
      .input('id', sql.Int, id)
      .input('updatedBy', sql.NVarChar(100), userName)
      .query(`
        UPDATE PersonalAccounts SET IsActive = 0, LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE()
        WHERE PersonalAccountId = @id
      `);
    return { success: true, message: 'الحساب عنده حركات — تم تعطيله بدلاً من الحذف', deactivated: true };
  }

  await pool.request().input('id', sql.Int, id).query('DELETE FROM PersonalAccounts WHERE PersonalAccountId = @id');
  return { success: true, message: 'تم حذف الحساب بنجاح' };
}

// ═══════════════════════════════════════════════════════════
// إضافة حركة (قرض دخل / تسديد) — نفس CreateLoanTransactionAsync
// ═══════════════════════════════════════════════════════════
async function createTransaction(accountId, data, userName = 'System') {
  const pool = await connectDB();
  const amount = parseFloat(data.amount || 0);
  if (amount <= 0) return { success: false, message: 'المبلغ يجب أن يكون أكبر من صفر' };
  if (!data.cashBoxId) return { success: false, message: 'الخزينة مطلوبة' };

  const accRes = await pool.request()
    .input('id', sql.Int, accountId)
    .query('SELECT * FROM PersonalAccounts WHERE PersonalAccountId = @id');
  const account = accRes.recordset[0];
  if (!account) return { success: false, message: 'الحساب غير موجود' };
  if (!account.IsActive) return { success: false, message: 'الحساب غير نشط' };

  const operationType = data.operationType === 'LoanIn' ? 'LoanIn' : 'LoanRepayment';
  const transType = operationType === 'LoanIn' ? 'قبض' : 'صرف';

  // لو تسديد (صرف) — فحص رصيد الخزينة (نفس بلازور)
  if (transType === 'صرف') {
    const balRes = await pool.request()
      .input('cashBoxId', sql.Int, data.cashBoxId)
      .query(`
        SELECT
          ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS InAmt,
          ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS OutAmt
        FROM CashboxTransactions WHERE CashBoxID = @cashBoxId
      `);
    const b = balRes.recordset[0] || { InAmt: 0, OutAmt: 0 };
    const balance = (b.InAmt || 0) - (b.OutAmt || 0);
    if (balance < amount) {
      return { success: false, message: `رصيد الخزينة غير كافي. المتاح: ${balance.toFixed(2)}` };
    }
  }

  const notes = data.notes || (transType === 'قبض'
    ? `قرض دخل من ${account.AccountName}`
    : `تسديد قرض إلى ${account.AccountName}`);

  const result = await pool.request()
    .input('cashBoxId', sql.Int, data.cashBoxId)
    .input('transType', sql.NVarChar(20), transType)
    .input('accountId', sql.Int, accountId)
    .input('amount', sql.Decimal(18, 2), amount)
    .input('transDate', sql.DateTime, data.transactionDate ? new Date(data.transactionDate) : new Date())
    .input('notes', sql.NVarChar(sql.MAX), notes)
    .input('createdBy', sql.NVarChar(100), userName)
    .query(`
      DECLARE @ids TABLE (id INT);
      INSERT INTO CashboxTransactions (
        CashBoxID, TransactionType, ReferenceType, ReferenceID,
        Amount, TransactionDate, Notes, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.CashboxTransactionID INTO @ids
      VALUES (
        @cashBoxId, @transType, 'Loan', @accountId,
        @amount, @transDate, @notes, @createdBy, GETDATE()
      );
      SELECT id FROM @ids;
    `);

  const txId = result.recordset[0]?.id;
  return {
    success: true,
    transactionId: txId,
    message: transType === 'قبض' ? 'تم تسجيل القرض الداخل' : 'تم تسجيل التسديد',
  };
}

// أنواع الحسابات (للفورم)
async function getAccountTypes() {
  return Object.entries(ACCOUNT_TYPES).map(([value, label]) => ({
    value,
    label,
    color: TYPE_COLORS[value] || '#6b7280',
  }));
}

module.exports = {
  getAccounts,
  getTotals,
  getAccountById,
  getStatement,
  createAccount,
  updateAccount,
  deleteAccount,
  createTransaction,
  getAccountTypes,
};
