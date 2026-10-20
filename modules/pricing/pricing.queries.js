const { sql, connectDB } = require('../../core/database');

// =============================================
// 🔢 نسب الربح (PricingMargins)
// =============================================

// جلب النسب الحالية الفعالة
async function getActiveMargins() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT TOP 1 
        MarginID, PremiumMargin, EliteMargin, 
        ChangedBy,
        FORMAT(ChangedAt, 'yyyy-MM-dd hh:mm tt') AS ChangedAt
      FROM PricingMargins 
      WHERE IsActive = 1
      ORDER BY MarginID DESC
    `);
  return result.recordset[0] || null;
}

// جلب سجل تغييرات النسب
async function getMarginsHistory() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        MarginID, PremiumMargin, EliteMargin,
        PreviousPremium, PreviousElite,
        ChangeReason, ChangedBy,
        FORMAT(ChangedAt, 'yyyy-MM-dd hh:mm tt') AS ChangedAt
      FROM PricingMargins 
      ORDER BY MarginID DESC
    `);
  return result.recordset;
}

// تحديث النسب (الأقدم يصير غير فعال + إضافة جديد)
async function updateMargins(premiumMargin, eliteMargin, reason, changedBy, clientTime) {
  const pool = await connectDB();
  
  // جلب النسب الحالية
  const current = await getActiveMargins();
  
  // إلغاء تفعيل الحالي
  await pool.request()
    .query(`UPDATE PricingMargins SET IsActive = 0 WHERE IsActive = 1`);
  
  // إضافة النسب الجديدة
  const result = await pool.request()
    .input('premiumMargin', sql.Decimal(8, 2), premiumMargin)
    .input('eliteMargin', sql.Decimal(8, 2), eliteMargin)
    .input('previousPremium', sql.Decimal(8, 2), current ? current.PremiumMargin : 0)
    .input('previousElite', sql.Decimal(8, 2), current ? current.EliteMargin : 0)
    .input('reason', sql.NVarChar(255), reason || null)
    .input('changedBy', sql.NVarChar(100), changedBy)
    .input('clientTime', sql.DateTime, new Date(clientTime))
    .query(`
      INSERT INTO PricingMargins (
        PremiumMargin, EliteMargin, IsActive,
        PreviousPremium, PreviousElite,
        ChangeReason, ChangedBy, ChangedAt
      )
      OUTPUT INSERTED.MarginID
      VALUES (
        @premiumMargin, @eliteMargin, 1,
        @previousPremium, @previousElite,
        @reason, @changedBy, @clientTime
      )
    `);
  
  return result.recordset[0].MarginID;
}

// =============================================
// 💰 تسعير المنتج (Factory)
// =============================================

