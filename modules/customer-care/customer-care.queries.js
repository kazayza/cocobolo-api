const { sql, connectDB } = require('../../core/database');

const KINDS = new Set(['Visit', 'Delivery', 'SalesInvoice', 'ComplaintFollowUp']);
const OUTCOMES = new Set([
  'Positive',
  'Neutral',
  'Negative',
  'NoAnswer',
  'NotInterested',
  'CallbackLater',
]);
const STATUSES = new Set(['Open', 'Done', 'Skipped']);
const CHANNELS = new Set(['اتصال', 'واتساب', 'إيميل']);
const TABLE = '[dbo].[CustomerFeedback]';
const SQL_INT_MAX = 2147483647;

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function assertId(value, label = 'المعرّف') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > SQL_INT_MAX) {
    throw Object.assign(new Error(`${label} غير صالح`), { statusCode: 400 });
  }
  return id;
}

function cleanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function ensureSchema(pool) {
  const result = await pool.request().query(`
    SELECT CASE WHEN OBJECT_ID(N'dbo.CustomerFeedback', N'U') IS NULL
      THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS ExistsFlag
  `);
  if (!(result.recordset[0]?.ExistsFlag === true || result.recordset[0]?.ExistsFlag === 1)) {
    throw Object.assign(
      new Error('جدول CustomerFeedback غير موجود. نفّذ CustomerCareModule.sql على قاعدة البيانات.'),
      { statusCode: 503, code: 'CUSTOMER_CARE_SCHEMA_MISSING' },
    );
  }
}

function dateRange(filters = {}) {
  const daysBack = Math.min(Math.max(intValue(filters.daysBack, 30), 1), 365);
  const from = cleanDate(filters.dateFrom) || new Date(new Date().setHours(0, 0, 0, 0) - daysBack * 86400000);
  const to = cleanDate(filters.dateTo);
  if (to) to.setDate(to.getDate() + 1);
  return { from, to };
}

function bindRange(request, range) {
  request.input('fromDate', sql.DateTime, range.from);
  request.input('toDate', sql.DateTime, range.to);
}

function feedbackApply(kind, keyColumn, sourceColumn) {
  return `OUTER APPLY (
    SELECT TOP 1 f.FeedbackId, f.Status, f.Outcome, f.Satisfaction,
           f.Channel, f.NextCallDate, f.AssignedTo, f.CreatedBy
    FROM ${TABLE} f
    WHERE f.IsActive = 1 AND f.FeedbackType = N'${kind}'
      AND f.${keyColumn} = ${sourceColumn}
    ORDER BY f.FeedbackId DESC
  ) feedback`;
}

function queueRow(raw, kind, fields = {}) {
  return {
    Kind: kind,
    PartyId: Number(raw.PartyId || 0),
    OpportunityId: raw.OpportunityId == null ? null : Number(raw.OpportunityId),
    TransactionId: raw.TransactionId == null ? null : Number(raw.TransactionId),
    ComplaintId: raw.ComplaintId == null ? null : Number(raw.ComplaintId),
    VisitInteractionId: raw.VisitInteractionId == null ? null : Number(raw.VisitInteractionId),
    ClientName: raw.ClientName || 'عميل',
    Phone: raw.Phone || null,
    SourceDate: raw.SourceDate || null,
    Title: fields.title || raw.Title || '',
    ExistingFeedbackId: raw.FeedbackId == null ? null : Number(raw.FeedbackId),
    FeedbackStatus: raw.Status || null,
    FeedbackOutcome: raw.Outcome || null,
    NextCallDate: raw.NextCallDate || null,
    Satisfaction: raw.Satisfaction == null ? null : Number(raw.Satisfaction),
    Channel: raw.Channel || null,
    _AssignedTo: raw.AssignedTo == null ? null : Number(raw.AssignedTo),
    _CreatedBy: raw.CreatedBy || null,
  };
}

function shouldShow(row, includeContacted) {
  return includeContacted
    || row.FeedbackStatus == null
    || row.FeedbackStatus === 'Open'
    || row.FeedbackStatus === 'Skipped';
}

