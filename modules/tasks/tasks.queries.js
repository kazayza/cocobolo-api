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

  const result = await pool.request()
    .input('assignedTo', sql.Int, data.assignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(sql.MAX), data.taskDescription)
    .input('dueDate', sql.Date, data.dueDate)
    .input('dueTime', sql.Time, dueTime)
    .input('priority', sql.NVarChar(20), normalizeTaskPriority(data.priority))
    .input('assignmentSource', sql.NVarChar(50), data.assignmentSource || 'Admin')
    .input('createdBy', sql.NVarChar(100), userName)
    .query(`
      DECLARE @InsertedTasks TABLE (TaskID int NOT NULL);

      INSERT INTO CRM_Tasks (
        AssignedTo, TaskTypeID, TaskDescription, DueDate, DueTime,
        Priority, Status, AssignmentSource, TaskScope, IsActive, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.TaskID INTO @InsertedTasks (TaskID)
      VALUES (
        @assignedTo, @taskTypeId, @taskDescription, @dueDate, @dueTime,
        @priority, N'Pending', @assignmentSource, N'General', 1, @createdBy, GETDATE()
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
};