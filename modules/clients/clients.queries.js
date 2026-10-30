const { sql, connectDB } = require('../../core/database');

// جلب كل العملاء
// جلب كل العملاء
async function getAllClients() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        PartyID, PartyName, Phone, Phone2, Email,
        Address, TaxNumber, OpeningBalance, BalanceType,
        ContactPerson, NationalID, FloorNumber, Notes,
        ReferralSourceID, ReferralSourceClient,
        CreatedBy, CreatedAt
      FROM Parties 
      WHERE PartyType = 1 AND IsActive = 1 
      ORDER BY CreatedAt DESC
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

// جلب عميل بالـ ID — المجموعة الكاملة من نموذج بلازور Party.cs
// (لا يوجد عمود Governorate: المحافظة هي City وتُعرض «المدينة» في
// بلازور، والمنطقة هي Area) + أسماء النوع/المرحلة/المصدر + جهات
// الاتصال كاملة من PartyContacts كما في PartyService.
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
        p.CustomerStage, p.StageId, p.JobTitle, p.ParentPartyId,
        p.City, p.Area, p.ContactSourceId,
        p.LastContactDate, p.Rating, p.LastUpdatedBy, p.LastUpdatedAt,
        p.DataDone, p.IsB2B,
        rs.SourceName AS ReferralSourceName,
        pt.PartyTypeName AS PartyTypeName,
        ss.StageName AS StageName, ss.StageNameAr AS StageNameAr,
        cs.SourceName AS ContactSourceName, cs.SourceNameAr AS ContactSourceNameAr,
        parent.PartyName AS ParentPartyName
      FROM Parties p
      LEFT JOIN ReferralSources rs ON p.ReferralSourceID = rs.ReferralSourceID
      LEFT JOIN PartyTypes pt ON p.PartyType = pt.PartyTypeId
      LEFT JOIN SalesStages ss ON p.StageId = ss.StageId
      LEFT JOIN ContactSources cs ON p.ContactSourceId = cs.SourceId
      LEFT JOIN Parties parent ON p.ParentPartyId = parent.PartyID
      WHERE p.PartyID = @id
    `);
  const client = result.recordset[0] || null;
  if (!client) return null;

  try {
    const contacts = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT ContactId, PartyId, ContactName, JobTitle, Phone, Email,
               Notes, IsPrimary, IsActive, CreatedBy, CreatedAt
        FROM PartyContacts
        WHERE PartyId = @id
        ORDER BY IsPrimary DESC, ContactId ASC
      `);
    client.Contacts = contacts.recordset;
  } catch (_) {
    client.Contacts = [];
  }
  return client;
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

