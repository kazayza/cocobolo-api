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
// تسجيل حضور (ذكي: بيجيب المواعيد من جدول الشيفتات)
async function checkIn(bioCode, dateStr, timeStr) {
  const pool = await connectDB();

  await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('dateIn', sql.VarChar(10), dateStr) // تاريخ اليوم YYYY-MM-DD
    .input('timeIn', sql.VarChar(8), timeStr)  // وقت الحضور HH:MM:SS
    .query(`
      -- 1️⃣ متغيرات لتخزين ميعاد الشيفت
      DECLARE @ShiftStart TIME;
      DECLARE @LateMinutes INT = 0;

      -- 2️⃣ نجيب بداية شيفت الموظف الساري النهاردة
      -- بنربط جدول الموظفين بجدول الشيفتات باستخدام BioCode
      SELECT TOP 1 @ShiftStart = s.StartTime
      FROM EmployeeShifts s
      JOIN Employees e ON s.EmployeeID = e.EmployeeID
      WHERE e.BioEmployeeID = @bioCode
      -- التاريخ الحالي لازم يكون جوه فترة الشيفت (من EffectiveFrom لحد EffectiveTo)
      AND CAST(@dateIn AS DATE) >= CAST(s.EffectiveFrom AS DATE)
      AND (s.EffectiveTo IS NULL OR CAST(@dateIn AS DATE) <= CAST(s.EffectiveTo AS DATE))
      ORDER BY s.EffectiveFrom DESC;

      -- 3️⃣ حساب التأخير (لو لقينا شيفت)
      IF @ShiftStart IS NOT NULL
      BEGIN
        -- لو وقت الحضور أكبر من وقت بداية الشيفت
        IF CAST(@timeIn AS TIME) > @ShiftStart
        BEGIN
           -- نحسب الفرق بالدقائق
           SET @LateMinutes = DATEDIFF(MINUTE, @ShiftStart, CAST(@timeIn AS TIME));
           
           -- 💡 (اختياري) لو عايز تعمل سماحية 15 دقيقة مثلاً، شيل الـ Comment من السطرين دول:
           -- IF @LateMinutes <= 15 SET @LateMinutes = 0;
           -- ELSE SET @LateMinutes = @LateMinutes - 15;
        END
      END

      -- 4️⃣ التسجيل في جدول الحضور
      INSERT INTO Attendance (BiometricCode, LogDate, TimeIn, Status, LateMinutes)
      VALUES (
        @bioCode, 
        CAST(@dateIn AS DATE), 
        CAST(@timeIn AS TIME), 
        N'حاضر',
        @LateMinutes
      );
    `);
}

// تسجيل انصراف (Attendance)
// تسجيل انصراف
// تسجيل انصراف (ذكي: بيحسب الانصراف المبكر + ساعات العمل)
async function checkOut(attendanceId, timeStr) {
  const pool = await connectDB();

  await pool.request()
    .input('id', sql.Int, attendanceId)
    .input('timeOut', sql.VarChar(8), timeStr) // وقت الانصراف HH:MM:SS
    .query(`
      -- 1️⃣ متغيرات لتخزين ميعاد الانصراف الرسمي ووقت الحضور
      DECLARE @ShiftEnd TIME;
      DECLARE @EarlyLeaveMinutes INT = 0;
      DECLARE @TimeIn TIME;
      DECLARE @LogDate DATE;

      -- 2️⃣ نجيب تاريخ اليوم ووقت الحضور من السجل الحالي
      SELECT @TimeIn = TimeIn, @LogDate = LogDate 
      FROM Attendance 
      WHERE AttendanceID = @id;

      -- 3️⃣ نجيب ميعاد انتهاء شيفت الموظف الساري النهاردة
      -- بنربط جدول الموظفين بجدول الشيفتات باستخدام BioCode
      SELECT TOP 1 @ShiftEnd = s.EndTime
      FROM EmployeeShifts s
      JOIN Employees e ON s.EmployeeID = e.EmployeeID
      JOIN Attendance a ON a.BiometricCode = e.BioEmployeeID
      WHERE a.AttendanceID = @id
      AND CAST(@LogDate AS DATE) >= CAST(s.EffectiveFrom AS DATE)
      AND (s.EffectiveTo IS NULL OR CAST(@LogDate AS DATE) <= CAST(s.EffectiveTo AS DATE))
      ORDER BY s.EffectiveFrom DESC;

      -- 4️⃣ حساب الانصراف المبكر (لو لقينا شيفت)
      IF @ShiftEnd IS NOT NULL
      BEGIN
        -- لو وقت الانصراف أقل من وقت انتهاء الشيفت (يعني مشي بدري)
        IF CAST(@timeOut AS TIME) < @ShiftEnd
        BEGIN
           -- نحسب الفرق بالدقائق
           SET @EarlyLeaveMinutes = DATEDIFF(MINUTE, CAST(@timeOut AS TIME), @ShiftEnd);
        END
      END

      -- 5️⃣ تحديث سجل الحضور (انصراف + ساعات عمل + انصراف مبكر)
      UPDATE Attendance 
      SET TimeOut = CAST(@timeOut AS TIME),
          TotalHours = DATEDIFF(MINUTE, TimeIn, CAST(@timeOut AS TIME)) / 60.0,
          EarlyLeaveMinutes = @EarlyLeaveMinutes,
          Status = N'حاضر' -- بنأكد الحالة
      WHERE AttendanceID = @id;
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

// جلب الفروع النشطة
async function getActiveLocations() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT LocationID, LocationName, Latitude, Longitude, AllowedRadius 
    FROM CompanyLocations 
    WHERE IsActive = 1
  `);
  return result.recordset;
}

