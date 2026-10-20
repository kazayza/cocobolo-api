const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════
// Constants - مطابق لبلازور CrmStages + RecoveryService
// ═══════════════════════════════════════════════════════════
const LOST_STAGE_ID = 4;
const NOT_INTERESTED_STAGE_ID = 5;
const CS_DEPARTMENT = 'خدمة العملاء';
const TASK_PENDING = 'Pending';
const TASK_SCOPE_RECOVERY = 'Recovery';

// ═══════════════════════════════════════════════════════════
// Helper: resolve employeeId by username
// ═══════════════════════════════════════════════════════════
async function getEmployeeIdByUsername(username) {
  if (!username) return 0;
  const pool = await connectDB();
  const res = await pool.request()
    .input('username', sql.NVarChar(100), username)
    .query(`SELECT TOP 1 employeeID FROM Users WHERE Username = @username AND employeeID IS NOT NULL`);
  return res.recordset[0]?.employeeID || 0;
}

// ═══════════════════════════════════════════════════════════
// 📊 الإحصائيات - مطابق RecoveryService.GetStatsAsync
// ═══════════════════════════════════════════════════════════
async function getStats() {
  const pool = await connectDB();

  // Lost opportunities count & value (not rejected)
  const lostRes = await pool.request().query(`
    SELECT OpportunityID, ExpectedValue
    FROM SalesOpportunities
    WHERE (StageID = ${LOST_STAGE_ID} OR StageID = ${NOT_INTERESTED_STAGE_ID})
      AND IsActive = 1
      AND (IsRecoveryRejected IS NULL OR IsRecoveryRejected = 0)
  `);
  const lost = lostRes.recordset;
  const lostIds = lost.map(o => o.OpportunityID);

  let assignedIds = new Set();
  if (lostIds.length > 0) {
    const idsStr = lostIds.join(',');
    const assignedRes = await pool.request().query(`
      SELECT DISTINCT OpportunityID
      FROM CRM_Tasks
      WHERE OpportunityID IN (${idsStr})
        AND TaskScope = N'${TASK_SCOPE_RECOVERY}'
        AND Status = N'${TASK_PENDING}'
        AND IsActive = 1
    `);
    assignedIds = new Set(assignedRes.recordset.map(r => r.OpportunityID));
  }

  // Revived this month
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const revivedRes = await pool.request()
    .input('monthStart', sql.DateTime, monthStart)
    .query(`
      SELECT COUNT(DISTINCT OpportunityID) as cnt
      FROM CustomerInteractions
      WHERE InteractionDate >= @monthStart
        AND StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
        AND StageAfterID IS NOT NULL
        AND StageAfterID NOT IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
    `);
  const revivedThisMonth = revivedRes.recordset[0]?.cnt || 0;

  // Uncontacted count
  let uncontacted = 0;
  if (lostIds.length > 0) {
    const idsStr = lostIds.join(',');
    const contactedRes = await pool.request().query(`
      SELECT DISTINCT OpportunityID
      FROM CustomerInteractions
      WHERE OpportunityID IN (${idsStr})
        AND StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
        AND StageAfterID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
        AND Summary NOT LIKE N'نقل تلقائي%'
    `);
    const contactedSet = new Set(contactedRes.recordset.map(r => r.OpportunityID));
    uncontacted = lost.filter(o => assignedIds.has(o.OpportunityID) && !contactedSet.has(o.OpportunityID)).length;
  }

  const lostValue = lost.reduce((sum, o) => sum + (o.ExpectedValue || 0), 0);
  const unassigned = lost.filter(o => !assignedIds.has(o.OpportunityID)).length;

  return {
    LostCount: lost.length,
    LostValue: lostValue,
    UnassignedCount: unassigned,
    RevivedThisMonth: revivedThisMonth,
    UncontactedCount: uncontacted,
  };
}

