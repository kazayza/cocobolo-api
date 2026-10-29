const { sql, connectDB } = require('../../core/database');
const notificationsQueries = require('../notifications/notifications.queries');


async function getInvoiceCostMap(pool, transactionIds) {
  const ids = [...new Set(transactionIds.map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();
  const request = pool.request();
  const params = ids.map((id, index) => {
    request.input(`costId${index}`, sql.Int, id);
    return `@costId${index}`;
  });
  const result = await request.query(`
    SELECT td.TransactionID,
      SUM(td.Quantity * CASE
        WHEN td.SelectedAlternativeID IS NOT NULL AND ISNULL(td.PricingTier, 'Premium') = 'CClass'
          THEN ISNULL(a.PurchasePriceCClass, 0)
        WHEN td.SelectedAlternativeID IS NOT NULL AND ISNULL(td.PricingTier, 'Premium') = 'Elite'
          THEN COALESCE(a.PurchasePriceElite, a.PurchasePricePremium, 0)
        WHEN td.SelectedAlternativeID IS NOT NULL
          THEN ISNULL(a.PurchasePricePremium, 0)
        WHEN ISNULL(td.PricingTier, 'Premium') = 'CClass'
          THEN ISNULL(p.PurchasePriceCClass, 0)
        WHEN ISNULL(td.PricingTier, 'Premium') = 'Elite'
          THEN COALESCE(p.PurchasePriceElite, p.PurchasePrice, 0)
        ELSE ISNULL(p.PurchasePrice, 0)
      END) AS TotalCost
    FROM TransactionDetails td
    INNER JOIN Products p ON td.ProductID = p.ProductID
    LEFT JOIN ProductFactoryAlternatives a ON td.SelectedAlternativeID = a.AlternativeID
    WHERE td.TransactionID IN (${params.join(',')})
    GROUP BY td.TransactionID
  `);
  return new Map(result.recordset.map((row) => [Number(row.TransactionID), Number(row.TotalCost || 0)]));
}

// جلب كل الفواتير
async function getAllTransactions({
  type = null,
  startDate = null,
  endDate = null,
  partyId = null,
  search = null,
  status = null,
  hasRemaining = null,
  overdue = false,
  page = 1,
  limit = 20,
  excludeProtectedAccountManagerSales = false,
  includeProfit = false,
}) {
  const pool = await connectDB();
  const request = pool.request();

  // ── بناء الفلاتر ─────────────────────────────────────
  let where = ' WHERE 1=1';

  if (type) {
    where += ` AND t.TransactionType = @type`;
    request.input('type', sql.VarChar(20), type);
  }
  if (excludeProtectedAccountManagerSales) {
    where += ` AND NOT (
      t.TransactionType = 'Sale' AND EXISTS (
        SELECT 1 FROM Users protectedCreator
        WHERE protectedCreator.Username = t.CreatedBy
          AND protectedCreator.Role = N'AccountManager'
      )
    )`;
  }
  if (startDate) {
    where += ` AND CAST(t.TransactionDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }
  if (endDate) {
    where += ` AND CAST(t.TransactionDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }
  if (partyId) {
    where += ` AND t.PartyID = @partyId`;
    request.input('partyId', sql.Int, partyId);
  }
  if (search && search.trim()) {
    where += ` AND (p.PartyName LIKE @search OR CAST(t.TransactionID AS VARCHAR) LIKE @search OR t.ReferenceNumber LIKE @search)`;
    request.input('search', sql.NVarChar(200), `%${search.trim()}%`);
  }
  if (status) {
    where += ` AND t.InvoiceStatus = @status`;
    request.input('status', sql.NVarChar(30), status);
  }
  if (hasRemaining === true) {
    where += ` AND t.GrandTotal > t.PaidAmount`;
  } else if (hasRemaining === false) {
    where += ` AND t.GrandTotal <= t.PaidAmount`;
  }
  if (overdue === true || overdue === 'true') {
    where += ` AND t.DueDate IS NOT NULL AND t.DueDate < GETDATE() AND (t.InvoiceStatus != 'Paid' OR t.InvoiceStatus IS NULL) AND (t.InvoiceStatus != 'Cancelled' OR t.InvoiceStatus IS NULL)`;
  }

  // ── القائمة مع Pagination ────────────────────────────
  const offset = ((page || 1) - 1) * (limit || 20);

  const query = `
    SELECT
      t.TransactionID, t.TransactionDate, t.TransactionType,
      t.TotalAmount, t.DiscountPercentage, t.DiscountAmount,
      t.NetTotalAmount, t.PaidAmount, t.TotalChargesAmount,
      t.GrandTotal, t.PaymentMethod, t.Notes,
      t.CreatedBy, t.CreatedAt,
      t.InvoiceStatus, t.EditStatus, t.EditBy, t.EditRequestDate, t.EditReason, t.EditDone,
      t.DueDate, t.IsDelivered, t.ReferenceNumber,
      p.PartyID, p.PartyName, p.Phone,
      w.WarehouseID, w.WarehouseName,
      e.FullName AS EmployeeName,
      supplier.PartyName AS SupplierName,
      (t.GrandTotal - t.PaidAmount) AS RemainingAmount
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
    LEFT JOIN Employees e ON t.EmpId = e.EmployeeID
    LEFT JOIN Parties supplier ON t.EmpId = supplier.PartyID
    ${where}
    ORDER BY t.TransactionDate DESC, t.TransactionID DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `;

  const result = await request.query(query);
  if (includeProfit && result.recordset.length) {
    const costMap = await getInvoiceCostMap(pool, result.recordset.map((row) => row.TransactionID));
    for (const row of result.recordset) {
      const totalCost = Number(costMap.get(Number(row.TransactionID)) || 0);
      const net = Number(row.NetTotalAmount ?? row.TotalAmount ?? 0);
      const grossProfit = Math.round((net - totalCost) * 100) / 100;
      row.TotalCost = totalCost;
      row.GrossProfit = grossProfit;
      row.ProfitMarginPercentage = totalCost > 0
        ? Math.round((grossProfit / totalCost * 100) * 100) / 100
        : null;
    }
  }
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// إحصائيات الفواتير (مطابقة لبلازور)
// ═══════════════════════════════════════════════════════════
async function getInvoicesStats({
  type = null,
  startDate = null,
  endDate = null,
  search = null,
  status = null,
  hasRemaining = null,
  overdue = false,
  excludeProtectedAccountManagerSales = false,
}) {
  const pool = await connectDB();
  const request = pool.request();

  let where = ' WHERE 1=1';
  if (type) {
    where += ` AND t.TransactionType = @type`;
    request.input('type', sql.VarChar(20), type);
  }
  if (excludeProtectedAccountManagerSales) {
    where += ` AND NOT (
      t.TransactionType = 'Sale' AND EXISTS (
        SELECT 1 FROM Users protectedCreator
        WHERE protectedCreator.Username = t.CreatedBy
          AND protectedCreator.Role = N'AccountManager'
      )
    )`;
  }
  if (startDate) {
    where += ` AND CAST(t.TransactionDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }
  if (endDate) {
    where += ` AND CAST(t.TransactionDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }
  if (search && search.trim()) {
    where += ` AND (p.PartyName LIKE @search OR CAST(t.TransactionID AS VARCHAR) LIKE @search)`;
    request.input('search', sql.NVarChar(200), `%${search.trim()}%`);
  }
  if (status) {
    where += ` AND t.InvoiceStatus = @status`;
    request.input('status', sql.NVarChar(30), status);
  }
  if (hasRemaining === true) {
    where += ` AND t.GrandTotal > t.PaidAmount`;
  } else if (hasRemaining === false) {
    where += ` AND t.GrandTotal <= t.PaidAmount`;
  }
  if (overdue === true || overdue === 'true') {
    where += ` AND t.DueDate IS NOT NULL AND t.DueDate < GETDATE() AND (t.InvoiceStatus != 'Paid' OR t.InvoiceStatus IS NULL) AND (t.InvoiceStatus != 'Cancelled' OR t.InvoiceStatus IS NULL)`;
  }

  const query = `
    SELECT
      COUNT(*) AS TotalCount,
      ISNULL(SUM(CASE WHEN CAST(t.TransactionDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS TodayCount,
      ISNULL(SUM(CASE WHEN t.InvoiceStatus = 'Open' OR t.InvoiceStatus IS NULL THEN 1 ELSE 0 END), 0) AS OpenCount,
      ISNULL(SUM(CASE WHEN t.InvoiceStatus = 'Paid' THEN 1 ELSE 0 END), 0) AS PaidCount,
      ISNULL(SUM(CASE WHEN t.DueDate IS NOT NULL AND t.DueDate < GETDATE() AND (t.InvoiceStatus != 'Paid' OR t.InvoiceStatus IS NULL) AND (t.InvoiceStatus != 'Cancelled' OR t.InvoiceStatus IS NULL) THEN 1 ELSE 0 END), 0) AS OverdueCount,
      ISNULL(SUM(t.GrandTotal), 0) AS TotalSales,
      ISNULL(SUM(t.PaidAmount), 0) AS TotalPaid,
      ISNULL(SUM(t.GrandTotal - t.PaidAmount), 0) AS TotalRemaining
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    ${where}
  `;

  const result = await request.query(query);
  return result.recordset[0];
}

// جلب فاتورة بالـ ID
async function getTransactionById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        t.*,
        p.PartyName, p.Phone, p.Address, p.TaxNumber,
        w.WarehouseName,
        e.FullName AS EmployeeName,
        supplier.PartyName AS SupplierName
      FROM Transactions t
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
      LEFT JOIN Employees e ON t.EmpId = e.EmployeeID
    LEFT JOIN Parties supplier ON t.EmpId = supplier.PartyID
      WHERE t.TransactionID = @id
    `);
  return result.recordset[0] || null;
}

// جلب تفاصيل الفاتورة
async function getTransactionDetails(transactionId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('transactionId', sql.Int, transactionId)
    .query(`
      SELECT
        td.DetailID, td.ProductID, td.Quantity,
        td.UnitPrice, td.TotalAmount, td.Notes,
        p.ProductName, p.ProductDescription
      FROM TransactionDetails td
      INNER JOIN Products p ON td.ProductID = p.ProductID
      WHERE td.TransactionID = @transactionId
    `);
  return result.recordset;
}

// جلب الرسوم الإضافية
async function getAdditionalCharges(transactionId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('transactionId', sql.Int, transactionId)
    .query(`
      SELECT ChargeID, ChargeDescription, ChargeAmount
      FROM AdditionalCharges
      WHERE TransactionID = @transactionId
    `);
  return result.recordset;
}

// جلب المدفوعات
async function getPayments(transactionId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('transactionId', sql.Int, transactionId)
    .query(`
      SELECT
        PaymentID, PaymentDate, Amount,
        PaymentMethod, Notes, CreatedBy, CreatedAt
      FROM Payments
      WHERE TransactionID = @transactionId
      ORDER BY PaymentDate DESC
    `);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════════════
// 🧮 قواعد مالية مطابقة لبلازور (مرحلة 1 — الحزمة A)
// - مجموع السطر: Round(Quantity × UnitPrice, 2) — DTOS/InvoiceDto.cs:128
// - الإجماليات: InvoiceService.CalculateTotals — Services/InvoiceService.cs:3245
// - تقريب الخصم لأقرب 100: QuotationService.CalculateTotals — Services/QuotationService.cs:2246
//   بصيغة .NET Math.Round الافتراضية (النصف إلى الزوجي)
// - الحالة: InvoiceService.ComputeStatus — Services/InvoiceService.cs:3281
// ═══════════════════════════════════════════════════════════════════
const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const money = (value) => Math.round((num(value) + Number.EPSILON) * 100) / 100;
const VALID_TIERS = new Set(['CClass', 'Premium', 'Elite']);

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFoundError(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

// .NET Math.Round(amount / 100, 0) * 100 — النصف إلى الزوجي، بحساب سنتات صحيح
function roundDiscountToNearest100(amount) {
  const cents = Math.round((Math.max(0, num(amount)) + Number.EPSILON) * 100);
  const wholeHundreds = Math.floor(cents / 10000);
  const remainder = cents - wholeHundreds * 10000;
  let units = wholeHundreds;
  if (remainder * 2 > 10000 || (remainder * 2 === 10000 && wholeHundreds % 2 === 1)) {
    units = wholeHundreds + 1;
  }
  return units * 100;
}

function computeInvoiceStatus(grandTotal, paidAmount) {
  if (grandTotal > 0 && paidAmount >= grandTotal) return 'Paid';
  if (paidAmount > 0) return 'PartiallyPaid';
  return 'Open';
}

function formatN2(value) {
  return num(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// توليد رقم الفاتورة التالي — InvoiceService.GenerateNextInvoiceNumberAsync:731
async function generateNextInvoiceNumber(transaction, transactionType) {
  const prefix = transactionType === 'Purchase' ? 'PRC' : 'INV';
  const fullPrefix = `${prefix}-${new Date().getFullYear()}-`;
  const result = await transaction.request()
    .input('type', sql.VarChar(20), transactionType)
    .input('prefix', sql.VarChar(20), fullPrefix)
    .query(`
      SELECT TOP 1 ReferenceNumber FROM Transactions
      WHERE TransactionType = @type AND ReferenceNumber LIKE @prefix + '%'
      ORDER BY TransactionID DESC
    `);
  let next = 1;
  const last = result.recordset[0] && result.recordset[0].ReferenceNumber;
  if (last) {
    const parsed = parseInt(String(last).split('-')[2], 10);
    if (Number.isFinite(parsed)) next = parsed + 1;
  }
  return `${fullPrefix}${String(next).padStart(5, '0')}`;
}

// حركة مخزون داخل معاملة — InvoiceService.UpdateStockAsync:3288
async function adjustStockTx(transaction, { productId, warehouseId, quantityChange, referenceId, unitPrice, username, referenceType }) {
  if (!quantityChange) return;
  await transaction.request()
    .input('productId', sql.Int, productId)
    .input('warehouseId', sql.Int, warehouseId)
    .input('change', sql.Int, quantityChange)
    .input('username', sql.NVarChar(100), username)
    .query(`
      IF EXISTS (SELECT 1 FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
                 WHERE ProductID = @productId AND WarehouseID = @warehouseId)
        UPDATE StockLevels SET Quantity = Quantity + @change, LastUpdatedAt = GETDATE()
        WHERE ProductID = @productId AND WarehouseID = @warehouseId;
      ELSE
        INSERT INTO StockLevels (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedBy, CreatedAt)
        VALUES (@productId, @warehouseId, @change, GETDATE(), @username, GETDATE());
    `);
  await transaction.request()
    .input('productId', sql.Int, productId)
    .input('warehouseId', sql.Int, warehouseId)
    .input('type', sql.NVarChar(20), quantityChange < 0 ? 'Out' : 'In')
    .input('quantity', sql.Int, Math.abs(quantityChange))
    .input('referenceId', sql.Int, referenceId)
    .input('referenceType', sql.NVarChar(80), referenceType)
    .input('unitPrice', sql.Decimal(18, 2), money(unitPrice))
    .input('totalAmount', sql.Decimal(18, 2), money(Math.abs(quantityChange) * num(unitPrice)))
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO StockTransactions
        (ProductID, WarehouseID, TransactionType, Quantity, TransactionDate,
         ReferenceID, ReferenceType, UnitPrice, TotalAmount, CreatedBy, CreatedAt)
      VALUES (@productId, @warehouseId, @type, @quantity, GETDATE(),
              @referenceId, @referenceType, @unitPrice, @totalAmount, @username, GETDATE())
    `);
}

// سجل تدقيق داخل معاملة (نفس نمط سجل طلبات التعديل في هذا الملف)
async function auditTx(transaction, { actionType, primaryKey, oldData, newData, username }) {
  await transaction.request()
    .input('actionType', sql.NVarChar(50), actionType)
    .input('primaryKey', sql.NVarChar(100), String(primaryKey))
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES ('Transactions', @actionType, @primaryKey, @oldData, @newData,
              GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

// إنشاء فاتورة جديدة — الإجماليات تُحسب على الخادم ولا تُعتمد أرقام العميل:
// التحقق ValidateInvoice (InvoiceService.cs:3225) ثم إعادة الحساب من السطور.
async function createTransaction(data) {
  const detailsIn = Array.isArray(data.details) ? data.details : [];
  if (!data.partyId) throw badRequest('يرجى اختيار العميل.');
  if (!data.warehouseId) throw badRequest('يرجى اختيار المخزن.');
  if (!detailsIn.length) throw badRequest('يجب إضافة صنف واحد على الأقل.');
  if (detailsIn.some((d) => !Number(d.productId))) throw badRequest('هناك صنف بدون منتج محدد.');
  if (detailsIn.some((d) => num(d.quantity) <= 0)) throw badRequest('يجب أن تكون الكمية أكبر من صفر لكل صنف.');
  if (detailsIn.some((d) => num(d.unitPrice) < 0)) throw badRequest('السعر لا يمكن أن يكون سالباً.');

  const lines = detailsIn.map((d) => ({
    productId: Number(d.productId),
    quantity: num(d.quantity),
    unitPrice: num(d.unitPrice),
    totalAmount: money(num(d.quantity) * num(d.unitPrice)),
    pricingTier: VALID_TIERS.has(String(d.pricingTier || '')) ? String(d.pricingTier) : 'Premium',
    selectedAlternativeId: d.selectedAlternativeId == null || d.selectedAlternativeId === ''
      ? null : Number(d.selectedAlternativeId),
    notes: d.notes || null,
  }));
  const totalAmount = money(lines.reduce((sum, l) => sum + l.totalAmount, 0));

  // الخصم: صيغة الإدخال كما في بلازور (مبلغ/نسبة) ثم تقريب أقرب 100 على المبلغ النهائي
  const entryMode = String(data.discountEntryMode || '').toLowerCase();
  const discountAmountIn = num(data.discountAmount, 0);
  const discountPercentageIn = (data.discountPercentage == null || data.discountPercentage === '')
    ? null : num(data.discountPercentage, 0);
  const amountEntered = entryMode === 'amount'
    || (!entryMode && discountAmountIn > 0 && !(discountPercentageIn > 0));
  let rawDiscount = 0;
  if (amountEntered && discountAmountIn > 0) {
    rawDiscount = Math.min(Math.max(discountAmountIn, 0), totalAmount);
  } else if (discountPercentageIn != null && discountPercentageIn > 0) {
    const pct = Math.min(Math.max(discountPercentageIn, 0), 100);
    rawDiscount = Math.min(money(totalAmount * pct / 100), totalAmount);
  }
  let discountAmount = roundDiscountToNearest100(rawDiscount);
  if (discountAmount > totalAmount) discountAmount = totalAmount;
  const discountPercentage = discountAmount > 0 && totalAmount > 0
    ? money(discountAmount / totalAmount * 100) : 0;
  const netTotalAmount = money(totalAmount - discountAmount);

  const chargesIn = Array.isArray(data.charges) ? data.charges : [];
  const totalChargesAmount = money(chargesIn.reduce(
    (sum, c) => sum + num(c.amount != null ? c.amount : c.chargeAmount), 0));
  const grandTotal = money(netTotalAmount + totalChargesAmount);

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // رقم الفاتورة: يُولَّد عند غيابه ويُفحص تكراره عند إرساله (InvoiceService.cs:731, 902)
    let referenceNumber = data.referenceNumber || null;
    if (referenceNumber) {
      const dup = await transaction.request()
        .input('ref', sql.NVarChar(50), referenceNumber)
        .input('type', sql.VarChar(20), data.transactionType)
        .query(`SELECT 1 AS X FROM Transactions WHERE ReferenceNumber = @ref AND TransactionType = @type`);
      if (dup.recordset.length) throw badRequest(`رقم الفاتورة '${referenceNumber}' مستخدم.`);
    } else {
      referenceNumber = await generateNextInvoiceNumber(transaction, data.transactionType);
    }

    // موظف البيع من اسم المستخدم عند غيابه (InvoiceService.cs:782)
    let empId = data.empId || null;
    if (!empId && data.createdBy) {
      const empRes = await transaction.request()
        .input('username', sql.NVarChar(50), data.createdBy)
        .query(`SELECT employeeID FROM Users WHERE Username = @username`);
      empId = (empRes.recordset[0] && empRes.recordset[0].employeeID) || null;
    }

    const result = await transaction.request()
      .input('transactionDate', sql.DateTime, data.transactionDate || new Date())
      .input('partyId', sql.Int, data.partyId)
      .input('transactionType', sql.VarChar(20), data.transactionType)
      .input('warehouseId', sql.Int, data.warehouseId)
      .input('empId', sql.Int, empId)
      .input('referenceNumber', sql.NVarChar(50), referenceNumber)
      .input('totalAmount', sql.Decimal(18, 2), totalAmount)
      .input('discountPercentage', sql.Decimal(5, 2), discountPercentage)
      .input('discountAmount', sql.Decimal(18, 2), discountAmount)
      .input('netTotalAmount', sql.Decimal(18, 2), netTotalAmount)
      .input('totalChargesAmount', sql.Decimal(18, 2), totalChargesAmount)
      .input('grandTotal', sql.Decimal(18, 2), grandTotal)
      .input('paymentMethod', sql.NVarChar(20), data.paymentMethod || null)
      .input('dueDate', sql.DateTime, data.dueDate || null)
      .input('opportunityId', sql.Int, data.opportunityId || null)
      .input('notes', sql.NVarChar(255), data.notes || null)
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO Transactions (
          TransactionDate, PartyID, TransactionType, WarehouseID, EmpId, ReferenceNumber,
          TotalAmount, DiscountPercentage, DiscountAmount, NetTotalAmount,
          PaidAmount, TotalChargesAmount, GrandTotal, PaymentMethod, InvoiceStatus,
          DueDate, OpportunityId, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.TransactionID
        VALUES (
          @transactionDate, @partyId, @transactionType, @warehouseId, @empId, @referenceNumber,
          @totalAmount, @discountPercentage, @discountAmount, @netTotalAmount,
          0, @totalChargesAmount, @grandTotal, @paymentMethod, 'Open',
          @dueDate, @opportunityId, @notes, @createdBy, GETDATE()
        )
      `);

    const transactionId = result.recordset[0].TransactionID;

    for (const line of lines) {
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('productId', sql.Int, line.productId)
        .input('quantity', sql.Decimal(18, 3), line.quantity)
        .input('unitPrice', sql.Decimal(18, 2), line.unitPrice)
        .input('totalAmount', sql.Decimal(18, 2), line.totalAmount)
        .input('pricingTier', sql.NVarChar(20), line.pricingTier)
        .input('selectedAlternativeId', sql.Int, line.selectedAlternativeId)
        .input('notes', sql.NVarChar(255), line.notes)
        .query(`
          INSERT INTO TransactionDetails (TransactionID, ProductID, Quantity, UnitPrice, TotalAmount, PricingTier, SelectedAlternativeID, Notes)
          VALUES (@transactionId, @productId, @quantity, @unitPrice, @totalAmount, @pricingTier, @selectedAlternativeId, @notes)
        `);
    }

    for (const charge of chargesIn) {
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('partyId', sql.Int, data.partyId)
        .input('chargeDescription', sql.NVarChar(255),
          charge.description != null ? charge.description : (charge.chargeDescription || null))
        .input('chargeAmount', sql.Decimal(18, 2),
          money(charge.amount != null ? charge.amount : charge.chargeAmount))
        .input('notes', sql.NVarChar(sql.MAX), charge.notes || null)
        .input('createdBy', sql.NVarChar(50), data.createdBy)
        .query(`
          INSERT INTO AdditionalCharges (TransactionID, PartyID, ChargeDescription, ChargeAmount, Notes, CreatedBy, CreatedAt)
          VALUES (@transactionId, @partyId, @chargeDescription, @chargeAmount, @notes, @createdBy, GETDATE())
        `);
    }

    // تطبيق الدفعات المقدمة المختارة (InvoiceService.cs:1000)
    let paidTotal = 0;
    const advanceIds = [...new Set((Array.isArray(data.selectedAdvanceChargeIds)
      ? data.selectedAdvanceChargeIds : []).map((id) => Number(id)).filter((id) => id > 0))];
    for (const chargeId of advanceIds) {
      const advRes = await transaction.request()
        .input('chargeId', sql.Int, chargeId)
        .input('partyId', sql.Int, data.partyId)
        .query(`SELECT ChargeID, ChargeDescription, ChargeAmount FROM AdditionalCharges
                WHERE ChargeID = @chargeId AND PartyID = @partyId AND TransactionID IS NULL`);
      const adv = advRes.recordset[0];
      if (!adv) continue;
      await transaction.request()
        .input('chargeId', sql.Int, chargeId)
        .input('transactionId', sql.Int, transactionId)
        .query(`UPDATE AdditionalCharges SET TransactionID = @transactionId WHERE ChargeID = @chargeId`);
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), money(adv.ChargeAmount))
        .input('notes', sql.NVarChar(sql.MAX), `تطبيق دفعة مقدمة: ${adv.ChargeDescription || ''}`)
        .input('createdBy', sql.NVarChar(50), data.createdBy)
        .query(`
          INSERT INTO Payments (TransactionID, PaymentDate, Amount, PaymentMethod, Notes, CreatedBy, CreatedAt)
          VALUES (@transactionId, GETDATE(), @amount, 'Advance', @notes, @createdBy, GETDATE())
        `);
      paidTotal = money(paidTotal + num(adv.ChargeAmount));
    }

    // الدفعة الفورية عند الإنشاء (InvoiceService.cs:1046): بحضور الخزينة تُسجَّل
    // دفعة + سند قبض في نفس المعاملة؛ وبدونها يُحفظ المبلغ كما كان سلوك الـ API
    // (تطبيق فلاتر الحالي لا يرسل الخزينة مع الإنشاء — إرسالها يفعّل السند).
    const paidIn = money(data.paidAmount);
    if (paidIn > 0 && data.cashBoxId) {
      const payRes = await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), paidIn)
        .input('paymentMethod', sql.NVarChar(50), data.paymentMethod || 'Cash')
        .input('createdBy', sql.NVarChar(50), data.createdBy)
        .query(`
          INSERT INTO Payments (TransactionID, PaymentDate, Amount, PaymentMethod, Notes, CreatedBy, CreatedAt)
          OUTPUT INSERTED.PaymentID
          VALUES (@transactionId, GETDATE(), @amount, @paymentMethod, N'دفعة عند إنشاء الفاتورة', @createdBy, GETDATE())
        `);
      const paymentId = payRes.recordset[0].PaymentID;
      await transaction.request()
        .input('cashBoxId', sql.Int, data.cashBoxId)
        .input('paymentId', sql.Int, paymentId)
        .input('referenceId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), paidIn)
        .input('notes', sql.NVarChar(500), `تحصيل فاتورة ${referenceNumber}`)
        .input('createdBy', sql.NVarChar(50), data.createdBy)
        .query(`
          INSERT INTO CashboxTransactions
            (CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType, Amount, TransactionDate, Notes, CreatedBy, CreatedAt)
          VALUES (@cashBoxId, @paymentId, @referenceId, 'SaleInvoice', N'قبض', @amount, GETDATE(), @notes, @createdBy, GETDATE())
        `);
    }
    if (paidIn > 0) paidTotal = money(paidTotal + paidIn);

    if (paidTotal > 0) {
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('paidAmount', sql.Decimal(18, 2), paidTotal)
        .input('status', sql.NVarChar(20), computeInvoiceStatus(grandTotal, paidTotal))
        .query(`UPDATE Transactions SET PaidAmount = @paidAmount, InvoiceStatus = @status WHERE TransactionID = @transactionId`);
    }

    await transaction.commit();
    return transactionId;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) { /* تجاهل */ }
    throw err;
  }
}

// إضافة دفعة — AddPaymentAsync (InvoiceService.cs:2276): حد بالمتبقي،
// رفض على الملغاة، وسند قبض بالخزينة في نفس المعاملة.
async function addPayment(data) {
  const amount = money(data.amount);
  if (!(amount > 0)) throw badRequest('المبلغ يجب أن يكون أكبر من صفر.');
  if (!data.cashBoxId) throw badRequest('يرجى اختيار الخزينة.');

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const cur = await transaction.request()
      .input('id', sql.Int, data.transactionId)
      .query(`SELECT TransactionID, ReferenceNumber, GrandTotal, PaidAmount, InvoiceStatus
              FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id`);
    const invoice = cur.recordset[0];
    if (!invoice) throw notFoundError('الفاتورة غير موجودة.');
    if (invoice.InvoiceStatus === 'Cancelled') throw badRequest('لا يمكن إضافة دفعة لفاتورة ملغية.');

    const remaining = money(num(invoice.GrandTotal) - num(invoice.PaidAmount));
    if (amount > remaining) throw badRequest(`المبلغ أكبر من المتبقي (${formatN2(remaining)}).`);

    const payRes = await transaction.request()
      .input('transactionId', sql.Int, data.transactionId)
      .input('paymentDate', sql.DateTime, data.paymentDate || new Date())
      .input('amount', sql.Decimal(18, 2), amount)
      .input('paymentMethod', sql.NVarChar(50), data.paymentMethod || 'Cash')
      .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO Payments (TransactionID, PaymentDate, Amount, PaymentMethod, Notes, CreatedBy, CreatedAt)
        OUTPUT INSERTED.PaymentID
        VALUES (@transactionId, @paymentDate, @amount, @paymentMethod, @notes, @createdBy, GETDATE())
      `);
    const paymentId = payRes.recordset[0].PaymentID;

    await transaction.request()
      .input('cashBoxId', sql.Int, data.cashBoxId)
      .input('paymentId', sql.Int, paymentId)
      .input('transactionId', sql.Int, data.transactionId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(500), `تحصيل فاتورة ${invoice.ReferenceNumber || ''}`)
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO CashboxTransactions
          (CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType, Amount, TransactionDate, Notes, CreatedBy, CreatedAt)
        VALUES (@cashBoxId, @paymentId, @transactionId, 'SaleInvoice', N'قبض', @amount, GETDATE(), @notes, @createdBy, GETDATE())
      `);

    const newPaid = money(num(invoice.PaidAmount) + amount);
    await transaction.request()
      .input('transactionId', sql.Int, data.transactionId)
      .input('paidAmount', sql.Decimal(18, 2), newPaid)
      .input('status', sql.NVarChar(20), computeInvoiceStatus(num(invoice.GrandTotal), newPaid))
      .query(`UPDATE Transactions SET PaidAmount = @paidAmount, InvoiceStatus = @status WHERE TransactionID = @transactionId`);

    await transaction.commit();
    return paymentId;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) { /* تجاهل */ }
    throw err;
  }
}

// إلغاء فاتورة — CancelInvoiceAsync (InvoiceService.cs:2024): ممنوع على المسددة
// بالكامل؛ إعادة مخزون البيع، إلغاء فاتورة الشراء المرآة، فكّ الدفعات المقدمة
// وعروض الأسعار — وسندات قبض الخزينة لا تُعكَس (كبلازور تمامًا).
async function cancelTransaction(transactionId, reason, username) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  const usernameVal = username || 'System';

  try {
    await transaction.begin();

    const headRes = await transaction.request()
      .input('id', sql.Int, transactionId)
      .query(`SELECT * FROM Transactions WITH (UPDLOCK, HOLDLOCK) WHERE TransactionID = @id`);
    const invoice = headRes.recordset[0];
    if (!invoice) throw notFoundError('الفاتورة غير موجودة.');
    if (invoice.InvoiceStatus === 'Cancelled') throw badRequest('الفاتورة ملغية بالفعل.');
    if (num(invoice.GrandTotal) > 0 && num(invoice.PaidAmount) >= num(invoice.GrandTotal)) {
      throw badRequest('لا يمكن إلغاء فاتورة مسددة بالكامل.');
    }

    const detailsRes = await transaction.request()
      .input('id', sql.Int, transactionId)
      .query(`SELECT ProductID, Quantity, UnitPrice FROM TransactionDetails WHERE TransactionID = @id`);
    const details = detailsRes.recordset;
    let mirrorCancelled = false;

    if (invoice.TransactionType === 'Sale') {
      for (const d of details) {
        await adjustStockTx(transaction, {
          productId: d.ProductID,
          warehouseId: invoice.WarehouseID,
          quantityChange: Math.round(num(d.Quantity)),
          referenceId: transactionId,
          unitPrice: d.UnitPrice,
          username: usernameVal,
          referenceType: 'SaleInvoiceCancel',
        });
      }
      const productIds = [...new Set(details.map((d) => Number(d.ProductID)).filter((x) => x > 0))];
      if (productIds.length) {
        await transaction.request().query(
          `UPDATE Products SET IsSelected = 0 WHERE ProductID IN (${productIds.join(',')}) AND Customer IS NOT NULL`);
      }

      const mirrorRes = await transaction.request()
        .input('refType', sql.NVarChar(80), `MirrorOf:${transactionId}`)
        .query(`SELECT TOP 1 * FROM Transactions WHERE ReferenceType = @refType`);
      const mirror = mirrorRes.recordset[0];
      if (mirror && mirror.InvoiceStatus !== 'Cancelled') {
        const mDetailsRes = await transaction.request()
          .input('id', sql.Int, mirror.TransactionID)
          .query(`SELECT ProductID, Quantity, UnitPrice FROM TransactionDetails WHERE TransactionID = @id`);
        for (const d of mDetailsRes.recordset) {
          await adjustStockTx(transaction, {
            productId: d.ProductID,
            warehouseId: mirror.WarehouseID,
            quantityChange: -Math.round(num(d.Quantity)),
            referenceId: mirror.TransactionID,
            unitPrice: d.UnitPrice,
            username: usernameVal,
            referenceType: 'PurchaseInvoiceCancel',
          });
        }
        await transaction.request()
          .input('id', sql.Int, mirror.TransactionID)
          .input('username', sql.NVarChar(50), usernameVal)
          .query(`UPDATE Transactions SET InvoiceStatus = 'Cancelled',
                    EditReason = N'إلغاء تلقائي مع فاتورة البيع', EditBy = @username, EditAt = GETDATE()
                  WHERE TransactionID = @id`);
        await auditTx(transaction, {
          actionType: 'Cancel',
          primaryKey: mirror.TransactionID,
          oldData: { InvoiceStatus: mirror.InvoiceStatus },
          newData: { InvoiceStatus: 'Cancelled', Reason: 'إلغاء تلقائي مع فاتورة البيع' },
          username: usernameVal,
        });
        mirrorCancelled = true;
      }
    }

    if (invoice.TransactionType === 'Purchase' && invoice.IsDelivered
      && (invoice.ReferenceType === 'PurchaseInvoice' || !invoice.ReferenceType)) {
      for (const d of details) {
        await adjustStockTx(transaction, {
          productId: d.ProductID,
          warehouseId: invoice.WarehouseID,
          quantityChange: -Math.round(num(d.Quantity)),
          referenceId: transactionId,
          unitPrice: d.UnitPrice,
          username: usernameVal,
          referenceType: 'PurchaseInvoiceCancel',
        });
      }
    }

    // فكّ الدفعات المقدمة: فكّ ربط الرسم وحذف صف الدفعة (InvoiceService.cs:2111)
    const advRes = await transaction.request()
      .input('id', sql.Int, transactionId)
      .query(`SELECT PaymentID, Amount FROM Payments WHERE TransactionID = @id AND PaymentMethod = 'Advance'`);
    for (const adv of advRes.recordset) {
      await transaction.request()
        .input('id', sql.Int, transactionId)
        .input('partyId', sql.Int, invoice.PartyID)
        .input('amount', sql.Decimal(18, 2), money(adv.Amount))
        .query(`UPDATE TOP (1) AdditionalCharges SET TransactionID = NULL
                WHERE TransactionID = @id AND PartyID = @partyId AND ChargeAmount = @amount`);
      await transaction.request()
        .input('paymentId', sql.Int, adv.PaymentID)
        .query(`DELETE FROM Payments WHERE PaymentID = @paymentId`);
    }

    // فكّ عروض الأسعار المرتبطة وإعادتها «مقبول» (InvoiceService.cs:2131)
    let quotationNote = '';
    if (invoice.TransactionType === 'Sale') {
      const qRes = await transaction.request()
        .input('id', sql.Int, transactionId)
        .query(`SELECT QuotationId, ReferenceNumber FROM Quotations WHERE InvoiceId = @id`);
      for (const q of qRes.recordset) {
        quotationNote += `، وفُك ارتباط عرض السعر ${q.ReferenceNumber} وأُعيد لحالة «مقبول»`;
      }
      if (qRes.recordset.length) {
        await transaction.request()
          .input('id', sql.Int, transactionId)
          .query(`UPDATE Quotations SET InvoiceId = NULL, Status = 'Accepted' WHERE InvoiceId = @id`);
      }
    }

    await transaction.request()
      .input('id', sql.Int, transactionId)
      .input('reason', sql.NVarChar(500), reason || null)
      .input('username', sql.NVarChar(50), usernameVal)
      .query(`UPDATE Transactions SET InvoiceStatus = 'Cancelled', EditReason = @reason,
                EditBy = @username, EditAt = GETDATE() WHERE TransactionID = @id`);
    await auditTx(transaction, {
      actionType: 'Cancel',
      primaryKey: transactionId,
      oldData: { InvoiceStatus: invoice.InvoiceStatus },
      newData: { InvoiceStatus: 'Cancelled', Reason: reason || '' },
      username: usernameVal,
    });

    await transaction.commit();

    let message;
    if (invoice.TransactionType === 'Sale') {
      message = mirrorCancelled
        ? 'تم إلغاء الفاتورة وفاتورة الشراء المرآة وإعادة المخزون.'
        : 'تم إلغاء الفاتورة وإعادة المخزون بدون وجود فاتورة شراء مرآة مرتبطة.';
      if (quotationNote) message += `${quotationNote}.`;
    } else {
      message = 'تم إلغاء فاتورة الشراء ومعالجة المخزون حسب حالة الاستلام.';
    }
    return { message };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) { /* تجاهل */ }
    throw err;
  }
}

// ملخص الفواتير
async function getTransactionsSummary(type = null) {
  const pool = await connectDB();
  const request = pool.request();

  let whereClause = '';
  if (type) {
    whereClause = `WHERE TransactionType = @type`;
    request.input('type', sql.VarChar(20), type);
  }

  const result = await request.query(`
    SELECT
      COUNT(*) as totalCount,
      ISNULL(SUM(GrandTotal), 0) as totalAmount,
      ISNULL(SUM(PaidAmount), 0) as totalPaid,
      ISNULL(SUM(GrandTotal - PaidAmount), 0) as totalRemaining
    FROM Transactions
    ${whereClause}
  `);
  return result.recordset[0];
}

// ═══════════════════════════════════════════════════════════
// 🧾 نظام طلبات تعديل الفواتير (Edit Status)
// ═══════════════════════════════════════════════════════════

// طلب تعديل فاتورة بيع + Audit + إشعار مدير الإنتاج
async function requestEdit(transactionId, requestedBy, reason) {
  const pool = await connectDB();
  const current = await pool.request().input('id', sql.Int, transactionId).query(`
    SELECT t.TransactionID, t.TransactionType, t.InvoiceStatus, t.ReferenceNumber,
           t.PartyID, p.PartyName
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionID = @id
  `);
  const invoice = current.recordset[0];
  if (!invoice) throw new Error('الفاتورة غير موجودة');
  if (invoice.TransactionType !== 'Sale') throw new Error('طلب التعديل متاح لفواتير البيع فقط');
  if (invoice.InvoiceStatus === 'Cancelled') throw new Error('لا يمكن طلب تعديل فاتورة ملغية');

  await pool.request()
    .input('id', sql.Int, transactionId)
    .input('editBy', sql.NVarChar(100), requestedBy)
    .input('editReason', sql.NVarChar(500), reason)
    .query(`
      UPDATE Transactions SET
        EditStatus = 1, EditBy = @editBy,
        EditRequestDate = GETDATE(), EditReason = @editReason,
        EditReviewedBy = NULL, EditReviewedAt = NULL,
        EditReviewNotes = NULL, EditDone = NULL
      WHERE TransactionID = @id;

      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (N'Transactions', N'EditRequest', CONVERT(NVARCHAR(100), @id), NULL,
         (SELECT @editReason AS Reason, @editBy AS RequestedBy FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
         GETDATE(), @editBy, N'COCOBOLO Flutter', @editBy);
    `);

  const message = `طلب تعديل الفاتورة ${invoice.ReferenceNumber || `#${transactionId}`} للعميل ${invoice.PartyName} بواسطة ${requestedBy}.\nالسبب: ${reason}\nبرجاء متابعة الطلب من شاشة أوامر التشغيل.`;
  try {
    await notificationsQueries.createNotificationSmart({
      title: '🧾 طلب تعديل فاتورة',
      message,
      createdBy: requestedBy,
      formName: 'production/job-orders',
      relatedTable: 'Transactions',
      relatedId: transactionId,
    }, 'ProductionManager');
  } catch (e) { console.error('invoice edit request notify:', e.message); }
  return true;
}

// قائمة طلبات التعديل المعلقة
async function getPendingEditRequests() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT t.TransactionID, t.TransactionDate, t.GrandTotal,
           t.EditBy, t.EditRequestDate, t.EditReason,
           p.PartyName AS ClientName
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.EditStatus = 1
    ORDER BY t.EditRequestDate DESC
  `);
  return result.recordset;
}

async function processEditRequest(transactionId, approved, reviewer, notes) {
  const pool = await connectDB();
  const current = await pool.request().input('id', sql.Int, transactionId).query(`
    SELECT t.TransactionID, t.ReferenceNumber, t.EditBy, t.EditStatus,
           p.PartyName
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.TransactionID = @id
  `);
  const invoice = current.recordset[0];
  if (!invoice) throw new Error('الفاتورة غير موجودة');
  if (Number(invoice.EditStatus) !== 1) throw new Error('طلب التعديل ليس معلقاً');

  const status = approved ? 2 : 3;
  const action = approved ? 'EditApprove' : 'EditReject';
  const done = approved
    ? `تمت الموافقة بواسطة ${reviewer}`
    : `تم الرفض بواسطة ${reviewer}${notes ? ` - السبب: ${notes}` : ''}`;

  await pool.request()
    .input('id', sql.Int, transactionId)
    .input('status', sql.Int, status)
    .input('reviewer', sql.NVarChar(100), reviewer)
    .input('notes', sql.NVarChar(500), notes || null)
    .input('done', sql.NVarChar(500), done)
    .input('action', sql.NVarChar(50), action)
    .query(`
      UPDATE Transactions SET
        EditStatus = @status, EditReviewedBy = @reviewer,
        EditReviewedAt = GETDATE(), EditReviewNotes = @notes,
        EditDone = @done
      WHERE TransactionID = @id AND EditStatus = 1;

      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (N'Transactions', @action, CONVERT(NVARCHAR(100), @id), NULL,
         (SELECT @reviewer AS ReviewedBy, @notes AS Notes, @status AS Status FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
         GETDATE(), @reviewer, N'COCOBOLO Flutter', @reviewer);
    `);

  if (invoice.EditBy && String(invoice.EditBy).toLowerCase() !== String(reviewer).toLowerCase()) {
    const title = approved
      ? '✅ تمت الموافقة على طلب تعديل الفاتورة'
      : '❌ تم رفض طلب تعديل الفاتورة';
    let message = approved
      ? `تمت الموافقة بواسطة ${reviewer} على طلب تعديل الفاتورة ${invoice.ReferenceNumber || transactionId} للعميل ${invoice.PartyName}.`
      : `تم رفض طلب تعديل الفاتورة ${invoice.ReferenceNumber || transactionId} للعميل ${invoice.PartyName} بواسطة ${reviewer}.`;
    if (notes) message += `\n${approved ? 'ملاحظات المراجعة' : 'سبب / ملاحظات الرفض'}: ${notes}`;
    try {
      await notificationsQueries.createNotification({
        title,
        message,
        recipientUser: invoice.EditBy,
        createdBy: reviewer,
        formName: 'sales/invoices',
        relatedTable: 'Transactions',
        relatedId: transactionId,
      });
    } catch (e) { console.error('invoice edit decision notify:', e.message); }
  }
  return true;
}

async function approveEditRequest(transactionId, approvedBy, notes = null) {
  return processEditRequest(transactionId, true, approvedBy, notes);
}

async function rejectEditRequest(transactionId, rejectedBy, reason) {
  return processEditRequest(transactionId, false, rejectedBy, reason);
}

// تعديل فعلي: تاريخ التسليم + الخصم — نسخة مصححة تحسب الإجماليات صح 100% مثل بلازور
async function applyInvoiceEdit({
  transactionId,
  dueDate,
  discountPercentage,
  discountAmount,
  editedBy,
}) {
  const pool = await connectDB();

  // 1) جلب الحالية لحساب الإجماليات بدقة
  const curRes = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT TotalAmount, TotalChargesAmount, DiscountPercentage, DiscountAmount FROM Transactions WHERE TransactionID = @id`);
  const cur = curRes.recordset[0];
  if (!cur) throw new Error('الفاتورة غير موجودة');

  const totalAmount = Number(cur.TotalAmount || 0);
  const totalCharges = Number(cur.TotalChargesAmount || 0);

  let newDiscPct = cur.DiscountPercentage;
  let newDiscAmt = cur.DiscountAmount;

  // أولوية لقيمة الخصم لو مبعوتة
  if (discountAmount !== undefined && discountAmount !== null && discountAmount !== '') {
    newDiscAmt = Number(discountAmount);
    if (newDiscAmt > totalAmount) newDiscAmt = totalAmount;
    newDiscPct = totalAmount > 0 ? Number(((newDiscAmt / totalAmount) * 100).toFixed(2)) : 0;
  } else if (discountPercentage !== undefined && discountPercentage !== null && discountPercentage !== '') {
    newDiscPct = Number(discountPercentage);
    newDiscAmt = Number((totalAmount * (newDiscPct / 100)).toFixed(2));
    if (newDiscAmt > totalAmount) newDiscAmt = totalAmount;
  }

  if (newDiscAmt == null) newDiscAmt = 0;
  if (newDiscPct == null) newDiscPct = 0;

  const netTotal = Number((totalAmount - newDiscAmt).toFixed(2));
  const grandTotal = Number((netTotal + totalCharges).toFixed(2));

  const request = pool.request()
    .input('id', sql.Int, transactionId)
    .input('editedBy', sql.NVarChar(100), editedBy || 'System')
    .input('discPct', sql.Decimal(5, 2), newDiscPct)
    .input('discAmt', sql.Decimal(18, 2), newDiscAmt)
    .input('netTotal', sql.Decimal(18, 2), netTotal)
    .input('grandTotal', sql.Decimal(18, 2), grandTotal);

  let setClause = `EditStatus = 4, EditDone = @editedBy, EditAt = GETDATE(), DiscountPercentage = @discPct, DiscountAmount = @discAmt, NetTotalAmount = @netTotal, GrandTotal = @grandTotal`;

  if (dueDate) {
    request.input('dueDate', sql.DateTime, new Date(dueDate));
    setClause += `, DueDate = @dueDate`;
  }

  await request.query(`UPDATE Transactions SET ${setClause} WHERE TransactionID = @id`);
  return true;
}

// تحديث هيدر الفاتورة (مطابق بلازور UpdateInvoiceAsync) - يحدث الملاحظات + التسليم + الدفع + الخصم مع إعادة حساب الإجماليات
async function updateTransaction(transactionId, data) {
  const pool = await connectDB();

  const curRes = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT TransactionID, TotalAmount, TotalChargesAmount, DiscountPercentage, DiscountAmount, InvoiceStatus FROM Transactions WHERE TransactionID = @id`);
  const cur = curRes.recordset[0];
  if (!cur) return { success: false, message: 'الفاتورة غير موجودة' };
  if (cur.InvoiceStatus === 'Cancelled') return { success: false, message: 'لا يمكن تعديل فاتورة ملغية' };

  const totalAmount = Number(cur.TotalAmount || 0);
  const totalCharges = Number(cur.TotalChargesAmount || 0);

  let newDiscPct = cur.DiscountPercentage;
  let newDiscAmt = cur.DiscountAmount;

  if (data.discountAmount !== undefined && data.discountAmount !== null && data.discountAmount !== '') {
    newDiscAmt = Number(data.discountAmount);
    if (newDiscAmt > totalAmount) newDiscAmt = totalAmount;
    newDiscPct = totalAmount > 0 ? Number(((newDiscAmt / totalAmount) * 100).toFixed(2)) : 0;
  } else if (data.discountPercentage !== undefined && data.discountPercentage !== null && data.discountPercentage !== '') {
    newDiscPct = Number(data.discountPercentage);
    newDiscAmt = Number((totalAmount * (newDiscPct / 100)).toFixed(2));
    if (newDiscAmt > totalAmount) newDiscAmt = totalAmount;
  }

  if (newDiscAmt == null) newDiscAmt = 0;
  if (newDiscPct == null) newDiscPct = 0;

  const netTotal = Number((totalAmount - newDiscAmt).toFixed(2));
  const grandTotal = Number((netTotal + totalCharges).toFixed(2));

  const req = pool.request()
    .input('id', sql.Int, transactionId)
    .input('discPct', sql.Decimal(5, 2), newDiscPct)
    .input('discAmt', sql.Decimal(18, 2), newDiscAmt)
    .input('netTotal', sql.Decimal(18, 2), netTotal)
    .input('grandTotal', sql.Decimal(18, 2), grandTotal)
    .input('editedBy', sql.NVarChar(100), data.editedBy || data.createdBy || 'System');

  let sets = [];
  sets.push('DiscountPercentage = @discPct');
  sets.push('DiscountAmount = @discAmt');
  sets.push('NetTotalAmount = @netTotal');
  sets.push('GrandTotal = @grandTotal');
  sets.push('EditBy = @editedBy');
  sets.push('EditAt = GETDATE()');
  sets.push('EditStatus = CASE WHEN EditStatus IN (1,2) THEN 4 ELSE EditStatus END');
  sets.push(`EditDone = CONCAT('تم التعديل بواسطة ', @editedBy, ' بتاريخ ', FORMAT(GETDATE(), 'yyyy/MM/dd HH:mm'))`);

  if (data.notes !== undefined) {
    req.input('notes', sql.NVarChar(sql.MAX), data.notes);
    sets.push('Notes = @notes');
  }
  if (data.dueDate) {
    req.input('dueDate', sql.DateTime, new Date(data.dueDate));
    sets.push('DueDate = @dueDate');
  }
  if (data.paymentMethod !== undefined) {
    req.input('payMethod', sql.NVarChar(50), data.paymentMethod);
    sets.push('PaymentMethod = @payMethod');
  }
  if (data.isDelivered !== undefined) {
    req.input('isDelivered', sql.Bit, data.isDelivered ? 1 : 0);
    sets.push('IsDelivered = @isDelivered');
  }
  if (data.opportunityId !== undefined) {
    req.input('oppId', sql.Int, data.opportunityId || null);
    sets.push('OpportunityId = @oppId');
  }

  const query = `UPDATE Transactions SET ${sets.join(', ')} WHERE TransactionID = @id`;
  await req.query(query);
  return { success: true };
}

// تعديل مبلغ صنف في الفاتورة + تسجيل في PriceHistory - مصحح 100% لحساب الإجماليات
async function updateDetailPrice(transactionId, detailId, newUnitPrice, editedBy, changeReason) {
  const pool = await connectDB();

  // 1. جلب السعر القديم + بيانات الفاتورة الحالية
  const oldRes = await pool.request()
    .input('detailId', sql.Int, detailId)
    .query(`
      SELECT td.UnitPrice, td.ProductID, td.Quantity, td.TransactionID
      FROM TransactionDetails td
      WHERE td.DetailID = @detailId
    `);
  const old = oldRes.recordset[0];
  if (!old) return { success: false, message: 'الصنف غير موجود' };

  // 2. تحديث السعر + الإجمالي للصنف
  await pool.request()
    .input('detailId', sql.Int, detailId)
    .input('newPrice', sql.Decimal(18, 2), newUnitPrice)
    .query(`
      UPDATE TransactionDetails
      SET UnitPrice = @newPrice,
          TotalAmount = Quantity * @newPrice
      WHERE DetailID = @detailId
    `);

  // 3. تسجيل في PriceHistory
  try {
    await pool.request()
      .input('productId', sql.Int, old.ProductID)
      .input('priceType', sql.NVarChar(20), 'Sale')
      .input('oldPrice', sql.Decimal(18, 2), old.UnitPrice)
      .input('newPrice', sql.Decimal(18, 2), newUnitPrice)
      .input('changedBy', sql.NVarChar(50), editedBy)
      .input('reason', sql.NVarChar(200), changeReason || `تعديل سعر صنف في فاتورة #${transactionId}`)
      .query(`
        INSERT INTO PriceHistory (
          ProductID, PriceType, OldPrice, NewPrice,
          ChangedBy, ChangedAt, ChangeReason
        )
        VALUES (
          @productId, @priceType, @oldPrice, @newPrice,
          @changedBy, GETDATE(), @reason
        )
      `);
  } catch (e) {
    console.warn('PriceHistory insert failed (table may not exist):', e.message);
  }

  // 4. إعادة حساب إجماليات الفاتورة بدقة - مثل بلازور CalculateTotals
  const sumRes = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT ISNULL(SUM(TotalAmount),0) AS SumTotal FROM TransactionDetails WHERE TransactionID = @id`);
  const sumTotal = Number(sumRes.recordset[0].SumTotal || 0);

  const transRes = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT DiscountPercentage, DiscountAmount, TotalChargesAmount FROM Transactions WHERE TransactionID = @id`);
  const tr = transRes.recordset[0] || {};
  let discPct = Number(tr.DiscountPercentage || 0);
  let discAmt = Number(tr.DiscountAmount || 0);
  const charges = Number(tr.TotalChargesAmount || 0);

  // حساب الخصم حسب الأولوية: قيمة > نسبة
  if (discAmt > 0) {
    if (discAmt > sumTotal) discAmt = sumTotal;
    discPct = sumTotal > 0 ? Number(((discAmt / sumTotal) * 100).toFixed(2)) : 0;
  } else if (discPct > 0) {
    discAmt = Number((sumTotal * (discPct / 100)).toFixed(2));
    if (discAmt > sumTotal) discAmt = sumTotal;
  } else {
    discAmt = 0;
    discPct = 0;
  }

  const netTotal = Number((sumTotal - discAmt).toFixed(2));
  const grandTotal = Number((netTotal + charges).toFixed(2));

  await pool.request()
    .input('id', sql.Int, transactionId)
    .input('totalAmt', sql.Decimal(18, 2), sumTotal)
    .input('discPct', sql.Decimal(5, 2), discPct)
    .input('discAmt', sql.Decimal(18, 2), discAmt)
    .input('netTotal', sql.Decimal(18, 2), netTotal)
    .input('grandTotal', sql.Decimal(18, 2), grandTotal)
    .query(`
      UPDATE Transactions SET
        TotalAmount = @totalAmt,
        DiscountPercentage = @discPct,
        DiscountAmount = @discAmt,
        NetTotalAmount = @netTotal,
        GrandTotal = @grandTotal,
        EditStatus = CASE WHEN EditStatus IN (1,2) THEN 4 ELSE EditStatus END,
        EditAt = GETDATE()
      WHERE TransactionID = @id
    `);

  return { success: true };
}

// ═══════════════════════════════════════════════════════════
// 🖨️ تصدير الفاتورة PDF — جلب كل بياناتها
// ═══════════════════════════════════════════════════════════

async function getFullInvoiceData(transactionId) {
  const pool = await connectDB();

  // الهيدر
  const header = await getTransactionById(transactionId);

  // الأصناف
  const details = await getTransactionDetails(transactionId);

  // الرسوم
  const charges = await getAdditionalCharges(transactionId);

  // المدفوعات
  const payments = await getPayments(transactionId);

  return {
    header,
    details,
    charges,
    payments,
  };
}

// تصدير الدوال
module.exports = {
  getAllTransactions,
  getInvoicesStats,
  getTransactionById,
  getTransactionDetails,
  getAdditionalCharges,
  getPayments,
  createTransaction,
  addPayment,
  cancelTransaction,
  getTransactionsSummary,
  requestEdit,
  getPendingEditRequests,
  approveEditRequest,
  rejectEditRequest,
  applyInvoiceEdit,
  updateDetailPrice,
  updateTransaction,
  getFullInvoiceData
};
