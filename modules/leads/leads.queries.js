const { sql, connectDB } = require('../../core/database');
const notificationsQueries = require('../notifications/notifications.queries');

// ═══════════════════════════════════════════════════════════
// Constants — must match Blazor LeadInteractionTypes / statuses
// ═══════════════════════════════════════════════════════════
const STATUSES = {
  NEW: 'جديد',
  ASSIGNED: 'تم الإسناد',
  CONTACTED: 'تم التواصل',
  CONVERTED: 'محول',
  REJECTED: 'مرفوض',
  QUALIFIED_LEGACY: 'مؤهل',
};

const INTERACTION_TYPES = {
  ASSIGNED: 'إسناد',
  CALL: 'اتصال',
  WHATSAPP: 'واتساب',
  NOTE: 'ملاحظة',
  FOLLOW_UP: 'متابعة',
  CONVERTED: 'تحويل',
  REJECTED: 'رفض',
};

const CONTACT_TYPES = new Set([
  INTERACTION_TYPES.CALL,
  INTERACTION_TYPES.WHATSAPP,
  INTERACTION_TYPES.FOLLOW_UP,
  INTERACTION_TYPES.NOTE,
]);

function normalizeStatus(status) {
  if (!status) return status;
  const s = String(status).trim();
  // Fix common wrong spellings from older mobile/API code
  if (s === 'محوّل' || s === 'محوّل' || s === 'محوله') return STATUSES.CONVERTED;
  if (s === 'تم الاسناد') return STATUSES.ASSIGNED;
  return s;
}

