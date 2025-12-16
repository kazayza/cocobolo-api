const { sql, connectDB } = require('../../core/database');

// جلب كل عروض الأسعار
async function getAllQuotations(startDate = null, endDate = null, partyId = null) {
  const pool = await connectDB();

  let query = `
    SELECT 
      q.QuotationID, q.QuotationDate, q.TotalAmount, q.GrandTotal,
      q.InvoiceID, q.Notes, q.CreatedBy, q.CreatedAt,
      p.PartyID, p.PartyName, p.Phone,
      w.WarehouseID, w.WarehouseName
    FROM Quotations q
    INNER JOIN Parties p ON q.PartyID = p.PartyID
    LEFT JOIN Warehouses w ON q.WarehouseID = w.WarehouseID
    WHERE 1=1
  `;

  const request = pool.request();

  if (startDate) {
    query += ` AND CAST(q.QuotationDate AS DATE) >= @startDate`;
    request.input('startDate', sql.Date, startDate);
  }

  if (endDate) {
    query += ` AND CAST(q.QuotationDate AS DATE) <= @endDate`;
    request.input('endDate', sql.Date, endDate);
  }

  if (partyId) {
    query += ` AND q.PartyID = @partyId`;
    request.input('partyId', sql.Int, partyId);
  }

  query += ` ORDER BY q.QuotationDate DESC, q.QuotationID DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب عرض سعر بالـ ID
async function getQuotationById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        q.*,
        p.PartyName, p.Phone, p.Address, p.TaxNumber,
        w.WarehouseName
      FROM Quotations q
      INNER JOIN Parties p ON q.PartyID = p.PartyID
      LEFT JOIN Warehouses w ON q.WarehouseID = w.WarehouseID
      WHERE q.QuotationID = @id
    `);
  return result.recordset[0] || null;
}

// جلب تفاصيل عرض السعر
async function getQuotationDetails(quotationId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('quotationId', sql.Int, quotationId)
    .query(`
      SELECT 
        qd.QuotationDetailID, qd.ProductID, qd.Quantity,
        qd.UnitPrice, qd.TotalAmount,
        p.ProductName, p.ProductDescription
      FROM QuotationDetails qd
      INNER JOIN Products p ON qd.ProductID = p.ProductID
      WHERE qd.QuotationID = @quotationId
    `);
  return result.recordset;
}

// جلب الرسوم الإضافية لعرض السعر
async function getQuotationCharges(quotationId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('quotationId', sql.Int, quotationId)
    .query(`
      SELECT ChargeID, ChargeDescription, ChargeAmount
      FROM AdditionalCharges
      WHERE QuotationID = @quotationId
    `);
  return result.recordset;
}

// إنشاء عرض سعر جديد
async function createQuotation(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // إنشاء عرض السعر
    const result = await transaction.request()
      .input('quotationDate', sql.DateTime, data.quotationDate || new Date())
      .input('partyId', sql.Int, data.partyId)
      .input('warehouseId', sql.Int, data.warehouseId || null)
      .input('totalAmount', sql.Decimal(18, 2), data.totalAmount || 0)
      .input('grandTotal', sql.Decimal(18, 2), data.grandTotal || 0)
      .input('notes', sql.NVarChar(500), data.notes || null)
      .input('createdBy', sql.NVarChar(100), data.createdBy)
      .query(`
        INSERT INTO Quotations (
          QuotationDate, PartyID, WarehouseID, TotalAmount,
          GrandTotal, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.QuotationID
        VALUES (
          @quotationDate, @partyId, @warehouseId, @totalAmount,
          @grandTotal, @notes, @createdBy, GETDATE()
        )
      `);

    const quotationId = result.recordset[0].QuotationID;

    // إضافة التفاصيل
    if (data.details && data.details.length > 0) {
      for (const detail of data.details) {
        await transaction.request()
          .input('quotationId', sql.Int, quotationId)
          .input('productId', sql.Int, detail.productId)
          .input('quantity', sql.Decimal(18, 2), detail.quantity)
          .input('unitPrice', sql.Decimal(18, 2), detail.unitPrice)
          .query(`
            INSERT INTO QuotationDetails (QuotationID, ProductID, Quantity, UnitPrice)
            VALUES (@quotationId, @productId, @quantity, @unitPrice)
          `);
      }
    }

    // إضافة الرسوم
    if (data.charges && data.charges.length > 0) {
      for (const charge of data.charges) {
        await transaction.request()
          .input('quotationId', sql.Int, quotationId)
          .input('chargeDescription', sql.NVarChar(255), charge.description)
          .input('chargeAmount', sql.Decimal(18, 2), charge.amount)
          .input('createdBy', sql.NVarChar(50), data.createdBy)
          .query(`
            INSERT INTO AdditionalCharges (QuotationID, ChargeDescription, ChargeAmount, CreatedBy, CreatedAt)
            VALUES (@quotationId, @chargeDescription, @chargeAmount, @createdBy, GETDATE())
          `);
      }
    }

    await transaction.commit();
    return quotationId;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// تحويل عرض السعر لفاتورة
async function convertToInvoice(quotationId, transactionId) {
  const pool = await connectDB();
  await pool.request()
    .input('quotationId', sql.Int, quotationId)
    .input('transactionId', sql.Int, transactionId)
    .query(`
      UPDATE Quotations SET InvoiceID = @transactionId WHERE QuotationID = @quotationId
    `);
  return true;
}

// حذف عرض سعر
async function deleteQuotation(id) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // حذف الرسوم
    await transaction.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM AdditionalCharges WHERE QuotationID = @id');

    // حذف التفاصيل
    await transaction.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM QuotationDetails WHERE QuotationID = @id');

    // حذف عرض السعر
    await transaction.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM Quotations WHERE QuotationID = @id');

    await transaction.commit();
    return true;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// تصدير الدوال
module.exports = {
  getAllQuotations,
  getQuotationById,
  getQuotationDetails,
  getQuotationCharges,
  createQuotation,
  convertToInvoice,
  deleteQuotation
};