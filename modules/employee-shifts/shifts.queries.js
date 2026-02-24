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

  // 2. إضافة الشيفت الجديد
  const result = await pool.request()
    .input('employeeId', sql.Int, data.employeeId)
    .input('shiftType', sql.VarChar(20), data.shiftType)
    .input('startTime', sql.Time, data.startTime)
    .input('endTime', sql.Time, data.endTime)
    .input('effectiveFrom', sql.DateTime, data.effectiveFrom)
    .input('effectiveTo', sql.DateTime, data.effectiveTo || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .input('createdAt', sql.DateTime, data.createdAt) // ✅ نستقبل الوقت من الـ Controller
    .query(`
      INSERT INTO EmployeeShifts (
        EmployeeID, ShiftType, StartTime, EndTime, 
        EffectiveFrom, EffectiveTo, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.EmployeeShiftID
      VALUES (
        @employeeId, @shiftType, @startTime, @endTime,
        @effectiveFrom, @effectiveTo, @createdBy, @createdAt -- ✅ نستخدمه هنا
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

module.exports = {
  getShiftsByEmployee,
  getCurrentShift,
  createShift,
  deleteShift
};