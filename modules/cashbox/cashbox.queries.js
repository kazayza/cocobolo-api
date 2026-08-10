const { sql, connectDB } = require('../../core/database');

// جلب كل الخزائن
async function getAllCashboxes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        c.CashBoxID, c.CashBoxName, c.Description,
        c.CashBoxKind, c.Icon, c.Color, c.IsActive, c.IsDefault,
        c.CreatedBy, c.CreatedAt,
        ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE -Amount END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      ORDER BY c.IsDefault DESC, c.CashBoxName
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

// ═══════════════════════════════════════════════════════════
// 📚 خريطة أنواع المراجع (مطابقة لبلازور CashBoxRefTypes)
// ═══════════════════════════════════════════════════════════
const CASHBOX_REF_LABELS = {
  SaleInvoice: 'فاتورة مبيعات',
  PurchaseInvoice: 'فاتورة مشتريات',
  Expense: 'مصروف',
  Payroll: 'راتب',
  BonusSeparate: 'مكافأة منفصلة',
  CommissionSeparate: 'عمولة منفصلة',
  Loan: 'قرض',
  TransferIn: 'تحويل وارد',
  TransferOut: 'تحويل صادر',
  AdvanceCharge: 'رسوم معاينة',
  ManualReceipt: 'سند قبض يدوي',
  ManualPayment: 'سند صرف يدوي',
  OpeningBalance: 'رصيد افتتاحي',
};

const CASHBOX_REF_COLORS = {
  SaleInvoice: '#10b981',
  PurchaseInvoice: '#ef4444',
  Expense: '#f59e0b',
  Payroll: '#8b5cf6',
  BonusSeparate: '#0ea5e9',
  CommissionSeparate: '#06b6d4',
  Loan: '#3b82f6',
  TransferIn: '#06b6d4',
  TransferOut: '#06b6d4',
  AdvanceCharge: '#84cc16',
  ManualReceipt: '#22c55e',
  ManualPayment: '#dc2626',
  OpeningBalance: '#6366f1',
};

