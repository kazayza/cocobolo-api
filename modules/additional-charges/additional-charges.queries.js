const { sql, connectDB } = require('../../core/database');

const TYPES = new Set(['Inspection', 'Shipping', 'Installation', 'Advance', 'Other']);
const STATUSES = new Set(['Paid', 'Applied', 'NonRefundable']);
const PAID_TYPES = new Set(['Inspection', 'Advance']);
const SQL_INT_MAX = 2147483647;

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

function normalizeType(value) {
  const type = String(value || '').trim();
  if (!TYPES.has(type)) {
    throw Object.assign(new Error('نوع الرسوم غير صالح'), { statusCode: 400 });
  }
  return type;
}

function buildWhere(request, filters = {}) {
  const clauses = ['1 = 1'];
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    clauses.push(`(
      p.PartyName LIKE @search OR p.Phone LIKE @search
      OR c.ChargeDescription LIKE @search
      OR linked.ReferenceNumber LIKE @search OR applied.ReferenceNumber LIKE @search
      OR CAST(c.ChargeID AS NVARCHAR(30)) LIKE @search
    )`);
  }
  if (String(filters.advanceLike) === 'true' || filters.advanceLike === true) {
    clauses.push(`c.ChargeType IN (N'Advance', N'Inspection')`);
  } else if (filters.type && TYPES.has(String(filters.type))) {
    request.input('type', sql.NVarChar(50), String(filters.type));
    clauses.push('c.ChargeType = @type');
  }
  if (filters.status && STATUSES.has(String(filters.status))) {
    request.input('status', sql.NVarChar(50), String(filters.status));
    clauses.push('c.Status = @status');
  }
  if (filters.partyId) {
    request.input('partyId', sql.Int, assertId(filters.partyId, 'معرّف العميل'));
    clauses.push('c.PartyID = @partyId');
  }
  if (String(filters.unappliedOnly) === 'true' || filters.unappliedOnly === true) {
    clauses.push('c.TransactionID IS NULL AND c.AppliedToTransactionId IS NULL AND c.Status = N\'Paid\'');
  }
  if (filters.dateFrom) {
    request.input('dateFrom', sql.Date, filters.dateFrom);
    clauses.push('CAST(c.CreatedAt AS DATE) >= @dateFrom');
  }
  if (filters.dateTo) {
    request.input('dateTo', sql.Date, filters.dateTo);
    clauses.push('CAST(c.CreatedAt AS DATE) <= @dateTo');
  }
  return clauses.map((clause) => `(${clause})`).join(' AND ');
}

const baseFrom = `
  FROM AdditionalCharges c
  LEFT JOIN Parties p ON c.PartyID = p.PartyID
  LEFT JOIN Transactions linked ON c.TransactionID = linked.TransactionID
  LEFT JOIN Transactions applied ON c.AppliedToTransactionId = applied.TransactionID
`;

async function getCharges(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 25), 1), 100);
  const offset = (page - 1) * limit;
  const where = buildWhere(request, filters);
  const result = await request.query(`
    SELECT
      c.ChargeID, c.ChargeType, c.ChargeDescription, c.ChargeAmount,
      c.Status, c.PartyID, p.PartyName, p.Phone AS PartyPhone,
      c.TransactionID, linked.ReferenceNumber AS TransactionRef,
      c.AppliedToTransactionId, applied.ReferenceNumber AS AppliedToTransactionRef,
      c.Notes, c.CreatedBy, c.CreatedAt,
      CASE WHEN c.TransactionID IS NOT NULL OR c.AppliedToTransactionId IS NOT NULL
             OR c.Status IN (N'Applied', N'NonRefundable')
           THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsLocked,
      COUNT(*) OVER() AS TotalRows
    ${baseFrom}
    WHERE ${where}
    ORDER BY c.CreatedAt DESC, c.ChargeID DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `);
  return {
    rows: result.recordset,
    page,
    limit,
    total: result.recordset.length ? Number(result.recordset[0].TotalRows || 0) : 0,
  };
}

