const { sql, connectDB } = require('../../core/database');
const policy = require('../../shared/authorization.policy');

const TIERS = new Set(['CClass', 'Premium', 'Elite']);
const STATUSES = new Set(['Draft', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Expired']);
const TRANSITIONS = {
  Draft: new Set(['Sent', 'Accepted', 'Rejected', 'Expired']),
  Sent: new Set(['Accepted', 'Rejected', 'Expired']),
  Accepted: new Set(['Converted', 'Rejected', 'Expired']),
  Rejected: new Set(['Draft']),
  Expired: new Set(['Draft']),
  Converted: new Set(),
};

const intValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};
const numberValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const money = (value) => Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

function normalizeTier(value) {
  const tier = String(value || 'Premium');
  return TIERS.has(tier) ? tier : 'Premium';
}

function buildWhere(request, filters = {}, options = {}) {
  const clauses = ['1=1'];
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    clauses.push(`(
      p.PartyName LIKE @search OR p.Phone LIKE @search
      OR q.Notes LIKE @search OR q.ReferenceNumber LIKE @search
      OR CAST(q.QuotationID AS NVARCHAR(30)) LIKE @search
    )`);
  }
  if (filters.partyId) {
    request.input('partyId', sql.Int, intValue(filters.partyId));
    clauses.push('q.PartyID = @partyId');
  }
  if (filters.employeeId) {
    request.input('employeeId', sql.Int, intValue(filters.employeeId));
    clauses.push('q.EmpId = @employeeId');
  }
  if (filters.startDate) {
    request.input('startDate', sql.Date, filters.startDate);
    clauses.push('CAST(q.QuotationDate AS DATE) >= @startDate');
  }
  if (filters.endDate) {
    request.input('endDate', sql.Date, filters.endDate);
    clauses.push('CAST(q.QuotationDate AS DATE) <= @endDate');
  }
  if (filters.status) {
    request.input('status', sql.NVarChar(50), String(filters.status));
    clauses.push('q.Status = @status');
  }
  if (filters.converted === true || filters.converted === 'true') {
    clauses.push('q.InvoiceID IS NOT NULL');
  } else if (filters.converted === false || filters.converted === 'false') {
    clauses.push('q.InvoiceID IS NULL');
  }
  if (filters.pendingOnly === true || filters.pendingOnly === 'true') {
    clauses.push(`q.InvoiceID IS NULL AND ISNULL(q.Status, 'Draft') IN ('Draft', 'Sent')`);
  }
  if (filters.expired === true || filters.expired === 'true') {
    clauses.push(`
      q.InvoiceID IS NULL AND q.ValidUntil IS NOT NULL
      AND CAST(q.ValidUntil AS DATE) < CAST(GETDATE() AS DATE)
      AND ISNULL(q.Status, 'Draft') IN ('Draft', 'Sent')
    `);
  }
  if (options.excludeProtectedAccountManager) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM Users protectedCreator
      WHERE protectedCreator.Username = q.CreatedBy
        AND protectedCreator.Role = N'AccountManager'
    )`);
  }
  if (options.costOnlyViewer) clauses.push('q.InvoiceID IS NULL');
  return clauses.map((clause) => `(${clause})`).join(' AND ');
}

async function getQuotations(filters = {}, auth) {
  const pool = await connectDB();
  const request = pool.request();
  const costOnlyViewer = policy.quotations.isCostOnlyViewer(auth);
  const where = buildWhere(request, filters, {
    costOnlyViewer,
    excludeProtectedAccountManager:
      !costOnlyViewer && !policy.quotations.canViewProtectedAccountManager(auth),
  });
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 25), 1), 100);
  const offset = (page - 1) * limit;
  const sort = filters.sortBy === 'GrandTotal' ? 'q.GrandTotal' : 'q.QuotationDate';
  const direction = String(filters.sortDirection || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const result = await request.query(`
    SELECT
      q.QuotationID, q.ReferenceNumber, q.QuotationDate, q.ValidUntil,
      q.PartyID, p.PartyName, p.Phone AS PartyPhone,
      q.WarehouseID, w.WarehouseName,
      q.OpportunityID, q.EmpId, e.FullName AS EmpName,
      q.[pricingType] AS PricingType, q.TotalAmount, q.DiscountAmount, q.GrandTotal,
      ISNULL(q.Status, 'Draft') AS Status, q.InvoiceID,
      inv.ReferenceNumber AS InvoiceReference,
      q.CreatedBy, q.CreatedAt, q.RejectionReason,
      ISNULL(summaryData.ItemsCount, 0) AS ItemsCount,
      summaryData.MaxManufacturingDays,
      summaryData.TotalCost,
      COUNT(*) OVER() AS TotalRows
    FROM Quotations q
    INNER JOIN Parties p ON q.PartyID = p.PartyID
    LEFT JOIN Warehouses w ON q.WarehouseID = w.WarehouseID
    LEFT JOIN Employees e ON q.EmpId = e.EmployeeID
    LEFT JOIN Transactions inv ON q.InvoiceID = inv.TransactionID
    OUTER APPLY (
      SELECT
        COUNT(*) AS ItemsCount,
        MAX(COALESCE(alt.Period, product.Period, 0)) AS MaxManufacturingDays,
        SUM(qd.Quantity * CASE
          WHEN qd.SelectedAlternativeID IS NOT NULL AND ISNULL(qd.PricingTier, 'Premium') = 'CClass'
            THEN ISNULL(alt.PurchasePriceCClass, 0)
          WHEN qd.SelectedAlternativeID IS NOT NULL AND ISNULL(qd.PricingTier, 'Premium') = 'Elite'
            THEN COALESCE(alt.PurchasePriceElite, alt.PurchasePricePremium, 0)
          WHEN qd.SelectedAlternativeID IS NOT NULL
            THEN ISNULL(alt.PurchasePricePremium, 0)
          WHEN ISNULL(qd.PricingTier, 'Premium') = 'CClass'
            THEN ISNULL(product.PurchasePriceCClass, 0)
          WHEN ISNULL(qd.PricingTier, 'Premium') = 'Elite'
            THEN COALESCE(product.PurchasePriceElite, product.PurchasePrice, 0)
          ELSE ISNULL(product.PurchasePrice, 0)
        END) AS TotalCost
      FROM QuotationDetails qd
      INNER JOIN Products product ON qd.ProductID = product.ProductID
      LEFT JOIN ProductFactoryAlternatives alt
        ON qd.SelectedAlternativeID = alt.AlternativeID
      WHERE qd.QuotationID = q.QuotationID
    ) summaryData
    WHERE ${where}
    ORDER BY ${sort} ${direction}, q.QuotationID ${direction}
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `);

  const rows = result.recordset;
  return {
    rows,
    page,
    limit,
    total: rows.length ? Number(rows[0].TotalRows || 0) : 0,
  };
}

async function getQuotationStats(filters = {}, auth) {
  const pool = await connectDB();
  const request = pool.request();
  const costOnlyViewer = policy.quotations.isCostOnlyViewer(auth);
  const where = buildWhere(request, filters, {
    costOnlyViewer,
    excludeProtectedAccountManager:
      !costOnlyViewer && !policy.quotations.canViewProtectedAccountManager(auth),
  });
  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      COUNT(DISTINCT q.PartyID) AS DistinctCustomersCount,
      ISNULL(SUM(q.GrandTotal), 0) AS TotalValue,
      SUM(CASE WHEN ISNULL(q.Status, 'Draft') = 'Draft' THEN 1 ELSE 0 END) AS DraftCount,
      SUM(CASE WHEN q.Status = 'Sent' THEN 1 ELSE 0 END) AS SentCount,
      SUM(CASE WHEN q.Status = 'Accepted' THEN 1 ELSE 0 END) AS AcceptedCount,
      SUM(CASE WHEN q.Status = 'Rejected' THEN 1 ELSE 0 END) AS RejectedCount,
      SUM(CASE WHEN q.InvoiceID IS NOT NULL OR q.Status = 'Converted' THEN 1 ELSE 0 END) AS ConvertedCount,
      SUM(CASE WHEN q.ValidUntil IS NOT NULL
        AND CAST(q.ValidUntil AS DATE) < CAST(GETDATE() AS DATE)
        AND q.InvoiceID IS NULL
        AND ISNULL(q.Status, 'Draft') IN ('Draft', 'Sent') THEN 1 ELSE 0 END) AS ExpiredCount,
      ISNULL(SUM(CASE WHEN q.InvoiceID IS NOT NULL THEN q.GrandTotal ELSE 0 END), 0) AS ConvertedValue,
      COUNT(DISTINCT CASE WHEN q.InvoiceID IS NOT NULL THEN q.PartyID END) AS ConvertedCustomersCount,
      SUM(CASE WHEN q.InvoiceID IS NOT NULL OR ISNULL(q.Status, 'Draft') <> 'Draft' THEN 1 ELSE 0 END) AS SentBaseCount
    FROM Quotations q
    INNER JOIN Parties p ON q.PartyID = p.PartyID
    WHERE ${where}
  `);
  const row = result.recordset[0] || {};
  const total = Number(row.TotalCount || 0);
  const customers = Number(row.DistinctCustomersCount || 0);
  const converted = Number(row.ConvertedCount || 0);
  const convertedCustomers = Number(row.ConvertedCustomersCount || 0);
  const sentBase = Number(row.SentBaseCount || 0);
  const convertedValue = Number(row.ConvertedValue || 0);
  return {
    ...row,
    ConversionRate: total ? money(converted / total * 100) : 0,
    CustomerConversionRate: customers ? money(convertedCustomers / customers * 100) : 0,
    SentConversionRate: sentBase ? money(converted / sentBase * 100) : 0,
    AvgConvertedCustomerValue: convertedCustomers
      ? money(convertedValue / convertedCustomers)
      : 0,
  };
}

