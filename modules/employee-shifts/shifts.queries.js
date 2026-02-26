const { sql, connectDB } = require('../../core/database');

// جلب شيفتات موظف
async function getShiftsByEmployee(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT 
        EmployeeShiftID, ShiftType, 
        FORMAT(StartTime, 'hh:mm tt') as StartTime, 
        FORMAT(EndTime, 'hh:mm tt') as EndTime,
        EffectiveFrom, EffectiveTo, CreatedAt
      FROM EmployeeShifts
      WHERE EmployeeID = @employeeId
      ORDER BY EffectiveFrom DESC
    `);
  return result.recordset;
}

// جلب الشيفت الحالي الساري لموظف
async function getCurrentShift(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT TOP 1 *
      FROM EmployeeShifts
      WHERE EmployeeID = @employeeId
      AND CAST(GETDATE() AS DATE) >= CAST(EffectiveFrom AS DATE)
      AND (EffectiveTo IS NULL OR CAST(GETDATE() AS DATE) <= CAST(EffectiveTo AS DATE))
      ORDER BY EffectiveFrom DESC
    `);
  return result.recordset[0];
}


// إضافة شيفت جديد
async function createShift(data) {
  const pool = await connectDB();
  
  // 1. إنهاء أي شيفت ساري
  await pool.request()
    .input('employeeId', sql.Int, data.employeeId)
    .input('newStartDate', sql.DateTime, data.effectiveFrom)
    .query(`
      UPDATE EmployeeShifts
      SET EffectiveTo = DATEADD(DAY, -1, @newStartDate)
      WHERE EmployeeID = @employeeId
      AND (EffectiveTo IS NULL OR EffectiveTo >= @newStartDate)
    `);

  // 2. إضافة الشيفت الجديد + كود البصمة
  const result = await pool.request()
    .input('employeeId', sql.Int, data.employeeId)
    .input('shiftType', sql.VarChar(20), data.shiftType)
    .input('startTime', sql.VarChar(8), data.startTime)
    .input('endTime', sql.VarChar(8), data.endTime)
    .input('effectiveFrom', sql.DateTime, data.effectiveFrom)
    .input('effectiveTo', sql.DateTime, data.effectiveTo || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .input('createdAt', sql.DateTime, data.createdAt)
    .query(`
      -- ✅ أولاً: نجيب كود البصمة
      DECLARE @BioCode INT;
      SELECT @BioCode = BioEmployeeID FROM Employees WHERE EmployeeID = @employeeId;

      -- ✅ ثانياً: نسجل الشيفت مع الكود
      INSERT INTO EmployeeShifts (
        EmployeeID, BiometricCode, ShiftType, StartTime, EndTime, 
        EffectiveFrom, EffectiveTo, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.EmployeeShiftID
      VALUES (
        @employeeId, @BioCode, @shiftType, 
        CAST(@startTime AS TIME), CAST(@endTime AS TIME),
        @effectiveFrom, @effectiveTo, @createdBy, @createdAt
      )
    `);
    
  return result.recordset[0].EmployeeShiftID;
}

// حذف شيفت (لو أضيف بالخطأ)
async function deleteShift(shiftId) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, shiftId)
    .query('DELETE FROM EmployeeShifts WHERE EmployeeShiftID = @id');
  return true;
}

