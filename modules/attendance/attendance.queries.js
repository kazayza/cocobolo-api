const { sql, connectDB } = require('../../core/database');

// تسجيل بصمة خام (BiometricLog)
// تسجيل بصمة خام
async function logBiometric(bioCode, dateStr, timeStr) {
  const pool = await connectDB();
  await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('logDate', sql.VarChar(10), dateStr) // ✅ نستقبل كنص YYYY-MM-DD
    .input('logTime', sql.VarChar(8), timeStr)  // ✅ نستقبل كنص HH:MM:SS
    .query(`
      INSERT INTO BiometricLog (BiometricCode, LogDate, LogTime)
      VALUES (@bioCode, CAST(@logDate AS DATE), CAST(@logTime AS TIME))
    `);
}

// التحقق من وجود سجل حضور لليوم
// التحقق من وجود سجل حضور لليوم (بتوقيت مصر)
async function getTodayAttendance(bioCode) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .query(`
      SELECT TOP 1 * FROM Attendance 
      WHERE BiometricCode = @bioCode 
      -- ✅ تحويل وقت السيرفر لتوقيت مصر (+02:00) ومقارنة التاريخ فقط
      AND CAST(SWITCHOFFSET(SYSDATETIMEOFFSET(), '+02:00') AS DATE) = CAST(LogDate AS DATE)
      ORDER BY AttendanceID DESC
    `);
  return result.recordset[0];
}

// تسجيل حضور (Attendance)
// تسجيل حضور
async function checkIn(bioCode, dateStr, timeStr) {
  const pool = await connectDB();
  await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('dateIn', sql.VarChar(10), dateStr) // ✅
    .input('timeIn', sql.VarChar(8), timeStr)  // ✅
    .query(`
      INSERT INTO Attendance (BiometricCode, LogDate, TimeIn, Status)
      VALUES (@bioCode, CAST(@dateIn AS DATE), CAST(@timeIn AS TIME), N'حاضر')
    `);
}

// تسجيل انصراف (Attendance)
// تسجيل انصراف
async function checkOut(attendanceId, timeStr) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, attendanceId)
    .input('timeOut', sql.VarChar(8), timeStr) // ✅
    .query(`
      UPDATE Attendance 
      SET TimeOut = CAST(@timeOut AS TIME),
          TotalHours = DATEDIFF(MINUTE, TimeIn, CAST(@timeOut AS TIME)) / 60.0
      WHERE AttendanceID = @id
    `);
}

