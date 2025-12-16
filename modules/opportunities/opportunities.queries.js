const { sql, connectDB } = require('../../core/database');

// ===================================
// 📋 Lookups
// ===================================

// جلب مراحل البيع
async function getStages() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT StageID, StageName, StageNameAr, StageOrder, StageColor FROM SalesStages WHERE IsActive = 1 ORDER BY StageOrder`);
  return result.recordset;
}

// جلب مصادر التواصل
async function getSources() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT SourceID, SourceName, SourceNameAr, SourceIcon FROM ContactSources WHERE IsActive = 1 ORDER BY SourceName`);
  return result.recordset;
}

// جلب حالات التواصل
async function getStatuses() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT StatusID, StatusName, StatusNameAr FROM ContactStatus WHERE IsActive = 1 ORDER BY StatusID`);
  return result.recordset;
}

// جلب أنواع الإعلانات
async function getAdTypes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT AdTypeID, AdTypeName, AdTypeNameAr FROM AdTypes WHERE IsActive = 1 ORDER BY AdTypeName`);
  return result.recordset;
}

// جلب فئات الاهتمام
async function getCategories() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT CategoryID, CategoryName, CategoryNameAr FROM InterestCategories WHERE IsActive = 1 ORDER BY CategoryName`);
  return result.recordset;
}

// جلب أسباب الخسارة
async function getLostReasons() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT LostReasonID, ReasonName, ReasonNameAr FROM LostReasons WHERE IsActive = 1 ORDER BY ReasonName`);
  return result.recordset;
}

// جلب أنواع المهام
async function getTaskTypes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT TaskTypeID, TaskTypeName, TaskTypeNameAr FROM TaskTypes WHERE IsActive = 1 ORDER BY TaskTypeName`);
  return result.recordset;
}

// جلب الموظفين
async function getEmployees() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT EmployeeID, FullName, JobTitle FROM Employees WHERE Status = N'نشط' ORDER BY FullName`);
  return result.recordset;
}

// ===================================
// 📊 الإحصائيات
// ===================================