async function getQuotationById(id) {
  const pool = await connectDB();
  const headerResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        q.*, q.[pricingType] AS PricingType,
        p.PartyName, p.Phone AS PartyPhone, p.Address AS PartyAddress,
        p.Email AS PartyEmail, p.City AS PartyCity,
        w.WarehouseName, e.FullName AS EmpName,
        inv.ReferenceNumber AS InvoiceReference
      FROM Quotations q
      INNER JOIN Parties p ON q.PartyID = p.PartyID
      LEFT JOIN Warehouses w ON q.WarehouseID = w.WarehouseID
      LEFT JOIN Employees e ON q.EmpId = e.EmployeeID
      LEFT JOIN Transactions inv ON q.InvoiceID = inv.TransactionID
      WHERE q.QuotationID = @id
    `);
  const header = headerResult.recordset[0];
  if (!header) return null;

  const detailsResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        qd.QuotationDetailID, qd.ProductID, qd.Quantity,
        qd.UnitPrice, qd.TotalAmount, qd.Notes, qd.PricingTier,
        qd.SelectedAlternativeID,
        p.ProductName, p.ProductDescription, p.Customer,
        p.SuggestedSalePriceCClass, p.SuggestedSalePrice,
        p.SuggestedSalePriceElite,
        p.PurchasePriceCClass, p.PurchasePrice, p.PurchasePriceElite,
        p.Period,
        alt.AlternativeName, alt.SpecificationSummary,
        alt.SuggestedSalePriceCClass AS AlternativeSalePriceCClass,
        alt.SuggestedSalePricePremium AS AlternativeSalePricePremium,
        alt.SuggestedSalePriceElite AS AlternativeSalePriceElite,
        alt.PurchasePriceCClass AS AlternativePurchasePriceCClass,
        alt.PurchasePricePremium AS AlternativePurchasePricePremium,
        alt.PurchasePriceElite AS AlternativePurchasePriceElite,
        alt.Period AS AlternativePeriod,
        imageData.MainImageId
      FROM QuotationDetails qd
      INNER JOIN Products p ON qd.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives alt
        ON qd.SelectedAlternativeID = alt.AlternativeID
      OUTER APPLY (
        SELECT TOP 1 ProductImagesID AS MainImageId
        FROM ProductImages pi
        WHERE pi.ProductID = p.ProductID
        ORDER BY pi.CreatedAt DESC, pi.ProductImagesID DESC
      ) imageData
      WHERE qd.QuotationID = @id
      ORDER BY qd.QuotationDetailID
    `);

  const chargesResult = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT ChargeID, ChargeDescription, ChargeAmount, ChargeType, Notes
      FROM AdditionalCharges
      WHERE QuotationID = @id
      ORDER BY ChargeID
    `);

  const advancesResult = await pool.request()
    .input('partyId', sql.Int, header.PartyID)
    .query(`
      SELECT ChargeID, PartyID, ChargeType, ChargeDescription,
             ChargeAmount, Notes, CreatedBy, CreatedAt
      FROM AdditionalCharges
      WHERE PartyID = @partyId AND TransactionID IS NULL
      ORDER BY CreatedAt DESC, ChargeID DESC
    `);

  return {
    ...header,
    details: detailsResult.recordset,
    charges: chargesResult.recordset,
    advances: advancesResult.recordset,
  };
}

async function searchParties(search, limit = 30) {
  const pool = await connectDB();
  const safeSearch = String(search || '').trim();
  const safeLimit = Math.min(Math.max(intValue(limit, 30), 1), 100);
  const result = await pool.request()
    .input('search', sql.NVarChar(200), `%${safeSearch}%`)
    .input('limit', sql.Int, safeLimit)
    .query(`
      SELECT TOP (@limit) PartyID, PartyName, Phone, Phone2, Address, City
      FROM Parties
      WHERE IsActive = 1 AND PartyType = 1
        AND (PartyName LIKE @search OR Phone LIKE @search OR Phone2 LIKE @search)
      ORDER BY PartyName
    `);
  return result.recordset;
}

async function getQuotationLookups(partyId = null, search = '') {
  const pool = await connectDB();
  const [warehouses, parties, opportunities] = await Promise.all([
    pool.request().query(`
      SELECT w.WarehouseID, w.WarehouseName, w.BranchID AS BranchId,
             b.BranchNameAr
      FROM Warehouses w
      LEFT JOIN Branches b ON w.BranchID = b.BranchID
      WHERE w.IsActive = 1
      ORDER BY b.BranchNameAr, w.WarehouseName
    `),
    searchParties(search, 30),
    partyId
      ? pool.request().input('partyId', sql.Int, partyId).query(`
          SELECT o.OpportunityID, o.StageID, s.StageNameAr,
                 o.ExpectedValue, o.EmployeeID, e.FullName AS EmployeeName
          FROM SalesOpportunities o
          LEFT JOIN SalesStages s ON o.StageID = s.StageID
          LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
          WHERE o.PartyID = @partyId AND o.IsActive = 1
          ORDER BY o.CreatedAt DESC
        `)
      : Promise.resolve({ recordset: [] }),
  ]);
  return {
    warehouses: warehouses.recordset,
    parties,
    opportunities: opportunities.recordset,
  };
}

async function getAvailableProducts(partyId, warehouseId = null, search = '') {
  const pool = await connectDB();
  const request = pool.request()
    .input('partyId', sql.Int, partyId)
    .input('search', sql.NVarChar(200), `%${String(search || '').trim()}%`);
  const hasWarehouse = intValue(warehouseId) > 0;
  if (hasWarehouse) request.input('warehouseId', sql.Int, warehouseId);
  const result = await request.query(`
    SELECT
      p.ProductID, p.ProductName, p.ProductDescription, p.Customer,
      p.SuggestedSalePriceCClass, p.SuggestedSalePrice,
      p.SuggestedSalePriceElite,
      p.PurchasePriceCClass, p.PurchasePrice, p.PurchasePriceElite,
      p.Period, pg.GroupName,
      ISNULL(stock.AvailableStock, 0) AS AvailableStock,
      imageData.MainImageId
    FROM Products p
    INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
    OUTER APPLY (
      SELECT SUM(sl.Quantity) AS AvailableStock
      FROM StockLevels sl
      WHERE sl.ProductID = p.ProductID
        ${hasWarehouse ? 'AND sl.WarehouseID = @warehouseId' : ''}
    ) stock
    OUTER APPLY (
      SELECT TOP 1 ProductImagesID AS MainImageId
      FROM ProductImages pi
      WHERE pi.ProductID = p.ProductID
      ORDER BY pi.CreatedAt DESC, pi.ProductImagesID DESC
    ) imageData
    WHERE (p.Customer = @partyId OR p.Customer IS NULL)
      AND (p.ProductName LIKE @search OR p.ProductDescription LIKE @search
           OR CAST(p.ProductID AS NVARCHAR(30)) LIKE @search)
      AND (p.Customer = @partyId OR ISNULL(stock.AvailableStock, 0) > 0)
    ORDER BY CASE WHEN p.Customer = @partyId THEN 0 ELSE 1 END, p.ProductName
  `);
  return result.recordset;
}

async function getProductAlternatives(productId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`
      SELECT AlternativeID, ProductID, AlternativeName, SpecificationSummary,
             Period, PurchasePriceCClass, PurchasePricePremium,
             PurchasePriceElite, SuggestedSalePriceCClass,
             SuggestedSalePricePremium, SuggestedSalePriceElite,
             Status, IsPrimary
      FROM ProductFactoryAlternatives
      WHERE ProductID = @productId
        AND (Status = 'Approved' OR IsPrimary = 1)
      ORDER BY IsPrimary DESC, AlternativeName
    `);
  return result.recordset;
}

function getItemSalePrice(item, product, alternative) {
  const tier = normalizeTier(item.pricingTier);
  if (alternative) {
    if (tier === 'CClass') return numberValue(alternative.SuggestedSalePriceCClass);
    if (tier === 'Elite') return numberValue(alternative.SuggestedSalePriceElite, numberValue(alternative.SuggestedSalePricePremium));
    return numberValue(alternative.SuggestedSalePricePremium);
  }
  if (tier === 'CClass') return numberValue(product.SuggestedSalePriceCClass);
  if (tier === 'Elite') return numberValue(product.SuggestedSalePriceElite, numberValue(product.SuggestedSalePrice));
  return numberValue(product.SuggestedSalePrice);
}

function getItemCost(item, product, alternative) {
  const tier = normalizeTier(item.pricingTier);
  if (alternative) {
    if (tier === 'CClass') return numberValue(alternative.PurchasePriceCClass);
    if (tier === 'Elite') return numberValue(alternative.PurchasePriceElite, numberValue(alternative.PurchasePricePremium));
    return numberValue(alternative.PurchasePricePremium);
  }
  if (tier === 'CClass') return numberValue(product.PurchasePriceCClass);
  if (tier === 'Elite') return numberValue(product.PurchasePriceElite, numberValue(product.PurchasePrice));
  return numberValue(product.PurchasePrice);
}

async function loadProductMaps(transaction, items) {
  const productIds = [...new Set(items.map((item) => intValue(item.productId)).filter((id) => id > 0))];
  if (!productIds.length) throw Object.assign(new Error('يجب إضافة صنف واحد على الأقل'), { statusCode: 400 });
  const request = transaction.request();
  const params = productIds.map((id, index) => {
    request.input(`p${index}`, sql.Int, id);
    return `@p${index}`;
  });
  const productResult = await request.query(`
    SELECT ProductID, ProductName, ProductDescription, Customer,
           SuggestedSalePriceCClass, SuggestedSalePrice, SuggestedSalePriceElite,
           PurchasePriceCClass, PurchasePrice, PurchasePriceElite, Period
    FROM Products WITH (UPDLOCK)
    WHERE ProductID IN (${params.join(',')})
  `);
  if (productResult.recordset.length !== productIds.length) {
    throw Object.assign(new Error('يوجد صنف غير موجود أو محذوف'), { statusCode: 400 });
  }
  const products = new Map(productResult.recordset.map((row) => [Number(row.ProductID), row]));

  const alternativeIds = [...new Set(items
    .map((item) => intValue(item.selectedAlternativeId))
    .filter((id) => id > 0))];
  const alternatives = new Map();
  if (alternativeIds.length) {
    const altRequest = transaction.request();
    const altParams = alternativeIds.map((id, index) => {
      altRequest.input(`a${index}`, sql.Int, id);
      return `@a${index}`;
    });
    const altResult = await altRequest.query(`
      SELECT AlternativeID, ProductID, AlternativeName, SpecificationSummary,
             Period, PurchasePriceCClass, PurchasePricePremium,
             PurchasePriceElite, SuggestedSalePriceCClass,
             SuggestedSalePricePremium, SuggestedSalePriceElite,
             Status, IsPrimary
      FROM ProductFactoryAlternatives WITH (UPDLOCK)
      WHERE AlternativeID IN (${altParams.join(',')})
    `);
    for (const row of altResult.recordset) alternatives.set(Number(row.AlternativeID), row);
  }

  for (const item of items) {
    const product = products.get(intValue(item.productId));
    const altId = intValue(item.selectedAlternativeId);
    if (!altId) continue;
    const alternative = alternatives.get(altId);
    if (!alternative || Number(alternative.ProductID) !== Number(product.ProductID)) {
      throw Object.assign(new Error(`البديل المختار لا يخص المنتج ${product.ProductName}`), { statusCode: 400 });
    }
    if (alternative.Status !== 'Approved' && !alternative.IsPrimary) {
      throw Object.assign(new Error(`البديل ${alternative.AlternativeName} غير معتمد`), { statusCode: 400 });
    }
  }
  return { products, alternatives };
}

function normalizeItems(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : []).map((raw) => ({
    quotationDetailId: intValue(raw.quotationDetailId ?? raw.QuotationDetailID),
    productId: intValue(raw.productId ?? raw.ProductID),
    quantity: numberValue(raw.quantity ?? raw.Quantity),
    unitPrice: numberValue(raw.unitPrice ?? raw.UnitPrice),
    notes: String(raw.notes ?? raw.Notes ?? '').trim(),
    pricingTier: normalizeTier(raw.pricingTier ?? raw.PricingTier),
    selectedAlternativeId: intValue(raw.selectedAlternativeId ?? raw.SelectedAlternativeID) || null,
  }));
}

function validateQuotationPayload(data, items) {
  if (!intValue(data.partyId)) throw Object.assign(new Error('يرجى اختيار العميل'), { statusCode: 400 });
  if (!items.length) throw Object.assign(new Error('يجب إضافة صنف واحد على الأقل'), { statusCode: 400 });
  if (items.some((item) => !item.productId)) throw Object.assign(new Error('يوجد صنف غير صالح'), { statusCode: 400 });
  if (items.some((item) => item.quantity <= 0)) throw Object.assign(new Error('الكمية يجب أن تكون أكبر من صفر'), { statusCode: 400 });
  if (items.some((item) => item.unitPrice < 0)) throw Object.assign(new Error('السعر لا يمكن أن يكون سالباً'), { statusCode: 400 });
  const quotationDate = data.quotationDate ? new Date(data.quotationDate) : new Date();
  const validUntil = data.validUntil ? new Date(data.validUntil) : null;
  if (Number.isNaN(quotationDate.getTime())) throw Object.assign(new Error('تاريخ العرض غير صحيح'), { statusCode: 400 });
  if (validUntil && (Number.isNaN(validUntil.getTime()) || validUntil < new Date(quotationDate.toDateString()))) {
    throw Object.assign(new Error('تاريخ الصلاحية يجب أن يكون بعد تاريخ العرض'), { statusCode: 400 });
  }
  return { quotationDate, validUntil };
}

function calculateQuotationTotals(data, items, products, alternatives, auth) {
  const totalAmount = money(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  let discountAmount = data.discountAmount != null
    ? numberValue(data.discountAmount)
    : totalAmount * numberValue(data.discountPercentage) / 100;
  discountAmount = money(Math.round(Math.max(discountAmount, 0) / 100) * 100);
  const baseTotal = money(items.reduce((sum, item) => {
    const product = products.get(item.productId);
    const alternative = item.selectedAlternativeId
      ? alternatives.get(item.selectedAlternativeId)
      : null;
    return sum + item.quantity * getItemSalePrice(item, product, alternative);
  }, 0));
  const increaseCap = Math.max(0, money(totalAmount - baseTotal));
  let allowedDiscount = increaseCap;
  if (policy.roles.admin(auth) || policy.roles.accountManager(auth)) {
    allowedDiscount = totalAmount;
  } else if (policy.roles.salesManager(auth)) {
    allowedDiscount = Math.min(totalAmount, increaseCap + baseTotal * 0.10);
  }
  if (discountAmount > allowedDiscount + 0.001) {
    throw Object.assign(new Error(
      policy.roles.salesManager(auth)
        ? `حد الخصم المتاح لمدير المبيعات هو ${money(allowedDiscount)} ج`
        : `الخصم المطلوب يحتاج مراجعة الإدارة. المتاح حاليًا ${money(allowedDiscount)} ج`,
    ), { statusCode: 403, code: 'DISCOUNT_APPROVAL_REQUIRED', allowedDiscount: money(allowedDiscount) });
  }
  if (discountAmount > totalAmount) {
    throw Object.assign(new Error('الخصم لا يمكن أن يتجاوز إجمالي العرض'), { statusCode: 400 });
  }
  return {
    totalAmount,
    discountAmount,
    discountPercentage: totalAmount ? money(discountAmount / totalAmount * 100) : 0,
    grandTotal: money(totalAmount - discountAmount),
    baseTotal,
    allowedDiscount: money(allowedDiscount),
  };
}

async function writeAudit(
  transaction,
  actionType,
  quotationId,
  oldData,
  newData,
  username,
  tableName = 'Quotations',
) {
  await transaction.request()
    .input('tableName', sql.NVarChar(128), tableName)
    .input('actionType', sql.NVarChar(50), String(actionType).slice(0, 10))
    .input('key', sql.NVarChar(100), String(quotationId))
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (@tableName, @actionType, @key, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function saveQuotation(id, data, auth) {
  const items = normalizeItems(data.items ?? data.details);
  const dates = validateQuotationPayload(data, items);
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const { products, alternatives } = await loadProductMaps(transaction, items);
    const totals = calculateQuotationTotals(data, items, products, alternatives, auth);
    let quotationId = intValue(id);
    let oldHeader = null;
    let status = String(data.status || 'Draft');
    if (!STATUSES.has(status)) status = 'Draft';

    if (quotationId > 0) {
      const currentResult = await transaction.request()
        .input('id', sql.Int, quotationId)
        .query(`SELECT * FROM Quotations WITH (UPDLOCK, HOLDLOCK) WHERE QuotationID = @id`);
      oldHeader = currentResult.recordset[0];
      if (!oldHeader) throw Object.assign(new Error('عرض السعر غير موجود'), { statusCode: 404 });
      if (oldHeader.InvoiceID != null) throw Object.assign(new Error('لا يمكن تعديل عرض تم تحويله لفاتورة'), { statusCode: 400 });

      await transaction.request()
        .input('id', sql.Int, quotationId)
        .input('date', sql.DateTime, dates.quotationDate)
        .input('validUntil', sql.DateTime, dates.validUntil)
        .input('partyId', sql.Int, intValue(data.partyId))
        .input('warehouseId', sql.Int, intValue(data.warehouseId) || null)
        .input('opportunityId', sql.Int, intValue(data.opportunityId) || null)
        .input('empId', sql.Int, intValue(data.employeeId ?? data.empId) || auth.employeeId || null)
        .input('pricingType', sql.NVarChar(50), resolvePricingType(items))
        .input('total', sql.Decimal(18, 2), totals.totalAmount)
        .input('discount', sql.Decimal(18, 2), totals.discountAmount)
        .input('grand', sql.Decimal(18, 2), totals.grandTotal)
        .input('notes', sql.NVarChar(500), data.notes || null)
        .input('status', sql.NVarChar(50), status)
        .query(`
          UPDATE Quotations SET
            QuotationDate = @date, ValidUntil = @validUntil,
            PartyID = @partyId, WarehouseID = @warehouseId,
            OpportunityID = @opportunityId, EmpId = @empId,
            [pricingType] = @pricingType, TotalAmount = @total,
            DiscountAmount = @discount, GrandTotal = @grand,
            Notes = @notes, Status = @status
          WHERE QuotationID = @id
        `);
    } else {
      const inserted = await transaction.request()
        .input('date', sql.DateTime, dates.quotationDate)
        .input('validUntil', sql.DateTime, dates.validUntil)
        .input('partyId', sql.Int, intValue(data.partyId))
        .input('warehouseId', sql.Int, intValue(data.warehouseId) || null)
        .input('opportunityId', sql.Int, intValue(data.opportunityId) || null)
        .input('empId', sql.Int, intValue(data.employeeId ?? data.empId) || auth.employeeId || null)
        .input('pricingType', sql.NVarChar(50), resolvePricingType(items))
        .input('total', sql.Decimal(18, 2), totals.totalAmount)
        .input('discount', sql.Decimal(18, 2), totals.discountAmount)
        .input('grand', sql.Decimal(18, 2), totals.grandTotal)
        .input('notes', sql.NVarChar(500), data.notes || null)
        .input('status', sql.NVarChar(50), status)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          INSERT INTO Quotations
            (QuotationDate, ValidUntil, PartyID, WarehouseID, OpportunityID,
             EmpId, [pricingType], TotalAmount, DiscountAmount, GrandTotal,
             Notes, Status, CreatedBy, CreatedAt)
          OUTPUT INSERTED.QuotationID
          VALUES
            (@date, @validUntil, @partyId, @warehouseId, @opportunityId,
             @empId, @pricingType, @total, @discount, @grand,
             @notes, @status, @username, GETDATE())
        `);
      quotationId = Number(inserted.recordset[0].QuotationID);
      const reference = `QT-${dates.quotationDate.getFullYear()}-${String(quotationId).padStart(5, '0')}`;
      await transaction.request()
        .input('id', sql.Int, quotationId)
        .input('reference', sql.NVarChar(100), reference)
        .query('UPDATE Quotations SET ReferenceNumber = @reference WHERE QuotationID = @id');
    }

    const existingResult = await transaction.request()
      .input('id', sql.Int, quotationId)
      .query('SELECT QuotationDetailID FROM QuotationDetails WHERE QuotationID = @id');
    const existingIds = new Set(existingResult.recordset.map((row) => Number(row.QuotationDetailID)));
    const keepIds = new Set();

    for (const item of items) {
      const tier = normalizeTier(item.pricingTier);
      const notes = item.notes ? `[${tier}] ${item.notes}` : `[${tier}]`;
      if (item.quotationDetailId > 0 && existingIds.has(item.quotationDetailId)) {
        keepIds.add(item.quotationDetailId);
        await transaction.request()
          .input('detailId', sql.Int, item.quotationDetailId)
          .input('quotationId', sql.Int, quotationId)
          .input('productId', sql.Int, item.productId)
          .input('quantity', sql.Decimal(18, 2), item.quantity)
          .input('unitPrice', sql.Decimal(18, 2), item.unitPrice)
          .input('alternativeId', sql.Int, item.selectedAlternativeId)
          .input('tier', sql.NVarChar(50), tier)
          .input('notes', sql.NVarChar(255), notes)
          .query(`
            UPDATE QuotationDetails SET
              ProductID = @productId, Quantity = @quantity,
              UnitPrice = @unitPrice, SelectedAlternativeID = @alternativeId,
              PricingTier = @tier, Notes = @notes
            WHERE QuotationDetailID = @detailId AND QuotationID = @quotationId
          `);
      } else {
        const detail = await transaction.request()
          .input('quotationId', sql.Int, quotationId)
          .input('productId', sql.Int, item.productId)
          .input('quantity', sql.Decimal(18, 2), item.quantity)
          .input('unitPrice', sql.Decimal(18, 2), item.unitPrice)
          .input('alternativeId', sql.Int, item.selectedAlternativeId)
          .input('tier', sql.NVarChar(50), tier)
          .input('notes', sql.NVarChar(255), notes)
          .query(`
            INSERT INTO QuotationDetails
              (QuotationID, ProductID, Quantity, UnitPrice,
               SelectedAlternativeID, PricingTier, Notes)
            OUTPUT INSERTED.QuotationDetailID
            VALUES
              (@quotationId, @productId, @quantity, @unitPrice,
               @alternativeId, @tier, @notes)
          `);
        keepIds.add(Number(detail.recordset[0].QuotationDetailID));
      }
    }

    for (const detailId of existingIds) {
      if (keepIds.has(detailId)) continue;
      await transaction.request()
        .input('detailId', sql.Int, detailId)
        .input('quotationId', sql.Int, quotationId)
        .query(`DELETE FROM QuotationDetails WHERE QuotationDetailID = @detailId AND QuotationID = @quotationId`);
    }

    const oldOpportunityId = Number(oldHeader?.OpportunityID || 0);
    const newOpportunityId = intValue(data.opportunityId);
    if (oldOpportunityId && oldOpportunityId !== newOpportunityId) {
      await transaction.request()
        .input('opportunityId', sql.Int, oldOpportunityId)
        .input('quotationId', sql.Int, quotationId)
        .query(`
          UPDATE SalesOpportunities SET QuotationID = NULL
          WHERE OpportunityID = @opportunityId AND QuotationID = @quotationId
        `);
    }
    if (newOpportunityId) {
      await transaction.request()
        .input('opportunityId', sql.Int, newOpportunityId)
        .input('quotationId', sql.Int, quotationId)
        .input('partyId', sql.Int, intValue(data.partyId))
        .query(`
          UPDATE SalesOpportunities SET QuotationID = @quotationId
          WHERE OpportunityID = @opportunityId AND PartyID = @partyId
        `);
    }

    await writeAudit(
      transaction,
      quotationId > 0 && oldHeader ? 'Update' : 'Insert',
      quotationId,
      oldHeader,
      { ...totals, ItemsCount: items.length, PartyID: intValue(data.partyId) },
      auth.username,
    );
    await transaction.commit();
    return { quotationId, totals, created: !oldHeader };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

