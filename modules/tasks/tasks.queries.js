const { sql, connectDB } = require('../../core/database');
const policy = require('../../shared/authorization.policy');

function guardError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// حارس الملكية للتكليفات العامة — مرآة Blazor CanActOnGeneralTaskAsync
// (Services/TaskService.cs): مدير (الأدوار الثلاثة) أو المكلَّف نفسه
// (حسابه مربوط بموظف التكليف).
function canActOnGeneralTask(auth, task) {
  if (policy.generalTasks.canManageAll(auth)) return true;
  return Number(auth?.employeeId || 0) > 0
    && Number(auth.employeeId) === Number(task.AssignedTo);
}

// tedious/mssql requires a JavaScript Date for sql.Time; Flutter sends HH:mm.
// Normalize every supported representation before binding so invalid input returns
// a controlled 400 instead of an EPARAM stack trace from the SQL driver.
function normalizeTaskPriority(value) {
  const priority = String(value || '').trim().toLowerCase();
  if (priority === 'high') return 'High';
  if (priority === 'low') return 'Low';
  if (priority === 'medium' || priority === 'normal') return 'Normal';
  return 'Normal';
}

function normalizeSqlTime(value) {
  if (value == null || String(value).trim() === '') return null;

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
    throw Object.assign(new Error('وقت تنفيذ المهمة غير صالح'), {
      statusCode: 400,
      code: 'INVALID_DUE_TIME',
    });
  }

  const raw = String(value).trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,7}))?)?$/);
  if (!match) {
    throw Object.assign(
      new Error('وقت تنفيذ المهمة غير صالح. استخدم الصيغة HH:mm مثل 10:30'),
      { statusCode: 400, code: 'INVALID_DUE_TIME' },
    );
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  const milliseconds = Number(String(match[4] || '').padEnd(3, '0').slice(0, 3) || 0);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, seconds, milliseconds));
}

// جلب كل المهام
// في tasks.queries.js
// جلب كل المهام (شامل التعديلات الجديدة)
async function getAllTasks(filters = {}) {
  const pool = await connectDB();
  const { assignedTo, status, priority, startDate, endDate, opportunityEmployeeId } = filters;

  let query = `
    SELECT 
      t.TaskID, t.OpportunityID, t.PartyID, t.AssignedTo,
      t.TaskTypeID, t.TaskDescription, t.DueDate, t.DueTime,
      t.Priority, t.Status, t.IsActive,
      
      -- بيانات العميل
      p.PartyName AS ClientName, p.Phone,
      
      -- بيانات الموظف المكلف بالمهمة (Assigned To)
      e.FullName AS AssignedToName,
      
      -- ✅ بيانات صاحب الفرصة (Opportunity Owner) - ده الجديد والمهم
      o.EmployeeID AS OpportunityOwnerID,
      empOwner.FullName AS OpportunityOwnerName,
      
      -- ✅ تاريخ آخر تواصل
      o.LastContactDate,
      
      tt.TaskTypeName, tt.TaskTypeNameAr,
      
      -- حالة المهمة المحسوبة
      CASE 
        WHEN t.Status = N'Completed' THEN N'Completed'
        WHEN CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'Overdue'
        WHEN CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE) THEN N'Today'
        WHEN CAST(t.DueDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN N'Tomorrow'
        ELSE N'Upcoming'
      END AS TaskDueStatus

    FROM CRM_Tasks t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
    LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
    
    -- ✅ الربط مع الفرص عشان نجيب بيانات المالك
    LEFT JOIN SalesOpportunities o ON t.OpportunityID = o.OpportunityID
    
    -- ✅ الربط مع جدول الموظفين تاني عشان نجيب اسم صاحب الفرصة
    LEFT JOIN Employees empOwner ON o.EmployeeID = empOwner.EmployeeID
    
    WHERE t.IsActive = 1
  `;

  const request = pool.request();

  // 1. فلتر بصاحب الفرصة (لو مختارين من الفلتر فوق)
  if (opportunityEmployeeId) {
    query += ` AND o.EmployeeID = @opportunityEmployeeId`;
    request.input('opportunityEmployeeId', sql.Int, opportunityEmployeeId);
  } 
  // 2. فلتر بالمكلف بالمهمة (لو مش مختارين فلتر، يبقى نجيب مهام الموظف الحالي)
  else if (assignedTo) {
    query += ` AND t.AssignedTo = @assignedTo`;
    request.input('assignedTo', sql.Int, assignedTo);
  }

  // باقي الفلاتر العادية
  if (status) {
    query += ` AND t.Status = @status`;
    request.input('status', sql.NVarChar(20), status);
  }

  // ترتيب حسب التاريخ والأولوية
  query += ` ORDER BY t.DueDate ASC, t.Priority DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب مهام اليوم
async function getTodayTasks(assignedTo = null) {
  const pool = await connectDB();
  const request = pool.request();

  let query = `
    SELECT 
      t.TaskID, t.TaskDescription, t.DueDate, t.DueTime,
      t.Priority, t.Status,
      p.PartyName AS ClientName, p.Phone,
      tt.TaskTypeNameAr
    FROM CRM_Tasks t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
    WHERE t.IsActive = 1 
      AND t.Status NOT IN ('Completed', 'Cancelled')
      AND CAST(t.DueDate AS DATE) = CAST(GETDATE() AS DATE)
  `;

  if (assignedTo) {
    query += ` AND t.AssignedTo = @assignedTo`;
    request.input('assignedTo', sql.Int, assignedTo);
  }

  query += ` ORDER BY t.DueTime ASC, t.Priority DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب المهام المتأخرة
async function getOverdueTasks(assignedTo = null) {
  const pool = await connectDB();
  const request = pool.request();

  let query = `
    SELECT 
      t.TaskID, t.TaskDescription, t.DueDate,
      t.Priority, t.Status,
      p.PartyName AS ClientName,
      DATEDIFF(DAY, t.DueDate, GETDATE()) AS DaysOverdue
    FROM CRM_Tasks t
    LEFT JOIN Parties p ON t.PartyID = p.PartyID
    WHERE t.IsActive = 1 
      AND t.Status NOT IN ('Completed', 'Cancelled')
      AND CAST(t.DueDate AS DATE) < CAST(GETDATE() AS DATE)
  `;

  if (assignedTo) {
    query += ` AND t.AssignedTo = @assignedTo`;
    request.input('assignedTo', sql.Int, assignedTo);
  }

  query += ` ORDER BY t.DueDate ASC`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب مهمة بالـ ID
async function getTaskById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        t.*,
        p.PartyName AS ClientName, p.Phone,
        e.FullName AS AssignedToName,
        tt.TaskTypeName, tt.TaskTypeNameAr
      FROM CRM_Tasks t
      LEFT JOIN Parties p ON t.PartyID = p.PartyID
      LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
      LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
      WHERE t.TaskID = @id
    `);
  return result.recordset[0] || null;
}

// إنشاء مهمة جديدة
async function createTask(data) {
  const dueTime = normalizeSqlTime(data.dueTime);
  const pool = await connectDB();
  const result = await pool.request()
    .input('opportunityId', sql.Int, data.opportunityId || null)
    .input('partyId', sql.Int, data.partyId || null)
    .input('assignedTo', sql.Int, data.assignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(500), data.taskDescription || null)
    .input('dueDate', sql.DateTime, data.dueDate)
    .input('dueTime', sql.Time, dueTime)
    .input('priority', sql.NVarChar(20), normalizeTaskPriority(data.priority))
    .input('status', sql.NVarChar(20), data.status || 'Pending')
    .input('reminderEnabled', sql.Bit, data.reminderEnabled !== undefined ? data.reminderEnabled : true)
    .input('reminderMinutes', sql.Int, data.reminderMinutes || 30)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      DECLARE @InsertedTasks TABLE (TaskID int NOT NULL);

      INSERT INTO CRM_Tasks (
        OpportunityID, PartyID, AssignedTo, TaskTypeID,
        TaskDescription, DueDate, DueTime, Priority, Status,
        ReminderEnabled, ReminderMinutes, IsActive, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.TaskID INTO @InsertedTasks (TaskID)
      VALUES (
        @opportunityId, @partyId, @assignedTo, @taskTypeId,
        @taskDescription, @dueDate, @dueTime, @priority, @status,
        @reminderEnabled, @reminderMinutes, 1, @createdBy, GETDATE()
      );

      SELECT TaskID FROM @InsertedTasks;
    `);
  return result.recordset[0].TaskID;
}