// ملخص الفرص
async function getOpportunitiesSummary() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT 
        COUNT(*) as totalOpportunities,
        SUM(CASE WHEN StageID = 1 THEN 1 ELSE 0 END) as leadCount,
        SUM(CASE WHEN StageID = 2 THEN 1 ELSE 0 END) as potentialCount,
        SUM(CASE WHEN StageID = 3 THEN 1 ELSE 0 END) as closedCount,
        SUM(CASE WHEN StageID = 4 THEN 1 ELSE 0 END) as lostCount,
        SUM(CASE WHEN StageID = 5 THEN 1 ELSE 0 END) as notInterestedCount,
        SUM(CASE WHEN CAST(NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) as todayFollowUp,
        SUM(CASE WHEN CAST(NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) AND StageID NOT IN (3,4,5) THEN 1 ELSE 0 END) as overdueFollowUp,
        ISNULL(SUM(CASE WHEN StageID = 3 THEN ExpectedValue ELSE 0 END), 0) as totalClosedValue
      FROM SalesOpportunities WHERE IsActive = 1
    `);
  return result.recordset[0];
}

// ===================================
// 🎯 الفرص - CRUD
// ===================================

// جلب كل الفرص مع الفلترة
async function getAllOpportunities(filters = {}) {
  const pool = await connectDB();
  const { search, stageId, sourceId, employeeId, followUpStatus } = filters;

  let query = `
    SELECT 
      o.OpportunityID, o.PartyID, p.PartyName AS ClientName,
      p.Phone AS Phone1, p.Phone2, p.Address,
      o.EmployeeID, e.FullName AS EmployeeName,
      o.SourceID, cs.SourceName, cs.SourceNameAr, cs.SourceIcon,
      o.StageID, ss.StageName, ss.StageNameAr, ss.StageColor, ss.StageOrder,
      o.StatusID, cst.StatusName, cst.StatusNameAr,
      o.InterestedProduct, o.ExpectedValue, o.Location,
      o.FirstContactDate, o.NextFollowUpDate, o.LastContactDate,
      o.Notes, o.CreatedBy, o.CreatedAt,
      DATEDIFF(DAY, o.FirstContactDate, GETDATE()) AS DaysSinceFirstContact,
      CASE 
        WHEN o.NextFollowUpDate IS NULL THEN N'NotSet'
        WHEN CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'Overdue'
        WHEN CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN N'Today'
        WHEN CAST(o.NextFollowUpDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN N'Tomorrow'
        ELSE N'Upcoming'
      END AS FollowUpStatus
    FROM SalesOpportunities o
    LEFT JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
    LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
    LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
    WHERE o.IsActive = 1
  `;

  const request = pool.request();

  if (search && search.trim() !== '') {
    query += ` AND (p.PartyName LIKE @search OR p.Phone LIKE @search OR o.InterestedProduct LIKE @search)`;
    request.input('search', sql.NVarChar, `%${search}%`);
  }

  if (stageId && stageId !== '' && stageId !== '0') {
    query += ` AND o.StageID = @stageId`;
    request.input('stageId', sql.Int, stageId);
  }

  if (sourceId && sourceId !== '' && sourceId !== '0') {
    query += ` AND o.SourceID = @sourceId`;
    request.input('sourceId', sql.Int, sourceId);
  }

  if (employeeId && employeeId !== '' && employeeId !== '0') {
    query += ` AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }

  if (followUpStatus && followUpStatus !== '') {
    switch (followUpStatus) {
      case 'Overdue':
        query += ` AND CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) AND o.StageID NOT IN (3,4,5)`;
        break;
      case 'Today':
        query += ` AND CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE)`;
        break;
      case 'Tomorrow':
        query += ` AND CAST(o.NextFollowUpDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE))`;
        break;
      case 'Upcoming':
        query += ` AND CAST(o.NextFollowUpDate AS DATE) > DATEADD(DAY, 1, CAST(GETDATE() AS DATE))`;
        break;
    }
  }

  query += ` ORDER BY ss.StageOrder, o.NextFollowUpDate, o.CreatedAt DESC`;

  const result = await request.query(query);
  return result.recordset;
}

// التحقق من وجود فرصة مفتوحة للعميل
async function checkOpenOpportunity(partyId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('partyId', sql.Int, partyId)
    .query(`
      SELECT TOP 1 
        o.OpportunityID, o.EmployeeID, o.SourceID, o.AdTypeID,
        o.StageID, o.StatusID, o.CategoryID, o.InterestedProduct,
        o.ExpectedValue, o.Notes, o.Guidance,
        e.FullName AS EmployeeName, ss.StageNameAr
      FROM SalesOpportunities o
      LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
      LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
      WHERE o.PartyID = @partyId AND o.IsActive = 1 AND o.StageID NOT IN (3, 4, 5)
      ORDER BY o.CreatedAt DESC
    `);

  return {
    hasOpenOpportunity: result.recordset.length > 0,
    opportunity: result.recordset[0] || null
  };
}

