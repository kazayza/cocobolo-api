const { sql, connectDB } = require('../../core/database');

// جلب كل الفواتير
async function getAllTransactions(type = null, startDate = null, endDate = null, partyId = null) {
  const pool = await connectDB();

  let query = `
    SELECT 
      t.TransactionID, t.TransactionDate, t.TransactionType,
      t.TotalAmount, t.DiscountPercentage, t.DiscountAmount,
      t.NetTotalAmount, t.PaidAmount, t.TotalChargesAmount,
      t.GrandTotal, t.PaymentMethod, t.Notes,
      t.CreatedBy, t.CreatedAt,
      p.PartyID, p.PartyName, p.Phone,
      w.WarehouseID, w.WarehouseName,
      (t.GrandTotal - t.PaidAmount) AS RemainingAmount
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
    WHERE 1=1
  `;

  const request = pool.request();

  if (type) {
    query += ` AND t.TransactionType = @type`;
    request.input('type', sql.VarChar(20), type);
  }

  if (startDate) {
    query += ` AND CAST(t.TransactionDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }

  if (endDate) {
    query += ` AND CAST(t.TransactionDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }

  if (partyId) {
    query += ` AND t.PartyID = @partyId`;
    request.input('partyId', sql.Int, partyId);
  }

  query += ` ORDER BY t.TransactionDate DESC, t.TransactionID DESC`;

  const result = await request.query(query);
  return result.recordset;
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
        e.FullName AS EmployeeName
      FROM Transactions t
      INNER JOIN Parties p ON t.PartyID = p.PartyID
      INNER JOIN Warehouses w ON t.WarehouseID = w.WarehouseID
      LEFT JOIN Employees e ON t.EmpId = e.EmployeeID
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

// إنشاء فاتورة جديدة
async function createTransaction(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // إنشاء الفاتورة
    const result = await transaction.request()
      .input('transactionDate', sql.DateTime, data.transactionDate || new Date())
      .input('partyId', sql.Int, data.partyId)
      .input('transactionType', sql.VarChar(20), data.transactionType)
      .input('warehouseId', sql.Int, data.warehouseId)
      .input('empId', sql.Int, data.empId || null)
      .input('totalAmount', sql.Decimal(18, 2), data.totalAmount || 0)
      .input('discountPercentage', sql.Decimal(5, 2), data.discountPercentage || 0)
      .input('discountAmount', sql.Decimal(18, 2), data.discountAmount || 0)
      .input('netTotalAmount', sql.Decimal(18, 2), data.netTotalAmount || 0)
      .input('paidAmount', sql.Decimal(18, 2), data.paidAmount || 0)
      .input('totalChargesAmount', sql.Decimal(18, 2), data.totalChargesAmount || 0)
      .input('grandTotal', sql.Decimal(18, 2), data.grandTotal || 0)
      .input('paymentMethod', sql.NVarChar(20), data.paymentMethod || null)
      .input('notes', sql.NVarChar(255), data.notes || null)
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO Transactions (
          TransactionDate, PartyID, TransactionType, WarehouseID, EmpId,
          TotalAmount, DiscountPercentage, DiscountAmount, NetTotalAmount,
          PaidAmount, TotalChargesAmount, GrandTotal, PaymentMethod,
          Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.TransactionID
        VALUES (
          @transactionDate, @partyId, @transactionType, @warehouseId, @empId,
          @totalAmount, @discountPercentage, @discountAmount, @netTotalAmount,
          @paidAmount, @totalChargesAmount, @grandTotal, @paymentMethod,
          @notes, @createdBy, GETDATE()
        )
      `);

    const transactionId = result.recordset[0].TransactionID;

    // إضافة التفاصيل
    if (data.details && data.details.length > 0) {
      for (const detail of data.details) {
        await transaction.request()
          .input('transactionId', sql.Int, transactionId)
          .input('productId', sql.Int, detail.productId)
          .input('quantity', sql.Decimal(18, 3), detail.quantity)
          .input('unitPrice', sql.Decimal(18, 2), detail.unitPrice)
          .input('notes', sql.NVarChar(255), detail.notes || null)
          .query(`
            INSERT INTO TransactionDetails (TransactionID, ProductID, Quantity, UnitPrice, Notes)
            VALUES (@transactionId, @productId, @quantity, @unitPrice, @notes)
          `);
      }
    }

    // إضافة الرسوم
    if (data.charges && data.charges.length > 0) {
      for (const charge of data.charges) {
        await transaction.request()
          .input('transactionId', sql.Int, transactionId)
          .input('chargeDescription', sql.NVarChar(255), charge.description)
          .input('chargeAmount', sql.Decimal(18, 2), charge.amount)
          .input('createdBy', sql.NVarChar(50), data.createdBy)
          .query(`
            INSERT INTO AdditionalCharges (TransactionID, ChargeDescription, ChargeAmount, CreatedBy, CreatedAt)
            VALUES (@transactionId, @chargeDescription, @chargeAmount, @createdBy, GETDATE())
          `);
      }
    }

    await transaction.commit();
    return transactionId;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// إضافة دفعة
async function addPayment(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // إضافة الدفعة
    const result = await transaction.request()
      .input('transactionId', sql.Int, data.transactionId)
      .input('paymentDate', sql.DateTime, data.paymentDate || new Date())
      .input('amount', sql.Decimal(18, 2), data.amount)
      .input('paymentMethod', sql.NVarChar(50), data.paymentMethod || null)
      .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
      .input('createdBy', sql.NVarChar(50), data.createdBy)
      .query(`
        INSERT INTO Payments (
          TransactionID, PaymentDate, Amount, PaymentMethod, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.PaymentID
        VALUES (
          @transactionId, @paymentDate, @amount, @paymentMethod, @notes, @createdBy, GETDATE()
        )
      `);

    const paymentId = result.recordset[0].PaymentID;

    // تحديث المبلغ المدفوع في الفاتورة
    await transaction.request()
      .input('transactionId', sql.Int, data.transactionId)
      .input('amount', sql.Decimal(18, 2), data.amount)
      .query(`
        UPDATE Transactions 
        SET PaidAmount = PaidAmount + @amount
        WHERE TransactionID = @transactionId
      `);

    await transaction.commit();
    return paymentId;
  } catch (err) {
    await transaction.rollback();
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

// طلب تعديل فاتورة (المندوب/أي مخول)
async function requestEdit(transactionId, requestedBy, reason) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, transactionId)
    .input('editBy', sql.NVarChar(50), requestedBy)
    .input('editReason', sql.NVarChar(500), reason || null)
    .query(`
      UPDATE Transactions 
      SET EditStatus = 1, EditBy = @editBy, 
          EditRequestDate = GETDATE(), EditReason = @editReason
      WHERE TransactionID = @id
    `);
  return true;
}

// قائمة طلبات التعديل المعلقة (للإشعارات والمراجعة)
async function getPendingEditRequests() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT 
      t.TransactionID, t.TransactionDate, t.GrandTotal,
      t.EditBy, t.EditRequestDate, t.EditReason,
      p.PartyName AS ClientName
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.EditStatus = 1
    ORDER BY t.EditRequestDate DESC
  `);
  return result.recordset;
}

// موافقة على طلب التعديل
async function approveEditRequest(transactionId, approvedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, transactionId)
    .input('by', sql.NVarChar(50), approvedBy)
    .query(`
      UPDATE Transactions 
      SET EditStatus = 2, EditDone = @by
      WHERE TransactionID = @id AND EditStatus = 1
    `);
  return true;
}

// رفض طلب التعديل
async function rejectEditRequest(transactionId, rejectedBy, reason) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, transactionId)
    .input('by', sql.NVarChar(50), rejectedBy)
    .input('reason', sql.NVarChar(500), reason || null)
    .query(`
      UPDATE Transactions 
      SET EditStatus = 3, EditDone = @by, EditReason = @reason
      WHERE TransactionID = @id AND EditStatus = 1
    `);
  return true;
}