// مزامنة جهات الاتصال — مرآة PartyService.SavePartyAsync:
// تحديث بالمعرّف، وحذف الغائب من القائمة المرسلة، وإدراج الجديد.
async function syncPartyContacts(pool, partyId, contacts, userName, isNew) {
  if (!Array.isArray(contacts)) return;
  const rows = contacts.filter((c) => c && String(c.contactName || c.ContactName || '').trim());
  if (!isNew) {
    const keepIds = rows
      .map((c) => Number(c.contactId ?? c.ContactId ?? 0))
      .filter((n) => Number.isInteger(n) && n > 0);
    const delReq = pool.request().input('partyId', sql.Int, partyId);
    let delQuery = `DELETE FROM PartyContacts WHERE PartyID = @partyId`;
    if (keepIds.length) {
      const placeholders = keepIds.map((n, i) => {
        delReq.input(`keep${i}`, sql.Int, n);
        return `@keep${i}`;
      }).join(',');
      delQuery += ` AND ContactID NOT IN (${placeholders})`;
    }
    await delReq.query(delQuery);
  }
  for (const c of rows) {
    const contactId = Number(c.contactId ?? c.ContactId ?? 0);
    const name = String(c.contactName || c.ContactName).trim();
    const jobTitle = c.jobTitle ?? c.JobTitle ?? null;
    const phone = c.phone ?? c.Phone ?? null;
    const email = c.email ?? c.Email ?? null;
    const notes = c.notes ?? c.Notes ?? null;
    const isPrimary = (c.isPrimary ?? c.IsPrimary) ? 1 : 0;
    const isActive = (c.isActive ?? c.IsActive) === false || (c.isActive ?? c.IsActive) === 0 ? 0 : 1;
    if (!isNew && Number.isInteger(contactId) && contactId > 0) {
      await pool.request()
        .input('contactId', sql.Int, contactId)
        .input('partyId', sql.Int, partyId)
        .input('name', sql.NVarChar(100), name)
        .input('jobTitle', sql.NVarChar(100), jobTitle)
        .input('phone', sql.NVarChar(50), phone)
        .input('email', sql.NVarChar(100), email)
        .input('notes', sql.NVarChar(255), notes)
        .input('isPrimary', sql.Bit, isPrimary)
        .input('isActive', sql.Bit, isActive)
        .query(`
          UPDATE PartyContacts SET
            ContactName = @name, JobTitle = @jobTitle, Phone = @phone,
            Email = @email, Notes = @notes, IsPrimary = @isPrimary, IsActive = @isActive
          WHERE ContactID = @contactId AND PartyID = @partyId
        `);
    } else {
      await pool.request()
        .input('partyId', sql.Int, partyId)
        .input('name', sql.NVarChar(100), name)
        .input('jobTitle', sql.NVarChar(100), jobTitle)
        .input('phone', sql.NVarChar(50), phone)
        .input('email', sql.NVarChar(100), email)
        .input('notes', sql.NVarChar(255), notes)
        .input('isPrimary', sql.Bit, isPrimary)
        .input('isActive', sql.Bit, isActive)
        .input('createdBy', sql.NVarChar(100), userName || null)
        .query(`
          INSERT INTO PartyContacts (PartyID, ContactName, JobTitle, Phone, Email, Notes, IsPrimary, IsActive, CreatedBy, CreatedAt)
          VALUES (@partyId, @name, @jobTitle, @phone, @email, @notes, @isPrimary, @isActive, @createdBy, GETDATE())
        `);
    }
  }
}

function bindPartyFields(request, clientData) {
  return request
    .input('partyName', sql.NVarChar(200), clientData.partyName)
    .input('partyType', sql.Int, Number(clientData.partyType) > 0 ? Number(clientData.partyType) : 1)
    .input('contactPerson', sql.NVarChar(100), clientData.contactPerson || null)
    .input('phone', sql.NVarChar(50), clientData.phone || null)
    .input('phone2', sql.NVarChar(50), clientData.phone2 || null)
    .input('email', sql.NVarChar(100), clientData.email || null)
    .input('address', sql.NVarChar(250), clientData.address || null)
    .input('taxNumber', sql.NVarChar(50), clientData.taxNumber || null)
    .input('openingBalance', sql.Decimal(18, 2), clientData.openingBalance || 0)
    .input('balanceType', sql.Char(1), clientData.balanceType === 'C' ? 'C' : 'D')
    .input('notes', sql.NVarChar(255), clientData.notes || null)
    .input('nationalId', sql.NVarChar(14), clientData.nationalId || null)
    .input('floorNumber', sql.NVarChar(50), clientData.floorNumber || null)
    .input('referralSourceId', sql.Int, clientData.referralSourceId || null)
    .input('referralSourceClient', sql.Int, clientData.referralSourceClient || null)
    .input('customerStage', sql.NVarChar(20), clientData.customerStage || null)
    .input('stageId', sql.Int, clientData.stageId || null)
    .input('jobTitle', sql.NVarChar(100), clientData.jobTitle || null)
    .input('parentPartyId', sql.Int, clientData.parentPartyId || null)
    .input('city', sql.NVarChar(100), clientData.city || null)
    .input('area', sql.NVarChar(100), clientData.area || null)
    .input('contactSourceId', sql.Int, clientData.contactSourceId || null);
}

