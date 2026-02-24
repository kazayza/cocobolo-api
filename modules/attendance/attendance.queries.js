const { sql, connectDB } = require('../../core/database');

// تسجيل بصمة خام (BiometricLog)
async function logBiometric(bioCode, date, time) {
  const pool = await connectDB();
  await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('logDate', sql.DateTime, date)
    .input('logTime', sql.Time, time)
    .query(`
      INSERT INTO BiometricLog (BiometricCode, LogDate, LogTime)
      VALUES (@bioCode, @logDate, @logTime)
    `);
}

// التحقق من وجود سجل حضور لليوم
async function getTodayAttendance(bioCode) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .query(`
      SELECT TOP 1 * FROM Attendance 
      WHERE BiometricCode = @bioCode 
      AND CAST(LogDate AS DATE) = CAST(GETDATE() AS DATE)
      ORDER BY AttendanceID DESC
    `);
  return result.recordset[0];
}

// تسجيل حضور (Attendance)
async function checkIn(bioCode, time) {
  const pool = await connectDB();
  await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('timeIn', sql.Time, time)
    .query(`
      INSERT INTO Attendance (BiometricCode, LogDate, TimeIn, Status)
      VALUES (@bioCode, GETDATE(), @timeIn, N'حاضر')
    `);
}

// تسجيل انصراف (Attendance)
async function checkOut(attendanceId, timeOut) {
  const pool = await connectDB();
  
  await pool.request()
    .input('id', sql.Int, attendanceId)
    .input('timeOut', sql.Time, timeOut)
    .query(`
      UPDATE Attendance 
      SET TimeOut = @timeOut,
          TotalHours = DATEDIFF(MINUTE, TimeIn, @timeOut) / 60.0
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
  getCalendar
};