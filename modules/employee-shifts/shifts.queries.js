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
        EffectiveFrom, EffectiveTo, CreatedAt, OffDay1, OffDay2
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
    .input('offDay1', sql.Int, data.offDay1 ?? null)
    .input('offDay2', sql.Int, data.offDay2 ?? null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .input('createdAt', sql.DateTime, data.createdAt)
    .query(`
      -- ✅ أولاً: نجيب كود البصمة
      DECLARE @BioCode INT;
      SELECT @BioCode = BioEmployeeID FROM Employees WHERE EmployeeID = @employeeId;

      -- ✅ ثانياً: نسجل الشيفت مع الكود وأيام الراحة الأسبوعية
      -- (OffDay1/OffDay2: بايتات DayOfWeek بنظام .NET — 0=الأحد..6=السبت؛
      --  غيابهما يُحفظ NULL كما في إنشاء البلازور تمامًا)
      INSERT INTO EmployeeShifts (
        EmployeeID, BiometricCode, ShiftType, StartTime, EndTime, 
        EffectiveFrom, EffectiveTo, OffDay1, OffDay2, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.EmployeeShiftID
      VALUES (
        @employeeId, @BioCode, @shiftType, 
        CAST(@startTime AS TIME), CAST(@endTime AS TIME),
        @effectiveFrom, @effectiveTo, @offDay1, @offDay2, @createdBy, @createdAt
      )
    `);
    
  return result.recordset[0].EmployeeShiftID;
}

// تعديل شيفت — مرآة EmployeeShiftService.UpdateShiftAsync:295:
// تحديث في المكان نفسه (النوع والأوقات والسريان وأيام الراحة وكود
// البصمة عند إرساله) دون إغلاق أي شيفتات أخرى ودون إنشاء سجل جديد.
// أيام الراحة ثلاثية الحالة لكل يوم: قيمة 0–6 تُضبط، وغيابها (null بلا
// علم مسح) يُبقي المخزَّن عبر ISNULL (سلوك البلازور)، وعلم المسح
// (offDayNClear — مصدره إشارة −1 في المتحكم) يُفرّغ العمود إلى NULL.
async function updateShift(shiftId, data) {
  const pool = await connectDB();
  const existingRes = await pool.request()
    .input('id', sql.Int, shiftId)
    .query(`SELECT EmployeeShiftID FROM EmployeeShifts WHERE EmployeeShiftID = @id`);
  if (existingRes.recordset.length === 0) {
    const err = new Error('الشيفت غير موجود.');
    err.statusCode = 404;
    throw err;
  }

  // فحص التعارض قبل الكتابة: الفترة الناتجة (EffectiveFrom..EffectiveTo)
  // لا يجوز أن تتداخل مع سجل آخر لنفس الموظف (باستثناء السجل نفسه).
  // فترة مفتوحة النهاية (EffectiveTo فارغ) تمتد بلا نهاية.
  const overlapRes = await pool.request()
    .input('id', sql.Int, shiftId)
    .input('effectiveFrom', sql.DateTime, data.effectiveFrom)
    .input('effectiveTo', sql.DateTime, data.effectiveTo || null)
    .query(`
      SELECT TOP 1 EmployeeShiftID
      FROM EmployeeShifts
      WHERE EmployeeID = (SELECT EmployeeID FROM EmployeeShifts WHERE EmployeeShiftID = @id)
        AND EmployeeShiftID <> @id
        AND CAST(EffectiveFrom AS DATE) <= CAST(ISNULL(@effectiveTo, '9999-12-31') AS DATE)
        AND (EffectiveTo IS NULL OR CAST(EffectiveTo AS DATE) >= CAST(@effectiveFrom AS DATE))
    `);
  if (overlapRes.recordset.length > 0) {
    const err = new Error('توجد فترة شيفت أخرى متداخلة مع هذه الفترة لنفس الموظف؛ عدّل التواريخ أولًا.');
    err.statusCode = 409;
    throw err;
  }

  await pool.request()
    .input('id', sql.Int, shiftId)
    .input('shiftType', sql.VarChar(20), data.shiftType)
    .input('startTime', sql.VarChar(8), data.startTime)
    .input('endTime', sql.VarChar(8), data.endTime)
    .input('effectiveFrom', sql.DateTime, data.effectiveFrom)
    .input('effectiveTo', sql.DateTime, data.effectiveTo || null)
    .input('offDay1', sql.Int, data.offDay1 ?? null)
    .input('offDay1Clear', sql.Bit, data.offDay1Clear ? 1 : 0)
    .input('offDay2', sql.Int, data.offDay2 ?? null)
    .input('offDay2Clear', sql.Bit, data.offDay2Clear ? 1 : 0)
    .input('biometricCode', sql.Int, data.biometricCode ?? null)
    .query(`
      UPDATE EmployeeShifts
      SET ShiftType = @shiftType,
          StartTime = CAST(@startTime AS TIME),
          EndTime = CAST(@endTime AS TIME),
          EffectiveFrom = @effectiveFrom,
          EffectiveTo = @effectiveTo,
          OffDay1 = CASE WHEN @offDay1Clear = 1 THEN NULL ELSE ISNULL(@offDay1, OffDay1) END,
          OffDay2 = CASE WHEN @offDay2Clear = 1 THEN NULL ELSE ISNULL(@offDay2, OffDay2) END,
          BiometricCode = ISNULL(@biometricCode, BiometricCode)
      WHERE EmployeeShiftID = @id
    `);
  return true;
}