async function getStats(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  const where = buildWhere(request, filters);
  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      COALESCE(SUM(ISNULL(c.ChargeAmount, 0)), 0) AS TotalAmount,
      COALESCE(SUM(CASE WHEN c.Status = N'Paid' THEN ISNULL(c.ChargeAmount, 0) ELSE 0 END), 0) AS PaidAmount,
      COALESCE(SUM(CASE WHEN c.Status = N'Applied' THEN ISNULL(c.ChargeAmount, 0) ELSE 0 END), 0) AS AppliedAmount,
      COALESCE(SUM(CASE WHEN c.Status = N'NonRefundable' THEN ISNULL(c.ChargeAmount, 0) ELSE 0 END), 0) AS NonRefundableAmount,
      COALESCE(SUM(CASE WHEN c.Status = N'Paid' AND c.TransactionID IS NULL AND c.AppliedToTransactionId IS NULL THEN ISNULL(c.ChargeAmount, 0) ELSE 0 END), 0) AS AvailableAmount
    ${baseFrom}
    WHERE ${where}
  `);
  return result.recordset[0] || {};
}

async function getCharge(value) {
  const id = assertId(value, 'معرّف الرسوم');
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT
        c.ChargeID, c.ChargeType, c.ChargeDescription, c.ChargeAmount,
        c.Status, c.PartyID, p.PartyName, p.Phone AS PartyPhone,
        p.Address AS PartyAddress, p.City AS PartyCity, p.Email AS PartyEmail,
        c.TransactionID, linked.ReferenceNumber AS TransactionRef,
        c.AppliedToTransactionId, applied.ReferenceNumber AS AppliedToTransactionRef,
        c.Notes, c.CreatedBy, c.CreatedAt,
        cash.CashboxTransactionID, cash.CashBoxID, cb.CashBoxName,
        cash.TransactionDate AS ReceiptDate,
        CASE WHEN c.TransactionID IS NOT NULL OR c.AppliedToTransactionId IS NOT NULL
               OR c.Status IN (N'Applied', N'NonRefundable')
             THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsLocked
      ${baseFrom}
      OUTER APPLY (
        SELECT TOP 1 ct.CashboxTransactionID, ct.CashBoxID, ct.TransactionDate
        FROM CashboxTransactions ct
        WHERE ct.ReferenceID = c.ChargeID AND ct.ReferenceType = N'Charge'
        ORDER BY ct.CashboxTransactionID DESC
      ) cash
      LEFT JOIN CashBoxes cb ON cash.CashBoxID = cb.CashBoxID
      WHERE c.ChargeID = @id
    `);
  return result.recordset[0] || null;
}

async function getReceipt(value) {
  const charge = await getCharge(value);
  if (!charge) return null;
  const pool = await connectDB();
  const companyResult = await pool.request().query(`
    SELECT TOP 1 CompanyName, Phone1, Phone2, Address, InfoEmail, LogoPath
    FROM CompanyInfo ORDER BY CompanyID
  `);
  const company = companyResult.recordset[0] || {};
  const date = charge.ReceiptDate || charge.CreatedAt || new Date();
  const year = new Date(date).getFullYear();
  const description = String(charge.ChargeDescription || '');
  const prefix = charge.ChargeType === 'Inspection' || description.includes('معاينة')
    ? 'INS'
    : charge.ChargeType === 'Advance' || /دفعة|عربون|مقدمة/.test(description)
      ? 'ADV'
      : 'CHR';
  return {
    ...charge,
    ReceiptNumber: `${prefix}-${year}-${String(charge.ChargeID).padStart(6, '0')}`,
    CompanyName: company.CompanyName || 'COCOBOLO',
    CompanyPhone: [company.Phone1, company.Phone2].filter(Boolean).join(' - '),
    CompanyAddress: company.Address,
    CompanyEmail: company.InfoEmail,
    CompanyLogoPath: company.LogoPath,
  };
}

