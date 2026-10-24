const { sql, connectDB } = require('../../core/database');

const SQL_INT_MAX = 2147483647;
const TIERS = new Set(['CClass', 'Premium', 'Elite']);

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function assertId(value, label = 'المعرّف') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > SQL_INT_MAX) {
    throw Object.assign(new Error(`${label} غير صالح`), { statusCode: 400 });
  }
  return id;
}

function normalizeTier(value) {
  const tier = String(value || 'Premium').trim();
  return TIERS.has(tier) ? tier : 'Premium';
}

function buildWhere(request, filters = {}, { includeStatus = true } = {}) {
  const clauses = [
    `t.TransactionType = 'Purchase'`,
    `t.ReferenceType = 'PurchaseInvoice'`,
    `(t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')`,
  ];
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    clauses.push(`(
      t.ReferenceNumber LIKE @search
      OR CAST(t.TransactionID AS NVARCHAR(30)) LIKE @search
      OR supplier.PartyName LIKE @search
      OR linked.PartyName LIKE @search
      OR w.WarehouseName LIKE @search
    )`);
  }
  if (filters.dateFrom) {
    request.input('dateFrom', sql.Date, filters.dateFrom);
    clauses.push('CAST(t.TransactionDate AS DATE) >= @dateFrom');
  }
  if (filters.dateTo) {
    request.input('dateTo', sql.Date, filters.dateTo);
    clauses.push('CAST(t.TransactionDate AS DATE) <= @dateTo');
  }
  if (filters.overdue === true || String(filters.overdue) === 'true') {
    clauses.push(`t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)
      AND ISNULL(t.GrandTotal, 0) > ISNULL(t.PaidAmount, 0)`);
  }
  if (includeStatus) {
    if (filters.status) {
      request.input('status', sql.NVarChar(50), String(filters.status));
      clauses.push('t.InvoiceStatus = @status');
    }
    const receipt = String(filters.receipt || 'all').toLowerCase();
    if (receipt === 'received') clauses.push('t.IsDelivered = 1');
    if (receipt === 'pending') clauses.push('ISNULL(t.IsDelivered, 0) = 0');
  }
  return clauses.map((clause) => `(${clause})`).join(' AND ');
}

async function getFactoryPurchases(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 25), 1), 100);
  const offset = (page - 1) * limit;
  const where = buildWhere(request, filters);
  const result = await request.query(`
    SELECT
      t.TransactionID, t.ReferenceNumber, t.TransactionDate, t.DueDate,
      t.PartyID AS SupplierID, supplier.PartyName AS SupplierName,
      t.EmpId AS LinkedCustomerID, linked.PartyName AS LinkedCustomerName,
      linked.Phone AS LinkedCustomerPhone,
      t.WarehouseID, w.WarehouseName,
      t.GrandTotal, t.PaidAmount,
      ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0) AS RemainingAmount,
      t.InvoiceStatus, t.PaymentMethod,
      ISNULL(t.IsDelivered, 0) AS IsDelivered,
      t.DeliveredAt, t.DeliveredNotes, t.CreatedBy, t.CreatedAt,
      ISNULL(items.ItemsCount, 0) AS ItemsCount,
      ISNULL(items.TotalQuantity, 0) AS TotalQuantity,
      ISNULL(items.AlternativeItemsCount, 0) AS AlternativeItemsCount,
      ISNULL(items.MaxPeriodDays, 0) AS MaxPeriodDays,
      CASE
        WHEN t.IsDelivered = 1 THEN N'تم الاستلام'
        WHEN t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'متأخر'
        ELSE N'بانتظار الاستلام'
      END AS ReceiptStatus,
      COUNT(*) OVER() AS TotalRows
    FROM Transactions t
    INNER JOIN Parties supplier ON t.PartyID = supplier.PartyID
    LEFT JOIN Parties linked ON t.EmpId = linked.PartyID
    INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
    OUTER APPLY (
      SELECT COUNT(*) AS ItemsCount,
             SUM(d.Quantity) AS TotalQuantity,
             SUM(CASE WHEN d.SelectedAlternativeID IS NOT NULL THEN 1 ELSE 0 END) AS AlternativeItemsCount,
             MAX(COALESCE(alt.Period, p.Period, 0)) AS MaxPeriodDays
      FROM TransactionDetails d
      INNER JOIN Products p ON d.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives alt
        ON d.SelectedAlternativeID = alt.AlternativeID
      WHERE d.TransactionID = t.TransactionID
    ) items
    WHERE ${where}
    ORDER BY CASE WHEN t.IsDelivered = 1 THEN 2 ELSE 0 END,
             CASE WHEN t.DueDate IS NULL THEN 1 ELSE 0 END,
             t.DueDate, t.TransactionDate DESC, t.TransactionID DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `);
  return {
    rows: result.recordset,
    page,
    limit,
    total: result.recordset.length ? Number(result.recordset[0].TotalRows || 0) : 0,
  };
}

