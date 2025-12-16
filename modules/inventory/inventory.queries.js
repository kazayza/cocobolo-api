const { sql, connectDB } = require('../../core/database');

// جلب كل المخازن
async function getAllWarehouses() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT WarehouseID, WarehouseName, Location, IsActive, Notes
      FROM Warehouses
      ORDER BY WarehouseName
    `);
  return result.recordset;
}

// جلب المخازن النشطة
async function getActiveWarehouses() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT WarehouseID, WarehouseName, Location
      FROM Warehouses
      WHERE IsActive = 1
      ORDER BY WarehouseName
    `);
  return result.recordset;
}

// جلب مستويات المخزون
async function getStockLevels(warehouseId = null) {
  const pool = await connectDB();
  let query = `
    SELECT 
      sl.StockLevelID, sl.ProductID, sl.WarehouseID, sl.Quantity,
      sl.LastUpdatedAt,
      p.ProductName, p.ProductDescription,
      w.WarehouseName
    FROM StockLevels sl
    INNER JOIN Products p ON sl.ProductID = p.ProductID
    INNER JOIN Warehouses w ON sl.WarehouseID = w.WarehouseID
    WHERE 1=1
  `;

  const request = pool.request();

  if (warehouseId) {
    query += ` AND sl.WarehouseID = @warehouseId`;
    request.input('warehouseId', sql.Int, warehouseId);
  }

  query += ` ORDER BY p.ProductName`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب مستوى مخزون منتج معين
async function getProductStock(productId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('productId', sql.Int, productId)
    .query(`
      SELECT 
        sl.StockLevelID, sl.WarehouseID, sl.Quantity,
        w.WarehouseName
      FROM StockLevels sl
      INNER JOIN Warehouses w ON sl.WarehouseID = w.WarehouseID
      WHERE sl.ProductID = @productId
    `);
  return result.recordset;
}

// جلب حركات المخزون
async function getStockTransactions(productId = null, warehouseId = null, startDate = null, endDate = null) {
  const pool = await connectDB();
  let query = `
    SELECT 
      st.TransactionID, st.ProductID, st.WarehouseID,
      st.TransactionType, st.Quantity, st.TransactionDate,
      st.ReferenceID, st.ReferenceType, st.UnitPrice, st.TotalAmount,
      st.Notes, st.CreatedBy, st.CreatedAt,
      p.ProductName,
      w.WarehouseName
    FROM StockTransactions st
    INNER JOIN Products p ON st.ProductID = p.ProductID
    INNER JOIN Warehouses w ON st.WarehouseID = w.WarehouseID
    WHERE 1=1
  `;

  const request = pool.request();

  if (productId) {
    query += ` AND st.ProductID = @productId`;
    request.input('productId', sql.Int, productId);
  }

  if (warehouseId) {
    query += ` AND st.WarehouseID = @warehouseId`;
    request.input('warehouseId', sql.Int, warehouseId);
  }

  if (startDate) {
    query += ` AND CAST(st.TransactionDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }

  if (endDate) {
    query += ` AND CAST(st.TransactionDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }

  query += ` ORDER BY st.TransactionDate DESC`;

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
    .input('createdBy', sql.NVarChar(100), data.createdBy)
    .query(`
      INSERT INTO Warehouses (WarehouseName, Location, IsActive, Notes, CreatedBy, CreatedAt)
      OUTPUT INSERTED.WarehouseID
      VALUES (@warehouseName, @location, 1, @notes, @createdBy, GETDATE())
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
    .input('isActive', sql.Bit, data.isActive !== undefined ? data.isActive : true)
    .input('notes', sql.NVarChar(150), data.notes || null)
    .query(`
      UPDATE Warehouses SET
        WarehouseName = @warehouseName, Location = @location,
        IsActive = @isActive, Notes = @notes
      WHERE WarehouseID = @id
    `);
  return true;
}

// تصدير الدوال
module.exports = {
  getAllWarehouses,
  getActiveWarehouses,
  getStockLevels,
  getProductStock,
  getStockTransactions,
  createStockTransaction,
  createWarehouse,
  updateWarehouse
};