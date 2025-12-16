const { sql, connectDB } = require('../../core/database');

// جلب كل العملاء
async function getAllClients() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        PartyID, PartyName, Phone, Phone2, Email,
        Address, TaxNumber, OpeningBalance, BalanceType,
        ContactPerson, NationalID
      FROM Parties 
      WHERE PartyType = 1 AND IsActive = 1 
      ORDER BY PartyName
    `);
  return result.recordset;
}

// جلب قائمة العملاء (مختصرة)
async function getClientsList() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT PartyID, PartyName, Phone
      FROM Parties 
      WHERE PartyType = 1 AND IsActive = 1
      ORDER BY PartyName
    `);
  return result.recordset;
}

// البحث عن عميل
async function searchClients(searchTerm) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('search', sql.NVarChar, `%${searchTerm}%`)
    .query(`
      SELECT TOP 20 
        PartyID, PartyName, Phone, Phone2, Address
      FROM Parties 
      WHERE IsActive = 1 
        AND PartyType = 1
        AND (PartyName LIKE @search OR Phone LIKE @search OR Phone2 LIKE @search)
      ORDER BY PartyName
    `);
  return result.recordset;
}

// ملخص العملاء
async function getClientsSummary() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        (SELECT COUNT(*) FROM Parties WHERE PartyType = 1 AND IsActive = 1) as totalClients,
        (SELECT COUNT(*) FROM Parties WHERE PartyType = 1 AND IsActive = 1 
         AND CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newToday,
        (SELECT COUNT(*) FROM Parties WHERE PartyType = 1 AND IsActive = 1 
         AND MONTH(CreatedAt) = MONTH(GETDATE()) AND YEAR(CreatedAt) = YEAR(GETDATE())) as newThisMonth
    `);
  return result.recordset[0];
}

// جلب عميل بالـ ID
async function getClientById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        p.PartyID, p.PartyName, p.PartyType, p.ContactPerson,
        p.Phone, p.Phone2, p.Email, p.Address, p.TaxNumber,
        p.OpeningBalance, p.BalanceType, p.Notes, p.IsActive,
        p.NationalID, p.FloorNumber, p.CreatedBy, p.CreatedAt,
        p.ReferralSourceID, p.ReferralSourceClient,
        rs.SourceName AS ReferralSourceName
      FROM Parties p
      LEFT JOIN ReferralSources rs ON p.ReferralSourceID = rs.ReferralSourceID
      WHERE p.PartyID = @id
    `);
  return result.recordset[0] || null;
}

// التحقق من وجود اسم العميل
async function checkClientNameExists(partyName, excludeId = null) {
  const pool = await connectDB();
  const request = pool.request()
    .input('partyName', sql.NVarChar(200), partyName);
  
  let query = 'SELECT PartyID FROM Parties WHERE PartyName = @partyName AND IsActive = 1';
  
  if (excludeId) {
    request.input('excludeId', sql.Int, excludeId);
    query += ' AND PartyID != @excludeId';
  }
  
  const result = await request.query(query);
  return result.recordset.length > 0;
}

// إضافة عميل جديد
async function createClient(clientData) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('partyName', sql.NVarChar(200), clientData.partyName)
    .input('partyType', sql.Int, 1)
    .input('contactPerson', sql.NVarChar(100), clientData.contactPerson || null)
    .input('phone', sql.NVarChar(50), clientData.phone || null)
    .input('phone2', sql.NVarChar(50), clientData.phone2 || null)
    .input('email', sql.NVarChar(100), clientData.email || null)
    .input('address', sql.NVarChar(250), clientData.address || null)
    .input('taxNumber', sql.NVarChar(50), clientData.taxNumber || null)
    .input('openingBalance', sql.Decimal(18, 2), clientData.openingBalance || 0)
    .input('balanceType', sql.Char(1), clientData.balanceType || 'D')
    .input('notes', sql.NVarChar(255), clientData.notes || null)
    .input('nationalId', sql.NVarChar(14), clientData.nationalId || null)
    .input('floorNumber', sql.NVarChar(50), clientData.floorNumber || null)
    .input('referralSourceId', sql.Int, clientData.referralSourceId || null)
    .input('referralSourceClient', sql.Int, clientData.referralSourceClient || null)
    .input('createdBy', sql.NVarChar(100), clientData.createdBy)
    .query(`
      INSERT INTO Parties (
        PartyName, PartyType, ContactPerson, Phone, Phone2, Email,
        Address, TaxNumber, OpeningBalance, BalanceType, Notes,
        NationalID, FloorNumber, ReferralSourceID, ReferralSourceClient,
        IsActive, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.PartyID
      VALUES (
        @partyName, @partyType, @contactPerson, @phone, @phone2, @email,
        @address, @taxNumber, @openingBalance, @balanceType, @notes,
        @nationalId, @floorNumber, @referralSourceId, @referralSourceClient,
        1, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].PartyID;
}

// تعديل عميل
async function updateClient(id, clientData) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('partyName', sql.NVarChar(200), clientData.partyName)
    .input('contactPerson', sql.NVarChar(100), clientData.contactPerson || null)
    .input('phone', sql.NVarChar(50), clientData.phone || null)
    .input('phone2', sql.NVarChar(50), clientData.phone2 || null)
    .input('email', sql.NVarChar(100), clientData.email || null)
    .input('address', sql.NVarChar(250), clientData.address || null)
    .input('taxNumber', sql.NVarChar(50), clientData.taxNumber || null)
    .input('openingBalance', sql.Decimal(18, 2), clientData.openingBalance || 0)
    .input('balanceType', sql.Char(1), clientData.balanceType || 'D')
    .input('notes', sql.NVarChar(255), clientData.notes || null)
    .input('nationalId', sql.NVarChar(14), clientData.nationalId || null)
    .input('floorNumber', sql.NVarChar(50), clientData.floorNumber || null)
    .input('referralSourceId', sql.Int, clientData.referralSourceId || null)
    .input('referralSourceClient', sql.Int, clientData.referralSourceClient || null)
    .query(`
      UPDATE Parties SET
        PartyName = @partyName, ContactPerson = @contactPerson,
        Phone = @phone, Phone2 = @phone2, Email = @email,
        Address = @address, TaxNumber = @taxNumber,
        OpeningBalance = @openingBalance, BalanceType = @balanceType,
        Notes = @notes, NationalID = @nationalId, FloorNumber = @floorNumber,
        ReferralSourceID = @referralSourceId, ReferralSourceClient = @referralSourceClient
      WHERE PartyID = @id
    `);
  return true;
}

// التحقق من وجود معاملات للعميل
async function checkClientHasTransactions(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT COUNT(*) as count FROM Transactions WHERE PartyID = @id');
  return result.recordset[0].count > 0;
}

// حذف عميل (Soft Delete)
async function deleteClient(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('UPDATE Parties SET IsActive = 0 WHERE PartyID = @id');
  return true;
}

// جلب مصادر الإحالة
async function getReferralSources() {
  const pool = await connectDB();
  const result = await pool.request()
    .query('SELECT ReferralSourceID, SourceName FROM ReferralSources WHERE IsActive = 1 ORDER BY SourceName');
  return result.recordset;
}

// تصدير الدوال
module.exports = {
  getAllClients,
  getClientsList,
  searchClients,
  getClientsSummary,
  getClientById,
  checkClientNameExists,
  createClient,
  updateClient,
  checkClientHasTransactions,
  deleteClient,
  getReferralSources
};