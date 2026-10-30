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

// تصنيف سبب الإعفاء بالكلمات المفتاحية — مرآة ExemptionReasonCodes
// (DTOS/AttendanceDtos.cs:51-104): مأمورية وانصراف مبكر بلا خصم افتراضيًا،
// وما عداهما (إذن) يُخصم افتراضيًا.
function classifyExemptionReason(reasonCode) {
  const text = String(reasonCode || '').trim();
  const isErrand = text.includes('مأمورية') || text.includes('مهمة رسمية')
    || text.includes('مهمة') || text.includes('عمل');
  const isEarlyLeave = text.includes('انصراف مبكر') || text.includes('خروج مبكر');
  const isPermission = text.includes('إذن') || text.includes('اذن');
  return { isErrand, isEarlyLeave, isPermission };
}

function defaultIsDeducted(reasonCode) {
  const { isErrand, isEarlyLeave } = classifyExemptionReason(reasonCode);
  if (isErrand) return false;
  if (isEarlyLeave) return false;
  return true;
}

// حالة الإعفاء مع التوافق للصفوف القديمة — مرآة
// ExemptionStatus.InferStatus (DTOS/AttendanceDtos.cs:179-185)
function inferExemptionStatus(row) {
  const status = row?.Status;
  if (status && String(status).trim() !== '' && status !== 'Approved') return status;
  return row?.ApprovedBy ? 'Approved' : 'Pending';
}

// إنشاء إعفاء — الحالة والمعتمِد يقررهما المتحكم من دور التوكن؛
// أي approvedBy وارد من العميل يُتجاهل تمامًا (كان اعتمادًا ذاتيًا).
async function createExemption(data) {
  const pool = await connectDB();
  const isDeducted = data.isDeducted != null ? data.isDeducted : defaultIsDeducted(data.reasonCode);
  const isFullDay = data.isFullDay !== false;
  const result = await pool.request()
    .input('bioEmployeeId', sql.Int, data.bioEmployeeId)
    .input('employeeId', sql.Int, data.employeeId || null)
    .input('exemptionDate', sql.DateTime, data.exemptionDate)
    .input('reasonCode', sql.NVarChar(100), data.reasonCode)
    .input('description', sql.NVarChar(sql.MAX), data.description || null)
    .input('isFullDay', sql.Bit, isFullDay)
    .input('hours', sql.Decimal(5, 2), isFullDay ? null : (data.hours || null))
    .input('isDeducted', sql.Bit, isDeducted)
    .input('notes', sql.NVarChar(500), data.notes || null)
    .input('createdBy', sql.NVarChar(100), data.createdBy || null)
    .input('status', sql.NVarChar(20), data.status)
    .input('approvedBy', sql.NVarChar(100), data.approvedBy || null)
    .query(`
      INSERT INTO DailyExemptions (
        BioEmployeeID, EmployeeID, ExemptionDate, ReasonCode,
        Description, IsFullDay, Hours, IsDeducted, Notes,
        CreatedBy, Status, ApprovedBy, CreatedDate
      )
      OUTPUT INSERTED.ExemptionID
      VALUES (
        @bioEmployeeId, @employeeId, @exemptionDate, @reasonCode,
        @description, @isFullDay, @hours, @isDeducted, @notes,
        @createdBy, @status, @approvedBy, GETDATE()
      )
    `);
  const exemptionId = result.recordset[0].ExemptionID;
  return {
    exemptionId,
    exemption: {
      ExemptionID: exemptionId,
      BioEmployeeID: data.bioEmployeeId,
      ExemptionDate: data.exemptionDate,
      ReasonCode: data.reasonCode,
      IsDeducted: isDeducted,
      Status: data.status,
    },
  };
}

