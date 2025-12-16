const { sql, connectDB } = require('../../core/database');

// جلب سجل الحضور لموظف معين
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

// جلب سجل الحضور لكل الموظفين في تاريخ معين
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

// جلب ملخص الحضور الشهري
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

// جلب سجلات البصمة الخام
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

// جلب الإعفاءات اليومية
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

// إضافة إعفاء يومي
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

// جلب التقويم (الإجازات الرسمية)
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

// تصدير الدوال
module.exports = {
  getAttendanceByEmployee,
  getAttendanceByDate,
  getMonthlyAttendanceSummary,
  getBiometricLogs,
  getDailyExemptions,
  createExemption,
  getCalendar
};