// ═══════════════════════════════════════════════════════════
// 📋 طابور الاسترداد مع فلاتر وترقيم - مطابق GetQueueAsync
// ═══════════════════════════════════════════════════════════
async function getQueue(filters = {}, pageIndex = 1, pageSize = 12, username = null) {
  const pool = await connectDB();
  if (pageIndex < 1) pageIndex = 1;
  if (pageSize < 1) pageSize = 12;
  if (pageSize > 100) pageSize = 100;

  const {
    SearchText,
    Kind = 'all',
    CandidateOnly = false,
    MineOnly = false,
    LateOnly = false,
    UnassignedOnly = false,
    UncontactedOnly = false,
    SortBy = 'value',
    MinValue,
    ClosedFrom,
    ClosedTo,
  } = filters;

  let whereClauses = [
    `(o.StageID = ${LOST_STAGE_ID} OR o.StageID = ${NOT_INTERESTED_STAGE_ID})`,
    `o.IsActive = 1`,
    `(o.IsRecoveryRejected IS NULL OR o.IsRecoveryRejected = 0)`,
  ];

  const request = pool.request();

  // Search by client name or phone
  if (SearchText && String(SearchText).trim() !== '') {
    const search = `%${String(SearchText).trim()}%`;
    request.input('search', sql.NVarChar(200), search);
    whereClauses.push(`(p.PartyName LIKE @search OR p.Phone LIKE @search OR p.Phone2 LIKE @search)`);
  }

  if (Kind === 'lost') {
    whereClauses.push(`o.StageID = ${LOST_STAGE_ID}`);
  } else if (Kind === 'notinterested') {
    whereClauses.push(`o.StageID = ${NOT_INTERESTED_STAGE_ID}`);
  }

  if (MinValue) {
    request.input('minValue', sql.Decimal(18, 2), MinValue);
    whereClauses.push(`o.ExpectedValue >= @minValue`);
  }

  if (CandidateOnly) {
    whereClauses.push(`o.IsRecoveryCandidate = 1`);
  }

  if (LateOnly) {
    whereClauses.push(`o.NextFollowUpDate IS NOT NULL AND CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE)`);
  }

  if (ClosedFrom) {
    request.input('closedFrom', sql.Date, new Date(ClosedFrom));
    whereClauses.push(`o.ClosedAt IS NOT NULL AND CAST(o.ClosedAt AS DATE) >= @closedFrom`);
  }
  if (ClosedTo) {
    request.input('closedTo', sql.Date, new Date(ClosedTo));
    whereClauses.push(`o.ClosedAt IS NOT NULL AND CAST(o.ClosedAt AS DATE) <= @closedTo`);
  }

  // For UnassignedOnly / MineOnly / UncontactedOnly we need subqueries
  if (UnassignedOnly) {
    whereClauses.push(`NOT EXISTS (SELECT 1 FROM CRM_Tasks t WHERE t.OpportunityID = o.OpportunityID AND t.TaskScope = N'Recovery' AND t.Status = N'Pending' AND t.IsActive = 1)`);
  }

  if (MineOnly && username) {
    const empId = await getEmployeeIdByUsername(username);
    if (empId === 0) {
      return { Items: [], TotalCount: 0, PageIndex: pageIndex, PageSize: pageSize, HasMore: false };
    }
    request.input('mineEmpId', sql.Int, empId);
    whereClauses.push(`EXISTS (SELECT 1 FROM CRM_Tasks t WHERE t.OpportunityID = o.OpportunityID AND t.TaskScope = N'Recovery' AND t.Status = N'Pending' AND t.IsActive = 1 AND t.AssignedTo = @mineEmpId)`);
  }

  if (UncontactedOnly) {
    whereClauses.push(`EXISTS (SELECT 1 FROM CRM_Tasks t WHERE t.OpportunityID = o.OpportunityID AND t.TaskScope = N'Recovery' AND t.Status = N'Pending' AND t.IsActive = 1)`);
    whereClauses.push(`NOT EXISTS (SELECT 1 FROM CustomerInteractions ci WHERE ci.OpportunityID = o.OpportunityID AND ci.StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.StageAfterID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.Summary NOT LIKE N'نقل تلقائي%')`);
  }

  const whereSQL = whereClauses.join(' AND ');

  // Count total
  const countQuery = `
    SELECT COUNT(*) as total
    FROM SalesOpportunities o
    LEFT JOIN Parties p ON o.PartyID = p.PartyID
    WHERE ${whereSQL}
  `;
  const countRes = await request.query(countQuery);
  const total = countRes.recordset[0]?.total || 0;

  // Sorting
  let orderSQL = '';
  switch (SortBy) {
    case 'recent':
      orderSQL = 'ORDER BY o.ClosedAt DESC, o.OpportunityID DESC';
      break;
    case 'days':
      orderSQL = 'ORDER BY o.ClosedAt ASC, o.OpportunityID DESC';
      break;
    case 'followup':
      orderSQL = 'ORDER BY CASE WHEN o.NextFollowUpDate IS NULL THEN 1 ELSE 0 END, o.NextFollowUpDate ASC, o.OpportunityID DESC';
      break;
    case 'value':
    default:
      orderSQL = 'ORDER BY o.ExpectedValue DESC, o.OpportunityID DESC';
      break;
  }

  const offset = (pageIndex - 1) * pageSize;
  request.input('offset', sql.Int, offset);
  request.input('pageSize', sql.Int, pageSize);

  const dataQuery = `
    SELECT
      o.OpportunityID, o.PartyID, o.StageID, o.ExpectedValue, o.InterestedProduct,
      o.ClosedAt, o.LostReasonID, o.LostNotes, o.IsRecoveryCandidate, o.RecoveryNotes,
      o.LastContactDate, o.NextFollowUpDate,
      p.PartyName AS ClientName, p.Phone, p.Phone2,
      ss.StageNameAr, ss.StageName, ss.StageColor,
      e.FullName AS PreviousEmployeeName,
      lr.ReasonNameAr AS LostReasonNameAr, lr.ReasonName AS LostReasonName,
      -- Recovery task
      (SELECT TOP 1 t.AssignedTo FROM CRM_Tasks t WHERE t.OpportunityID = o.OpportunityID AND t.TaskScope = N'Recovery' AND t.Status = N'Pending' AND t.IsActive = 1 ORDER BY t.TaskID DESC) AS RecoveryEmployeeId,
      (SELECT TOP 1 emp.FullName FROM CRM_Tasks t LEFT JOIN Employees emp ON t.AssignedTo = emp.EmployeeID WHERE t.OpportunityID = o.OpportunityID AND t.TaskScope = N'Recovery' AND t.Status = N'Pending' AND t.IsActive = 1 ORDER BY t.TaskID DESC) AS RecoveryEmployeeName,
      DATEDIFF(DAY, o.ClosedAt, GETDATE()) AS DaysSinceClosed,
      CASE WHEN o.NextFollowUpDate IS NOT NULL AND CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS IsFollowUpOverdue,
      -- Last CS contact after loss
      (SELECT TOP 1 ci.Summary FROM CustomerInteractions ci WHERE ci.OpportunityID = o.OpportunityID AND ci.StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.StageAfterID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.Summary NOT LIKE N'نقل تلقائي%' ORDER BY ci.InteractionDate DESC) AS LastCsSummary,
      (SELECT TOP 1 ci.InteractionDate FROM CustomerInteractions ci WHERE ci.OpportunityID = o.OpportunityID AND ci.StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.StageAfterID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.Summary NOT LIKE N'نقل تلقائي%' ORDER BY ci.InteractionDate DESC) AS LastCsDate,
      (SELECT TOP 1 ci.CreatedBy FROM CustomerInteractions ci WHERE ci.OpportunityID = o.OpportunityID AND ci.StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.StageAfterID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND ci.Summary NOT LIKE N'نقل تلقائي%' ORDER BY ci.InteractionDate DESC) AS LastCsBy
    FROM SalesOpportunities o
    LEFT JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    LEFT JOIN LostReasons lr ON o.LostReasonID = lr.LostReasonID
    WHERE ${whereSQL}
    ${orderSQL}
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `;

  const dataRes = await request.query(dataQuery);

  const items = dataRes.recordset.map(row => ({
    OpportunityId: row.OpportunityID,
    PartyId: row.PartyID,
    ClientName: row.ClientName || '—',
    Phone: row.Phone || row.Phone2 || '',
    StageId: row.StageID,
    StageNameAr: row.StageNameAr || row.StageName || 'خسارة',
    StageColor: row.StageColor || '#ef4444',
    IsNotInterested: row.StageID === NOT_INTERESTED_STAGE_ID,
    ExpectedValue: row.ExpectedValue,
    InterestedProduct: row.InterestedProduct,
    ClosedAt: row.ClosedAt,
    DaysSinceClosed: row.DaysSinceClosed || 0,
    LostReasonNameAr: row.LostReasonNameAr || row.LostReasonName,
    LostNotes: row.LostNotes,
    IsRecoveryCandidate: row.IsRecoveryCandidate,
    RecoveryNotes: row.RecoveryNotes,
    PreviousEmployeeName: row.PreviousEmployeeName,
    RecoveryEmployeeId: row.RecoveryEmployeeId,
    RecoveryEmployeeName: row.RecoveryEmployeeName,
    LastContactDate: row.LastContactDate,
    NextFollowUpDate: row.NextFollowUpDate,
    LastCsDate: row.LastCsDate,
    LastCsBy: row.LastCsBy,
    LastCsSummary: row.LastCsSummary,
    IsFollowUpOverdue: row.IsFollowUpOverdue === 1,
  }));

  return {
    Items: items,
    TotalCount: total,
    PageIndex: pageIndex,
    PageSize: pageSize,
    HasMore: pageIndex * pageSize < total,
  };
}

// ═══════════════════════════════════════════════════════════
// 🔢 Late count
// ═══════════════════════════════════════════════════════════
async function getLateCount() {
  const pool = await connectDB();
  const res = await pool.request().query(`
    SELECT COUNT(*) as cnt
    FROM SalesOpportunities
    WHERE (StageID = ${LOST_STAGE_ID} OR StageID = ${NOT_INTERESTED_STAGE_ID})
      AND IsActive = 1
      AND (IsRecoveryRejected IS NULL OR IsRecoveryRejected = 0)
      AND NextFollowUpDate IS NOT NULL
      AND CAST(NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE)
  `);
  return res.recordset[0]?.cnt || 0;
}

// ═══════════════════════════════════════════════════════════
// 🆕 Unprocessed new losses count
// ═══════════════════════════════════════════════════════════
async function getUnprocessedNewLossesCount() {
  const pool = await connectDB();
  const res = await pool.request().query(`
    SELECT COUNT(*) as cnt
    FROM SalesOpportunities o
    WHERE (o.StageID = ${LOST_STAGE_ID} OR o.StageID = ${NOT_INTERESTED_STAGE_ID})
      AND o.IsActive = 1
      AND (o.IsRecoveryRejected IS NULL OR o.IsRecoveryRejected = 0)
      AND NOT EXISTS (
        SELECT 1 FROM CRM_Tasks t
        WHERE t.OpportunityID = o.OpportunityID
          AND t.TaskScope = N'Recovery'
          AND t.Status = N'Pending'
          AND t.IsActive = 1
      )
  `);
  return res.recordset[0]?.cnt || 0;
}