// إضافة عميل جديد — الحقول الكاملة من Party.cs؛ مرحلة العميل
// الافتراضية عند الإنشاء 'Lead' كما في Blazor SavePartyAsync
// (CustomerStage = dto.CustomerStage ?? CustomerStages.Lead).
async function createClient(clientData) {
  const pool = await connectDB();
  const result = await bindPartyFields(pool.request(), clientData)
    .input('createdBy', sql.NVarChar(100), clientData.createdBy)
    .query(`
      INSERT INTO Parties (
        PartyName, PartyType, ContactPerson, Phone, Phone2, Email,
        Address, TaxNumber, OpeningBalance, BalanceType, Notes,
        NationalID, FloorNumber, ReferralSourceID, ReferralSourceClient,
        CustomerStage, StageID, JobTitle, ParentPartyID, City, Area, ContactSourceID,
        IsActive, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.PartyID
      VALUES (
        @partyName, @partyType, @contactPerson, @phone, @phone2, @email,
        @address, @taxNumber, @openingBalance, @balanceType, @notes,
        @nationalId, @floorNumber, @referralSourceId, @referralSourceClient,
        ISNULL(@customerStage, N'Lead'), @stageId, @jobTitle, @parentPartyId, @city, @area, @contactSourceId,
        1, @createdBy, GETDATE()
      )
    `);
  const partyId = result.recordset[0].PartyID;
  await syncPartyContacts(pool, partyId, clientData.contacts, clientData.createdBy, true);
  return partyId;
}

// تعديل عميل — الحقول الكاملة + LastUpdatedBy/At كما في بلازور.
async function updateClient(id, clientData) {
  const pool = await connectDB();
  await bindPartyFields(pool.request(), clientData)
    .input('id', sql.Int, id)
    .input('updatedBy', sql.NVarChar(100), clientData.updatedBy || clientData.createdBy || null)
    .query(`
      UPDATE Parties SET
        PartyName = @partyName, PartyType = @partyType, ContactPerson = @contactPerson,
        Phone = @phone, Phone2 = @phone2, Email = @email,
        Address = @address, TaxNumber = @taxNumber,
        OpeningBalance = @openingBalance, BalanceType = @balanceType,
        Notes = @notes, NationalID = @nationalId, FloorNumber = @floorNumber,
        ReferralSourceID = @referralSourceId, ReferralSourceClient = @referralSourceClient,
        CustomerStage = @customerStage, StageID = @stageId, JobTitle = @jobTitle,
        ParentPartyID = @parentPartyId, City = @city, Area = @area, ContactSourceID = @contactSourceId,
        LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE()
      WHERE PartyID = @id
    `);
  await syncPartyContacts(pool, Number(id), clientData.contacts, clientData.updatedBy || clientData.createdBy, false);
  return true;
}

// قوائم مرجعية من جداول بلازور نفسها (شكل الجداول الأصلي — القوائم
// العامة في وحدات أخرى لها أشكال مختلفة فلا تصلح هنا).
async function getPartyTypes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT PartyTypeID, PartyTypeName FROM PartyTypes ORDER BY PartyTypeID`);
  return result.recordset;
}

async function getSalesStages() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT StageID, StageName, StageNameAr, StageOrder, StageColor
      FROM SalesStages WHERE ISNULL(IsActive, 1) = 1 ORDER BY StageOrder, StageID
    `);
  return result.recordset;
}

async function getContactSources() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT SourceID, SourceName, SourceNameAr, SourceIcon, IsB2B
      FROM ContactSources WHERE ISNULL(IsActive, 1) = 1 ORDER BY SourceName
    `);
  return result.recordset;
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

// التحقق من وجود رقم الهاتف
async function checkPhoneExists(phone, phone2 = null, excludeId = null) {
  const pool = await connectDB();
  const request = pool.request();
  
  let conditions = [];
  
  if (phone) {
    request.input('phone', sql.NVarChar(50), phone);
    conditions.push('(Phone = @phone OR Phone2 = @phone)');
  }
  
  if (phone2) {
    request.input('phone2', sql.NVarChar(50), phone2);
    conditions.push('(Phone = @phone2 OR Phone2 = @phone2)');
  }
  
  if (conditions.length === 0) {
    return null;
  }
  
  let query = `
    SELECT PartyID, PartyName, Phone, Phone2 
    FROM Parties 
    WHERE IsActive = 1 AND PartyType = 1 AND (${conditions.join(' OR ')})
  `;
  
  if (excludeId) {
    request.input('excludeId', sql.Int, excludeId);
    query += ` AND PartyID != @excludeId`;
  }
  
  const result = await request.query(query);
  return result.recordset.length > 0 ? result.recordset[0] : null;
}

// تصدير الدوال
module.exports = {
  getAllClients,
  getClientsList,
  searchClients,
  getClientsSummary,
  getClientById,
  checkClientNameExists,
  checkPhoneExists,
  createClient,
  updateClient,
  checkClientHasTransactions,
  deleteClient,
  getReferralSources,
  getPartyTypes,
  getSalesStages,
  getContactSources
};