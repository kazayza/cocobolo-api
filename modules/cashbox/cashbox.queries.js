const { sql, connectDB } = require('../../core/database');

// جلب كل الخزائن
async function getAllCashboxes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        c.CashBoxID, c.CashBoxName, c.Description,
        c.BranchID, c.OpeningBalance, c.OpeningDate,
        c.CashBoxKind, c.Icon, c.Color, c.IsActive, c.IsDefault,
        c.CreatedBy, c.CreatedAt,
        ISNULL(c.OpeningBalance, 0) + ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                          WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      ORDER BY c.IsDefault DESC, c.CashBoxName
    `);
  return result.recordset;
}


// جلب الخزائن النشطة فقط — مطابق لبلازور activeOnly:true
async function getActiveCashboxes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        c.CashBoxID, c.CashBoxName, c.Description,
        c.BranchID, c.OpeningBalance, c.OpeningDate,
        c.CashBoxKind, c.Icon, c.Color, c.IsActive, c.IsDefault,
        c.CreatedBy, c.CreatedAt,
        ISNULL(c.OpeningBalance, 0) + ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                          WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      WHERE c.IsActive = 1
      ORDER BY c.IsDefault DESC, c.CashBoxName
    `);
  return result.recordset;
}

// جلب خزينة بالـ ID — مع تحقق رقمي (يمنع EREQUEST Invalid number)
async function getCashboxById(id) {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, parsed)
    .query(`
      SELECT 
        c.*,
        ISNULL(c.OpeningBalance, 0) + ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                          WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END)
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

// ملخص الخزينة بمعالجة فترة — مرآة CashBoxService.GetSummaryAsync:958
// وتركيب صفحة بلازور: لكل خزينة الرصيد الافتتاحي المخزّن، ورصيد أول الفترة
// (المخزّن + صافي ما قبل بدايتها)، ووارد/صادر وعدد الفترة، ورصيد إغلاق
// الفترة، والرصيد الحالي الحقيقي لكل الأوقات بالتعريف الموحد.
async function getCashboxSummary(cashboxId = null, from = null, to = null) {
  const pool = await connectDB();
  const request = pool.request();
  const parsedId = Number(cashboxId);
  const hasBox = cashboxId != null && cashboxId !== '' && Number.isInteger(parsedId) && parsedId > 0;
  if (hasBox) request.input('cashboxId', sql.Int, parsedId);
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  request.input('fromDate', sql.Date, fromDate);
  request.input('toDate', sql.Date, toDate);
  const boxFilter = hasBox ? 'WHERE c.CashBoxID = @cashboxId' : '';
  const result = await request.query(`
    SELECT
      c.CashBoxID, c.CashBoxName, c.CashBoxKind, c.Color, c.IsActive,
      ISNULL(c.OpeningBalance, 0) AS StoredOpeningBalance,
      ISNULL(SUM(CASE WHEN @fromDate IS NOT NULL AND CAST(t.TransactionDate AS DATE) < @fromDate
                      THEN CASE WHEN t.TransactionType = N'قبض' THEN t.Amount
                                WHEN t.TransactionType = N'صرف' THEN -t.Amount ELSE 0 END
                      ELSE 0 END), 0) AS NetBeforePeriod,
      ISNULL(SUM(CASE WHEN (@fromDate IS NULL OR CAST(t.TransactionDate AS DATE) >= @fromDate)
                       AND (@toDate IS NULL OR CAST(t.TransactionDate AS DATE) <= @toDate)
                       AND t.TransactionType = N'قبض' THEN t.Amount ELSE 0 END), 0) AS TotalIn,
      ISNULL(SUM(CASE WHEN (@fromDate IS NULL OR CAST(t.TransactionDate AS DATE) >= @fromDate)
                       AND (@toDate IS NULL OR CAST(t.TransactionDate AS DATE) <= @toDate)
                       AND t.TransactionType = N'صرف' THEN t.Amount ELSE 0 END), 0) AS TotalOut,
      ISNULL(SUM(CASE WHEN (@fromDate IS NULL OR CAST(t.TransactionDate AS DATE) >= @fromDate)
                       AND (@toDate IS NULL OR CAST(t.TransactionDate AS DATE) <= @toDate)
                       AND t.TransactionType = N'قبض' THEN 1 ELSE 0 END), 0) AS InCount,
      ISNULL(SUM(CASE WHEN (@fromDate IS NULL OR CAST(t.TransactionDate AS DATE) >= @fromDate)
                       AND (@toDate IS NULL OR CAST(t.TransactionDate AS DATE) <= @toDate)
                       AND t.TransactionType = N'صرف' THEN 1 ELSE 0 END), 0) AS OutCount,
      ISNULL(SUM(CASE WHEN t.TransactionType = N'قبض' THEN t.Amount
                      WHEN t.TransactionType = N'صرف' THEN -t.Amount ELSE 0 END), 0) AS NetAllTime
    FROM CashBoxes c
    LEFT JOIN CashboxTransactions t ON t.CashBoxID = c.CashBoxID
    ${boxFilter}
    GROUP BY c.CashBoxID, c.CashBoxName, c.CashBoxKind, c.Color, c.IsActive, c.OpeningBalance
    ORDER BY c.IsActive DESC, c.CashBoxName
  `);
  const boxes = result.recordset.map((row) => {
    const stored = Number(row.StoredOpeningBalance || 0);
    const periodOpening = stored + Number(row.NetBeforePeriod || 0);
    const totalIn = Number(row.TotalIn || 0);
    const totalOut = Number(row.TotalOut || 0);
    return {
      CashBoxId: row.CashBoxID,
      CashBoxID: row.CashBoxID,
      CashBoxName: row.CashBoxName,
      CashBoxKind: row.CashBoxKind,
      Color: row.Color,
      IsActive: Boolean(row.IsActive),
      StoredOpeningBalance: stored,
      OpeningBalance: stored,
      PeriodOpeningBalance: periodOpening,
      TotalIn: totalIn,
      TotalOut: totalOut,
      InCount: Number(row.InCount || 0),
      OutCount: Number(row.OutCount || 0),
      ClosingBalance: periodOpening + totalIn - totalOut,
      CurrentBalance: stored + Number(row.NetAllTime || 0),
    };
  });
  const sum = (key) => Math.round(boxes.reduce((acc, b) => acc + Number(b[key] || 0), 0) * 100) / 100;
  return {
    // حقول الإرث للمستهلكين القدامى (إجماليات الفترة على النطاق المطلوب)
    TotalIn: sum('TotalIn'),
    TotalOut: sum('TotalOut'),
    Balance: sum('ClosingBalance'),
    StoredOpeningBalance: sum('StoredOpeningBalance'),
    PeriodOpeningBalance: sum('PeriodOpeningBalance'),
    ClosingBalance: sum('ClosingBalance'),
    CurrentBalance: sum('CurrentBalance'),
    From: fromDate,
    To: toDate,
    Boxes: boxes,
    boxes,
  };
}

// ═══════════════════════════════════════════════════════════
// إدارة الخزن — مرآة CashBoxService.SaveCashBoxAsync:112
// (الأصناف من DTOS/CashBoxDto.cs CashBoxKinds)
// ═══════════════════════════════════════════════════════════
const CASHBOX_KINDS = {
  Cash: { icon: 'AttachMoney', color: '#10b981' },
  Bank: { icon: 'AccountBalance', color: '#3b82f6' },
  Wallet: { icon: 'PhoneAndroid', color: '#f59e0b' },
  Other: { icon: 'Wallet', color: '#94a3b8' },
};

function cashboxFields(data, current = null) {
  const kind = String(data.cashBoxKind ?? data.CashBoxKind ?? current?.CashBoxKind ?? 'Cash');
  const safeKind = CASHBOX_KINDS[kind] ? kind : 'Other';
  return {
    cashBoxName: String(data.cashBoxName ?? data.CashBoxName ?? current?.CashBoxName ?? '').trim(),
    description: data.description ?? data.Description ?? current?.Description ?? null,
    // ⚠️ انحراف موثّق (Item 15): BranchID يُحفظ ويُتحقق منه عند إرساله،
    // لكنه ليس إلزاميًا خادميًا هنا خلافًا لبلازور («الفرع مطلوب»).
    branchId: data.branchId ?? data.BranchID ?? data.BranchId ?? current?.BranchID ?? null,
    cashBoxKind: safeKind,
    icon: data.icon ?? data.Icon ?? current?.Icon ?? CASHBOX_KINDS[safeKind].icon,
    color: data.color ?? data.Color ?? current?.Color ?? CASHBOX_KINDS[safeKind].color,
    openingBalance: Number(data.openingBalance ?? data.OpeningBalance ?? current?.OpeningBalance ?? 0) || 0,
    openingDate: data.openingDate ?? data.OpeningDate ?? current?.OpeningDate ?? null,
    isActive: data.isActive ?? data.IsActive ?? current?.IsActive ?? true,
    isDefault: Boolean(data.isDefault ?? data.IsDefault ?? current?.IsDefault ?? false),
  };
}

async function assertBranchActive(transaction, branchId) {
  if (branchId == null || branchId === '') return null;
  const parsed = Number(branchId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error('الفرع المحدد غير موجود أو غير نشط'), { statusCode: 400 });
  }
  const result = await transaction.request()
    .input('branchId', sql.Int, parsed)
    .query(`SELECT BranchID FROM Branches WHERE BranchID = @branchId AND ISNULL(IsActive, 0) = 1`);
  if (!result.recordset[0]) {
    throw Object.assign(new Error('الفرع المحدد غير موجود أو غير نشط'), { statusCode: 400 });
  }
  return parsed;
}

// إنشاء خزينة جديدة — الرصيد الافتتاحي يُخزّن على الخزينة فقط، بلا حركة
// (SaveCashBoxAsync:112 — مصدر حقيقة واحد حتى لا يُحتسب مرتين)
async function createCashbox(data) {
  const fields = cashboxFields(data);
  if (!fields.cashBoxName) {
    throw Object.assign(new Error('اسم الخزينة مطلوب'), { statusCode: 400 });
  }
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const branchId = await assertBranchActive(transaction, fields.branchId);
    if (fields.isDefault) {
      await transaction.request().query(`UPDATE CashBoxes SET IsDefault = 0 WHERE ISNULL(IsDefault, 0) = 1`);
    }
    const result = await transaction.request()
      .input('cashBoxName', sql.NVarChar(100), fields.cashBoxName)
      .input('description', sql.NVarChar(255), fields.description)
      .input('branchId', sql.Int, branchId)
      .input('cashBoxKind', sql.NVarChar(50), fields.cashBoxKind)
      .input('icon', sql.NVarChar(100), fields.icon)
      .input('color', sql.NVarChar(50), fields.color)
      .input('openingBalance', sql.Decimal(18, 2), fields.openingBalance)
      .input('openingDate', sql.DateTime, fields.openingDate ? new Date(fields.openingDate) : new Date())
      .input('isActive', sql.Bit, fields.isActive ? 1 : 0)
      .input('isDefault', sql.Bit, fields.isDefault ? 1 : 0)
      .input('createdBy', sql.NVarChar(50), data.createdBy || data.username || null)
      .query(`
        INSERT INTO CashBoxes (
          CashBoxName, Description, BranchID, CashBoxKind, Icon, Color,
          OpeningBalance, OpeningDate, IsActive, IsDefault, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.CashBoxID
        VALUES (
          @cashBoxName, @description, @branchId, @cashBoxKind, @icon, @color,
          @openingBalance, @openingDate, @isActive, @isDefault, @createdBy, GETDATE()
        )
      `);
    await transaction.commit();
    return result.recordset[0].CashBoxID;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// تعديل خزينة — تغيير الفرع ممنوع عند وجود حركات (CashBoxService.cs:145-154)
async function updateCashbox(id, data) {
  const parsedId = Number(id);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    throw Object.assign(new Error('معرّف الخزينة غير صالح'), { statusCode: 400 });
  }
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, parsedId)
      .query(`SELECT * FROM CashBoxes WITH (UPDLOCK, HOLDLOCK) WHERE CashBoxID = @id`);
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error('الخزينة غير موجودة'), { statusCode: 404 });
    const fields = cashboxFields(data, current);
    if (!fields.cashBoxName) {
      throw Object.assign(new Error('اسم الخزينة مطلوب'), { statusCode: 400 });
    }
    const branchId = await assertBranchActive(transaction, fields.branchId);
    if (branchId != null && current.BranchID != null && Number(current.BranchID) !== branchId) {
      const movements = await transaction.request()
        .input('id', sql.Int, parsedId)
        .query(`SELECT TOP 1 1 AS Has FROM CashboxTransactions WHERE CashBoxID = @id`);
      if (movements.recordset.length) {
        throw Object.assign(new Error('لا يمكن تغيير فرع خزينة عليها حركات سابقة. أنشئ خزينة جديدة للفرع الصحيح.'), { statusCode: 409 });
      }
    }
    if (fields.isDefault) {
      await transaction.request()
        .input('id', sql.Int, parsedId)
        .query(`UPDATE CashBoxes SET IsDefault = 0 WHERE ISNULL(IsDefault, 0) = 1 AND CashBoxID <> @id`);
    }
    await transaction.request()
      .input('id', sql.Int, parsedId)
      .input('cashBoxName', sql.NVarChar(100), fields.cashBoxName)
      .input('description', sql.NVarChar(255), fields.description)
      .input('branchId', sql.Int, branchId)
      .input('cashBoxKind', sql.NVarChar(50), fields.cashBoxKind)
      .input('icon', sql.NVarChar(100), fields.icon)
      .input('color', sql.NVarChar(50), fields.color)
      .input('openingBalance', sql.Decimal(18, 2), fields.openingBalance)
      .input('openingDate', sql.DateTime, fields.openingDate ? new Date(fields.openingDate) : null)
      .input('isActive', sql.Bit, fields.isActive ? 1 : 0)
      .input('isDefault', sql.Bit, fields.isDefault ? 1 : 0)
      .input('lastUpdatedBy', sql.NVarChar(50), data.lastUpdatedBy || data.createdBy || data.username || null)
      .query(`
        UPDATE CashBoxes SET
          CashBoxName = @cashBoxName, Description = @description,
          BranchID = @branchId, CashBoxKind = @cashBoxKind,
          Icon = @icon, Color = @color,
          OpeningBalance = @openingBalance, OpeningDate = @openingDate,
          IsActive = @isActive, IsDefault = @isDefault,
          LastUpdatedBy = @lastUpdatedBy, LastUpdatedAt = GETDATE()
        WHERE CashBoxID = @id
      `);
    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// الحركات اليدوية — مرآة CashBoxService.CreateManualOperationAsync:691
// والأنواع الستة من DTOS/CashBoxDto.cs:218 (ManualOperationTypes)
// ═══════════════════════════════════════════════════════════
const MANUAL_OPERATION_LABELS = {
  ManualReceipt: 'سند قبض يدوي',
  ManualPayment: 'سند صرف يدوي',
  LoanIn: 'قرض دخل من شخص',
  LoanRepayment: 'تسديد قرض لشخص',
  Transfer: 'تحويل بين خزن',
  OpeningBalance: 'رصيد افتتاحي',
};

function buildManualNote(title, recipient, notes) {
  const parts = [title];
  if (recipient && String(recipient).trim()) parts.push(`المستلم: ${String(recipient).trim()}`);
  if (notes && String(notes).trim()) parts.push(String(notes).trim());
  return parts.join(' - ');
}

async function insertManualTransaction(transaction, { cashBoxId, transactionType, referenceType, referenceId, amount, date, notes, createdBy }) {
  const result = await transaction.request()
    .input('cashBoxId', sql.Int, cashBoxId)
    .input('referenceId', sql.Int, referenceId ?? null)
    .input('referenceType', sql.NVarChar(50), referenceType)
    .input('transactionType', sql.NVarChar(20), transactionType)
    .input('amount', sql.Decimal(18, 2), amount)
    .input('transactionDate', sql.DateTime, date)
    .input('notes', sql.NVarChar(sql.MAX), notes || null)
    .input('createdBy', sql.NVarChar(50), createdBy || null)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, ReferenceID, ReferenceType, TransactionType,
        Amount, TransactionDate, Notes, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.CashboxTransactionID
      VALUES (
        @cashBoxId, @referenceId, @referenceType, @transactionType,
        @amount, @transactionDate, @notes, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].CashboxTransactionID;
}

// الرصيد بالتعريف الموحد داخل معاملة: OpeningBalance + قبض − صرف
async function cashboxBalanceInTx(transaction, cashBoxId) {
  const result = await transaction.request()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`
      SELECT ISNULL((SELECT ISNULL(OpeningBalance, 0) FROM CashBoxes WHERE CashBoxID = @cashBoxId), 0)
        + ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                          WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0) AS Balance
      FROM CashboxTransactions WHERE CashBoxID = @cashBoxId
    `);
  return Number(result.recordset[0]?.Balance || 0);
}

async function assertSufficientBalance(transaction, cashBoxId, amount) {
  const balance = await cashboxBalanceInTx(transaction, cashBoxId);
  if (balance < amount) {
    throw Object.assign(new Error(`الرصيد غير كافي. المتاح: ${balance.toFixed(2)}`), { statusCode: 400 });
  }
}

async function createManualOperation(data) {
  const operationType = String(data.operationType || '');
  if (!MANUAL_OPERATION_LABELS[operationType]) {
    throw Object.assign(new Error('نوع العملية غير صحيح'), { statusCode: 400 });
  }
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('المبلغ يجب أن يكون أكبر من صفر'), { statusCode: 400 });
  }
  const cashBoxId = Number(data.cashBoxId);
  if (!Number.isInteger(cashBoxId) || cashBoxId <= 0) {
    throw Object.assign(new Error('الخزينة مطلوبة'), { statusCode: 400 });
  }
  const date = data.transactionDate ? new Date(data.transactionDate) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error('تاريخ الحركة غير صحيح'), { statusCode: 400 });
  }
  const createdBy = data.createdBy || data.username || null;
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    let id = null;
    let transferOutId = null;
    let transferInId = null;
    const base = { cashBoxId, amount, date, createdBy };
    switch (operationType) {
      case 'ManualReceipt':
        id = await insertManualTransaction(transaction, {
          ...base, transactionType: 'قبض', referenceType: 'ManualReceipt', referenceId: null,
          notes: buildManualNote('سند قبض يدوي', data.recipient, data.notes),
        });
        break;
      case 'ManualPayment':
        await assertSufficientBalance(transaction, cashBoxId, amount);
        id = await insertManualTransaction(transaction, {
          ...base, transactionType: 'صرف', referenceType: 'ManualPayment', referenceId: null,
          notes: buildManualNote('سند صرف يدوي', data.recipient, data.notes),
        });
        break;
      case 'LoanIn': {
        const personalAccountId = Number(data.personalAccountId);
        if (!Number.isInteger(personalAccountId) || personalAccountId <= 0) {
          throw Object.assign(new Error('يرجى اختيار الحساب الشخصي'), { statusCode: 400 });
        }
        id = await insertManualTransaction(transaction, {
          ...base, transactionType: 'قبض', referenceType: 'Loan', referenceId: personalAccountId,
          notes: buildManualNote('قرض دخل', null, data.notes),
        });
        break;
      }
      case 'LoanRepayment': {
        const personalAccountId = Number(data.personalAccountId);
        if (!Number.isInteger(personalAccountId) || personalAccountId <= 0) {
          throw Object.assign(new Error('يرجى اختيار الحساب الشخصي'), { statusCode: 400 });
        }
        await assertSufficientBalance(transaction, cashBoxId, amount);
        id = await insertManualTransaction(transaction, {
          ...base, transactionType: 'صرف', referenceType: 'Loan', referenceId: personalAccountId,
          notes: buildManualNote('تسديد قرض', null, data.notes),
        });
        break;
      }
      case 'Transfer': {
        const toCashBoxId = Number(data.toCashBoxId);
        if (!Number.isInteger(toCashBoxId) || toCashBoxId <= 0) {
          throw Object.assign(new Error('يرجى اختيار الخزينة المستقبلة'), { statusCode: 400 });
        }
        if (toCashBoxId === cashBoxId) {
          throw Object.assign(new Error('لا يمكن التحويل لنفس الخزينة'), { statusCode: 400 });
        }
        await assertSufficientBalance(transaction, cashBoxId, amount);
        // زوج مرتبط: الصادر مرجعه الخزينة المستقبلة والوارد مرجعه المصدر
        transferOutId = await insertManualTransaction(transaction, {
          ...base, transactionType: 'صرف', referenceType: 'TransferOut', referenceId: toCashBoxId,
          notes: buildManualNote('تحويل صادر', null, data.notes),
        });
        transferInId = await insertManualTransaction(transaction, {
          ...base, cashBoxId: toCashBoxId, transactionType: 'قبض', referenceType: 'TransferIn', referenceId: cashBoxId,
          notes: buildManualNote('تحويل وارد', null, data.notes),
        });
        id = transferInId;
        break;
      }
      case 'OpeningBalance': {
        // يُضاف لحقل الرصيد الافتتاحي نفسه (بأدنى تاريخ) — بلا أي حركة
        const boxResult = await transaction.request()
          .input('cashBoxId', sql.Int, cashBoxId)
          .query(`SELECT OpeningBalance, OpeningDate FROM CashBoxes WITH (UPDLOCK, HOLDLOCK) WHERE CashBoxID = @cashBoxId`);
        const box = boxResult.recordset[0];
        if (!box) throw Object.assign(new Error('الخزينة غير موجودة'), { statusCode: 404 });
        const newOpeningDate = !box.OpeningDate || date < new Date(box.OpeningDate) ? date : box.OpeningDate;
        await transaction.request()
          .input('cashBoxId', sql.Int, cashBoxId)
          .input('amount', sql.Decimal(18, 2), amount)
          .input('openingDate', sql.DateTime, newOpeningDate)
          .query(`
            UPDATE CashBoxes
            SET OpeningBalance = ISNULL(OpeningBalance, 0) + @amount, OpeningDate = @openingDate
            WHERE CashBoxID = @cashBoxId
          `);
        id = cashBoxId;
        break;
      }
      default:
        throw Object.assign(new Error('نوع العملية غير صحيح'), { statusCode: 400 });
    }
    await transaction.commit();
    return {
      id,
      transactionId: id,
      transferOutId,
      transferInId,
      operationType,
      message: `تم تسجيل ${MANUAL_OPERATION_LABELS[operationType]} بنجاح`,
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// إضافة حركة خزينة — مسار الإرث: بلا operationType تُشتق العملية اليدوية
// القياسية من اتجاه الحركة، وتُطبَّع أنواع المرجع 'Manual'/الغائبة إلى
// ManualReceipt/ManualPayment، ويُحترم التاريخ المختار.
async function createTransaction(data) {
  if (data.operationType) {
    return createManualOperation(data);
  }
  const derivedType = data.transactionType === 'صرف' ? 'ManualPayment' : 'ManualReceipt';
  const referenceType = !data.referenceType || data.referenceType === 'Manual'
    ? derivedType
    : data.referenceType;
  const pool = await connectDB();
  const result = await pool.request()
    .input('cashBoxId', sql.Int, data.cashBoxId)
    .input('paymentId', sql.Int, data.paymentId || null)
    .input('referenceId', sql.Int, data.referenceId || null)
    .input('referenceType', sql.NVarChar(50), referenceType)
    .input('transactionType', sql.NVarChar(20), data.transactionType)
    .input('amount', sql.Decimal(18, 2), data.amount)
    .input('transactionDate', sql.DateTime, data.transactionDate ? new Date(data.transactionDate) : new Date())
    .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy || data.username || null)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, PaymentID, ReferenceID, ReferenceType,
        TransactionType, Amount, TransactionDate, Notes,
        CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.CashboxTransactionID
      VALUES (
        @cashBoxId, @paymentId, @referenceId, @referenceType,
        @transactionType, @amount, @transactionDate, @notes,
        @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].CashboxTransactionID;
}

// تحويل بين خزينتين — يفوّض لعملية Transfer اليدوية (زوج TransferOut/TransferIn)
async function createTransfer(data) {
  const result = await createManualOperation({
    operationType: 'Transfer',
    cashBoxId: data.cashBoxIdFrom,
    toCashBoxId: data.cashBoxIdTo,
    amount: data.amount,
    notes: data.notes,
    transactionDate: data.transactionDate || data.date,
    createdBy: data.createdBy || data.username,
  });
  return {
    transactionIdFrom: result.transferOutId,
    transactionIdTo: result.transferInId,
  };
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
      (SELECT ISNULL(SUM(ISNULL(OpeningBalance, 0)), 0) FROM CashBoxes)
        + (SELECT ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                                   WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0)
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
      ISNULL(c.OpeningBalance, 0) + ISNULL((SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
              WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END)
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
      ISNULL((SELECT SUM(ISNULL(OpeningBalance, 0)) FROM CashBoxes), 0)
        + ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0) AS TotalBalance,
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
      ISNULL(c.OpeningBalance, 0) + ISNULL((SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
              WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END)
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
  getAllCashboxes,
  getActiveCashboxes,
  getCashboxById,
  getCashboxTransactions,
  getCashboxSummary,
  createCashbox,
  updateCashbox,
  createTransaction,
  createManualOperation,
  createTransfer,
   getDashboardStats,
  getChartData,
  getDistribution,
  getCashboxBalances,
  getRecentTransactions,
  getMonthlyComparison
};