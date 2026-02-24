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
      
      -- 👇 ده التعديل المهم عشان العرض يظبط
      FORMAT(CAST(s.StartTime AS DATETIME), 'hh:mm tt') as StartTime,
      FORMAT(CAST(s.EndTime AS DATETIME), 'hh:mm tt') as EndTime,
      FORMAT(s.EffectiveFrom, 'yyyy-MM-dd') as StartDate
      
      s.EffectiveFrom
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

module.exports = {
  getShiftsByEmployee,
  getCurrentShift,
  createShift,
  deleteShift,
  getEmployeesWithCurrentShift
};