function resolvePricingType(items) {
  const tiers = [...new Set(items.map((item) => normalizeTier(item.pricingTier)))];
  return tiers.length === 1 ? tiers[0] : 'Mixed';
}

async function changeQuotationStatus(id, newStatus, username, { isPublic = false, reason = null } = {}) {
  if (!STATUSES.has(newStatus)) throw Object.assign(new Error('حالة عرض السعر غير صحيحة'), { statusCode: 400 });
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM Quotations WITH (UPDLOCK, HOLDLOCK) WHERE QuotationID = @id`);
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error('عرض السعر غير موجود'), { statusCode: 404 });
    if (current.InvoiceID != null) throw Object.assign(new Error('تم تحويل العرض إلى فاتورة ولا يمكن تغيير حالته'), { statusCode: 400 });
    const oldStatus = current.Status || 'Draft';
    if (oldStatus === newStatus) {
      await transaction.rollback();
      return { oldStatus, newStatus, unchanged: true };
    }
    if (!TRANSITIONS[oldStatus]?.has(newStatus)) {
      throw Object.assign(new Error(`لا يمكن تغيير الحالة من ${oldStatus} إلى ${newStatus}`), { statusCode: 400 });
    }

    await transaction.request()
      .input('id', sql.Int, id)
      .input('status', sql.NVarChar(50), newStatus)
      .input('actor', sql.NVarChar(100), username)
      .input('reason', sql.NVarChar(500), reason || null)
      .query(`
        UPDATE Quotations SET
          Status = @status,
          AcceptedAt = CASE WHEN @status = 'Accepted' THEN GETDATE() ELSE AcceptedAt END,
          AcceptedBy = CASE WHEN @status = 'Accepted' THEN @actor ELSE AcceptedBy END,
          RejectedAt = CASE WHEN @status = 'Rejected' THEN GETDATE() ELSE RejectedAt END,
          RejectedBy = CASE WHEN @status = 'Rejected' THEN @actor ELSE RejectedBy END,
          RejectionReason = CASE WHEN @status = 'Rejected' THEN @reason
                                 WHEN @status = 'Draft' THEN NULL ELSE RejectionReason END
        WHERE QuotationID = @id
      `);

    if (newStatus === 'Accepted' && current.OpportunityID) {
      await transaction.request()
        .input('opportunityId', sql.Int, current.OpportunityID)
        .input('quotationId', sql.Int, id)
        .query('UPDATE SalesOpportunities SET QuotationID = @quotationId WHERE OpportunityID = @opportunityId');
    }
    await writeAudit(transaction, 'ChangeStatus', id, { Status: oldStatus }, {
      Status: newStatus,
      Reason: reason || null,
      IsPublic: isPublic,
    }, username);
    await transaction.commit();
    return { oldStatus, newStatus, unchanged: false };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function deleteQuotation(id, username) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query('SELECT * FROM Quotations WITH (UPDLOCK, HOLDLOCK) WHERE QuotationID = @id');
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error('عرض السعر غير موجود'), { statusCode: 404 });
    if (current.InvoiceID != null) throw Object.assign(new Error('لا يمكن حذف عرض تم تحويله لفاتورة'), { statusCode: 400 });

    await transaction.request().input('id', sql.Int, id)
      .query('UPDATE SalesOpportunities SET QuotationID = NULL WHERE QuotationID = @id');
    await transaction.request().input('id', sql.Int, id)
      .query('DELETE FROM AdditionalCharges WHERE QuotationID = @id');
    await transaction.request().input('id', sql.Int, id)
      .query('DELETE FROM QuotationDetails WHERE QuotationID = @id');
    await writeAudit(transaction, 'Delete', id, current, null, username);
    await transaction.request().input('id', sql.Int, id)
      .query('DELETE FROM Quotations WHERE QuotationID = @id');
    await transaction.commit();
    return true;
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function updateQuotationItemCosts(id, updates, username) {
  const cleanUpdates = (Array.isArray(updates) ? updates : [])
    .map((row) => ({ detailId: intValue(row.quotationDetailId), unitCost: numberValue(row.unitCost) }))
    .filter((row) => row.detailId > 0 && row.unitCost > 0);
  if (!cleanUpdates.length) throw Object.assign(new Error('لا توجد تكاليف صالحة للحفظ'), { statusCode: 400 });
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const ids = cleanUpdates.map((row) => row.detailId);
    const request = transaction.request().input('quotationId', sql.Int, id);
    const params = ids.map((detailId, index) => {
      request.input(`d${index}`, sql.Int, detailId);
      return `@d${index}`;
    });
    const detailsResult = await request.query(`
      SELECT qd.QuotationDetailID, qd.ProductID, qd.PricingTier,
             qd.SelectedAlternativeID, p.ProductName,
             alt.AlternativeName
      FROM QuotationDetails qd
      INNER JOIN Products p ON qd.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives alt ON qd.SelectedAlternativeID = alt.AlternativeID
      WHERE qd.QuotationID = @quotationId
        AND qd.QuotationDetailID IN (${params.join(',')})
    `);
    if (detailsResult.recordset.length !== cleanUpdates.length) {
      throw Object.assign(new Error('أحد الأصناف لا ينتمي إلى عرض السعر'), { statusCode: 400 });
    }
    const details = new Map(detailsResult.recordset.map((row) => [Number(row.QuotationDetailID), row]));
    const changed = [];
    for (const update of cleanUpdates) {
      const detail = details.get(update.detailId);
      const tier = normalizeTier(detail.PricingTier);
      const isAlternative = detail.SelectedAlternativeID != null;
      const column = tier === 'CClass'
        ? 'PurchasePriceCClass'
        : tier === 'Elite'
          ? 'PurchasePriceElite'
          : isAlternative ? 'PurchasePricePremium' : 'PurchasePrice';
      const table = isAlternative ? 'ProductFactoryAlternatives' : 'Products';
      const keyColumn = detail.SelectedAlternativeID ? 'AlternativeID' : 'ProductID';
      const keyValue = detail.SelectedAlternativeID || detail.ProductID;
      const currentResult = await transaction.request()
        .input('key', sql.Int, keyValue)
        .query(`SELECT ${column} AS OldCost FROM ${table} WITH (UPDLOCK) WHERE ${keyColumn} = @key`);
      const oldCost = Number(currentResult.recordset[0]?.OldCost || 0);
      if (money(oldCost) === money(update.unitCost)) continue;
      await transaction.request()
        .input('key', sql.Int, keyValue)
        .input('cost', sql.Decimal(18, 2), update.unitCost)
        .query(`UPDATE ${table} SET ${column} = @cost WHERE ${keyColumn} = @key`);
      await transaction.request()
        .input('productId', sql.Int, detail.ProductID)
        .input('type', sql.NVarChar(50), `${tier}_Cost`)
        .input('oldCost', sql.Decimal(18, 2), oldCost)
        .input('newCost', sql.Decimal(18, 2), update.unitCost)
        .input('username', sql.NVarChar(100), username)
        .input('reason', sql.NVarChar(255), `تكلفة من عرض السعر #${id}`)
        .query(`
          INSERT INTO PriceHistory
            (ProductID, PriceType, OldPrice, NewPrice, ChangedBy, ChangedAt, ChangeReason)
          VALUES
            (@productId, @type, @oldCost, @newCost, @username, GETDATE(), @reason)
        `);
      changed.push(detail.AlternativeName || detail.ProductName);
    }
    await writeAudit(transaction, 'CostUpdate', id, null, { Changed: changed }, username);
    await transaction.commit();
    return changed;
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function adjustStock(transaction, productId, warehouseId, change, referenceId, unitPrice, username, referenceType) {
  if (!change) return;
  await transaction.request()
    .input('productId', sql.Int, productId)
    .input('warehouseId', sql.Int, warehouseId)
    .input('change', sql.Int, change)
    .input('username', sql.NVarChar(100), username)
    .query(`
      IF EXISTS (SELECT 1 FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
                 WHERE ProductID = @productId AND WarehouseID = @warehouseId)
        UPDATE StockLevels SET Quantity = Quantity + @change,
          LastUpdatedAt = GETDATE()
        WHERE ProductID = @productId AND WarehouseID = @warehouseId;
      ELSE
        INSERT INTO StockLevels
          (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedBy, CreatedAt)
        VALUES
          (@productId, @warehouseId, @change, GETDATE(), @username, GETDATE());
    `);
  await transaction.request()
    .input('productId', sql.Int, productId)
    .input('warehouseId', sql.Int, warehouseId)
    .input('type', sql.NVarChar(50), change < 0 ? 'Out' : 'In')
    .input('quantity', sql.Int, Math.abs(change))
    .input('referenceId', sql.Int, referenceId)
    .input('referenceType', sql.NVarChar(50), referenceType)
    .input('unitPrice', sql.Decimal(18, 2), money(unitPrice))
    .input('total', sql.Decimal(18, 2), money(Math.abs(change) * unitPrice))
    .input('notes', sql.NVarChar(500), `تحويل عرض سعر #${referenceId}`)
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO StockTransactions
        (ProductID, WarehouseID, TransactionType, Quantity, TransactionDate,
         ReferenceID, ReferenceType, UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt)
      VALUES
        (@productId, @warehouseId, @type, @quantity, GETDATE(),
         @referenceId, @referenceType, @unitPrice, @total, @notes, @username, GETDATE())
    `);
}

async function generateInvoiceReference(transaction, type) {
  const prefix = type === 'Purchase' ? 'PRC' : 'INV';
  const year = new Date().getFullYear();
  const result = await transaction.request()
    .input('prefix', sql.NVarChar(20), `${prefix}-${year}-%`)
    .query(`
      SELECT TOP 1 ReferenceNumber
      FROM Transactions WITH (UPDLOCK, HOLDLOCK)
      WHERE TransactionType = '${type}' AND ReferenceNumber LIKE @prefix
      ORDER BY TransactionID DESC
    `);
  const last = result.recordset[0]?.ReferenceNumber;
  const parts = String(last || '').split('-');
  const next = parts.length === 3 && Number(parts[2]) ? Number(parts[2]) + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(5, '0')}`;
}

