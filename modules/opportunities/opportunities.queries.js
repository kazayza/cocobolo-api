const { sql, connectDB } = require('../../core/database');

// ===================================
// 📋 Lookups (الجداول المرجعية)
// ===================================

async function getStages() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT StageID, StageName, StageNameAr, StageOrder, StageColor FROM SalesStages WHERE IsActive = 1 ORDER BY StageOrder`);
  return result.recordset;
}

async function getSources() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT SourceID, SourceName, SourceNameAr, SourceIcon FROM ContactSources WHERE IsActive = 1 ORDER BY SourceName`);
  return result.recordset;
}

async function getStatuses() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT StatusID, StatusName, StatusNameAr FROM ContactStatus WHERE IsActive = 1 ORDER BY StatusID`);
  return result.recordset;
}

async function getAdTypes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT AdTypeID, AdTypeName, AdTypeNameAr FROM AdTypes WHERE IsActive = 1 ORDER BY AdTypeName`);
  return result.recordset;
}

async function getCategories() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT CategoryID, CategoryName, CategoryNameAr FROM InterestCategories WHERE IsActive = 1 ORDER BY CategoryName`);
  return result.recordset;
}

async function getLostReasons() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT LostReasonID, ReasonName, ReasonNameAr FROM LostReasons WHERE IsActive = 1 ORDER BY ReasonName`);
  return result.recordset;
}

async function getTaskTypes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT TaskTypeID, TaskTypeName, TaskTypeNameAr FROM TaskTypes WHERE IsActive = 1 ORDER BY TaskTypeName`);
  return result.recordset;
}

async function getEmployees() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`SELECT EmployeeID, FullName, JobTitle FROM Employees WHERE Status = N'نشط' ORDER BY FullName`);
  return result.recordset;
}

// ===================================
// 📊 الإحصائيات (Summary)
// ===================================

// ملخص الفرص (معدل ليقبل الفلاتر)
async function getOpportunitiesSummary(filters = {}) {
  const pool = await connectDB();
  const { employeeId, sourceId, adTypeId } = filters;
  
  let whereClause = `WHERE IsActive = 1`;
  const request = pool.request();

  if (employeeId) {
    whereClause += ` AND EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }
  if (sourceId) {
    whereClause += ` AND SourceID = @sourceId`;
    request.input('sourceId', sql.Int, sourceId);
  }
  if (adTypeId) {
    whereClause += ` AND AdTypeID = @adTypeId`;
    request.input('adTypeId', sql.Int, adTypeId);
  }

  const result = await request.query(`
    SELECT 
      COUNT(*) as totalOpportunities,
      SUM(CASE WHEN StageID = 1 THEN 1 ELSE 0 END) as leadCount,
      SUM(CASE WHEN StageID = 2 THEN 1 ELSE 0 END) as potentialCount,
      SUM(CASE WHEN StageID = 3 THEN 1 ELSE 0 END) as closedCount,
      SUM(CASE WHEN StageID = 4 THEN 1 ELSE 0 END) as lostCount, -- ✅ الخسارة
      SUM(CASE WHEN StageID = 5 THEN 1 ELSE 0 END) as notInterestedCount,
      SUM(CASE WHEN CAST(NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) as todayFollowUp,
      SUM(CASE WHEN CAST(NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) AND StageID NOT IN (3,4,5) THEN 1 ELSE 0 END) as overdueFollowUp
    FROM SalesOpportunities
    ${whereClause}
  `);
  return result.recordset[0];
}

// ===================================
// 🎯 الفرص - CRUD
// ===================================

