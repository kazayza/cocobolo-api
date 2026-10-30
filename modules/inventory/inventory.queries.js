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

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// إضافة حركة مخزون — مرآة فحوصات بلازور StockService.AddStockEntryAsync:168-215:
// مخزن نشط فقط، مطابقة فرع المخزن للفرع المحدد، رفض منتجات العملاء المخصصة
// عند الإدخال، والمبلغ الإجمالي محسوب خادميًا (سعر الوحدة × الكمية) —
// لا يُقبل totalAmount من العميل أبدًا.
async function createStockTransaction(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const quantity = parseInt(data.quantity, 10);
    if (!data.productId || !data.warehouseId || !data.transactionType) {
      throw badRequest('البيانات غير مكتملة');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw badRequest('الكمية يجب أن تكون أكبر من صفر.');
    }
    if (!['In', 'Out'].includes(data.transactionType)) {
      throw badRequest('نوع الحركة غير صالح.');
    }

    const warehouseRes = await new sql.Request(transaction)
      .input('warehouseId', sql.Int, data.warehouseId)
      .query(`SELECT WarehouseID, BranchID, IsActive FROM Warehouses WHERE WarehouseID = @warehouseId`);
    const warehouse = warehouseRes.recordset[0];
    if (!warehouse || (warehouse.IsActive !== true && warehouse.IsActive !== 1)) {
      throw badRequest('المخزن غير موجود أو غير نشط.');
    }
    if (data.branchId && Number(warehouse.BranchID) !== Number(data.branchId)) {
      throw badRequest('المخزن المختار لا يتبع الفرع المحدد.');
    }

    const productRes = await new sql.Request(transaction)
      .input('productId', sql.Int, data.productId)
      .query(`SELECT ProductID, Customer FROM Products WHERE ProductID = @productId`);
    const product = productRes.recordset[0];
    if (!product) {
      throw badRequest('المنتج غير موجود.');
    }
    if (data.transactionType === 'In' && product.Customer != null) {
      throw badRequest('منتجات العملاء المخصصة لا تدخل مخزون المعرض ولا يمكن إضافتها من هذه الشاشة.');
    }

    const unitPrice = data.unitPrice != null && data.unitPrice !== ''
      ? Number(data.unitPrice)
      : null;
    // المبلغ محسوب خادميًا دائمًا — يُتجاهل أي totalAmount وارد من العميل
    const totalAmount = unitPrice != null && Number.isFinite(unitPrice)
      ? unitPrice * quantity
      : null;

    // إضافة الحركة
    const result = await new sql.Request(transaction)
      .input('productId', sql.Int, data.productId)
      .input('warehouseId', sql.Int, data.warehouseId)
      .input('transactionType', sql.NVarChar(50), data.transactionType)
      .input('quantity', sql.Int, quantity)
      .input('referenceId', sql.Int, data.referenceId || null)
      .input('referenceType', sql.NVarChar(50), data.referenceType || null)
      .input('unitPrice', sql.Decimal(18, 2), unitPrice)
      .input('totalAmount', sql.Decimal(18, 2), totalAmount)
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
    const quantityChange = data.transactionType === 'In' ? quantity : -quantity;

    await new sql.Request(transaction)
      .input('productId', sql.Int, data.productId)
      .input('warehouseId', sql.Int, data.warehouseId)
      .input('quantity', sql.Int, quantityChange)
      .input('createdBy', sql.NVarChar(100), data.createdBy)
      .query(`
        IF EXISTS (SELECT 1 FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId)
          UPDATE StockLevels
          SET Quantity = Quantity + @quantity, LastUpdatedAt = GETDATE()
          WHERE ProductID = @productId AND WarehouseID = @warehouseId
        ELSE
          INSERT INTO StockLevels (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedAt, CreatedBy)
          VALUES (@productId, @warehouseId, @quantity, GETDATE(), GETDATE(), @createdBy)
      `);

    await transaction.commit();
    return transactionId;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
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

// تحويل مخزني بين مخزنين — مرآة بلازور StockService.TransferStockAsync:303-390:
// كل الفحوصات داخل معاملة واحدة: مخزنا المصدر والوجهة موجودان ونشطان،
// اختلاف المخزنين، المنتج موجود وليس منتج عميل مخصصًا، كفاية رصيد المصدر،
// وسعر الوحدة من أحدث حركة مسعّرة في مخزن المصدر والمبلغ محسوب خادميًا.
// مرجع كل حركة هو المخزن الآخر كما في بلازور (ReferenceId رقمي).
async function transferStock(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const { fromWarehouseId, toWarehouseId, productId, notes, createdBy } = data;
    const quantity = parseInt(data.quantity, 10);

    if (!fromWarehouseId || !toWarehouseId || !productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw badRequest('بيانات التحويل غير مكتملة');
    }

    if (Number(fromWarehouseId) === Number(toWarehouseId)) {
      throw badRequest('لا يمكن التحويل إلى نفس المخزن.');
    }

    const warehousesRes = await new sql.Request(transaction)
      .input('fromWarehouseId', sql.Int, fromWarehouseId)
      .input('toWarehouseId', sql.Int, toWarehouseId)
      .query(`SELECT WarehouseID, WarehouseName, BranchID, IsActive FROM Warehouses WHERE WarehouseID IN (@fromWarehouseId, @toWarehouseId)`);
    const fromWarehouse = warehousesRes.recordset.find((w) => Number(w.WarehouseID) === Number(fromWarehouseId));
    const toWarehouse = warehousesRes.recordset.find((w) => Number(w.WarehouseID) === Number(toWarehouseId));
    const isActive = (w) => w && (w.IsActive === true || w.IsActive === 1);
    if (!isActive(fromWarehouse) || !isActive(toWarehouse)) {
      throw badRequest('مخزن المصدر أو الوجهة غير موجود أو غير نشط.');
    }
    if (data.fromBranchId && Number(fromWarehouse.BranchID) !== Number(data.fromBranchId)) {
      throw badRequest('المخازن المختارة لا تتبع الفروع المحددة.');
    }
    if (data.toBranchId && Number(toWarehouse.BranchID) !== Number(data.toBranchId)) {
      throw badRequest('المخازن المختارة لا تتبع الفروع المحددة.');
    }

    const productRes = await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .query(`SELECT ProductID, Customer FROM Products WHERE ProductID = @productId`);
    const product = productRes.recordset[0];
    if (!product) {
      throw badRequest('المنتج غير موجود.');
    }
    if (product.Customer != null) {
      throw badRequest('منتجات العملاء المخصصة لا تدخل التحويلات المخزنية الخاصة بالمعرض.');
    }

    // تحقق من رصيد المصدر
    const sourceStockRes = await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, fromWarehouseId)
      .query(`SELECT Quantity FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId`);

    const sourceQty = sourceStockRes.recordset[0]?.Quantity || 0;
    if (sourceQty < quantity) {
      throw badRequest('الكمية المتاحة في مخزن المصدر لا تكفي للتحويل.');
    }

    // أحدث سعر وحدة مسجل للمنتج في مخزن المصدر (كما في بلازور)
    const priceRes = await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, fromWarehouseId)
      .query(`
        SELECT TOP 1 UnitPrice FROM StockTransactions
        WHERE ProductID = @productId AND WarehouseID = @warehouseId AND UnitPrice IS NOT NULL
        ORDER BY TransactionDate DESC, TransactionID DESC
      `);
    const unitPrice = priceRes.recordset[0]?.UnitPrice ?? null;
    const totalAmount = unitPrice != null ? Number(unitPrice) * quantity : null;

    const now = new Date();
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const transferRef = `TR-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
    const extraNotes = notes && String(notes).trim() ? ` | ${String(notes).trim()}` : '';

    await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, fromWarehouseId)
      .input('quantity', sql.Int, quantity)
      .input('referenceId', sql.Int, toWarehouseId)
      .input('unitPrice', sql.Decimal(18, 2), unitPrice)
      .input('totalAmount', sql.Decimal(18, 2), totalAmount)
      .input('notes', sql.NVarChar(500), `تحويل مخزني ${transferRef} إلى ${toWarehouse.WarehouseName}${extraNotes}`)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO StockTransactions (
          ProductID, WarehouseID, TransactionType, Quantity,
          TransactionDate, ReferenceID, ReferenceType,
          UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @productId, @warehouseId, 'Out', @quantity,
          GETDATE(), @referenceId, 'WarehouseTransferOut',
          @unitPrice, @totalAmount, @notes, @createdBy, GETDATE()
        )
      `);

    await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('warehouseId', sql.Int, toWarehouseId)
      .input('quantity', sql.Int, quantity)
      .input('referenceId', sql.Int, fromWarehouseId)
      .input('unitPrice', sql.Decimal(18, 2), unitPrice)
      .input('totalAmount', sql.Decimal(18, 2), totalAmount)
      .input('notes', sql.NVarChar(500), `تحويل مخزني ${transferRef} من ${fromWarehouse.WarehouseName}${extraNotes}`)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO StockTransactions (
          ProductID, WarehouseID, TransactionType, Quantity,
          TransactionDate, ReferenceID, ReferenceType,
          UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @productId, @warehouseId, 'In', @quantity,
          GETDATE(), @referenceId, 'WarehouseTransferIn',
          @unitPrice, @totalAmount, @notes, @createdBy, GETDATE()
        )
      `);

    // تحديث أرصدة
    await new sql.Request(transaction)
      .input('productId', sql.Int, productId)
      .input('fromWarehouseId', sql.Int, fromWarehouseId)
      .input('toWarehouseId', sql.Int, toWarehouseId)
      .input('quantity', sql.Int, quantity)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        UPDATE StockLevels SET Quantity = Quantity - @quantity, LastUpdatedAt = GETDATE()
        WHERE ProductID = @productId AND WarehouseID = @fromWarehouseId;

        IF EXISTS (SELECT 1 FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @toWarehouseId)
          UPDATE StockLevels SET Quantity = Quantity + @quantity, LastUpdatedAt = GETDATE()
          WHERE ProductID = @productId AND WarehouseID = @toWarehouseId
        ELSE
          INSERT INTO StockLevels (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedAt, CreatedBy)
          VALUES (@productId, @toWarehouseId, @quantity, GETDATE(), GETDATE(), @createdBy)
      `);

    await transaction.commit();

    const newSource = await getCurrentStock(productId, fromWarehouseId);
    const newDest = await getCurrentStock(productId, toWarehouseId);

    return {
      success: true,
      transferReference: transferRef,
      sourceNewQuantity: newSource,
      destinationNewQuantity: newDest,
      message: 'تم التحويل المخزني بنجاح.',
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════
// الجرد المخزني — مرآة بلازور StockService:
// GetStockCountWorkspaceAsync / GetStockCountsAsync /
// SaveStockCountDraftAsync:650 / FinalizeStockCountAsync:757
// ══════════════════════════════════════════════════════════════

async function getStockCountWorkspace(warehouseId, stockCountId = null) {
  const pool = await connectDB();

  if (stockCountId) {
    const headerRes = await pool.request()
      .input('stockCountId', sql.Int, stockCountId)
      .query(`
        SELECT h.StockCountID AS StockCountId, h.BranchID AS BranchId, b.BranchNameAr, h.WarehouseID AS WarehouseId,
               w.WarehouseName, h.CountDate, h.Status, h.Notes,
               h.CreatedBy, h.CreatedAt, h.FinalizedBy, h.FinalizedAt
        FROM StockCountHeaders h
        LEFT JOIN Branches b ON h.BranchID = b.BranchID
        LEFT JOIN Warehouses w ON h.WarehouseID = w.WarehouseID
        WHERE h.StockCountID = @stockCountId
      `);
    const header = headerRes.recordset[0];
    if (!header) return null;
    const linesRes = await pool.request()
      .input('stockCountId', sql.Int, stockCountId)
      .query(`
        SELECT l.StockCountLineID AS StockCountLineId, l.ProductID AS ProductId, p.ProductName,
               l.SystemQty, l.ActualQty, l.DifferenceQty, l.Notes
        FROM StockCountLines l
        INNER JOIN Products p ON l.ProductID = p.ProductID
        WHERE l.StockCountID = @stockCountId
        ORDER BY p.ProductName
      `);
    return { ...header, Lines: linesRes.recordset };
  }

  const warehouseRes = await pool.request()
    .input('warehouseId', sql.Int, warehouseId)
    .query(`
      SELECT w.WarehouseID AS WarehouseId, w.WarehouseName, w.BranchID AS BranchId,
             b.BranchNameAr, w.IsActive
      FROM Warehouses w
      LEFT JOIN Branches b ON w.BranchID = b.BranchID
      WHERE w.WarehouseID = @warehouseId
    `);
  const warehouse = warehouseRes.recordset[0];
  if (!warehouse || (warehouse.IsActive !== true && warehouse.IsActive !== 1) || warehouse.BranchId == null) {
    return null;
  }

  const linesRes = await pool.request()
    .input('warehouseId', sql.Int, warehouseId)
    .query(`
      SELECT sl.ProductID AS ProductId, p.ProductName,
             sl.Quantity AS SystemQty, sl.Quantity AS ActualQty,
             0 AS DifferenceQty, CAST(NULL AS NVARCHAR(500)) AS Notes
      FROM StockLevels sl
      INNER JOIN Products p ON sl.ProductID = p.ProductID
      WHERE sl.WarehouseID = @warehouseId AND p.Customer IS NULL
      ORDER BY p.ProductName
    `);

  return {
    StockCountId: null,
    BranchId: warehouse.BranchId,
    BranchNameAr: warehouse.BranchNameAr || '',
    WarehouseId: warehouse.WarehouseId,
    WarehouseName: warehouse.WarehouseName,
    CountDate: new Date(),
    Status: 'Draft',
    Notes: null,
    Lines: linesRes.recordset,
  };
}

async function getStockCounts({ branchId = null, warehouseId = null } = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT h.StockCountID AS StockCountId, h.BranchID AS BranchId, b.BranchNameAr, h.WarehouseID AS WarehouseId,
           w.WarehouseName, h.CountDate, h.Status, h.CreatedBy, h.CreatedAt,
           h.FinalizedBy, h.FinalizedAt,
           (SELECT COUNT(*) FROM StockCountLines l WHERE l.StockCountID = h.StockCountID) AS LinesCount,
           (SELECT COUNT(*) FROM StockCountLines l WHERE l.StockCountID = h.StockCountID AND l.DifferenceQty != 0) AS DifferenceItemsCount
    FROM StockCountHeaders h
    LEFT JOIN Branches b ON h.BranchID = b.BranchID
    LEFT JOIN Warehouses w ON h.WarehouseID = w.WarehouseID
    WHERE 1=1
  `;
  if (branchId) {
    query += ` AND h.BranchId = @branchId`;
    request.input('branchId', sql.Int, branchId);
  }
  if (warehouseId) {
    query += ` AND h.WarehouseId = @warehouseId`;
    request.input('warehouseId', sql.Int, warehouseId);
  }
  query += ` ORDER BY h.CountDate DESC, h.StockCountId DESC`;
  const result = await request.query(query);
  return result.recordset;
}

// حفظ مسودة جرد — التحقق يطابق SaveStockCountDraftAsync:650:
// فرع ومخزن مطلوبان، بنود غير فارغة، مخزن نشط تابع للفرع،
// مستند بحالة Draft وبنوده تُستبدل بالكامل وDifferenceQty = الفعلي − النظام.
async function saveStockCountDraft(dto, currentUserName) {
  if (!dto.branchId || Number(dto.branchId) <= 0) throw badRequest('اختيار الفرع مطلوب.');
  if (!dto.warehouseId || Number(dto.warehouseId) <= 0) throw badRequest('اختيار المخزن مطلوب.');
  if (!Array.isArray(dto.lines) || dto.lines.length === 0) throw badRequest('لا توجد أصناف للجرد.');

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const warehouseRes = await new sql.Request(transaction)
      .input('warehouseId', sql.Int, dto.warehouseId)
      .query(`SELECT WarehouseID, BranchID, IsActive FROM Warehouses WHERE WarehouseID = @warehouseId`);
    const warehouse = warehouseRes.recordset[0];
    if (!warehouse || (warehouse.IsActive !== true && warehouse.IsActive !== 1)
      || Number(warehouse.BranchID) !== Number(dto.branchId)) {
      throw badRequest('المخزن المختار لا يتبع الفرع المحدد.');
    }

    let stockCountId = dto.stockCountId ? Number(dto.stockCountId) : null;

    if (!stockCountId) {
      const headerRes = await new sql.Request(transaction)
        .input('branchId', sql.Int, dto.branchId)
        .input('warehouseId', sql.Int, dto.warehouseId)
        .input('countDate', sql.DateTime, dto.countDate ? new Date(dto.countDate) : new Date())
        .input('notes', sql.NVarChar(500), dto.notes || null)
        .input('createdBy', sql.NVarChar(100), currentUserName)
        .query(`
          INSERT INTO StockCountHeaders (BranchID, WarehouseID, CountDate, Status, Notes, CreatedBy, CreatedAt)
          OUTPUT INSERTED.StockCountID
          VALUES (@branchId, @warehouseId, @countDate, 'Draft', @notes, @createdBy, GETDATE())
        `);
      stockCountId = headerRes.recordset[0].StockCountId;
    } else {
      const existingRes = await new sql.Request(transaction)
        .input('stockCountId', sql.Int, stockCountId)
        .query(`SELECT StockCountID AS StockCountId, Status FROM StockCountHeaders WHERE StockCountID = @stockCountId`);
      const existing = existingRes.recordset[0];
      if (!existing) throw badRequest('مستند الجرد غير موجود.');
      if (String(existing.Status).toLowerCase() === 'finalized') {
        throw badRequest('لا يمكن تعديل جرد معتمد.');
      }
      await new sql.Request(transaction)
        .input('stockCountId', sql.Int, stockCountId)
        .input('branchId', sql.Int, dto.branchId)
        .input('warehouseId', sql.Int, dto.warehouseId)
        .input('countDate', sql.DateTime, dto.countDate ? new Date(dto.countDate) : null)
        .input('notes', sql.NVarChar(500), dto.notes || null)
        .query(`
          UPDATE StockCountHeaders SET
            BranchID = @branchId, WarehouseID = @warehouseId,
            CountDate = ISNULL(@countDate, CountDate), Notes = @notes
          WHERE StockCountID = @stockCountId;
          DELETE FROM StockCountLines WHERE StockCountID = @stockCountId;
        `);
    }

    for (const line of dto.lines) {
      const systemQty = parseInt(line.systemQty, 10) || 0;
      const actualQty = parseInt(line.actualQty, 10) || 0;
      await new sql.Request(transaction)
        .input('stockCountId', sql.Int, stockCountId)
        .input('productId', sql.Int, line.productId)
        .input('systemQty', sql.Int, systemQty)
        .input('actualQty', sql.Int, actualQty)
        .input('differenceQty', sql.Int, actualQty - systemQty)
        .input('notes', sql.NVarChar(500), line.notes || null)
        .query(`
          INSERT INTO StockCountLines (StockCountID, ProductID, SystemQty, ActualQty, DifferenceQty, Notes)
          VALUES (@stockCountId, @productId, @systemQty, @actualQty, @differenceQty, @notes)
        `);
    }

    await transaction.commit();
    return stockCountId;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// اعتماد جرد — يطابق FinalizeStockCountAsync:757: الفرق يُعاد حسابه
// مقابل الرصيد الحالي لحظة الاعتماد (لا فرق المسودة)، يُضبط الرصيد
// إلى الكمية الفعلية، وتُنشأ حركات StockCountAdjustmentIn/Out
// بمرجع رقم الجرد — كل ذلك في معاملة واحدة.
async function finalizeStockCount(stockCountId, currentUserName) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const headerRes = await new sql.Request(transaction)
      .input('stockCountId', sql.Int, stockCountId)
      .query(`SELECT StockCountID AS StockCountId, WarehouseID AS WarehouseId, Status FROM StockCountHeaders WHERE StockCountID = @stockCountId`);
    const header = headerRes.recordset[0];
    if (!header) throw badRequest('مستند الجرد غير موجود.');
    if (String(header.Status).toLowerCase() === 'finalized') {
      throw badRequest('هذا الجرد معتمد بالفعل.');
    }

    const linesRes = await new sql.Request(transaction)
      .input('stockCountId', sql.Int, stockCountId)
      .query(`SELECT ProductID AS ProductId, ActualQty, Notes FROM StockCountLines WHERE StockCountID = @stockCountId`);
    const lines = linesRes.recordset;

    for (const line of lines) {
      const stockRes = await new sql.Request(transaction)
        .input('productId', sql.Int, line.ProductId)
        .input('warehouseId', sql.Int, header.WarehouseId)
        .query(`SELECT Quantity FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId`);
      const currentQty = stockRes.recordset[0]?.Quantity || 0;
      const delta = line.ActualQty - currentQty;

      await new sql.Request(transaction)
        .input('productId', sql.Int, line.ProductId)
        .input('warehouseId', sql.Int, header.WarehouseId)
        .input('actualQty', sql.Int, line.ActualQty)
        .input('createdBy', sql.NVarChar(100), currentUserName)
        .query(`
          IF EXISTS (SELECT 1 FROM StockLevels WHERE ProductID = @productId AND WarehouseID = @warehouseId)
            UPDATE StockLevels SET Quantity = @actualQty, LastUpdatedAt = GETDATE()
            WHERE ProductID = @productId AND WarehouseID = @warehouseId
          ELSE
            INSERT INTO StockLevels (ProductID, WarehouseID, Quantity, LastUpdatedAt, CreatedAt, CreatedBy)
            VALUES (@productId, @warehouseId, @actualQty, GETDATE(), GETDATE(), @createdBy)
        `);

      if (delta !== 0) {
        await new sql.Request(transaction)
          .input('productId', sql.Int, line.ProductId)
          .input('warehouseId', sql.Int, header.WarehouseId)
          .input('transactionType', sql.NVarChar(50), delta > 0 ? 'In' : 'Out')
          .input('quantity', sql.Int, Math.abs(delta))
          .input('referenceId', sql.Int, stockCountId)
          .input('referenceType', sql.NVarChar(50), delta > 0 ? 'StockCountAdjustmentIn' : 'StockCountAdjustmentOut')
          .input('notes', sql.NVarChar(500), `تسوية جرد رقم #${stockCountId}${line.Notes ? ` | ${line.Notes}` : ''}`)
          .input('createdBy', sql.NVarChar(100), currentUserName)
          .query(`
            INSERT INTO StockTransactions (
              ProductID, WarehouseID, TransactionType, Quantity,
              TransactionDate, ReferenceID, ReferenceType,
              UnitPrice, TotalAmount, Notes, CreatedBy, CreatedAt
            )
            VALUES (
              @productId, @warehouseId, @transactionType, @quantity,
              GETDATE(), @referenceId, @referenceType,
              NULL, NULL, @notes, @createdBy, GETDATE()
            )
          `);
      }
    }

    await new sql.Request(transaction)
      .input('stockCountId', sql.Int, stockCountId)
      .input('finalizedBy', sql.NVarChar(100), currentUserName)
      .query(`
        UPDATE StockCountHeaders
        SET Status = 'Finalized', FinalizedAt = GETDATE(), FinalizedBy = @finalizedBy
        WHERE StockCountID = @stockCountId
      `);

    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// قيمة المخزون — مرآة GetStockValueAsync:859: مخازن نشطة فقط، كمية > 0،
