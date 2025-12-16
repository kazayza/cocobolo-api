const { sql, connectDB } = require('../../core/database');

// جلب بيانات الشركة
async function getCompanyInfo() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        CompanyID, CompanyName, Logo, LogoPath,
        Address, Phone1, Phone2, SalesEmail, InfoEmail,
        Website, CurrentVersion
      FROM CompanyInfo
    `);
  
  if (result.recordset.length > 0 && result.recordset[0].Logo) {
    result.recordset[0].Logo = Buffer.from(result.recordset[0].Logo).toString('base64');
  }
  
  return result.recordset[0] || null;
}

// تحديث بيانات الشركة
async function updateCompanyInfo(data) {
  const pool = await connectDB();
  
  const request = pool.request()
    .input('companyName', sql.NVarChar(100), data.companyName)
    .input('address', sql.NVarChar(255), data.address)
    .input('phone1', sql.NVarChar(20), data.phone1)
    .input('phone2', sql.NVarChar(20), data.phone2 || null)
    .input('salesEmail', sql.NVarChar(100), data.salesEmail)
    .input('infoEmail', sql.NVarChar(100), data.infoEmail)
    .input('website', sql.NVarChar(100), data.website);

  let query = `
    UPDATE CompanyInfo SET
      CompanyName = @companyName, Address = @address,
      Phone1 = @phone1, Phone2 = @phone2,
      SalesEmail = @salesEmail, InfoEmail = @infoEmail,
      Website = @website
  `;

  // إذا فيه لوجو جديد
  if (data.logo) {
    const logoBuffer = Buffer.from(data.logo, 'base64');
    request.input('logo', sql.VarBinary(sql.MAX), logoBuffer);
    query += `, Logo = @logo`;
  }

  await request.query(query);
  return true;
}

// جلب الإصدار الحالي
async function getCurrentVersion() {
  const pool = await connectDB();
  const result = await pool.request()
    .query('SELECT CurrentVersion FROM CompanyInfo');
  return result.recordset[0]?.CurrentVersion || '1.0.0';
}

// تحديث الإصدار
async function updateVersion(version) {
  const pool = await connectDB();
  await pool.request()
    .input('version', sql.NVarChar(20), version)
    .query('UPDATE CompanyInfo SET CurrentVersion = @version');
  return true;
}

// تصدير الدوال
module.exports = {
  getCompanyInfo,
  updateCompanyInfo,
  getCurrentVersion,
  updateVersion
};