// تسعير من المصنع (تكلفة فقط + حساب البيع تلقائي)
async function updateProductPricing(productId, purchasePrice, purchasePriceElite, changedBy, clientTime) {
  const pool = await connectDB();
  
  // 1. جلب النسب الحالية
  const margins = await getActiveMargins();
  if (!margins) throw new Error('لا توجد نسب ربح محددة');
  
  // 2. جلب الأسعار القديمة
  const oldProduct = await pool.request()
    .input('id', sql.Int, productId)
    .query(`
      SELECT PurchasePrice, SuggestedSalePrice, 
             PurchasePriceElite, SuggestedSalePriceElite,
             CreatedBy
      FROM Products WHERE ProductID = @id
    `);
  
  if (oldProduct.recordset.length === 0) throw new Error('المنتج غير موجود');
  
  const old = oldProduct.recordset[0];
  
  // 3. حساب أسعار البيع
  const salePricePremium = purchasePrice * (1 + margins.PremiumMargin / 100);
  const salePriceElite = purchasePriceElite * (1 + margins.EliteMargin / 100);
  
  // 4. تحديث المنتج
  await pool.request()
    .input('id', sql.Int, productId)
    .input('purchasePrice', sql.Decimal(18, 2), purchasePrice)
    .input('suggestedSalePrice', sql.Decimal(18, 2), salePricePremium)
    .input('purchasePriceElite', sql.Decimal(18, 2), purchasePriceElite)
    .input('suggestedSalePriceElite', sql.Decimal(18, 2), salePriceElite)
    .query(`
      UPDATE Products SET
        PurchasePrice = @purchasePrice,
        SuggestedSalePrice = @suggestedSalePrice,
        PurchasePriceElite = @purchasePriceElite,
        SuggestedSalePriceElite = @suggestedSalePriceElite
      WHERE ProductID = @id
    `);
  
  // 5. تسجيل في PriceHistory - Premium
  if (purchasePrice !== (old.PurchasePrice || 0)) {
    await _logPriceHistory(pool, productId, 'PurchasePrice', old.PurchasePrice, purchasePrice, changedBy, 'تسعير المصنع', clientTime);
  }
  if (salePricePremium !== (old.SuggestedSalePrice || 0)) {
    await _logPriceHistory(pool, productId, 'SalePrice', old.SuggestedSalePrice, salePricePremium, changedBy, 'حساب تلقائي من التكلفة', clientTime);
  }
  
  // 6. تسجيل في PriceHistory - Elite
  if (purchasePriceElite !== (old.PurchasePriceElite || 0)) {
    await _logPriceHistory(pool, productId, 'PurchasePriceElite', old.PurchasePriceElite, purchasePriceElite, changedBy, 'تسعير المصنع', clientTime);
  }
  if (salePriceElite !== (old.SuggestedSalePriceElite || 0)) {
    await _logPriceHistory(pool, productId, 'SalePriceElite', old.SuggestedSalePriceElite, salePriceElite, changedBy, 'حساب تلقائي من التكلفة', clientTime);
  }
  
  return {
    salePricePremium,
    salePriceElite,
    createdBy: old.CreatedBy // عشان نبعت إشعار للسيلز اللي كوّد المنتج
  };
}

// =============================================
// 💵 تعديل سعر البيع (Admin / AccountManager)
// =============================================

async function updateSalePrice(productId, priceType, newSalePrice, changedBy, reason, clientTime) {
  const tier = assertPriceListTier(priceType);
  const column = PRICE_LIST_TIERS[tier].saleColumn;
  const pool = await connectDB();

  const oldProduct = await pool.request()
    .input('id', sql.Int, productId)
    .query(`
      SELECT ${column} AS OldPrice, CreatedBy
      FROM Products
      WHERE ProductID = @id
    `);
  if (oldProduct.recordset.length === 0) throw new Error('المنتج غير موجود');

  const old = oldProduct.recordset[0];
  await pool.request()
    .input('id', sql.Int, productId)
    .input('price', sql.Decimal(18, 2), newSalePrice)
    .query(`UPDATE Products SET ${column} = @price WHERE ProductID = @id`);

  await _logPriceHistory(
    pool,
    productId,
    tier,
    old.OldPrice,
    newSalePrice,
    changedBy,
    reason,
    clientTime || new Date().toISOString(),
  );

  return { createdBy: old.CreatedBy };
}

// =============================================
// 📝 طلبات تعديل الأسعار
// =============================================

// إنشاء طلب تعديل سعر
async function createPriceChangeRequest(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, data.productId)
    .input('priceType', sql.NVarChar(20), data.priceType)
    .input('currentPrice', sql.Decimal(18, 2), data.currentPrice)
    .input('requestedPrice', sql.Decimal(18, 2), data.requestedPrice)
    .input('reason', sql.NVarChar(500), data.reason)
    .input('requestedBy', sql.NVarChar(100), data.requestedBy)
    .input('clientTime', sql.DateTime, data.clientTime ? new Date(data.clientTime) : new Date())
    .query(`
      INSERT INTO PriceChangeRequests (
        ProductID, PriceType, CurrentPrice, RequestedPrice,
        Reason, Status, RequestedBy, RequestedAt
      )
      OUTPUT INSERTED.RequestID
      VALUES (
        @productId, @priceType, @currentPrice, @requestedPrice,
        @reason, 'Pending', @requestedBy, @clientTime
      )
    `);
  return result.recordset[0].RequestID;
}

