const { sql, connectDB } = require('../../core/database');

// جلب كل المخازن
async function getAllWarehouses() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT
        w.WarehouseID, w.WarehouseName, w.Location, w.IsActive, w.Notes,
        w.BranchID AS BranchId, b.BranchNameAr, b.BranchNameEn AS BranchName,
        ISNULL((SELECT COUNT(*) FROM StockLevels sl
                WHERE sl.WarehouseID = w.WarehouseID AND sl.Quantity != 0), 0) AS ProductsCount,
        ISNULL((SELECT SUM(sl.Quantity) FROM StockLevels sl
                WHERE sl.WarehouseID = w.WarehouseID), 0) AS TotalQuantity
      FROM Warehouses w
      LEFT JOIN Branches b ON w.BranchID = b.BranchID
      ORDER BY ISNULL(w.IsActive, 0) DESC, b.BranchNameAr, w.WarehouseName
    `);
  return result.recordset;
}

// جلب المخازن النشطة مع الفرع
async function getActiveWarehouses(branchId = null) {
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT w.WarehouseID, w.WarehouseName, w.Location, w.BranchID AS BranchId,
           b.BranchNameAr, b.BranchNameEn AS BranchName
    FROM Warehouses w
    LEFT JOIN Branches b ON w.BranchID = b.BranchID
    WHERE w.IsActive = 1
  `;
  if (branchId) {
    query += ` AND w.BranchID = @branchId`;
    request.input('branchId', sql.Int, branchId);
  }
  query += ` ORDER BY w.WarehouseName`;
  const result = await request.query(query);
  return result.recordset;
}

// جلب الفروع - مطابق بلازور BranchService
async function getBranches() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT
      BranchID AS BranchId,
      BranchCode,
      BranchNameAr,
      BranchNameEn AS BranchName,
      IsActive
    FROM Branches
    WHERE IsActive = 1
    ORDER BY BranchNameAr
  `);
  return result.recordset;
}

// جلب مستويات المخزون مع الفرع والبحث
async function getStockLevels(warehouseId = null, branchId = null, search = null) {
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT
      sl.StockLevelID, sl.ProductID, sl.WarehouseID, sl.Quantity,
      sl.LastUpdatedAt,
      p.ProductName, p.ProductDescription,
      w.WarehouseName, w.BranchID AS BranchId,
      b.BranchNameAr, b.BranchNameEn AS BranchName
    FROM StockLevels sl
    INNER JOIN Products p ON sl.ProductID = p.ProductID
    INNER JOIN Warehouses w ON sl.WarehouseID = w.WarehouseID
    LEFT JOIN Branches b ON w.BranchID = b.BranchID
    WHERE 1=1
  `;

  if (warehouseId) {
    query += ` AND sl.WarehouseID = @warehouseId`;
    request.input('warehouseId', sql.Int, warehouseId);
  }
  if (branchId) {
    query += ` AND w.BranchID = @branchId`;
    request.input('branchId', sql.Int, branchId);
  }
  if (search && String(search).trim()) {
    query += ` AND (p.ProductName LIKE @search OR p.ProductDescription LIKE @search OR CAST(p.ProductID AS VARCHAR(20)) LIKE @search)`;
    request.input('search', sql.NVarChar(200), `%${String(search).trim()}%`);
  }

  query += ` ORDER BY b.BranchNameAr, w.WarehouseName, p.ProductName`;
  const result = await request.query(query);
  return result.recordset;
}

// جلب مستوى مخزون منتج معين
async function getProductStock(productId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`
      SELECT sl.StockLevelID, sl.WarehouseID, sl.Quantity,
             w.WarehouseName, w.BranchID AS BranchId,
             b.BranchNameAr, b.BranchNameEn AS BranchName
      FROM StockLevels sl
      INNER JOIN Warehouses w ON sl.WarehouseID = w.WarehouseID
      LEFT JOIN Branches b ON w.BranchID = b.BranchID
      WHERE sl.ProductID = @productId
      ORDER BY b.BranchNameAr, w.WarehouseName
    `);
  return result.recordset;
}