// تعديل فعلي: تاريخ التسليم + الخصم + مبلغ صنف + تسجيل PriceHistory
async function applyInvoiceEdit({
  transactionId,
  dueDate,            // تاريخ التسليم الجديد
  discountPercentage, // نسبة الخصم الجديدة
  discountAmount,     // قيمة الخصم الجديدة
  editedBy,
}) {
  const pool = await connectDB();
  const request = pool.request()
    .input('id', sql.Int, transactionId)
    .input('editedBy', sql.NVarChar(50), editedBy);

  let query = `
    UPDATE Transactions SET
      EditStatus = 4, EditDone = @editedBy, EditAt = GETDATE()
  `;

  if (dueDate) {
    request.input('dueDate', sql.DateTime, new Date(dueDate));
    query += `, DueDate = @dueDate`;
  }
  if (discountPercentage !== undefined && discountPercentage !== null) {
    request.input('discPct', sql.Decimal(5, 2), discountPercentage);
    query += `, DiscountPercentage = @discPct`;
  }
  if (discountAmount !== undefined && discountAmount !== null) {
    request.input('discAmt', sql.Decimal(18, 2), discountAmount);
    query += `, DiscountAmount = @discAmt`;
  }

  // إعادة حساب NetTotalAmount و GrandTotal (لو في خصم)
  // NetTotal = TotalAmount - DiscountAmount (أو نسبة من TotalAmount)
  // GrandTotal = NetTotal + TotalChargesAmount
  query += `,
    NetTotalAmount = ISNULL(TotalAmount,0) 
      - CASE 
          WHEN DiscountAmount > 0 THEN DiscountAmount 
          WHEN DiscountPercentage > 0 THEN ISNULL(TotalAmount,0) * DiscountPercentage / 100 
          ELSE 0 
        END,
    GrandTotal = ISNULL(TotalAmount,0) 
      - CASE 
          WHEN DiscountAmount > 0 THEN DiscountAmount 
          WHEN DiscountPercentage > 0 THEN ISNULL(TotalAmount,0) * DiscountPercentage / 100 
          ELSE 0 
        END 
      + ISNULL(TotalChargesAmount,0)
  `;

  query += ` WHERE TransactionID = @id`;
  await request.query(query);
  return true;
}