function toInt(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function toDecimal(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

// ═══════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════
async function getLeads(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();

  const page = Math.max(1, toInt(filters.page, 1));
  const limit = Math.min(200, Math.max(1, toInt(filters.limit, 50)));
  const offset = (page - 1) * limit;

  let where = ' WHERE 1=1 ';

  const status = normalizeStatus(filters.status || filters.leadStatus);
  if (status && status !== 'الكل') {
    request.input('status', sql.NVarChar(50), status);
    where += ' AND l.LeadStatus = @status ';
  }

  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(100), `%${String(filters.search).trim()}%`);
    where += ` AND (
      l.FullName LIKE @search OR l.Phone LIKE @search OR l.Phone2 LIKE @search
      OR l.CampaignName LIKE @search OR l.AdName LIKE @search
      OR l.City LIKE @search OR l.ProjectType LIKE @search
    ) `;
  }

  const employeeId = toInt(filters.employeeId ?? filters.assignedEmployeeId);
  if (employeeId) {
    request.input('employeeId', sql.Int, employeeId);
    where += ' AND l.AssignedEmployeeId = @employeeId ';
  }

  const city = filters.city != null ? String(filters.city).trim() : '';
  if (city && city !== 'الكل') {
    request.input('city', sql.NVarChar(100), city);
    where += ' AND LTRIM(RTRIM(ISNULL(l.City, N\'\'))) = @city ';
  }

  const projectType =
    filters.projectType != null ? String(filters.projectType).trim() : '';
  if (projectType && projectType !== 'الكل') {
    request.input('projectType', sql.NVarChar(150), projectType);
    where += ' AND LTRIM(RTRIM(ISNULL(l.ProjectType, N\'\'))) = @projectType ';
  }

  if (filters.dateFrom) {
    request.input('dateFrom', sql.DateTime, new Date(filters.dateFrom));
    where += ' AND ISNULL(l.LeadDate, l.CreatedAt) >= @dateFrom ';
  }
  if (filters.dateTo) {
    // inclusive end-of-day-ish
    const d = new Date(filters.dateTo);
    d.setHours(23, 59, 59, 999);
    request.input('dateTo', sql.DateTime, d);
    where += ' AND ISNULL(l.LeadDate, l.CreatedAt) <= @dateTo ';
  }

  if (filters.platform) {
    request.input('platform', sql.NVarChar(50), filters.platform);
    where += ' AND l.Platform = @platform ';
  }

  if (filters.lateFollowUpOnly === '1' || filters.lateFollowUpOnly === true) {
    where += `
      AND l.LeadStatus NOT IN (N'محول', N'مرفوض')
      AND l.IsConverted = 0
      AND ISNULL(l.LeadDate, l.CreatedAt) < DATEADD(HOUR, -1, GETDATE())
    `;
  }

  request.input('offset', sql.Int, offset);
  request.input('limit', sql.Int, limit);

  const countResult = await request.query(`
    SELECT COUNT(1) AS total
    FROM LeadsCRM l
    ${where}
  `);
  const total = countResult.recordset[0]?.total || 0;

  // new request for data (mssql request is single-use after query in some paths — recreate)
  const dataReq = pool.request();
  if (status && status !== 'الكل') dataReq.input('status', sql.NVarChar(50), status);
  if (filters.search && String(filters.search).trim()) {
    dataReq.input('search', sql.NVarChar(100), `%${String(filters.search).trim()}%`);
  }
  if (employeeId) dataReq.input('employeeId', sql.Int, employeeId);
  if (city && city !== 'الكل') dataReq.input('city', sql.NVarChar(100), city);
  if (projectType && projectType !== 'الكل') {
    dataReq.input('projectType', sql.NVarChar(150), projectType);
  }
  if (filters.dateFrom) dataReq.input('dateFrom', sql.DateTime, new Date(filters.dateFrom));
  if (filters.dateTo) {
    const d = new Date(filters.dateTo);
    d.setHours(23, 59, 59, 999);
    dataReq.input('dateTo', sql.DateTime, d);
  }
  if (filters.platform) dataReq.input('platform', sql.NVarChar(50), filters.platform);
  dataReq.input('offset', sql.Int, offset);
  dataReq.input('limit', sql.Int, limit);

  const dataResult = await dataReq.query(`
    SELECT
      l.LeadId, l.FullName, l.Phone, l.Phone2, l.Email,
      l.City, l.Area, l.Address,
      l.CampaignName, l.AdName, l.AdSetName, l.FormName, l.Platform,
      l.ProjectType, l.ProjectStage, l.Budget, l.BestTimeToReach,
      l.DecisionMaker, l.LeadStatus, l.IsConverted,
      l.AssignedEmployeeId, e.FullName AS AssignedEmployeeName,
      l.ConvertedPartyId, l.ConvertedOpportunityId,
      l.IsDuplicate, l.Feedback, l.RejectedReason, l.Notes,
      l.LastContactDate, l.LeadDate, l.CreatedAt, l.CreatedBy
    FROM LeadsCRM l
    LEFT JOIN Employees e ON l.AssignedEmployeeId = e.EmployeeID
    ${where}
    ORDER BY l.LeadId DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  `);

  return {
    items: dataResult.recordset,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

// ═══════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════
async function getFilterOptions() {
  const pool = await connectDB();
  const cities = await pool.request().query(`
    SELECT DISTINCT LTRIM(RTRIM(City)) AS value
    FROM LeadsCRM
    WHERE City IS NOT NULL AND LTRIM(RTRIM(City)) <> N''
    ORDER BY value
  `);
  const projectTypes = await pool.request().query(`
    SELECT DISTINCT LTRIM(RTRIM(ProjectType)) AS value
    FROM LeadsCRM
    WHERE ProjectType IS NOT NULL AND LTRIM(RTRIM(ProjectType)) <> N''
    ORDER BY value
  `);
  return {
    cities: (cities.recordset || []).map((r) => r.value).filter(Boolean),
    projectTypes: (projectTypes.recordset || []).map((r) => r.value).filter(Boolean),
  };
}

async function getStats(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let where = ' WHERE 1=1 ';

  const employeeId = toInt(filters.employeeId);
  if (employeeId) {
    request.input('employeeId', sql.Int, employeeId);
    where += ' AND AssignedEmployeeId = @employeeId ';
  }
  const city = filters.city != null ? String(filters.city).trim() : '';
  if (city && city !== 'الكل') {
    request.input('city', sql.NVarChar(100), city);
    where += ' AND LTRIM(RTRIM(ISNULL(City, N\'\'))) = @city ';
  }
  const projectType =
    filters.projectType != null ? String(filters.projectType).trim() : '';
  if (projectType && projectType !== 'الكل') {
    request.input('projectType', sql.NVarChar(150), projectType);
    where += ' AND LTRIM(RTRIM(ISNULL(ProjectType, N\'\'))) = @projectType ';
  }
  if (filters.dateFrom) {
    request.input('dateFrom', sql.DateTime, new Date(filters.dateFrom));
    where += ' AND ISNULL(LeadDate, CreatedAt) >= @dateFrom ';
  }
  if (filters.dateTo) {
    const d = new Date(filters.dateTo);
    d.setHours(23, 59, 59, 999);
    request.input('dateTo', sql.DateTime, d);
    where += ' AND ISNULL(LeadDate, CreatedAt) <= @dateTo ';
  }

  const result = await request.query(`
    SELECT
      COUNT(1) AS TotalLeads,
      SUM(CASE WHEN LeadStatus = N'جديد' THEN 1 ELSE 0 END) AS NewLeads,
      SUM(CASE WHEN LeadStatus = N'تم الإسناد' THEN 1 ELSE 0 END) AS AssignedLeads,
      SUM(CASE WHEN LeadStatus = N'تم التواصل' THEN 1 ELSE 0 END) AS ContactedLeads,
      SUM(CASE WHEN LeadStatus = N'مؤهل' THEN 1 ELSE 0 END) AS QualifiedLeads,
      SUM(CASE WHEN LeadStatus = N'محول' OR IsConverted = 1 THEN 1 ELSE 0 END) AS ConvertedLeads,
      SUM(CASE WHEN LeadStatus = N'مرفوض' THEN 1 ELSE 0 END) AS RejectedLeads,
      SUM(CASE
            WHEN LeadStatus NOT IN (N'محول', N'مرفوض') AND IsConverted = 0
             AND ISNULL(LeadDate, CreatedAt) < DATEADD(HOUR, -1, GETDATE())
            THEN 1 ELSE 0 END) AS LateFollowUps
    FROM LeadsCRM
    ${where}
  `);

  const row = result.recordset[0] || {};
  return {
    totalLeads: row.TotalLeads || 0,
    newLeads: row.NewLeads || 0,
    assignedLeads: row.AssignedLeads || 0,
    contactedLeads: row.ContactedLeads || 0,
    qualifiedLeads: row.QualifiedLeads || 0,
    convertedLeads: row.ConvertedLeads || 0,
    rejectedLeads: row.RejectedLeads || 0,
    lateFollowUps: row.LateFollowUps || 0,
  };
}

// ═══════════════════════════════════════════════════════════
// DETAIL
// ═══════════════════════════════════════════════════════════
async function getLeadById(leadId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .query(`
      SELECT
        l.*,
        e.FullName AS AssignedEmployeeName,
        oe.FullName AS OpportunityEmployeeName
      FROM LeadsCRM l
      LEFT JOIN Employees e ON l.AssignedEmployeeId = e.EmployeeID
      LEFT JOIN SalesOpportunities so ON l.ConvertedOpportunityId = so.OpportunityID
      LEFT JOIN Employees oe ON so.EmployeeID = oe.EmployeeID
      WHERE l.LeadId = @leadId
    `);

  const lead = result.recordset[0] || null;
  if (lead) {
    lead.LeadStatus = normalizeStatus(lead.LeadStatus);
    lead.CanConvert = canConvertLead(lead);
  }
  return lead;
}

function canConvertLead(lead) {
  if (!lead) return false;
  if (lead.IsConverted === true || lead.IsConverted === 1) return false;
  const status = normalizeStatus(lead.LeadStatus);
  if (status === STATUSES.CONVERTED || status === STATUSES.REJECTED) return false;
  return status === STATUSES.CONTACTED || !!lead.LastContactDate;
}

// ═══════════════════════════════════════════════════════════
// EMPLOYEES (assignable)
// ═══════════════════════════════════════════════════════════
async function getAssignableEmployees() {
  // Same rule as Blazor LeadsCrmService.GetAssignableEmployeesAsync:
  // Active + Department in (المبيعات, إدارة العلاقات العامة)
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT
      EmployeeID AS EmployeeId,
      FullName,
      Department,
      Status,
      JobTitle,
      MobilePhone
    FROM Employees
    WHERE Status IN (N'نشط', N'Active')
      AND Department IS NOT NULL
      AND LTRIM(RTRIM(Department)) IN (N'المبيعات', N'إدارة العلاقات العامة')
    ORDER BY FullName
  `);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// UPDATE (status / assign / notes) — Blazor UpdateLeadAsync
// ═══════════════════════════════════════════════════════════
async function updateLead(leadId, data, userName = 'System') {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const req = new sql.Request(transaction);
    const leadResult = await req
      .input('leadId', sql.Int, leadId)
      .query('SELECT * FROM LeadsCRM WHERE LeadId = @leadId');

    const lead = leadResult.recordset[0];
    if (!lead) {
      await transaction.rollback();
      return { success: false, message: 'Lead غير موجود' };
    }

    const statusNow = normalizeStatus(lead.LeadStatus);
    if (statusNow === STATUSES.CONVERTED || lead.IsConverted) {
      await transaction.rollback();
      return { success: false, message: 'لا يمكن تعديل Lead محوّل' };
    }

    const now = new Date();
    const oldStatus = lead.LeadStatus;
    const oldAssigned = lead.AssignedEmployeeId;

    let newStatus = data.leadStatus !== undefined
      ? normalizeStatus(data.leadStatus)
      : lead.LeadStatus;

    let assignedEmployeeId =
      data.assignedEmployeeId !== undefined
        ? toInt(data.assignedEmployeeId, null)
        : lead.AssignedEmployeeId;

    // allow explicit null unassign
    if (data.assignedEmployeeId === null) assignedEmployeeId = null;

    const notes = data.notes !== undefined ? data.notes : lead.Notes;
    const feedback = data.feedback !== undefined ? data.feedback : lead.Feedback;
    let rejectedReason = data.rejectedReason !== undefined
      ? data.rejectedReason
      : lead.RejectedReason;

    let hasContactAction = false;
    if (newStatus === STATUSES.CONTACTED || newStatus === STATUSES.QUALIFIED_LEGACY) {
      hasContactAction = true;
    }
    if (newStatus === STATUSES.REJECTED) {
      hasContactAction = true;
      if (!rejectedReason && data.rejectedReason) rejectedReason = data.rejectedReason;
    }
    if (feedback && String(feedback).trim() && feedback !== lead.Feedback) {
      hasContactAction = true;
    }

    const assignmentChanged = oldAssigned !== assignedEmployeeId;

    // Auto: assign on جديد → تم الإسناد
    if (assignmentChanged && assignedEmployeeId && normalizeStatus(newStatus) === STATUSES.NEW) {
      newStatus = STATUSES.ASSIGNED;
    } else if (
      assignmentChanged &&
      assignedEmployeeId &&
      normalizeStatus(lead.LeadStatus) === STATUSES.NEW &&
      data.leadStatus === undefined
    ) {
      newStatus = STATUSES.ASSIGNED;
    }

    const lastContactDate = hasContactAction ? now : lead.LastContactDate;
    const qualifiedDate =
      newStatus === STATUSES.QUALIFIED_LEGACY && oldStatus !== STATUSES.QUALIFIED_LEGACY
        ? now
        : lead.QualifiedDate;

    await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .input('status', sql.NVarChar(50), newStatus)
      .input('employeeId', sql.Int, assignedEmployeeId)
      .input('notes', sql.NVarChar(sql.MAX), notes)
      .input('feedback', sql.NVarChar(sql.MAX), feedback)
      .input('rejectedReason', sql.NVarChar(sql.MAX), rejectedReason)
      .input('lastContact', sql.DateTime, lastContactDate)
      .input('qualifiedDate', sql.DateTime, qualifiedDate)
      .query(`
        UPDATE LeadsCRM SET
          LeadStatus = @status,
          AssignedEmployeeId = @employeeId,
          Notes = @notes,
          Feedback = @feedback,
          RejectedReason = @rejectedReason,
          LastContactDate = @lastContact,
          QualifiedDate = @qualifiedDate
        WHERE LeadId = @leadId
      `);

    // System interaction on assign
    if (assignmentChanged && assignedEmployeeId) {
      await insertLeadInteraction(transaction, {
        leadId,
        employeeId: assignedEmployeeId,
        interactionType: INTERACTION_TYPES.ASSIGNED,
        summary: 'تم إسناد الـ Lead إلى موظف مسؤول.',
        notes: null,
        oldLeadStatus: oldStatus,
        newLeadStatus: newStatus,
        nextFollowUpDate: null,
        isSystemGenerated: true,
        createdBy: userName,
      });
    }

    if (assignmentChanged && !assignedEmployeeId && oldAssigned) {
      await insertLeadInteraction(transaction, {
        leadId,
        employeeId: oldAssigned,
        interactionType: INTERACTION_TYPES.NOTE,
        summary: 'تم إلغاء إسناد الـ Lead من الموظف السابق.',
        notes: null,
        oldLeadStatus: oldStatus,
        newLeadStatus: newStatus,
        nextFollowUpDate: null,
        isSystemGenerated: true,
        createdBy: userName,
      });
    }

    // Reject system interaction when status flipped to مرفوض via update
    if (
      normalizeStatus(newStatus) === STATUSES.REJECTED &&
      normalizeStatus(oldStatus) !== STATUSES.REJECTED
    ) {
      await insertLeadInteraction(transaction, {
        leadId,
        employeeId: assignedEmployeeId || oldAssigned,
        interactionType: INTERACTION_TYPES.REJECTED,
        summary: rejectedReason || 'تم رفض الـ Lead',
        notes: feedback,
        oldLeadStatus: oldStatus,
        newLeadStatus: STATUSES.REJECTED,
        nextFollowUpDate: null,
        isSystemGenerated: true,
        createdBy: userName,
      });
    }

    await transaction.commit();

    // Notify outside transaction
    if (assignmentChanged && assignedEmployeeId) {
      const fresh = await getLeadById(leadId);
      await notifyLeadAssigned(fresh || lead, assignedEmployeeId, userName);
    }

    return { success: true, message: 'تم التحديث بنجاح', leadId };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// INTERACTIONS
// ═══════════════════════════════════════════════════════════
async function getLeadInteractions(leadId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .query(`
      SELECT
        i.LeadInteractionId,
        i.LeadId,
        i.EmployeeId,
        e.FullName AS EmployeeName,
        i.InteractionType,
        i.InteractionDate,
        i.Summary,
        i.Notes,
        i.OldLeadStatus,
        i.NewLeadStatus,
        i.NextFollowUpDate,
        i.IsCompleted,
        i.CompletedByEmployeeId,
        i.CompletedDate,
        i.IsSystemGenerated,
        i.CreatedBy,
        i.CreatedAt
      FROM LeadInteractions i
      LEFT JOIN Employees e ON i.EmployeeId = e.EmployeeID
      WHERE i.LeadId = @leadId
      ORDER BY i.InteractionDate DESC, i.LeadInteractionId DESC
    `);
  return result.recordset;
}

async function insertLeadInteraction(transactionOrNull, payload) {
  const run = async (requestFactory) => {
    const request = requestFactory();
    const result = await request
      .input('leadId', sql.Int, payload.leadId)
      .input('employeeId', sql.Int, payload.employeeId || null)
      .input('type', sql.NVarChar(50), payload.interactionType)
      .input('summary', sql.NVarChar(sql.MAX), payload.summary || null)
      .input('notes', sql.NVarChar(sql.MAX), payload.notes || null)
      .input('oldStatus', sql.NVarChar(50), payload.oldLeadStatus || null)
      .input('newStatus', sql.NVarChar(50), payload.newLeadStatus || null)
      .input('nextFollowUp', sql.DateTime, payload.nextFollowUpDate || null)
      .input('isSystem', sql.Bit, payload.isSystemGenerated ? 1 : 0)
      .input('createdBy', sql.NVarChar(100), payload.createdBy || 'System')
      .query(`
        INSERT INTO LeadInteractions (
          LeadId, EmployeeId, InteractionType, InteractionDate,
          Summary, Notes, OldLeadStatus, NewLeadStatus, NextFollowUpDate,
          IsCompleted, IsSystemGenerated, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.LeadInteractionId
        VALUES (
          @leadId, @employeeId, @type, GETDATE(),
          @summary, @notes, @oldStatus, @newStatus, @nextFollowUp,
          0, @isSystem, @createdBy, GETDATE()
        )
      `);
    return result.recordset[0]?.LeadInteractionId;
  };

  if (transactionOrNull) {
    return run(() => new sql.Request(transactionOrNull));
  }
  const pool = await connectDB();
  return run(() => pool.request());
}

/**
 * Blazor AddLeadInteractionAsync parity
 */
async function addLeadInteraction(leadId, data, userName = 'System') {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const leadRes = await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .query('SELECT * FROM LeadsCRM WHERE LeadId = @leadId');

    const lead = leadRes.recordset[0];
    if (!lead) {
      await transaction.rollback();
      return { success: false, message: 'Lead غير موجود' };
    }

    if (lead.IsConverted || normalizeStatus(lead.LeadStatus) === STATUSES.CONVERTED) {
      await transaction.rollback();
      return { success: false, message: 'لا يمكن إضافة تواصل على Lead محوّل' };
    }
    if (normalizeStatus(lead.LeadStatus) === STATUSES.REJECTED) {
      await transaction.rollback();
      return { success: false, message: 'لا يمكن إضافة تواصل على Lead مرفوض' };
    }

    const now = new Date();
    const oldStatus = lead.LeadStatus;
    const interactionType = (data.interactionType || INTERACTION_TYPES.NOTE).trim();
    let newStatus = data.newLeadStatus ? normalizeStatus(data.newLeadStatus) : null;

    // Resolve employee: body → assigned → user.employee
    let empId = toInt(data.employeeId, null);
    if (!empId) empId = lead.AssignedEmployeeId || null;
    if (!empId && userName) {
      const u = await new sql.Request(transaction)
        .input('username', sql.NVarChar(100), userName)
        .query('SELECT employeeID FROM Users WHERE Username = @username');
      empId = u.recordset[0]?.employeeID || null;
    }

    // Close open follow-ups
    await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .input('empId', sql.Int, empId)
      .query(`
        UPDATE LeadInteractions
        SET IsCompleted = 1,
            CompletedByEmployeeId = @empId,
            CompletedDate = GETDATE()
        WHERE LeadId = @leadId
          AND NextFollowUpDate IS NOT NULL
          AND ISNULL(IsCompleted, 0) = 0
      `);

    let assignedEmployeeId = lead.AssignedEmployeeId;
    let leadStatus = lead.LeadStatus;
    let lastContactDate = lead.LastContactDate;
    let rejectedReason = lead.RejectedReason;

    // Auto-assign if unassigned
    if (!assignedEmployeeId && empId) {
      assignedEmployeeId = empId;
      if (normalizeStatus(leadStatus) === STATUSES.NEW) {
        leadStatus = STATUSES.ASSIGNED;
      }
    }

    if (newStatus) {
      leadStatus = newStatus;
      if (newStatus === STATUSES.CONTACTED) {
        lastContactDate = now;
      } else if (newStatus === STATUSES.REJECTED) {
        lastContactDate = now;
        if (data.rejectedReason) rejectedReason = data.rejectedReason;
      } else if (newStatus === STATUSES.CONVERTED) {
        lastContactDate = now;
      }
    } else if (CONTACT_TYPES.has(interactionType)) {
      lastContactDate = now;
      const st = normalizeStatus(leadStatus);
      if (st === STATUSES.NEW || st === STATUSES.ASSIGNED) {
        leadStatus = STATUSES.CONTACTED;
        newStatus = STATUSES.CONTACTED;
      }
    }

    const interactionId = await insertLeadInteraction(transaction, {
      leadId,
      employeeId: empId,
      interactionType,
      summary: data.summary || null,
      notes: data.notes || null,
      oldLeadStatus: oldStatus,
      newLeadStatus: newStatus,
      nextFollowUpDate: data.nextFollowUpDate ? new Date(data.nextFollowUpDate) : null,
      isSystemGenerated: false,
      createdBy: userName,
    });

    await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .input('status', sql.NVarChar(50), leadStatus)
      .input('employeeId', sql.Int, assignedEmployeeId)
      .input('lastContact', sql.DateTime, lastContactDate)
      .input('rejectedReason', sql.NVarChar(sql.MAX), rejectedReason)
      .query(`
        UPDATE LeadsCRM SET
          LeadStatus = @status,
          AssignedEmployeeId = @employeeId,
          LastContactDate = @lastContact,
          RejectedReason = @rejectedReason
        WHERE LeadId = @leadId
      `);

    await transaction.commit();

    // Notify if we newly assigned via interaction
    if (!lead.AssignedEmployeeId && assignedEmployeeId) {
      const fresh = await getLeadById(leadId);
      await notifyLeadAssigned(fresh || lead, assignedEmployeeId, userName);
    }

    return {
      success: true,
      message: 'تم تسجيل التواصل بنجاح',
      interactionId,
      leadStatus,
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// CONVERT — Blazor ConvertLeadToClientAsync parity
// ═══════════════════════════════════════════════════════════
async function convertLeadToClient(leadId, dto = {}, userName = 'System') {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const leadRes = await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .query('SELECT * FROM LeadsCRM WHERE LeadId = @leadId');

    const lead = leadRes.recordset[0];
    if (!lead) {
      await transaction.rollback();
      return { success: false, message: 'Lead غير موجود' };
    }
    if (lead.IsConverted) {
      await transaction.rollback();
      return { success: false, message: 'الـ Lead ده اتحول لعميل قبل كده' };
    }

    const status = normalizeStatus(lead.LeadStatus);
    if (status === STATUSES.REJECTED) {
      await transaction.rollback();
      return { success: false, message: 'لا يمكن تحويل Lead مرفوض' };
    }
    if (!(status === STATUSES.CONTACTED || lead.LastContactDate)) {
      await transaction.rollback();
      return {
        success: false,
        message: 'يجب تسجيل تواصل مع الـ Lead قبل التحويل (حالة تم التواصل)',
      };
    }

    const employeeId = toInt(dto.employeeId ?? dto.EmployeeId, null)
      || lead.AssignedEmployeeId;
    if (!employeeId) {
      await transaction.rollback();
      return {
        success: false,
        message: 'يجب اختيار الموظف الذي ستُسند إليه الفرصة قبل التحويل',
      };
    }

    const empRes = await new sql.Request(transaction)
      .input('employeeId', sql.Int, employeeId)
      .query(`
        SELECT EmployeeID, FullName, Status
        FROM Employees
        WHERE EmployeeID = @employeeId
          AND Status IN (N'نشط', N'Active')
      `);
    if (!empRes.recordset[0]) {
      await transaction.rollback();
      return { success: false, message: 'الموظف المختار غير موجود أو غير نشط' };
    }

    if (!lead.FullName || !lead.Phone) {
      await transaction.rollback();
      return { success: false, message: 'بيانات الـ Lead ناقصة (الاسم أو الموبايل)' };
    }

    const phoneCheck = await new sql.Request(transaction)
      .input('phone', sql.NVarChar(50), String(lead.Phone).trim())
      .query(`
        SELECT TOP 1 PartyID FROM Parties
        WHERE Phone = @phone AND ISNULL(IsActive, 1) = 1
      `);
    if (phoneCheck.recordset[0]) {
      await transaction.rollback();
      return { success: false, message: 'رقم الهاتف موجود بالفعل في العملاء' };
    }

    // Initial stage: المرحلة 1 = عميل مؤهل (Lead) else أول مرحلة مفعّلة
    let stageRes = await new sql.Request(transaction).query(`
      SELECT TOP 1 StageID
      FROM SalesStages
      WHERE IsActive = 1
        AND (StageName = 'Lead' OR StageNameAr = N'عميل مؤهل')
      ORDER BY StageOrder
    `);
    let stageId = stageRes.recordset[0]?.StageID;
    if (!stageId) {
      stageRes = await new sql.Request(transaction).query(`
        SELECT TOP 1 StageID FROM SalesStages
        WHERE IsActive = 1 ORDER BY StageOrder
      `);
      stageId = stageRes.recordset[0]?.StageID;
    }
    if (!stageId) {
      await transaction.rollback();
      return { success: false, message: 'لا توجد مراحل بيع مفعّلة' };
    }

    const expectedValue = toDecimal(dto.expectedValue ?? dto.ExpectedValue, 0);
    const notes = dto.notes ?? dto.Notes ?? lead.Notes ?? null;
    const categoryId = toInt(dto.categoryId ?? dto.CategoryId, null);
    const taskTypeId = toInt(dto.taskTypeId ?? dto.TaskTypeId, null);
    const oldLeadStatus = lead.LeadStatus;

    // قراءة البيانات الإضافية المحفوظة عند إضافة الليد اليدوي (JSON)
    let leadExtra = {};
    try { leadExtra = lead.ExtraData ? JSON.parse(lead.ExtraData) : {}; } catch (_) {}

    // المصدر: لو مفيش sourceId من الشاشة → نجيبه من Platform المحفوظ
    let sourceId = toInt(dto.sourceId ?? dto.SourceId, null);
    if (!sourceId && lead.Platform) {
      const sRes = await new sql.Request(transaction)
        .input('p', sql.NVarChar(50), String(lead.Platform).trim())
        .query(`
          SELECT TOP 1 SourceID FROM ContactSources
          WHERE SourceName = @p AND ISNULL(IsActive, 1) = 1
        `);
      sourceId = sRes.recordset[0]?.SourceID ?? null;
    }

    // الحملة: لو مفيش adTypeId → نجيبه من CampaignName المحفوظ
    let adTypeId = toInt(dto.adTypeId ?? dto.AdTypeId, null);
    if (!adTypeId && lead.CampaignName) {
      const aRes = await new sql.Request(transaction)
        .input('c', sql.NVarChar(300), String(lead.CampaignName).trim())
        .query(`
          SELECT TOP 1 AdTypeID FROM AdTypes
          WHERE AdTypeName = @c AND ISNULL(IsActive, 1) = 1
        `);
      adTypeId = aRes.recordset[0]?.AdTypeID ?? null;
    }

    // التوجيهات: من ExtraData لو موجودة، وإلا نبنيها من بيانات الليد
    const guidance = leadExtra.guidance || buildGuidanceFromLead(lead);

    // تاريخ المتابعة: من ExtraData لو موجود، وإلا غداً
    let nextFollowUpDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (leadExtra.nextFollowUp) {
      const parsed = new Date(leadExtra.nextFollowUp);
      if (!isNaN(parsed.getTime())) nextFollowUpDate = parsed;
    }

    // 1) Party
    const partyResult = await new sql.Request(transaction)
      .input('partyName', sql.NVarChar(200), String(lead.FullName).trim())
      .input('phone', sql.NVarChar(50), String(lead.Phone).trim())
      .input('phone2', sql.NVarChar(50), lead.Phone2 || null)
      .input('email', sql.NVarChar(100), lead.Email || null)
      .input('address', sql.NVarChar(250), lead.Address || lead.City || null)
      .input('referralSourceId', sql.Int, sourceId || null)
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        DECLARE @ids TABLE (id INT);
        INSERT INTO Parties (
          PartyName, PartyType, Phone, Phone2, Email, Address,
          ReferralSourceID, IsActive, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.PartyID INTO @ids
        VALUES (
          @partyName, 1, @phone, @phone2, @email, @address,
          @referralSourceId, 1, @createdBy, GETDATE()
        );
        SELECT id FROM @ids;
      `);
    const partyId = partyResult.recordset[0].id;

    // 2) Opportunity (column set matches working opportunities module)
    const oppResult = await new sql.Request(transaction)
      .input('partyId', sql.Int, partyId)
      .input('employeeId', sql.Int, employeeId)
      .input('sourceId', sql.Int, sourceId)
      .input('adTypeId', sql.Int, adTypeId)
      .input('stageId', sql.Int, stageId)
      .input('categoryId', sql.Int, categoryId)
      .input('interestedProduct', sql.NVarChar(255), lead.ProjectType || null)
      .input('nextFollowUp', sql.DateTime, nextFollowUpDate)
      .input('notes', sql.NVarChar(sql.MAX), notes)
      .input('expectedValue', sql.Decimal(18, 2), expectedValue)
      .input('guidance', sql.NVarChar(sql.MAX), guidance)
      .input('createdBy', sql.NVarChar(50), userName)
      .query(`
        DECLARE @ids TABLE (id INT);
        INSERT INTO SalesOpportunities (
          PartyID, EmployeeID, SourceID, AdTypeID, CategoryID,
          StageID, InterestedProduct, ExpectedValue,
          Notes, Guidance, NextFollowUpDate, FirstContactDate,
          CreatedBy, CreatedAt, IsActive
        )
        OUTPUT INSERTED.OpportunityID INTO @ids
        VALUES (
          @partyId, @employeeId, @sourceId, @adTypeId, @categoryId,
          @stageId, @interestedProduct, @expectedValue,
          @notes, @guidance, @nextFollowUp, GETDATE(),
          @createdBy, GETDATE(), 1
        );
        SELECT id FROM @ids;
      `);
    const opportunityId = oppResult.recordset[0].id;

    // 3) Customer interaction
    await new sql.Request(transaction)
      .input('opportunityId', sql.Int, opportunityId)
      .input('partyId', sql.Int, partyId)
      .input('employeeId', sql.Int, employeeId)
      .input('sourceId', sql.Int, sourceId)
      .input('stageAfterId', sql.Int, stageId)
      .input('summary', sql.NVarChar(1000),
        `تحويل Lead يدوي - المصدر: ${leadExtra.sourceAr || lead.Platform || 'غير محدد'}${lead.CampaignName ? ` - الحملة: ${lead.CampaignName}` : ''}`)
      .input('nextFollowUp', sql.DateTime, nextFollowUpDate)
      .input('notes', sql.NVarChar(500), notes)
      .input('createdBy', sql.NVarChar(50), userName)
      .query(`
        INSERT INTO CustomerInteractions (
          OpportunityID, PartyID, EmployeeID, SourceID,
          InteractionDate, Summary, StageAfterID, NextFollowUpDate,
          Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @opportunityId, @partyId, @employeeId, @sourceId,
          GETDATE(), @summary, @stageAfterId, @nextFollowUp,
          @notes, @createdBy, GETDATE()
        )
      `);

    // 4) CRM Task
    await new sql.Request(transaction)
      .input('opportunityId', sql.Int, opportunityId)
      .input('partyId', sql.Int, partyId)
      .input('assignedTo', sql.Int, employeeId)
      .input('taskTypeId', sql.Int, taskTypeId)
      .input('taskDescription', sql.NVarChar(sql.MAX),
        `متابعة عميل جديد من Meta: ${lead.FullName}`)
      .input('dueDate', sql.DateTime, new Date(Date.now() + 24 * 60 * 60 * 1000))
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO CRM_Tasks (
          OpportunityID, PartyID, AssignedTo, TaskTypeID,
          TaskDescription, DueDate, Priority, Status,
          ReminderEnabled, IsActive, CreatedBy, CreatedAt
        )
        VALUES (
          @opportunityId, @partyId, @assignedTo, @taskTypeId,
          @taskDescription, @dueDate, 'Normal', 'Pending',
          1, 1, @createdBy, GETDATE()
        )
      `);

    // 5) Update lead
    await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .input('partyId', sql.Int, partyId)
      .input('oppId', sql.Int, opportunityId)
      .input('convertedBy', sql.NVarChar(100), userName)
      .input('employeeId', sql.Int, employeeId)
      .query(`
        UPDATE LeadsCRM SET
          IsConverted = 1,
          LeadStatus = N'محول',
          ConvertedPartyId = @partyId,
          ConvertedOpportunityId = @oppId,
          ConvertedDate = GETDATE(),
          ConvertedBy = @convertedBy,
          LastContactDate = GETDATE(),
          AssignedEmployeeId = ISNULL(AssignedEmployeeId, @employeeId)
        WHERE LeadId = @leadId
      `);

    // 6) Lead interaction system
    await insertLeadInteraction(transaction, {
      leadId,
      employeeId,
      interactionType: INTERACTION_TYPES.CONVERTED,
      summary: `تم تحويل الـ Lead إلى فرصة بيع #${opportunityId}`,
      notes,
      oldLeadStatus: oldLeadStatus,
      newLeadStatus: STATUSES.CONVERTED,
      nextFollowUpDate: null,
      isSystemGenerated: true,
      createdBy: userName,
    });

    await transaction.commit();

    // 7) Notify
    try {
      await notifyOpportunityFromConversion(lead, opportunityId, employeeId, userName);
    } catch (e) {
      console.error('⚠️ convert notify failed:', e.message);
    }

    return {
      success: true,
      message: 'تم تحويل Lead لعميل بنجاح',
      partyId,
      opportunityId,
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    console.error('convertLeadToClient error:', err);
    return {
      success: false,
      message: err.originalError?.message || err.message || 'فشل التحويل',
    };
  }
}