// جلب حركات المخزون بكامل الفلاتر
async function getStockTransactions({
  productId = null,
  warehouseId = null,
  branchId = null,
  referenceType = null,
  search = null,
  startDate = null,
  endDate = null,
} = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT
      st.TransactionID, st.ProductID, st.WarehouseID,
      st.TransactionType, st.Quantity, st.TransactionDate,
      st.ReferenceID, st.ReferenceType, st.UnitPrice, st.TotalAmount,
      st.Notes, st.CreatedBy, st.CreatedAt,
      p.ProductName,
      w.WarehouseName, w.BranchID AS BranchId,
      b.BranchNameAr, b.BranchNameEn AS BranchName
    FROM StockTransactions st
    INNER JOIN Products p ON st.ProductID = p.ProductID
    INNER JOIN Warehouses w ON st.WarehouseID = w.WarehouseID
    LEFT JOIN Branches b ON w.BranchID = b.BranchID
    WHERE 1=1
  `;

  if (productId) {
    query += ` AND st.ProductID = @productId`;
    request.input('productId', sql.Int, productId);
  }
  if (warehouseId) {
    query += ` AND st.WarehouseID = @warehouseId`;
    request.input('warehouseId', sql.Int, warehouseId);
  }
  if (branchId) {
    query += ` AND w.BranchID = @branchId`;
    request.input('branchId', sql.Int, branchId);
  }
  if (referenceType) {
    query += ` AND st.ReferenceType = @referenceType`;
    request.input('referenceType', sql.NVarChar(80), referenceType);
  }
  if (search && String(search).trim()) {
    query += ` AND (p.ProductName LIKE @search OR w.WarehouseName LIKE @search OR st.Notes LIKE @search OR CAST(st.ReferenceID AS NVARCHAR(100)) LIKE @search)`;
    request.input('search', sql.NVarChar(200), `%${String(search).trim()}%`);
  }
  if (startDate) {
    query += ` AND CAST(st.TransactionDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }
  if (endDate) {
    query += ` AND CAST(st.TransactionDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }

  query += ` ORDER BY st.TransactionDate DESC, st.TransactionID DESC`;
  const result = await request.query(query);
  return result.recordset;
}

// إضافة حركة مخزون
async function createStockTransaction(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // إضافة الحركة
    const result = await transaction.request()
      .input('productId', sql.Int, data.productId)
      .input('warehouseId', sql.Int, data.warehouseId)
      .input('transactionType', sql.NVarChar(50), data.transactionType)
      .input('quantity', sql.Int, data.quantity)
      .input('referenceId', sql.Int, data.referenceId || null)
      .input('referenceType', sql.NVarChar(50), data.referenceType || null)
      .input('unitPrice', sql.Decimal(18, 2), data.unitPrice || null)
      .input('totalAmount', sql.Decimal(18, 2), data.totalAmount || null)
      .input('notes', sql.NVarChar(500), data.notes || null)
      .input('createdBy', sql.NVarChar(100), data.createdBy)
      .query(`
        INSERT INTO StockTransactions (
          ProductID, WarehouseID, TransactionType, Quantity,
          TransactionDate, ReferenceID, ReferenceType,
          UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.TransactionID
        VALUES (
          @productId, @warehouseId, @transactionType, @quantity,
          GETDATE(), @referenceId, @referenceType,
          @unitPrice, @totalAmount, @notes, @createdBy, GETDATE()
        )
      `);

    const transactionId = result.recordset[0].TransactionID;

    // تحديث مستوى المخزون
    const quantityChange = data.transactionType === 'In' ? data.quantity : -data.quantity;

    await transaction.request()
      .input('productId', sql.Int, data.productId)
      .input('warehouseId', sql.Int, data.warehouseId)
      .input('quantity', sql.Int, quantityChange)
      .query(`
        IF EXISTS (SELECT 1 FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId)
          UPDATE StockLevels 
          SET Quantity = Quantity + @quantity, LastUpdatedAt = GETDATE()
          WHERE ProductID = @productId AND WarehouseID = @warehouseId
        ELSE
          INSERT INTO StockLevels (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedAt)
          VALUES (@productId, @warehouseId, @quantity, GETDATE(), GETDATE())
      `);

    await transaction.commit();
    return transactionId;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// إضافة مخزن جديد
async function createWarehouse(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('warehouseName', sql.NVarChar(100), data.warehouseName)
    .input('location', sql.NVarChar(200), data.location || null)
    .input('notes', sql.NVarChar(150), data.notes || null)
    .input('branchId', sql.Int, data.branchId || null)
    .input('createdBy', sql.NVarChar(100), data.createdBy)
    .query(`
      INSERT INTO Warehouses (WarehouseName, Location, IsActive, Notes, BranchID, CreatedBy, CreatedAt)
      OUTPUT INSERTED.WarehouseID
      VALUES (@warehouseName, @location, 1, @notes, @branchId, @createdBy, GETDATE())
    `);
  return result.recordset[0].WarehouseID;
}

// تعديل مخزن
async function updateWarehouse(id, data) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('warehouseName', sql.NVarChar(100), data.warehouseName)
    .input('location', sql.NVarChar(200), data.location || null)
    .input('branchId', sql.Int, data.branchId || null)
    .input('isActive', sql.Bit, data.isActive !== undefined ? data.isActive : true)
    .input('notes', sql.NVarChar(150), data.notes || null)
    .query(`
      UPDATE Warehouses SET
        WarehouseName = @warehouseName, Location = @location,
        BranchID = @branchId, IsActive = @isActive, Notes = @notes
      WHERE WarehouseID = @id
    `);
  return true;
}

// جلب رصيد منتج في مخزن معين
async function getCurrentStock(productId, warehouseId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .input('warehouseId', sql.Int, warehouseId)
    .query(`SELECT ISNULL(Quantity,0) as Quantity FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId`);
  return result.recordset[0]?.Quantity || 0;
}

// تحويل مخزني بين مخزنين - مطابق بلازور StockService.TransferStockAsync
async function transferStock(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const { fromWarehouseId, toWarehouseId, productId, quantity, notes, createdBy } = data;

    if (!fromWarehouseId || !toWarehouseId || !productId || !quantity || quantity <= 0) {
      throw new Error('بيانات التحويل غير مكتملة');
    }

    if (fromWarehouseId == toWarehouseId) {
      throw new Error('مخزن المصدر والوجهة لا يمكن أن يكونا نفس المخزن');
    }

    // تحقق من رصيد المصدر
    const sourceStockRes = await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, fromWarehouseId)
      .query(`SELECT Quantity FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId`);

    const sourceQty = sourceStockRes.recordset[0]?.Quantity || 0;
    if (sourceQty < quantity) {
      throw new Error(`رصيد المصدر غير كافي. المتاح: ${sourceQty} والمطلوب: ${quantity}`);
    }

    // ReferenceID في قاعدة البيانات من نوع int، لذلك نستخدم رقم حركة الخروج
    // كمرجع مشترك للحركتين بدل إرسال نص إلى عمود رقمي.
    const outResult = await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, fromWarehouseId)
      .input('transactionType', sql.NVarChar(50), 'Out')
      .input('quantity', sql.Int, quantity)
      .input('referenceType', sql.NVarChar(50), 'WarehouseTransferOut')
      .input('notes', sql.NVarChar(500), notes || `تحويل إلى مخزن ${toWarehouseId}`)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO StockTransactions (
          ProductID, WarehouseID, TransactionType, Quantity,
          TransactionDate, ReferenceType, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.TransactionID
        VALUES (
          @productId, @warehouseId, @transactionType, @quantity,
          GETDATE(), @referenceType, @notes, @createdBy, GETDATE()
        )
      `);

    const transferReferenceId = outResult.recordset[0].TransactionID;
    const transferRef = `TRF-${transferReferenceId}`;

    await new sql.Request(transaction)
      .input('transactionId', sql.Int, transferReferenceId)
      .query(`
        UPDATE StockTransactions
        SET ReferenceID = @transactionId
        WHERE TransactionID = @transactionId
      `);

    // حركة دخول إلى الوجهة بنفس المرجع الرقمي
    await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, toWarehouseId)
      .input('transactionType', sql.NVarChar(50), 'In')
      .input('quantity', sql.Int, quantity)
      .input('referenceType', sql.NVarChar(50), 'WarehouseTransferIn')
      .input('referenceId', sql.Int, transferReferenceId)
      .input('notes', sql.NVarChar(500), notes || `تحويل من مخزن ${fromWarehouseId}`)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO StockTransactions (
          ProductID, WarehouseID, TransactionType, Quantity,
          TransactionDate, ReferenceType, ReferenceID, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @productId, @warehouseId, @transactionType, @quantity,
          GETDATE(), @referenceType, @referenceId, @notes, @createdBy, GETDATE()
        )
      `);

    // تحديث أرصدة
    await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('fromWarehouseId', sql.Int, fromWarehouseId)
      .input('toWarehouseId', sql.Int, toWarehouseId)
      .input('quantity', sql.Int, quantity)
      .query(`
        -- خصم من المصدر
        UPDATE StockLevels SET Quantity = Quantity - @quantity, LastUpdatedAt = GETDATE()
        WHERE ProductID = @productId AND WarehouseID = @fromWarehouseId;

        -- إضافة للوجهة
        IF EXISTS (SELECT 1 FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @toWarehouseId)
          UPDATE StockLevels SET Quantity = Quantity + @quantity, LastUpdatedAt = GETDATE()
          WHERE ProductID = @productId AND WarehouseID = @toWarehouseId
        ELSE
          INSERT INTO StockLevels (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedAt)
          VALUES (@productId, @toWarehouseId, @quantity, GETDATE(), GETDATE())
      `);

    await transaction.commit();

    // جلب الأرصدة الجديدة
    const newSource = await getCurrentStock(productId, fromWarehouseId);
    const newDest = await getCurrentStock(productId, toWarehouseId);

    return {
      success: true,
      transferReference: transferRef,
      sourceNewQuantity: newSource,
      destinationNewQuantity: newDest,
      message: `تم التحويل بنجاح ${quantity} قطعة من مخزن ${fromWarehouseId} إلى ${toWarehouseId} - المرجع ${transferRef}`,
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// تصدير الدوال
module.exports = {
  getAllWarehouses,
  getActiveWarehouses,
  getBranches,
  getStockLevels,
  getProductStock,
  getCurrentStock,
  getStockTransactions,
  createStockTransaction,
  transferStock,
  createWarehouse,
  updateWarehouse
};