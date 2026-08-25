const { sql, connectDB } = require('../../core/database');

/**
 * Unified "My Follow-ups" — mirrors Blazor TaskService.GetTasksAsync merge:
 *   1) CRM_Tasks (client / opportunity work)
 *   2) LeadInteractions open NextFollowUp (IsLeadTask)
 * Plus optional opportunity-level NextFollowUpDate (CRM dashboard style).
 *
 * Buckets: overdue | today | tomorrow | upcoming | all
 * Source:  all | lead | client | task | opportunity
 */

function toInt(v, fb = null) {
  if (v === undefined || v === null || v === '') return fb;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fb : n;
}

function bucketOf(dateVal) {
  if (!dateVal) return 'upcoming';
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return 'upcoming';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((day - today) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  return 'upcoming';
}

function daysOverdue(dateVal) {
  if (!dateVal) return 0;
  const d = new Date(dateVal);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const n = Math.round((today - day) / 86400000);
  return n > 0 ? n : 0;
}

function scopeSql(dateExpr, scope) {
  const s = (scope || 'all').toLowerCase();
  if (s === 'overdue') {
    return `CAST(${dateExpr} AS DATE) < CAST(GETDATE() AS DATE)`;
  }
  if (s === 'today') {
    return `CAST(${dateExpr} AS DATE) = CAST(GETDATE() AS DATE)`;
  }
  if (s === 'tomorrow') {
    return `CAST(${dateExpr} AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE))`;
  }
  if (s === 'upcoming') {
    return `CAST(${dateExpr} AS DATE) > DATEADD(DAY, 1, CAST(GETDATE() AS DATE))`;
  }
  // all active (include overdue..upcoming)
  return '1=1';
}

function mapRow(r) {
  const followUpDate = r.FollowUpDate;
  const bucket = r.Bucket || bucketOf(followUpDate);
  const overdueDays = bucket === 'overdue' ? daysOverdue(followUpDate) : 0;
  let severity = '';
  if (bucket === 'overdue') {
    if (overdueDays >= 7) severity = 'high';
    else if (overdueDays >= 3) severity = 'med';
    else severity = 'low';
  }
  return {
    itemType: r.ItemType,
    isLeadTask: r.ItemType === 'lead' || r.IsLeadTask === true || r.IsLeadTask === 1,
    itemId: r.ItemId,
    relatedId: r.RelatedId,
    relatedTable: r.RelatedTable,
    formName: r.FormName,
    clientName: r.ClientName,
    phone: r.Phone,
    city: r.City || null,
    title: r.Title,
    notes: r.Notes || null,
    subType: r.SubType || null,
    statusLabel: r.StatusLabel || null,
    priority: r.Priority || 'Normal',
    followUpDate,
    bucket,
    daysOverdue: overdueDays,
    severity,
    employeeId: r.EmployeeId,
    employeeName: r.EmployeeName,
    bestTimeToReach: r.BestTimeToReach || null,
    campaignName: r.CampaignName || null,
    platform: r.Platform || null,
    extra: r.Extra || null,
    createdAt: r.CreatedAt || null,
  };
}

async function getFollowUps(filters = {}) {
  const pool = await connectDB();
  const scope = (filters.scope || 'all').toString().toLowerCase();
  const source = (filters.source || 'all').toString().toLowerCase();
  const employeeId = toInt(filters.employeeId);
  const limit = Math.min(400, Math.max(1, toInt(filters.limit, 150)));
  const search = filters.search ? String(filters.search).trim() : '';

  const parts = [];

  // ═══════════════════════════════════════════════════════
  // A) Lead follow-ups  (Blazor TaskService lead merge)
  // ═══════════════════════════════════════════════════════
  if (source === 'all' || source === 'lead' || source === 'leads') {
    const req = pool.request();
    let where = `
      WHERE i.NextFollowUpDate IS NOT NULL
        AND ISNULL(i.IsCompleted, 0) = 0
        AND ISNULL(l.IsConverted, 0) = 0
        AND ISNULL(l.LeadStatus, N'') NOT IN (N'محول', N'مرفوض')
        AND ${scopeSql('i.NextFollowUpDate', scope)}
    `;
    if (employeeId) {
      req.input('empLead', sql.Int, employeeId);
      where += ` AND (i.EmployeeId = @empLead OR l.AssignedEmployeeId = @empLead)`;
    }
    if (search) {
      req.input('qLead', sql.NVarChar(120), `%${search}%`);
      where += ` AND (
        l.FullName LIKE @qLead OR l.Phone LIKE @qLead OR l.Phone2 LIKE @qLead
        OR i.Summary LIKE @qLead OR l.CampaignName LIKE @qLead OR l.City LIKE @qLead
      )`;
    }
    try {
      const r = await req.query(`
        SELECT TOP (${limit})
          N'lead' AS ItemType,
          CAST(1 AS bit) AS IsLeadTask,
          i.LeadInteractionId AS ItemId,
          l.LeadId AS RelatedId,
          N'LeadsCRM' AS RelatedTable,
          N'crm/leads' AS FormName,
          l.FullName AS ClientName,
          l.Phone AS Phone,
          l.City AS City,
          ISNULL(i.Summary, N'متابعة Lead') AS Title,
          i.Notes AS Notes,
          i.InteractionType AS SubType,
          l.LeadStatus AS StatusLabel,
          N'Normal' AS Priority,
          i.NextFollowUpDate AS FollowUpDate,
          COALESCE(i.EmployeeId, l.AssignedEmployeeId) AS EmployeeId,
          COALESCE(ei.FullName, ea.FullName) AS EmployeeName,
          l.BestTimeToReach AS BestTimeToReach,
          l.CampaignName AS CampaignName,
          l.Platform AS Platform,
          l.ProjectType AS Extra,
          i.CreatedAt AS CreatedAt
        FROM LeadInteractions i
        INNER JOIN LeadsCRM l ON l.LeadId = i.LeadId
        LEFT JOIN Employees ei ON i.EmployeeId = ei.EmployeeID
        LEFT JOIN Employees ea ON l.AssignedEmployeeId = ea.EmployeeID
        ${where}
        ORDER BY i.NextFollowUpDate ASC
      `);
      parts.push(...(r.recordset || []));
    } catch (e) {
      console.error('followups/leads:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════
  // B) CRM Tasks (client work) — Blazor VwCrmTasks style
  // ═══════════════════════════════════════════════════════
  if (
    source === 'all' ||
    source === 'client' ||
    source === 'task' ||
    source === 'tasks'
  ) {
    const req = pool.request();
    let where = `
      WHERE t.IsActive = 1
        AND t.Status NOT IN (N'Completed', N'Cancelled', N'completed', N'cancelled')
        AND t.DueDate IS NOT NULL
        AND ${scopeSql('t.DueDate', scope)}
    `;
    if (employeeId) {
      req.input('empTask', sql.Int, employeeId);
      where += ` AND (t.AssignedTo = @empTask OR o.EmployeeID = @empTask)`;
    }
    if (search) {
      req.input('qTask', sql.NVarChar(120), `%${search}%`);
      where += ` AND (
        p.PartyName LIKE @qTask OR p.Phone LIKE @qTask
        OR t.TaskDescription LIKE @qTask
      )`;
    }
    try {
      const r = await req.query(`
        SELECT TOP (${limit})
          N'task' AS ItemType,
          CAST(0 AS bit) AS IsLeadTask,
          t.TaskID AS ItemId,
          t.OpportunityID AS RelatedId,
          N'CRM_Tasks' AS RelatedTable,
          N'frmDailyTasks' AS FormName,
          p.PartyName AS ClientName,
          p.Phone AS Phone,
          NULL AS City,
          ISNULL(t.TaskDescription, N'مهمة') AS Title,
          t.TaskDescription AS Notes,
          ISNULL(tt.TaskTypeNameAr, tt.TaskTypeName) AS SubType,
          t.Status AS StatusLabel,
          t.Priority AS Priority,
          t.DueDate AS FollowUpDate,
          t.AssignedTo AS EmployeeId,
          e.FullName AS EmployeeName,
          NULL AS BestTimeToReach,
          NULL AS CampaignName,
          NULL AS Platform,
          empOwner.FullName AS Extra,
          t.CreatedAt AS CreatedAt
        FROM CRM_Tasks t
        LEFT JOIN Parties p ON t.PartyID = p.PartyID
        LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
        LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
        LEFT JOIN SalesOpportunities o ON t.OpportunityID = o.OpportunityID
        LEFT JOIN Employees empOwner ON o.EmployeeID = empOwner.EmployeeID
        ${where}
        ORDER BY t.DueDate ASC, t.Priority DESC
      `);
      parts.push(...(r.recordset || []));
    } catch (e) {
      console.error('followups/tasks:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════
  // C) Opportunity NextFollowUp — REMOVED to match Blazor TaskService
  // السبب: كان يسبب تكرار العميل مرتين في نفس التاريخ (مرة Task ومرة Opportunity)
  // البلازور المرجع الأساسي لا يدرج NextFollowUpDate كـ item منفصل في GetTasksAsync
  // فقط: LeadInteractions + CRM_Tasks (TaskScope != General, != Lead)
  // لو احتجنا مستقبلاً، يمكن إرجاعه مع شرط NOT EXISTS task لنفس الفرصة بنفس التاريخ
  // ═══════════════════════════════════════════════════════

  // Map + sort + DEDUP (منع تكرار نفس العميل في نفس اليوم)
  // السبب الثاني للتكرار: نفس Lead أو نفس Opportunity له أكثر من متابعة بنفس التاريخ
  let items = parts.map(mapRow);

  // ── DEDUP FIX: نفس العميل ظاهر مرتين في نفس التاريخ ──
  // المفتاح: RelatedId + تاريخ اليوم فقط (بدون وقت) + نوع المصدر
  // الأولوية: task > lead > opportunity
  const seen = new Map();
  const deduped = [];
  for (const it of items) {
    if (!it.followUpDate || !it.relatedId) {
      deduped.push(it);
      continue;
    }
    const d = new Date(it.followUpDate);
    const dateKey = isNaN(d.getTime()) ? String(it.followUpDate) : d.toISOString().split('T')[0];
    const key = `${it.relatedId}-${dateKey}`;
    if (!seen.has(key)) {
      seen.set(key, it);
      deduped.push(it);
    } else {
      const existing = seen.get(key);
      // لو الموجود opportunity والجديد task → استبدل (Task أهم)
      if (existing.itemType === 'opportunity' && it.itemType === 'task') {
        const idx = deduped.indexOf(existing);
        if (idx !== -1) deduped[idx] = it;
        seen.set(key, it);
      } else if (existing.itemType === 'opportunity' && it.itemType === 'lead') {
        const idx = deduped.indexOf(existing);
        if (idx !== -1) deduped[idx] = it;
        seen.set(key, it);
      }
      // لو نفس النوع و نفس التاريخ، نحتفظ بالأحدث CreatedAt
      else if (existing.itemType === it.itemType) {
        const existingCreated = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
        const newCreated = it.createdAt ? new Date(it.createdAt).getTime() : 0;
        if (newCreated > existingCreated) {
          const idx = deduped.indexOf(existing);
          if (idx !== -1) deduped[idx] = it;
          seen.set(key, it);
        }
      }
    }
  }
  items = deduped;

  items.sort((a, b) => {
    const order = { overdue: 0, today: 1, tomorrow: 2, upcoming: 3 };
    const ba = order[a.bucket] ?? 9;
    const bb = order[b.bucket] ?? 9;
    if (ba !== bb) return ba - bb;
    if (a.bucket === 'overdue' && b.bucket === 'overdue') {
      return (b.daysOverdue || 0) - (a.daysOverdue || 0);
    }
    const da = a.followUpDate ? new Date(a.followUpDate).getTime() : 0;
    const db = b.followUpDate ? new Date(b.followUpDate).getTime() : 0;
    return da - db;
  });

  items = items.slice(0, limit);

  const summary = buildSummary(items);
  return { items, summary, scope, source };
}

function buildSummary(items) {
  return {
    total: items.length,
    overdue: items.filter((x) => x.bucket === 'overdue').length,
    today: items.filter((x) => x.bucket === 'today').length,
    tomorrow: items.filter((x) => x.bucket === 'tomorrow').length,
    upcoming: items.filter((x) => x.bucket === 'upcoming').length,
    leads: items.filter((x) => x.isLeadTask || x.itemType === 'lead').length,
    clients: items.filter((x) => !x.isLeadTask && x.itemType !== 'lead').length,
    opportunities: items.filter((x) => x.itemType === 'opportunity').length,
    tasks: items.filter((x) => x.itemType === 'task').length,
  };
}

async function getFollowUpSummary(filters = {}) {
  // Full scan for KPIs (all buckets)
  const data = await getFollowUps({ ...filters, scope: 'all', limit: 400 });
  return data.summary;
}

async function completeLeadFollowUp(interactionId) {
  const pool = await connectDB();
  const result = await pool
    .request()
    .input('id', sql.Int, interactionId)
    .query(`
      UPDATE LeadInteractions
      SET IsCompleted = 1,
          CompletedDate = GETDATE()
      WHERE LeadInteractionId = @id
        AND ISNULL(IsCompleted, 0) = 0;

      SELECT @@ROWCOUNT AS affected;
    `);
  const affected = result.recordset?.[0]?.affected ?? 0;
  return {
    success: affected > 0,
    message: affected > 0 ? 'تم إنهاء متابعة الـ Lead' : 'المتابعة غير موجودة أو منتهية',
  };
}

module.exports = {
  getFollowUps,
  getFollowUpSummary,
  completeLeadFollowUp,
};