async function getFactoryPurchaseStats(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, filters, { includeStatus: false });
  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      COALESCE(SUM(CASE WHEN CAST(t.TransactionDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS TodayCount,
      COALESCE(SUM(CASE WHEN ISNULL(t.IsDelivered, 0) = 0 THEN 1 ELSE 0 END), 0) AS PendingReceiptCount,
      COALESCE(SUM(CASE WHEN t.IsDelivered = 1 THEN 1 ELSE 0 END), 0) AS ReceivedCount,
      COALESCE(SUM(CASE WHEN t.DueDate IS NOT NULL
        AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)
        AND ISNULL(t.GrandTotal, 0) > ISNULL(t.PaidAmount, 0)
        THEN 1 ELSE 0 END), 0) AS OverdueCount,
      COALESCE(SUM(CASE WHEN t.InvoiceStatus = 'Open' OR t.InvoiceStatus IS NULL THEN 1 ELSE 0 END), 0) AS OpenCount,
      COALESCE(SUM(CASE WHEN t.InvoiceStatus = 'Paid' THEN 1 ELSE 0 END), 0) AS PaidCount,
      COALESCE(SUM(ISNULL(t.GrandTotal, 0)), 0) AS TotalAmount,
      COALESCE(SUM(ISNULL(t.PaidAmount, 0)), 0) AS TotalPaid,
      COALESCE(SUM(ISNULL(t.GrandTotal, 0) - ISNULL(t.PaidAmount, 0)), 0) AS TotalRemaining
    FROM Transactions t
    INNER JOIN Parties supplier ON t.PartyID = supplier.PartyID
    LEFT JOIN Parties linked ON t.EmpId = linked.PartyID
    INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
    WHERE ${where}
  `);
  return result.recordset[0] || {};
}

async function resolveFactorySupplier(requestOrTransaction) {
  const result = await requestOrTransaction.request().query(`
    SELECT TOP 1 PartyID, PartyName, Phone, Address
    FROM Parties
    WHERE PartyID = 11 OR PartyName = N'المصنع'
    ORDER BY CASE WHEN PartyID = 11 THEN 0 ELSE 1 END, PartyID
  `);
  const supplier = result.recordset[0];
  if (!supplier) {
    throw Object.assign(new Error('حساب المورد المصنع غير موجود في جدول العملاء والموردين'), {
      statusCode: 409,
      code: 'FACTORY_SUPPLIER_MISSING',
    });
  }
  return supplier;
}

async function getLookups() {
  const pool = await connectDB();
  const supplierResult = await pool.request().query(`
    SELECT TOP 1 PartyID, PartyName, Phone, Address
    FROM Parties
    WHERE PartyID = 11 OR PartyName = N'المصنع'
    ORDER BY CASE WHEN PartyID = 11 THEN 0 ELSE 1 END, PartyID
  `);
  const [warehouseResult, cashboxResult] = await Promise.all([
    pool.request().query(`
      SELECT w.WarehouseID, w.WarehouseName, w.BranchID,
             COALESCE(b.BranchNameAr, b.BranchNameEn, N'غير محدد') AS BranchName
      FROM Warehouses w
      LEFT JOIN Branches b ON w.BranchID = b.BranchID
      WHERE ISNULL(w.IsActive, 1) = 1
      ORDER BY BranchName, w.WarehouseName
    `),
    pool.request().query(`
      SELECT CashBoxID, CashBoxName, BranchID,
             ISNULL(IsDefault, 0) AS IsDefault
      FROM CashBoxes
      WHERE ISNULL(IsActive, 1) = 1
      ORDER BY ISNULL(IsDefault, 0) DESC, CashBoxName
    `),
  ]);
  return {
    supplier: supplierResult.recordset[0] || null,
    warehouses: warehouseResult.recordset,
    cashboxes: cashboxResult.recordset,
  };
}

async function searchLinkedCustomers(search = '') {
  const pool = await connectDB();
  const request = pool.request();
  let where = `WHERE ISNULL(IsActive, 1) = 1 AND PartyID <> 11`;
  if (String(search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(search).trim()}%`);
    where += ` AND (PartyName LIKE @search OR Phone LIKE @search OR Phone2 LIKE @search)`;
  }
  const result = await request.query(`
    SELECT TOP 40 PartyID, PartyName, Phone, Address
    FROM Parties
    ${where}
    ORDER BY PartyName
  `);
  return result.recordset;
}