// جلب الطلبات (لمدير المبيعات - Pending)
async function getPendingRequests() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT * FROM vw_PriceChangeRequests 
      WHERE Status = 'Pending'
      ORDER BY RequestedAt DESC
    `);
  return result.recordset;
}

// جلب طلباتي (للسيلز)
async function getMyRequests(username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query(`
      SELECT * FROM vw_PriceChangeRequests 
      WHERE RequestedBy = @username
      ORDER BY RequestedAt DESC
    `);
  return result.recordset;
}

// جلب كل الطلبات (للأدمن)
async function getAllRequests() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT * FROM vw_PriceChangeRequests 
      ORDER BY RequestedAt DESC
    `);
  return result.recordset;
}

// موافقة على طلب
async function approveRequest(requestId, reviewedBy, reviewNotes, clientTime) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const requestResult = await transaction.request()
      .input('id', sql.Int, requestId)
      .query(`
        SELECT RequestID, ProductID, PriceType, CurrentPrice,
               RequestedPrice, RequestedBy
        FROM PriceChangeRequests WITH (UPDLOCK, HOLDLOCK)
        WHERE RequestID = @id AND Status = 'Pending'
      `);
    const request = requestResult.recordset[0];
    if (!request) {
      const error = new Error('الطلب غير موجود أو تمت معالجته');
      error.statusCode = 404;
      throw error;
    }

    const tier = assertPriceListTier(request.PriceType);
    const column = PRICE_LIST_TIERS[tier].saleColumn;
    const productResult = await transaction.request()
      .input('productId', sql.Int, request.ProductID)
      .query(`
        SELECT ProductName, ${column} AS OldPrice
        FROM Products WITH (UPDLOCK, HOLDLOCK)
        WHERE ProductID = @productId
      `);
    const product = productResult.recordset[0];
    if (!product) {
      const error = new Error('المنتج غير موجود');
      error.statusCode = 404;
      throw error;
    }

    const oldPrice = Number(product.OldPrice || 0);
    await transaction.request()
      .input('id', sql.Int, requestId)
      .input('reviewedBy', sql.NVarChar(100), reviewedBy)
      .input('reviewNotes', sql.NVarChar(500), reviewNotes || null)
      .query(`
        UPDATE PriceChangeRequests SET
          Status = 'Approved', ReviewedBy = @reviewedBy,
          ReviewedAt = GETDATE(), ReviewNotes = @reviewNotes
        WHERE RequestID = @id AND Status = 'Pending'
      `);

    await transaction.request()
      .input('productId', sql.Int, request.ProductID)
      .input('price', sql.Decimal(18, 2), request.RequestedPrice)
      .query(`UPDATE Products SET ${column} = @price WHERE ProductID = @productId`);

    await transaction.request()
      .input('productId', sql.Int, request.ProductID)
      .input('tier', sql.NVarChar(50), tier)
      .input('oldPrice', sql.Decimal(18, 2), oldPrice)
      .input('newPrice', sql.Decimal(18, 2), request.RequestedPrice)
      .input('reviewedBy', sql.NVarChar(100), reviewedBy)
      .input('reason', sql.NVarChar(255), `موافقة على طلب تعديل #${requestId}: ${reviewNotes || ''}`)
      .query(`
        INSERT INTO PriceHistory
          (ProductID, PriceType, OldPrice, NewPrice, ChangedBy, ChangedAt, ChangeReason)
        VALUES
          (@productId, @tier, @oldPrice, @newPrice, @reviewedBy, GETDATE(), @reason)
      `);

    await writePriceListAudit(transaction, {
      productId: request.ProductID,
      actionType: 'PriceChangeApproved',
      oldData: { Tier: tier, Value: oldPrice, RequestID: Number(requestId) },
      newData: {
        Tier: tier,
        Value: Number(request.RequestedPrice),
        RequestID: Number(requestId),
        ReviewNotes: reviewNotes || null,
      },
      username: reviewedBy,
    });

    await transaction.commit();
    return {
      productId: request.ProductID,
      productName: product.ProductName,
      requestedBy: request.RequestedBy,
      priceType: tier,
      oldPrice,
      newPrice: request.RequestedPrice,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

// رفض طلب
async function rejectRequest(requestId, reviewedBy, reviewNotes, clientTime) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const requestResult = await transaction.request()
      .input('id', sql.Int, requestId)
      .query(`
        SELECT RequestID, ProductID, PriceType, CurrentPrice,
               RequestedPrice, RequestedBy
        FROM PriceChangeRequests WITH (UPDLOCK, HOLDLOCK)
        WHERE RequestID = @id AND Status = 'Pending'
      `);
    const request = requestResult.recordset[0];
    if (!request) {
      const error = new Error('الطلب غير موجود أو تمت معالجته');
      error.statusCode = 404;
      throw error;
    }

    await transaction.request()
      .input('id', sql.Int, requestId)
      .input('reviewedBy', sql.NVarChar(100), reviewedBy)
      .input('reviewNotes', sql.NVarChar(500), reviewNotes)
      .query(`
        UPDATE PriceChangeRequests SET
          Status = 'Rejected', ReviewedBy = @reviewedBy,
          ReviewedAt = GETDATE(), ReviewNotes = @reviewNotes
        WHERE RequestID = @id AND Status = 'Pending'
      `);

    await writePriceListAudit(transaction, {
      productId: request.ProductID,
      actionType: 'PriceChangeRejected',
      oldData: {
        Tier: request.PriceType,
        Value: Number(request.CurrentPrice),
        RequestID: Number(requestId),
      },
      newData: {
        RequestedValue: Number(request.RequestedPrice),
        RequestID: Number(requestId),
        ReviewNotes: reviewNotes,
      },
      username: reviewedBy,
    });

    await transaction.commit();
    return {
      productId: request.ProductID,
      requestedBy: request.RequestedBy,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

// =============================================
// 📊 تاريخ الأسعار
// =============================================

async function getProductPriceHistory(productId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`
      SELECT 
        HistoryID, ProductID, PriceType,
        OldPrice, NewPrice,
        ChangedBy, 
        FORMAT(ChangedAt, 'yyyy-MM-dd hh:mm tt') AS ChangedAt,
        ChangeReason
      FROM PriceHistory 
      WHERE ProductID = @productId
      ORDER BY ChangedAt DESC
    `);
  return result.recordset;
}

// =============================================
// 🔧 دالة مساعدة - تسجيل PriceHistory
// =============================================

async function _logPriceHistory(pool, productId, priceType, oldPrice, newPrice, changedBy, reason, clientTime) {
  await pool.request()
    .input('productId', sql.Int, productId)
    .input('priceType', sql.NVarChar(50), priceType)
    .input('oldPrice', sql.Decimal(18, 2), oldPrice || 0)
    .input('newPrice', sql.Decimal(18, 2), newPrice)
    .input('changedBy', sql.NVarChar(100), changedBy)
    .input('reason', sql.NVarChar(255), reason || null)
    .input('clientTime', sql.DateTime, new Date(clientTime))
    .query(`
      INSERT INTO PriceHistory (
        ProductID, PriceType, OldPrice, NewPrice,
        ChangedBy, ChangedAt, ChangeReason
      )
      VALUES (
        @productId, @priceType, @oldPrice, @newPrice,
        @changedBy, @clientTime, @reason
      )
    `);
}


// =============================================
// قائمة الأسعار - الكتالوج العام
// =============================================

const PRICE_LIST_TIERS = {
  CClass: {
    saleColumn: 'SuggestedSalePriceCClass',
    costColumn: 'PurchasePriceCClass',
  },
  Premium: {
    saleColumn: 'SuggestedSalePrice',
    costColumn: 'PurchasePrice',
  },
  Elite: {
    saleColumn: 'SuggestedSalePriceElite',
    costColumn: 'PurchasePriceElite',
  },
};

function assertPriceListTier(tier) {
  const normalized = String(tier || '');
  if (!PRICE_LIST_TIERS[normalized]) {
    const error = new Error('فئة السعر غير معروفة');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

async function getPriceListRows(branchId = null) {
  const pool = await connectDB();
  const schemaResult = await pool.request().query(`
    SELECT
      COL_LENGTH('dbo.Products', 'IsWebsite') AS IsWebsiteColumn,
      COL_LENGTH('dbo.ProductImages', 'IsPrimary') AS IsPrimaryColumn
  `);
  const schema = schemaResult.recordset[0] || {};
  const websiteExpression = schema.IsWebsiteColumn != null
    ? 'ISNULL(p.IsWebsite, 0)'
    : 'CAST(0 AS bit)';
  const imageOrder = schema.IsPrimaryColumn != null
    ? 'ISNULL(pi.IsPrimary, 0) DESC,'
    : '';

  const request = pool.request();
  const hasBranch = Number.isInteger(Number(branchId)) && Number(branchId) > 0;
  if (hasBranch) request.input('branchId', sql.Int, Number(branchId));

  const result = await request.query(`
    SELECT
      p.ProductID,
      p.ProductName,
      pg.GroupName,
      p.SuggestedSalePriceCClass AS StdPrice,
      p.SuggestedSalePrice AS PremiumPrice,
      p.SuggestedSalePriceElite AS ElitePrice,
      p.PurchasePriceCClass AS StdCost,
      p.PurchasePrice AS PremiumCost,
      p.PurchasePriceElite AS EliteCost,
      p.PricingStatusID,
      ${websiteExpression} AS IsWebsite,
      ISNULL(stock.StockQuantity, 0) AS StockQuantity,
      imageData.MainImageId,
      ISNULL(imageCount.ImageCount, 0) AS ImageCount,
      CASE WHEN pending.ProductID IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS HasPendingRequest,
      CASE
        WHEN lastPremium.OldPrice > 0 AND lastPremium.NewPrice < lastPremium.OldPrice
          THEN CAST(ROUND((lastPremium.OldPrice - lastPremium.NewPrice) * 100.0 / lastPremium.OldPrice, 0) AS int)
        ELSE NULL
      END AS SaleDiscountPercent,
      CASE
        WHEN lastPremium.OldPrice > 0 AND lastPremium.NewPrice < lastPremium.OldPrice
          THEN lastPremium.OldPrice
        ELSE NULL
      END AS PreviousPremiumPrice
    FROM Products p
    INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
    OUTER APPLY (
      SELECT SUM(sl.Quantity) AS StockQuantity
      FROM StockLevels sl
      INNER JOIN Warehouses w ON sl.WarehouseID = w.WarehouseID
      WHERE sl.ProductID = p.ProductID
        ${hasBranch ? 'AND w.BranchID = @branchId' : ''}
    ) stock
    OUTER APPLY (
      SELECT TOP 1 pi.ProductImagesID AS MainImageId
      FROM ProductImages pi
      WHERE pi.ProductID = p.ProductID
      ORDER BY ${imageOrder} pi.CreatedAt DESC, pi.ProductImagesID DESC
    ) imageData
    OUTER APPLY (
      SELECT COUNT(*) AS ImageCount
      FROM ProductImages pic
      WHERE pic.ProductID = p.ProductID
    ) imageCount
    OUTER APPLY (
      SELECT TOP 1 h.OldPrice, h.NewPrice
      FROM PriceHistory h
      WHERE h.ProductID = p.ProductID
        AND h.PriceType IN (N'Premium', N'SalePrice', N'بيع')
      ORDER BY h.ChangedAt DESC, h.HistoryID DESC
    ) lastPremium
    OUTER APPLY (
      SELECT TOP 1 r.ProductID
      FROM PriceChangeRequests r
      WHERE r.ProductID = p.ProductID AND r.Status = 'Pending'
    ) pending
    WHERE p.Customer IS NULL
    ORDER BY p.ProductName, p.ProductID
  `);

  return result.recordset;
}

async function getPriceListBranches() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT BranchID AS BranchId, BranchNameAr AS BranchName
    FROM Branches
    ORDER BY BranchNameAr
  `);
  return result.recordset;
}

async function getPriceListHistory(productId, take = 15) {
  const pool = await connectDB();
  const safeTake = Math.min(Math.max(Number(take) || 15, 1), 50);
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .input('take', sql.Int, safeTake)
    .query(`
      SELECT TOP (@take)
        HistoryID, PriceType, OldPrice, NewPrice,
        ChangedBy, ChangedAt, ChangeReason
      FROM PriceHistory
      WHERE ProductID = @productId
      ORDER BY ChangedAt DESC, HistoryID DESC
    `);
  return result.recordset;
}

async function getPriceListImageIds(productId) {
  const pool = await connectDB();
  const schemaResult = await pool.request().query(
    "SELECT COL_LENGTH('dbo.ProductImages', 'IsPrimary') AS IsPrimaryColumn",
  );
  const imageOrder = schemaResult.recordset[0]?.IsPrimaryColumn != null
    ? 'ISNULL(IsPrimary, 0) DESC,'
    : '';
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`
      SELECT ProductImagesID
      FROM ProductImages
      WHERE ProductID = @productId
      ORDER BY ${imageOrder} CreatedAt DESC, ProductImagesID DESC
    `);
  return result.recordset.map((row) => Number(row.ProductImagesID));
}

async function writePriceListAudit(transaction, {
  productId,
  actionType,
  oldData,
  newData,
  username,
}) {
  await transaction.request()
    .input('tableName', sql.NVarChar(100), 'Products')
    .input('actionType', sql.NVarChar(50), actionType)
    .input('primaryKey', sql.NVarChar(100), String(productId))
    .input('oldData', sql.NVarChar(sql.MAX), JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), JSON.stringify(newData))
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (@tableName, @actionType, @primaryKey, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function updatePriceListValue({
  productId,
  tier,
  newValue,
  reason,
  username,
  valueType,
}) {
  const normalizedTier = assertPriceListTier(tier);
  const tierInfo = PRICE_LIST_TIERS[normalizedTier];
  const isCost = valueType === 'cost';
  const column = isCost ? tierInfo.costColumn : tierInfo.saleColumn;
  const historyType = isCost ? `${normalizedTier}_Cost` : normalizedTier;
  const amount = Number(newValue);
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error(isCost ? 'التكلفة غير صالحة' : 'السعر غير صالح');
    error.statusCode = 400;
    throw error;
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('سبب التعديل إلزامي');
    error.statusCode = 400;
    throw error;
  }

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('productId', sql.Int, productId)
      .query(`
        SELECT ProductID, ProductName, ${column} AS OldValue
        FROM Products WITH (UPDLOCK, HOLDLOCK)
        WHERE ProductID = @productId AND Customer IS NULL
      `);
    const current = currentResult.recordset[0];
    if (!current) {
      const error = new Error('المنتج غير موجود في الكتالوج العام');
      error.statusCode = 404;
      throw error;
    }

    const oldValue = Number(current.OldValue || 0);
    if (Math.round(oldValue * 100) === Math.round(amount * 100)) {
      const error = new Error(isCost ? 'التكلفة الجديدة مطابقة للحالية' : 'السعر الجديد مطابق للحالي');
      error.statusCode = 400;
      throw error;
    }

    await transaction.request()
      .input('productId', sql.Int, productId)
      .input('newValue', sql.Decimal(18, 2), amount)
      .query(`UPDATE Products SET ${column} = @newValue WHERE ProductID = @productId`);

    await transaction.request()
      .input('productId', sql.Int, productId)
      .input('priceType', sql.NVarChar(50), historyType)
      .input('oldValue', sql.Decimal(18, 2), oldValue)
      .input('newValue', sql.Decimal(18, 2), amount)
      .input('username', sql.NVarChar(100), username)
      .input('reason', sql.NVarChar(255), cleanReason)
      .query(`
        INSERT INTO PriceHistory
          (ProductID, PriceType, OldPrice, NewPrice, ChangedBy, ChangedAt, ChangeReason)
        VALUES
          (@productId, @priceType, @oldValue, @newValue, @username, GETDATE(), @reason)
      `);

    await writePriceListAudit(transaction, {
      productId,
      actionType: isCost ? 'CostUpdate' : 'PriceUpdate',
      oldData: { Tier: normalizedTier, Value: oldValue },
      newData: { Tier: normalizedTier, Value: amount, Reason: cleanReason },
      username,
    });

    await transaction.commit();
    return {
      productId: Number(productId),
      productName: current.ProductName,
      tier: normalizedTier,
      oldValue,
      newValue: amount,
      valueType,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function createPriceListRequest({
  productId,
  tier,
  requestedPrice,
  reason,
  username,
}) {
  const normalizedTier = assertPriceListTier(tier);
  const amount = Number(requestedPrice);
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error('السعر المطلوب غير صالح');
    error.statusCode = 400;
    throw error;
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('سبب الطلب إلزامي');
    error.statusCode = 400;
    throw error;
  }

  const column = PRICE_LIST_TIERS[normalizedTier].saleColumn;
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const productResult = await transaction.request()
      .input('productId', sql.Int, productId)
      .query(`
        SELECT ProductID, ProductName, ${column} AS CurrentPrice
        FROM Products WITH (UPDLOCK, HOLDLOCK)
        WHERE ProductID = @productId AND Customer IS NULL
      `);
    const product = productResult.recordset[0];
    if (!product) {
      const error = new Error('المنتج غير موجود في الكتالوج العام');
      error.statusCode = 404;
      throw error;
    }

    const currentPrice = Number(product.CurrentPrice || 0);
    if (Math.round(currentPrice * 100) === Math.round(amount * 100)) {
      const error = new Error('السعر المطلوب مطابق للسعر الحالي');
      error.statusCode = 400;
      throw error;
    }

    const duplicate = await transaction.request()
      .input('productId', sql.Int, productId)
      .input('tier', sql.NVarChar(20), normalizedTier)
      .input('requestedPrice', sql.Decimal(18, 2), amount)
      .query(`
        SELECT TOP 1 RequestID
        FROM PriceChangeRequests WITH (UPDLOCK, HOLDLOCK)
        WHERE ProductID = @productId
          AND PriceType = @tier
          AND Status = 'Pending'
          AND RequestedPrice = @requestedPrice
      `);
    if (duplicate.recordset.length) {
      const error = new Error('يوجد طلب معلق بنفس القيمة لهذا المنتج والفئة');
      error.statusCode = 409;
      throw error;
    }

    const inserted = await transaction.request()
      .input('productId', sql.Int, productId)
      .input('tier', sql.NVarChar(20), normalizedTier)
      .input('currentPrice', sql.Decimal(18, 2), currentPrice)
      .input('requestedPrice', sql.Decimal(18, 2), amount)
      .input('reason', sql.NVarChar(500), cleanReason)
      .input('username', sql.NVarChar(100), username)
      .query(`
        INSERT INTO PriceChangeRequests
          (ProductID, PriceType, CurrentPrice, RequestedPrice,
           Reason, Status, RequestedBy, RequestedAt)
        OUTPUT INSERTED.RequestID
        VALUES
          (@productId, @tier, @currentPrice, @requestedPrice,
           @reason, 'Pending', @username, GETDATE())
      `);
    const requestId = Number(inserted.recordset[0].RequestID);

    await writePriceListAudit(transaction, {
      productId,
      actionType: 'PriceChangeRequest',
      oldData: { Tier: normalizedTier, Value: currentPrice },
      newData: { Tier: normalizedTier, Value: amount, Reason: cleanReason, RequestID: requestId },
      username,
    });

    await transaction.commit();
    return {
      requestId,
      productId: Number(productId),
      productName: product.ProductName,
      tier: normalizedTier,
      currentPrice,
      requestedPrice: amount,
      requestedBy: username,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

// =============================================
// تصدير الدوال
// =============================================
module.exports = {
  // نسب الربح
  getActiveMargins,
  getMarginsHistory,
  updateMargins,
  // تسعير المصنع
  updateProductPricing,
  // تعديل سعر البيع
  updateSalePrice,
  // طلبات التعديل
  createPriceChangeRequest,
  getPendingRequests,
  getMyRequests,
  getAllRequests,
  approveRequest,
  rejectRequest,
  // تاريخ الأسعار
  getProductPriceHistory,
  // قائمة الأسعار
  getPriceListRows,
  getPriceListBranches,
  getPriceListHistory,
  getPriceListImageIds,
  updatePriceListValue,
  createPriceListRequest
};