// بيانات حارس الحذف: هل السجل هو الشيفت الساري اليوم؟ وهل هو سجل
// الموظف الوحيد؟ (حذف أيٍّ منهما مرفوض — انظر deleteShift)
async function getShiftDeleteInfo(shiftId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, shiftId)
    .query(`
      SELECT
        s.EmployeeShiftID, s.EmployeeID,
        CASE WHEN CAST(s.EffectiveFrom AS DATE) <= CAST(GETDATE() AS DATE)
              AND (s.EffectiveTo IS NULL OR CAST(s.EffectiveTo AS DATE) >= CAST(GETDATE() AS DATE))
             THEN 1 ELSE 0 END AS IsCurrent,
        (SELECT COUNT(*) FROM EmployeeShifts WHERE EmployeeID = s.EmployeeID) AS TotalCount
      FROM EmployeeShifts s
      WHERE s.EmployeeShiftID = @id
    `);
  return result.recordset[0] || null;
}

// حذف شيفت (لو أضيف بالخطأ) — بحارس: حذف الشيفت الساري حاليًا أو
// سجل الموظف الوحيد مرفوض (409)؛ السجلات التاريخية غير الوحيدة
// تُحذف كما كانت. سجل غير موجود: الحذف يمر بلا أثر كما كان سابقًا.
async function deleteShift(shiftId) {
  const pool = await connectDB();
  const info = await getShiftDeleteInfo(shiftId);
  if (info) {
    if (info.IsCurrent) {
      const err = new Error('لا يمكن حذف الشيفت الساري حاليًا؛ أغلقه بتاريخ انتهاء أو عدّل سريانه أولًا.');
      err.statusCode = 409;
      throw err;
    }
    if (info.TotalCount <= 1) {
      const err = new Error('لا يمكن حذف الشيفت الوحيد لهذا الموظف.');
      err.statusCode = 409;
      throw err;
    }
  }
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
      
      FORMAT(CAST(s.StartTime AS DATETIME), 'hh:mm tt') as StartTime,
      FORMAT(CAST(s.EndTime AS DATETIME), 'hh:mm tt') as EndTime,
      FORMAT(s.EffectiveFrom, 'yyyy-MM-dd') as EffectiveFrom,
      FORMAT(s.EffectiveTo, 'yyyy-MM-dd') as EffectiveTo,
      s.OffDay1, s.OffDay2
      
    FROM Employees e
    -- حسم حتمي للشيفت الحالي: سجل واحد لكل موظف — أحدث EffectiveFrom
    -- يغطي اليوم (OUTER APPLY + TOP 1)؛ بلا شيفت سارٍ تبقى أعمدة
    -- الشيفت فارغة كما كانت مع LEFT JOIN.
    OUTER APPLY (
      SELECT TOP 1 *
      FROM EmployeeShifts
      WHERE EmployeeID = e.EmployeeID
        AND CAST(GETDATE() AS DATE) >= CAST(EffectiveFrom AS DATE)
        AND (EffectiveTo IS NULL OR CAST(GETDATE() AS DATE) <= CAST(EffectiveTo AS DATE))
      ORDER BY EffectiveFrom DESC
    ) s
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
  updateShift,
  deleteShift,
  getShiftDeleteInfo,
  getEmployeesWithCurrentShift,
  searchShifts,
  getMySchedule
};