// جلب الموظفين (النشطين وغير المعفيين) مع شيفتاتهم الحالية
// ✅ التعديل هنا: استخدام FORMAT لتحويل الوقت لنص
async function getEmployeesWithCurrentShift() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT 
      e.EmployeeID, e.FullName, e.JobTitle, e.Department,
      s.EmployeeShiftID, s.ShiftType, 
      
      -- تنسيق الوقت والتاريخ
      FORMAT(CAST(s.StartTime AS DATETIME), 'hh:mm tt') as StartTime,
      FORMAT(CAST(s.EndTime AS DATETIME), 'hh:mm tt') as EndTime,
      FORMAT(s.EffectiveFrom, 'yyyy-MM-dd') as StartDate -- ✅ الحقل الجديد
      
    FROM Employees e
    LEFT JOIN EmployeeShifts s ON e.EmployeeID = s.EmployeeID 
      AND CAST(GETDATE() AS DATE) >= CAST(s.EffectiveFrom AS DATE)
      AND (s.EffectiveTo IS NULL OR CAST(GETDATE() AS DATE) <= CAST(s.EffectiveTo AS DATE))
    WHERE e.Status = N'نشط' 
    AND (e.IsPermanentlyExempt = 0 OR e.IsPermanentlyExempt IS NULL)
    ORDER BY e.FullName
  `);
  return result.recordset;
}

async function searchShifts(filters) {
  const pool = await connectDB();
  const request = pool.request();
  
  let query = `
    SELECT 
      s.EmployeeShiftID, s.ShiftType,
      FORMAT(CAST(s.StartTime AS DATETIME), 'hh:mm tt') as StartTime,
      FORMAT(CAST(s.EndTime AS DATETIME), 'hh:mm tt') as EndTime,
      FORMAT(s.EffectiveFrom, 'yyyy-MM-dd') as StartDate,
      FORMAT(s.EffectiveTo, 'yyyy-MM-dd') as EndDate,
      e.FullName, e.Department, e.JobTitle
    FROM EmployeeShifts s
    JOIN Employees e ON s.EmployeeID = e.EmployeeID
    WHERE 1=1
  `;

  // فلترة بالتاريخ (الشيفت الساري في الفترة دي)
  if (filters.fromDate && filters.toDate) {
    request.input('fromDate', sql.Date, filters.fromDate);
    request.input('toDate', sql.Date, filters.toDate);
    // شرط التداخل الزمني (Overlap)
    query += ` AND (
      s.EffectiveFrom <= @toDate 
      AND (s.EffectiveTo IS NULL OR s.EffectiveTo >= @fromDate)
    )`;
  }

  // فلترة بنوع الشيفت
  if (filters.shiftType && filters.shiftType !== 'الكل') {
    request.input('shiftType', sql.VarChar(20), filters.shiftType);
    query += ` AND s.ShiftType = @shiftType`;
  }

  // فلترة باسم الموظف
  if (filters.employeeName) {
    request.input('empName', sql.NVarChar(100), `%${filters.employeeName}%`);
    query += ` AND e.FullName LIKE @empName`;
  }

  query += ` ORDER BY s.EffectiveFrom DESC, e.FullName`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب جدول الموظف (شيفتات + حضور) لشهر معين
async function getMySchedule(userId, year, month) {
  const pool = await connectDB();
  
  // 1. الشيفتات السارية في هذا الشهر
  const shiftsResult = await pool.request()
    .input('userId', sql.Int, userId)
    .input('year', sql.Int, year)
    .input('month', sql.Int, month)
    .query(`
      SELECT 
        s.ShiftType,
        FORMAT(CAST(s.StartTime AS DATETIME), 'hh:mm tt') as StartTime,
        FORMAT(CAST(s.EndTime AS DATETIME), 'hh:mm tt') as EndTime,
        FORMAT(s.EffectiveFrom, 'yyyy-MM-dd') as StartDate,
        FORMAT(s.EffectiveTo, 'yyyy-MM-dd') as EndDate
      FROM EmployeeShifts s
      JOIN Employees e ON s.EmployeeID = e.EmployeeID
      JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE u.UserID = @userId
      AND (
        YEAR(s.EffectiveFrom) <= @year AND 
        (s.EffectiveTo IS NULL OR YEAR(s.EffectiveTo) >= @year)
      )
    `);

  // 2. الحضور الفعلي في هذا الشهر
  const attendanceResult = await pool.request()
    .input('userId', sql.Int, userId)
    .input('year', sql.Int, year)
    .input('month', sql.Int, month)
    .query(`
      SELECT 
        FORMAT(a.LogDate, 'yyyy-MM-dd') as LogDate,
        FORMAT(CAST(a.TimeIn AS DATETIME), 'hh:mm tt') as CheckIn,
        FORMAT(CAST(a.TimeOut AS DATETIME), 'hh:mm tt') as CheckOut,
        a.Status,
        a.LateMinutes,
        a.EarlyLeaveMinutes
      FROM Attendance a
      JOIN Employees e ON a.BiometricCode = e.BioEmployeeID
      JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE u.UserID = @userId
      AND YEAR(a.LogDate) = @year AND MONTH(a.LogDate) = @month
    `);

  return {
    shifts: shiftsResult.recordset,
    attendance: attendanceResult.recordset
  };
}



module.exports = {
  getShiftsByEmployee,
  getCurrentShift,
  createShift,
  deleteShift,
  getEmployeesWithCurrentShift,
  searchShifts,
  getMySchedule
};