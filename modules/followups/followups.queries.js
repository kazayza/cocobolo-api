const { sql, connectDB } = require('../../core/database');

/**
 * Unified follow-ups: Leads + CRM Opportunities + CRM Tasks
 * Buckets: overdue | today | upcoming | all
 * Aligned with Blazor CrmDashboardService follow-up ideas.
 */

function toInt(v, fb = null) {
  if (v === undefined || v === null || v === '') return fb;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fb : n;
}

function buildScopeCase(dateExpr) {
  // dateExpr e.g. i.NextFollowUpDate
  return `
    CASE
      WHEN CAST(${dateExpr} AS DATE) < CAST(GETDATE() AS DATE) THEN N'overdue'
      WHEN CAST(${dateExpr} AS DATE) = CAST(GETDATE() AS DATE) THEN N'today'
      ELSE N'upcoming'
    END
  `;
}

function scopeWhere(dateExpr, scope) {
  if (!scope || scope === 'all') return '1=1';
  if (scope === 'overdue') {
    return `CAST(${dateExpr} AS DATE) < CAST(GETDATE() AS DATE)`;
  }
  if (scope === 'today') {
    return `CAST(${dateExpr} AS DATE) = CAST(GETDATE() AS DATE)`;
  }
  if (scope === 'upcoming') {
    return `CAST(${dateExpr} AS DATE) > CAST(GETDATE() AS DATE)`;
  }
  return '1=1';
}

/**
 * GET unified list
 * filters: scope, employeeId, source (lead|opportunity|task|all), search, limit
 */