async function getLookups({ search = '', partyId = null, invoiceSearch = '' } = {}) {
  const pool = await connectDB();
  const partiesRequest = pool.request();
  const term = String(search || '').trim();
  let partiesWhere = '1 = 1';
  if (term) {
    partiesRequest.input('search', sql.NVarChar(200), `%${term}%`);
    partiesWhere = `(PartyName LIKE @search OR Phone LIKE @search OR Phone2 LIKE @search)`;
  }
  const partiesResult = await partiesRequest.query(`
    SELECT TOP 40 PartyID, PartyName, Phone, Address
    FROM Parties
    WHERE ${partiesWhere}
    ORDER BY PartyName
  `);
  const cashboxesResult = await pool.request().query(`
    SELECT CashBoxID, CashBoxName, ISNULL(IsActive, 1) AS IsActive
    FROM CashBoxes
    WHERE ISNULL(IsActive, 1) = 1
    ORDER BY ISNULL(IsDefault, 0) DESC, CashBoxName
  `);

  let invoices = [];
  if (partyId) {
    const invoiceRequest = pool.request()
      .input('partyId', sql.Int, assertId(partyId, 'معرّف العميل'));
    let invoiceWhere = '';
    if (String(invoiceSearch || '').trim()) {
      invoiceRequest.input('invoiceSearch', sql.NVarChar(200), `%${String(invoiceSearch).trim()}%`);
      invoiceWhere = `AND (ReferenceNumber LIKE @invoiceSearch OR CAST(TransactionID AS NVARCHAR(30)) LIKE @invoiceSearch)`;
    }
    const invoiceResult = await invoiceRequest.query(`
      SELECT TOP 40 TransactionID, ReferenceNumber, TransactionDate,
             GrandTotal, PaidAmount,
             ISNULL(GrandTotal, 0) - ISNULL(PaidAmount, 0) AS RemainingAmount,
             InvoiceStatus
      FROM Transactions
      WHERE PartyID = @partyId AND TransactionType = 'Sale'
        AND (InvoiceStatus IS NULL OR InvoiceStatus <> 'Cancelled')
        ${invoiceWhere}
      ORDER BY TransactionDate DESC, TransactionID DESC
    `);
    invoices = invoiceResult.recordset;
  }
  return {
    parties: partiesResult.recordset,
    cashboxes: cashboxesResult.recordset,
    invoices,
  };
}