// ✅ دالة جديدة: جلب إحصائيات الموظف (أيام الحضور، التأخير، ساعات اليوم)
async function getEmployeeStatistics(userId) {
  const pool = await connectDB();

  // 1. نجيب كود البصمة الخاص بالموظف
  const bioResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT e.BioEmployeeID 
      FROM Employees e
      JOIN Users u ON e.EmployeeID = u.employeeID
      WHERE u.UserID = @userId
    `);

  const bioCode = bioResult.recordset[0]?.BioEmployeeID;

  // لو مفيش كود بصمة، نرجع أصفار
  if (!bioCode) {
    return { daysThisMonth: 0, lateMinutes: 0, hoursToday: 0 };
  }

  // 2. نحسب الإحصائيات
  const statsResult = await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .query(`
      SELECT 
        -- عدد أيام الحضور في الشهر الحالي
        (SELECT COUNT(*) FROM Attendance 
         WHERE BiometricCode = @bioCode 
         AND MONTH(LogDate) = MONTH(GETDATE()) 
         AND YEAR(LogDate) = YEAR(GETDATE())
         AND Status = N'حاضر') as DaysThisMonth,

        -- دقائق التأخير اليوم (لو موجودة)
        (SELECT TOP 1 ISNULL(LateMinutes, 0)
         FROM Attendance
         WHERE BiometricCode = @bioCode 
         AND CAST(LogDate AS DATE) = CAST(SWITCHOFFSET(SYSDATETIMEOFFSET(), '+02:00') AS DATE)
        ) as TodayLate,

        -- ساعات العمل اليوم (سواء خلص ولا لسه شغال)
        (SELECT TOP 1 
            CASE 
                WHEN TimeOut IS NOT NULL THEN TotalHours
                ELSE DATEDIFF(MINUTE, TimeIn, CAST(SWITCHOFFSET(SYSDATETIMEOFFSET(), '+02:00') AS TIME)) / 60.0
            END
         FROM Attendance
         WHERE BiometricCode = @bioCode 
         AND CAST(LogDate AS DATE) = CAST(SWITCHOFFSET(SYSDATETIMEOFFSET(), '+02:00') AS DATE)
        ) as TodayHours
    `);

  const data = statsResult.recordset[0];

  return {
    daysThisMonth: data.DaysThisMonth || 0,
    lateMinutes: data.TodayLate || 0,
    hoursToday: data.TodayHours || 0.0
  };
}

// ✅ دالة تقرير الحضور المتقدم (للمدير والموظف)
async function getAdvancedReport(filters) {
  const pool = await connectDB();
  const request = pool.request(); // بنعمل ريكويست فاضي عشان نضيف عليه المدخلات

  let query = `
    SELECT 
      a.AttendanceID,
      -- تنسيق التاريخ والوقت عشان يظهروا مظبوط في الموبايل
      FORMAT(a.LogDate, 'yyyy-MM-dd') as LogDate,
      FORMAT(CAST(a.TimeIn AS DATETIME), 'hh:mm tt') as TimeIn,
      FORMAT(CAST(a.TimeOut AS DATETIME), 'hh:mm tt') as TimeOut,
      
      a.Status,
      ISNULL(a.LateMinutes, 0) as LateMinutes,
      ISNULL(a.EarlyLeaveMinutes, 0) as EarlyLeaveMinutes,
      ISNULL(a.TotalHours, 0) as TotalHours,
      
      -- بيانات الموظف (عشان لو مدير بيعرض الكل)
      e.FullName,
      e.Department,
      e.JobTitle
    FROM Attendance a
    JOIN Employees e ON a.BiometricCode = e.BioEmployeeID
    WHERE 1=1
  `;

  // 1️⃣ فلتر التاريخ (من - إلى)
  if (filters.startDate && filters.endDate) {
    request.input('startDate', sql.Date, filters.startDate);
    request.input('endDate', sql.Date, filters.endDate);
    query += ` AND CAST(a.LogDate AS DATE) BETWEEN @startDate AND @endDate`;
  }

  // 2️⃣ فلتر البحث بالاسم (للمدير)
  if (filters.employeeName) {
    request.input('empName', sql.NVarChar(100), `%${filters.employeeName}%`); // % للبحث الجزئي
    query += ` AND e.FullName LIKE @empName`;
  }

  // 3️⃣ فلتر الموظف المحدد (لو موظف عادي، بنجيب بياناته هو بس)
  if (filters.biometricCode) {
    request.input('bioCode', sql.Int, filters.biometricCode);
    query += ` AND a.BiometricCode = @bioCode`;
  }

  // الترتيب: الأحدث أولاً، ثم أبجدياً بالاسم
  query += ` ORDER BY a.LogDate DESC, e.FullName ASC`;

  const result = await request.query(query);
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
  getCalendar,
  getEmployeeNameByUserId,
  getAllExemptions,
  deleteExemption,
  getActiveLocations,
  getEmployeeStatistics,
  getAdvancedReport
};