// تعديل مهمة
async function updateTask(id, data) {
  const dueTime = normalizeSqlTime(data.dueTime);
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('assignedTo', sql.Int, data.assignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(500), data.taskDescription || null)
    .input('dueDate', sql.DateTime, data.dueDate)
    .input('dueTime', sql.Time, dueTime)
    .input('priority', sql.NVarChar(20), normalizeTaskPriority(data.priority))
    .input('reminderEnabled', sql.Bit, data.reminderEnabled !== undefined ? data.reminderEnabled : true)
    .input('reminderMinutes', sql.Int, data.reminderMinutes || 30)
    .query(`
      UPDATE CRM_Tasks SET
        AssignedTo = @assignedTo, TaskTypeID = @taskTypeId,
        TaskDescription = @taskDescription, DueDate = @dueDate,
        DueTime = @dueTime, Priority = @priority,
        ReminderEnabled = @reminderEnabled, ReminderMinutes = @reminderMinutes
      WHERE TaskID = @id
    `);
  return true;
}

// تحديث حالة المهمة
async function updateTaskStatus(id, status, completedBy = null, completionNotes = null) {
  const pool = await connectDB();
  const request = pool.request()
    .input('id', sql.Int, id)
    .input('status', sql.NVarChar(20), status);

  let query = `UPDATE CRM_Tasks SET Status = @status`;

  if (status === 'Completed') {
    query += `, CompletedDate = GETDATE(), CompletedBy = @completedBy, CompletionNotes = @completionNotes`;
    request.input('completedBy', sql.NVarChar(50), completedBy);
    request.input('completionNotes', sql.NVarChar(500), completionNotes);
  }

  query += ` WHERE TaskID = @id`;

  await request.query(query);
  return true;
}

// حذف مهمة (Soft Delete)
async function deleteTask(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('UPDATE CRM_Tasks SET IsActive = 0 WHERE TaskID = @id');
  return true;
}

// ملخص المهام
async function getTasksSummary(assignedTo = null) {
  const pool = await connectDB();
  const request = pool.request();

  let whereClause = 'WHERE IsActive = 1';
  if (assignedTo) {
    whereClause += ' AND AssignedTo = @assignedTo';
    request.input('assignedTo', sql.Int, assignedTo);
  }

  const result = await request.query(`
    SELECT 
      COUNT(*) as totalTasks,
      SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END) as pendingTasks,
      SUM(CASE WHEN Status = 'In Progress' THEN 1 ELSE 0 END) as inProgressTasks,
      SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as completedTasks,
      SUM(CASE WHEN CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status NOT IN ('Completed', 'Cancelled') THEN 1 ELSE 0 END) as todayTasks,
      SUM(CASE WHEN CAST(DueDate AS DATE) < CAST(GETDATE() AS DATE) AND Status NOT IN ('Completed', 'Cancelled') THEN 1 ELSE 0 END) as overdueTasks
    FROM CRM_Tasks
    ${whereClause}
  `);
  return result.recordset[0];
}

// ═══════════════════════════════════════════════════════════
// التكليفات العامة - مطابقة بلازور GeneralTasks.razor
// TaskScope = General - مهام عامة بعيد عن الفرص البيعية
// ═══════════════════════════════════════════════════════════

async function getGeneralTasks(auth) {
  const pool = await connectDB();
  const req = pool.request();

  let query = `
    SELECT
      t.TaskID, t.OpportunityID, t.PartyID, t.LeadID,
      t.AssignedTo, t.TaskTypeID, t.TaskDescription,
      t.DueDate, t.DueTime, t.Priority, t.Status,
      t.AssignmentSource, t.TaskScope,
      t.StartedAt, t.StartedBy, t.StartNotes,
      t.CompletedDate, t.CompletedBy, t.CompletionNotes,
      t.CancelledAt, t.CancelledBy, t.CancellationReason,
      t.AcknowledgedAt, t.AcknowledgedBy,
      t.ReturnedAt, t.ReturnedBy, t.ReturnReason,
      t.CompletionLink,
      t.LinkedEntityType, t.LinkedEntityId, t.LinkedEntityTitle,
      t.ReminderEnabled, t.ReminderMinutes,
      t.CreatedBy, t.CreatedAt, t.IsActive,
      e.FullName AS AssignedToName,
      tt.TaskTypeName, tt.TaskTypeNameAr
    FROM CRM_Tasks t
    LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
    LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
    WHERE t.IsActive = 1 AND ISNULL(t.TaskScope, N'') = N'General'
  `;

  // نطاق القراءة — مرآة Blazor GetGeneralTasksAsync (Services/TaskService.cs):
  // مدير (الأدوار الثلاثة) يرى الكل؛ غيره يرى ما أُسند إليه أو أنشأه فقط.
  // قبل الإصلاح كانت القائمة تُرجع كل التكليفات لكل جلسة.
  if (!policy.generalTasks.canManageAll(auth)) {
    req.input('userName', sql.NVarChar(100), auth.username);
    if (auth.employeeId) {
      req.input('empId', sql.Int, auth.employeeId);
      query += ` AND (t.AssignedTo = @empId OR t.CreatedBy = @userName)`;
    } else {
      query += ` AND t.CreatedBy = @userName`;
    }
  }

  const result = await req.query(query + ` ORDER BY CASE WHEN t.Status = N'Completed' THEN 1 ELSE 0 END, t.DueDate ASC, t.DueTime ASC`);
  return result.recordset;
}

