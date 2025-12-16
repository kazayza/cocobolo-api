const { sql, connectDB } = require('../../core/database');

// جلب كل الموظفين
async function getAllEmployees() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        EmployeeID, FullName, JobTitle, Department, NationalID,
        Gender, BirthDate, qualification, Address, MobilePhone,
        MobilePhone2, EmailAddress, HireDate, EndDate,
        BioEmployeeID, CurrentSalaryBase, Status, Notes,
        CreatedBy, CreatedAt
      FROM Employees
      ORDER BY FullName
    `);
  return result.recordset;
}

// جلب الموظفين النشطين فقط
async function getActiveEmployees() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT EmployeeID, FullName, JobTitle, Department, MobilePhone
      FROM Employees 
      WHERE Status = N'نشط'
      ORDER BY FullName
    `);
  return result.recordset;
}

// جلب موظف بالـ ID
async function getEmployeeById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT * FROM Employees WHERE EmployeeID = @id
    `);
  return result.recordset[0] || null;
}

// إضافة موظف جديد
async function createEmployee(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('fullName', sql.NVarChar(150), data.fullName)
    .input('jobTitle', sql.NVarChar(100), data.jobTitle || null)
    .input('department', sql.NVarChar(100), data.department || null)
    .input('nationalId', sql.NVarChar(14), data.nationalId)
    .input('gender', sql.NVarChar(5), data.gender || null)
    .input('birthDate', sql.DateTime, data.birthDate || null)
    .input('qualification', sql.NVarChar(100), data.qualification || null)
    .input('address', sql.NVarChar(150), data.address || null)
    .input('mobilePhone', sql.NVarChar(20), data.mobilePhone || null)
    .input('mobilePhone2', sql.NVarChar(20), data.mobilePhone2 || null)
    .input('emailAddress', sql.NVarChar(50), data.emailAddress || null)
    .input('hireDate', sql.DateTime, data.hireDate || null)
    .input('bioEmployeeId', sql.Int, data.bioEmployeeId || null)
    .input('currentSalaryBase', sql.Decimal(18, 2), data.currentSalaryBase || 0)
    .input('status', sql.NVarChar(20), data.status || 'نشط')
    .input('notes', sql.NVarChar(150), data.notes || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO Employees (
        FullName, JobTitle, Department, NationalID, Gender,
        BirthDate, qualification, Address, MobilePhone, MobilePhone2,
        EmailAddress, HireDate, BioEmployeeID, CurrentSalaryBase,
        Status, Notes, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.EmployeeID
      VALUES (
        @fullName, @jobTitle, @department, @nationalId, @gender,
        @birthDate, @qualification, @address, @mobilePhone, @mobilePhone2,
        @emailAddress, @hireDate, @bioEmployeeId, @currentSalaryBase,
        @status, @notes, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].EmployeeID;
}

// تعديل موظف
async function updateEmployee(id, data) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('fullName', sql.NVarChar(150), data.fullName)
    .input('jobTitle', sql.NVarChar(100), data.jobTitle || null)
    .input('department', sql.NVarChar(100), data.department || null)
    .input('nationalId', sql.NVarChar(14), data.nationalId)
    .input('gender', sql.NVarChar(5), data.gender || null)
    .input('birthDate', sql.DateTime, data.birthDate || null)
    .input('qualification', sql.NVarChar(100), data.qualification || null)
    .input('address', sql.NVarChar(150), data.address || null)
    .input('mobilePhone', sql.NVarChar(20), data.mobilePhone || null)
    .input('mobilePhone2', sql.NVarChar(20), data.mobilePhone2 || null)
    .input('emailAddress', sql.NVarChar(50), data.emailAddress || null)
    .input('hireDate', sql.DateTime, data.hireDate || null)
    .input('bioEmployeeId', sql.Int, data.bioEmployeeId || null)
    .input('currentSalaryBase', sql.Decimal(18, 2), data.currentSalaryBase || 0)
    .input('status', sql.NVarChar(20), data.status || 'نشط')
    .input('notes', sql.NVarChar(150), data.notes || null)
    .query(`
      UPDATE Employees SET
        FullName = @fullName, JobTitle = @jobTitle, Department = @department,
        NationalID = @nationalId, Gender = @gender, BirthDate = @birthDate,
        qualification = @qualification, Address = @address,
        MobilePhone = @mobilePhone, MobilePhone2 = @mobilePhone2,
        EmailAddress = @emailAddress, HireDate = @hireDate,
        BioEmployeeID = @bioEmployeeId, CurrentSalaryBase = @currentSalaryBase,
        Status = @status, Notes = @notes
      WHERE EmployeeID = @id
    `);
  return true;
}

// تغيير حالة الموظف
async function updateEmployeeStatus(id, status) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('status', sql.NVarChar(20), status)
    .query('UPDATE Employees SET Status = @status WHERE EmployeeID = @id');
  return true;
}

// جلب سجل الرواتب للموظف
async function getSalaryHistory(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT * FROM SalaryHistory 
      WHERE EmployeeID = @employeeId 
      ORDER BY ChangeDate DESC
    `);
  return result.recordset;
}

// تصدير الدوال
module.exports = {
  getAllEmployees,
  getActiveEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  updateEmployeeStatus,
  getSalaryHistory
};