// ═══════════════════════════════════════════════════════════
// 🔁 Sync new losses - auto assign to least loaded CS employee
// ═══════════════════════════════════════════════════════════
async function syncNewLosses() {
  const pool = await connectDB();

  // Get lost opportunities without open recovery task and not rejected
  const lostRes = await pool.request().query(`
    SELECT OpportunityID, PartyID, StageID, ExpectedValue, LostReasonID
    FROM SalesOpportunities
    WHERE (StageID = ${LOST_STAGE_ID} OR StageID = ${NOT_INTERESTED_STAGE_ID})
      AND IsActive = 1
      AND (IsRecoveryRejected IS NULL OR IsRecoveryRejected = 0)
      AND NOT EXISTS (
        SELECT 1 FROM CRM_Tasks t
        WHERE t.OpportunityID = SalesOpportunities.OpportunityID
          AND t.TaskScope = N'Recovery'
          AND t.Status = N'Pending'
          AND t.IsActive = 1
      )
  `);
  const need = lostRes.recordset;
  if (need.length === 0) return { created: 0 };

  // Get CS employees with active user accounts
  const empsRes = await pool.request().query(`
    SELECT e.EmployeeID, e.FullName
    FROM Employees e
    WHERE e.Department = N'${CS_DEPARTMENT}'
      AND (e.Status = N'نشط' OR e.Status = N'Active')
  `);
  const employees = empsRes.recordset;
  if (employees.length === 0) return { created: 0 };

  const empIds = employees.map(e => e.EmployeeID);
  const empIdsStr = empIds.join(',');

  const usersRes = await pool.request().query(`
    SELECT employeeID, Username
    FROM Users
    WHERE employeeID IN (${empIdsStr}) AND ISNULL(IsActive,1)=1 AND Username IS NOT NULL
  `);
  const users = usersRes.recordset;
  if (users.length === 0) return { created: 0 };

  const userByEmp = {};
  users.forEach(u => { userByEmp[u.employeeID] = u.Username; });
  const csEmps = employees.filter(e => userByEmp[e.EmployeeID]);
  if (csEmps.length === 0) return { created: 0 };

  // Current loads
  const loadsRes = await pool.request().query(`
    SELECT AssignedTo, COUNT(*) as Cnt
    FROM CRM_Tasks
    WHERE Status = N'Pending' AND IsActive = 1 AND AssignedTo IN (${empIdsStr})
    GROUP BY AssignedTo
  `);
  const loads = {};
  loadsRes.recordset.forEach(r => { loads[r.AssignedTo] = r.Cnt; });

  // Get party names and stage names and reason names in batch
  const oppIds = need.map(o => o.OpportunityID);
  const partyIds = [...new Set(need.map(o => o.PartyID))];
  const partyIdsStr = partyIds.join(',');

  const partyRes = await pool.request().query(`
    SELECT PartyID, PartyName FROM Parties WHERE PartyID IN (${partyIdsStr})
  `);
  const partyMap = {};
  partyRes.recordset.forEach(p => { partyMap[p.PartyID] = p.PartyName; });

  const stageIds = [...new Set(need.map(o => o.StageID))];
  const stageIdsStr = stageIds.join(',');
  const stageRes = await pool.request().query(`
    SELECT StageID, StageNameAr, StageName FROM SalesStages WHERE StageID IN (${stageIdsStr})
  `);
  const stageMap = {};
  stageRes.recordset.forEach(s => { stageMap[s.StageID] = s.StageNameAr || s.StageName; });

  const reasonIds = [...new Set(need.filter(o => o.LostReasonID).map(o => o.LostReasonID))];
  let reasonMap = {};
  if (reasonIds.length > 0) {
    const reasonIdsStr = reasonIds.join(',');
    const reasonRes = await pool.request().query(`
      SELECT LostReasonID, ReasonNameAr, ReasonName FROM LostReasons WHERE LostReasonID IN (${reasonIdsStr})
    `);
    reasonRes.recordset.forEach(r => { reasonMap[r.LostReasonID] = r.ReasonNameAr || r.ReasonName; });
  }

  const notificationsQueries = require('../notifications/notifications.queries');
  let created = 0;

  for (const opp of need) {
    // Least loaded employee
    const chosen = csEmps.sort((a, b) => {
      const loadA = loads[a.EmployeeID] || 0;
      const loadB = loads[b.EmployeeID] || 0;
      return loadA - loadB;
    })[0];

    const partyName = partyMap[opp.PartyID] || `عميل #${opp.PartyID}`;
    const stageAr = stageMap[opp.StageID] || 'خسارة';
    const reason = opp.LostReasonID ? reasonMap[opp.LostReasonID] : null;

    const taskDesc = `استرداد فرصة خاسرة: ${partyName} — القيمة ${(opp.ExpectedValue || 0).toLocaleString()} ج.م${reason ? ` (السبب: ${reason})` : ''}`;
    const priority = (opp.ExpectedValue || 0) >= 50000 ? 'High' : 'Normal';

    try {
      await pool.request()
        .input('oppId', sql.Int, opp.OpportunityID)
        .input('partyId', sql.Int, opp.PartyID)
        .input('assignedTo', sql.Int, chosen.EmployeeID)
        .input('taskDesc', sql.NVarChar(sql.MAX), taskDesc)
        .input('priority', sql.NVarChar(20), priority)
        .query(`
          INSERT INTO CRM_Tasks (
            OpportunityID, PartyID, AssignedTo, TaskScope, TaskDescription,
            DueDate, Priority, Status, IsActive, ReminderEnabled, CreatedBy, CreatedAt
          ) VALUES (
            @oppId, @partyId, @assignedTo, N'Recovery', @taskDesc,
            DATEADD(DAY, 1, CAST(GETDATE() AS DATE)), @priority, N'Pending', 1, 1, N'RecoverySystem', GETDATE()
          )
        `);
      created++;
      loads[chosen.EmployeeID] = (loads[chosen.EmployeeID] || 0) + 1;

      // Notification
      try {
        await notificationsQueries.createNotification({
          title: '🔁 فرصة خاسرة بانتظار الاسترداد',
          message: `العميل ${partyName} — ${stageAr} بقيمة ${(opp.ExpectedValue || 0).toLocaleString()} ج.م. برجاء التواصل خلال 24 ساعة.`,
          recipientUser: userByEmp[chosen.EmployeeID],
          relatedTable: 'SalesOpportunities',
          relatedId: opp.OpportunityID,
          formName: 'crm/lost-recovery',
          createdBy: 'RecoverySystem',
        });
      } catch (e) {
        console.error('notify recovery:', e.message);
      }
    } catch (err) {
      // Unique index violation - concurrent assignment, ignore
      if (err.number === 2601 || err.number === 2627 || (err.message && err.message.includes('UX_CrmTasks_RecoveryOpen'))) {
        console.log(`Recovery: opportunity ${opp.OpportunityID} assigned concurrently, skipping`);
      } else {
        console.error(`Recovery sync error for opp ${opp.OpportunityID}:`, err.message);
      }
    }
  }

  return { created };
}

// ═══════════════════════════════════════════════════════════
// ⏰ Send overdue reminders
// ═══════════════════════════════════════════════════════════
async function sendOverdueReminders() {
  const pool = await connectDB();
  const tasksRes = await pool.request().query(`
    SELECT TaskID, OpportunityID, PartyID, AssignedTo, DueDate
    FROM CRM_Tasks
    WHERE TaskScope = N'Recovery'
      AND Status = N'Pending'
      AND IsActive = 1
      AND ReminderEnabled = 1
      AND DueDate < GETDATE()
  `);
  const tasks = tasksRes.recordset;
  if (tasks.length === 0) return { sent: 0 };

  const empIds = [...new Set(tasks.map(t => t.AssignedTo))];
  const empIdsStr = empIds.join(',');

  const usersRes = await pool.request().query(`
    SELECT employeeID, Username FROM Users WHERE employeeID IN (${empIdsStr}) AND ISNULL(IsActive,1)=1
  `);
  const userByEmp = {};
  usersRes.recordset.forEach(u => { userByEmp[u.employeeID] = u.Username; });

  const partyIds = [...new Set(tasks.filter(t => t.PartyID).map(t => t.PartyID))];
  let partyMap = {};
  if (partyIds.length > 0) {
    const partyIdsStr = partyIds.join(',');
    const partyRes = await pool.request().query(`SELECT PartyID, PartyName FROM Parties WHERE PartyID IN (${partyIdsStr})`);
    partyRes.recordset.forEach(p => { partyMap[p.PartyID] = p.PartyName; });
  }

  const notificationsQueries = require('../notifications/notifications.queries');
  let sent = 0;

  for (const t of tasks) {
    const uname = userByEmp[t.AssignedTo];
    if (!uname) {
      console.warn(`Overdue recovery task ${t.TaskID} skipped: no active user for emp ${t.AssignedTo}`);
      continue;
    }

    const partyName = t.PartyID && partyMap[t.PartyID] ? partyMap[t.PartyID] : (t.OpportunityID ? `فرصة #${t.OpportunityID}` : 'عميل');

    try {
      await notificationsQueries.createNotification({
        title: '⏰ متابعة استرداد متأخرة',
        message: `العميل ${partyName} — كان موعد المتابعة ${new Date(t.DueDate).toLocaleDateString('ar-EG')}. برجاء التواصل اليوم لإتمام الاسترداد.`,
        recipientUser: uname,
        relatedTable: 'SalesOpportunities',
        relatedId: t.OpportunityID,
        formName: 'crm/lost-recovery',
        createdBy: 'RecoverySystem',
      });

      await pool.request()
        .input('id', sql.Int, t.TaskID)
        .query(`UPDATE CRM_Tasks SET ReminderEnabled = 0 WHERE TaskID = @id`);

      sent++;
    } catch (e) {
      console.error('reminder error:', e.message);
    }
  }

  return { sent };
}

// ═══════════════════════════════════════════════════════════
// 🔄 Run maintenance (sync + reminders)
// ═══════════════════════════════════════════════════════════
async function runQueueMaintenance() {
  const sync = await syncNewLosses();
  const reminders = await sendOverdueReminders();
  return { sync, reminders };
}