async function createGeneralTask(data, auth) {
  const userName = auth.username;
  const dueTime = normalizeSqlTime(data.dueTime);
  const pool = await connectDB();

  // فحوص بلازور AddGeneralEmployeeTaskAsync بنفس الترتيب: تاريخ التنفيذ
  // لا يكون في الماضي، والمكلَّف موظف موجود ونشط.
  const due = new Date(data.dueDate);
  if (!Number.isNaN(due.getTime())) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    if (dueDay < today) {
      throw guardError('تاريخ التنفيذ لا يمكن أن يكون في الماضي.', 400);
    }
  }
  const assigneeRes = await pool.request()
    .input('assignedTo', sql.Int, data.assignedTo)
    .query(`
      SELECT EmployeeID FROM Employees
      WHERE EmployeeID = @assignedTo AND (Status = N'نشط' OR Status = N'Active')
    `);
  if (!assigneeRes.recordset.length) {
    throw guardError('الموظف غير موجود أو غير نشط.', 400);
  }

  // ربط اختياري بمستند — العنوان يُحسم خادميًا وقت الحفظ (لقطة)، ولا يُوثق
  // بعنوان يرسله العميل — مرآة ResolveLinkedEntityCoreAsync في بلازور
  // (general-tasks-3-systemwide.patch). نوع/مستند غير صالح = رفض واضح 400.
  let link = null;
  const linkType = data.linkedEntityType != null ? String(data.linkedEntityType).trim() : '';
  const linkId = data.linkedEntityId != null ? Number(data.linkedEntityId) : null;
  if (linkType || linkId) {
    if (!LINK_TYPES.includes(linkType) || !Number.isInteger(linkId) || linkId <= 0) {
      throw guardError('المستند المرتبط غير موجود — تحقق من النوع والرقم.', 400);
    }
    link = await resolveLinkedEntity(pool, linkType, linkId);
    if (!link) {
      throw guardError('المستند المرتبط غير موجود — تحقق من النوع والرقم.', 400);
    }
  }

  const result = await pool.request()
    .input('assignedTo', sql.Int, data.assignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(sql.MAX), data.taskDescription)
    .input('dueDate', sql.Date, data.dueDate)
    .input('dueTime', sql.Time, dueTime)
    .input('priority', sql.NVarChar(20), normalizeTaskPriority(data.priority))
    .input('assignmentSource', sql.NVarChar(50), data.assignmentSource || 'Admin')
    .input('reminderMinutes', sql.Int, Number(data.reminderMinutes) > 0 ? Number(data.reminderMinutes) : null)
    .input('linkedEntityType', sql.NVarChar(30), link ? link.type : null)
    .input('linkedEntityId', sql.Int, link ? link.id : null)
    .input('linkedEntityTitle', sql.NVarChar(250), link ? link.title : null)
    .input('createdBy', sql.NVarChar(100), userName)
    .query(`
      DECLARE @InsertedTasks TABLE (TaskID int NOT NULL);

      INSERT INTO CRM_Tasks (
        AssignedTo, TaskTypeID, TaskDescription, DueDate, DueTime,
        Priority, Status, AssignmentSource, TaskScope, IsActive, CreatedBy, CreatedAt,
        ReminderEnabled, ReminderMinutes,
        LinkedEntityType, LinkedEntityId, LinkedEntityTitle
      )
      OUTPUT INSERTED.TaskID INTO @InsertedTasks (TaskID)
      VALUES (
        @assignedTo, @taskTypeId, @taskDescription, @dueDate, @dueTime,
        @priority, N'Pending', @assignmentSource, N'General', 1, @createdBy, GETDATE(),
        1, @reminderMinutes,
        @linkedEntityType, @linkedEntityId, @linkedEntityTitle
      );

      SELECT TaskID FROM @InsertedTasks;
    `);
  const taskId = result.recordset[0].TaskID;

  // ── إشعار للموظف المكلف - مطابق لبلازور ──
  try {
    const notificationsQueries = require('../notifications/notifications.queries');
    const userRes = await pool.request().input('empId', sql.Int, data.assignedTo).query(`
      SELECT TOP 1 Username FROM Users WHERE employeeID = @empId AND ISNULL(IsActive,1)=1
    `);
    const targetUser = userRes.recordset[0]?.Username;
    if (targetUser && targetUser.toLowerCase() !== userName.toLowerCase()) {
      await notificationsQueries.createNotification({
        title: '📌 تكليف عام جديد',
        message: `كلفك ${userName} بمهمة: ${data.taskDescription} - تاريخ التنفيذ: ${data.dueDate ? new Date(data.dueDate).toLocaleDateString('ar-EG') : ''}`,
        recipientUser: targetUser,
        relatedTable: 'CRM_Tasks',
        relatedId: taskId,
        formName: 'crm/general-tasks',
        createdBy: userName,
      });
    }
  } catch (e) {
    console.error('notify general task:', e.message);
  }

  return taskId;
}

async function loadTaskForAction(pool, taskId) {
  const result = await pool.request()
    .input('id', sql.Int, taskId)
    .query(`
      SELECT TaskID, Status, TaskScope, AssignedTo
      FROM CRM_Tasks
      WHERE TaskID = @id AND IsActive = 1
    `);
  return result.recordset[0] || null;
}

