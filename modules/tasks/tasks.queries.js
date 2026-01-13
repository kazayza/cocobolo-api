const { sql, connectDB } = require('../../core/database');

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
  const pool = await connectDB();
  const result = await pool.request()
    .input('opportunityId', sql.Int, data.opportunityId || null)
    .input('partyId', sql.Int, data.partyId || null)
    .input('assignedTo', sql.Int, data.assignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(500), data.taskDescription || null)
    .input('dueDate', sql.DateTime, data.dueDate)
    .input('dueTime', sql.Time, data.dueTime || null)
    .input('priority', sql.NVarChar(20), data.priority || 'Normal')
    .input('status', sql.NVarChar(20), data.status || 'Pending')
    .input('reminderEnabled', sql.Bit, data.reminderEnabled !== undefined ? data.reminderEnabled : true)
    .input('reminderMinutes', sql.Int, data.reminderMinutes || 30)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO CRM_Tasks (
        OpportunityID, PartyID, AssignedTo, TaskTypeID,
        TaskDescription, DueDate, DueTime, Priority, Status,
        ReminderEnabled, ReminderMinutes, IsActive, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.TaskID
      VALUES (
        @opportunityId, @partyId, @assignedTo, @taskTypeId,
        @taskDescription, @dueDate, @dueTime, @priority, @status,
        @reminderEnabled, @reminderMinutes, 1, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].TaskID;
}

// تعديل مهمة
async function updateTask(id, data) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('assignedTo', sql.Int, data.assignedTo)
    .input('taskTypeId', sql.Int, data.taskTypeId || null)
    .input('taskDescription', sql.NVarChar(500), data.taskDescription || null)
    .input('dueDate', sql.DateTime, data.dueDate)
    .input('dueTime', sql.Time, data.dueTime || null)
    .input('priority', sql.NVarChar(20), data.priority || 'Normal')
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

// تصدير الدوال
module.exports = {
  getAllTasks,
  getTodayTasks,
  getOverdueTasks,
  getTaskById,
  createTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  getTasksSummary
};