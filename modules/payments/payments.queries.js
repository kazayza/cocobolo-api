const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════════════
// وحدة المدفوعات — مرآة Services/PaymentService.cs في بلازور:
// القائمة (GetPaymentsAsync:60)، الإحصائيات (GetStatsAsync:355)،
// التحليل (GetPaymentAnalysisAsync:419)، الإنشاء (CreatePaymentAsync:663
// عبر نواة transactions.addPayment نفسها)، الإلغاء (CancelPaymentAsync:
// 796)، التعديل (UpdatePaymentAsync:906)، السند (GetPaymentForReceipt-
// Async:310 + GenerateReceiptNumber)، والتفقيط (ConvertNumberToArabic-
// Words:1042). البوابات في shared/authorization.policy.js (payments).
// ═══════════════════════════════════════════════════════════════════

// طرق الدفع القابلة للاختيار يدويًا — PaymentMethods.Selectable
// (DTOS/InvoiceDto.cs:440): Advance نظامية فقط ولا تُختار أبدًا.
const SELECTABLE_METHODS = ['Cash', 'Bank', 'Visa', 'InstaPay', 'Credit', 'Other'];
const METHOD_AR = {
  Cash: 'نقدى', Bank: 'تحويل بنكى', Visa: 'فيزا',
  InstaPay: 'InstaPay', Credit: 'آجل', Advance: 'دفعة مقدمة', Other: 'أخرى',
};

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const money = (value) => Math.round((num(value) + Number.EPSILON) * 100) / 100;
const round1 = (value) => Math.round((num(value) + Number.EPSILON) * 10) / 10;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFoundError(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}
function formatN2(value) {
  return num(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeInvoiceStatus(grandTotal, paidAmount) {
  if (grandTotal > 0 && paidAmount >= grandTotal) return 'Paid';
  if (paidAmount > 0) return 'PartiallyPaid';
  return 'Open';
}

// GenerateReceiptNumber (PaymentService.cs:1035): RCV للبيع وPMT لغيره،
// السنة من تاريخ الدفعة، والمعرّف بخمس خانات.
function generateReceiptNumber(paymentId, transactionType, date) {
  const prefix = transactionType === 'Sale' ? 'RCV' : 'PMT';
  const year = (date ? new Date(date) : new Date()).getFullYear();
  return `${prefix}-${year}-${String(paymentId).padStart(5, '0')}`;
}

// ── التفقيط — نقل حرفي لخوارزمية PaymentService.cs:1042-1153 ──────
function convertIntegerToWords(n) {
  let number = Math.trunc(num(n));
  if (number === 0) return 'صفر';
  if (number < 0) return `ناقص ${convertIntegerToWords(-number)}`;
  if (number >= 1000000000) {
    const billions = Math.floor(number / 1000000000);
    const rem = number % 1000000000;
    const word = billions === 1 ? 'مليار'
      : billions === 2 ? 'ملياران' : `${convertIntegerToWords(billions)} مليار`;
    return rem === 0 ? word : `${word} و ${convertIntegerToWords(rem)}`;
  }
  if (number >= 1000000) {
    const millions = Math.floor(number / 1000000);
    const rem = number % 1000000;
    const word = millions === 1 ? 'مليون'
      : millions === 2 ? 'مليونان' : `${convertIntegerToWords(millions)} مليون`;
    return rem === 0 ? word : `${word} و ${convertIntegerToWords(rem)}`;
  }
  if (number >= 1000) {
    const thousands = Math.floor(number / 1000);
    const rem = number % 1000;
    let word;
    if (thousands === 1) word = 'ألف';
    else if (thousands === 2) word = 'ألفان';
    else if (thousands >= 3 && thousands <= 10) word = `${convertIntegerToWords(thousands)} آلاف`;
    else word = `${convertIntegerToWords(thousands)} ألف`;
    return rem === 0 ? word : `${word} و ${convertIntegerToWords(rem)}`;
  }
  if (number >= 100) {
    const hundreds = Math.floor(number / 100);
    const rem = number % 100;
    const hundredsWord = {
      1: 'مائة', 2: 'مائتان', 3: 'ثلاثمائة', 4: 'أربعمائة', 5: 'خمسمائة',
      6: 'ستمائة', 7: 'سبعمائة', 8: 'ثمانمائة', 9: 'تسعمائة',
    }[hundreds] || '';
    return rem === 0 ? hundredsWord : `${hundredsWord} و ${convertIntegerToWords(rem)}`;
  }
  if (number >= 20) {
    const tens = Math.floor(number / 10);
    const ones = number % 10;
    const tensWord = {
      2: 'عشرون', 3: 'ثلاثون', 4: 'أربعون', 5: 'خمسون',
      6: 'ستون', 7: 'سبعون', 8: 'ثمانون', 9: 'تسعون',
    }[tens] || '';
    return ones === 0 ? tensWord : `${convertIntegerToWords(ones)} و ${tensWord}`;
  }
  return {
    1: 'واحد', 2: 'اثنان', 3: 'ثلاثة', 4: 'أربعة', 5: 'خمسة',
    6: 'ستة', 7: 'سبعة', 8: 'ثمانية', 9: 'تسعة', 10: 'عشرة',
    11: 'أحد عشر', 12: 'اثنا عشر', 13: 'ثلاثة عشر', 14: 'أربعة عشر',
    15: 'خمسة عشر', 16: 'ستة عشر', 17: 'سبعة عشر', 18: 'ثمانية عشر',
    19: 'تسعة عشر',
  }[number] || String(number);
}

function convertNumberToArabicWords(value) {
  const number = num(value);
  if (number === 0) return 'صفر جنيه فقط لا غير';
  const integerPart = Math.floor(number);
  const decimalPart = Math.round((number - integerPart) * 100);
  let result = `${convertIntegerToWords(integerPart)} جنيه`;
  if (decimalPart > 0) result += ` و ${convertIntegerToWords(decimalPart)} قرشاً`;
  result += ' فقط لا غير';
  return result;
}

// سجل تدقيق داخل معاملة — نمط Audit_Log نفسه في transactions.queries.
async function auditTx(transaction, { tableName, actionType, primaryKey, oldData, newData, username }) {
  await transaction.request()
    .input('tableName', sql.NVarChar(100), tableName)
    .input('actionType', sql.NVarChar(50), actionType)
    .input('primaryKey', sql.NVarChar(100), String(primaryKey))
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES (@tableName, @actionType, @primaryKey, @oldData, @newData,
              GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

// نوع فاتورة واحدة — لبوابات الإنشاء/التعديل المعتمدة على بيع/شراء.
async function getTransactionType(transactionId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT TransactionID, TransactionType, InvoiceStatus FROM Transactions WHERE TransactionID = @id`);
  return result.recordset[0] || null;
}

// نوع الفاتورة المرتبطة بدفعة — لبوابة التعديل.
async function getPaymentInvoiceType(paymentId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, paymentId)
    .query(`
      SELECT t.TransactionType, t.InvoiceStatus
      FROM Payments p
      INNER JOIN Transactions t ON p.TransactionID = t.TransactionID
      WHERE p.PaymentID = @id
    `);
  return result.recordset[0] || null;
}

function isPurchaseType(type) {
  return type === 'Purchase' || type === 'PurchaseReturn';
}

// ── قائمة المدفوعات — GetPaymentsAsync:60 ──────────────────────────
// تبويب بيع/شراء بنوع المعاملة، بحث (اسم الطرف/هاتفه/المرجع، وللشراء
// اسم الطرف المرتبط بالموظف)، فلاتر التاريخ والطريقة والخزينة والطرف،
// استبعاد Advance، وترقيم صفحات. النسبة تراكمية داخل فاتورة الدفعة:
// بلازور يجمعها على شريحة الصفحة؛ هنا تُحسب على كامل دفعات الفاتورة
// (نفس النتيجة متى وقعت دفعات الفاتورة في صفحة واحدة).
async function getPayments(filter = {}) {
  const transactionType = filter.type === 'Purchase' ? 'Purchase' : 'Sale';
  const page = Math.max(parseInt(filter.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(filter.pageSize || filter.limit, 10) || 25, 1), 100);
  const offset = (page - 1) * pageSize;
  const sortByAmount = String(filter.sortBy || '') === 'Amount';
  const sortDesc = filter.sortDescending !== 'false' && filter.sortDescending !== false;

  const pool = await connectDB();
  const request = pool.request();
  request.input('type', sql.VarChar(20), transactionType);

  const clauses = [`t.TransactionType = @type`, `p.PaymentMethod <> 'Advance'`];
  if (filter.search && String(filter.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filter.search).trim()}%`);
    clauses.push(`(
      t.ReferenceNumber LIKE @search
      OR party.PartyName LIKE @search OR party.Phone LIKE @search OR party.Phone2 LIKE @search
      OR (t.TransactionType = 'Purchase' AND empParty.PartyName LIKE @search)
    )`);
  }
  if (filter.from) {
    request.input('from', sql.DateTime, new Date(filter.from));
    clauses.push('p.PaymentDate >= @from');
  }
  if (filter.to) {
    const to = new Date(filter.to);
    to.setDate(to.getDate() + 1);
    request.input('to', sql.DateTime, to);
    clauses.push('p.PaymentDate < @to');
  }
  if (filter.method) {
    request.input('method', sql.NVarChar(50), String(filter.method));
    clauses.push('p.PaymentMethod = @method');
  }
  if (filter.cashBoxId) {
    request.input('cashBoxId', sql.Int, parseInt(filter.cashBoxId, 10));
    clauses.push('EXISTS (SELECT 1 FROM CashboxTransactions ct WHERE ct.PaymentID = p.PaymentID AND ct.CashBoxID = @cashBoxId)');
  }
  if (filter.partyId) {
    request.input('partyId', sql.Int, parseInt(filter.partyId, 10));
    clauses.push('t.PartyID = @partyId');
  }
  if (filter.empId && transactionType === 'Purchase') {
    request.input('empId', sql.Int, parseInt(filter.empId, 10));
    clauses.push('t.EmpId = @empId');
  }
  const where = clauses.join(' AND ');
  const order = sortByAmount
    ? `p.Amount ${sortDesc ? 'DESC' : 'ASC'}`
    : `p.PaymentDate ${sortDesc ? 'DESC' : 'ASC'}, p.PaymentID ${sortDesc ? 'DESC' : 'ASC'}`;

  const result = await request.query(`
    SELECT
      p.PaymentID, p.PaymentDate, p.Amount, p.PaymentMethod, p.Notes,
      p.CreatedBy, p.CreatedAt,
      t.TransactionID, t.ReferenceNumber AS InvoiceReferenceNumber,
      t.TransactionType, t.GrandTotal AS InvoiceGrandTotal,
      t.PaidAmount AS InvoicePaidAmount, t.PartyID, t.EmpId,
      party.PartyName, party.Phone AS PartyPhone,
      CASE WHEN t.TransactionType = 'Purchase' THEN empParty.PartyName ELSE emp.FullName END AS EmpName,
      cash.CashBoxID, cash.CashBoxName,
      COUNT(*) OVER() AS TotalRows
    FROM Payments p
    INNER JOIN Transactions t ON p.TransactionID = t.TransactionID
    LEFT JOIN Parties party ON t.PartyID = party.PartyID
    LEFT JOIN Parties empParty ON t.EmpId = empParty.PartyID
    LEFT JOIN Employees emp ON t.EmpId = emp.EmployeeID
    OUTER APPLY (
      SELECT TOP 1 ct.CashBoxID, cb.CashBoxName
      FROM CashboxTransactions ct
      LEFT JOIN CashBoxes cb ON ct.CashBoxID = cb.CashBoxID
      WHERE ct.PaymentID = p.PaymentID
      ORDER BY ct.CashboxTransactionID
    ) cash
    WHERE ${where}
    ORDER BY ${order}
    OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `);
  const rows = result.recordset;
  const totalCount = rows.length ? Number(rows[0].TotalRows || 0) : 0;

  // النسبة التراكمية: مجموع كل دفعات الفاتورة (غير Advance) حتى هذه
  // الدفعة بترتيب التاريخ/المعرّف، مقسومًا على إجمالي الفاتورة.
  const txIds = [...new Set(rows.map((r) => Number(r.TransactionID)).filter((x) => x > 0))];
  const cumulative = new Map();
  if (txIds.length) {
    const hist = await pool.request().query(`
      SELECT PaymentID, TransactionID, Amount FROM Payments
      WHERE TransactionID IN (${txIds.join(',')}) AND PaymentMethod <> 'Advance'
      ORDER BY PaymentDate ASC, PaymentID ASC
    `);
    const running = new Map();
    for (const h of hist.recordset) {
      const key = Number(h.TransactionID);
      const next = money(num(running.get(key)) + num(h.Amount));
      running.set(key, next);
      cumulative.set(Number(h.PaymentID), next);
    }
  }

  const items = rows.map((r) => {
    const { TotalRows, ...row } = r;
    const cumPaid = cumulative.get(Number(r.PaymentID)) ?? num(r.Amount);
    return {
      ...row,
      ReceiptNumber: generateReceiptNumber(r.PaymentID, r.TransactionType, r.PaymentDate),
      Percentage: num(r.InvoiceGrandTotal) === 0 ? 0 : round1(cumPaid / num(r.InvoiceGrandTotal) * 100),
      InvoiceRemaining: money(num(r.InvoiceGrandTotal) - num(r.InvoicePaidAmount)),
      PaymentMethodAr: METHOD_AR[r.PaymentMethod] || r.PaymentMethod || '',
      IsCancelled: false,
    };
  });
  return { items, totalCount, page, pageSize };
}

// ── الإحصائيات — GetStatsAsync:355 ─────────────────────────────────
async function getStats(filter = {}) {
  const transactionType = filter.type === 'Purchase' ? 'Purchase' : 'Sale';
  const pool = await connectDB();
  const request = pool.request();
  request.input('type', sql.VarChar(20), transactionType);
  const clauses = [`t.TransactionType = @type`, `p.PaymentMethod <> 'Advance'`];
  if (filter.from) {
    request.input('from', sql.DateTime, new Date(filter.from));
    clauses.push('p.PaymentDate >= @from');
  }
  if (filter.to) {
    const to = new Date(filter.to);
    to.setDate(to.getDate() + 1);
    request.input('to', sql.DateTime, to);
    clauses.push('p.PaymentDate < @to');
  }
  const result = await request.query(`
    SELECT p.PaymentID, p.Amount, p.PaymentDate, p.PaymentMethod
    FROM Payments p
    INNER JOIN Transactions t ON p.TransactionID = t.TransactionID
    WHERE ${clauses.join(' AND ')}
  `);
  const rows = result.recordset;
  const today = new Date();
  const isToday = (d) => {
    const dt = new Date(d);
    return dt.getFullYear() === today.getFullYear()
      && dt.getMonth() === today.getMonth() && dt.getDate() === today.getDate();
  };
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const sum = (list) => money(list.reduce((s, r) => s + num(r.Amount), 0));

  const methodMap = new Map();
  for (const r of rows) {
    const key = r.PaymentMethod || 'Other';
    const entry = methodMap.get(key) || { PaymentMethod: key, PaymentMethodAr: METHOD_AR[key] || key, Count: 0, Total: 0 };
    entry.Count += 1;
    entry.Total = money(entry.Total + num(r.Amount));
    methodMap.set(key, entry);
  }

  const boxResult = await pool.request()
    .input('type', sql.VarChar(20), transactionType)
    .query(`
      SELECT ct.CashBoxID, cb.CashBoxName, COUNT(*) AS Count, SUM(ct.Amount) AS Total
      FROM CashboxTransactions ct
      INNER JOIN CashBoxes cb ON ct.CashBoxID = cb.CashBoxID
      INNER JOIN Payments p ON ct.PaymentID = p.PaymentID
      INNER JOIN Transactions t ON p.TransactionID = t.TransactionID
      WHERE t.TransactionType = @type AND p.PaymentMethod <> 'Advance'
      GROUP BY ct.CashBoxID, cb.CashBoxName
    `);
  const cashBoxBreakdown = boxResult.recordset.map((r) => ({
    CashBoxId: r.CashBoxID, CashBoxName: r.CashBoxName,
    Count: Number(r.Count || 0), Total: money(r.Total),
  }));

  const todayRows = rows.filter((r) => isToday(r.PaymentDate));
  const monthRows = rows.filter((r) => new Date(r.PaymentDate) >= monthStart);
  return {
    TotalCount: rows.length,
    TotalAmount: sum(rows),
    TodayCount: todayRows.length,
    TodayAmount: sum(todayRows),
    MonthCount: monthRows.length,
    MonthAmount: sum(monthRows),
    CashBoxesCount: cashBoxBreakdown.length,
    CashBoxBreakdown: cashBoxBreakdown,
    MethodBreakdown: [...methodMap.values()],
  };
}

// ── دفعة واحدة + بيانات السند — GetPaymentByIdAsync:253 ────────────
async function getPaymentById(paymentId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, paymentId)
    .query(`
      SELECT
        p.PaymentID, p.PaymentDate, p.Amount, p.PaymentMethod, p.Notes,
        p.CreatedBy, p.CreatedAt,
        t.TransactionID, t.ReferenceNumber AS InvoiceReferenceNumber,
        t.TransactionType, t.GrandTotal AS InvoiceGrandTotal,
        t.PaidAmount AS InvoicePaidAmount, t.PartyID, t.EmpId,
        party.PartyName, party.Phone AS PartyPhone,
        party.Address AS CustomerAddress, party.City AS CustomerCity,
        party.Email AS CustomerEmail, party.NationalID AS CustomerNationalId,
        CASE WHEN t.TransactionType = 'Purchase' THEN empParty.PartyName ELSE emp.FullName END AS EmpName,
        cash.CashBoxID, cash.CashBoxName
      FROM Payments p
      INNER JOIN Transactions t ON p.TransactionID = t.TransactionID
      LEFT JOIN Parties party ON t.PartyID = party.PartyID
      LEFT JOIN Parties empParty ON t.EmpId = empParty.PartyID
      LEFT JOIN Employees emp ON t.EmpId = emp.EmployeeID
      OUTER APPLY (
        SELECT TOP 1 ct.CashBoxID, cb.CashBoxName
        FROM CashboxTransactions ct
        LEFT JOIN CashBoxes cb ON ct.CashBoxID = cb.CashBoxID
        WHERE ct.PaymentID = p.PaymentID
        ORDER BY ct.CashboxTransactionID
      ) cash
      WHERE p.PaymentID = @id
    `);
  const row = result.recordset[0];
  if (!row) return null;
  return {
    ...row,
    ReceiptNumber: generateReceiptNumber(row.PaymentID, row.TransactionType, row.PaymentDate),
    Percentage: num(row.InvoiceGrandTotal) === 0 ? 0
      : round1(num(row.Amount) / num(row.InvoiceGrandTotal) * 100),
    InvoiceRemaining: money(num(row.InvoiceGrandTotal) - num(row.InvoicePaidAmount)),
    PaymentMethodAr: METHOD_AR[row.PaymentMethod] || row.PaymentMethod || '',
  };
}

// ── سند الدفعة — GetPaymentForReceiptAsync:310 ─────────────────────
async function getReceipt(paymentId) {
  const payment = await getPaymentById(paymentId);
  if (!payment) return null;
  const pool = await connectDB();
  let company = {};
  try {
    const companyResult = await pool.request().query(`
      SELECT TOP 1 CompanyName, Phone1, Phone2, Address, TaxNumber
      FROM CompanyInfo ORDER BY CompanyID
    `);
    company = companyResult.recordset[0] || {};
  } catch (_) { company = {}; }
  const isSale = payment.TransactionType === 'Sale';
  return {
    Payment: payment,
    ReceiptNumber: payment.ReceiptNumber,
    ReceiptType: isSale ? 'Receive' : 'Pay',
    ReceiptTypeAr: isSale ? 'سند قبض' : 'سند صرف',
    CompanyName: company.CompanyName || 'COCOBOLO',
    CompanyPhone: [company.Phone1, company.Phone2].filter(Boolean).join(' - ') || null,
    CompanyAddress: company.Address || null,
    CompanyTaxNumber: company.TaxNumber || null,
    CustomerAddress: payment.CustomerAddress || null,
    CustomerCity: payment.CustomerCity || null,
    CustomerEmail: payment.CustomerEmail || null,
    CustomerNationalId: payment.CustomerNationalId || null,
    AmountInWords: convertNumberToArabicWords(payment.Amount),
  };
}

// ── تحليل الشرائح — GetPaymentAnalysisAsync:419 + PaymentTiers ────
const TIER_PERCENTAGES = [70, 20, 10];
const TIER_NAMES = { 1: 'الدفعة الأولى (70%)', 2: 'الدفعة الثانية (20%)', 3: 'الدفعة الثالثة (10%)' };

async function getAnalysis(transactionId, proposedAmount) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT TransactionID, ReferenceNumber, GrandTotal, PaidAmount FROM Transactions WHERE TransactionID = @id`);
  const t = result.recordset[0];
  if (!t) return null;
  const grand = money(t.GrandTotal);
  const paidBefore = money(t.PaidAmount);
  const remaining = money(grand - paidBefore);

  const tiers = [];
  let cumulativePaid = 0;
  for (let i = 0; i < TIER_PERCENTAGES.length; i++) {
    const pct = TIER_PERCENTAGES[i];
    const tierAmount = money(grand * (pct / 100));
    const tierPaid = Math.max(0, Math.min(tierAmount, money(paidBefore - cumulativePaid)));
    cumulativePaid = money(cumulativePaid + tierPaid);
    tiers.push({
      TierNumber: i + 1,
      TierName: TIER_NAMES[i + 1],
      Percentage: pct,
      Amount: tierAmount,
      AmountPaid: money(tierPaid),
      AmountRemaining: Math.max(0, money(tierAmount - tierPaid)),
      CompletionPercentage: tierAmount === 0 ? 0 : round1(tierPaid / tierAmount * 100),
      Status: tierPaid >= tierAmount ? 'Paid' : tierPaid > 0 ? 'Partial' : 'Pending',
    });
  }

  const dto = {
    TransactionId: t.TransactionID,
    ReferenceNumber: t.ReferenceNumber,
    GrandTotal: grand,
    PaidBefore: paidBefore,
    Remaining: remaining,
    PaidPercentage: grand === 0 ? 0 : round1(paidBefore / grand * 100),
    Tiers: tiers,
    CurrentPaymentAnalysis: null,
  };

  const amount = proposedAmount == null || proposedAmount === '' ? null : money(proposedAmount);
  if (amount != null && amount > 0) {
    const analysis = {
      EnteredAmount: amount,
      PercentageOfInvoice: grand === 0 ? 0 : round1(amount / grand * 100),
      Description: '',
      Allocations: [],
    };
    let remainingToAllocate = amount;
    for (const tier of tiers) {
      if (remainingToAllocate <= 0) break;
      const tierRemaining = tier.AmountRemaining;
      if (tierRemaining <= 0) continue;
      const allocated = Math.min(tierRemaining, remainingToAllocate);
      const newRemaining = money(tierRemaining - allocated);
      analysis.Allocations.push({
        TierNumber: tier.TierNumber,
        TierName: tier.TierName,
        AmountAllocated: money(allocated),
        RemainingInTier: newRemaining,
        Note: newRemaining === 0
          ? '✅ ستكتمل هذه الدفعة'
          : `⏳ سيتبقى ${formatN2(newRemaining)} ج من هذه الدفعة`,
      });
      remainingToAllocate = money(remainingToAllocate - allocated);
    }
    if (amount > remaining) {
      analysis.Description = `⚠️ المبلغ (${formatN2(amount)}) أكبر من المتبقي (${formatN2(remaining)})`;
    } else if (amount === remaining) {
      analysis.Description = ' ستسدد الفاتورة بالكامل بهذه الدفعة';
    } else {
      const newPaid = money(paidBefore + amount);
      const newRemain = money(grand - newPaid);
      const newPct = grand === 0 ? 0 : round1(newPaid / grand * 100);
      analysis.Description = `بعد الدفعة: المسدد ${formatN2(newPaid)} ج (${newPct}%) | المتبقي ${formatN2(newRemain)} ج`;
    }
    dto.CurrentPaymentAnalysis = analysis;
  }
  return dto;
}

// ── إلغاء دفعة — CancelPaymentAsync:796 ────────────────────────────
// حذف فعلي للدفعة وحركات خزينتها + إعادة حساب PaidAmount/الحالة،
// في معاملة واحدة، مع سجل تدقيق يحمل السبب (Audit_Log).
async function cancelPayment(paymentId, reason, username) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const payRes = await transaction.request()
      .input('id', sql.Int, paymentId)
      .query(`SELECT PaymentID, TransactionID, Amount, PaymentMethod, PaymentDate, Notes, CreatedBy
              FROM Payments WITH (UPDLOCK, HOLDLOCK) WHERE PaymentID = @id`);
    const payment = payRes.recordset[0];
    if (!payment) throw notFoundError('الدفعة غير موجودة.');

    const invRes = await transaction.request()
      .input('id', sql.Int, payment.TransactionID)
      .query(`SELECT TransactionID, ReferenceNumber, GrandTotal, PaidAmount, InvoiceStatus
              FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id`);
    const invoice = invRes.recordset[0];
    if (!invoice) throw notFoundError('الفاتورة المرتبطة غير موجودة.');

    const newPaid = Math.max(0, money(num(invoice.PaidAmount) - num(payment.Amount)));
    await transaction.request()
      .input('paymentId', sql.Int, paymentId)
      .query(`DELETE FROM CashboxTransactions WHERE PaymentID = @paymentId`);
    await transaction.request()
      .input('paymentId', sql.Int, paymentId)
      .query(`DELETE FROM Payments WHERE PaymentID = @paymentId`);
    await transaction.request()
      .input('id', sql.Int, invoice.TransactionID)
      .input('paidAmount', sql.Decimal(18, 2), newPaid)
      .input('status', sql.NVarChar(20), computeInvoiceStatus(num(invoice.GrandTotal), newPaid))
      .query(`UPDATE Transactions SET PaidAmount = @paidAmount, InvoiceStatus = @status WHERE TransactionID = @id`);

    await auditTx(transaction, {
      tableName: 'Payments',
      actionType: 'Cancel',
      primaryKey: paymentId,
      oldData: payment,
      newData: { Reason: reason },
      username,
    });
    await transaction.commit();
    return { paymentId, newPaidAmount: newPaid };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) { /* تجاهل */ }
    throw err;
  }
}

// ── تعديل دفعة — UpdatePaymentAsync:906 ────────────────────────────
// الحد = المتبقي الحالي + مبلغ الدفعة القديمة؛ حركة الخزينة القائمة
// تُحدَّث في مكانها (مبلغ/خزينة/ملاحظة) ولا تُستبدل؛ رفض على الملغاة.
async function updatePayment(paymentId, data, username) {
  const amount = money(data.amount);
  if (!(amount > 0)) throw badRequest('المبلغ يجب أن يكون أكبر من صفر.');
  if (!data.cashBoxId) throw badRequest('يرجى اختيار الخزينة.');
  const method = data.paymentMethod == null || data.paymentMethod === ''
    ? null : String(data.paymentMethod);
  if (method != null && !SELECTABLE_METHODS.includes(method)) {
    throw badRequest('طريقة الدفع غير صالحة.');
  }

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const payRes = await transaction.request()
      .input('id', sql.Int, paymentId)
      .query(`SELECT PaymentID, TransactionID, Amount, PaymentMethod, Notes
              FROM Payments WITH (UPDLOCK, HOLDLOCK) WHERE PaymentID = @id`);
    const payment = payRes.recordset[0];
    if (!payment) throw notFoundError('الدفعة غير موجودة.');

    const invRes = await transaction.request()
      .input('id', sql.Int, payment.TransactionID)
      .query(`SELECT TransactionID, ReferenceNumber, TransactionType, GrandTotal, PaidAmount, InvoiceStatus
              FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id`);
    const invoice = invRes.recordset[0];
    if (!invoice) throw notFoundError('الفاتورة المرتبطة غير موجودة.');
    if (invoice.InvoiceStatus === 'Cancelled') {
      throw badRequest('لا يمكن تعديل دفعة لفاتورة ملغية.');
    }

    const maxAmount = money(num(invoice.GrandTotal) - num(invoice.PaidAmount) + num(payment.Amount));
    if (amount > maxAmount) {
      throw badRequest(`المبلغ (${formatN2(amount)}) أكبر من المسموح (${formatN2(maxAmount)}).`);
    }

    const finalMethod = method != null ? method : (payment.PaymentMethod || 'Cash');
    const finalNotes = data.notes !== undefined ? (data.notes || null) : payment.Notes;

    await transaction.request()
      .input('paymentId', sql.Int, paymentId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('paymentMethod', sql.NVarChar(50), finalMethod)
      .input('notes', sql.NVarChar(sql.MAX), finalNotes)
      .input('username', sql.NVarChar(50), username)
      .query(`
        UPDATE Payments
        SET Amount = @amount, PaymentMethod = @paymentMethod, Notes = @notes,
            LastModifiedBy = @username, LastModifiedAt = GETDATE()
        WHERE PaymentID = @paymentId
      `);

    // حركة الخزينة القائمة في مكانها — بلا حذف ولا إنشاء (بلازور: انعدامها
    // لا يُنشئ بديلًا).
    await transaction.request()
      .input('paymentId', sql.Int, paymentId)
      .input('cashBoxId', sql.Int, data.cashBoxId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(500), finalNotes)
      .input('username', sql.NVarChar(50), username)
      .query(`
        UPDATE CashboxTransactions
        SET CashBoxID = @cashBoxId, Amount = @amount, Notes = @notes,
            CreatedBy = @username, CreatedAt = GETDATE()
        WHERE PaymentID = @paymentId
      `);

    const newPaid = money(num(invoice.PaidAmount) - num(payment.Amount) + amount);
    await transaction.request()
      .input('id', sql.Int, invoice.TransactionID)
      .input('paidAmount', sql.Decimal(18, 2), newPaid)
      .input('status', sql.NVarChar(20), computeInvoiceStatus(num(invoice.GrandTotal), newPaid))
      .query(`UPDATE Transactions SET PaidAmount = @paidAmount, InvoiceStatus = @status WHERE TransactionID = @id`);

    await auditTx(transaction, {
      tableName: 'Payments',
      actionType: 'Update',
      primaryKey: paymentId,
      oldData: { Amount: payment.Amount, PaymentMethod: payment.PaymentMethod, Notes: payment.Notes },
      newData: { Amount: amount, PaymentMethod: finalMethod, Notes: finalNotes },
      username,
    });
    await transaction.commit();
    return { paymentId, newPaidAmount: newPaid };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) { /* تجاهل */ }
    throw err;
  }
}

module.exports = {
  SELECTABLE_METHODS,
  METHOD_AR,
  generateReceiptNumber,
  convertNumberToArabicWords,
  convertIntegerToWords,
  getTransactionType,
  getPaymentInvoiceType,
  isPurchaseType,
  getPayments,
  getStats,
  getPaymentById,
  getReceipt,
  getAnalysis,
  cancelPayment,
  updatePayment,
};