async function insertAudit(transaction, table, action, id, username, oldData, newData) {
  await transaction.request()
    .input('table', sql.NVarChar(128), table)
    .input('action', sql.NVarChar(100), action)
    .input('key', sql.NVarChar(200), String(id))
    .input('username', sql.NVarChar(100), username)
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (@table, @action, @key, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function validatePartyAndCashbox(transaction, partyId, cashBoxId) {
  const partyResult = await transaction.request()
    .input('partyId', sql.Int, partyId)
    .query(`SELECT PartyName FROM Parties WHERE PartyID = @partyId`);
  if (!partyResult.recordset[0]) throw Object.assign(new Error('العميل غير موجود'), { statusCode: 400 });

  let selectedCashBoxId = cashBoxId ? assertId(cashBoxId, 'معرّف الخزينة') : null;
  if (selectedCashBoxId) {
    const cashResult = await transaction.request()
      .input('cashBoxId', sql.Int, selectedCashBoxId)
      .query(`SELECT CashBoxName FROM CashBoxes WHERE CashBoxID = @cashBoxId AND ISNULL(IsActive, 1) = 1`);
    if (!cashResult.recordset[0]) throw Object.assign(new Error('الخزينة غير موجودة أو غير نشطة'), { statusCode: 400 });
  } else {
    const cashResult = await transaction.request().query(`
      SELECT TOP 1 CashBoxID FROM CashBoxes
      WHERE ISNULL(IsActive, 1) = 1
      ORDER BY ISNULL(IsDefault, 0) DESC, CashBoxID
    `);
    selectedCashBoxId = cashResult.recordset[0]?.CashBoxID || null;
    if (!selectedCashBoxId) throw Object.assign(new Error('لا توجد خزينة نشطة لتسجيل التحصيل'), { statusCode: 409 });
  }
  return {
    partyName: partyResult.recordset[0].PartyName,
    cashBoxId: selectedCashBoxId,
  };
}

async function createCharge(data, auth) {
  const partyId = assertId(data.partyId, 'معرّف العميل');
  const type = normalizeType(data.chargeType || 'Inspection');
  const amount = money(data.chargeAmount);
  if (amount <= 0) throw Object.assign(new Error('المبلغ يجب أن يكون أكبر من صفر'), { statusCode: 400 });
  const description = String(data.chargeDescription || '').trim();
  if (!description) throw Object.assign(new Error('وصف الرسوم مطلوب'), { statusCode: 400 });

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const lookup = await validatePartyAndCashbox(transaction, partyId, data.cashBoxId);
    const chargeResult = await transaction.request()
      .input('partyId', sql.Int, partyId)
      .input('type', sql.NVarChar(50), type)
      .input('description', sql.NVarChar(255), description)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(255), String(data.notes || '').trim() || null)
      .input('username', sql.NVarChar(100), auth.username)
      .query(`
        INSERT INTO AdditionalCharges
          (PartyID, ChargeType, ChargeDescription, ChargeAmount,
           Status, Notes, CreatedBy, CreatedAt)
        OUTPUT INSERTED.ChargeID
        VALUES
          (@partyId, @type, @description, @amount,
           N'Paid', @notes, @username, GETDATE())
      `);
    const chargeId = chargeResult.recordset[0].ChargeID;
    await transaction.request()
      .input('cashBoxId', sql.Int, lookup.cashBoxId)
      .input('chargeId', sql.Int, chargeId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(500), `تحصيل ${amount.toFixed(2)} - ${description} - ${lookup.partyName}`)
      .input('username', sql.NVarChar(100), auth.username)
      .query(`
        INSERT INTO CashboxTransactions
          (CashBoxID, ReferenceID, ReferenceType, TransactionType,
           Amount, TransactionDate, Notes, CreatedBy, CreatedAt)
        VALUES
          (@cashBoxId, @chargeId, N'Charge', N'قبض',
           @amount, GETDATE(), @notes, @username, GETDATE())
      `);
    await insertAudit(transaction, 'AdditionalCharges', 'Insert', chargeId, auth.username, null, {
      PartyID: partyId,
      ChargeType: type,
      ChargeDescription: description,
      ChargeAmount: amount,
      Status: 'Paid',
      CashBoxID: lookup.cashBoxId,
    });
    await transaction.commit();
    return { chargeId, partyName: lookup.partyName, type, description, amount };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function updateCharge(value, data, auth) {
  const id = assertId(value, 'معرّف الرسوم');
  const type = normalizeType(data.chargeType);
  const amount = money(data.chargeAmount);
  if (amount <= 0) throw Object.assign(new Error('المبلغ يجب أن يكون أكبر من صفر'), { statusCode: 400 });
  const description = String(data.chargeDescription || '').trim();
  if (!description) throw Object.assign(new Error('وصف الرسوم مطلوب'), { statusCode: 400 });

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM AdditionalCharges WITH (UPDLOCK, HOLDLOCK) WHERE ChargeID = @id`);
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error('الرسوم غير موجودة'), { statusCode: 404 });
    if (current.TransactionID != null || current.AppliedToTransactionId != null
        || ['Applied', 'NonRefundable'].includes(current.Status)) {
      throw Object.assign(new Error('لا يمكن تعديل رسوم مرتبطة أو مطبقة أو غير مستردة'), { statusCode: 409 });
    }
    let cashBoxId = data.cashBoxId ? assertId(data.cashBoxId, 'معرّف الخزينة') : null;
    if (cashBoxId) {
      const cashboxResult = await transaction.request()
        .input('cashBoxId', sql.Int, cashBoxId)
        .query(`SELECT CashBoxID FROM CashBoxes WHERE CashBoxID = @cashBoxId AND ISNULL(IsActive, 1) = 1`);
      if (!cashboxResult.recordset[0]) throw Object.assign(new Error('الخزينة غير موجودة أو غير نشطة'), { statusCode: 400 });
    }
    await transaction.request()
      .input('id', sql.Int, id)
      .input('type', sql.NVarChar(50), type)
      .input('description', sql.NVarChar(255), description)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(255), String(data.notes || '').trim() || null)
      .query(`
        UPDATE AdditionalCharges
        SET ChargeType = @type, ChargeDescription = @description,
            ChargeAmount = @amount, Notes = @notes
        WHERE ChargeID = @id
      `);
    const cashRequest = transaction.request()
      .input('id', sql.Int, id)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(500), `تحديث تحصيل رسوم #${id}: ${description}`);
    let cashUpdate = `UPDATE CashboxTransactions SET Amount = @amount, Notes = @notes`;
    if (cashBoxId) {
      cashRequest.input('cashBoxId', sql.Int, cashBoxId);
      cashUpdate += `, CashBoxID = @cashBoxId`;
    }
    cashUpdate += ` WHERE ReferenceID = @id AND ReferenceType = N'Charge'`;
    await cashRequest.query(cashUpdate);
    await insertAudit(transaction, 'AdditionalCharges', 'Update', id, auth.username, current, {
      ChargeType: type,
      ChargeDescription: description,
      ChargeAmount: amount,
      Notes: data.notes || null,
      CashBoxID: cashBoxId,
    });
    await transaction.commit();
    return { chargeId: id, type, description, amount };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function deleteCharge(value, auth) {
  const id = assertId(value, 'معرّف الرسوم');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM AdditionalCharges WITH (UPDLOCK, HOLDLOCK) WHERE ChargeID = @id`);
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error('الرسوم غير موجودة'), { statusCode: 404 });
    if (current.TransactionID != null || current.AppliedToTransactionId != null
        || ['Applied', 'NonRefundable'].includes(current.Status)) {
      throw Object.assign(new Error('لا يمكن حذف رسوم مرتبطة أو مطبقة أو غير مستردة'), { statusCode: 409 });
    }
    await transaction.request().input('id', sql.Int, id).query(`
      DELETE FROM CashboxTransactions WHERE ReferenceID = @id AND ReferenceType = N'Charge';
      DELETE FROM AdditionalCharges WHERE ChargeID = @id;
    `);
    await insertAudit(transaction, 'AdditionalCharges', 'Delete', id, auth.username, current, null);
    await transaction.commit();
    return { chargeId: id, amount: Number(current.ChargeAmount || 0), partyId: current.PartyID };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function applyToInvoice(value, transactionValue, auth) {
  const id = assertId(value, 'معرّف الرسوم');
  const transactionId = assertId(transactionValue, 'معرّف الفاتورة');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const chargeResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM AdditionalCharges WITH (UPDLOCK, HOLDLOCK) WHERE ChargeID = @id`);
    const charge = chargeResult.recordset[0];
    if (!charge) throw Object.assign(new Error('الرسوم غير موجودة'), { statusCode: 404 });
    if (charge.Status !== 'Paid' || charge.TransactionID != null || charge.AppliedToTransactionId != null) {
      throw Object.assign(new Error('هذه الرسوم غير متاحة للتطبيق'), { statusCode: 409 });
    }
    const invoiceResult = await transaction.request()
      .input('transactionId', sql.Int, transactionId)
      .query(`
        SELECT TransactionID, ReferenceNumber, PartyID, TransactionType,
               InvoiceStatus, GrandTotal, PaidAmount, TotalChargesAmount
        FROM Transactions WITH (UPDLOCK, HOLDLOCK)
        WHERE TransactionID = @transactionId
      `);
    const invoice = invoiceResult.recordset[0];
    if (!invoice || invoice.TransactionType !== 'Sale') throw Object.assign(new Error('فاتورة البيع غير موجودة'), { statusCode: 404 });
    if (invoice.InvoiceStatus === 'Cancelled') throw Object.assign(new Error('لا يمكن تطبيق الرسوم على فاتورة ملغية'), { statusCode: 409 });
    if (Number(invoice.PartyID) !== Number(charge.PartyID)) {
      throw Object.assign(new Error('لا يمكن تطبيق دفعة عميل على فاتورة عميل آخر'), { statusCode: 409 });
    }

    const amount = money(charge.ChargeAmount);
    let paymentId = null;
    if (PAID_TYPES.has(charge.ChargeType)) {
      const cashResult = await transaction.request()
        .input('chargeId', sql.Int, id)
        .query(`
          SELECT TOP 1 CashboxTransactionID
          FROM CashboxTransactions WITH (UPDLOCK, HOLDLOCK)
          WHERE ReferenceID = @chargeId AND ReferenceType = N'Charge'
          ORDER BY CashboxTransactionID DESC
        `);
      const cashboxTransactionId = cashResult.recordset[0]?.CashboxTransactionID || null;
      const paymentResult = await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), amount)
        .input('description', sql.NVarChar(255), charge.ChargeDescription || 'دفعة مقدمة')
        .input('cashboxTransactionId', sql.Int, cashboxTransactionId)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          INSERT INTO Payments
            (TransactionID, PaymentDate, Amount, PaymentMethod,
             CashboxTransactionID, Notes, CreatedBy, CreatedAt)
          OUTPUT INSERTED.PaymentID
          VALUES
            (@transactionId, GETDATE(), @amount, N'Advance',
             @cashboxTransactionId, CONCAT(N'تطبيق دفعة مقدمة: ', @description),
             @username, GETDATE())
        `);
      paymentId = paymentResult.recordset[0].PaymentID;
      if (cashboxTransactionId) {
        await transaction.request()
          .input('cashId', sql.Int, cashboxTransactionId)
          .input('paymentId', sql.Int, paymentId)
          .query(`UPDATE CashboxTransactions SET PaymentID = @paymentId WHERE CashboxTransactionID = @cashId`);
      }
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), amount)
        .query(`
          UPDATE Transactions
          SET PaidAmount = ISNULL(PaidAmount, 0) + @amount,
              InvoiceStatus = CASE
                WHEN ISNULL(PaidAmount, 0) + @amount >= ISNULL(GrandTotal, 0) AND ISNULL(GrandTotal, 0) > 0 THEN N'Paid'
                WHEN ISNULL(PaidAmount, 0) + @amount > 0 THEN N'PartiallyPaid'
                ELSE InvoiceStatus END
          WHERE TransactionID = @transactionId
        `);
    } else {
      await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('amount', sql.Decimal(18, 2), amount)
        .query(`
          UPDATE Transactions
          SET TotalChargesAmount = ISNULL(TotalChargesAmount, 0) + @amount,
              GrandTotal = ISNULL(GrandTotal, 0) + @amount,
              InvoiceStatus = CASE
                WHEN ISNULL(PaidAmount, 0) >= ISNULL(GrandTotal, 0) + @amount AND ISNULL(GrandTotal, 0) + @amount > 0 THEN N'Paid'
                WHEN ISNULL(PaidAmount, 0) > 0 THEN N'PartiallyPaid'
                ELSE InvoiceStatus END
          WHERE TransactionID = @transactionId
        `);
    }
    await transaction.request()
      .input('id', sql.Int, id)
      .input('transactionId', sql.Int, transactionId)
      .query(`
        UPDATE AdditionalCharges
        SET Status = N'Applied', TransactionID = @transactionId,
            AppliedToTransactionId = @transactionId
        WHERE ChargeID = @id
      `);
    await insertAudit(transaction, 'AdditionalCharges', 'Apply', id, auth.username, charge, {
      TransactionID: transactionId,
      ReferenceNumber: invoice.ReferenceNumber,
      Amount: amount,
      AppliedAsPayment: PAID_TYPES.has(charge.ChargeType),
      PaymentID: paymentId,
    });
    await insertAudit(transaction, 'Transactions', 'ApplyCharge', transactionId, auth.username, {
      GrandTotal: invoice.GrandTotal,
      PaidAmount: invoice.PaidAmount,
      TotalChargesAmount: invoice.TotalChargesAmount,
    }, {
      ChargeID: id,
      ChargeType: charge.ChargeType,
      Amount: amount,
    });
    await transaction.commit();
    return {
      chargeId: id,
      transactionId,
      referenceNumber: invoice.ReferenceNumber,
      amount,
      appliedAsPayment: PAID_TYPES.has(charge.ChargeType),
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function markNonRefundable(value, reason, auth) {
  const id = assertId(value, 'معرّف الرسوم');
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw Object.assign(new Error('سبب عدم الاسترداد مطلوب'), { statusCode: 400 });
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const currentResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM AdditionalCharges WITH (UPDLOCK, HOLDLOCK) WHERE ChargeID = @id`);
    const current = currentResult.recordset[0];
    if (!current) throw Object.assign(new Error('الرسوم غير موجودة'), { statusCode: 404 });
    if (current.Status === 'Applied' || current.TransactionID != null || current.AppliedToTransactionId != null) {
      throw Object.assign(new Error('لا يمكن تغيير رسوم مطبقة على فاتورة'), { statusCode: 409 });
    }
    const notes = [String(current.Notes || '').trim(), `غير مستردة: ${cleanReason}`].filter(Boolean).join(' | ');
    await transaction.request()
      .input('id', sql.Int, id)
      .input('notes', sql.NVarChar(255), notes)
      .query(`UPDATE AdditionalCharges SET Status = N'NonRefundable', Notes = @notes WHERE ChargeID = @id`);
    await transaction.request()
      .input('id', sql.Int, id)
      .input('reason', sql.NVarChar(500), ` | غير مستردة: ${cleanReason}`)
      .query(`
        UPDATE CashboxTransactions
        SET Notes = CONCAT(ISNULL(Notes, N''), @reason)
        WHERE ReferenceID = @id AND ReferenceType = N'Charge'
      `);
    await insertAudit(transaction, 'AdditionalCharges', 'NonRefundable', id, auth.username, current, {
      Status: 'NonRefundable', Reason: cleanReason,
    });
    await transaction.commit();
    return { chargeId: id };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

module.exports = {
  TYPES,
  STATUSES,
  PAID_TYPES,
  getCharges,
  getStats,
  getCharge,
  getReceipt,
  getLookups,
  createCharge,
  updateCharge,
  deleteCharge,
  applyToInvoice,
  markNonRefundable,
};