// بدء التنفيذ — حرّاس بلازور StartAsync (Services/TaskService.cs) بنفس
// الترتيب: وجود/نشاط → مكتملة → ملغية → قيد التنفيذ (نجاح تكراري) →
// الملاحظة إلزامية → ملكية التكليفات العامة.
// قبل الإصلاح: أي جلسة تبدأ أي تكليف وبهوية معلنة من العميل.
async function startGeneralTask(taskId, notes, auth) {
  const pool = await connectDB();
  const task = await loadTaskForAction(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (task.Status === 'Completed') throw guardError('تم إكمال المهمة بالفعل', 400);
  if (task.Status === 'Cancelled') throw guardError('المهمة ملغية ولا يمكن بدء تنفيذها', 400);
  if (task.Status === 'In Progress') return { message: 'المهمة بالفعل قيد التنفيذ' };
  if (!notes || !String(notes).trim()) {
    throw guardError('برجاء كتابة ماذا ستبدأ تنفيذه قبل بدء المهمة.', 400);
  }
  if (String(task.TaskScope || '').toLowerCase() === 'general' && !canActOnGeneralTask(auth, task)) {
    throw guardError('لا يمكنك بدء تنفيذ تكليف غير مُسند إليك.', 403);
  }

  await pool.request()
    .input('id', sql.Int, taskId)
    .input('notes', sql.NVarChar(500), String(notes).trim())
    .input('userName', sql.NVarChar(100), auth.username)
    .query(`
      UPDATE CRM_Tasks SET
        Status = N'In Progress',
        StartedAt = GETDATE(),
        StartedBy = @userName,
        StartNotes = @notes
      WHERE TaskID = @id AND Status = N'Pending'
    `);
  return { message: 'تم تحويل المهمة إلى جاري التنفيذ' };
}

// إتمام التنفيذ — حرّاس بلازور CompleteAsync (Services/TaskService.cs)
// بنفس الترتيب: وجود/نشاط (المحذوفة ناعمًا لا تُستكمل) → الملاحظة إلزامية →
// مكتملة (لا إعادة كتابة للإتمام) → ملغية (لا تُستكمل أبدًا) → الملكية.
// قبل الإصلاح كان الشرط الوحيد Status != 'Completed' — فالملغية تُستكمل،
// والمحذوفة تُستكمل، وأي شخص يُتمّ تكليف غيره.
async function completeGeneralTask(taskId, notes, auth) {
  const pool = await connectDB();
  const task = await loadTaskForAction(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (!notes || !String(notes).trim()) {
    throw guardError('برجاء كتابة ما الذي تم تنفيذه قبل إكمال المهمة.', 400);
  }
  if (task.Status === 'Completed') {
    throw guardError('تم إكمال المهمة بالفعل ولا يمكن إعادة إتمامها.', 400);
  }
  if (task.Status === 'Cancelled') throw guardError('المهمة ملغية ولا يمكن إتمامها.', 400);
  if (String(task.TaskScope || '').toLowerCase() === 'general' && !canActOnGeneralTask(auth, task)) {
    throw guardError('لا يمكنك إتمام تكليف غير مُسند إليك.', 403);
  }

  await pool.request()
    .input('id', sql.Int, taskId)
    .input('notes', sql.NVarChar(500), String(notes).trim())
    .input('userName', sql.NVarChar(100), auth.username)
    .query(`
      UPDATE CRM_Tasks SET
        Status = N'Completed',
        CompletedDate = GETDATE(),
        CompletedBy = @userName,
        CompletionNotes = @notes
      WHERE TaskID = @id AND Status IN (N'Pending', N'In Progress')
    `);
  return { message: 'تم إكمال المهمة' };
}

function isMissingTableError(error) {
  return Boolean(error) && (error.number === 208 || /Invalid object name/i.test(String(error.message || '')));
}

// عدّاد إشارات «مهامي» — مرآة Blazor GetMyTasksSummaryAsync
// (Services/TaskService.cs): عدد التكليفات العامة المميزة (DISTINCT
// TaskId) التي ذُكر فيها الموظف (@) في أي تعليق بخيطها. لا علم قراءة
// في نموذج بلازور — العدّ هو «مهام ذُكرت فيها» لا «إشارات غير مقروءة».
// الهوية من التوكن فقط (auth.employeeId)؛ حساب بلا موظف مربوط = صفر،
// وغياب جداول الخيط (قبل سكربت المنصة) يُخفّض العدد لصفر كما يفعل
// بلازور بدل كسر الرئيسية.
async function getMyMentionsCount(auth) {
  const employeeId = Number(auth?.employeeId || 0);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return 0;

  const pool = await connectDB();
  try {
    const result = await pool.request()
      .input('empId', sql.Int, employeeId)
      .query(`
        SELECT COUNT(DISTINCT c.TaskId) AS MentionCount
        FROM TaskCommentMentions m
        INNER JOIN TaskComments c ON c.Id = m.CommentId
        INNER JOIN CRM_Tasks t ON t.TaskID = c.TaskId
        WHERE m.MentionedEmployeeId = @empId
          AND t.TaskScope = N'General'
      `);
    return Number(result.recordset[0]?.MentionCount || 0);
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// منصة التكليفات العامة (المراحل ١/٣/٤) — الاستلام والإرجاع والإلغاء
// المسبَّب وخيط النقاش والمناداة والربط والتعديل المحروس.
// الهوية من التوكن فقط (auth) في كل دالة؛ المرجع: ملخصات وصِيَغ بلازور
// general-tasks-1-fixes / 3-systemwide / 4-discussion.
// الأعمدة الجديدة تفترض تشغيل general-tasks-2-platform.sql أولًا.
// ═══════════════════════════════════════════════════════════

const LINK_TYPES = ['Invoice', 'Delivery', 'JobOrder', 'Quotation', 'Customer', 'Maintenance'];

// تدقيق باصطلاحات بلازور (Audit_Log: TableName/ActionType/PrimaryKeyValue/
// OldData/NewData/LoginName) — فشله صامت دائمًا ولا يُسقط العملية الأصلية.
async function writeTaskAudit(pool, action, primaryKey, oldData, newData, userName) {
  try {
    await pool.request()
      .input('action', sql.NVarChar(100), action)
      .input('pk', sql.NVarChar(100), String(primaryKey))
      .input('oldData', sql.NVarChar(sql.MAX), oldData ? JSON.stringify(oldData) : null)
      .input('newData', sql.NVarChar(sql.MAX), newData ? JSON.stringify(newData) : null)
      .input('user', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO Audit_Log (TableName, ActionType, PrimaryKeyValue, OldData, NewData, ActionDate, LoginName, AppName)
        VALUES (N'CRM_Tasks', @action, @pk, @oldData, @newData, GETDATE(), @user, N'COCOBOLO API')
      `);
  } catch (_) { /* التدقيق لا يكسر العملية */ }
}

async function notifyUsername(pool, username, title, message, actor, taskId) {
  if (!username) return false;
  if (actor && String(username).toLowerCase() === String(actor).toLowerCase()) return false;
  try {
    const notificationsQueries = require('../notifications/notifications.queries');
    await notificationsQueries.createNotification({
      title,
      message,
      recipientUser: username,
      relatedTable: 'CRM_Tasks',
      relatedId: taskId,
      formName: 'crm/general-tasks',
      createdBy: actor,
    });
    return true;
  } catch (e) {
    console.error('notify task user:', e.message);
    return false;
  }
}

// إشعار موظف عبر حسابه المرتبط النشط — صامت عند غياب الحساب (نمط بلازور).
async function notifyTaskEmployee(pool, employeeId, title, message, actor, taskId) {
  try {
    const res = await pool.request()
      .input('empId', sql.Int, employeeId)
      .query(`SELECT TOP 1 Username FROM Users WHERE EmployeeID = @empId AND ISNULL(IsActive,1)=1`);
    const username = res.recordset[0]?.Username;
    if (!username) return false;
    return notifyUsername(pool, username, title, message, actor, taskId);
  } catch (e) {
    console.error('notify task employee:', e.message);
    return false;
  }
}

// إشعار منشئ التكليف بحسابه إن وُجد وكان نشطًا (NotifyTaskCreatorAsync).
async function notifyTaskCreator(pool, task, title, message, actor) {
  if (!task.CreatedBy) return;
  try {
    const res = await pool.request()
      .input('u', sql.NVarChar(100), task.CreatedBy)
      .query(`SELECT TOP 1 Username FROM Users WHERE Username = @u AND ISNULL(IsActive,1)=1`);
    if (!res.recordset.length) return;
    await notifyUsername(pool, task.CreatedBy, title, message, actor, task.TaskID);
  } catch (e) {
    console.error('notify task creator:', e.message);
  }
}

async function loadFullTask(pool, taskId) {
  const result = await pool.request()
    .input('id', sql.Int, taskId)
    .query(`
      SELECT TaskID, Status, TaskScope, AssignedTo, CreatedBy, TaskDescription,
             TaskTypeID, DueDate, DueTime, Priority,
             AcknowledgedAt, AcknowledgedBy
      FROM CRM_Tasks
      WHERE TaskID = @id AND IsActive = 1
    `);
  return result.recordset[0] || null;
}

// منشئ التكليف أو مدير — حارس الإلغاء/التعديل (CanAdministerGeneralTask).
function canAdministerGeneralTask(auth, task) {
  if (policy.generalTasks.canManageAll(auth)) return true;
  return Boolean(auth?.username)
    && String(task.CreatedBy || '').toLowerCase() === String(auth.username).toLowerCase();
}

function isAssignee(auth, task) {
  return Number(auth?.employeeId || 0) > 0
    && Number(auth.employeeId) === Number(task.AssignedTo);
}

// المشاركون في التكليف (IsTaskParticipantAsync): مكلَّف/منشئ/مدير/مذكور.
async function isTaskParticipant(pool, auth, task) {
  if (canAdministerGeneralTask(auth, task)) return true;
  if (isAssignee(auth, task)) return true;
  const employeeId = Number(auth?.employeeId || 0);
  if (!employeeId) return false;
  try {
    const res = await pool.request()
      .input('empId', sql.Int, employeeId)
      .input('taskId', sql.Int, task.TaskID)
      .query(`
        SELECT TOP 1 1 AS Hit
        FROM TaskCommentMentions m
        INNER JOIN TaskComments c ON c.Id = m.CommentId
        WHERE m.MentionedEmployeeId = @empId AND c.TaskId = @taskId
      `);
    return res.recordset.length > 0;
  } catch (_) {
    return false;
  }
}

// ── ربط المستندات: حسم العنوان الرسمي خادميًا ──
// مرآة ResolveLinkedEntityCoreAsync (general-tasks-3-systemwide.patch):
// المعاملات برقمها المرجعي واسم الطرف، وعروض الأسعار، وبنود صيانة
// التسليمات، والأطراف. عنوان أطول من ٢٥٠ حرفًا يُقتطع كما في بلازور.
async function partyNameById(pool, partyId) {
  if (!partyId) return 'غير محدد';
  const res = await pool.request()
    .input('pid', sql.Int, partyId)
    .query(`SELECT PartyName FROM Parties WHERE PartyID = @pid`);
  return res.recordset[0]?.PartyName || 'غير محدد';
}

async function transactionLinkTitle(pool, transactionId, prefix) {
  const res = await pool.request()
    .input('id', sql.Int, transactionId)
    .query(`SELECT ReferenceNumber, PartyID FROM Transactions WHERE TransactionID = @id`);
  const row = res.recordset[0];
  if (!row) return null;
  const party = await partyNameById(pool, row.PartyID);
  return `${prefix} ${row.ReferenceNumber || `#${transactionId}`} — ${party}`;
}

async function resolveLinkedEntity(pool, entityType, entityId) {
  let title = null;
  if (entityType === 'Customer') {
    const res = await pool.request()
      .input('id', sql.Int, entityId)
      .query(`SELECT PartyName FROM Parties WHERE PartyID = @id`);
    if (res.recordset.length) title = `العميل ${res.recordset[0].PartyName}`;
  } else if (entityType === 'Invoice') {
    title = await transactionLinkTitle(pool, entityId, 'فاتورة');
  } else if (entityType === 'Delivery') {
    title = await transactionLinkTitle(pool, entityId, 'تسليمة فاتورة');
  } else if (entityType === 'JobOrder') {
    title = await transactionLinkTitle(pool, entityId, 'أمر تشغيل');
  } else if (entityType === 'Quotation') {
    const res = await pool.request()
      .input('id', sql.Int, entityId)
      .query(`SELECT ReferenceNumber, PartyID FROM Quotations WHERE QuotationID = @id`);
    const row = res.recordset[0];
    if (row) {
      const party = await partyNameById(pool, row.PartyID);
      title = `عرض سعر ${row.ReferenceNumber || `#${entityId}`} — ${party}`;
    }
  } else if (entityType === 'Maintenance') {
    const res = await pool.request()
      .input('id', sql.Int, entityId)
      .query(`SELECT MaintenanceId, IssueDescription FROM DeliveryMaintenanceItems WHERE MaintenanceId = @id`);
    const row = res.recordset[0];
    if (row) title = `صيانة تسليم #${row.MaintenanceId} — ${row.IssueDescription || ''}`;
  }
  if (!title || !String(title).trim()) return null;
  if (title.length > 250) title = title.slice(0, 250);
  return { type: entityType, id: entityId, title };
}

// ── الاستلام: المكلَّف فقط يختم، والمنشئ يُشعَر، والتكرار نجاح ──
// مرآة AcknowledgeTaskAsync (general-tasks-4-discussion.patch) بنفس الترتيب.
async function acknowledgeGeneralTask(taskId, auth) {
  const pool = await connectDB();
  const task = await loadFullTask(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (String(task.TaskScope || '').toLowerCase() !== 'general') {
    throw guardError('الاستلام الموثّق متاح للتكليفات العامة فقط.', 400);
  }
  if (!isAssignee(auth, task)) {
    throw guardError('استلام التكليف متاح للمكلَّف به فقط.', 403);
  }
  if (task.Status === 'Completed' || task.Status === 'Cancelled') {
    throw guardError('لا يمكن استلام تكليف منتهٍ أو ملغى.', 400);
  }
  if (task.AcknowledgedAt) return { message: 'التكليف مُستلم بالفعل.' };

  await pool.request()
    .input('id', sql.Int, taskId)
    .input('user', sql.NVarChar(100), auth.username)
    .query(`
      UPDATE CRM_Tasks SET AcknowledgedAt = GETDATE(), AcknowledgedBy = @user
      WHERE TaskID = @id AND AcknowledgedAt IS NULL
    `);
  await writeTaskAudit(pool, 'GeneralEmployeeTaskAcknowledge', taskId, null,
    { AssignedTo: task.AssignedTo, AcknowledgedBy: auth.username, TaskDescription: task.TaskDescription }, auth.username);
  await notifyTaskCreator(pool, task, '👀 تم استلام تكليفك',
    `استلم ${auth.username} التكليف «${task.TaskDescription}».`, auth.username);
  return { message: 'تم تأكيد استلام التكليف وإشعار المنشئ.' };
}

// ── الإرجاع: المكلَّف، سبب إلزامي أولًا ثم النطاق ثم المكلَّف ──
// مرآة ReturnTaskAsync بنفس ترتيب الحرّاس: السبب ← الوجود ← النطاق ←
// المكلَّف ← الحالة. يعود Pending ويُصفَّر الاستلام والبدء ويُشعَر المنشئ.
async function returnGeneralTask(taskId, reason, auth) {
  if (!reason || !String(reason).trim()) {
    throw guardError('برجاء كتابة سبب إرجاع التكليف.', 400);
  }
  const pool = await connectDB();
  const task = await loadFullTask(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (String(task.TaskScope || '').toLowerCase() !== 'general') {
    throw guardError('الإرجاع الموثّق متاح للتكليفات العامة فقط.', 400);
  }
  if (!isAssignee(auth, task)) {
    throw guardError('إرجاع التكليف متاح للمكلَّف به فقط.', 403);
  }
  if (task.Status === 'Completed' || task.Status === 'Cancelled') {
    throw guardError('لا يمكن إرجاع تكليف منتهٍ أو ملغى.', 400);
  }

  const trimmed = String(reason).trim();
  await pool.request()
    .input('id', sql.Int, taskId)
    .input('user', sql.NVarChar(100), auth.username)
    .input('reason', sql.NVarChar(500), trimmed)
    .query(`
      UPDATE CRM_Tasks SET
        Status = N'Pending',
        StartedAt = NULL, StartedBy = NULL, StartNotes = NULL,
        ReturnedAt = GETDATE(), ReturnedBy = @user, ReturnReason = @reason,
        AcknowledgedAt = NULL, AcknowledgedBy = NULL
      WHERE TaskID = @id
    `);
  await writeTaskAudit(pool, 'GeneralEmployeeTaskReturn', taskId, null,
    { AssignedTo: task.AssignedTo, ReturnedBy: auth.username, Reason: trimmed, TaskDescription: task.TaskDescription }, auth.username);
  await notifyTaskCreator(pool, task, '↩️ أُرجع تكليف أنشأته',
    `أرجع ${auth.username} التكليف «${task.TaskDescription}».\nسبب الإرجاع: ${trimmed}\nيمكنك تعديله أو إعادة إسناده أو إلغاءه من صفحة التكليفات.`, auth.username);
  return { message: 'تم إرجاع التكليف وإشعار المنشئ.' };
}

// ── الإلغاء المسبَّب: المنشئ أو مدير، من Pending/In Progress فقط ──
// مرآة CancelGeneralTaskAsync (general-tasks-1-fixes.patch) بترتيبها الحرفي:
// السبب ← الوجود ← النطاق ← الإدارة ← مكتمل ← ملغى ← حالة أخرى.
async function cancelGeneralTask(taskId, reason, auth) {
  if (!reason || !String(reason).trim()) {
    throw guardError('برجاء كتابة سبب إلغاء التكليف.', 400);
  }
  const pool = await connectDB();
  const task = await loadFullTask(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (String(task.TaskScope || '').toLowerCase() !== 'general') {
    throw guardError('الإلغاء الموثّق متاح للتكليفات العامة فقط.', 400);
  }
  if (!canAdministerGeneralTask(auth, task)) {
    throw guardError('لا يمكنك إلغاء تكليف لم تنشئه.', 403);
  }
  if (task.Status === 'Completed') throw guardError('لا يمكن إلغاء تكليف مكتمل.', 400);
  if (task.Status === 'Cancelled') throw guardError('التكليف ملغى بالفعل.', 400);
  if (task.Status !== 'Pending' && task.Status !== 'In Progress') {
    throw guardError('لا يمكن إلغاء التكليف في حالته الحالية.', 400);
  }

  const trimmed = String(reason).trim();
  await pool.request()
    .input('id', sql.Int, taskId)
    .input('user', sql.NVarChar(100), auth.username)
    .input('reason', sql.NVarChar(500), trimmed)
    .query(`
      UPDATE CRM_Tasks SET
        Status = N'Cancelled',
        CancelledAt = GETDATE(), CancelledBy = @user, CancellationReason = @reason
      WHERE TaskID = @id
    `);
  await writeTaskAudit(pool, 'GeneralEmployeeTaskCancel', taskId, null,
    { AssignedTo: task.AssignedTo, CancelledBy: auth.username, Reason: trimmed, TaskDescription: task.TaskDescription }, auth.username);
  await notifyTaskEmployee(pool, task.AssignedTo, '🚫 تم إلغاء تكليف',
    `ألغى ${auth.username} تكليفًا كان مُسندًا إليك.\nالمهمة: ${task.TaskDescription}\nسبب الإلغاء: ${trimmed}`, auth.username, taskId);
  return { message: 'تم إلغاء التكليف وإشعار المكلَّف.' };
}

// ── خيط النقاش: قراءة وكتابة للمشاركين فقط ──
// غياب جدولي الخيط يتحلل بأمان: القراءة فارغة، والكتابة برسالة واضحة
// تطلب تشغيل سكربت المنصة — كما في بلازور تمامًا.
async function getTaskComments(taskId, auth) {
  const pool = await connectDB();
  const task = await loadFullTask(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (!(await isTaskParticipant(pool, auth, task))) {
    throw guardError('عرض النقاش متاح لأطراف التكليف فقط (المكلَّف والمنشئ والإدارة والمذكورون).', 403);
  }
  try {
    const res = await pool.request()
      .input('taskId', sql.Int, taskId)
      .query(`
        SELECT c.Id, c.TaskId, c.AuthorUserName, c.AuthorEmployeeId, c.AuthorName,
               c.Body, c.Kind, c.CreatedAt,
               (SELECT STRING_AGG(CAST(m.MentionedEmployeeId AS NVARCHAR(20)), ',')
                FROM TaskCommentMentions m WHERE m.CommentId = c.Id) AS MentionIdsCsv,
               (SELECT STRING_AGG(e.FullName, N'، ')
                FROM TaskCommentMentions m
                INNER JOIN Employees e ON e.EmployeeID = m.MentionedEmployeeId
                WHERE m.CommentId = c.Id) AS MentionNamesCsv
        FROM TaskComments c
        WHERE c.TaskId = @taskId
        ORDER BY c.CreatedAt ASC
      `);
    return res.recordset.map((r) => ({
      ...r,
      MentionedEmployeeIds: r.MentionIdsCsv ? String(r.MentionIdsCsv).split(',').map((x) => Number(x)).filter((n) => n > 0) : [],
      MentionedNames: r.MentionNamesCsv ? String(r.MentionNamesCsv).split('، ').filter(Boolean) : [],
      MentionIdsCsv: undefined,
      MentionNamesCsv: undefined,
    }));
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

// مرآة AddTaskCommentAsync: النص مطلوب (≤ ٢٠٠٠ حرف)، النوع Comment/Progress،
// والمناداة صريحة بقائمة موظفين تُشعر كل مذكور «📣 ذُكرت في تكليف».
async function addTaskComment(taskId, data, auth) {
  const body = String(data.body || '').trim();
  if (!body) throw guardError('برجاء كتابة نص التعليق أولًا.', 400);
  if (body.length > 2000) throw guardError('نص التعليق أطول من الحد المسموح (2000 حرف).', 400);

  const pool = await connectDB();
  const task = await loadFullTask(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (!(await isTaskParticipant(pool, auth, task))) {
    throw guardError('التعليق متاح لأطراف التكليف فقط (المكلَّف والمنشئ والإدارة والمذكورون).', 403);
  }

  const kind = data.kind === 'Progress' || data.type === 'Progress' ? 'Progress' : 'Comment';
  const authorEmpId = Number(auth.employeeId || 0) > 0 ? Number(auth.employeeId) : null;
  let authorName = null;
  if (authorEmpId) {
    try {
      const nameRes = await pool.request()
        .input('empId', sql.Int, authorEmpId)
        .query(`SELECT FullName FROM Employees WHERE EmployeeID = @empId`);
      authorName = nameRes.recordset[0]?.FullName || null;
    } catch (_) { authorName = null; }
  }

  const mentionIds = [...new Set((Array.isArray(data.mentionEmployeeIds) ? data.mentionEmployeeIds : [])
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== authorEmpId))];

  let commentId;
  try {
    const inserted = await pool.request()
      .input('taskId', sql.Int, taskId)
      .input('author', sql.NVarChar(100), auth.username)
      .input('authorEmpId', sql.Int, authorEmpId)
      .input('authorName', sql.NVarChar(150), authorName)
      .input('body', sql.NVarChar(2000), body)
      .input('kind', sql.NVarChar(20), kind)
      .query(`
        INSERT INTO TaskComments (TaskId, AuthorUserName, AuthorEmployeeId, AuthorName, Body, Kind, CreatedAt)
        OUTPUT INSERTED.Id
        VALUES (@taskId, @author, @authorEmpId, @authorName, @body, @kind, GETDATE())
      `);
    commentId = inserted.recordset[0].Id;
    for (const mid of mentionIds) {
      await pool.request()
        .input('commentId', sql.Int, commentId)
        .input('mid', sql.Int, mid)
        .query(`INSERT INTO TaskCommentMentions (CommentId, MentionedEmployeeId) VALUES (@commentId, @mid)`);
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      throw guardError('خيط النقاش غير مفعّل بعد — برجاء تشغيل سكربت المنصة (general-tasks-2-platform.sql) على قاعدة البيانات أولًا.', 400);
    }
    throw error;
  }

  for (const mid of mentionIds) {
    await notifyTaskEmployee(pool, mid, '📣 ذُكرت في تكليف',
      `ذكرك ${authorName || auth.username} في تكليف «${task.TaskDescription}».\nافتح «مهامي ← إشاراتي» لعرض الخيط والرد.`, auth.username, taskId);
  }
  return { commentId, message: 'تمت إضافة تعليقك إلى خيط التكليف.' };
}

// ── «إشاراتي»: تكليفات عامة مميزة ذُكر فيها موظف التوكن ──
// DISTINCT، الأحدث ذكرًا أولًا (أحدث تعليق مناداة)، وغياب جداول الخيط
// يتحلل لقائمة فارغة كما في بلازور. الهوية من التوكن فقط.
async function getMyMentions(auth) {
  const employeeId = Number(auth?.employeeId || 0);
  if (!Number.isInteger(employeeId) || employeeId <= 0) return [];
  const pool = await connectDB();
  try {
    const res = await pool.request()
      .input('empId', sql.Int, employeeId)
      .query(`
        SELECT
          t.TaskID, t.AssignedTo, t.TaskTypeID, t.TaskDescription,
          t.DueDate, t.DueTime, t.Priority, t.Status,
          t.AssignmentSource, t.TaskScope,
          t.StartedAt, t.CompletedDate,
          t.AcknowledgedAt, t.AcknowledgedBy,
          t.LinkedEntityType, t.LinkedEntityId, t.LinkedEntityTitle,
          t.CreatedBy, t.CreatedAt,
          e.FullName AS AssignedToName,
          tt.TaskTypeName, tt.TaskTypeNameAr,
          MAX(c.CreatedAt) AS LastMentionAt
        FROM TaskCommentMentions m
        INNER JOIN TaskComments c ON c.Id = m.CommentId
        INNER JOIN CRM_Tasks t ON t.TaskID = c.TaskId
        LEFT JOIN Employees e ON t.AssignedTo = e.EmployeeID
        LEFT JOIN TaskTypes tt ON t.TaskTypeID = tt.TaskTypeID
        WHERE m.MentionedEmployeeId = @empId
          AND t.IsActive = 1 AND t.TaskScope = N'General'
        GROUP BY
          t.TaskID, t.AssignedTo, t.TaskTypeID, t.TaskDescription,
          t.DueDate, t.DueTime, t.Priority, t.Status,
          t.AssignmentSource, t.TaskScope,
          t.StartedAt, t.CompletedDate,
          t.AcknowledgedAt, t.AcknowledgedBy,
          t.LinkedEntityType, t.LinkedEntityId, t.LinkedEntityTitle,
          t.CreatedBy, t.CreatedAt,
          e.FullName, tt.TaskTypeName, tt.TaskTypeNameAr
        ORDER BY LastMentionAt DESC
      `);
    return res.recordset;
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

// ── تعديل تكليف عام محروس — مرآة UpdateGeneralTaskAsync ──
// المنشئ أو مدير فقط؛ المكتمل/الملغى ممنوع؛ الوصف إلزامي؛ تاريخ ماضٍ
// مرفوض؛ إعادة الإسناد تتحقق من نشاط الموظف الجديد وتُصفّر الاستلام
// وتُشعر الطرفين، والتعديل العادي يُشعر المكلَّف؛ تدقيق قبل/بعد.
async function updateGeneralTask(taskId, data, auth) {
  const pool = await connectDB();
  const task = await loadFullTask(pool, taskId);
  if (!task) throw guardError('المهمة غير موجودة', 404);
  if (String(task.TaskScope || '').toLowerCase() !== 'general') {
    throw guardError('التعديل متاح للتكليفات العامة فقط.', 400);
  }
  if (!canAdministerGeneralTask(auth, task)) {
    throw guardError('لا يمكنك تعديل تكليف لم تنشئه.', 403);
  }
  if (task.Status === 'Completed' || task.Status === 'Cancelled') {
    throw guardError('لا يمكن تعديل تكليف مكتمل أو ملغى.', 400);
  }
  const description = String(data.taskDescription || '').trim();
  if (!description) throw guardError('اكتب وصف المهمة.', 400);
  const due = new Date(data.dueDate);
  if (Number.isNaN(due.getTime())) throw guardError('تاريخ التنفيذ غير صالح.', 400);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  if (dueDay < today) throw guardError('تاريخ التنفيذ لا يمكن أن يكون في الماضي.', 400);

  const newAssignedTo = Number(data.assignedTo);
  if (!Number.isInteger(newAssignedTo) || newAssignedTo <= 0) {
    throw guardError('اختر الموظف المكلف.', 400);
  }
  const reassigned = newAssignedTo !== Number(task.AssignedTo);
  let newAssigneeName = null;
  if (reassigned) {
    const empRes = await pool.request()
      .input('empId', sql.Int, newAssignedTo)
      .query(`
        SELECT FullName FROM Employees
        WHERE EmployeeID = @empId AND (Status = N'نشط' OR Status = N'Active')
      `);
    if (!empRes.recordset.length) throw guardError('الموظف الجديد غير موجود أو غير نشط.', 400);
    newAssigneeName = empRes.recordset[0].FullName;
  }

  // ربط اختياري: يُحدَّث فقط عند إرسال الحقلين؛ العنوان يُحسم خادميًا.
  let link = undefined;
  if (data.linkedEntityType !== undefined || data.linkedEntityId !== undefined) {
    const lt = data.linkedEntityType != null ? String(data.linkedEntityType).trim() : '';
    const li = data.linkedEntityId != null ? Number(data.linkedEntityId) : null;
    if (!lt && !li) {
      link = null;
    } else {
      if (!LINK_TYPES.includes(lt) || !Number.isInteger(li) || li <= 0) {
        throw guardError('المستند المرتبط غير موجود — تحقق من النوع والرقم.', 400);
      }
      link = await resolveLinkedEntity(pool, lt, li);
      if (!link) throw guardError('المستند المرتبط غير موجود — تحقق من النوع والرقم.', 400);
    }
  }

  const before = {
    AssignedTo: task.AssignedTo, TaskTypeId: task.TaskTypeID,
    TaskDescription: task.TaskDescription, DueDate: task.DueDate,
    DueTime: task.DueTime, Priority: task.Priority,
  };
  const dueTime = normalizeSqlTime(data.dueTime);
  const req = pool.request()
    .input('id', sql.Int, taskId)
    .input('assignedTo', sql.Int, newAssignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(sql.MAX), description)
    .input('dueDate', sql.Date, data.dueDate)
    .input('dueTime', sql.Time, dueTime)
    .input('priority', sql.NVarChar(20), normalizeTaskPriority(data.priority));
  let setLink = '';
  if (link !== undefined) {
    req.input('linkedEntityType', sql.NVarChar(30), link ? link.type : null);
    req.input('linkedEntityId', sql.Int, link ? link.id : null);
    req.input('linkedEntityTitle', sql.NVarChar(250), link ? link.title : null);
    setLink = ', LinkedEntityType = @linkedEntityType, LinkedEntityId = @linkedEntityId, LinkedEntityTitle = @linkedEntityTitle';
  }
  await req.query(`
    UPDATE CRM_Tasks SET
      AssignedTo = @assignedTo, TaskTypeID = @taskTypeId,
      TaskDescription = @taskDescription, DueDate = @dueDate,
      DueTime = @dueTime, Priority = @priority
      ${reassigned ? ', AcknowledgedAt = NULL, AcknowledgedBy = NULL' : ''}
      ${setLink}
    WHERE TaskID = @id
  `);

  await writeTaskAudit(pool, 'GeneralEmployeeTaskUpdate', taskId, before, {
    AssignedTo: newAssignedTo, TaskTypeId: data.taskTypeId || null,
    TaskDescription: description, DueDate: data.dueDate, Priority: normalizeTaskPriority(data.priority),
    UpdatedBy: auth.username,
  }, auth.username);

  if (reassigned) {
    await notifyTaskEmployee(pool, Number(task.AssignedTo), '↩️ تم نقل تكليف منك',
      `نقل ${auth.username} تكليفًا كان مُسندًا إليك إلى موظف آخر.\nالمهمة: ${description}`, auth.username, taskId);
    await notifyTaskEmployee(pool, newAssignedTo, '📌 تكليف عام جديد',
      `كلفك ${auth.username} بمهمة: ${description} - تاريخ التنفيذ: ${new Date(data.dueDate).toLocaleDateString('ar-EG')}`, auth.username, taskId);
    return { message: 'تم نقل التكليف إلى المكلَّف الجديد وإشعار الطرفين.', reassigned: true, newAssigneeName };
  }

  await notifyTaskEmployee(pool, newAssignedTo, '✏️ تم تعديل تكليفك',
    `عدّل ${auth.username} تكليفًا مُسندًا إليك.\nالمهمة: ${description}\nالمطلوب قبل: ${new Date(data.dueDate).toLocaleDateString('ar-EG')}`, auth.username, taskId);
  return { message: 'تم تحديث التكليف وإشعار المكلَّف.', reassigned: false };
}

// تصدير الدوال
module.exports = {
  normalizeTaskPriority,
  normalizeSqlTime,
  getAllTasks,
  getTodayTasks,
  getOverdueTasks,
  getTaskById,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  getTasksSummary,
  // التكليفات العامة
  getMyMentionsCount,
  getGeneralTasks,
  createGeneralTask,
  startGeneralTask,
  completeGeneralTask,
  // منصة التكليفات (استلام/إرجاع/إلغاء/نقاش/ربط/تعديل محروس)
  LINK_TYPES,
  resolveLinkedEntity,
  acknowledgeGeneralTask,
  returnGeneralTask,
  cancelGeneralTask,
  getTaskComments,
  addTaskComment,
  getMyMentions,
  updateGeneralTask,
};