// جلب فرصة بالـ ID
async function getOpportunityById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        o.*, p.PartyName AS ClientName, p.Phone AS Phone1, p.Phone2, p.Email, p.Address,
        e.FullName AS EmployeeName,
        cs.SourceName, cs.SourceNameAr, cs.SourceIcon,
        ss.StageName, ss.StageNameAr, ss.StageColor,
        cst.StatusName, cst.StatusNameAr,
        lr.ReasonName AS LostReasonName, lr.ReasonNameAr AS LostReasonNameAr
      FROM SalesOpportunities o
      LEFT JOIN Parties p ON o.PartyID = p.PartyID
      LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
      LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
      LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
      LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
      LEFT JOIN LostReasons lr ON o.LostReasonID = lr.LostReasonID
      WHERE o.OpportunityID = @id
    `);
  return result.recordset[0] || null;
}

// إضافة فرصة جديدة
async function createOpportunity(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('partyId', sql.Int, data.partyId)
    .input('employeeId', sql.Int, data.employeeId || null)
    .input('sourceId', sql.Int, data.sourceId || null)
    .input('stageId', sql.Int, data.stageId || 1)
    .input('statusId', sql.Int, data.statusId || 1)
    .input('interestedProduct', sql.NVarChar(200), data.interestedProduct || null)
    .input('expectedValue', sql.Decimal(18, 2), data.expectedValue || 0)
    .input('location', sql.NVarChar(200), data.location || null)
    .input('nextFollowUpDate', sql.DateTime, data.nextFollowUpDate || null)
    .input('notes', sql.NVarChar(500), data.notes || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO SalesOpportunities (
        PartyID, EmployeeID, SourceID, StageID, StatusID,
        InterestedProduct, ExpectedValue, Location,
        FirstContactDate, NextFollowUpDate, Notes,
        IsActive, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.OpportunityID
      VALUES (
        @partyId, @employeeId, @sourceId, @stageId, @statusId,
        @interestedProduct, @expectedValue, @location,
        GETDATE(), @nextFollowUpDate, @notes,
        1, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].OpportunityID;
}

// تعديل فرصة
async function updateOpportunity(id, data) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('partyId', sql.Int, data.partyId)
    .input('employeeId', sql.Int, data.employeeId || null)
    .input('sourceId', sql.Int, data.sourceId || null)
    .input('stageId', sql.Int, data.stageId)
    .input('statusId', sql.Int, data.statusId || null)
    .input('interestedProduct', sql.NVarChar(200), data.interestedProduct || null)
    .input('expectedValue', sql.Decimal(18, 2), data.expectedValue || 0)
    .input('location', sql.NVarChar(200), data.location || null)
    .input('nextFollowUpDate', sql.DateTime, data.nextFollowUpDate || null)
    .input('notes', sql.NVarChar(500), data.notes || null)
    .input('lostReasonId', sql.Int, data.lostReasonId || null)
    .input('lostNotes', sql.NVarChar(500), data.lostNotes || null)
    .input('updatedBy', sql.NVarChar(50), data.updatedBy)
    .query(`
      UPDATE SalesOpportunities SET
        PartyID = @partyId, EmployeeID = @employeeId, SourceID = @sourceId,
        StageID = @stageId, StatusID = @statusId,
        InterestedProduct = @interestedProduct, ExpectedValue = @expectedValue,
        Location = @location, NextFollowUpDate = @nextFollowUpDate,
        Notes = @notes, LostReasonID = @lostReasonId, LostNotes = @lostNotes,
        LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE()
      WHERE OpportunityID = @id
    `);
  return true;
}

// تغيير مرحلة الفرصة
async function updateOpportunityStage(id, stageId, updatedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('stageId', sql.Int, stageId)
    .input('updatedBy', sql.NVarChar(50), updatedBy)
    .query(`
      UPDATE SalesOpportunities SET
        StageID = @stageId, LastContactDate = GETDATE(),
        LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE()
      WHERE OpportunityID = @id
    `);
  return true;
}

// حذف فرصة (Soft Delete)
async function deleteOpportunity(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('UPDATE SalesOpportunities SET IsActive = 0 WHERE OpportunityID = @id');
  return true;
}

// تصدير الدوال
module.exports = {
  // Lookups
  getStages,
  getSources,
  getStatuses,
  getAdTypes,
  getCategories,
  getLostReasons,
  getTaskTypes,
  getEmployees,
  // Summary
  getOpportunitiesSummary,
  // CRUD
  getAllOpportunities,
  checkOpenOpportunity,
  getOpportunityById,
  createOpportunity,
  updateOpportunity,
  updateOpportunityStage,
  deleteOpportunity
};