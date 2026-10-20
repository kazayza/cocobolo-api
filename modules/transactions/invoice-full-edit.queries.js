const { sql, connectDB } = require('../../core/database');
const notificationsQueries = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');

const VALID_TIERS = new Set(['CClass', 'Premium', 'Elite']);
const VALID_NEW_CHARGES = new Set(['Shipping', 'Installation', 'Other']);

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const money = (value) => Math.round((num(value) + Number.EPSILON) * 100) / 100;
const qtyInt = (value) => Math.round(num(value));
const pick = (obj, ...keys) => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, key)) return obj[key];
  }
  return undefined;
};

function normalizeTier(value) {
  const tier = String(value || 'Premium');
  return VALID_TIERS.has(tier) ? tier : 'Premium';
}

function normalizeItem(raw) {
  return {
    detailId: Number(pick(raw, 'detailId', 'DetailID', 'DetailId') || 0),
    productId: Number(pick(raw, 'productId', 'ProductID', 'ProductId') || 0),
    productName: String(pick(raw, 'productName', 'ProductName') || ''),
    quantity: num(pick(raw, 'quantity', 'Quantity')),
    unitPrice: num(pick(raw, 'unitPrice', 'UnitPrice')),
    pricingTier: normalizeTier(pick(raw, 'pricingTier', 'PricingTier')),
    selectedAlternativeId: (() => {
      const value = pick(raw, 'selectedAlternativeId', 'SelectedAlternativeID', 'SelectedAlternativeId');
      return value == null || value === '' ? null : Number(value);
    })(),
    notes: String(pick(raw, 'notes', 'Notes') || '').trim(),
  };
}

function normalizeNewCharge(raw) {
  const type = String(pick(raw, 'chargeType', 'ChargeType') || 'Other');
  return {
    chargeType: VALID_NEW_CHARGES.has(type) ? type : 'Other',
    chargeDescription: String(pick(raw, 'chargeDescription', 'description', 'ChargeDescription') || '').trim(),
    chargeAmount: money(pick(raw, 'chargeAmount', 'amount', 'ChargeAmount')),
    notes: String(pick(raw, 'notes', 'Notes') || '').trim(),
  };
}

function calculateTotals(data, items, oldChargesTotal, newCharges) {
  const totalAmount = money(items.reduce((sum, item) => sum + money(item.quantity * item.unitPrice), 0));
  const entryMode = String(pick(data, 'discountEntryMode', 'DiscountEntryMode') || '').toLowerCase();
  let discountAmount = num(pick(data, 'discountAmount', 'DiscountAmount'), 0);
  let discountPercentage = pick(data, 'discountPercentage', 'DiscountPercentage');
  discountPercentage = discountPercentage == null || discountPercentage === ''
    ? null
    : num(discountPercentage, 0);

  const amountEntered = entryMode === 'amount'
    || (!entryMode && discountAmount > 0 && !(discountPercentage > 0));

  if (amountEntered && discountAmount > 0) {
    discountAmount = money(Math.min(Math.max(discountAmount, 0), totalAmount));
    discountPercentage = null;
  } else if (discountPercentage != null && discountPercentage > 0) {
    discountPercentage = Math.min(Math.max(discountPercentage, 0), 100);
    discountAmount = money(totalAmount * discountPercentage / 100);
  } else {
    discountAmount = 0;
    discountPercentage = null;
  }

  const netTotalAmount = money(totalAmount - discountAmount);
  const newChargesTotal = money(newCharges.reduce((sum, charge) => sum + charge.chargeAmount, 0));
  const totalChargesAmount = money(num(oldChargesTotal) + newChargesTotal);
  const grandTotal = money(netTotalAmount + totalChargesAmount);

  return {
    totalAmount,
    discountPercentage,
    discountAmount,
    netTotalAmount,
    newChargesTotal,
    totalChargesAmount,
    grandTotal,
  };
}

function computeStatus(grandTotal, paidAmount) {
  if (grandTotal > 0 && paidAmount >= grandTotal) return 'Paid';
  if (paidAmount > 0) return 'PartiallyPaid';
  return 'Open';
}

async function getHeader(poolOrTransaction, transactionId, { lock = false } = {}) {
  const request = poolOrTransaction.request();
  const lockHint = lock ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  const result = await request
    .input('id', sql.Int, transactionId)
    .query(`
      SELECT t.*, p.PartyName, p.Phone, p.Address, p.TaxNumber,
             w.WarehouseName, e.FullName AS EmployeeName,
             supplier.PartyName AS SupplierName
      FROM Transactions t ${lockHint}
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
      LEFT JOIN Employees e ON t.EmpId = e.EmployeeID
      LEFT JOIN Parties supplier ON t.EmpId = supplier.PartyID
      WHERE t.TransactionID = @id
    `);
  return result.recordset[0] || null;
}