// ═══════════════════════════════════════════════════════════
// 📝 Log contact after loss
// ═══════════════════════════════════════════════════════════
async function logContact(data, userName) {
  const pool = await connectDB();
  const { OpportunityId, PartyId, Channel, Outcome, Summary, NextFollowUpDate } = data;

  if (!Summary || String(Summary).trim() === '') {
    return { success: false, message: 'اكتب ملخص التواصل أولاً' };
  }

  const oppRes = await pool.request()
    .input('id', sql.Int, OpportunityId)
    .query(`SELECT OpportunityID, PartyID, EmployeeID, StageID FROM SalesOpportunities WHERE OpportunityID = @id`);
  const opp = oppRes.recordset[0];
  if (!opp) return { success: false, message: 'الفرصة غير موجودة' };

  const empIdRes = await pool.request()
    .input('username', sql.NVarChar(100), userName)
    .query(`SELECT TOP 1 employeeID FROM Users WHERE Username = @username AND employeeID IS NOT NULL`);
  const actorEmpId = empIdRes.recordset[0]?.employeeID || opp.EmployeeID || null;

  const isDefinitive = Outcome === 'رفض نهائي';
  const now = new Date();

  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    // Add interaction
    await new sql.Request(transaction)
      .input('oppId', sql.Int, OpportunityId)
      .input('partyId', sql.Int, PartyId || opp.PartyID)
      .input('empId', sql.Int, actorEmpId)
      .input('summary', sql.NVarChar(sql.MAX), `[${Channel}] ${Summary}`)
      .input('stageBefore', sql.Int, opp.StageID)
      .input('stageAfter', sql.Int, opp.StageID)
      .input('nextFollowUp', sql.DateTime, isDefinitive ? null : (NextFollowUpDate ? new Date(NextFollowUpDate) : null))
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO CustomerInteractions (
          OpportunityID, PartyID, EmployeeID, InteractionDate, Summary,
          StageBeforeID, StageAfterID, NextFollowUpDate, CreatedBy, CreatedAt
        ) VALUES (
          @oppId, @partyId, @empId, GETDATE(), @summary,
          @stageBefore, @stageAfter, @nextFollowUp, @createdBy, GETDATE()
        )
      `);

    // Update opportunity
    if (isDefinitive) {
      await new sql.Request(transaction)
        .input('id', sql.Int, OpportunityId)
        .input('notes', sql.NVarChar(sql.MAX), `رفض نهائي (${Channel}): ${Summary}`)
        .input('userName', sql.NVarChar(100), userName)
        .query(`
          UPDATE SalesOpportunities SET
            IsRecoveryRejected = 1,
            IsRecoveryCandidate = 0,
            RecoveryNotes = @notes,
            NextFollowUpDate = NULL,
            LastContactDate = GETDATE(),
            LastUpdatedBy = @userName,
            LastUpdatedAt = GETDATE()
          WHERE OpportunityID = @id
        `);

      await new sql.Request(transaction)
        .input('oppId', sql.Int, OpportunityId)
        .input('userName', sql.NVarChar(100), userName)
        .input('notes', sql.NVarChar(500), `رفض نهائي من العميل: ${Summary}`)
        .query(`
          UPDATE CRM_Tasks SET
            Status = N'Completed',
            CompletedDate = GETDATE(),
            CompletedBy = @userName,
            CompletionNotes = @notes
          WHERE OpportunityID = @oppId AND TaskScope = N'Recovery' AND Status = N'Pending' AND IsActive = 1
        `);
    } else if (NextFollowUpDate) {
      await new sql.Request(transaction)
        .input('id', sql.Int, OpportunityId)
        .input('nextFollowUp', sql.DateTime, new Date(NextFollowUpDate))
        .input('userName', sql.NVarChar(100), userName)
        .query(`
          UPDATE SalesOpportunities SET
            NextFollowUpDate = @nextFollowUp,
            LastContactDate = GETDATE(),
            LastUpdatedBy = @userName,
            LastUpdatedAt = GETDATE()
          WHERE OpportunityID = @id
        `);

      const pendingRes = await new sql.Request(transaction)
        .input('oppId', sql.Int, OpportunityId)
        .query(`SELECT TOP 1 TaskID FROM CRM_Tasks WHERE OpportunityID = @oppId AND TaskScope = N'Recovery' AND Status = N'Pending' AND IsActive = 1`);

      if (pendingRes.recordset[0]) {
        await new sql.Request(transaction)
          .input('taskId', sql.Int, pendingRes.recordset[0].TaskID)
          .input('dueDate', sql.DateTime, new Date(NextFollowUpDate))
          .input('desc', sql.NVarChar(sql.MAX), `متابعة استرداد: ${Summary}`)
          .query(`
            UPDATE CRM_Tasks SET DueDate = @dueDate, TaskDescription = @desc WHERE TaskID = @taskId
          `);
      } else if (actorEmpId) {
        await new sql.Request(transaction)
          .input('oppId', sql.Int, OpportunityId)
          .input('partyId', sql.Int, PartyId || opp.PartyID)
          .input('assignedTo', sql.Int, actorEmpId)
          .input('desc', sql.NVarChar(sql.MAX), `متابعة استرداد: ${Summary}`)
          .input('dueDate', sql.DateTime, new Date(NextFollowUpDate))
          .input('createdBy', sql.NVarChar(100), userName)
          .query(`
            INSERT INTO CRM_Tasks (
              OpportunityID, PartyID, AssignedTo, TaskScope, TaskDescription,
              DueDate, Priority, Status, IsActive, ReminderEnabled, CreatedBy, CreatedAt
            ) VALUES (
              @oppId, @partyId, @assignedTo, N'Recovery', @desc,
              @dueDate, N'Normal', N'Pending', 1, 1, @createdBy, GETDATE()
            )
          `);
      }
    } else {
      await new sql.Request(transaction)
        .input('id', sql.Int, OpportunityId)
        .input('userName', sql.NVarChar(100), userName)
        .query(`
          UPDATE SalesOpportunities SET LastContactDate = GETDATE(), LastUpdatedBy = @userName, LastUpdatedAt = GETDATE()
          WHERE OpportunityID = @id
        `);
    }

    await transaction.commit();

    return {
      success: true,
      message: isDefinitive
        ? 'تم تسجيل الرفض النهائي — لن تظهر الفرصة في طابور المتابعة مرة أخرى.'
        : 'تم تسجيل محاولة التواصل.',
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// 🕘 History after loss
// ═══════════════════════════════════════════════════════════
async function getRecoveryHistory(opportunityId) {
  const pool = await connectDB();

  const oppRes = await pool.request()
    .input('id', sql.Int, opportunityId)
    .query(`SELECT ClosedAt FROM SalesOpportunities WHERE OpportunityID = @id`);
  if (!oppRes.recordset[0]) return [];

  const closedAt = oppRes.recordset[0].ClosedAt || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const rowsRes = await pool.request()
    .input('oppId', sql.Int, opportunityId)
    .input('from', sql.DateTime, new Date(closedAt))
    .query(`
      SELECT InteractionDate, Summary, CreatedBy, EmployeeID
      FROM CustomerInteractions
      WHERE OpportunityID = @oppId AND InteractionDate >= @from
      ORDER BY InteractionDate ASC
    `);
  const rows = rowsRes.recordset;
  if (rows.length === 0) return [];

  const empIds = [...new Set(rows.filter(r => r.EmployeeID).map(r => r.EmployeeID))];
  let empMap = {};
  if (empIds.length > 0) {
    const empIdsStr = empIds.join(',');
    const empRes = await pool.request().query(`SELECT EmployeeID, FullName FROM Employees WHERE EmployeeID IN (${empIdsStr})`);
    empRes.recordset.forEach(e => { empMap[e.EmployeeID] = e.FullName; });
  }

  const usernames = [...new Set(rows.map(r => r.CreatedBy).filter(Boolean))];
  let userMap = {};
  if (usernames.length > 0) {
    const req = pool.request();
    const placeholders = usernames.map((_, i) => `@u${i}`).join(',');
    usernames.forEach((u, i) => req.input(`u${i}`, sql.NVarChar(100), u));
    const userRes = await req.query(`SELECT Username, FullName FROM Users WHERE Username IN (${placeholders})`);
    userRes.recordset.forEach(u => { userMap[u.Username] = u.FullName; });
  }

  return rows.map(r => {
    let summary = r.Summary || '';
    let channel = null;
    if (summary.startsWith('[') && summary.includes(']')) {
      const close = summary.indexOf(']');
      channel = summary.substring(1, close);
      summary = summary.substring(close + 1).trim();
    }
    const name = r.EmployeeID && empMap[r.EmployeeID] ? empMap[r.EmployeeID] : (userMap[r.CreatedBy] || r.CreatedBy);
    return {
      Date: r.InteractionDate,
      Summary: summary,
      CreatedBy: name,
      EmployeeName: name,
      Channel: channel,
    };
  });
}

// ═══════════════════════════════════════════════════════════
// 🔁 Revive - العميل راجع
// ═══════════════════════════════════════════════════════════
async function revive(data, userName) {
  const pool = await connectDB();
  const { OpportunityId, SameOpportunity, NewStageId, ExpectedValue, NextFollowUpDate, NewInterestedProduct, Notes } = data;

  const oppRes = await pool.request()
    .input('id', sql.Int, OpportunityId)
    .query(`SELECT OpportunityID, PartyID, StageID, EmployeeID, SourceID, CategoryID, InterestedProduct, ExpectedValue FROM SalesOpportunities WHERE OpportunityID = @id`);
  const opp = oppRes.recordset[0];
  if (!opp) return { success: false, message: 'الفرصة غير موجودة' };

  if (opp.StageID !== LOST_STAGE_ID && opp.StageID !== NOT_INTERESTED_STAGE_ID) {
    return { success: false, message: 'الفرصة ليست في مرحلة خسارة — لا يمكن استردادها' };
  }

  if (NewStageId === LOST_STAGE_ID || NewStageId === NOT_INTERESTED_STAGE_ID) {
    return { success: false, message: 'اختر مرحلة بيع فعلية (وليست مرحلة خسارة)' };
  }

  const stageRes = await pool.request()
    .input('id', sql.Int, NewStageId)
    .query(`SELECT StageNameAr, StageName FROM SalesStages WHERE StageID = @id AND IsActive = 1`);
  if (!stageRes.recordset[0]) return { success: false, message: 'المرحلة الجديدة غير صالحة' };
  const stageAr = stageRes.recordset[0].StageNameAr || stageRes.recordset[0].StageName;

  const oldStageRes = await pool.request()
    .input('id', sql.Int, opp.StageID)
    .query(`SELECT StageNameAr, StageName FROM SalesStages WHERE StageID = @id`);
  const oldStageAr = oldStageRes.recordset[0]?.StageNameAr || oldStageRes.recordset[0]?.StageName || 'خسارة';

  const partyRes = await pool.request()
    .input('id', sql.Int, opp.PartyID)
    .query(`SELECT PartyName FROM Parties WHERE PartyID = @id`);
  const partyName = partyRes.recordset[0]?.PartyName || `عميل #${opp.PartyID}`;

  const empIdRes = await pool.request()
    .input('username', sql.NVarChar(100), userName)
    .query(`SELECT TOP 1 employeeID FROM Users WHERE Username = @username AND employeeID IS NOT NULL`);
  const actorEmpId = empIdRes.recordset[0]?.employeeID || opp.EmployeeID || null;

  const followUp = NextFollowUpDate ? new Date(NextFollowUpDate) : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    // Close open recovery tasks
    await new sql.Request(transaction)
      .input('oppId', sql.Int, OpportunityId)
      .input('userName', sql.NVarChar(100), userName)
      .input('notes', sql.NVarChar(500), `تم استرداد العميل — ${stageAr}`)
      .query(`
        UPDATE CRM_Tasks SET Status = N'Completed', CompletedDate = GETDATE(), CompletedBy = @userName, CompletionNotes = @notes
        WHERE OpportunityID = @oppId AND TaskScope = N'Recovery' AND Status = N'Pending' AND IsActive = 1
      `);

    let newId = null;

    if (SameOpportunity) {
      await new sql.Request(transaction)
        .input('id', sql.Int, OpportunityId)
        .input('newStageId', sql.Int, NewStageId)
        .input('expectedValue', sql.Decimal(18, 2), ExpectedValue || opp.ExpectedValue || 0)
        .input('nextFollowUp', sql.DateTime, followUp)
        .input('userName', sql.NVarChar(100), userName)
        .query(`
          UPDATE SalesOpportunities SET
            StageID = @newStageId,
            LostReasonID = NULL,
            LostNotes = NULL,
            IsRecoveryCandidate = 0,
            IsRecoveryRejected = 0,
            RecoveryNotes = NULL,
            ClosedAt = NULL,
            ClosedBy = NULL,
            ExpectedValue = @expectedValue,
            NextFollowUpDate = @nextFollowUp,
            LastContactDate = GETDATE(),
            LastUpdatedBy = @userName,
            LastUpdatedAt = GETDATE()
          WHERE OpportunityID = @id
        `);

      await new sql.Request(transaction)
        .input('oppId', sql.Int, OpportunityId)
        .input('partyId', sql.Int, opp.PartyID)
        .input('empId', sql.Int, actorEmpId)
        .input('summary', sql.NVarChar(sql.MAX), `🔁 استرداد: عاد العميل بعد ${oldStageAr} إلى ${stageAr}`)
        .input('stageBefore', sql.Int, opp.StageID)
        .input('stageAfter', sql.Int, NewStageId)
        .input('nextFollowUp', sql.DateTime, followUp)
        .input('notes', sql.NVarChar(sql.MAX), Notes || null)
        .input('createdBy', sql.NVarChar(100), userName)
        .query(`
          INSERT INTO CustomerInteractions (
            OpportunityID, PartyID, EmployeeID, InteractionDate, Summary,
            StageBeforeID, StageAfterID, NextFollowUpDate, Notes, CreatedBy, CreatedAt
          ) VALUES (
            @oppId, @partyId, @empId, GETDATE(), @summary,
            @stageBefore, @stageAfter, @nextFollowUp, @notes, @createdBy, GETDATE()
          )
        `);
    } else {
      // New opportunity linked to old
      const newOppRes = await new sql.Request(transaction)
        .input('partyId', sql.Int, opp.PartyID)
        .input('empId', sql.Int, opp.EmployeeID)
        .input('sourceId', sql.Int, opp.SourceID)
        .input('catId', sql.Int, opp.CategoryID)
        .input('product', sql.NVarChar(255), NewInterestedProduct || opp.InterestedProduct || null)
        .input('expectedValue', sql.Decimal(18, 2), ExpectedValue || opp.ExpectedValue || 0)
        .input('stageId', sql.Int, NewStageId)
        .input('nextFollowUp', sql.DateTime, followUp)
        .input('notes', sql.NVarChar(sql.MAX), `مستردة من الفرصة الخاسرة #${OpportunityId} (${partyName})${Notes ? ` — ${Notes}` : ''}`)
        .input('createdBy', sql.NVarChar(100), userName)
        .query(`
          INSERT INTO SalesOpportunities (
            PartyID, EmployeeID, SourceID, CategoryID, InterestedProduct, ExpectedValue,
            StageID, StatusID, FirstContactDate, NextFollowUpDate, Notes, IsActive, CreatedBy, CreatedAt
          )
          OUTPUT INSERTED.OpportunityID
          VALUES (
            @partyId, @empId, @sourceId, @catId, @product, @expectedValue,
            @stageId, 1, GETDATE(), @nextFollowUp, @notes, 1, @createdBy, GETDATE()
          )
        `);
      newId = newOppRes.recordset[0].OpportunityID;

      await new sql.Request(transaction)
        .input('oppId', sql.Int, newId)
        .input('partyId', sql.Int, opp.PartyID)
        .input('empId', sql.Int, actorEmpId)
        .input('summary', sql.NVarChar(sql.MAX), `🔁 فرصة جديدة بعد الاسترداد من الخاسرة #${OpportunityId} — ${stageAr}`)
        .input('stageAfter', sql.Int, NewStageId)
        .input('nextFollowUp', sql.DateTime, followUp)
        .input('createdBy', sql.NVarChar(100), userName)
        .query(`
          INSERT INTO CustomerInteractions (
            OpportunityID, PartyID, EmployeeID, InteractionDate, Summary,
            StageAfterID, NextFollowUpDate, CreatedBy, CreatedAt
          ) VALUES (
            @oppId, @partyId, @empId, GETDATE(), @summary,
            @stageAfter, @nextFollowUp, @createdBy, GETDATE()
          )
        `);

      await new sql.Request(transaction)
        .input('id', sql.Int, OpportunityId)
        .input('notes', sql.NVarChar(sql.MAX), Notes || null)
        .input('userName', sql.NVarChar(100), userName)
        .query(`
          UPDATE SalesOpportunities SET
            IsActive = 0,
            Notes = ISNULL(Notes, N'') + N'
[استرداد] أُنشئت فرصة جديدة #' + CAST(${newId} AS NVARCHAR) + N' بتاريخ ' + CONVERT(NVARCHAR, GETDATE(), 23) + N'.',
            LastUpdatedBy = @userName,
            LastUpdatedAt = GETDATE()
          WHERE OpportunityID = @id
        `);

      await new sql.Request(transaction)
        .input('oppId', sql.Int, OpportunityId)
        .input('partyId', sql.Int, opp.PartyID)
        .input('empId', sql.Int, actorEmpId)
        .input('summary', sql.NVarChar(sql.MAX), `🔁 استرداد: عاد العميل بفرصة جديدة #${newId} بعد ${oldStageAr} إلى ${stageAr}`)
        .input('stageBefore', sql.Int, opp.StageID)
        .input('stageAfter', sql.Int, NewStageId)
        .input('nextFollowUp', sql.DateTime, followUp)
        .input('notes', sql.NVarChar(sql.MAX), Notes || null)
        .input('createdBy', sql.NVarChar(100), userName)
        .query(`
          INSERT INTO CustomerInteractions (
            OpportunityID, PartyID, EmployeeID, InteractionDate, Summary,
            StageBeforeID, StageAfterID, NextFollowUpDate, Notes, CreatedBy, CreatedAt
          ) VALUES (
            @oppId, @partyId, @empId, GETDATE(), @summary,
            @stageBefore, @stageAfter, @nextFollowUp, @notes, @createdBy, GETDATE()
          )
        `);
    }

    await transaction.commit();

    return {
      success: true,
      message: SameOpportunity
        ? `تم استرداد العميل ${partyName} — عادت الفرصة إلى مرحلة ${stageAr}.`
        : `تم إنشاء فرصة جديدة (#${newId}) للعميل ${partyName} في مرحلة ${stageAr}.`,
      newOpportunityId: newId,
    };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// 📋 Recovery stages (valid for revive)
// ═══════════════════════════════════════════════════════════
async function getRecoveryStages() {
  const pool = await connectDB();
  const res = await pool.request().query(`
    SELECT StageID, StageName, StageNameAr, StageOrder, StageColor
    FROM SalesStages
    WHERE IsActive = 1 AND StageID NOT IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
    ORDER BY StageOrder
  `);
  return res.recordset;
}

// ═══════════════════════════════════════════════════════════
// 👥 CS employees light
// ═══════════════════════════════════════════════════════════
async function getCustomerServiceEmployeesLight() {
  const pool = await connectDB();
  const res = await pool.request().query(`
    SELECT EmployeeID, FullName
    FROM Employees
    WHERE Department = N'${CS_DEPARTMENT}' AND (Status = N'نشط' OR Status = N'Active')
    ORDER BY FullName
  `);
  return res.recordset;
}

// ═══════════════════════════════════════════════════════════
// 📊 تقرير الاسترداد الشامل - مطابق RecoveryService.GetRecoveryReportAsync
// ═══════════════════════════════════════════════════════════
async function getRecoveryReport(filters = {}, pageIndex = 1, pageSize = 50) {
  const pool = await connectDB();
  if (pageIndex < 1) pageIndex = 1;
  if (pageSize < 0) pageSize = 0; // 0 = الكل

  const { From, To, Status = 'all', CsEmployeeId, SearchText } = filters;

  // Build base query: currently lost + revived
  let whereOpps = `o.IsActive = 1 OR EXISTS (
    SELECT 1 FROM CustomerInteractions ci
    WHERE ci.OpportunityID = o.OpportunityID
      AND ci.StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
      AND ci.StageAfterID NOT IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
  )`;

  // For simplicity, get all opps that are lost or were revived
  const allOppsRes = await pool.request().query(`
    SELECT OpportunityID, PartyID, StageID, ExpectedValue, LostReasonID, ClosedAt, LastContactDate, CreatedAt, IsRecoveryRejected, IsActive
    FROM SalesOpportunities
    WHERE (StageID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID}) AND IsActive = 1)
       OR OpportunityID IN (
         SELECT DISTINCT OpportunityID FROM CustomerInteractions
         WHERE StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
           AND StageAfterID NOT IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
       )
  `);

  let opps = allOppsRes.recordset;
  if (opps.length === 0) {
    return { Rows: [], RowCount: 0, TotalValue: 0, UncontactedCount: 0, ContactedCount: 0, RejectedCount: 0, RevivedCount: 0, PageIndex: pageIndex, PageSize: pageSize, TotalPages: 1, HasMore: false, AsOfUtc: new Date() };
  }

  const oppIds = opps.map(o => o.OpportunityID);
  const oppIdsStr = oppIds.join(',');

  // Party names & phones
  const partyIds = [...new Set(opps.map(o => o.PartyID))];
  const partyIdsStr = partyIds.join(',');
  const partyRes = await pool.request().query(`SELECT PartyID, PartyName, Phone FROM Parties WHERE PartyID IN (${partyIdsStr})`);
  const partyMap = {};
  const phoneMap = {};
  partyRes.recordset.forEach(p => { partyMap[p.PartyID] = p.PartyName; phoneMap[p.PartyID] = p.Phone; });

  // Lost reasons
  const reasonIds = [...new Set(opps.filter(o => o.LostReasonID).map(o => o.LostReasonID))];
  let reasonMap = {};
  if (reasonIds.length > 0) {
    const reasonRes = await pool.request().query(`SELECT LostReasonID, ReasonNameAr, ReasonName FROM LostReasons WHERE LostReasonID IN (${reasonIds.join(',')})`);
    reasonRes.recordset.forEach(r => { reasonMap[r.LostReasonID] = r.ReasonNameAr || r.ReasonName; });
  }

  // Stages
  const stageIds = [...new Set(opps.map(o => o.StageID))];
  let stageMap = {};
  if (stageIds.length > 0) {
    const stageRes = await pool.request().query(`SELECT StageID, StageNameAr, StageName FROM SalesStages WHERE StageID IN (${stageIds.join(',')})`);
    stageRes.recordset.forEach(s => { stageMap[s.StageID] = s.StageNameAr || s.StageName; });
  }

  // CS interactions after loss
  const csIntsRes = await pool.request().query(`
    SELECT OpportunityID, InteractionDate, Summary, CreatedBy
    FROM CustomerInteractions
    WHERE OpportunityID IN (${oppIdsStr})
      AND StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
      AND StageAfterID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
      AND Summary NOT LIKE N'نقل تلقائي%'
  `);
  const csByOpp = {};
  csIntsRes.recordset.forEach(row => {
    if (!csByOpp[row.OpportunityID]) csByOpp[row.OpportunityID] = [];
    csByOpp[row.OpportunityID].push({ Date: row.InteractionDate, Summary: row.Summary, By: row.CreatedBy });
  });

  // Revived rows
  const revivedRes = await pool.request().query(`
    SELECT OpportunityID, InteractionDate, CreatedBy
    FROM CustomerInteractions
    WHERE OpportunityID IN (${oppIdsStr})
      AND StageBeforeID IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
      AND StageAfterID NOT IN (${LOST_STAGE_ID}, ${NOT_INTERESTED_STAGE_ID})
  `);
  const revivedByOpp = {};
  revivedRes.recordset.forEach(r => {
    if (!revivedByOpp[r.OpportunityID] || revivedByOpp[r.OpportunityID] < r.InteractionDate) {
      revivedByOpp[r.OpportunityID] = r.InteractionDate;
    }
  });

  // Recovery tasks open
  const tasksRes = await pool.request().query(`
    SELECT OpportunityID, AssignedTo FROM CRM_Tasks
    WHERE OpportunityID IN (${oppIdsStr}) AND TaskScope = N'Recovery' AND Status = N'Pending' AND IsActive = 1
  `);
  const empByOpp = {};
  const taskEmpIds = [];
  tasksRes.recordset.forEach(t => { empByOpp[t.OpportunityID] = t.AssignedTo; taskEmpIds.push(t.AssignedTo); });

  let empNameMap = {};
  if (taskEmpIds.length > 0) {
    const empRes = await pool.request().query(`SELECT EmployeeID, FullName FROM Employees WHERE EmployeeID IN (${[...new Set(taskEmpIds)].join(',')})`);
    empRes.recordset.forEach(e => { empNameMap[e.EmployeeID] = e.FullName; });
  }

  // Users for creators
  const allCreators = [...csIntsRes.recordset.map(r => r.CreatedBy), ...revivedRes.recordset.map(r => r.CreatedBy)].filter(Boolean);
  let userMap = {};
  if (allCreators.length > 0) {
    const uniq = [...new Set(allCreators)];
    const placeholders = uniq.map((_, i) => `@u${i}`).join(',');
    const req = pool.request();
    uniq.forEach((u, i) => req.input(`u${i}`, sql.NVarChar(100), u));
    const userRes = await req.query(`SELECT Username, FullName, employeeID FROM Users WHERE Username IN (${placeholders})`);
    userRes.recordset.forEach(u => { userMap[u.Username] = { Name: u.FullName || u.Username, EmpId: u.employeeID || 0 }; });
  }

  // Build rows
  let rows = [];
  for (const o of opps) {
    const isCurrentlyLost = o.IsActive == 1 && (o.StageID == LOST_STAGE_ID || o.StageID == NOT_INTERESTED_STAGE_ID);
    const hasRevive = revivedByOpp[o.OpportunityID] != null;
    const isRejected = o.IsRecoveryRejected == 1 || o.IsRecoveryRejected == true;

    if (!isCurrentlyLost && !hasRevive) continue;

    let csList = csByOpp[o.OpportunityID] || [];
    csList = csList.filter(c => !o.ClosedAt || new Date(c.Date) >= new Date(o.ClosedAt));

    let lastCs = null;
    if (csList.length > 0) {
      lastCs = csList.sort((a, b) => new Date(a.Date) - new Date(b.Date)).pop();
    }

    let statusAr;
    if (!isCurrentlyLost) statusAr = 'مُسترد';
    else if (isRejected) statusAr = 'رفض نهائي';
    else if (csList.length > 0) statusAr = 'قيد المتابعة';
    else statusAr = 'لم يُتواصل';

    let anchorDate;
    let csName = null;

    if (!isCurrentlyLost) {
      anchorDate = revivedByOpp[o.OpportunityID];
      const lastRev = revivedRes.recordset.filter(r => r.OpportunityID == o.OpportunityID && r.InteractionDate == anchorDate).pop();
      if (lastRev && userMap[lastRev.CreatedBy]) csName = userMap[lastRev.CreatedBy].Name;
    } else if (statusAr == 'لم يُتواصل') {
      anchorDate = o.ClosedAt || o.LastContactDate || o.CreatedAt;
      if (empByOpp[o.OpportunityID] && empNameMap[empByOpp[o.OpportunityID]]) csName = empNameMap[empByOpp[o.OpportunityID]];
    } else {
      anchorDate = lastCs ? lastCs.Date : (o.ClosedAt || o.LastContactDate || o.CreatedAt);
      if (empByOpp[o.OpportunityID] && empNameMap[empByOpp[o.OpportunityID]]) csName = empNameMap[empByOpp[o.OpportunityID]];
      else if (lastCs && userMap[lastCs.By]) csName = userMap[lastCs.By].Name;
    }

    let ownerEmp = null;
    if (empByOpp[o.OpportunityID]) ownerEmp = empByOpp[o.OpportunityID];
    else if (lastCs && userMap[lastCs.By]) ownerEmp = userMap[lastCs.By].EmpId;
    else if (!isCurrentlyLost) {
      const lr = revivedRes.recordset.filter(r => r.OpportunityID == o.OpportunityID).pop();
      if (lr && userMap[lr.CreatedBy]) ownerEmp = userMap[lr.CreatedBy].EmpId;
    }

    rows.push({
      OpportunityId: o.OpportunityID,
      PartyId: o.PartyID,
      ClientName: partyMap[o.PartyID] || `عميل #${o.PartyID}`,
      Phone: phoneMap[o.PartyID] || null,
      ExpectedValue: o.ExpectedValue,
      LostReasonName: o.LostReasonID && reasonMap[o.LostReasonID] ? reasonMap[o.LostReasonID] : null,
      StageNameAr: stageMap[o.StageID] || null,
      ClosedAt: o.ClosedAt,
      CsEmployeeName: csName,
      ContactCount: csList.length,
      LastCsDate: lastCs ? lastCs.Date : null,
      LastCsSummary: lastCs ? (lastCs.Summary && lastCs.Summary.startsWith('[') && lastCs.Summary.includes(']') ? lastCs.Summary.substring(lastCs.Summary.indexOf(']') + 1).trim() : lastCs.Summary) : null,
      RevivedDate: (!isCurrentlyLost && hasRevive) ? revivedByOpp[o.OpportunityID] : null,
      StatusAr: statusAr,
      AnchorDate: anchorDate,
      CsEmpId: ownerEmp,
    });
  }

  // Apply filters
  let filtered = rows.filter(r => {
    if (From && r.AnchorDate && new Date(r.AnchorDate) < new Date(From)) return false;
    if (To && r.AnchorDate && new Date(r.AnchorDate) > new Date(To)) return false;
    if (CsEmployeeId && r.CsEmpId != CsEmployeeId) return false;
    if (Status != 'all') {
      const matches = (Status == 'rejected' && r.StatusAr == 'رفض نهائي') ||
        (Status == 'revived' && r.StatusAr == 'مُسترد') ||
        (Status == 'contacting' && r.StatusAr == 'قيد المتابعة') ||
        (Status == 'uncontacted' && r.StatusAr == 'لم يُتواصل');
      if (!matches) return false;
    }
    if (SearchText && SearchText.trim() !== '') {
      const s = SearchText.trim().toLowerCase();
      const phone = (r.Phone || '').toLowerCase();
      if (!(r.ClientName.toLowerCase().includes(s) || phone.includes(s))) return false;
    }
    return true;
  });

  // Sort by latest activity
  filtered.sort((a, b) => {
    const da = a.RevivedDate || a.LastCsDate || a.ClosedAt;
    const db = b.RevivedDate || b.LastCsDate || b.ClosedAt;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return new Date(db) - new Date(da);
  });

  const rowCount = filtered.length;
  const totalValue = filtered.reduce((sum, r) => sum + (r.ExpectedValue || 0), 0);
  const uncontactedCount = filtered.filter(r => r.StatusAr == 'لم يُتواصل').length;
  const contactedCount = filtered.filter(r => r.StatusAr == 'قيد المتابعة').length;
  const rejectedCount = filtered.filter(r => r.StatusAr == 'رفض نهائي').length;
  const revivedCount = filtered.filter(r => r.StatusAr == 'مُسترد').length;

  // Pagination
  const totalPages = pageSize > 0 ? Math.ceil(rowCount / pageSize) : 1;
  const currentPage = Math.min(Math.max(1, pageIndex), Math.max(1, totalPages));
  let pageRows = filtered;
  if (pageSize > 0) {
    const start = (currentPage - 1) * pageSize;
    pageRows = filtered.slice(start, start + pageSize);
  }

  return {
    Rows: pageRows,
    RowCount: rowCount,
    TotalValue: totalValue,
    UncontactedCount: uncontactedCount,
    ContactedCount: contactedCount,
    RejectedCount: rejectedCount,
    RevivedCount: revivedCount,
    PageIndex: currentPage,
    PageSize: pageSize,
    TotalPages: totalPages,
    HasMore: pageSize > 0 && currentPage * pageSize < rowCount,
    AsOfUtc: new Date(),
  };
}

async function getReportTrend(months = 12) {
  if (months < 2) months = 2;
  if (months > 24) months = 24;

  const report = await getRecoveryReport({}, 1, 0);
  const rows = report.Rows;

  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1);

  const points = [];
  for (let i = 0; i < months; i++) {
    const m = new Date(start.getFullYear(), start.getMonth() + i, 1);
    points.push({ Label: `${m.getFullYear()}/${String(m.getMonth() + 1).padStart(2, '0')}`, Uncontacted: 0, Contacting: 0, Rejected: 0, Revived: 0 });
  }

  for (const r of rows) {
    if (!r.AnchorDate) continue;
    const m = new Date(r.AnchorDate);
    if (m < start || m > today) continue;
    const idx = (m.getFullYear() - start.getFullYear()) * 12 + (m.getMonth() - start.getMonth());
    if (idx < 0 || idx >= points.length) continue;
    switch (r.StatusAr) {
      case 'لم يُتواصل': points[idx].Uncontacted++; break;
      case 'قيد المتابعة': points[idx].Contacting++; break;
      case 'رفض نهائي': points[idx].Rejected++; break;
      case 'مُسترد': points[idx].Revived++; break;
    }
  }

  return points;
}