async function getDashboard(filters = {}, auth, { canViewAll = false } = {}) {
  const pool = await connectDB();
  await ensureSchema(pool);
  const range = dateRange(filters);
  const includeContacted = String(filters.includeContacted) === 'true' || filters.includeContacted === true;
  const scopeQueue = (rows) => rows
    .filter((row) => shouldShow(row, includeContacted))
    .filter((row) => canViewAll
      || row.ExistingFeedbackId == null
      || String(row._CreatedBy || '').toLowerCase()
        === String(auth.username || '').toLowerCase()
      || (row._AssignedTo != null
        && Number(row._AssignedTo) === Number(auth.employeeId || 0)))
    .map((row) => {
      const result = { ...row };
      delete result._AssignedTo;
      delete result._CreatedBy;
      return result;
    });

  const visitRequest = pool.request();
  bindRange(visitRequest, range);
  const visitResult = await visitRequest.query(`
    SELECT TOP 400
      ci.InteractionID AS VisitInteractionId,
      ci.OpportunityID AS OpportunityId,
      ci.PartyID AS PartyId,
      ci.InteractionDate AS SourceDate,
      p.PartyName AS ClientName, p.Phone,
      feedback.FeedbackId, feedback.Status, feedback.Outcome,
      feedback.Satisfaction, feedback.Channel, feedback.NextCallDate,
      feedback.AssignedTo, feedback.CreatedBy
    FROM CustomerInteractions ci
    INNER JOIN ContactStatus cs ON ci.StatusID = cs.StatusID
    INNER JOIN Parties p ON ci.PartyID = p.PartyID
    ${feedbackApply('Visit', 'VisitInteractionId', 'ci.InteractionID')}
    WHERE ci.InteractionDate >= @fromDate
      AND (@toDate IS NULL OR ci.InteractionDate < @toDate)
      AND ISNULL(p.IsB2B, 0) = 0
      AND (cs.StatusName LIKE N'%Visit%'
        OR cs.StatusName LIKE N'%ShowRoom%'
        OR cs.StatusName LIKE N'%Show Room%')
    ORDER BY ci.InteractionDate DESC, ci.InteractionID DESC
  `);
  const visits = scopeQueue(visitResult.recordset
    .map((row) => queueRow(row, 'Visit', {
      title: `زيارة معرض — ${row.SourceDate ? new Date(row.SourceDate).toISOString().slice(0, 10) : ''}`,
    })));

  const deliveryRequest = pool.request();
  bindRange(deliveryRequest, range);
  const deliveryResult = await deliveryRequest.query(`
    SELECT TOP 400
      t.TransactionID AS TransactionId, t.PartyID AS PartyId,
      t.DeliveredAt AS SourceDate, p.PartyName AS ClientName, p.Phone,
      t.ReferenceNumber,
      feedback.FeedbackId, feedback.Status, feedback.Outcome,
      feedback.Satisfaction, feedback.Channel, feedback.NextCallDate,
      feedback.AssignedTo, feedback.CreatedBy
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    ${feedbackApply('Delivery', 'TransactionId', 't.TransactionID')}
    WHERE t.TransactionType = 'Sale'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND t.IsDelivered = 1 AND t.DeliveredAt IS NOT NULL
      AND t.DeliveredAt >= @fromDate
      AND (@toDate IS NULL OR t.DeliveredAt < @toDate)
      AND ISNULL(p.IsB2B, 0) = 0
    ORDER BY t.DeliveredAt DESC, t.TransactionID DESC
  `);
  const deliveries = scopeQueue(deliveryResult.recordset
    .map((row) => queueRow(row, 'Delivery', {
      title: `فاتورة ${row.ReferenceNumber || `#${row.TransactionId}`} — تم التسليم`,
    })));

  const invoiceRequest = pool.request();
  bindRange(invoiceRequest, range);
  const invoiceResult = await invoiceRequest.query(`
    SELECT TOP 400
      t.TransactionID AS TransactionId, t.PartyID AS PartyId,
      t.TransactionDate AS SourceDate, p.PartyName AS ClientName, p.Phone,
      t.ReferenceNumber,
      CASE
        WHEN t.DueDate IS NOT NULL AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'متأخر'
        ELSE N'جارى' END AS DeliveryState,
      feedback.FeedbackId, feedback.Status, feedback.Outcome,
      feedback.Satisfaction, feedback.Channel, feedback.NextCallDate,
      feedback.AssignedTo, feedback.CreatedBy
    FROM Transactions t
    INNER JOIN Parties p ON t.PartyID = p.PartyID
    ${feedbackApply('SalesInvoice', 'TransactionId', 't.TransactionID')}
    WHERE t.TransactionType = 'Sale'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND ISNULL(t.IsDelivered, 0) = 0
      AND (t.DeliveredNotes IS NULL OR t.DeliveredNotes NOT LIKE N'مرتجع:%')
      AND t.TransactionDate >= @fromDate
      AND (@toDate IS NULL OR t.TransactionDate < @toDate)
      AND ISNULL(p.IsB2B, 0) = 0
    ORDER BY t.TransactionDate DESC, t.TransactionID DESC
  `);
  const salesInvoices = scopeQueue(invoiceResult.recordset
    .map((row) => queueRow(row, 'SalesInvoice', {
      title: `فاتورة ${row.ReferenceNumber || `#${row.TransactionId}`} — لم تُسلّم (${row.DeliveryState})`,
    })));

  const complaintRequest = pool.request();
  bindRange(complaintRequest, range);
  const complaintResult = await complaintRequest.query(`
    SELECT TOP 400
      c.ComplaintID AS ComplaintId, c.PartyID AS PartyId,
      c.OpportunityID AS OpportunityId, c.TransactionID AS TransactionId,
      COALESCE(c.ComplaintDate, c.SolvedDate) AS SourceDate,
      p.PartyName AS ClientName, p.Phone,
      c.Subject AS Title,
      feedback.FeedbackId, feedback.Status AS FeedbackStatus,
      feedback.Outcome, feedback.Satisfaction, feedback.Channel, feedback.NextCallDate,
      feedback.AssignedTo, feedback.CreatedBy
    FROM Complaints c
    INNER JOIN Parties p ON c.PartyID = p.PartyID
    ${feedbackApply('ComplaintFollowUp', 'ComplaintId', 'c.ComplaintID')}
    WHERE ISNULL(c.IsActive, 1) = 1
      AND ISNULL(p.IsB2B, 0) = 0
      AND (
        c.Status IN (1, 2, 3, 6)
        OR (c.Status = 4 AND c.SolvedDate IS NOT NULL
          AND c.SolvedDate >= @fromDate
          AND (@toDate IS NULL OR c.SolvedDate < @toDate)
          AND c.SatisfactionLevel IS NULL)
      )
    ORDER BY COALESCE(c.ComplaintDate, c.SolvedDate) DESC, c.ComplaintID DESC
  `);
  const complaints = scopeQueue(complaintResult.recordset
    .map((raw) => queueRow({
      ...raw,
      Status: raw.FeedbackStatus,
    }, 'ComplaintFollowUp', { title: raw.Title || 'شكوى' })));

  const callbackRequest = pool.request();
  if (!canViewAll) {
    callbackRequest
      .input('username', sql.NVarChar(100), auth.username)
      .input('employeeId', sql.Int, auth.employeeId || null);
  }
  const callbackScope = canViewAll
    ? ''
    : `AND (f.CreatedBy = @username OR (f.AssignedTo IS NOT NULL AND f.AssignedTo = @employeeId))`;
  const callbackResult = await callbackRequest.query(`
    SELECT TOP 50
      f.FeedbackId, f.FeedbackType AS Kind, f.PartyId,
      f.OpportunityId, f.TransactionId, f.ComplaintId, f.VisitInteractionId,
      f.ClientName, f.Phone, f.SourceDate, f.NextCallDate,
      f.Satisfaction, f.Channel, f.Status, f.Outcome
    FROM ${TABLE} f
    INNER JOIN Parties p ON f.PartyId = p.PartyID
    WHERE f.IsActive = 1 AND f.Status = N'Open'
      AND f.Outcome = N'CallbackLater' AND f.NextCallDate IS NOT NULL
      AND ISNULL(p.IsB2B, 0) = 0
      ${callbackScope}
    ORDER BY f.NextCallDate, f.FeedbackId
  `);
  const callbacks = callbackResult.recordset.map((raw) => {
    const row = queueRow({
      ...raw,
      FeedbackId: raw.FeedbackId,
      FeedbackStatus: 'Open',
      Status: 'Open',
    }, raw.Kind, { title: 'متابعة مجدولة' });
    delete row._AssignedTo;
    delete row._CreatedBy;
    return row;
  });

  const kpiRequest = pool.request();
  if (!canViewAll) {
    kpiRequest
      .input('username', sql.NVarChar(100), auth.username)
      .input('employeeId', sql.Int, auth.employeeId || null);
  }
  const kpiScope = canViewAll
    ? ''
    : `AND (f.CreatedBy = @username OR (f.AssignedTo IS NOT NULL AND f.AssignedTo = @employeeId))`;
  const kpiResult = await kpiRequest.query(`
    SELECT
      COUNT(*) AS DoneTotal,
      COALESCE(SUM(CASE WHEN f.CompletedAt >= CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END), 0) AS DoneToday,
      COALESCE(SUM(CASE WHEN f.Outcome = N'Positive' THEN 1 ELSE 0 END), 0) AS PositiveCount,
      AVG(CASE WHEN f.Satisfaction BETWEEN 1 AND 5 THEN CAST(f.Satisfaction AS FLOAT) END) AS AvgSatisfaction
    FROM ${TABLE} f
    INNER JOIN Parties p ON f.PartyId = p.PartyID
    WHERE f.IsActive = 1 AND f.Status = N'Done'
      AND ISNULL(p.IsB2B, 0) = 0
      ${kpiScope}
  `);
  const kpi = kpiResult.recordset[0] || {};

  return {
    kpis: {
      OpenVisits: visits.length,
      OpenDeliveries: deliveries.length,
      OpenSalesInvoices: salesInvoices.length,
      OpenComplaints: complaints.length,
      DoneToday: Number(kpi.DoneToday || 0),
      DoneTotal: Number(kpi.DoneTotal || 0),
      AvgSatisfaction: kpi.AvgSatisfaction == null ? null : Number(kpi.AvgSatisfaction),
      PositiveCount: Number(kpi.PositiveCount || 0),
      CallbackCount: callbacks.length,
    },
    visits,
    deliveries,
    salesInvoices,
    complaints,
    callbacks,
  };
}