async function getExemptionById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT ExemptionID, BioEmployeeID, EmployeeID, ExemptionDate, ReasonCode,
             Description, IsFullDay, Hours, IsDeducted, Notes, CreatedBy,
             Status, ApprovedBy, CreatedDate
      FROM DailyExemptions
      WHERE ExemptionID = @id
    `);
  return result.recordset[0] || null;
}

// قرار اعتماد/رفض — الرفض يلحق سببه بالملاحظات كما في
// RejectExemptionAsync:2215 (تُحفظ داخل Notes بصيغة [سبب الرفض: ...])
async function setExemptionDecision(id, { status, approvedBy, rejectionReason = null }) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('status', sql.NVarChar(20), status)
    .input('approvedBy', sql.NVarChar(100), approvedBy)
    .input('rejectionReason', sql.NVarChar(500), rejectionReason || null)
    .query(`
      UPDATE DailyExemptions
      SET Status = @status,
          ApprovedBy = @approvedBy,
          Notes = CASE
            WHEN @rejectionReason IS NULL THEN Notes
            WHEN Notes IS NULL OR LTRIM(RTRIM(Notes)) = '' THEN N'[سبب الرفض: ' + @rejectionReason + N']'
            ELSE Notes + N' [سبب الرفض: ' + @rejectionReason + N']'
          END
      WHERE ExemptionID = @id
    `);
  return true;
}

// الانعكاس على الحضور — نسخة موثقة مبسطة من
// CreateOrUpdateExemptionAttendanceAsync (AttendanceService.cs:2295):
// التصنيف بالكلمات المفتاحية (مأمورية/إذن/انصراف مبكر)، وأوقات الوردية
// السارية أو الافتراضي 08:00–17:00. سجل بصمة قائم بوقت دخول يُعدَّل
// في حالته فقط؛ وما عداه يُبنى سجل الإعفاء كاملًا.
async function applyExemptionAttendance(exemption) {
  const pool = await connectDB();
  const bioCode = exemption.BioEmployeeID;
  const date = exemption.ExemptionDate;
  const { isErrand, isEarlyLeave, isPermission } = classifyExemptionReason(exemption.ReasonCode);
  const isDeducted = exemption.IsDeducted !== false && exemption.IsDeducted !== 0;

  const status = isErrand ? 'مأمورية'
    : isEarlyLeave ? 'خروج مبكر'
    : 'إذن';
  // إذن مخصوم = بلا أوقات حضور؛ وما عداه بأوقات الوردية كاملة
  const withTimes = isErrand || isEarlyLeave || (isPermission && !isDeducted) || !isPermission;

  await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('logDate', sql.Date, date)
    .input('status', sql.NVarChar(50), status)
    .input('withTimes', sql.Bit, withTimes)
    .query(`
      DECLARE @ShiftStart TIME = '08:00';
      DECLARE @ShiftEnd TIME = '17:00';

      SELECT TOP 1 @ShiftStart = s.StartTime, @ShiftEnd = s.EndTime
      FROM EmployeeShifts s
      JOIN Employees e ON s.EmployeeID = e.EmployeeID
      WHERE e.BioEmployeeID = @bioCode
        AND CAST(@logDate AS DATE) >= CAST(s.EffectiveFrom AS DATE)
        AND (s.EffectiveTo IS NULL OR CAST(@logDate AS DATE) <= CAST(s.EffectiveTo AS DATE))
      ORDER BY s.EffectiveFrom DESC;

      IF EXISTS (SELECT 1 FROM Attendance WHERE BiometricCode = @bioCode AND CAST(LogDate AS DATE) = CAST(@logDate AS DATE))
      BEGIN
        UPDATE Attendance
        SET Status = CASE
              WHEN TimeIn IS NOT NULL AND @status = N'إذن' AND @withTimes = 1 THEN N'حاضر'
              ELSE @status
            END,
            LateMinutes = CASE WHEN TimeIn IS NOT NULL THEN LateMinutes ELSE 0 END,
            EarlyLeaveMinutes = CASE WHEN @status = N'خروج مبكر' THEN 0 ELSE EarlyLeaveMinutes END,
            PenaltyHours = CASE WHEN TimeIn IS NULL THEN 0 ELSE PenaltyHours END,
            TimeIn = CASE WHEN TimeIn IS NULL AND @withTimes = 1 THEN @ShiftStart ELSE TimeIn END,
            TimeOut = CASE WHEN TimeIn IS NULL AND @withTimes = 1 THEN @ShiftEnd ELSE TimeOut END,
            TotalHours = CASE WHEN TimeIn IS NULL AND @withTimes = 1
              THEN DATEDIFF(MINUTE, @ShiftStart, @ShiftEnd) / 60.0 ELSE TotalHours END
        WHERE BiometricCode = @bioCode AND CAST(LogDate AS DATE) = CAST(@logDate AS DATE);
      END
      ELSE
      BEGIN
        INSERT INTO Attendance (BiometricCode, LogDate, TimeIn, TimeOut, Status, LateMinutes, EarlyLeaveMinutes, PenaltyHours, TotalHours)
        VALUES (
          @bioCode, CAST(@logDate AS DATE),
          CASE WHEN @withTimes = 1 THEN @ShiftStart ELSE NULL END,
          CASE WHEN @withTimes = 1 THEN @ShiftEnd ELSE NULL END,
          @status, 0, 0, 0,
          CASE WHEN @withTimes = 1 THEN DATEDIFF(MINUTE, @ShiftStart, @ShiftEnd) / 60.0 ELSE NULL END
        );
      END
    `);
  return true;
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
// Phase 0 (حرج-4): الفلاتر كانت تُدمج نصيًا في الاستعلام (حقن SQL) — الآن معاملات مربوطة.
async function getAllExemptions(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT
      x.ExemptionID, x.ExemptionDate, x.ReasonCode, x.Description,
      x.Status, x.ApprovedBy, x.CreatedBy, x.Notes, x.IsFullDay, x.Hours, x.IsDeducted,
      e.FullName as EmployeeName, e.Department
    FROM DailyExemptions x
    JOIN Employees e ON x.BioEmployeeID = e.BioEmployeeID
    WHERE 1=1
  `;

  if (filters.date) {
    request.input('exemptionDate', sql.Date, filters.date);
    query += ` AND CAST(x.ExemptionDate AS DATE) = @exemptionDate`;
  }

  if (filters.employeeName) {
    request.input('employeeName', sql.NVarChar(200), `%${String(filters.employeeName).trim()}%`);
    query += ` AND e.FullName LIKE @employeeName`;
  }

  query += ` ORDER BY x.ExemptionDate DESC`;

  const result = await request.query(query);
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