async function getEmployeePerformance() {
  const report = await getRecoveryReport({}, 1, 0);
  const rows = report.Rows.filter(r => r.CsEmpId);

  const byEmp = {};
  for (const r of rows) {
    const id = r.CsEmpId;
    if (!byEmp[id]) byEmp[id] = [];
    byEmp[id].push(r);
  }

  const list = [];
  for (const empId in byEmp) {
    const empRows = byEmp[empId];
    const first = empRows.find(r => r.CsEmployeeName) || empRows[0];
    list.push({
      EmployeeId: parseInt(empId),
      FullName: first.CsEmployeeName || `موظف #${empId}`,
      Assigned: empRows.length,
      Uncontacted: empRows.filter(r => r.StatusAr == 'لم يُتواصل').length,
      Contacting: empRows.filter(r => r.StatusAr == 'قيد المتابعة').length,
      Rejected: empRows.filter(r => r.StatusAr == 'رفض نهائي').length,
      Revived: empRows.filter(r => r.StatusAr == 'مُسترد').length,
      RevivedValue: empRows.filter(r => r.StatusAr == 'مُسترد').reduce((sum, r) => sum + (r.ExpectedValue || 0), 0),
      ReviveRate: empRows.length > 0 ? (empRows.filter(r => r.StatusAr == 'مُسترد').length / empRows.length) * 100 : 0,
    });
  }

  return list.sort((a, b) => b.RevivedValue - a.RevivedValue || b.Revived - a.Revived || b.Assigned - a.Assigned);
}

