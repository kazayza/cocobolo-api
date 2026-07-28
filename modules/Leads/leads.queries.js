const { sql, connectDB } = require('../../core/database');

// جلب الـ Leads مع الفلاتر والبحث
async function getLeads(filters = {}) {
  const pool = await connectDB();
  let query = `
    SELECT 
      l.LeadId, l.FullName, l.Phone, l.Phone2, l.Email,
      l.City, l.CampaignName, l.AdName, l.FormName, l.Platform,
      l.LeadStatus, l.IsConverted, l.AssignedEmployeeId,
      e.FullName AS EmployeeName,
      FORMAT(l.LeadDate, 'yyyy-MM-dd hh:mm tt') as LeadDate,
      FORMAT(l.CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt,
      l.Notes, l.Feedback
    FROM LeadsCRM l
    LEFT JOIN Employees e ON l.AssignedEmployeeId = e.EmployeeID
    WHERE 1=1
  `;

  const request = pool.request();

  if (filters.status && filters.status !== 'الكل') {
    request.input('status', sql.NVarChar(50), filters.status);
    query += ` AND l.LeadStatus = @status`;
  }

  if (filters.search && filters.search.trim() !== '') {
    request.input('search', sql.NVarChar(100), `%${filters.search}%`);
    query += ` AND (l.FullName LIKE @search OR l.Phone LIKE @search OR l.CampaignName LIKE @search)`;
  }

  query += ` ORDER BY l.LeadId DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// جلب تفاصيل Lead معين
async function getLeadById(leadId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .query(`
      SELECT l.*, e.FullName AS EmployeeName
      FROM LeadsCRM l
      LEFT JOIN Employees e ON l.AssignedEmployeeId = e.EmployeeID
      WHERE l.LeadId = @leadId
    `);
  return result.recordset[0] || null;
}

// تحديث بيانات الـ Lead (الحالة، الملاحظات، الموظف المسؤول)
async function updateLead(leadId, data) {
  const pool = await connectDB();
  await pool.request()
    .input('leadId', sql.Int, leadId)
    .input('status', sql.NVarChar(50), data.leadStatus)
    .input('employeeId', sql.Int, data.assignedEmployeeId || null)
    .input('notes', sql.NVarChar(sql.MAX), data.notes || null)
    .input('feedback', sql.NVarChar(sql.MAX), data.feedback || null)
    .query(`
      UPDATE LeadsCRM 
      SET LeadStatus = @status,
          AssignedEmployeeId = @employeeId,
          Notes = @notes,
          Feedback = @feedback
      WHERE LeadId = @leadId
    `);
  return true;
}

// تحويل Lead إلى عميل (Party + SalesOpportunity + Interaction)
async function convertLeadToClient(leadId, dto, userName) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    // 1. جلب بيانات الـ Lead
    const leadResult = await transaction.request()
      .input('leadId', sql.Int, leadId)
      .query(`SELECT * FROM LeadsCRM WHERE LeadId = @leadId`);
    const lead = leadResult.recordset[0];

    if (!lead) throw new Error('العميل المحتمل غير موجود');

    // 2. إنشاء عميل جديد في Parties
    const partyResult = await transaction.request()
      .input('partyName', sql.NVarChar(200), lead.FullName)
      .input('phone', sql.NVarChar(50), lead.Phone)
      .input('phone2', sql.NVarChar(50), lead.Phone2 || null)
      .input('email', sql.NVarChar(100), lead.Email || null)
      .input('address', sql.NVarChar(500), lead.Address || lead.City || null)
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO Parties (PartyName, Phone, Phone2, Email, Address, PartyType, IsActive, CreatedBy, CreatedAt)
        OUTPUT INSERTED.PartyID
        VALUES (@partyName, @phone, @phone2, @email, @address, 1, 1, @createdBy, GETDATE())
      `);
    const partyId = partyResult.recordset[0].PartyID;

    // 3. إنشاء فرصة مبيعات في SalesOpportunities
    const oppResult = await transaction.request()
      .input('partyId', sql.Int, partyId)
      .input('employeeId', sql.Int, dto.employeeId || lead.AssignedEmployeeId || 1)
      .input('expectedValue', sql.Decimal(18,2), dto.expectedValue || 0)
      .input('notes', sql.NVarChar(sql.MAX), dto.notes || lead.Notes || 'مستورد من إعلانات Meta')
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO SalesOpportunities (
          PartyID, EmployeeID, StageID, ExpectedValue, Notes, IsActive, CreatedBy, CreatedAt, FirstContactDate
        )
        OUTPUT INSERTED.OpportunityID
        VALUES (
          @partyId, @employeeId, 1, @expectedValue, @notes, 1, @createdBy, GETDATE(), GETDATE()
        )
      `);
    const opportunityId = oppResult.recordset[0].OpportunityID;

    // 4. تحديث حالة الـ Lead بأنه تم التحويل
    await transaction.request()
      .input('leadId', sql.Int, leadId)
      .input('partyId', sql.Int, partyId)
      .input('oppId', sql.Int, opportunityId)
      .query(`
        UPDATE LeadsCRM 
        SET IsConverted = 1,
            LeadStatus = N'محوّل',
            ConvertedPartyId = @partyId,
            ConvertedOpportunityId = @oppId,
            ConvertedDate = GETDATE()
        WHERE LeadId = @leadId
      `);

    await transaction.commit();
    return { success: true, partyId, opportunityId };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}
// ===================================
// 📞 تفاعلات الـ Leads (LeadsInteraction)
// ===================================

// جلب تفاعلات Lead معين
async function getLeadInteractions(leadId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .query(`
      SELECT 
        InteractionID, LeadID, InteractionType, Notes,
        CreatedBy, FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt
      FROM LeadsInteraction
      WHERE LeadID = @leadId
      ORDER BY InteractionID DESC
    `);
  return result.recordset;
}

// إضافة تفاعل جديد لـ Lead
async function addLeadInteraction(leadId, data, userName) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('leadId', sql.Int, leadId)
    .input('type', sql.NVarChar(50), data.interactionType || 'مكالمة')
    .input('notes', sql.NVarChar(sql.MAX), data.notes)
    .input('userName', sql.NVarChar(100), userName)
    .query(`
      INSERT INTO LeadsInteraction (LeadID, InteractionType, Notes, CreatedBy, CreatedAt)
      OUTPUT INSERTED.InteractionID
      VALUES (@leadId, @type, @notes, @userName, GETDATE())
    `);
  return result.recordset[0].InteractionID;
}

module.exports = {
  getLeads,
  getLeadById,
  updateLead,
  convertLeadToClient,
  getLeadInteractions,
  addLeadInteraction
};