async function getFollowUps(filters = {}) {
  const pool = await connectDB();
  const scope = (filters.scope || 'all').toString().toLowerCase();
  const source = (filters.source || 'all').toString().toLowerCase();
  const employeeId = toInt(filters.employeeId);
  const limit = Math.min(300, Math.max(1, toInt(filters.limit, 100)));
  const search = filters.search ? String(filters.search).trim() : '';

  const parts = [];

  // ── 1) Lead follow-ups (open LeadInteractions with NextFollowUpDate)
  if (source === 'all' || source === 'lead' || source === 'leads') {
    const req = pool.request();
    let where = `
      WHERE i.NextFollowUpDate IS NOT NULL
        AND ISNULL(i.IsCompleted, 0) = 0
        AND ISNULL(l.IsConverted, 0) = 0
        AND ISNULL(l.LeadStatus, N'') NOT IN (N'محول', N'مرفوض')
        AND ${scopeWhere('i.NextFollowUpDate', scope)}
    `;
    if (employeeId) {
      req.input('empLead', sql.Int, employeeId);
      where += ` AND (
        i.EmployeeId = @empLead
        OR l.AssignedEmployeeId = @empLead
      )`;
    }
    if (search) {
      req.input('searchLead', sql.NVarChar(100), `%${search}%`);
      where += ` AND (
        l.FullName LIKE @searchLead OR l.Phone LIKE @searchLead
        OR i.Summary LIKE @searchLead OR i.Notes LIKE @searchLead
      )`;
    }

    const q = `
      SELECT TOP (${limit})
        N'lead' AS ItemType,
        i.LeadInteractionId AS ItemId,
        l.LeadId AS RelatedId,
        N'LeadsCRM' AS RelatedTable,
        N'crm/leads' AS FormName,
        l.FullName AS ClientName,
        l.Phone AS Phone,
        l.City AS City,
        l.LeadStatus AS StatusLabel,
        i.InteractionType AS SubType,
        i.Summary AS Title,
        i.Notes AS Notes,
        i.NextFollowUpDate AS FollowUpDate,
        ${buildScopeCase('i.NextFollowUpDate')} AS Bucket,
        COALESCE(i.EmployeeId, l.AssignedEmployeeId) AS EmployeeId,
        COALESCE(ei.FullName, ea.FullName) AS EmployeeName,
        l.BestTimeToReach AS BestTimeToReach,
        l.CampaignName AS Extra,
        i.CreatedAt AS CreatedAt
      FROM LeadInteractions i
      INNER JOIN LeadsCRM l ON l.LeadId = i.LeadId
      LEFT JOIN Employees ei ON i.EmployeeId = ei.EmployeeID
      LEFT JOIN Employees ea ON l.AssignedEmployeeId = ea.EmployeeID
      ${where}
      ORDER BY i.NextFollowUpDate ASC
    `;
    try {
      const r = await req.query(q);
      parts.push(...(r.recordset || []));
    } catch (e) {
      console.error('followups leads query:', e.message);
    }
  }

  // ── 2) Opportunity follow-ups
  if (source === 'all' || source === 'opportunity' || source === 'crm') {
    const req = pool.request();
    let where = `
      WHERE o.IsActive = 1
        AND o.NextFollowUpDate IS NOT NULL
        AND o.StageID NOT IN (3, 4, 5)
        AND ${scopeWhere('o.NextFollowUpDate', scope)}
    `;
    if (employeeId) {
      req.input('empOpp', sql.Int, employeeId);
      where += ` AND o.EmployeeID = @empOpp`;
    }
    if (search) {
      req.input('searchOpp', sql.NVarChar(100), `%${search}%`);
      where += ` AND (
        p.PartyName LIKE @searchOpp OR p.Phone LIKE @searchOpp
        OR o.InterestedProduct LIKE @searchOpp OR o.Notes LIKE @searchOpp
      )`;
    }

    const q = `
      SELECT TOP (${limit})
        N'opportunity' AS ItemType,
        o.OpportunityID AS ItemId,
        o.OpportunityID AS RelatedId,
        N'SalesOpportunities' AS RelatedTable,
        N'crm/opportunities' AS FormName,
        p.PartyName AS ClientName,
        p.Phone AS Phone,
        NULL AS City,
        ISNULL(ss.StageNameAr, ss.StageName) AS StatusLabel,
        N'متابعة فرصة' AS SubType,
        CONCAT(N'متابعة: ', ISNULL(p.PartyName, N'')) AS Title,
        o.Notes AS Notes,
        o.NextFollowUpDate AS FollowUpDate,
        ${buildScopeCase('o.NextFollowUpDate')} AS Bucket,
        o.EmployeeID AS EmployeeId,
        e.FullName AS EmployeeName,
        NULL AS BestTimeToReach,
        o.InterestedProduct AS Extra,
        o.CreatedAt AS CreatedAt
      FROM SalesOpportunities o
      LEFT JOIN Parties p ON o.PartyID = p.PartyID
      LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
      LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
      ${where}
      ORDER BY o.NextFollowUpDate ASC
    `;
    try {
      const r = await req.query(q);
      parts.push(...(r.recordset || []));
    } catch (e) {
      console.error('followups opportunities query:', e.message);
    }
  }

  // ── 3) CRM Tasks due
  if (source === 'all' || source === 'task' || source === 'tasks') {
    const req = pool.request();
    let where = `
      WHERE t.IsActive = 1
        AND t.Status NOT IN (N'Completed', N'Cancelled', N'completed', N'cancelled')
        AND t.DueDate IS NOT NULL
        AND ${scopeWhere('t.DueDate', scope)}
    `;
    if (employeeId) {
      req.input('empTask', sql.Int, employeeId);
      where += ` AND (t.AssignedTo = @empTask OR o.EmployeeID = @empTask)`;
    }
    if (search) {
      req.input('searchTask', sql.NVarChar(100), `%${search}%`);
      where += ` AND (
        p.PartyName LIKE @searchTask OR p.Phone LIKE @searchTask
        OR t.TaskDescription LIKE @searchTask
      )`;
    }

    const q = `
      SELECT TOP (${limit})
        N'task' AS ItemType,
        t.TaskID AS ItemId,
        t.OpportunityID AS RelatedId,
        N'CRM_Tasks' AS RelatedTable,
        N'frmDailyTasks' AS FormName,
        p.PartyName AS ClientName,
        p.Phone AS Phone,
        NULL AS City,
        t.Status AS StatusLabel,
        ISNULL(tt.TaskTypeNameAr, tt.TaskTypeName) AS SubType,
        ISNULL(t.TaskDescription, N'مهمة') AS Title,
        t.TaskDescription AS Notes,
        t.DueDate AS FollowUpDate,
        ${buildScopeCase('t.DueDate')} AS Bucket,
        t.AssignedTo AS EmployeeId,
        e.FullName AS EmployeeName,
        NULL AS BestTimeToReach,
        empOwner.FullName AS Extra,
        t.CreatedAt AS CreatedAt
      FROM CRM_Tasks t
      LEFT JOIN Parties p ON t.PartyID = p.PartyID
      LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
      LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
      LEFT JOIN SalesOpportunities o ON t.OpportunityID = o.OpportunityID
      LEFT JOIN Employees empOwner ON o.EmployeeID = empOwner.EmployeeID
      ${where}
      ORDER BY t.DueDate ASC
    `;
    try {
      const r = await req.query(q);
      parts.push(...(r.recordset || []));
    } catch (e) {
      console.error('followups tasks query:', e.message);
    }
  }

  // Sort merged
  parts.sort((a, b) => {
    const da = a.FollowUpDate ? new Date(a.FollowUpDate).getTime() : 0;
    const db = b.FollowUpDate ? new Date(b.FollowUpDate).getTime() : 0;
    return da - db;
  });

  const items = parts.slice(0, limit);

  const summary = {
    total: items.length,
    overdue: items.filter((x) => x.Bucket === 'overdue').length,
    today: items.filter((x) => x.Bucket === 'today').length,
    upcoming: items.filter((x) => x.Bucket === 'upcoming').length,
    leads: items.filter((x) => x.ItemType === 'lead').length,
    opportunities: items.filter((x) => x.ItemType === 'opportunity').length,
    tasks: items.filter((x) => x.ItemType === 'task').length,
  };

  return { items, summary, scope, source };
}

async function getFollowUpSummary(filters = {}) {
  const data = await getFollowUps({ ...filters, scope: 'all', limit: 300 });
  return data.summary;
}

/**
 * Complete a lead follow-up interaction (mark IsCompleted)
 */
async function completeLeadFollowUp(interactionId, userName = 'System') {
  const pool = await connectDB();
  await pool
    .request()
    .input('id', sql.Int, interactionId)
    .query(`
      UPDATE LeadInteractions
      SET IsCompleted = 1,
          CompletedDate = GETDATE()
      WHERE LeadInteractionId = @id
    `);
  return { success: true, message: 'تم إنهاء متابعة الـ Lead' };
}

module.exports = {
  getFollowUps,
  getFollowUpSummary,
  completeLeadFollowUp,
};