// جلب كل الفرص (معدل بالكامل)
async function getAllOpportunities(filters = {}) {
  const pool = await connectDB();
  const { search, stageId, sourceId, adTypeId, employeeId, followUpStatus, sortBy } = filters;

  let query = `
    SELECT 
      o.OpportunityID, o.PartyID, p.PartyName AS ClientName,
      p.Phone AS Phone1, p.Phone2, p.Address, p.Email,
      
      -- ✅ اسم صاحب الفرصة
      o.EmployeeID, e.FullName AS EmployeeName,
      
      -- بيانات المصدر
      o.SourceID, cs.SourceName, cs.SourceNameAr, cs.SourceIcon,
      
      -- ✅ بيانات الحملة الإعلانية
      o.AdTypeID, at.AdTypeName, at.AdTypeNameAr,
      
      -- بيانات الفئة
      o.CategoryID, ic.CategoryName, ic.CategoryNameAr,
      
      -- ✅ عدد التواصلات (Subquery)
      (SELECT COUNT(*) FROM CustomerInteractions ci WHERE ci.OpportunityID = o.OpportunityID) AS InteractionCount,
      
      -- باقي البيانات
      o.StageID, ss.StageName, ss.StageNameAr, ss.StageColor, ss.StageOrder,
      o.StatusID, cst.StatusName, cst.StatusNameAr,
      o.InterestedProduct, o.ExpectedValue, o.Location,
      o.FirstContactDate, o.NextFollowUpDate, o.LastContactDate,
      o.Notes, o.Guidance, o.CreatedBy, o.CreatedAt,
      
      DATEDIFF(DAY, o.FirstContactDate, GETDATE()) AS DaysSinceFirstContact,
      
      CASE 
        WHEN o.NextFollowUpDate IS NULL THEN N'NotSet'
        WHEN CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'Overdue'
        WHEN CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN N'Today'
        WHEN CAST(o.NextFollowUpDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN N'Tomorrow'
        WHEN CAST(o.NextFollowUpDate AS DATE) > DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN N'Upcoming'
        ELSE N'Upcoming'
      END AS FollowUpStatus

    FROM SalesOpportunities o
    LEFT JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
    LEFT JOIN AdTypes at ON o.AdTypeID = at.AdTypeID
    LEFT JOIN InterestCategories ic ON o.CategoryID = ic.CategoryID
    LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
    LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
    
    WHERE o.IsActive = 1
  `;

  const request = pool.request();

  if (search && search.trim() !== '') {
    query += ` AND (p.PartyName LIKE @search OR p.Phone LIKE @search OR o.InterestedProduct LIKE @search)`;
    request.input('search', sql.NVarChar, `%${search}%`);
  }

  if (stageId && stageId !== '0') {
    query += ` AND o.StageID = @stageId`;
    request.input('stageId', sql.Int, stageId);
  }

  if (sourceId && sourceId !== '0') {
    query += ` AND o.SourceID = @sourceId`;
    request.input('sourceId', sql.Int, sourceId);
  }

  // ✅ فلتر الحملة الإعلانية
  if (adTypeId && adTypeId !== '0') {
    query += ` AND o.AdTypeID = @adTypeId`;
    request.input('adTypeId', sql.Int, adTypeId);
  }

  // ✅ فلتر الموظف
  if (employeeId && employeeId !== '0') {
    query += ` AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }

  if (followUpStatus) {
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

  // ✅ الترتيب
  if (sortBy) {
    switch (sortBy) {
      case 'newest': query += ` ORDER BY o.CreatedAt DESC`; break;
      case 'oldest': query += ` ORDER BY o.CreatedAt ASC`; break;
      case 'value_high': query += ` ORDER BY o.ExpectedValue DESC`; break;
      case 'value_low': query += ` ORDER BY o.ExpectedValue ASC`; break;
      case 'name': query += ` ORDER BY p.PartyName ASC`; break;
      default: query += ` ORDER BY ss.StageOrder, o.NextFollowUpDate`;
    }
  } else {
    query += ` ORDER BY ss.StageOrder, o.NextFollowUpDate, o.CreatedAt DESC`;
  }

  const result = await request.query(query);
  return result.recordset;
}

// باقي الدوال زي ما هي (checkOpenOpportunity, getOpportunityById, createOpportunity, updateOpportunity, updateOpportunityStage, deleteOpportunity)
// ... (أضفها هنا عشان الكود يبقى كامل لو نسخت الملف كله) ...

async function checkOpenOpportunity(partyId) {
  const pool = await connectDB();
  const result = await pool.request().input('partyId', sql.Int, partyId).query(`SELECT TOP 1 * FROM SalesOpportunities WHERE PartyID = @partyId AND IsActive = 1 AND StageID NOT IN (3, 4, 5) ORDER BY CreatedAt DESC`);
  return { hasOpenOpportunity: result.recordset.length > 0, opportunity: result.recordset[0] || null };
}

async function getOpportunityById(id) {
  const pool = await connectDB();
  const result = await pool.request().input('id', sql.Int, id).query(`SELECT o.*, p.PartyName AS ClientName, p.Phone AS Phone1 FROM SalesOpportunities o LEFT JOIN Parties p ON o.PartyID = p.PartyID WHERE o.OpportunityID = @id`);
  return result.recordset[0] || null;
}

async function createOpportunity(data) {
  // ... (نفس كود الإضافة القديم)
}

async function updateOpportunity(id, data) {
  // ... (نفس كود التعديل القديم)
}

async function updateOpportunityStage(id, stageId, updatedBy) {
  const pool = await connectDB();
  await pool.request().input('id', sql.Int, id).input('stageId', sql.Int, stageId).input('updatedBy', sql.NVarChar(50), updatedBy).query(`UPDATE SalesOpportunities SET StageID = @stageId, LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE() WHERE OpportunityID = @id`);
  return true;
}

async function deleteOpportunity(id) {
  const pool = await connectDB();
  await pool.request().input('id', sql.Int, id).query('UPDATE SalesOpportunities SET IsActive = 0 WHERE OpportunityID = @id');
  return true;
}

// تصدير الدوال
module.exports = {
  getStages, getSources, getStatuses, getAdTypes, getCategories, getLostReasons, getTaskTypes, getEmployees,
  getOpportunitiesSummary,
  getAllOpportunities, checkOpenOpportunity, getOpportunityById, createOpportunity, updateOpportunity, updateOpportunityStage, deleteOpportunity
};