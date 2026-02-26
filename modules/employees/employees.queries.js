const { sql, connectDB } = require('../../core/database');

// جلب كل الموظفين (مع البحث والفلترة)
async function getAllEmployees(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  
  let query = `
    SELECT 
      EmployeeID, FullName, JobTitle, Department, NationalID,
      Gender, BirthDate, qualification, Address, MobilePhone,
      MobilePhone2, EmailAddress, HireDate, EndDate,
      BioEmployeeID, IsPermanentlyExempt, CurrentSalaryBase, Status, Notes,
      CreatedBy, CreatedAt
    FROM Employees
    WHERE 1=1
  `;

  // الفلترة
  if (filters.status) {
    request.input('status', sql.NVarChar(20), filters.status);
    query += ` AND Status = @status`;
  }

  if (filters.department) {
    request.input('department', sql.NVarChar(100), filters.department);
    query += ` AND Department = @department`;
  }

  if (filters.search) {
    request.input('search', sql.NVarChar(100), `%${filters.search}%`);
    query += ` AND (FullName LIKE @search OR MobilePhone LIKE @search OR NationalID LIKE @search)`;
  }

  query += ` ORDER BY FullName`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب الموظفين النشطين فقط
async function getActiveEmployees() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT EmployeeID, FullName, JobTitle, Department, MobilePhone, BioEmployeeID
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

// جلب قوائم الأقسام والوظائف (Dropdowns)
async function getEmployeeLookups() {
  const pool = await connectDB();
  
  const departments = await pool.request().query(`
    SELECT DISTINCT Department FROM Employees WHERE Department IS NOT NULL AND Department != ''
  `);
  
  const jobTitles = await pool.request().query(`
    SELECT DISTINCT JobTitle FROM Employees WHERE JobTitle IS NOT NULL AND JobTitle != ''
  `);
  
  return {
    departments: departments.recordset.map(r => r.Department),
    jobTitles: jobTitles.recordset.map(r => r.JobTitle)
  };
}

// إضافة موظف جديد
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
    .input('endDate', sql.DateTime, data.endDate || null) // ✅
    .input('bioEmployeeId', sql.Int, data.bioEmployeeId || null) // ✅
    .input('isPermanentlyExempt', sql.Bit, data.isPermanentlyExempt ? 1 : 0) // ✅
    .input('currentSalaryBase', sql.Decimal(18, 2), data.currentSalaryBase || 0)
    .input('status', sql.NVarChar(20), data.status || 'نشط')
    .input('notes', sql.NVarChar(150), data.notes || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO Employees (
        FullName, JobTitle, Department, NationalID, Gender,
        BirthDate, qualification, Address, MobilePhone, MobilePhone2,
        EmailAddress, HireDate, EndDate, BioEmployeeID, IsPermanentlyExempt,
        CurrentSalaryBase, Status, Notes, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.EmployeeID
      VALUES (
        @fullName, @jobTitle, @department, @nationalId, @gender,
        @birthDate, @qualification, @address, @mobilePhone, @mobilePhone2,
        @emailAddress, @hireDate, @endDate, @bioEmployeeId, @isPermanentlyExempt,
        @currentSalaryBase, @status, @notes, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].EmployeeID;
}

// تعديل موظف
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
    .input('endDate', sql.DateTime, data.endDate || null) // ✅
    .input('bioEmployeeId', sql.Int, data.bioEmployeeId || null) // ✅
    .input('isPermanentlyExempt', sql.Bit, data.isPermanentlyExempt ? 1 : 0) // ✅
    .input('currentSalaryBase', sql.Decimal(18, 2), data.currentSalaryBase || 0)
    .input('status', sql.NVarChar(20), data.status || 'نشط')
    .input('notes', sql.NVarChar(150), data.notes || null)
    .query(`
      UPDATE Employees SET
        FullName = @fullName, JobTitle = @jobTitle, Department = @department,
        NationalID = @nationalId, Gender = @gender, BirthDate = @birthDate,
        qualification = @qualification, Address = @address,
        MobilePhone = @mobilePhone, MobilePhone2 = @mobilePhone2,
        EmailAddress = @emailAddress, HireDate = @hireDate, EndDate = @endDate,
        BioEmployeeID = @bioEmployeeId, IsPermanentlyExempt = @isPermanentlyExempt,
        CurrentSalaryBase = @currentSalaryBase, Status = @status, Notes = @notes
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
  getEmployeeLookups,
  createEmployee,
  updateEmployee,
  updateEmployeeStatus,
  getSalaryHistory
};