// إثراء الحركات بمعلومات المصدر (مطابق لمنطق بلازور EnrichTransactionsSourceInfoAsync)
async function enrichCashboxTransactions(items) {
  if (!items.length) return items;

  const ids = (arr) => (arr.length ? arr.join(',') : '0');

  // الفواتير (مبيعات/مشتريات)
  const invoiceIds = items
    .filter((t) => (t.ReferenceType === 'SaleInvoice' || t.ReferenceType === 'PurchaseInvoice') && t.ReferenceID)
    .map((t) => t.ReferenceID);
  const invoices = new Map();
  if (invoiceIds.length) {
    const pool = await connectDB();
    try {
      const res = await pool.request().query(
        `SELECT TransactionID, ReferenceNumber, PartyID
         FROM Transactions WHERE TransactionID IN (${ids(invoiceIds)})`
      );
      for (const r of res.recordset) invoices.set(r.TransactionID, r);
    } catch (e) { console.error('⚠️ enrich invoices:', e.message); }
  }

  // العملاء/الموردين
  const partyIds = [...new Set([...invoices.values()].map((i) => i.PartyID).filter(Boolean))];
  const parties = new Map();
  if (partyIds.length) {
    const pool = await connectDB();
    try {
      const res = await pool.request().query(
        `SELECT PartyID, PartyName FROM Parties WHERE PartyID IN (${ids(partyIds)})`
      );
      for (const r of res.recordset) parties.set(r.PartyID, r.PartyName);
    } catch (e) { console.error('⚠️ enrich parties:', e.message); }
  }

  // المصروفات
  const expenseIds = items
    .filter((t) => t.ReferenceType === 'Expense' && t.ReferenceID)
    .map((t) => t.ReferenceID);
  const expenses = new Map();
  if (expenseIds.length) {
    const pool = await connectDB();
    try {
      const res = await pool.request().query(
        `SELECT ExpenseID, ExpenseName, Torecipient
         FROM Expenses WHERE ExpenseID IN (${ids(expenseIds)})`
      );
      for (const r of res.recordset) expenses.set(r.ExpenseID, r);
    } catch (e) { console.error('⚠️ enrich expenses:', e.message); }
  }

  // الرواتب والمكافآت
  const payrollIds = items
    .filter((t) => (t.ReferenceType === 'Payroll' || t.ReferenceType === 'BonusSeparate' || t.ReferenceType === 'CommissionSeparate') && t.ReferenceID)
    .map((t) => t.ReferenceID);
  const payrolls = new Map();
  if (payrollIds.length) {
    const pool = await connectDB();
    try {
      const res = await pool.request().query(
        `SELECT p.PayrollID, p.Notes, e.FullName
         FROM Payroll p
         INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
         WHERE p.PayrollID IN (${ids(payrollIds)})`
      );
      for (const r of res.recordset) payrolls.set(r.PayrollID, r);
    } catch (e) { console.error('⚠️ enrich payrolls:', e.message); }
  }

  // الحسابات الشخصية (قروض)
  const accountIds = items
    .filter((t) => t.ReferenceType === 'Loan' && t.ReferenceID)
    .map((t) => t.ReferenceID);
  const accounts = new Map();
  if (accountIds.length) {
    const pool = await connectDB();
    try {
      const res = await pool.request().query(
        `SELECT PersonalAccountID, AccountName
         FROM PersonalAccounts WHERE PersonalAccountID IN (${ids(accountIds)})`
      );
      for (const r of res.recordset) accounts.set(r.PersonalAccountID, r.AccountName);
    } catch (e) { console.error('⚠️ enrich personal accounts:', e.message); }
  }

  // تحويلات (خزائن)
  const transferIds = items
    .filter((t) => (t.ReferenceType === 'TransferIn' || t.ReferenceType === 'TransferOut') && t.ReferenceID)
    .map((t) => t.ReferenceID);
  const transferBoxes = new Map();
  if (transferIds.length) {
    const pool = await connectDB();
    try {
      const res = await pool.request().query(
        `SELECT CashBoxID, CashBoxName FROM CashBoxes WHERE CashBoxID IN (${ids(transferIds)})`
      );
      for (const r of res.recordset) transferBoxes.set(r.CashBoxID, r.CashBoxName);
    } catch (e) { console.error('⚠️ enrich transfers:', e.message); }
  }

  for (const t of items) {
    // أسماء وألوان الأنواع
    t.ReferenceTypeAr = CASHBOX_REF_LABELS[t.ReferenceType] || t.ReferenceType || '-';
    t.ReferenceColor = CASHBOX_REF_COLORS[t.ReferenceType] || '#94a3b8';
    t.SourceTitle = null;
    t.SourceUrl = null;
    t.PartyName = null;
    t.PersonalAccountName = null;

    switch (t.ReferenceType) {
      case 'SaleInvoice': {
        const inv = invoices.get(t.ReferenceID);
        if (inv) {
          t.SourceTitle = `فاتورة ${inv.ReferenceNumber || t.ReferenceID}`;
          t.SourceUrl = `/sales/invoices/${t.ReferenceID}`;
          t.PartyName = parties.get(inv.PartyID) || null;
        }
        break;
      }
      case 'PurchaseInvoice': {
        const inv = invoices.get(t.ReferenceID);
        if (inv) {
          t.SourceTitle = `فاتورة شراء ${inv.ReferenceNumber || t.ReferenceID}`;
          t.SourceUrl = `/sales/invoices/${t.ReferenceID}`;
          t.PartyName = parties.get(inv.PartyID) || null;
        }
        break;
      }
      case 'Expense': {
        const exp = expenses.get(t.ReferenceID);
        if (exp) {
          t.SourceTitle = `مصروف: ${exp.ExpenseName}`;
          t.SourceUrl = '/expenses';
          t.PartyName = exp.Torecipient || null;
        }
        break;
      }
      case 'Loan': {
        const acc = accounts.get(t.ReferenceID);
        if (acc) {
          t.SourceTitle = `حساب: ${acc}`;
          t.SourceUrl = `/cashbox/personal-accounts/${t.ReferenceID}/statement`;
          t.PersonalAccountName = acc;
        }
        break;
      }
      case 'TransferIn':
      case 'TransferOut': {
        const box = transferBoxes.get(t.ReferenceID);
        if (box) {
          t.SourceTitle = `تحويل ↔ ${box}`;
          t.SourceUrl = `/cashbox/transactions?cashBoxId=${t.ReferenceID}`;
        }
        break;
      }
      case 'Payroll':
      case 'BonusSeparate':
      case 'CommissionSeparate': {
        const pay = payrolls.get(t.ReferenceID);
        if (pay) {
          t.SourceTitle = t.ReferenceType === 'Payroll'
            ? `راتب ${pay.FullName}`
            : `دفعة منفصلة ${pay.FullName}`;
          t.SourceUrl = '/hr/payroll';
          t.PartyName = pay.FullName;
        }
        break;
      }
      case 'AdvanceCharge':
        t.SourceTitle = 'رسوم معاينة';
        t.SourceUrl = '/additional-charges';
        break;
      case 'OpeningBalance':
        t.SourceTitle = 'رصيد افتتاحي';
        break;
      case 'ManualReceipt':
        t.SourceTitle = 'سند قبض يدوي';
        break;
      case 'ManualPayment':
        t.SourceTitle = 'سند صرف يدوي';
        break;
      default:
        break;
    }
  }

  return items;
}