// سعر الباقة المختارة مع السقوط للسعر الأساسي، ترتيب تنازلي بقيمة البيع،
// وملخص يشمل الربح المتوقع.
async function getStockValue({ branchId = null, warehouseId = null, priceTier = null } = {}) {
  const tier = !priceTier || !String(priceTier).trim() ? 'Premium' : String(priceTier).trim();
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT sl.ProductID AS ProductId, p.ProductName,
           sl.WarehouseID AS WarehouseId, w.WarehouseName,
           w.BranchID AS BranchId, b.BranchNameAr,
           sl.Quantity,
           p.PurchasePrice, p.PurchasePriceCClass, p.PurchasePriceElite,
           p.SuggestedSalePrice, p.SuggestedSalePriceCClass, p.SuggestedSalePriceElite
    FROM StockLevels sl
    INNER JOIN Warehouses w ON sl.WarehouseID = w.WarehouseID AND w.IsActive = 1
    INNER JOIN Products p ON sl.ProductID = p.ProductID
    LEFT JOIN Branches b ON w.BranchID = b.BranchID
    WHERE sl.Quantity > 0
  `;
  if (branchId) {
    query += ` AND w.BranchID = @branchId`;
    request.input('branchId', sql.Int, branchId);
  }
  if (warehouseId) {
    query += ` AND sl.WarehouseID = @warehouseId`;
    request.input('warehouseId', sql.Int, warehouseId);
  }
  const result = await request.query(query);

  const pickPrice = (basePrice, cclass, elite) => {
    if (tier === 'CClass') return cclass ?? basePrice ?? 0;
    if (tier === 'Elite') return elite ?? basePrice ?? 0;
    return basePrice ?? cclass ?? elite ?? 0;
  };

  const rows = result.recordset.map((x) => {
    const unitCost = Number(pickPrice(x.PurchasePrice, x.PurchasePriceCClass, x.PurchasePriceElite)) || 0;
    const unitSalePrice = Number(pickPrice(x.SuggestedSalePrice, x.SuggestedSalePriceCClass, x.SuggestedSalePriceElite)) || 0;
    const costValue = x.Quantity * unitCost;
    const saleValue = x.Quantity * unitSalePrice;
    return {
      ProductId: x.ProductId,
      ProductName: x.ProductName,
      WarehouseId: x.WarehouseId,
      WarehouseName: x.WarehouseName,
      BranchId: x.BranchId,
      BranchNameAr: x.BranchNameAr,
      Quantity: x.Quantity,
      UnitCost: unitCost,
      UnitSalePrice: unitSalePrice,
      CostValue: costValue,
      SaleValue: saleValue,
      ExpectedProfit: saleValue - costValue,
    };
  }).sort((a, b) => b.SaleValue - a.SaleValue);

  const summary = {
    TotalCostValue: rows.reduce((s, r) => s + r.CostValue, 0),
    TotalSaleValue: rows.reduce((s, r) => s + r.SaleValue, 0),
    TotalExpectedProfit: rows.reduce((s, r) => s + r.ExpectedProfit, 0),
    TotalProducts: new Set(rows.map((r) => r.ProductId)).size,
    TotalQuantity: rows.reduce((s, r) => s + r.Quantity, 0),
    WarehousesCount: new Set(rows.map((r) => r.WarehouseId)).size,
  };

  return { rows, summary, priceTier: tier };
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
  updateWarehouse,
  getStockCountWorkspace,
  getStockCounts,
  saveStockCountDraft,
  finalizeStockCount,
  getStockValue
};