// تعديل مبلغ صنف في الفاتورة + تسجيل في PriceHistory
async function updateDetailPrice(transactionId, detailId, newUnitPrice, editedBy, changeReason) {
  const pool = await connectDB();

  // 1. جلب السعر القديم
  const oldRes = await pool.request()
    .input('detailId', sql.Int, detailId)
    .query(`
      SELECT td.UnitPrice, td.ProductID, td.Quantity
      FROM TransactionDetails td
      WHERE td.DetailID = @detailId
    `);
  const old = oldRes.recordset[0];
  if (!old) return { success: false, message: 'الصنف غير موجود' };

  // 2. تحديث السعر + الإجمالي
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

  // 4. إعادة حساب إجماليات الفاتورة بعد تعديل الصنف
  await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`
      UPDATE Transactions SET
        TotalAmount = (SELECT ISNULL(SUM(TotalAmount),0) FROM TransactionDetails WHERE TransactionID = @id),
        NetTotalAmount = (SELECT ISNULL(SUM(TotalAmount),0) FROM TransactionDetails WHERE TransactionID = @id) 
          - CASE WHEN DiscountAmount > 0 THEN DiscountAmount 
                 WHEN DiscountPercentage > 0 THEN (SELECT ISNULL(SUM(TotalAmount),0) FROM TransactionDetails WHERE TransactionID = @id) * DiscountPercentage / 100 
                 ELSE 0 END,
        GrandTotal = (SELECT ISNULL(SUM(TotalAmount),0) FROM TransactionDetails WHERE TransactionID = @id) 
          - CASE WHEN DiscountAmount > 0 THEN DiscountAmount 
                 WHEN DiscountPercentage > 0 THEN (SELECT ISNULL(SUM(TotalAmount),0) FROM TransactionDetails WHERE TransactionID = @id) * DiscountPercentage / 100 
                 ELSE 0 END 
          + ISNULL(TotalChargesAmount,0)
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
  getTransactionById,
  getTransactionDetails,
  getAdditionalCharges,
  getPayments,
  createTransaction,
  addPayment,
  getTransactionsSummary,
  requestEdit,
  getPendingEditRequests,
  approveEditRequest,
  rejectEditRequest,
  applyInvoiceEdit,
  updateDetailPrice,
  getFullInvoiceData
};