// جلب حركات الخزينة (مع بحث + ترقيم صفحات + إحصائيات + إثراء)
async function getCashboxTransactions(cashboxId = null, startDate = null, endDate = null, transactionType = null, referenceType = null, search = null, page = 1, limit = 25) {
  const pool = await connectDB();

  const request = pool.request();
  let where = ' WHERE 1=1';

  if (cashboxId) {
    where += ' AND ct.CashBoxID = @cashboxId';
    request.input('cashboxId', sql.Int, cashboxId);
  }

  if (startDate) {
    where += ' AND CAST(ct.TransactionDate AS DATE) >= @startDate';
    request.input('startDate', sql.Date, startDate);
  }

  if (endDate) {
    where += ' AND CAST(ct.TransactionDate AS DATE) <= @endDate';
    request.input('endDate', sql.Date, endDate);
  }

  if (transactionType && transactionType !== 'All') {
    where += ' AND ct.TransactionType = @transactionType';
    request.input('transactionType', sql.NVarChar(20), transactionType);
  }

  if (referenceType && referenceType !== 'All') {
    where += ' AND ct.ReferenceType = @referenceType';
    request.input('referenceType', sql.NVarChar(50), referenceType);
  }

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    where += ' AND (ct.Notes LIKE @search OR ct.CreatedBy LIKE @search)';
    request.input('search', sql.NVarChar(200), s);
  }

  // 1) العدد الكلي
  const countRes = await request.query(
    `SELECT COUNT(*) AS Total FROM CashboxTransactions ct${where}`
  );
  const total = countRes.recordset[0]?.Total || 0;

  // 2) الإحصائيات (على المفلتر كله مش الصفحة)
  const statsRes = await request.query(
    `SELECT
       ISNULL(SUM(CASE WHEN ct.TransactionType = N'قبض' THEN ct.Amount ELSE 0 END), 0) AS TotalIn,
       ISNULL(SUM(CASE WHEN ct.TransactionType = N'صرف' THEN ct.Amount ELSE 0 END), 0) AS TotalOut
     FROM CashboxTransactions ct${where}`
  );
  const st = statsRes.recordset[0] || { TotalIn: 0, TotalOut: 0 };
  const stats = {
    TotalIn: st.TotalIn ?? 0,
    TotalOut: st.TotalOut ?? 0,
    Net: (st.TotalIn ?? 0) - (st.TotalOut ?? 0),
  };

  // 3) الصفحة الحالية
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (pageNum - 1) * pageSize;

  const pageRes = await request
    .input('pageSize', sql.Int, pageSize)
    .input('offset', sql.Int, offset)
    .query(`
    SELECT
      ct.CashboxTransactionID, ct.CashBoxID, ct.PaymentID,
      ct.ReferenceID, ct.ReferenceType, ct.TransactionType,
      ct.Amount, ct.TransactionDate, ct.Notes,
      ct.CreatedBy, ct.CreatedAt,
      c.CashBoxName, c.Color AS CashBoxColor
    FROM CashboxTransactions ct
    INNER JOIN CashBoxes c ON ct.CashBoxID = c.CashBoxID
    ${where}
    ORDER BY ct.TransactionDate DESC, ct.CashboxTransactionID DESC
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `);

  const data = await enrichCashboxTransactions(pageRes.recordset);

  return {
    data,
    total,
    page: pageNum,
    limit: pageSize,
    totalPages: Math.ceil(total / pageSize),
    stats,
  };
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