// ══════════════════════════════════════════════════════════════
// الحضور اليدوي للمعفيين من البصمة — مرآة PayrollService:
// GetManualAttendanceAsync:1394 (المعفي الدائم يظهر دائمًا؛ وغياب
// السجل = 26 يوم حضور + ملاحظة «معفى من البصمة») و
// SaveManualAttendanceAsync:1457 (إدراج أو تحديث بمفتاح الموظف+الشهر).
// مفتاح الموظف في الاستجابة EmployeeID موحّدًا بين الخادم والتطبيق.
// ══════════════════════════════════════════════════════════════
async function getManualAttendance(month) {
  const pool = await connectDB();
  const employeesRes = await pool.request().query(`
    SELECT EmployeeID, FullName, Department
    FROM Employees
    WHERE (Status = N'نشط' OR Status = 'Active') AND IsPermanentlyExempt = 1
    ORDER BY Department, FullName
  `);
  const employees = employeesRes.recordset;
  if (employees.length === 0) return [];

  const existingRes = await pool.request()
    .input('month', sql.NVarChar(10), month)
    .query(`
      SELECT ManualID AS ManualId, EmployeeID AS EmployeeId, AttendanceMonth, PresentDays, AbsenceDays, LateMinutes, Notes
      FROM AttendanceManual
      WHERE AttendanceMonth = @month
    `);
  const existing = new Map(existingRes.recordset.map((r) => [r.EmployeeId, r]));

  return employees.map((emp) => {
    const rec = existing.get(emp.EmployeeID);
    if (rec) {
      return {
        ManualID: rec.ManualId,
        EmployeeID: emp.EmployeeID,
        EmployeeName: emp.FullName,
        Department: emp.Department,
        AttendanceMonth: month,
        PresentDays: rec.PresentDays,
        AbsenceDays: rec.AbsenceDays,
        LateMinutes: rec.LateMinutes,
        Notes: rec.Notes,
      };
    }
    return {
      ManualID: 0,
      EmployeeID: emp.EmployeeID,
      EmployeeName: emp.FullName,
      Department: emp.Department,
      AttendanceMonth: month,
      PresentDays: 26,
      AbsenceDays: 0,
      LateMinutes: 0,
      Notes: 'معفى من البصمة',
    };
  });
}

async function saveManualAttendance(dto, currentUserName) {
  const pool = await connectDB();
  // الحضور اليدوي للمعفيين فقط — غير المعفي يُرفض (مرآة قاعدة بلازور)
  const empRes = await pool.request()
    .input('employeeId', sql.Int, dto.employeeId)
    .query(`SELECT EmployeeID, IsPermanentlyExempt FROM Employees WHERE EmployeeID = @employeeId`);
  const employee = empRes.recordset[0];
  if (!employee) {
    const err = new Error('الموظف غير موجود.');
    err.statusCode = 400;
    throw err;
  }
  if (employee.IsPermanentlyExempt !== true && employee.IsPermanentlyExempt !== 1) {
    const err = new Error('الحضور اليدوي متاح للمعفيين من البصمة فقط.');
    err.statusCode = 400;
    throw err;
  }

  await pool.request()
    .input('employeeId', sql.Int, dto.employeeId)
    .input('month', sql.NVarChar(10), dto.attendanceMonth)
    .input('presentDays', sql.Int, dto.presentDays || 0)
    .input('absenceDays', sql.Int, dto.absenceDays || 0)
    .input('lateMinutes', sql.Int, dto.lateMinutes || 0)
    .input('notes', sql.NVarChar(500), dto.notes || null)
    .input('createdBy', sql.NVarChar(100), currentUserName)
    .query(`
      IF EXISTS (SELECT 1 FROM AttendanceManual WHERE EmployeeID = @employeeId AND AttendanceMonth = @month)
        UPDATE AttendanceManual
        SET PresentDays = @presentDays, AbsenceDays = @absenceDays,
            LateMinutes = @lateMinutes, Notes = @notes
        WHERE EmployeeID = @employeeId AND AttendanceMonth = @month
      ELSE
        INSERT INTO AttendanceManual (EmployeeID, AttendanceMonth, PresentDays, AbsenceDays, LateMinutes, Notes, CreatedBy, CreatedAt)
        VALUES (@employeeId, @month, @presentDays, @absenceDays, @lateMinutes, @notes, @createdBy, GETDATE())
    `);
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
  getExemptionById,
  setExemptionDecision,
  applyExemptionAttendance,
  inferExemptionStatus,
  classifyExemptionReason,
  getCalendar,
  getEmployeeNameByUserId,
  getAllExemptions,
  deleteExemption,
  getActiveLocations,
  getEmployeeStatistics,
  getAdvancedReport,
  getManualAttendance,
  saveManualAttendance
};