async function writeAudit(transaction, action, id, username, oldData, newData) {
  await transaction.request()
    .input('action', sql.NVarChar(10), action)
    .input('key', sql.NVarChar(200), String(id))
    .input('username', sql.NVarChar(100), username)
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (N'CustomerFeedback', @action, @key, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

async function findExistingFeedback(transaction, data) {
  let column = null;
  let value = null;
  if (data.kind === 'Visit' && data.visitInteractionId) {
    column = 'VisitInteractionId';
    value = assertId(data.visitInteractionId, 'معرّف الزيارة');
  } else if ((data.kind === 'Delivery' || data.kind === 'SalesInvoice') && data.transactionId) {
    column = 'TransactionId';
    value = assertId(data.transactionId, 'معرّف الفاتورة');
  } else if (data.kind === 'ComplaintFollowUp' && data.complaintId) {
    column = 'ComplaintId';
    value = assertId(data.complaintId, 'معرّف الشكوى');
  }
  if (!column) return null;
  const result = await transaction.request()
    .input('kind', sql.NVarChar(50), data.kind)
    .input('value', sql.Int, value)
    .query(`
      SELECT TOP 1 * FROM ${TABLE} WITH (UPDLOCK, HOLDLOCK)
      WHERE IsActive = 1 AND FeedbackType = @kind AND ${column} = @value
      ORDER BY FeedbackId DESC
    `);
  return result.recordset[0] || null;
}

async function logOutcome(data, auth, { canViewAll = false } = {}) {
  const kind = String(data.kind || '');
  const outcome = String(data.outcome || '');
  if (!KINDS.has(kind)) throw Object.assign(new Error('مصدر الفيدباك غير صالح'), { statusCode: 400 });
  if (!OUTCOMES.has(outcome)) throw Object.assign(new Error('اختر نتيجة المكالمة'), { statusCode: 400 });
  const partyId = assertId(data.partyId, 'معرّف العميل');
  const channel = CHANNELS.has(String(data.channel || '')) ? String(data.channel) : 'اتصال';
  const satisfaction = intValue(data.satisfaction, 0);
  const callbackDate = cleanDate(data.nextCallDate);

  const pool = await connectDB();
  await ensureSchema(pool);
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const partyResult = await transaction.request()
      .input('partyId', sql.Int, partyId)
      .query(`SELECT PartyName, Phone, ISNULL(IsB2B, 0) AS IsB2B FROM Parties WHERE PartyID = @partyId`);
    const party = partyResult.recordset[0];
    if (!party) throw Object.assign(new Error('العميل غير موجود'), { statusCode: 404 });
    if (party.IsB2B === true || party.IsB2B === 1) {
      throw Object.assign(new Error('عملاء B2B مستبعدون من موديول خدمة العملاء'), { statusCode: 409 });
    }

    let current = null;
    let feedbackId = data.feedbackId ? assertId(data.feedbackId, 'معرّف الفيدباك') : null;
    if (feedbackId) {
      const currentResult = await transaction.request()
        .input('id', sql.Int, feedbackId)
        .query(`SELECT * FROM ${TABLE} WITH (UPDLOCK, HOLDLOCK) WHERE FeedbackId = @id AND IsActive = 1`);
      current = currentResult.recordset[0] || null;
      if (!current) throw Object.assign(new Error('سجل الفيدباك غير موجود'), { statusCode: 404 });
      if (!canViewAll) {
        const own = String(current.CreatedBy || '').toLowerCase() === String(auth.username || '').toLowerCase()
          || (current.AssignedTo != null && Number(current.AssignedTo) === Number(auth.employeeId || 0));
        if (!own) throw Object.assign(new Error('لا يمكنك تعديل سجل موظف آخر'), { statusCode: 403 });
      }
    } else {
      current = await findExistingFeedback(transaction, {
        ...data,
        kind,
      });
      if (current) {
        if (!canViewAll) {
          const own = String(current.CreatedBy || '').toLowerCase()
                === String(auth.username || '').toLowerCase()
            || (current.AssignedTo != null
                && Number(current.AssignedTo) === Number(auth.employeeId || 0));
          if (!own) {
            throw Object.assign(new Error('هذه المتابعة مسندة لموظف آخر'), {
              statusCode: 403,
            });
          }
        }
        feedbackId = Number(current.FeedbackId);
      }
    }

    const markSkipped = data.markSkipped === true;
    const status = markSkipped
      ? 'Skipped'
      : outcome === 'CallbackLater'
        ? 'Open'
        : 'Done';
    const nextCallDate = status === 'Open'
      ? (callbackDate || new Date(Date.now() + 86400000))
      : null;
    const completedAt = status === 'Done' ? new Date() : null;
    const notes = String(data.notes || '').trim() || null;
    const employeeNotes = String(data.employeeNotes || '').trim() || null;
    const now = new Date();

    if (feedbackId) {
      await transaction.request()
        .input('id', sql.Int, feedbackId)
        .input('channel', sql.NVarChar(50), channel)
        .input('status', sql.NVarChar(20), status)
        .input('outcome', sql.NVarChar(50), outcome)
        .input('satisfaction', sql.TinyInt, satisfaction >= 1 && satisfaction <= 5 ? satisfaction : null)
        .input('notes', sql.NVarChar(sql.MAX), notes)
        .input('employeeNotes', sql.NVarChar(sql.MAX), employeeNotes)
        .input('nextCallDate', sql.DateTime, nextCallDate)
        .input('completedBy', sql.NVarChar(100), status === 'Done' ? auth.username : null)
        .input('completedAt', sql.DateTime, completedAt)
        .input('username', sql.NVarChar(100), auth.username)
        .query(`
          UPDATE ${TABLE}
          SET Channel = @channel, Status = @status, Outcome = @outcome,
              Satisfaction = @satisfaction, Notes = @notes,
              EmployeeNotes = @employeeNotes, NextCallDate = @nextCallDate,
              CompletedBy = @completedBy, CompletedAt = @completedAt,
              UpdatedBy = @username, UpdatedAt = GETDATE()
          WHERE FeedbackId = @id
        `);
    } else {
      const insertResult = await transaction.request()
        .input('kind', sql.NVarChar(50), kind)
        .input('partyId', sql.Int, partyId)
        .input('opportunityId', sql.Int, data.opportunityId ? assertId(data.opportunityId, 'معرّف الفرصة') : null)
        .input('transactionId', sql.Int, data.transactionId ? assertId(data.transactionId, 'معرّف الفاتورة') : null)
        .input('complaintId', sql.Int, data.complaintId ? assertId(data.complaintId, 'معرّف الشكوى') : null)
        .input('visitInteractionId', sql.Int, data.visitInteractionId ? assertId(data.visitInteractionId, 'معرّف الزيارة') : null)
        .input('sourceDate', sql.DateTime, cleanDate(data.sourceDate))
        .input('clientName', sql.NVarChar(200), String(data.clientName || party.PartyName || 'عميل'))
        .input('phone', sql.NVarChar(50), String(data.phone || party.Phone || '') || null)
        .input('channel', sql.NVarChar(50), channel)
        .input('status', sql.NVarChar(20), status)
        .input('outcome', sql.NVarChar(50), outcome)
        .input('satisfaction', sql.TinyInt, satisfaction >= 1 && satisfaction <= 5 ? satisfaction : null)
        .input('notes', sql.NVarChar(sql.MAX), notes)
        .input('employeeNotes', sql.NVarChar(sql.MAX), employeeNotes)
        .input('nextCallDate', sql.DateTime, nextCallDate)
        .input('assignedTo', sql.Int, auth.employeeId || null)
        .input('username', sql.NVarChar(100), auth.username)
        .input('completedBy', sql.NVarChar(100), status === 'Done' ? auth.username : null)
        .input('completedAt', sql.DateTime, completedAt)
        .query(`
          INSERT INTO ${TABLE}
            (FeedbackType, PartyId, OpportunityId, TransactionId,
             ComplaintId, VisitInteractionId, SourceDate, ClientName, Phone,
             Channel, Status, Outcome, Satisfaction, Notes, EmployeeNotes,
             NextCallDate, AssignedTo, CreatedBy, CreatedAt,
             CompletedBy, CompletedAt, UpdatedBy, UpdatedAt, IsActive)
          OUTPUT INSERTED.FeedbackId
          VALUES
            (@kind, @partyId, @opportunityId, @transactionId,
             @complaintId, @visitInteractionId, @sourceDate, @clientName, @phone,
             @channel, @status, @outcome, @satisfaction, @notes, @employeeNotes,
             @nextCallDate, @assignedTo, @username, GETDATE(),
             @completedBy, @completedAt, @username, GETDATE(), 1)
        `);
      feedbackId = Number(insertResult.recordset[0].FeedbackId);
    }

    await writeAudit(transaction, 'CCLog', feedbackId, auth.username, current, {
      Kind: kind,
      PartyId: partyId,
      Channel: channel,
      Status: status,
      Outcome: outcome,
      Satisfaction: satisfaction || null,
      NextCallDate: nextCallDate,
    });
    await transaction.commit();
    return {
      feedbackId,
      status,
      outcome,
      nextCallDate,
      clientName: data.clientName || party.PartyName,
    };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

function buildHistoryWhere(request, filters, auth, canViewAll) {
  const clauses = ['f.IsActive = 1', 'ISNULL(p.IsB2B, 0) = 0'];
  if (filters.dateFrom) {
    request.input('dateFrom', sql.Date, filters.dateFrom);
    clauses.push('CAST(f.CreatedAt AS DATE) >= @dateFrom');
  }
  if (filters.dateTo) {
    request.input('dateTo', sql.Date, filters.dateTo);
    clauses.push('CAST(f.CreatedAt AS DATE) <= @dateTo');
  }
  if (filters.kind && KINDS.has(String(filters.kind))) {
    request.input('kind', sql.NVarChar(50), String(filters.kind));
    clauses.push('f.FeedbackType = @kind');
  }
  if (filters.status && STATUSES.has(String(filters.status))) {
    request.input('status', sql.NVarChar(20), String(filters.status));
    clauses.push('f.Status = @status');
  }
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(250), `%${String(filters.search).trim()}%`);
    clauses.push(`(f.ClientName LIKE @search OR f.Phone LIKE @search
      OR f.Notes LIKE @search OR f.EmployeeNotes LIKE @search)`);
  }
  if (filters.feedbackId) {
    request.input('feedbackId', sql.Int, assertId(filters.feedbackId, 'معرّف الفيدباك'));
    clauses.push('f.FeedbackId = @feedbackId');
  }
  if (!canViewAll) {
    request
      .input('username', sql.NVarChar(100), auth.username)
      .input('employeeId', sql.Int, auth.employeeId || null);
    clauses.push('(f.CreatedBy = @username OR (f.AssignedTo IS NOT NULL AND f.AssignedTo = @employeeId))');
  }
  return clauses.map((x) => `(${x})`).join(' AND ');
}

async function getHistory(filters = {}, auth, { canViewAll = false } = {}) {
  const pool = await connectDB();
  await ensureSchema(pool);
  const page = Math.max(intValue(filters.page, 1), 1);
  const limit = Math.min(Math.max(intValue(filters.limit, 30), 1), 100);
  const offset = (page - 1) * limit;
  const request = pool.request();
  const where = buildHistoryWhere(request, filters, auth, canViewAll);
  const result = await request.query(`
    SELECT
      f.FeedbackId, f.FeedbackType AS Kind, f.PartyId,
      f.OpportunityId, f.TransactionId, f.ComplaintId, f.VisitInteractionId,
      f.ClientName, f.Phone, f.Status, f.Outcome, f.Satisfaction,
      f.Channel, f.Notes, f.EmployeeNotes, f.SourceDate, f.NextCallDate,
      f.AssignedTo, f.CreatedBy, f.CreatedAt, f.CompletedBy, f.CompletedAt,
      COUNT(*) OVER() AS TotalRows
    FROM ${TABLE} f
    INNER JOIN Parties p ON f.PartyId = p.PartyID
    WHERE ${where}
    ORDER BY f.CreatedAt DESC, f.FeedbackId DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `);

  const statRequest = pool.request();
  const statWhere = buildHistoryWhere(statRequest, filters, auth, canViewAll);
  const statsResult = await statRequest.query(`
    SELECT f.Outcome, COUNT(*) AS Count
    FROM ${TABLE} f
    INNER JOIN Parties p ON f.PartyId = p.PartyID
    WHERE ${statWhere} AND f.Status = N'Done'
    GROUP BY f.Outcome
  `);
  return {
    rows: result.recordset,
    outcomeStats: statsResult.recordset,
    page,
    limit,
    total: result.recordset.length ? Number(result.recordset[0].TotalRows || 0) : 0,
  };
}

async function hideFeedback(value, auth) {
  const id = assertId(value, 'معرّف الفيدباك');
  const pool = await connectDB();
  await ensureSchema(pool);
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM ${TABLE} WITH (UPDLOCK, HOLDLOCK) WHERE FeedbackId = @id AND IsActive = 1`);
    const current = result.recordset[0];
    if (!current) throw Object.assign(new Error('سجل الفيدباك غير موجود'), { statusCode: 404 });
    await transaction.request()
      .input('id', sql.Int, id)
      .input('username', sql.NVarChar(100), auth.username)
      .query(`
        UPDATE ${TABLE}
        SET IsActive = 0, UpdatedBy = @username, UpdatedAt = GETDATE()
        WHERE FeedbackId = @id
      `);
    await writeAudit(transaction, 'CCHide', id, auth.username, current, { IsActive: false });
    await transaction.commit();
    return { feedbackId: id };
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function getExportRows(filters = {}, auth, { canViewAll = false } = {}) {
  const pool = await connectDB();
  await ensureSchema(pool);
  const request = pool.request();
  const where = buildHistoryWhere(request, filters, auth, canViewAll);
  const result = await request.query(`
    SELECT TOP 10000
      f.FeedbackId, f.FeedbackType AS Kind, f.ClientName, f.Phone,
      f.Status, f.Outcome, f.Satisfaction, f.Channel,
      f.Notes, f.EmployeeNotes, f.SourceDate, f.NextCallDate,
      f.CreatedBy, f.CreatedAt, f.CompletedBy, f.CompletedAt
    FROM ${TABLE} f
    INNER JOIN Parties p ON f.PartyId = p.PartyID
    WHERE ${where}
    ORDER BY f.CreatedAt DESC, f.FeedbackId DESC
  `);
  return result.recordset;
}

module.exports = {
  KINDS,
  OUTCOMES,
  STATUSES,
  getDashboard,
  logOutcome,
  getHistory,
  hideFeedback,
  getExportRows,
};