async function getDetails(poolOrTransaction, transactionId) {
  const result = await poolOrTransaction.request()
    .input('id', sql.Int, transactionId)
    .query(`
      SELECT td.DetailID, td.TransactionID, td.ProductID, td.Quantity,
             td.UnitPrice, td.TotalAmount, td.Notes, td.PricingTier,
             td.SelectedAlternativeID,
             p.ProductName, p.ProductDescription, p.Customer,
             p.SuggestedSalePriceCClass, p.SuggestedSalePrice,
             p.SuggestedSalePriceElite, p.PurchasePriceCClass,
             p.PurchasePrice, p.PurchasePriceElite, p.Period,
             a.AlternativeName, a.SpecificationSummary,
             a.SuggestedSalePriceCClass AS AlternativeSalePriceCClass,
             a.SuggestedSalePricePremium AS AlternativeSalePricePremium,
             a.SuggestedSalePriceElite AS AlternativeSalePriceElite,
             a.PurchasePriceCClass AS AlternativePurchasePriceCClass,
             a.PurchasePricePremium AS AlternativePurchasePricePremium,
             a.PurchasePriceElite AS AlternativePurchasePriceElite,
             a.Period AS AlternativePeriod
      FROM TransactionDetails td
      INNER JOIN Products p ON td.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives a ON td.SelectedAlternativeID = a.AlternativeID
      WHERE td.TransactionID = @id
      ORDER BY td.DetailID
    `);
  return result.recordset;
}

async function getCharges(poolOrTransaction, transactionId) {
  const result = await poolOrTransaction.request()
    .input('id', sql.Int, transactionId)
    .query(`
      SELECT ChargeID, ChargeDescription, ChargeAmount, ChargeType, Notes
      FROM AdditionalCharges
      WHERE TransactionID = @id
      ORDER BY ChargeID
    `);
  return result.recordset;
}

async function isProtectedSale(pool, header, auth) {
  if (!header || header.TransactionType !== 'Sale'
      || policy.invoices.canSeeProtectedAccountManagerInvoices(auth)) return false;

  const result = await pool.request()
    .input('creator', sql.NVarChar(100), header.CreatedBy)
    .query(`SELECT TOP 1 1 AS IsProtected FROM Users WHERE Username = @creator AND Role = N'AccountManager'`);
  return result.recordset.length > 0;
}

async function assertCanView(pool, header, auth) {
  if (!header) return { ok: false, status: 404, message: 'الفاتورة غير موجودة.' };
  if (header.TransactionType === 'Purchase') {
    if (!policy.invoices.canViewPurchases(auth)) {
      return { ok: false, status: 403, message: 'ليس لديك صلاحية عرض فواتير الشراء.' };
    }
  } else if (!policy.invoices.canViewSales(auth)) {
    return { ok: false, status: 403, message: 'ليس لديك صلاحية عرض فواتير المبيعات.' };
  }
  if (await isProtectedSale(pool, header, auth)) {
    return { ok: false, status: 403, message: 'هذه الفاتورة محمية حسب نطاق صلاحيات الحسابات.' };
  }
  return { ok: true };
}

async function computeProfit(pool, transactionId) {
  const result = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`
      SELECT td.Quantity, td.PricingTier, td.Notes, td.SelectedAlternativeID,
             p.PurchasePriceCClass, p.PurchasePrice, p.PurchasePriceElite,
             a.PurchasePriceCClass AS AltCostCClass,
             a.PurchasePricePremium AS AltCostPremium,
             a.PurchasePriceElite AS AltCostElite
      FROM TransactionDetails td
      INNER JOIN Products p ON td.ProductID = p.ProductID
      LEFT JOIN ProductFactoryAlternatives a ON td.SelectedAlternativeID = a.AlternativeID
      WHERE td.TransactionID = @id
    `);

  let totalCost = 0;
  for (const row of result.recordset) {
    const notes = String(row.Notes || '');
    const tier = normalizeTier(row.PricingTier
      || (notes.startsWith('[CClass]') ? 'CClass' : notes.startsWith('[Elite]') ? 'Elite' : 'Premium'));
    let unitCost;
    if (row.SelectedAlternativeID != null) {
      unitCost = tier === 'CClass'
        ? num(row.AltCostCClass)
        : tier === 'Elite'
          ? num(row.AltCostElite, num(row.AltCostPremium))
          : num(row.AltCostPremium);
    } else {
      unitCost = tier === 'CClass'
        ? num(row.PurchasePriceCClass)
        : tier === 'Elite'
          ? num(row.PurchasePriceElite, num(row.PurchasePrice))
          : num(row.PurchasePrice);
    }
    totalCost += money(num(row.Quantity) * unitCost);
  }
  return money(totalCost);
}

async function getEditModel(transactionId, auth) {
  const pool = await connectDB();
  const header = await getHeader(pool, transactionId);
  const access = await assertCanView(pool, header, auth);
  if (!access.ok) return access;

  const [details, charges] = await Promise.all([
    getDetails(pool, transactionId),
    getCharges(pool, transactionId),
  ]);

  let mirror = null;
  if (header.TransactionType === 'Sale') {
    const result = await pool.request()
      .input('tag', sql.NVarChar(100), `MirrorOf:${transactionId}`)
      .query(`
        SELECT TOP 1 TransactionID, ReferenceNumber
        FROM Transactions
        WHERE ReferenceType = @tag AND ISNULL(InvoiceStatus, '') != 'Cancelled'
      `);
    mirror = result.recordset[0] || null;
  } else if (String(header.ReferenceType || '').startsWith('MirrorOf:')) {
    const saleId = Number(String(header.ReferenceType).slice('MirrorOf:'.length));
    if (saleId > 0) {
      const result = await pool.request().input('id', sql.Int, saleId)
        .query('SELECT TOP 1 TransactionID, ReferenceNumber FROM Transactions WHERE TransactionID = @id');
      mirror = result.recordset[0] || null;
    }
  }

  const canProfit = policy.invoices.canViewProfit(auth) && header.TransactionType === 'Sale';
  let profit = null;
  if (canProfit) {
    const totalCost = await computeProfit(pool, transactionId);
    const net = num(header.NetTotalAmount, num(header.TotalAmount));
    const grossProfit = money(net - totalCost);
    profit = {
      totalCost,
      grossProfit,
      profitMarginPercentage: totalCost > 0 ? money(grossProfit / totalCost * 100) : null,
    };
  }

  return {
    ok: true,
    data: {
      header,
      details,
      charges,
      mirror,
      profit,
      capabilities: {
        canFullEdit: policy.invoices.canFullEdit(auth),
        canLimitedEdit: policy.invoices.canLimitedEdit(auth),
        canViewHistory: policy.invoices.canViewHistory(auth),
        canRestore: policy.invoices.canRestore(auth),
        canViewProfit: canProfit,
      },
    },
  };
}