async function getLostReasonAnalysis() {
  const report = await getRecoveryReport({}, 1, 0);
  const rows = report.Rows.filter(r => r.LostReasonName);

  const byReason = {};
  for (const r of rows) {
    const reason = r.LostReasonName;
    if (!byReason[reason]) byReason[reason] = [];
    byReason[reason].push(r);
  }

  const list = [];
  for (const reason in byReason) {
    const rs = byReason[reason];
    list.push({
      ReasonName: reason,
      Total: rs.length,
      Revived: rs.filter(r => r.StatusAr == 'مُسترد').length,
      ReviveRate: rs.length > 0 ? (rs.filter(r => r.StatusAr == 'مُسترد').length / rs.length) * 100 : 0,
    });
  }

  return list.sort((a, b) => b.Total - a.Total || b.ReviveRate - a.ReviveRate);
}

// ═══════════════════════════════════════════════════════════
// 🔁 Ensure recovery assignment for single opportunity (called on loss close)
// ═══════════════════════════════════════════════════════════
async function ensureRecoveryAssignment(opportunityId) {
  const pool = await connectDB();

  const oppRes = await pool.request()
    .input('id', sql.Int, opportunityId)
    .query(`
      SELECT PartyID, StageID, ExpectedValue, LostReasonID, IsRecoveryRejected, IsActive
      FROM SalesOpportunities WHERE OpportunityID = @id
    `);
  const opp = oppRes.recordset[0];
  if (!opp) return;
  if (opp.IsActive !== true && opp.IsActive !== 1) return;
  if (opp.StageID !== LOST_STAGE_ID && opp.StageID !== NOT_INTERESTED_STAGE_ID) return;
  if (opp.IsRecoveryRejected === true || opp.IsRecoveryRejected === 1) return;

  const hasTaskRes = await pool.request()
    .input('oppId', sql.Int, opportunityId)
    .query(`
      SELECT TOP 1 TaskID FROM CRM_Tasks
      WHERE OpportunityID = @oppId AND TaskScope = N'Recovery' AND Status = N'Pending' AND IsActive = 1
    `);
  if (hasTaskRes.recordset[0]) return;

  // CS employees
  const empsRes = await pool.request().query(`
    SELECT e.EmployeeID, e.FullName
    FROM Employees e
    WHERE e.Department = N'${CS_DEPARTMENT}' AND (e.Status = N'نشط' OR e.Status = N'Active')
  `);
  const employees = empsRes.recordset;
  if (employees.length === 0) return;

  const empIds = employees.map(e => e.EmployeeID);
  const empIdsStr = empIds.join(',');

  const usersRes = await pool.request().query(`
    SELECT employeeID, Username FROM Users WHERE employeeID IN (${empIdsStr}) AND ISNULL(IsActive,1)=1
  `);
  const userByEmp = {};
  usersRes.recordset.forEach(u => { userByEmp[u.employeeID] = u.Username; });
  const csEmps = employees.filter(e => userByEmp[e.EmployeeID]);
  if (csEmps.length === 0) return;

  const loadsRes = await pool.request().query(`
    SELECT AssignedTo, COUNT(*) as Cnt FROM CRM_Tasks
    WHERE Status = N'Pending' AND IsActive = 1 AND AssignedTo IN (${empIdsStr})
    GROUP BY AssignedTo
  `);
  const loads = {};
  loadsRes.recordset.forEach(r => { loads[r.AssignedTo] = r.Cnt; });

  const chosen = csEmps.sort((a, b) => (loads[a.EmployeeID] || 0) - (loads[b.EmployeeID] || 0))[0];

  const partyRes = await pool.request()
    .input('id', sql.Int, opp.PartyID)
    .query(`SELECT PartyName FROM Parties WHERE PartyID = @id`);
  const partyName = partyRes.recordset[0]?.PartyName || `عميل #${opp.PartyID}`;

  const stageRes = await pool.request()
    .input('id', sql.Int, opp.StageID)
    .query(`SELECT StageNameAr, StageName FROM SalesStages WHERE StageID = @id`);
  const stageAr = stageRes.recordset[0]?.StageNameAr || stageRes.recordset[0]?.StageName || 'خسارة';

  const reasonRes = opp.LostReasonID ? await pool.request()
    .input('id', sql.Int, opp.LostReasonID)
    .query(`SELECT ReasonNameAr, ReasonName FROM LostReasons WHERE LostReasonID = @id`) : { recordset: [] };
  const reason = reasonRes.recordset[0]?.ReasonNameAr || reasonRes.recordset[0]?.ReasonName || null;

  const taskDesc = `استرداد فرصة خاسرة: ${partyName} — القيمة ${(opp.ExpectedValue || 0).toLocaleString()} ج.م${reason ? ` (السبب: ${reason})` : ''}`;
  const priority = (opp.ExpectedValue || 0) >= 50000 ? 'High' : 'Normal';

  try {
    await pool.request()
      .input('oppId', sql.Int, opportunityId)
      .input('partyId', sql.Int, opp.PartyID)
      .input('assignedTo', sql.Int, chosen.EmployeeID)
      .input('taskDesc', sql.NVarChar(sql.MAX), taskDesc)
      .input('priority', sql.NVarChar(20), priority)
      .query(`
        INSERT INTO CRM_Tasks (
          OpportunityID, PartyID, AssignedTo, TaskScope, TaskDescription,
          DueDate, Priority, Status, IsActive, ReminderEnabled, CreatedBy, CreatedAt
        ) VALUES (
          @oppId, @partyId, @assignedTo, N'Recovery', @taskDesc,
          DATEADD(DAY, 1, CAST(GETDATE() AS DATE)), @priority, N'Pending', 1, 1, N'RecoverySystem', GETDATE()
        )
      `);

    const notificationsQueries = require('../notifications/notifications.queries');
    await notificationsQueries.createNotification({
      title: '🔁 فرصة خاسرة بانتظار الاسترداد',
      message: `العميل ${partyName} — ${stageAr} بقيمة ${(opp.ExpectedValue || 0).toLocaleString()} ج.م. برجاء التواصل خلال 24 ساعة.`,
      recipientUser: userByEmp[chosen.EmployeeID],
      relatedTable: 'SalesOpportunities',
      relatedId: opportunityId,
      formName: 'crm/lost-recovery',
      createdBy: 'RecoverySystem',
    });
  } catch (err) {
    if (err.number === 2601 || err.number === 2627) {
      console.log(`Recovery ensure: opportunity ${opportunityId} assigned concurrently`);
    } else {
      console.error('ensureRecoveryAssignment error:', err.message);
    }
  }
}

module.exports = {
  getStats,
  getQueue,
  getLateCount,
  getUnprocessedNewLossesCount,
  syncNewLosses,
  sendOverdueReminders,
  runQueueMaintenance,
  logContact,
  getRecoveryHistory,
  revive,
  getRecoveryStages,
  getCustomerServiceEmployeesLight,
  getEmployeeIdByUsername,
  ensureRecoveryAssignment,
  getRecoveryReport,
  getReportTrend,
  getEmployeePerformance,
  getLostReasonAnalysis,
};