async function searchShowroomProducts({ search = '', limit = 40 } = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let where = `WHERE p.Customer IS NULL`;
  if (String(search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(search).trim()}%`);
    where += ` AND (p.ProductName LIKE @search OR CAST(p.ProductID AS NVARCHAR(30)) LIKE @search)`;
  }
  const safeLimit = Math.min(Math.max(intValue(limit, 40), 1), 100);
  const result = await request.query(`
    SELECT TOP ${safeLimit}
      p.ProductID, p.ProductName, p.ProductDescription,
      p.ManufacturingDescription, p.PricingType,
      p.PurchasePriceCClass, p.PurchasePrice, p.PurchasePriceElite,
      p.Period, p.ProductGroupID, pg.GroupName,
      ISNULL((SELECT SUM(sl.Quantity) FROM StockLevels sl
              WHERE sl.ProductID = p.ProductID), 0) AS CurrentStock,
      (SELECT TOP 1 ProductImagesID FROM ProductImages pi
       WHERE pi.ProductID = p.ProductID
       ORDER BY pi.ProductImagesID) AS MainImageId,
      (SELECT COUNT(*) FROM ProductFactoryAlternatives a
       WHERE a.ProductID = p.ProductID AND ISNULL(a.Status,'') <> 'Rejected') AS AlternativesCount
    FROM Products p
    INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
    ${where}
    ORDER BY p.ProductID DESC
  `);
  return result.recordset;
}

async function getProductAlternatives(value) {
  const productId = assertId(value, 'معرّف المنتج');
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`
      SELECT AlternativeID, ProductID, AlternativeName,
             SpecificationSummary, ManufacturingDescription,
             PurchasePriceCClass, PurchasePricePremium, PurchasePriceElite,
             Period, Status, IsPrimary
      FROM ProductFactoryAlternatives
      WHERE ProductID = @productId AND ISNULL(Status,'') <> 'Rejected'
      ORDER BY IsPrimary DESC, AlternativeName, AlternativeID
    `);
  return result.recordset;
}

async function generateReference(transaction) {
  const year = new Date().getUTCFullYear();
  const prefix = `PRC-${year}-`;
  const result = await transaction.request()
    .input('prefix', sql.NVarChar(30), `${prefix}%`)
    .query(`
      SELECT TOP 1 ReferenceNumber
      FROM Transactions WITH (UPDLOCK, HOLDLOCK)
      WHERE TransactionType = 'Purchase' AND ReferenceNumber LIKE @prefix
      ORDER BY TransactionID DESC
    `);
  const last = String(result.recordset[0]?.ReferenceNumber || '');
  const parts = last.split('-');
  const next = parts.length === 3 && Number(parts[2]) > 0
    ? Number(parts[2]) + 1
    : 1;
  return `${prefix}${String(next).padStart(5, '0')}`;
}

function calculateSuggestedPrice(product, alternative, tier) {
  if (alternative) {
    if (tier === 'CClass') return money(alternative.PurchasePriceCClass);
    if (tier === 'Elite') {
      return money(alternative.PurchasePriceElite ?? alternative.PurchasePricePremium);
    }
    return money(alternative.PurchasePricePremium);
  }
  if (tier === 'CClass') return money(product.PurchasePriceCClass);
  if (tier === 'Elite') return money(product.PurchasePriceElite ?? product.PurchasePrice);
  return money(product.PurchasePrice);
}

async function writeAudit(transaction, action, id, username, oldData, newData) {
  await transaction.request()
    .input('action', sql.NVarChar(10), action)
    .input('key', sql.NVarChar(200), String(id))
    .input('username', sql.NVarChar(100), username)
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (N'Transactions', @action, @key, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function createFactoryPurchase(data, auth) {
  const items = Array.isArray(data.items || data.details)
    ? (data.items || data.details)
    : [];
  if (!items.length) {
    throw Object.assign(new Error('يجب إضافة صنف واحد على الأقل'), { statusCode: 400 });
  }
  if (items.length > 100) {
    throw Object.assign(new Error('عدد الأصناف أكبر من الحد المسموح'), { statusCode: 400 });
  }
  const warehouseId = assertId(data.warehouseId, 'معرّف المخزن');
  const linkedCustomerId = data.linkedCustomerId || data.empId
    ? assertId(data.linkedCustomerId || data.empId, 'معرّف العميل المرتبط')
    : null;
  const paidAmount = money(data.paidAmount);
  if (paidAmount < 0) {
    throw Object.assign(new Error('المبلغ المدفوع غير صالح'), { statusCode: 400 });
  }

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const supplier = await resolveFactorySupplier(transaction);
    const warehouseResult = await transaction.request()
      .input('warehouseId', sql.Int, warehouseId)
      .query(`SELECT WarehouseName FROM Warehouses WHERE WarehouseID = @warehouseId AND ISNULL(IsActive, 1) = 1`);
    if (!warehouseResult.recordset[0]) {
      throw Object.assign(new Error('المخزن غير موجود أو غير نشط'), { statusCode: 400 });
    }
    let linkedCustomer = null;
    if (linkedCustomerId) {
      const linkedResult = await transaction.request()
        .input('linkedCustomerId', sql.Int, linkedCustomerId)
        .query(`SELECT PartyID, PartyName FROM Parties WHERE PartyID = @linkedCustomerId AND ISNULL(IsActive, 1) = 1`);
      linkedCustomer = linkedResult.recordset[0] || null;
      if (!linkedCustomer) {
        throw Object.assign(new Error('العميل المرتبط غير موجود'), { statusCode: 400 });
      }
    }

    const normalizedItems = [];
    for (const raw of items) {
      const productId = assertId(raw.productId || raw.ProductID, 'معرّف المنتج');
      const quantity = Number(raw.quantity ?? raw.Quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw Object.assign(new Error('كل كمية يجب أن تكون أكبر من صفر'), { statusCode: 400 });
      }
      const productResult = await transaction.request()
        .input('productId', sql.Int, productId)
        .query(`
          SELECT ProductID, ProductName, Customer,
                 PurchasePriceCClass, PurchasePrice, PurchasePriceElite,
                 Period
          FROM Products WITH (UPDLOCK, HOLDLOCK)
          WHERE ProductID = @productId
        `);
      const product = productResult.recordset[0];
      if (!product) {
        throw Object.assign(new Error(`المنتج #${productId} غير موجود`), { statusCode: 400 });
      }
      if (product.Customer != null) {
        throw Object.assign(
          new Error(`المنتج ${product.ProductName || `#${productId}`} مرتبط بعميل؛ فاتورة المصنع المباشرة تقبل منتجات المعرض فقط`),
          { statusCode: 409 },
        );
      }
      const tier = normalizeTier(raw.pricingTier || raw.PricingTier);
      const alternativeId = raw.selectedAlternativeId || raw.SelectedAlternativeID
        ? assertId(raw.selectedAlternativeId || raw.SelectedAlternativeID, 'معرّف البديل')
        : null;
      let alternative = null;
      if (alternativeId) {
        const altResult = await transaction.request()
          .input('alternativeId', sql.Int, alternativeId)
          .input('productId', sql.Int, productId)
          .query(`
            SELECT AlternativeID, ProductID, AlternativeName,
                   PurchasePriceCClass, PurchasePricePremium, PurchasePriceElite,
                   Period, Status, IsPrimary
            FROM ProductFactoryAlternatives
            WHERE AlternativeID = @alternativeId AND ProductID = @productId
              AND ISNULL(Status,'') <> 'Rejected'
          `);
        alternative = altResult.recordset[0] || null;
        if (!alternative) {
          throw Object.assign(new Error('البديل المحدد لا يخص المنتج أو غير نشط'), { statusCode: 400 });
        }
      }
      const suggested = calculateSuggestedPrice(product, alternative, tier);
      const submitted = raw.unitPrice ?? raw.UnitPrice;
      const unitPrice = submitted == null || submitted === ''
        ? suggested
        : money(submitted);
      if (unitPrice < 0) {
        throw Object.assign(new Error('سعر الشراء لا يمكن أن يكون سالبًا'), { statusCode: 400 });
      }
      normalizedItems.push({
        productId,
        productName: product.ProductName,
        quantity: Math.round(quantity * 1000) / 1000,
        unitPrice,
        tier,
        alternativeId,
        notes: String(raw.notes || raw.Notes || '').trim() || null,
        period: Number(alternative?.Period ?? product.Period ?? 0),
      });
    }

    const charges = (Array.isArray(data.charges) ? data.charges : [])
      .map((raw) => ({
        description: String(raw.description || raw.chargeDescription || '').trim(),
        amount: money(raw.amount ?? raw.chargeAmount),
        type: String(raw.chargeType || 'Other').trim() || 'Other',
        notes: String(raw.notes || '').trim() || null,
      }))
      .filter((charge) => charge.description && charge.amount > 0);

    const totalAmount = money(normalizedItems.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0,
    ));
    const requestedDiscountAmount = money(data.discountAmount);
    const requestedDiscountPct = Number(data.discountPercentage || 0);
    let discountAmount = requestedDiscountAmount;
    let discountPercentage = 0;
    if (discountAmount > 0) {
      discountAmount = Math.min(discountAmount, totalAmount);
      discountPercentage = totalAmount > 0
        ? Math.round((discountAmount / totalAmount) * 10000) / 100
        : 0;
    } else if (Number.isFinite(requestedDiscountPct) && requestedDiscountPct > 0) {
      discountPercentage = Math.min(requestedDiscountPct, 100);
      discountAmount = money(totalAmount * discountPercentage / 100);
    }
    const netTotal = money(totalAmount - discountAmount);
    const totalCharges = money(charges.reduce((sum, charge) => sum + charge.amount, 0));
    const grandTotal = money(netTotal + totalCharges);
    if (paidAmount > grandTotal) {
      throw Object.assign(new Error('المبلغ المدفوع أكبر من إجمالي الفاتورة'), { statusCode: 400 });
    }
    const cashBoxId = paidAmount > 0
      ? assertId(data.cashBoxId, 'معرّف الخزينة')
      : null;
    if (cashBoxId) {
      const cashboxResult = await transaction.request()
        .input('cashBoxId', sql.Int, cashBoxId)
        .query(`SELECT CashBoxID FROM CashBoxes WHERE CashBoxID = @cashBoxId AND ISNULL(IsActive, 1) = 1`);
      if (!cashboxResult.recordset[0]) {
        throw Object.assign(new Error('الخزينة غير موجودة أو غير نشطة'), { statusCode: 400 });
      }
    }

    const reference = String(data.referenceNumber || '').trim()
      || await generateReference(transaction);
    const duplicateResult = await transaction.request()
      .input('reference', sql.NVarChar(50), reference)
      .query(`
        SELECT TOP 1 TransactionID FROM Transactions
        WHERE TransactionType = 'Purchase' AND ReferenceNumber = @reference
      `);
    if (duplicateResult.recordset[0]) {
      throw Object.assign(new Error(`رقم فاتورة الشراء ${reference} مستخدم بالفعل`), { statusCode: 409 });
    }
    const transactionDate = data.transactionDate ? new Date(data.transactionDate) : new Date();
    const dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (Number.isNaN(transactionDate.getTime()) || (dueDate && Number.isNaN(dueDate.getTime()))) {
      throw Object.assign(new Error('تاريخ الفاتورة أو موعد الاستلام غير صالح'), { statusCode: 400 });
    }
    const invoiceStatus = grandTotal > 0 && paidAmount >= grandTotal
      ? 'Paid'
      : paidAmount > 0
        ? 'PartiallyPaid'
        : 'Open';

    const headerResult = await transaction.request()
      .input('transactionDate', sql.DateTime, transactionDate)
      .input('supplierId', sql.Int, supplier.PartyID)
      .input('warehouseId', sql.Int, warehouseId)
      .input('linkedCustomerId', sql.Int, linkedCustomerId)
      .input('reference', sql.NVarChar(50), reference)
      .input('dueDate', sql.DateTime, dueDate)
      .input('totalAmount', sql.Decimal(18, 2), totalAmount)
      .input('discountPercentage', sql.Decimal(5, 2), discountPercentage)
      .input('discountAmount', sql.Decimal(18, 2), discountAmount)
      .input('netTotal', sql.Decimal(18, 2), netTotal)
      .input('charges', sql.Decimal(18, 2), totalCharges)
      .input('grandTotal', sql.Decimal(18, 2), grandTotal)
      .input('paidAmount', sql.Decimal(18, 2), paidAmount)
      .input('paymentMethod', sql.NVarChar(20), String(data.paymentMethod || 'Credit'))
      .input('notes', sql.NVarChar(255), String(data.notes || '').trim() || null)
      .input('status', sql.NVarChar(50), invoiceStatus)
      .input('username', sql.NVarChar(100), auth.username)
      .query(`
        DECLARE @InsertedTransactions TABLE (TransactionID int NOT NULL);
        INSERT INTO Transactions
          (TransactionDate, PartyID, TransactionType, WarehouseID, EmpId,
           ReferenceNumber, ReferenceType, DueDate,
           TotalAmount, DiscountPercentage, DiscountAmount, NetTotalAmount,
           TotalChargesAmount, GrandTotal, PaidAmount, PaymentMethod,
           Notes, InvoiceStatus, IsDelivered, CreatedBy, CreatedAt)
        OUTPUT INSERTED.TransactionID INTO @InsertedTransactions (TransactionID)
        VALUES
          (@transactionDate, @supplierId, 'Purchase', @warehouseId, @linkedCustomerId,
           @reference, 'PurchaseInvoice', @dueDate,
           @totalAmount, @discountPercentage, @discountAmount, @netTotal,
           @charges, @grandTotal, @paidAmount, @paymentMethod,
           @notes, @status, 0, @username, GETDATE());
        SELECT TransactionID FROM @InsertedTransactions;
      `);
    const transactionId = Number(headerResult.recordset[0].TransactionID);

    for (const item of normalizedItems) {
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('productId', sql.Int, item.productId)
        .input('quantity', sql.Decimal(18, 3), item.quantity)
        .input('unitPrice', sql.Decimal(18, 2), item.unitPrice)
        .input('alternativeId', sql.Int, item.alternativeId)
        .input('tier', sql.NVarChar(50), item.tier)
        .input('notes', sql.NVarChar(255), item.notes)
        .query(`
          INSERT INTO TransactionDetails
            (TransactionID, ProductID, Quantity, UnitPrice,
             SelectedAlternativeID, PricingTier, Notes)
          VALUES
            (@transactionId, @productId, @quantity, @unitPrice,
             @alternativeId, @tier, @notes)
        `);
    }
    for (const charge of charges) {
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('partyId', sql.Int, supplier.PartyID)
        .input('type', sql.NVarChar(50), charge.type)
        .input('description', sql.NVarChar(255), charge.description)
        .input('amount', sql.Decimal(18, 2), charge.amount)
        .input('notes', sql.NVarChar(255), charge.notes)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          INSERT INTO AdditionalCharges
            (TransactionID, PartyID, ChargeType, ChargeDescription,
             ChargeAmount, Status, AppliedToTransactionId,
             Notes, CreatedBy, CreatedAt)
          VALUES
            (@transactionId, @partyId, @type, @description,
             @amount, N'Applied', @transactionId,
             @notes, @username, GETDATE())
        `);
    }

    let paymentId = null;
    if (paidAmount > 0) {
      const paymentResult = await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), paidAmount)
        .input('method', sql.NVarChar(50), String(data.paymentMethod || 'Cash'))
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          DECLARE @InsertedPayments TABLE (PaymentID int NOT NULL);
          INSERT INTO Payments
            (TransactionID, PaymentDate, Amount, PaymentMethod,
             Notes, CreatedBy, CreatedAt)
          OUTPUT INSERTED.PaymentID INTO @InsertedPayments (PaymentID)
          VALUES
            (@transactionId, GETDATE(), @amount, @method,
             N'دفعة عند إنشاء فاتورة شراء المصنع', @username, GETDATE());
          SELECT PaymentID FROM @InsertedPayments;
        `);
      paymentId = Number(paymentResult.recordset[0].PaymentID);
      const cashResult = await transaction.request()
        .input('cashBoxId', sql.Int, cashBoxId)
        .input('paymentId', sql.Int, paymentId)
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), paidAmount)
        .input('reference', sql.NVarChar(50), reference)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          DECLARE @InsertedCash TABLE (CashboxTransactionID int NOT NULL);
          INSERT INTO CashboxTransactions
            (CashBoxID, PaymentID, ReferenceID, ReferenceType,
             TransactionType, Amount, TransactionDate, Notes,
             CreatedBy, CreatedAt)
          OUTPUT INSERTED.CashboxTransactionID INTO @InsertedCash (CashboxTransactionID)
          VALUES
            (@cashBoxId, @paymentId, @transactionId, N'PurchaseInvoice',
             N'صرف', @amount, GETDATE(),
             CONCAT(N'سداد فاتورة شراء ', @reference), @username, GETDATE());
          SELECT CashboxTransactionID FROM @InsertedCash;
        `);
      const cashboxTransactionId = Number(cashResult.recordset[0].CashboxTransactionID);
      await transaction.request()
        .input('paymentId', sql.Int, paymentId)
        .input('cashId', sql.Int, cashboxTransactionId)
        .query(`UPDATE Payments SET CashboxTransactionID = @cashId WHERE PaymentID = @paymentId`);
    }

    await writeAudit(transaction, 'Insert', transactionId, auth.username, null, {
      TransactionID: transactionId,
      ReferenceNumber: reference,
      ReferenceType: 'PurchaseInvoice',
      SupplierID: supplier.PartyID,
      LinkedCustomerID: linkedCustomerId,
      WarehouseID: warehouseId,
      DueDate: dueDate,
      ItemsCount: normalizedItems.length,
      TotalQuantity: normalizedItems.reduce((sum, item) => sum + item.quantity, 0),
      TotalAmount: totalAmount,
      GrandTotal: grandTotal,
      PaidAmount: paidAmount,
      PaymentID: paymentId,
      StockChanged: false,
    });

    await transaction.commit();
    return {
      transactionId,
      jobOrderId: transactionId,
      referenceNumber: reference,
      supplierId: supplier.PartyID,
      supplierName: supplier.PartyName,
      linkedCustomerId,
      linkedCustomerName: linkedCustomer?.PartyName || null,
      warehouseId,
      warehouseName: warehouseResult.recordset[0].WarehouseName,
      dueDate,
      itemCount: normalizedItems.length,
      maxPeriodDays: Math.max(...normalizedItems.map((item) => item.period || 0), 0),
      grandTotal,
      paidAmount,
      invoiceStatus,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function cancelFactoryPurchase(value, reason, auth) {
  const id = assertId(value, 'معرّف فاتورة الشراء');
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw Object.assign(new Error('سبب الإلغاء مطلوب'), { statusCode: 400 });
  }
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const headerResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT * FROM Transactions WITH (UPDLOCK, HOLDLOCK)
        WHERE TransactionID = @id
      `);
    const header = headerResult.recordset[0];
    if (!header || header.TransactionType !== 'Purchase'
        || header.ReferenceType !== 'PurchaseInvoice') {
      throw Object.assign(new Error('فاتورة شراء المصنع غير موجودة'), { statusCode: 404 });
    }
    if (header.InvoiceStatus === 'Cancelled') {
      throw Object.assign(new Error('الفاتورة ملغية بالفعل'), { statusCode: 409 });
    }
    const detailsResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT d.ProductID, d.Quantity, d.UnitPrice, p.ProductName
        FROM TransactionDetails d WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN Products p ON d.ProductID = p.ProductID
        WHERE d.TransactionID = @id
      `);

    if (header.IsDelivered === true || header.IsDelivered === 1) {
      const shortages = [];
      for (const item of detailsResult.recordset) {
        const quantity = Math.round(Number(item.Quantity || 0));
        const stockResult = await transaction.request()
          .input('productId', sql.Int, item.ProductID)
          .input('warehouseId', sql.Int, header.WarehouseID)
          .query(`
            SELECT Quantity FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
            WHERE ProductID = @productId AND WarehouseID = @warehouseId
          `);
        const available = Number(stockResult.recordset[0]?.Quantity || 0);
        if (available < quantity) {
          shortages.push(`${item.ProductName}: المتاح ${available} والمطلوب عكسه ${quantity}`);
        }
      }
      if (shortages.length) {
        throw Object.assign(
          new Error(`لا يمكن إلغاء الاستلام لأن جزءًا من المخزون تم استخدامه: ${shortages.join(' | ')}`),
          { statusCode: 409, code: 'PURCHASE_CANCEL_STOCK_SHORTAGE' },
        );
      }
      for (const item of detailsResult.recordset) {
        const quantity = Math.round(Number(item.Quantity || 0));
        if (quantity <= 0) continue;
        const unitPrice = money(item.UnitPrice);
        await transaction.request()
          .input('productId', sql.Int, item.ProductID)
          .input('warehouseId', sql.Int, header.WarehouseID)
          .input('quantity', sql.Int, quantity)
          .query(`
            UPDATE StockLevels
            SET Quantity = Quantity - @quantity, LastUpdatedAt = GETDATE()
            WHERE ProductID = @productId AND WarehouseID = @warehouseId
          `);
        await transaction.request()
          .input('productId', sql.Int, item.ProductID)
          .input('warehouseId', sql.Int, header.WarehouseID)
          .input('quantity', sql.Int, quantity)
          .input('referenceId', sql.Int, id)
          .input('unitPrice', sql.Decimal(18, 2), unitPrice)
          .input('total', sql.Decimal(18, 2), money(quantity * unitPrice))
          .input('username', sql.NVarChar(100), auth.username)
          .input('notes', sql.NVarChar(500), `إلغاء استلام فاتورة شراء: ${cleanReason}`)
          .query(`
            INSERT INTO StockTransactions
              (ProductID, WarehouseID, TransactionType, Quantity, TransactionDate,
               ReferenceID, ReferenceType, UnitPrice, TotalAmount,
               Notes, CreatedBy, CreatedAt)
            VALUES
              (@productId, @warehouseId, N'Out', @quantity, GETDATE(),
               @referenceId, N'PurchaseInvoiceCancel', @unitPrice, @total,
               @notes, @username, GETDATE())
          `);
      }
    }

    await transaction.request()
      .input('id', sql.Int, id)
      .input('reason', sql.NVarChar(500), cleanReason)
      .input('username', sql.NVarChar(100), auth.username)
      .query(`
        UPDATE Transactions
        SET InvoiceStatus = N'Cancelled',
            IsDelivered = 0,
            EditReason = @reason,
            EditBy = @username,
            EditAt = GETDATE()
        WHERE TransactionID = @id
      `);
    await writeAudit(transaction, 'Cancel', id, auth.username, {
      InvoiceStatus: header.InvoiceStatus,
      IsDelivered: header.IsDelivered,
      DeliveredAt: header.DeliveredAt,
    }, {
      InvoiceStatus: 'Cancelled',
      Reason: cleanReason,
      StockReversed: header.IsDelivered === true || header.IsDelivered === 1,
    });
    await transaction.commit();
    return {
      transactionId: id,
      referenceNumber: header.ReferenceNumber,
      stockReversed: header.IsDelivered === true || header.IsDelivered === 1,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

module.exports = {
  getFactoryPurchases,
  getFactoryPurchaseStats,
  getLookups,
  searchLinkedCustomers,
  searchShowroomProducts,
  getProductAlternatives,
  createFactoryPurchase,
  cancelFactoryPurchase,
};