function buildGuidanceFromLead(lead) {
  const parts = [];
  if (lead.ProjectType) parts.push(`نوع المشروع: ${lead.ProjectType}`);
  if (lead.ProjectStage) parts.push(`مرحلة المشروع: ${lead.ProjectStage}`);
  if (lead.Budget) parts.push(`الميزانية: ${lead.Budget}`);
  if (lead.DecisionMaker) parts.push(`متخذ القرار: ${lead.DecisionMaker}`);
  if (lead.BestTimeToReach) parts.push(`أفضل وقت: ${lead.BestTimeToReach}`);
  if (lead.CampaignName) parts.push(`الحملة: ${lead.CampaignName}`);
  if (lead.Platform) parts.push(`المنصة: ${lead.Platform}`);
  return parts.length ? parts.join(' | ') : null;
}

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS + FCM (via notifications.queries)
// ═══════════════════════════════════════════════════════════
async function getUsernameByEmployeeId(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT TOP 1 Username, FullName
      FROM Users
      WHERE employeeID = @employeeId AND ISNULL(IsActive, 1) = 1
    `);
  return result.recordset[0] || null;
}

async function notifyLeadAssigned(lead, employeeId, assignedBy) {
  try {
    const user = await getUsernameByEmployeeId(employeeId);
    if (!user?.Username) {
      console.warn(`⚠️ Lead ${lead.LeadId} assigned to emp ${employeeId} but no linked user`);
      return;
    }
    const campaignPart = lead.CampaignName ? ` من حملة: ${lead.CampaignName}` : '';
    await notificationsQueries.createNotification({
      title: '📌 تم إسناد Lead جديد لك',
      message:
        `تم إسناد Lead لك: ${lead.FullName} - ${lead.Phone}${campaignPart}. ` +
        'برجاء المتابعة واتخاذ إجراء.',
      recipientUser: user.Username,
      relatedTable: 'LeadsCRM',
      relatedId: lead.LeadId,
      // Blazor source-of-truth form key
      formName: 'crm/leads/my',
      createdBy: assignedBy || 'System',
    });
  } catch (e) {
    console.error('notifyLeadAssigned:', e.message);
  }
}

async function notifyOpportunityFromConversion(lead, opportunityId, employeeId, actor) {
  try {
    const user = await getUsernameByEmployeeId(employeeId);
    if (!user?.Username) return;

    await notificationsQueries.createNotification({
      title: '🎯 تم تحويل Lead إلى فرصة بيع لك',
      message:
        `تم تحويل Lead العميل ${lead.FullName} إلى فرصة بيع رقم #${opportunityId} وتم إسنادها لك. برجاء البدء في المتابعة.`,
      recipientUser: user.Username,
      relatedTable: 'SalesOpportunities',
      relatedId: opportunityId,
      // Blazor key
      formName: 'crm/opportunities',
      createdBy: actor || 'System',
    });
  } catch (e) {
    console.error('notifyOpportunityFromConversion:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// CREATE manual lead (basic — for list "add" later)
// ═══════════════════════════════════════════════════════════
async function createLead(data, userName = 'System') {
  const pool = await connectDB();
  if (!data.fullName || !data.phone) {
    return { success: false, message: 'الاسم والهاتف مطلوبان' };
  }

  // بيانات إضافية (JSON في عمود ExtraData — من غير أي عمود جديد)
  const extra = {};
  if (data.guidance) extra.guidance = String(data.guidance);
  if (data.nextFollowUp) extra.nextFollowUp = String(data.nextFollowUp);
  if (data.sourceNameAr) extra.sourceAr = String(data.sourceNameAr);
  if (data.adTypeNameAr) extra.adTypeAr = String(data.adTypeNameAr);
  const extraDataJson = Object.keys(extra).length ? JSON.stringify(extra) : null;

  const result = await pool.request()
    .input('fullName', sql.NVarChar(200), String(data.fullName).trim())
    .input('phone', sql.NVarChar(50), String(data.phone).trim())
    .input('phone2', sql.NVarChar(50), data.phone2 || null)
    .input('email', sql.NVarChar(200), data.email || null)
    .input('city', sql.NVarChar(100), data.city || null)
    .input('area', sql.NVarChar(100), data.area || null)
    .input('address', sql.NVarChar(500), data.address || null)
    .input('projectType', sql.NVarChar(200), data.projectType || null)
    .input('projectStage', sql.NVarChar(200), data.projectStage || null)
    .input('budget', sql.NVarChar(200), data.budget || null)
    .input('decisionMaker', sql.NVarChar(200), data.decisionMaker || null)
    .input('nextAction', sql.NVarChar(200), data.nextAction || null)
    .input('bestTimeToReach', sql.NVarChar(200), data.bestTimeToReach || null)
    .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
    .input('platform', sql.NVarChar(50), data.platform || 'Manual')
    .input('campaignName', sql.NVarChar(300), data.campaignName || null)
    .input('extraData', sql.NVarChar(sql.MAX), extraDataJson)
    .input('employeeId', sql.Int, toInt(data.assignedEmployeeId, null))
    .input('createdBy', sql.NVarChar(100), userName)
    .input('status', sql.NVarChar(50),
      toInt(data.assignedEmployeeId, null) ? STATUSES.ASSIGNED : STATUSES.NEW)
    .query(`
      INSERT INTO LeadsCRM (
        FullName, Phone, Phone2, Email, City, Area, Address,
        ProjectType, ProjectStage, Budget, DecisionMaker,
        NextAction, BestTimeToReach, Notes, Platform, CampaignName, ExtraData,
        LeadStatus, AssignedEmployeeId, LeadDate, CreatedAt, CreatedBy, IsConverted
      )
      OUTPUT INSERTED.LeadId
      VALUES (
        @fullName, @phone, @phone2, @email, @city, @area, @address,
        @projectType, @projectStage, @budget, @decisionMaker,
        @nextAction, @bestTimeToReach, @notes, @platform, @campaignName, @extraData,
        @status, @employeeId, GETDATE(), GETDATE(), @createdBy, 0
      )
    `);

  const leadId = result.recordset[0].LeadId;
  const empId = toInt(data.assignedEmployeeId, null);
  if (empId) {
    await insertLeadInteraction(null, {
      leadId,
      employeeId: empId,
      interactionType: INTERACTION_TYPES.ASSIGNED,
      summary: 'تم إسناد الـ Lead عند الإنشاء.',
      oldLeadStatus: STATUSES.NEW,
      newLeadStatus: STATUSES.ASSIGNED,
      isSystemGenerated: true,
      createdBy: userName,
    });
    const lead = await getLeadById(leadId);
    await notifyLeadAssigned(lead, empId, userName);
  }

  return { success: true, leadId, message: 'تم إنشاء الـ Lead' };
}


// ═══════════════════════════════════════════════════════════
// REJECT REQUEST FLOW (needs GeneralManager approval)
// InteractionType = 'طلب رفض' + IsCompleted=0 => pending
// ═══════════════════════════════════════════════════════════
const REJECT_REQUEST_TYPE = 'طلب رفض';

async function getUsersByRoles(roles = []) {
  const pool = await connectDB();
  if (!roles.length) return [];
  const req = pool.request();
  const parts = roles.map((r, i) => {
    req.input(`r${i}`, sql.NVarChar(50), r);
    return `@r${i}`;
  });
  // Also match without spaces / case-insensitive-ish via LOWER
  const result = await req.query(`
    SELECT UserID, Username, FullName, Role, employeeID, FCMToken
    FROM Users
    WHERE ISNULL(IsActive, 1) = 1
      AND (
        Role IN (${parts.join(',')})
        OR LOWER(REPLACE(ISNULL(Role,''), ' ', '')) IN (${parts.map((_, i) => `LOWER(REPLACE(@r${i}, ' ', ''))`).join(',')})
      )
  `);
  return result.recordset || [];
}

async function hasPendingRejectRequest(leadId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .input('type', sql.NVarChar(50), REJECT_REQUEST_TYPE)
    .query(`
      SELECT TOP 1 LeadInteractionId
      FROM LeadInteractions
      WHERE LeadId = @leadId
        AND InteractionType = @type
        AND ISNULL(IsCompleted, 0) = 0
      ORDER BY LeadInteractionId DESC
    `);
  return result.recordset[0] || null;
}

/**
 * Employee requests reject → notify GeneralManagers
 * Does NOT change LeadStatus until GM approves.
 */
async function requestLeadReject(leadId, data = {}, userName = 'System') {
  const pool = await connectDB();
  const lead = await getLeadById(leadId);
  if (!lead) return { success: false, message: 'Lead غير موجود' };

  const status = normalizeStatus(lead.LeadStatus);
  if (lead.IsConverted || status === STATUSES.CONVERTED) {
    return { success: false, message: 'لا يمكن رفض Lead محوّل' };
  }
  if (status === STATUSES.REJECTED) {
    return { success: false, message: 'الـ Lead مرفوض بالفعل' };
  }

  const reason = (data.reason || data.rejectedReason || '').toString().trim();
  if (!reason) return { success: false, message: 'سبب طلب الرفض مطلوب' };

  const pending = await hasPendingRejectRequest(leadId);
  if (pending) {
    return {
      success: false,
      message: 'يوجد طلب رفض معلّق بالفعل بانتظار موافقة المدير العام',
      pendingRequestId: pending.LeadInteractionId,
    };
  }

  // optional: requester employee id
  let empId = toInt(data.employeeId, null);
  if (!empId && userName) {
    const u = await pool.request()
      .input('username', sql.NVarChar(100), userName)
      .query('SELECT employeeID FROM Users WHERE Username = @username');
    empId = u.recordset[0]?.employeeID || lead.AssignedEmployeeId || null;
  }

  const interactionId = await insertLeadInteraction(null, {
    leadId,
    employeeId: empId,
    interactionType: REJECT_REQUEST_TYPE,
    summary: `طلب رفض من ${userName}`,
    notes: reason,
    oldLeadStatus: lead.LeadStatus,
    newLeadStatus: null,
    nextFollowUpDate: null,
    isSystemGenerated: false,
    createdBy: userName,
  });

  // Store pending marker lightly in Feedback (does not change status)
  try {
    await pool.request()
      .input('leadId', sql.Int, leadId)
      .input('feedback', sql.NVarChar(sql.MAX),
        `⏳ طلب رفض معلّق بواسطة ${userName}: ${reason}`)
      .query(`UPDATE LeadsCRM SET Feedback = @feedback WHERE LeadId = @leadId`);
  } catch (_) {}

  // Notify GeneralManager (+ Admin) — per username via shared helper
  const title = '⚠️ طلب رفض Lead يحتاج موافقتك';
  const message =
    `طلب ${userName} رفض Lead: ${lead.FullName} - ${lead.Phone}. السبب: ${reason}`;

  let notified = 0;
  try {
    const nr = await notificationsQueries.notifyByRoles({
      roles: ['GeneralManager', 'Admin'],
      title,
      message,
      createdBy: userName,
      // Blazor form key (Flutter maps it)
      formName: 'frm_LeadsCRM',
      relatedTable: 'LeadsCRM',
      relatedId: leadId,
      excludeUsername: userName,
    });
    notified = nr.count || 0;
  } catch (e) {
    console.error('notify GM failed', e.message);
  }

  return {
    success: true,
    message: notified > 0
      ? `تم إرسال طلب الرفض إلى المدير العام (${notified})`
      : 'تم تسجيل طلب الرفض — لم يُعثر على مستخدم GeneralManager لإشعاره',
    requestId: interactionId,
    notifiedCount: notified,
    requiresApproval: true,
  };
}

/**
 * GM decides on reject request
 * data: { approve: boolean, decisionNotes?, userName, actorRole? }
 */
async function decideLeadRejectRequest(requestId, data = {}, userName = 'System') {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const reqRes = await new sql.Request(transaction)
      .input('id', sql.Int, requestId)
      .input('type', sql.NVarChar(50), REJECT_REQUEST_TYPE)
      .query(`
        SELECT * FROM LeadInteractions
        WHERE LeadInteractionId = @id AND InteractionType = @type
      `);
    const requestRow = reqRes.recordset[0];
    if (!requestRow) {
      await transaction.rollback();
      return { success: false, message: 'طلب الرفض غير موجود' };
    }
    if (requestRow.IsCompleted) {
      await transaction.rollback();
      return { success: false, message: 'تم البت في هذا الطلب مسبقًا' };
    }

    const leadId = requestRow.LeadId;
    const leadRes = await new sql.Request(transaction)
      .input('leadId', sql.Int, leadId)
      .query('SELECT * FROM LeadsCRM WHERE LeadId = @leadId');
    const lead = leadRes.recordset[0];
    if (!lead) {
      await transaction.rollback();
      return { success: false, message: 'Lead غير موجود' };
    }

    const approve = data.approve === true || data.approve === 1 || data.approve === 'true';
    const decisionNotes = (data.decisionNotes || data.notes || '').toString().trim();
    const requester = requestRow.CreatedBy || '';
    const reason = requestRow.Notes || '';

    // complete request interaction
    await new sql.Request(transaction)
      .input('id', sql.Int, requestId)
      .input('notes', sql.NVarChar(sql.MAX),
        `${requestRow.Notes || ''}\n---\nقرار ${userName}: ${approve ? 'موافقة' : 'رفض الطلب'}${decisionNotes ? ' | ' + decisionNotes : ''}`)
      .query(`
        UPDATE LeadInteractions
        SET IsCompleted = 1,
            CompletedDate = GETDATE(),
            Notes = @notes
        WHERE LeadInteractionId = @id
      `);

    if (approve) {
      const oldStatus = lead.LeadStatus;
      await new sql.Request(transaction)
        .input('leadId', sql.Int, leadId)
        .input('reason', sql.NVarChar(sql.MAX), reason)
        .input('feedback', sql.NVarChar(sql.MAX),
          `✅ تم اعتماد الرفض بواسطة ${userName}`)
        .query(`
          UPDATE LeadsCRM SET
            LeadStatus = N'مرفوض',
            RejectedReason = @reason,
            Feedback = @feedback,
            LastContactDate = GETDATE()
          WHERE LeadId = @leadId
        `);

      await insertLeadInteraction(transaction, {
        leadId,
        employeeId: null,
        interactionType: INTERACTION_TYPES.REJECTED,
        summary: `تم اعتماد طلب الرفض بواسطة ${userName}`,
        notes: decisionNotes || reason,
        oldLeadStatus: oldStatus,
        newLeadStatus: STATUSES.REJECTED,
        isSystemGenerated: true,
        createdBy: userName,
      });
    } else {
      await new sql.Request(transaction)
        .input('leadId', sql.Int, leadId)
        .input('feedback', sql.NVarChar(sql.MAX),
          `❌ المدير العام رفض طلب الرفض — ${userName}${decisionNotes ? ': ' + decisionNotes : ''}`)
        .query(`UPDATE LeadsCRM SET Feedback = @feedback WHERE LeadId = @leadId`);

      await insertLeadInteraction(transaction, {
        leadId,
        employeeId: null,
        interactionType: INTERACTION_TYPES.NOTE,
        summary: `تم رفض طلب الرفض بواسطة ${userName}`,
        notes: decisionNotes || 'لم تتم الموافقة على الرفض',
        oldLeadStatus: lead.LeadStatus,
        newLeadStatus: lead.LeadStatus,
        isSystemGenerated: true,
        createdBy: userName,
      });
    }

    await transaction.commit();

    // Notify original requester
    if (requester) {
      try {
        await notificationsQueries.createNotification({
          title: approve
            ? '✅ تمت الموافقة على طلب رفض Lead'
            : '❌ تم رفض طلب رفض Lead',
          message: approve
            ? `المدير العام ${userName} اعتمد رفض Lead: ${lead.FullName} - ${lead.Phone}`
            : `المدير العام ${userName} رفض طلبك لرفض Lead: ${lead.FullName}. ${decisionNotes}`,
          recipientUser: requester,
          relatedTable: 'LeadsCRM',
          relatedId: leadId,
          formName: 'crm/leads',
          createdBy: userName,
        });
      } catch (e) {
        console.error('notify requester failed', e.message);
      }
    }

    return {
      success: true,
      message: approve ? 'تم اعتماد الرفض وتحويل الـ Lead إلى مرفوض' : 'تم رفض الطلب وإبقاء حالة الـ Lead',
      approved: approve,
      leadId,
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function getPendingRejectRequests() {
  const pool = await connectDB();
  const result = await pool.request()
    .input('type', sql.NVarChar(50), REJECT_REQUEST_TYPE)
    .query(`
      SELECT
        i.LeadInteractionId AS RequestId,
        i.LeadId,
        i.Summary,
        i.Notes AS Reason,
        i.CreatedBy AS RequestedBy,
        i.CreatedAt AS RequestedAt,
        i.InteractionDate,
        l.FullName,
        l.Phone,
        l.LeadStatus,
        l.CampaignName,
        l.AssignedEmployeeId,
        e.FullName AS AssignedEmployeeName
      FROM LeadInteractions i
      INNER JOIN LeadsCRM l ON l.LeadId = i.LeadId
      LEFT JOIN Employees e ON l.AssignedEmployeeId = e.EmployeeID
      WHERE i.InteractionType = @type
        AND ISNULL(i.IsCompleted, 0) = 0
      ORDER BY i.CreatedAt DESC
    `);
  return result.recordset;
}

async function getLeadPendingReject(leadId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .input('type', sql.NVarChar(50), REJECT_REQUEST_TYPE)
    .query(`
      SELECT TOP 1
        LeadInteractionId AS RequestId,
        Summary, Notes AS Reason, CreatedBy AS RequestedBy, CreatedAt AS RequestedAt
      FROM LeadInteractions
      WHERE LeadId = @leadId
        AND InteractionType = @type
        AND ISNULL(IsCompleted, 0) = 0
      ORDER BY LeadInteractionId DESC
    `);
  return result.recordset[0] || null;
}


module.exports = {
  STATUSES,
  INTERACTION_TYPES,
  REJECT_REQUEST_TYPE,
  getLeads,
  getStats,
  getFilterOptions,
  getLeadById,
  getAssignableEmployees,
  updateLead,
  getLeadInteractions,
  addLeadInteraction,
  convertLeadToClient,
  createLead,
  canConvertLead,
  normalizeStatus,
  requestLeadReject,
  decideLeadRejectRequest,
  getPendingRejectRequests,
  getLeadPendingReject,
  getUsersByRoles,
};
