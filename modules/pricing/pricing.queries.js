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
  const pool = await connectDB();
  
  // 1. جلب الأسعار القديمة
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
  
  // 2. تحديث السعر حسب النوع
  if (priceType === 'Premium') {
    await pool.request()
      .input('id', sql.Int, productId)
      .input('price', sql.Decimal(18, 2), newSalePrice)
      .query(`UPDATE Products SET SuggestedSalePrice = @price WHERE ProductID = @id`);
    
    await _logPriceHistory(pool, productId, 'SalePrice', old.SuggestedSalePrice, newSalePrice, changedBy, reason, clientTime);
  } else {
    await pool.request()
      .input('id', sql.Int, productId)
      .input('price', sql.Decimal(18, 2), newSalePrice)
      .query(`UPDATE Products SET SuggestedSalePriceElite = @price WHERE ProductID = @id`);
    
      await _logPriceHistory(pool, productId, 'SalePriceElite', old.SuggestedSalePriceElite, newSalePrice, changedBy, reason, clientTime);
  }
  
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
    .input('clientTime', sql.DateTime, new Date(clientTime))
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
  
  // 1. جلب بيانات الطلب
  const reqResult = await pool.request()
    .input('id', sql.Int, requestId)
    .query(`SELECT * FROM PriceChangeRequests WHERE RequestID = @id AND Status = 'Pending'`);
  
  if (reqResult.recordset.length === 0) throw new Error('الطلب غير موجود أو تمت معالجته');
  
  const request = reqResult.recordset[0];
  
  // 2. تحديث حالة الطلب
  await pool.request()
    .input('id', sql.Int, requestId)
    .input('reviewedBy', sql.NVarChar(100), reviewedBy)
    .input('reviewNotes', sql.NVarChar(500), reviewNotes)
    .input('clientTime', sql.DateTime, new Date(clientTime))
    .query(`
      UPDATE PriceChangeRequests SET 
        Status = 'Approved',
        ReviewedBy = @reviewedBy,
        ReviewedAt = @clientTime,
        ReviewNotes = @reviewNotes
      WHERE RequestID = @id
    `);
  
  // 3. تحديث سعر البيع في المنتج
 await updateSalePrice(
    request.ProductID, 
    request.PriceType, 
    request.RequestedPrice, 
    reviewedBy,
    'موافقة على طلب تعديل #' + requestId + ': ' + (reviewNotes || ''),
    clientTime
  );
  
  return {
    productId: request.ProductID,
    requestedBy: request.RequestedBy,
    priceType: request.PriceType,
    oldPrice: request.CurrentPrice,
    newPrice: request.RequestedPrice
  };
}

// رفض طلب
async function rejectRequest(requestId, reviewedBy, reviewNotes, clientTime) {
  const pool = await connectDB();
  
  // 1. جلب بيانات الطلب
  const reqResult = await pool.request()
    .input('id', sql.Int, requestId)
    .query(`SELECT * FROM PriceChangeRequests WHERE RequestID = @id AND Status = 'Pending'`);
  
  if (reqResult.recordset.length === 0) throw new Error('الطلب غير موجود أو تمت معالجته');
  
  const request = reqResult.recordset[0];
  
  // 2. تحديث حالة الطلب
  await pool.request()
    .input('id', sql.Int, requestId)
    .input('reviewedBy', sql.NVarChar(100), reviewedBy)
    .input('reviewNotes', sql.NVarChar(500), reviewNotes)
    .input('clientTime', sql.DateTime, new Date(clientTime))
    .query(`
      UPDATE PriceChangeRequests SET 
        Status = 'Rejected',
        ReviewedBy = @reviewedBy,
        ReviewedAt = @clientTime,
        ReviewNotes = @reviewNotes
      WHERE RequestID = @id
    `);
  
  return {
    productId: request.ProductID,
    requestedBy: request.RequestedBy
  };
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
    .input('priceType', sql.NVarChar(10), priceType)
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
  getProductPriceHistory
};