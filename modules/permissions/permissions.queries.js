const { sql, connectDB } = require('../../core/database');

// 1. إضافة طلب إذن جديد
// 1. إضافة طلب إذن جديد (مع حساب المدة أوتوماتيك)
async function createPermission(data) {
  const pool = await connectDB();
  
  const result = await pool.request()
    .input('employeeId', sql.Int, data.employeeId)
    .input('permDate', sql.Date, data.permissionDate)
    .input('type', sql.NVarChar(50), data.type)
    .input('fromTime', sql.VarChar(8), data.fromTime) // بنستقبل الوقت كنص "09:00"
    .input('toTime', sql.VarChar(8), data.toTime)     // بنستقبل الوقت كنص "11:00"
    .input('reason', sql.NVarChar(255), data.reason)
    .input('createdAt', sql.DateTime, data.createdAt)
    .query(`
      INSERT INTO ShortPermissions (
        EmployeeID, PermissionDate, PermissionType, 
        FromTime, ToTime, DurationMinutes, 
        Reason, Status, CreatedAt
      )
      OUTPUT INSERTED.PermissionID
      VALUES (
        @employeeId, @permDate, @type, 
        CAST(@fromTime AS TIME), 
        CAST(@toTime AS TIME), 
        
        -- 🔥🔥 التعديل هنا: السيرفر هو اللي يحسب الفرق بالدقائق 🔥🔥
        DATEDIFF(MINUTE, CAST(@fromTime AS TIME), CAST(@toTime AS TIME)), 
        
        @reason, 'Pending', @createdAt
      )
    `);
    
  return result.recordset[0].PermissionID;
}

// 2. جلب تفاصيل إذن واحد (عشان نعرف نبعت إشعار لصاحبه)
async function getPermissionById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT p.*, e.FullName, u.UserID as RequesterUserID
      FROM ShortPermissions p
      JOIN Employees e ON p.EmployeeID = e.EmployeeID
      LEFT JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE p.PermissionID = @id
    `);
  return result.recordset[0];
}

// 3. عرض الأذونات (بفلاتر للمدير والموظف)
async function getPermissionsList(filters) {
  const pool = await connectDB();
  const request = pool.request();

  let query = `
    SELECT 
      p.PermissionID,
      FORMAT(p.PermissionDate, 'yyyy-MM-dd') as PermissionDate,
      p.PermissionType,
      p.Status,
      p.Reason,
      FORMAT(CAST(p.FromTime AS DATETIME), 'hh:mm tt') as FromTime,
      FORMAT(CAST(p.ToTime AS DATETIME), 'hh:mm tt') as ToTime,
      p.DurationMinutes,
      p.ManagerComment,
      FORMAT(p.CreatedAt, 'yyyy-MM-dd hh:mm tt') as RequestDate,
      e.FullName,
      e.Department,
      e.JobTitle
    FROM ShortPermissions p
    JOIN Employees e ON p.EmployeeID = e.EmployeeID
    WHERE 1=1
  `;

  // لو موظف (يشوف طلباته بس)
  if (filters.employeeId) {
    request.input('empId', sql.Int, filters.employeeId);
    query += ` AND p.EmployeeID = @empId`;
  }

  // لو مدير (فلتر بالحالة أو الاسم)
  if (filters.status) {
    request.input('status', sql.NVarChar(20), filters.status);
    query += ` AND p.Status = @status`;
  }
  
  if (filters.employeeName) {
    request.input('empName', sql.NVarChar(100), `%${filters.employeeName}%`);
    query += ` AND e.FullName LIKE @empName`;
  }

  query += ` ORDER BY p.PermissionDate DESC, p.CreatedAt DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// 4. تغيير الحالة (موافقة/رفض) + تحديث الحضور أوتوماتيك
async function updatePermissionStatus(data) {
  const pool = await connectDB();
  
  await pool.request()
    .input('id', sql.Int, data.permissionId)
    .input('status', sql.NVarChar(20), data.status)
    .input('comment', sql.NVarChar(255), data.comment || '')
    .input('userId', sql.Int, data.userId) // المدير اللي وافق
    .input('now', sql.DateTime, new Date())
    .query(`
      -- 1. تحديث حالة الإذن
      UPDATE ShortPermissions
      SET Status = @status,
          ManagerComment = @comment,
          ApprovedByUserID = @userId,
          ApprovalDate = @now
      WHERE PermissionID = @id;

      -- 2. لو تمت الموافقة، نحدث سجل الحضور
      IF @status = 'Approved'
      BEGIN
          DECLARE @Type NVARCHAR(50);
          DECLARE @Date DATE;
          DECLARE @EmpID INT;
          DECLARE @BioCode INT;

          SELECT @Type = PermissionType, @Date = PermissionDate, @EmpID = EmployeeID
          FROM ShortPermissions WHERE PermissionID = @id;

          SELECT @BioCode = BioEmployeeID FROM Employees WHERE EmployeeID = @EmpID;

          -- إذن تأخير -> صفر LateMinutes
          IF @Type = 'LateIn'
          BEGIN
              UPDATE Attendance 
              SET LateMinutes = 0, 
                  Status = N'حاضر (تأخير مقبول)'
              WHERE BiometricCode = @BioCode AND CAST(LogDate AS DATE) = @Date;
          END

          -- إذن انصراف -> صفر EarlyLeaveMinutes
          IF @Type = 'EarlyOut'
          BEGIN
              UPDATE Attendance 
              SET EarlyLeaveMinutes = 0,
                  Status = N'حاضر (انصراف مقبول)'
              WHERE BiometricCode = @BioCode AND CAST(LogDate AS DATE) = @Date;
          END
      END
    `);
}

module.exports = {
  createPermission,
  getPermissionById,
  getPermissionsList,
  updatePermissionStatus
};