// جلب كود البصمة للموظف عن طريق UserID
async function getBioCodeByUserId(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT e.BioEmployeeID 
      FROM Employees e
      JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE u.UserID = @userId
    `);
  return result.recordset[0]?.BioEmployeeID;
}

// --- الدوال القديمة (للتقارير) ---

async function getAttendanceByEmployee(biometricCode, startDate, endDate) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('biometricCode', sql.Int, biometricCode)
    .input('startDate', sql.Date, startDate)
    .input('endDate', sql.Date, endDate)
    .query(`
      SELECT 
        a.AttendanceID, a.BiometricCode, a.LogDate,
        a.TimeIn, a.TimeOut, a.Status, a.TotalHours,
        a.LateMinutes, a.EarlyLeaveMinutes, a.PenaltyHours,
        e.FullName AS EmployeeName
      FROM Attendance a
      LEFT JOIN Employees e ON a.BiometricCode = e.BioEmployeeID
      WHERE a.BiometricCode = @biometricCode
        AND CAST(a.LogDate AS DATE) >= @startDate
        AND CAST(a.LogDate AS DATE) <= @endDate
      ORDER BY a.LogDate DESC
    `);
  return result.recordset;
}

async function getAttendanceByDate(date) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('date', sql.Date, date)
    .query(`
      SELECT 
        a.AttendanceID, a.BiometricCode, a.LogDate,
        a.TimeIn, a.TimeOut, a.Status, a.TotalHours,
        a.LateMinutes, a.EarlyLeaveMinutes, a.PenaltyHours,
        e.FullName AS EmployeeName, e.Department
      FROM Attendance a
      LEFT JOIN Employees e ON a.BiometricCode = e.BioEmployeeID
      WHERE CAST(a.LogDate AS DATE) = @date
      ORDER BY e.FullName
    `);
  return result.recordset;
}

async function getMonthlyAttendanceSummary(year, month) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('year', sql.Int, year)
    .input('month', sql.Int, month)
    .query(`
      SELECT 
        e.EmployeeID, e.FullName, e.Department, e.BioEmployeeID,
        COUNT(CASE WHEN a.Status = N'حاضر' THEN 1 END) as PresentDays,
        COUNT(CASE WHEN a.Status = N'غائب' THEN 1 END) as AbsentDays,
        COUNT(CASE WHEN a.Status = N'إجازة' THEN 1 END) as LeaveDays,
        SUM(ISNULL(a.LateMinutes, 0)) as TotalLateMinutes,
        SUM(ISNULL(a.TotalHours, 0)) as TotalWorkHours
      FROM Employees e
      LEFT JOIN Attendance a ON e.BioEmployeeID = a.BiometricCode
        AND YEAR(a.LogDate) = @year
        AND MONTH(a.LogDate) = @month
      WHERE e.Status = N'نشط'
      GROUP BY e.EmployeeID, e.FullName, e.Department, e.BioEmployeeID
      ORDER BY e.FullName
    `);
  return result.recordset;
}

async function getBiometricLogs(biometricCode, date) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('biometricCode', sql.Int, biometricCode)
    .input('date', sql.Date, date)
    .query(`
      SELECT BiometricLogID, BiometricCode, LogDate, LogTime
      FROM BiometricLog
      WHERE BiometricCode = @biometricCode
        AND CAST(LogDate AS DATE) = @date
      ORDER BY LogTime
    `);
  return result.recordset;
}

async function getDailyExemptions(biometricCode, startDate, endDate) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('biometricCode', sql.Int, biometricCode)
    .input('startDate', sql.Date, startDate)
    .input('endDate', sql.Date, endDate)
    .query(`
      SELECT 
        ExemptionID, BioEmployeeID, ExemptionDate,
        ReasonCode, Description, ApprovedBy, CreatedDate
      FROM DailyExemptions
      WHERE BioEmployeeID = @biometricCode
        AND CAST(ExemptionDate AS DATE) >= @startDate
        AND CAST(ExemptionDate AS DATE) <= @endDate
      ORDER BY ExemptionDate DESC
    `);
  return result.recordset;
}

async function createExemption(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('bioEmployeeId', sql.Int, data.bioEmployeeId)
    .input('exemptionDate', sql.DateTime, data.exemptionDate)
    .input('reasonCode', sql.VarChar(20), data.reasonCode)
    .input('description', sql.Text, data.description || null)
    .input('approvedBy', sql.VarChar(100), data.approvedBy)
    .query(`
      INSERT INTO DailyExemptions (
        BioEmployeeID, ExemptionDate, ReasonCode,
        Description, ApprovedBy, CreatedDate
      )
      OUTPUT INSERTED.ExemptionID
      VALUES (
        @bioEmployeeId, @exemptionDate, @reasonCode,
        @description, @approvedBy, GETDATE()
      )
    `);
  return result.recordset[0].ExemptionID;
}

async function getCalendar(year, month) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('year', sql.Int, year)
    .input('month', sql.Int, month)
    .query(`
      SELECT CalendarDate, DayOfWeek, DayName, IsWeekend, IsHoliday
      FROM Calendar
      WHERE YEAR(CalendarDate) = @year AND MONTH(CalendarDate) = @month
      ORDER BY CalendarDate
    `);
  return result.recordset;
}

// جلب اسم الموظف عن طريق UserID
async function getEmployeeNameByUserId(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT e.FullName 
      FROM Employees e
      JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE u.UserID = @userId
    `);
  return result.recordset[0]?.FullName || 'موظف';
}

// جلب الاستثناءات (بفلاتر)
async function getAllExemptions(filters = {}) {
  const pool = await connectDB();
  let query = `
    SELECT 
      x.ExemptionID, x.ExemptionDate, x.ReasonCode, x.Description,
      e.FullName as EmployeeName, e.Department
    FROM DailyExemptions x
    JOIN Employees e ON x.BioEmployeeID = e.BioEmployeeID
    WHERE 1=1
  `;

  if (filters.date) {
    query += ` AND CAST(x.ExemptionDate AS DATE) = '${filters.date}'`;
  }
  
  if (filters.employeeName) {
    query += ` AND e.FullName LIKE N'%${filters.employeeName}%'`;
  }

  query += ` ORDER BY x.ExemptionDate DESC`;

  const result = await pool.request().query(query);
  return result.recordset;
}

// حذف استثناء
async function deleteExemption(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM DailyExemptions WHERE ExemptionID = @id');
  return true;
}


module.exports = {
  logBiometric,
  getTodayAttendance,
  checkIn,
  checkOut,
  getBioCodeByUserId,
  getAttendanceByEmployee,
  getAttendanceByDate,
  getMonthlyAttendanceSummary,
  getBiometricLogs,
  getDailyExemptions,
  createExemption,
  getCalendar,
  getEmployeeNameByUserId,
  getAllExemptions,
  deleteExemption 
};