async function adjustStock(transaction, {
  productId,
  warehouseId,
  quantityChange,
  referenceId,
  unitPrice,
  username,
  referenceType,
}) {
  if (!quantityChange) return;
  const request = transaction.request();
  await request
    .input('productId', sql.Int, productId)
    .input('warehouseId', sql.Int, warehouseId)
    .input('change', sql.Int, quantityChange)
    .input('username', sql.NVarChar(100), username)
    .query(`
      IF EXISTS (SELECT 1 FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
                 WHERE ProductID = @productId AND WarehouseID = @warehouseId)
        UPDATE StockLevels
        SET Quantity = Quantity + @change, LastUpdatedAt = GETDATE()
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
    .input('type', sql.NVarChar(20), quantityChange < 0 ? 'Out' : 'In')
    .input('quantity', sql.Int, Math.abs(quantityChange))
    .input('referenceId', sql.Int, referenceId)
    .input('referenceType', sql.NVarChar(80), referenceType)
    .input('unitPrice', sql.Decimal(18, 2), money(unitPrice))
    .input('totalAmount', sql.Decimal(18, 2), money(Math.abs(quantityChange) * num(unitPrice)))
    .input('notes', sql.NVarChar(500), `تعديل كامل للفاتورة #${referenceId}`)
    .input('username', sql.NVarChar(100), username)
    .query(`
      INSERT INTO StockTransactions
        (ProductID, WarehouseID, TransactionType, Quantity, TransactionDate,
         ReferenceID, ReferenceType, UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt)
      VALUES
        (@productId, @warehouseId, @type, @quantity, GETDATE(),
         @referenceId, @referenceType, @unitPrice, @totalAmount, @notes, @username, GETDATE())
    `);
}

async function audit(transaction, {
  tableName,
  actionType,
  primaryKey,
  oldData,
  newData,
  username,
}) {
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
      VALUES
        (@tableName, @actionType, @primaryKey, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function getProductsMap(transaction, productIds) {
  const unique = [...new Set(productIds.map(Number).filter((id) => id > 0))];
  if (!unique.length) return new Map();
  const request = transaction.request();
  const params = unique.map((id, index) => {
    request.input(`p${index}`, sql.Int, id);
    return `@p${index}`;
  });
  const result = await request.query(`
    SELECT ProductID, ProductName, Customer, IsSelected
    FROM Products WITH (UPDLOCK)
    WHERE ProductID IN (${params.join(',')})
  `);
  return new Map(result.recordset.map((row) => [Number(row.ProductID), row]));
}

function snapshot(header, details, reason = null, names = new Map()) {
  return {
    TotalAmount: num(header.TotalAmount),
    DiscountAmount: header.DiscountAmount == null ? null : num(header.DiscountAmount),
    DiscountPercentage: header.DiscountPercentage == null ? null : num(header.DiscountPercentage),
    NetTotalAmount: header.NetTotalAmount == null ? null : num(header.NetTotalAmount),
    GrandTotal: num(header.GrandTotal),
    TotalChargesAmount: num(header.TotalChargesAmount),
    WarehouseId: Number(header.WarehouseID),
    TransactionDate: header.TransactionDate,
    DueDate: header.DueDate,
    PaymentMethod: header.PaymentMethod,
    IsDelivered: header.IsDelivered,
    Notes: header.Notes,
    OpportunityId: header.OpportunityID,
    Reason: reason,
    Items: details.map((d) => ({
      DetailId: Number(d.DetailID ?? d.detailId ?? 0),
      ProductId: Number(d.ProductID ?? d.productId),
      ProductName: d.ProductName || names.get(Number(d.ProductID ?? d.productId)) || `#${d.ProductID ?? d.productId}`,
      Quantity: num(d.Quantity ?? d.quantity),
      UnitPrice: num(d.UnitPrice ?? d.unitPrice),
      PricingTier: normalizeTier(d.PricingTier ?? d.pricingTier),
      SelectedAlternativeId: d.SelectedAlternativeID ?? d.selectedAlternativeId ?? null,
    })),
  };
}

async function findMirrorSyncNeeded(transaction, header, oldDetails, newItems, productMap) {
  if (header.TransactionType !== 'Sale') return null;
  const customerId = Number(header.PartyID);
  const isCustomerProduct = (productId) => Number(productMap.get(Number(productId))?.Customer) === customerId;

  const aggregate = (items, oldShape) => {
    const map = new Map();
    for (const item of items) {
      const productId = Number(oldShape ? item.ProductID : item.productId);
      if (!isCustomerProduct(productId)) continue;
      const quantity = num(oldShape ? item.Quantity : item.quantity);
      map.set(productId, money((map.get(productId) || 0) + quantity));
    }
    return map;
  };

  const before = aggregate(oldDetails, true);
  const after = aggregate(newItems, false);
  const changed = before.size !== after.size
    || [...before].some(([id, quantity]) => after.get(id) !== quantity);
  if (!changed) return null;

  const result = await transaction.request()
    .input('tag', sql.NVarChar(100), `MirrorOf:${header.TransactionID}`)
    .query(`
      SELECT TOP 1 TransactionID, ReferenceNumber
      FROM Transactions
      WHERE ReferenceType = @tag AND ISNULL(InvoiceStatus, '') != 'Cancelled'
    `);
  return result.recordset[0] || null;
}

async function fullEditInvoice(transactionId, rawData, auth) {
  if (!policy.invoices.canFullEdit(auth)) {
    return { ok: false, status: 403, message: 'التعديل الكامل متاح للمدير ومدير الحسابات فقط.' };
  }

  const reason = String(pick(rawData, 'fullEditReason', 'FullEditReason') || '').trim();
  if (!reason) return { ok: false, status: 400, message: 'سبب التعديل إلزامي.' };

  const items = (pick(rawData, 'items', 'Items') || []).map(normalizeItem);
  if (!items.length) return { ok: false, status: 400, message: 'لا يمكن حفظ الفاتورة بدون أصناف.' };
  if (items.some((i) => !Number.isInteger(i.productId) || i.productId <= 0)) {
    return { ok: false, status: 400, message: 'هناك صنف غير صالح.' };
  }
  if (items.some((i) => i.quantity <= 0)) {
    return { ok: false, status: 400, message: 'يجب أن تكون الكمية أكبر من صفر لكل صنف.' };
  }
  if (items.some((i) => i.unitPrice < 0)) {
    return { ok: false, status: 400, message: 'السعر لا يمكن أن يكون سالباً.' };
  }

  const newCharges = (pick(rawData, 'newCharges', 'NewCharges') || [])
    .map(normalizeNewCharge)
    .filter((charge) => charge.chargeAmount > 0);
  if (newCharges.some((charge) => !charge.chargeDescription)) {
    return { ok: false, status: 400, message: 'وصف الرسم الإضافي الجديد إلزامي.' };
  }

  const pool = await connectDB();
  const dbTransaction = new sql.Transaction(pool);
  await dbTransaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

  try {
    const header = await getHeader(dbTransaction, transactionId, { lock: true });
    if (!header) {
      await dbTransaction.rollback();
      return { ok: false, status: 404, message: 'الفاتورة غير موجودة.' };
    }
    const access = await assertCanView(pool, header, auth);
    if (!access.ok) {
      await dbTransaction.rollback();
      return access;
    }
    if (header.InvoiceStatus === 'Cancelled') {
      await dbTransaction.rollback();
      return { ok: false, status: 400, message: 'لا يمكن تعديل فاتورة ملغية.' };
    }
    if (header.InvoiceStatus === 'Paid') {
      await dbTransaction.rollback();
      return { ok: false, status: 400, message: 'لا يمكن تعديل فاتورة مسددة بالكامل.' };
    }

    const oldDetails = await getDetails(dbTransaction, transactionId);
    const oldIdSet = new Set(oldDetails.map((d) => Number(d.DetailID)));
    const submittedOldIds = items.filter((i) => i.detailId > 0).map((i) => i.detailId);
    if (submittedOldIds.some((id) => !oldIdSet.has(id))) {
      await dbTransaction.rollback();
      return { ok: false, status: 400, message: 'بيانات الأصناف غير مطابقة للفاتورة الأصلية.' };
    }
    if (new Set(submittedOldIds).size !== submittedOldIds.length) {
      await dbTransaction.rollback();
      return { ok: false, status: 400, message: 'لا يمكن تكرار نفس الصف الأصلي أكثر من مرة.' };
    }

    const allProductIds = [
      ...oldDetails.map((d) => Number(d.ProductID)),
      ...items.map((i) => i.productId),
    ];
    const productMap = await getProductsMap(dbTransaction, allProductIds);
    if (items.some((i) => !productMap.has(i.productId))) {
      await dbTransaction.rollback();
      return { ok: false, status: 400, message: 'يوجد صنف غير موجود أو تم حذفه.' };
    }

    for (const item of items) {
      if (item.selectedAlternativeId == null) continue;
      const alt = await dbTransaction.request()
        .input('altId', sql.Int, item.selectedAlternativeId)
        .input('productId', sql.Int, item.productId)
        .query(`
          SELECT TOP 1 AlternativeID
          FROM ProductFactoryAlternatives
          WHERE AlternativeID = @altId AND ProductID = @productId
        `);
      if (!alt.recordset.length) {
        await dbTransaction.rollback();
        return { ok: false, status: 400, message: `البديل المصنعي لا يخص الصنف ${productMap.get(item.productId)?.ProductName || item.productId}.` };
      }
    }

    const totals = calculateTotals(rawData, items, header.TotalChargesAmount, newCharges);
    if (totals.grandTotal < num(header.PaidAmount)) {
      await dbTransaction.rollback();
      return {
        ok: false,
        status: 400,
        message: `لا يمكن الحفظ: الإجمالي الجديد (${totals.grandTotal.toFixed(2)} ج) أقل من المدفوع (${num(header.PaidAmount).toFixed(2)} ج).`,
      };
    }

    const oldWarehouse = Number(header.WarehouseID);
    const newWarehouse = Number(pick(rawData, 'warehouseId', 'WarehouseID', 'WarehouseId') || oldWarehouse);
    const oldById = new Map(oldDetails.map((d) => [Number(d.DetailID), d]));
    const unchanged = (item, old) => Boolean(old)
      && item.productId === Number(old.ProductID)
      && newWarehouse === oldWarehouse
      && qtyInt(item.quantity) === qtyInt(old.Quantity);

    const names = new Map([...productMap].map(([id, value]) => [id, value.ProductName]));
    const oldSnapshot = snapshot(header, oldDetails, null, names);
    const mirror = await findMirrorSyncNeeded(dbTransaction, header, oldDetails, items, productMap);

    // عكس الأثر القديم للأصناف المتغيرة ثم تطبيق الجديد.
    if (header.TransactionType === 'Sale') {
      for (const old of oldDetails) {
        const current = items.find((i) => i.detailId === Number(old.DetailID));
        if (unchanged(current, old)) continue;
        await adjustStock(dbTransaction, {
          productId: Number(old.ProductID),
          warehouseId: oldWarehouse,
          quantityChange: qtyInt(old.Quantity),
          referenceId: transactionId,
          unitPrice: old.UnitPrice,
          username: auth.username,
          referenceType: 'SaleInvoiceEdit',
        });
      }

      const needed = new Map();
      for (const item of items) {
        const old = oldById.get(item.detailId);
        if (unchanged(item, old)) continue;
        // المنتجات المرتبطة بعميل لا تدخل فحص رصيد المعرض.
        if (productMap.get(item.productId)?.Customer != null) continue;
        needed.set(item.productId, (needed.get(item.productId) || 0) + qtyInt(item.quantity));
      }
      for (const [productId, required] of needed) {
        const level = await dbTransaction.request()
          .input('productId', sql.Int, productId)
          .input('warehouseId', sql.Int, newWarehouse)
          .query(`
            SELECT ISNULL(Quantity, 0) AS Quantity
            FROM StockLevels WITH (UPDLOCK, HOLDLOCK)
            WHERE ProductID = @productId AND WarehouseID = @warehouseId
          `);
        const available = Number(level.recordset[0]?.Quantity || 0);
        if (available < required) {
          await dbTransaction.rollback();
          return {
            ok: false,
            status: 400,
            message: `رصيد الصنف '${productMap.get(productId)?.ProductName || `#${productId}`}' غير كافٍ في المخزن. المتاح ${available} والمطلوب ${required}.`,
          };
        }
      }

      for (const item of items) {
        const old = oldById.get(item.detailId);
        if (unchanged(item, old)) continue;
        await adjustStock(dbTransaction, {
          productId: item.productId,
          warehouseId: newWarehouse,
          quantityChange: -qtyInt(item.quantity),
          referenceId: transactionId,
          unitPrice: item.unitPrice,
          username: auth.username,
          referenceType: 'SaleInvoiceEdit',
        });
      }
    } else if (header.IsDelivered === true || header.IsDelivered === 1) {
      for (const old of oldDetails) {
        const current = items.find((i) => i.detailId === Number(old.DetailID));
        if (unchanged(current, old)) continue;
        await adjustStock(dbTransaction, {
          productId: Number(old.ProductID),
          warehouseId: oldWarehouse,
          quantityChange: -qtyInt(old.Quantity),
          referenceId: transactionId,
          unitPrice: old.UnitPrice,
          username: auth.username,
          referenceType: 'PurchaseInvoiceEdit',
        });
      }
      for (const item of items) {
        const old = oldById.get(item.detailId);
        if (unchanged(item, old)) continue;
        await adjustStock(dbTransaction, {
          productId: item.productId,
          warehouseId: newWarehouse,
          quantityChange: qtyInt(item.quantity),
          referenceId: transactionId,
          unitPrice: item.unitPrice,
          username: auth.username,
          referenceType: 'PurchaseInvoiceEdit',
        });
      }
    }

    for (const charge of newCharges) {
      await dbTransaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('partyId', sql.Int, header.PartyID)
        .input('type', sql.NVarChar(50), charge.chargeType)
        .input('description', sql.NVarChar(255), charge.chargeDescription)
        .input('amount', sql.Decimal(18, 2), charge.chargeAmount)
        .input('notes', sql.NVarChar(sql.MAX), charge.notes || null)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          INSERT INTO AdditionalCharges
            (TransactionID, PartyID, ChargeType, ChargeDescription, ChargeAmount,
             Status, AppliedToTransactionId, Notes, CreatedBy, CreatedAt)
          VALUES
            (@transactionId, @partyId, @type, @description, @amount,
             N'Applied', @transactionId, @notes, @username, GETDATE())
        `);
    }

    const keepIds = [];
    for (const item of items) {
      const notes = item.notes ? `[${item.pricingTier}] ${item.notes}` : `[${item.pricingTier}]`;
      if (item.detailId > 0) {
        keepIds.push(item.detailId);
        await dbTransaction.request()
          .input('detailId', sql.Int, item.detailId)
          .input('productId', sql.Int, item.productId)
          .input('quantity', sql.Decimal(18, 3), item.quantity)
          .input('unitPrice', sql.Decimal(18, 2), money(item.unitPrice))
          .input('total', sql.Decimal(18, 2), money(item.quantity * item.unitPrice))
          .input('altId', sql.Int, item.selectedAlternativeId)
          .input('tier', sql.NVarChar(20), item.pricingTier)
          .input('notes', sql.NVarChar(255), notes)
          .query(`
            UPDATE TransactionDetails
            SET ProductID = @productId, Quantity = @quantity, UnitPrice = @unitPrice,
                TotalAmount = @total, SelectedAlternativeID = @altId,
                PricingTier = @tier, Notes = @notes
            WHERE DetailID = @detailId AND TransactionID = ${Number(transactionId)}
          `);
      } else {
        const inserted = await dbTransaction.request()
          .input('transactionId', sql.Int, transactionId)
          .input('productId', sql.Int, item.productId)
          .input('quantity', sql.Decimal(18, 3), item.quantity)
          .input('unitPrice', sql.Decimal(18, 2), money(item.unitPrice))
          .input('total', sql.Decimal(18, 2), money(item.quantity * item.unitPrice))
          .input('altId', sql.Int, item.selectedAlternativeId)
          .input('tier', sql.NVarChar(20), item.pricingTier)
          .input('notes', sql.NVarChar(255), notes)
          .query(`
            INSERT INTO TransactionDetails
              (TransactionID, ProductID, Quantity, UnitPrice, TotalAmount,
               SelectedAlternativeID, PricingTier, Notes)
            OUTPUT INSERTED.DetailID
            VALUES
              (@transactionId, @productId, @quantity, @unitPrice, @total,
               @altId, @tier, @notes)
          `);
        const newId = Number(inserted.recordset[0].DetailID);
        keepIds.push(newId);
        item.detailId = newId;
      }
    }

    const removed = oldDetails.filter((d) => !keepIds.includes(Number(d.DetailID)));
    for (const detail of removed) {
      await dbTransaction.request()
        .input('detailId', sql.Int, detail.DetailID)
        .input('transactionId', sql.Int, transactionId)
        .query('DELETE FROM TransactionDetails WHERE DetailID = @detailId AND TransactionID = @transactionId');
    }

    // تحرير/حجز منتجات العميل.
    if (header.TransactionType === 'Sale') {
      const oldCustomer = new Set(oldDetails
        .filter((d) => productMap.get(Number(d.ProductID))?.Customer != null)
        .map((d) => Number(d.ProductID)));
      const newCustomer = new Set(items
        .filter((i) => productMap.get(i.productId)?.Customer != null)
        .map((i) => i.productId));
      for (const productId of new Set([...oldCustomer, ...newCustomer])) {
        await dbTransaction.request()
          .input('id', sql.Int, productId)
          .input('selected', sql.Bit, newCustomer.has(productId) ? 1 : 0)
          .query('UPDATE Products SET IsSelected = @selected WHERE ProductID = @id');
      }
    }

    const transactionDate = pick(rawData, 'transactionDate', 'TransactionDate') || header.TransactionDate;
    const dueRaw = pick(rawData, 'dueDate', 'DueDate');
    const dueDate = dueRaw === undefined ? header.DueDate : dueRaw;
    const paymentMethod = pick(rawData, 'paymentMethod', 'PaymentMethod') ?? header.PaymentMethod;
    const isDeliveredRaw = pick(rawData, 'isDelivered', 'IsDelivered');
    const isDelivered = isDeliveredRaw == null ? header.IsDelivered : Boolean(isDeliveredRaw);
    const notes = pick(rawData, 'notes', 'Notes') ?? header.Notes;
    const opportunityId = pick(rawData, 'opportunityId', 'OpportunityID', 'OpportunityId') ?? header.OpportunityID;
    const invoiceStatus = computeStatus(totals.grandTotal, num(header.PaidAmount));
    const editStatus = [1, 2].includes(Number(header.EditStatus)) ? 4 : header.EditStatus;

    await dbTransaction.request()
      .input('id', sql.Int, transactionId)
      .input('total', sql.Decimal(18, 2), totals.totalAmount)
      .input('discPct', sql.Decimal(5, 2), totals.discountPercentage)
      .input('discAmt', sql.Decimal(18, 2), totals.discountAmount)
      .input('net', sql.Decimal(18, 2), totals.netTotalAmount)
      .input('charges', sql.Decimal(18, 2), totals.totalChargesAmount)
      .input('grand', sql.Decimal(18, 2), totals.grandTotal)
      .input('warehouseId', sql.Int, newWarehouse)
      .input('transactionDate', sql.DateTime, new Date(transactionDate))
      .input('dueDate', sql.DateTime, dueDate ? new Date(dueDate) : null)
      .input('paymentMethod', sql.NVarChar(50), paymentMethod || null)
      .input('isDelivered', sql.Bit, isDelivered ? 1 : 0)
      .input('notes', sql.NVarChar(sql.MAX), notes || null)
      .input('opportunityId', sql.Int, opportunityId || null)
      .input('username', sql.NVarChar(100), auth.username)
      .input('reason', sql.NVarChar(500), reason)
      .input('editStatus', sql.Int, editStatus == null ? null : Number(editStatus))
      .input('invoiceStatus', sql.NVarChar(30), invoiceStatus)
      .query(`
        UPDATE Transactions SET
          TotalAmount = @total,
          DiscountPercentage = @discPct,
          DiscountAmount = @discAmt,
          NetTotalAmount = @net,
          TotalChargesAmount = @charges,
          GrandTotal = @grand,
          WarehouseID = @warehouseId,
          TransactionDate = @transactionDate,
          DueDate = @dueDate,
          PaymentMethod = @paymentMethod,
          IsDelivered = @isDelivered,
          Notes = @notes,
          OpportunityID = CASE WHEN TransactionType = 'Sale' THEN @opportunityId ELSE OpportunityID END,
          EditBy = @username,
          EditAt = GETDATE(),
          EditReason = @reason,
          EditStatus = @editStatus,
          EditDone = CASE WHEN @editStatus = 4
            THEN CONCAT(N'تم التعديل الكامل بواسطة ', @username, N' بتاريخ ', FORMAT(GETDATE(), 'yyyy/MM/dd HH:mm'))
            ELSE EditDone END,
          InvoiceStatus = @invoiceStatus
        WHERE TransactionID = @id
      `);

    const newHeader = {
      ...header,
      TotalAmount: totals.totalAmount,
      DiscountAmount: totals.discountAmount,
      DiscountPercentage: totals.discountPercentage,
      NetTotalAmount: totals.netTotalAmount,
      GrandTotal: totals.grandTotal,
      TotalChargesAmount: totals.totalChargesAmount,
      WarehouseID: newWarehouse,
      TransactionDate: transactionDate,
      DueDate: dueDate || null,
      PaymentMethod: paymentMethod,
      IsDelivered: isDelivered,
      Notes: notes,
      OpportunityID: opportunityId,
    };
    const newSnapshot = snapshot(newHeader, items, reason, names);

    if (removed.length) {
      await audit(dbTransaction, {
        tableName: 'TransactionDetails',
        actionType: 'Delete',
        primaryKey: transactionId,
        oldData: null,
        newData: { Removed: removed.map((d) => ({ ProductId: d.ProductID, Quantity: d.Quantity })) },
        username: auth.username,
      });
    }
    const added = items.filter((i) => !oldIdSet.has(i.detailId));
    if (added.length) {
      await audit(dbTransaction, {
        tableName: 'TransactionDetails',
        actionType: 'Insert',
        primaryKey: transactionId,
        oldData: null,
        newData: { Added: added.map((i) => ({ ProductId: i.productId, Quantity: i.quantity })) },
        username: auth.username,
      });
    }
    await audit(dbTransaction, {
      tableName: 'Transactions',
      actionType: 'FullEdit',
      primaryKey: transactionId,
      oldData: oldSnapshot,
      newData: newSnapshot,
      username: auth.username,
    });

    await dbTransaction.commit();

    // إشعارات الإدارة لا تعطل نجاح المعاملة.
    const message = `تم تعديل الفاتورة ${header.ReferenceNumber || `#${transactionId}`} بالكامل بقيمة ${totals.grandTotal.toFixed(2)} ج بواسطة ${auth.username}`;
    try {
      await notificationsQueries.createNotificationSmart({
        title: '🧾 تم تعديل فاتورة بالكامل',
        message,
        createdBy: auth.username,
        formName: 'sales/invoices',
        relatedTable: 'Transactions',
        relatedId: transactionId,
      }, 'Admin');
      await notificationsQueries.createNotificationSmart({
        title: '🧾 تم تعديل فاتورة بالكامل',
        message,
        createdBy: auth.username,
        formName: 'sales/invoices',
        relatedTable: 'Transactions',
        relatedId: transactionId,
      }, 'AccountManager');
    } catch (notifyError) {
      console.error('fullEdit invoice notification:', notifyError.message);
    }

    return {
      ok: true,
      status: 200,
      message: `تم حفظ التعديل الكامل للفاتورة ${header.ReferenceNumber || transactionId} بنجاح.`,
      data: {
        transactionId,
        totals,
        mirrorSyncNeeded: mirror,
      },
    };
  } catch (error) {
    try { await dbTransaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function getEditHistory(transactionId, auth) {
  const pool = await connectDB();
  const header = await getHeader(pool, transactionId);
  const access = await assertCanView(pool, header, auth);
  if (!access.ok) return access;
  if (!policy.invoices.canViewHistory(auth)) {
    return { ok: false, status: 403, message: 'سجل التعديلات متاح للمدير ومدير الحسابات فقط.' };
  }

  const result = await pool.request()
    .input('id', sql.NVarChar(100), String(transactionId))
    .query(`
      SELECT TOP 60 AuditID, ActionType, ActionDate,
             COALESCE(NULLIF(LoginName, ''), AccessUserName) AS LoginName,
             OldData, NewData
      FROM [dbo].[Audit_Log]
      WHERE TableName = N'Transactions' AND PrimaryKeyValue = @id
      ORDER BY AuditID DESC
    `);

  const entries = result.recordset.map((entry) => {
    let reason = null;
    try { reason = JSON.parse(entry.NewData || '{}').Reason || null; } catch (_) {}
    return {
      auditId: entry.AuditID,
      actionType: entry.ActionType || '',
      actionDate: entry.ActionDate,
      loginName: entry.LoginName,
      oldData: entry.OldData,
      newData: entry.NewData,
      canRestore: entry.ActionType === 'FullEdit' && Boolean(entry.OldData),
      reason,
    };
  });

  return {
    ok: true,
    data: {
      transactionId,
      referenceNumber: header.ReferenceNumber,
      createdBy: header.CreatedBy,
      createdAt: header.CreatedAt,
      editStatus: header.EditStatus,
      editReason: header.EditReason,
      editBy: header.EditBy,
      editAt: header.EditAt,
      editDone: header.EditDone,
      entries,
    },
  };
}

async function restoreSnapshot(transactionId, auditId, reason, auth) {
  if (!policy.invoices.canRestore(auth)) {
    return { ok: false, status: 403, message: 'الاسترجاع متاح للمدير ومدير الحسابات فقط.' };
  }
  const pool = await connectDB();
  const result = await pool.request()
    .input('auditId', sql.BigInt, auditId)
    .input('id', sql.NVarChar(100), String(transactionId))
    .query(`
      SELECT TOP 1 AuditID, ActionDate, OldData
      FROM [dbo].[Audit_Log]
      WHERE AuditID = @auditId AND TableName = N'Transactions'
        AND PrimaryKeyValue = @id AND ActionType = N'FullEdit'
    `);
  const entry = result.recordset[0];
  if (!entry?.OldData) return { ok: false, status: 404, message: 'لا توجد نسخة قابلة للاسترجاع في هذا السجل.' };

  let snapshotData;
  try { snapshotData = JSON.parse(entry.OldData); } catch (_) {
    return { ok: false, status: 400, message: 'تعذر قراءة النسخة المحفوظة.' };
  }
  if (!Array.isArray(snapshotData.Items) || !snapshotData.Items.length) {
    return { ok: false, status: 400, message: 'النسخة المحفوظة لا تحتوي أصنافًا.' };
  }

  return fullEditInvoice(transactionId, {
    warehouseId: snapshotData.WarehouseId,
    transactionDate: snapshotData.TransactionDate,
    dueDate: snapshotData.DueDate,
    paymentMethod: snapshotData.PaymentMethod,
    isDelivered: snapshotData.IsDelivered,
    notes: snapshotData.Notes,
    opportunityId: snapshotData.OpportunityId,
    discountAmount: snapshotData.DiscountAmount,
    discountPercentage: snapshotData.DiscountPercentage,
    discountEntryMode: snapshotData.DiscountPercentage > 0 ? 'percent' : 'amount',
    items: snapshotData.Items,
    newCharges: [],
    fullEditReason: `استرجاع نسخة بتاريخ ${entry.ActionDate?.toISOString?.() || entry.ActionDate} — ${String(reason || 'استرجاع من سجل التعديلات').trim()} — بواسطة ${auth.username}`,
  }, auth);
}

async function syncMirrorWithSale(mirrorTransactionId, auth) {
  if (!policy.invoices.canFullEdit(auth)) {
    return { ok: false, status: 403, message: 'مزامنة المرآة متاحة للمدير ومدير الحسابات فقط.' };
  }
  const pool = await connectDB();
  const mirror = await getHeader(pool, mirrorTransactionId);
  if (!mirror || mirror.InvoiceStatus === 'Cancelled') {
    return { ok: false, status: 404, message: 'فاتورة المرآة غير موجودة أو ملغاة.' };
  }
  const ref = String(mirror.ReferenceType || '');
  if (!ref.startsWith('MirrorOf:')) {
    return { ok: false, status: 400, message: 'هذه الفاتورة ليست مرآة لفاتورة بيع.' };
  }
  const saleId = Number(ref.slice('MirrorOf:'.length));
  const sale = await getHeader(pool, saleId);
  if (!sale) return { ok: false, status: 404, message: 'فاتورة البيع الأصل غير موجودة.' };

  const saleDetails = await getDetails(pool, saleId);
  const customerDetails = saleDetails.filter((d) => Number(d.Customer) === Number(sale.PartyID));
  const grouped = new Map();
  for (const detail of customerDetails) {
    const productId = Number(detail.ProductID);
    if (!grouped.has(productId)) grouped.set(productId, []);
    grouped.get(productId).push(detail);
  }

  const mirrorDetails = await getDetails(pool, mirrorTransactionId);
  const mirrorByProduct = new Map(mirrorDetails.map((d) => [Number(d.ProductID), d]));
  const items = [];
  for (const [productId, rows] of grouped) {
    const first = rows[0];
    const tier = normalizeTier(first.PricingTier);
    const quantity = rows.reduce((sum, row) => sum + num(row.Quantity), 0);
    let purchasePrice;
    if (first.SelectedAlternativeID != null) {
      purchasePrice = tier === 'CClass'
        ? num(first.AlternativePurchasePriceCClass)
        : tier === 'Elite'
          ? num(first.AlternativePurchasePriceElite, num(first.AlternativePurchasePricePremium))
          : num(first.AlternativePurchasePricePremium);
    } else {
      purchasePrice = tier === 'CClass'
        ? num(first.PurchasePriceCClass)
        : tier === 'Elite'
          ? num(first.PurchasePriceElite, num(first.PurchasePrice))
          : num(first.PurchasePrice);
    }
    items.push({
      detailId: Number(mirrorByProduct.get(productId)?.DetailID || 0),
      productId,
      quantity,
      unitPrice: purchasePrice,
      pricingTier: tier,
      selectedAlternativeId: first.SelectedAlternativeID,
      notes: `مزامنة مع فاتورة البيع ${sale.ReferenceNumber || saleId}`,
    });
  }

  if (!items.length) {
    return { ok: false, status: 400, message: 'فاتورة البيع لا تحتوي أصناف عميل للمزامنة.' };
  }

  return fullEditInvoice(mirrorTransactionId, {
    warehouseId: mirror.WarehouseID,
    transactionDate: mirror.TransactionDate,
    dueDate: mirror.DueDate,
    paymentMethod: mirror.PaymentMethod,
    isDelivered: mirror.IsDelivered,
    notes: mirror.Notes,
    discountAmount: mirror.DiscountAmount,
    discountPercentage: mirror.DiscountPercentage,
    items,
    newCharges: [],
    fullEditReason: `مزامنة تلقائية مع فاتورة البيع ${sale.ReferenceNumber || saleId}`,
  }, auth);
}

module.exports = {
  getEditModel,
  fullEditInvoice,
  getEditHistory,
  restoreSnapshot,
  syncMirrorWithSale,
  assertCanView,
  computeProfit,
};