async function convertQuotationToInvoice(id, data, auth) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const quotationResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM Quotations WITH (UPDLOCK, HOLDLOCK) WHERE QuotationID = @id`);
    const quotation = quotationResult.recordset[0];
    if (!quotation) throw Object.assign(new Error('عرض السعر غير موجود'), { statusCode: 404 });
    if (quotation.InvoiceID != null) {
      throw Object.assign(new Error(`تم تحويل العرض من قبل إلى الفاتورة #${quotation.InvoiceID}`), { statusCode: 409 });
    }

    const detailsResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT qd.*, p.ProductName, p.Customer,
               p.PurchasePriceCClass, p.PurchasePrice, p.PurchasePriceElite,
               p.Period,
               alt.PurchasePriceCClass AS AlternativePurchasePriceCClass,
               alt.PurchasePricePremium AS AlternativePurchasePricePremium,
               alt.PurchasePriceElite AS AlternativePurchasePriceElite,
               alt.Period AS AlternativePeriod
        FROM QuotationDetails qd
        INNER JOIN Products p ON qd.ProductID = p.ProductID
        LEFT JOIN ProductFactoryAlternatives alt
          ON qd.SelectedAlternativeID = alt.AlternativeID
        WHERE qd.QuotationID = @id
      `);
    const details = detailsResult.recordset;
    if (!details.length) throw Object.assign(new Error('عرض السعر لا يحتوي أصنافاً'), { statusCode: 400 });

    let warehouseId = intValue(data.warehouseId ?? quotation.WarehouseID);
    if (!warehouseId) {
      const warehouse = await transaction.request().query(`
        SELECT TOP 1 WarehouseID FROM Warehouses
        WHERE IsActive = 1 ORDER BY WarehouseID
      `);
      warehouseId = Number(warehouse.recordset[0]?.WarehouseID || 0);
    }
    if (!warehouseId) throw Object.assign(new Error('يجب اختيار المخزن قبل التحويل'), { statusCode: 400 });

    const showroomNeeds = new Map();
    for (const item of details) {
      if (item.Customer != null) continue;
      const quantity = Math.round(numberValue(item.Quantity));
      showroomNeeds.set(Number(item.ProductID), (showroomNeeds.get(Number(item.ProductID)) || 0) + quantity);
    }
    for (const [productId, required] of showroomNeeds) {
      const stock = await transaction.request()
        .input('productId', sql.Int, productId)
        .input('warehouseId', sql.Int, warehouseId)
        .query(`
          SELECT ISNULL(Quantity, 0) AS Quantity
          FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
          WHERE ProductID = @productId AND WarehouseID = @warehouseId
        `);
      const available = Number(stock.recordset[0]?.Quantity || 0);
      if (available < required) {
        const name = details.find((row) => Number(row.ProductID) === productId)?.ProductName || `#${productId}`;
        throw Object.assign(new Error(`رصيد المنتج '${name}' غير كافٍ. المتاح ${available} والمطلوب ${required}`), { statusCode: 400 });
      }
    }

    const invoiceDate = data.invoiceDate ? new Date(data.invoiceDate) : new Date();
    const maxPeriod = details.reduce((max, item) => Math.max(
      max,
      intValue(item.AlternativePeriod ?? item.Period),
    ), 0);
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + maxPeriod);
    const saleReference = await generateInvoiceReference(transaction, 'Sale');

    const saleResult = await transaction.request()
      .input('date', sql.DateTime, invoiceDate)
      .input('partyId', sql.Int, quotation.PartyID)
      .input('warehouseId', sql.Int, warehouseId)
      .input('empId', sql.Int, quotation.EmpId || auth.employeeId || null)
      .input('reference', sql.NVarChar(50), saleReference)
      .input('opportunityId', sql.Int, quotation.OpportunityID || null)
      .input('dueDate', sql.DateTime, dueDate)
      .input('total', sql.Decimal(18, 2), quotation.TotalAmount)
      .input('discount', sql.Decimal(18, 2), quotation.DiscountAmount || 0)
      .input('grand', sql.Decimal(18, 2), quotation.GrandTotal || quotation.TotalAmount)
      .input('notes', sql.NVarChar(500), `تحويل من عرض السعر ${quotation.ReferenceNumber || id}${quotation.Notes ? `\n${quotation.Notes}` : ''}`)
      .input('username', sql.NVarChar(100), auth.username)
      .query(`
        INSERT INTO Transactions
          (TransactionDate, PartyID, TransactionType, WarehouseID, EmpId,
           ReferenceNumber, ReferenceType, OpportunityID, DueDate,
           TotalAmount, DiscountPercentage, DiscountAmount, NetTotalAmount,
           TotalChargesAmount, GrandTotal, PaidAmount, PaymentMethod,
           Notes, InvoiceStatus, IsDelivered, CreatedBy, CreatedAt)
        OUTPUT INSERTED.TransactionID
        VALUES
          (@date, @partyId, 'Sale', @warehouseId, @empId,
           @reference, 'Invoice', @opportunityId, @dueDate,
           @total, NULL, @discount, @grand,
           0, @grand, 0, 'Cash',
           @notes, 'Open', 0, @username, GETDATE())
      `);
    const saleId = Number(saleResult.recordset[0].TransactionID);

    const selectedAdvanceIds = [...new Set(
      (Array.isArray(data.selectedAdvanceChargeIds)
        ? data.selectedAdvanceChargeIds
        : [])
        .map((value) => intValue(value))
        .filter((value) => value > 0),
    )];
    let advanceTotal = 0;
    if (selectedAdvanceIds.length) {
      const advanceRequest = transaction.request()
        .input('partyId', sql.Int, quotation.PartyID);
      const advanceParams = selectedAdvanceIds.map((chargeId, index) => {
        advanceRequest.input(`advance${index}`, sql.Int, chargeId);
        return `@advance${index}`;
      });
      const advancesResult = await advanceRequest.query(`
        SELECT ChargeID, ChargeAmount, ChargeDescription
        FROM AdditionalCharges WITH (UPDLOCK, HOLDLOCK)
        WHERE PartyID = @partyId
          AND TransactionID IS NULL
          AND AppliedToTransactionId IS NULL
          AND ISNULL(Status, N'Paid') = N'Paid'
          AND ChargeID IN (${advanceParams.join(',')})
      `);
      if (advancesResult.recordset.length !== selectedAdvanceIds.length) {
        throw Object.assign(
          new Error('إحدى الدفعات المقدمة غير متاحة أو تم تطبيقها من قبل'),
          { statusCode: 409 },
        );
      }
      for (const advance of advancesResult.recordset) {
        const amount = numberValue(advance.ChargeAmount);
        advanceTotal += amount;
        await transaction.request()
          .input('chargeId', sql.Int, advance.ChargeID)
          .input('transactionId', sql.Int, saleId)
          .query(`
            UPDATE AdditionalCharges
            SET TransactionID = @transactionId,
                AppliedToTransactionId = @transactionId,
                Status = N'Applied'
            WHERE ChargeID = @chargeId
              AND TransactionID IS NULL
              AND AppliedToTransactionId IS NULL
          `);
        await transaction.request()
          .input('transactionId', sql.Int, saleId)
          .input('amount', sql.Decimal(18, 2), amount)
          .input('description', sql.NVarChar(255), advance.ChargeDescription || 'دفعة مقدمة')
          .input('username', sql.NVarChar(100), auth.username)
          .query(`
            INSERT INTO Payments
              (TransactionID, PaymentDate, Amount, PaymentMethod,
               Notes, CreatedBy, CreatedAt)
            VALUES
              (@transactionId, GETDATE(), @amount, 'Advance',
               CONCAT(N'تطبيق دفعة مقدمة: ', @description), @username, GETDATE())
          `);
      }
    }

    const customerItems = details.filter((item) => item.Customer != null);
    let mirrorId = null;
    let mirrorReference = null;
    if (customerItems.length) {
      mirrorReference = await generateInvoiceReference(transaction, 'Purchase');
      const mirrorResult = await transaction.request()
        .input('date', sql.DateTime, invoiceDate)
        .input('warehouseId', sql.Int, warehouseId)
        .input('reference', sql.NVarChar(50), mirrorReference)
        .input('referenceType', sql.NVarChar(50), `MirrorOf:${saleId}`)
        .input('customerId', sql.Int, quotation.PartyID)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          INSERT INTO Transactions
            (TransactionDate, PartyID, TransactionType, WarehouseID, EmpId,
             ReferenceNumber, ReferenceType, TotalAmount, DiscountPercentage,
             DiscountAmount, NetTotalAmount, TotalChargesAmount, GrandTotal,
             PaidAmount, PaymentMethod, Notes, InvoiceStatus, IsDelivered,
             CreatedBy, CreatedAt)
          OUTPUT INSERTED.TransactionID
          VALUES
            (@date, 11, 'Purchase', @warehouseId, @customerId,
             @reference, @referenceType, 0, 0,
             0, 0, 0, 0,
             0, 'Credit', N'فاتورة شراء مرآة تلقائية من عرض سعر', 'Open', 1,
             @username, GETDATE())
        `);
      mirrorId = Number(mirrorResult.recordset[0].TransactionID);
      let mirrorTotal = 0;
      for (const item of customerItems) {
        const tier = normalizeTier(item.PricingTier);
        const alt = item.SelectedAlternativeID ? {
          PurchasePriceCClass: item.AlternativePurchasePriceCClass,
          PurchasePricePremium: item.AlternativePurchasePricePremium,
          PurchasePriceElite: item.AlternativePurchasePriceElite,
        } : null;
        const cost = getItemCost({ pricingTier: tier }, item, alt);
        mirrorTotal += money(numberValue(item.Quantity) * cost);
        await transaction.request()
          .input('transactionId', sql.Int, mirrorId)
          .input('productId', sql.Int, item.ProductID)
          .input('quantity', sql.Decimal(18, 3), item.Quantity)
          .input('unitPrice', sql.Decimal(18, 2), cost)
          .input('alternativeId', sql.Int, item.SelectedAlternativeID)
          .input('tier', sql.NVarChar(50), tier)
          .input('notes', sql.NVarChar(255), `[${tier}] مقابل بيع ${saleReference}`)
          .query(`
            INSERT INTO TransactionDetails
              (TransactionID, ProductID, Quantity, UnitPrice,
               SelectedAlternativeID, PricingTier, Notes)
            VALUES
              (@transactionId, @productId, @quantity, @unitPrice,
               @alternativeId, @tier, @notes)
          `);
        await adjustStock(
          transaction,
          Number(item.ProductID),
          warehouseId,
          Math.round(numberValue(item.Quantity)),
          mirrorId,
          cost,
          auth.username,
          'PurchaseInvoice',
        );
      }
      await transaction.request()
        .input('id', sql.Int, mirrorId)
        .input('total', sql.Decimal(18, 2), mirrorTotal)
        .query(`
          UPDATE Transactions SET TotalAmount = @total,
            NetTotalAmount = @total, GrandTotal = @total
          WHERE TransactionID = @id
        `);
    }

    for (const item of details) {
      const tier = normalizeTier(item.PricingTier);
      await transaction.request()
        .input('transactionId', sql.Int, saleId)
        .input('productId', sql.Int, item.ProductID)
        .input('quantity', sql.Decimal(18, 3), item.Quantity)
        .input('unitPrice', sql.Decimal(18, 2), item.UnitPrice)
        .input('alternativeId', sql.Int, item.SelectedAlternativeID)
        .input('tier', sql.NVarChar(50), tier)
        .input('notes', sql.NVarChar(255), item.Notes || `[${tier}]`)
        .query(`
          INSERT INTO TransactionDetails
            (TransactionID, ProductID, Quantity, UnitPrice,
             SelectedAlternativeID, PricingTier, Notes)
          VALUES
            (@transactionId, @productId, @quantity, @unitPrice,
             @alternativeId, @tier, @notes)
        `);
      await adjustStock(
        transaction,
        Number(item.ProductID),
        warehouseId,
        -Math.round(numberValue(item.Quantity)),
        saleId,
        numberValue(item.UnitPrice),
        auth.username,
        'SaleInvoice',
      );
    }

    if (customerItems.length) {
      const ids = [...new Set(customerItems.map((item) => Number(item.ProductID)))];
      const request = transaction.request();
      const params = ids.map((productId, index) => {
        request.input(`selected${index}`, sql.Int, productId);
        return `@selected${index}`;
      });
      await request.query(`UPDATE Products SET IsSelected = 1 WHERE ProductID IN (${params.join(',')})`);
    }

    await transaction.request()
      .input('id', sql.Int, saleId)
      .input('paid', sql.Decimal(18, 2), advanceTotal)
      .query(`
        UPDATE Transactions SET
          PaidAmount = @paid,
          InvoiceStatus = CASE
            WHEN @paid >= GrandTotal AND GrandTotal > 0 THEN 'Paid'
            WHEN @paid > 0 THEN 'PartiallyPaid'
            ELSE 'Open'
          END
        WHERE TransactionID = @id
      `);

    await transaction.request()
      .input('id', sql.Int, id)
      .input('invoiceId', sql.Int, saleId)
      .query(`UPDATE Quotations SET InvoiceID = @invoiceId, Status = 'Converted' WHERE QuotationID = @id`);

    if (quotation.OpportunityID) {
      const oldOpportunity = await transaction.request()
        .input('opportunityId', sql.Int, quotation.OpportunityID)
        .query('SELECT StageID, PartyID, EmployeeID, SourceID, StatusID FROM SalesOpportunities WHERE OpportunityID = @opportunityId');
      const opp = oldOpportunity.recordset[0];
      if (opp) {
        await transaction.request()
          .input('opportunityId', sql.Int, quotation.OpportunityID)
          .input('quotationId', sql.Int, id)
          .input('invoiceId', sql.Int, saleId)
          .input('value', sql.Decimal(18, 2), quotation.GrandTotal || quotation.TotalAmount)
          .input('username', sql.NVarChar(100), auth.username)
          .query(`
            UPDATE SalesOpportunities SET
              QuotationID = @quotationId, TransactionID = @invoiceId,
              StageID = 3, ActualValue = @value,
              NextFollowUpDate = NULL, ClosedAt = ISNULL(ClosedAt, GETDATE()),
              ClosedBy = ISNULL(ClosedBy, @username),
              LastContactDate = GETDATE(), LastUpdatedBy = @username,
              LastUpdatedAt = GETDATE()
            WHERE OpportunityID = @opportunityId
          `);
        await transaction.request()
          .input('opportunityId', sql.Int, quotation.OpportunityID)
          .input('username', sql.NVarChar(100), auth.username)
          .query(`
            UPDATE CRM_Tasks SET Status = 'Completed', CompletedDate = GETDATE(),
              CompletedBy = @username,
              CompletionNotes = N'تم الإغلاق تلقائياً بعد تحويل عرض السعر إلى فاتورة.'
            WHERE OpportunityID = @opportunityId AND Status IN ('Pending', 'In Progress')
          `);
        await transaction.request()
          .input('opportunityId', sql.Int, quotation.OpportunityID)
          .input('partyId', sql.Int, opp.PartyID)
          .input('employeeId', sql.Int, opp.EmployeeID)
          .input('sourceId', sql.Int, opp.SourceID)
          .input('statusId', sql.Int, opp.StatusID)
          .input('before', sql.Int, opp.StageID)
          .input('username', sql.NVarChar(100), auth.username)
          .input('summary', sql.NVarChar(1000), `تم تحويل عرض السعر ${quotation.ReferenceNumber || id} إلى فاتورة ${saleReference}.`)
          .query(`
            INSERT INTO CustomerInteractions
              (OpportunityID, PartyID, EmployeeID, SourceID, StatusID,
               InteractionDate, Summary, StageBeforeID, StageAfterID,
               CreatedBy, CreatedAt)
            VALUES
              (@opportunityId, @partyId, @employeeId, @sourceId, @statusId,
               GETDATE(), @summary, @before, 3, @username, GETDATE())
          `);
      }
    }

    await writeAudit(transaction, 'ConvertToInvoice', id, null, {
      InvoiceID: saleId,
      MirrorInvoiceID: mirrorId,
    }, auth.username);
    await writeAudit(transaction, 'Insert', saleId, null, {
      Source: 'Quotation',
      QuotationID: Number(id),
      ReferenceNumber: saleReference,
    }, auth.username, 'Transactions');
    await transaction.commit();
    return {
      invoiceId: saleId,
      invoiceReference: saleReference,
      mirrorInvoiceId: mirrorId,
      mirrorReference,
      dueDate,
      appliedAdvanceTotal: money(advanceTotal),
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function getPublicQuotation(id) {
  const quote = await getQuotationById(id);
  if (!quote) return null;
  const publicQuote = { ...quote };
  delete publicQuote.CreatedBy;
  delete publicQuote.RejectedBy;
  delete publicQuote.AcceptedBy;
  delete publicQuote.advances;
  for (const item of publicQuote.details || []) {
    delete item.PurchasePriceCClass;
    delete item.PurchasePrice;
    delete item.PurchasePriceElite;
    delete item.AlternativePurchasePriceCClass;
    delete item.AlternativePurchasePricePremium;
    delete item.AlternativePurchasePriceElite;
  }
  return publicQuote;
}

module.exports = {
  getQuotations,
  getQuotationStats,
  getQuotationById,
  searchParties,
  getQuotationLookups,
  getAvailableProducts,
  getProductAlternatives,
  saveQuotation,
  changeQuotationStatus,
  deleteQuotation,
  updateQuotationItemCosts,
  convertQuotationToInvoice,
  getPublicQuotation,
};
