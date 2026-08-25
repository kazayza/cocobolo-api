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
// 📊 الإحصائيات (Summary) - محدث
// ===================================

async function getOpportunitiesSummary(filters = {}) {
  const pool = await connectDB();
  const { employeeId, sourceId, adTypeId, stageId, dateFrom, dateTo } = filters;
  
  // 1️⃣ إعداد الفلاتر المشتركة
  let whereClause = `WHERE o.IsActive = 1`;
  const request = pool.request();

  if (employeeId && employeeId !== 'null') {
    whereClause += ` AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }
  if (sourceId && sourceId !== 'null') {
    whereClause += ` AND o.SourceID = @sourceId`;
    request.input('sourceId', sql.Int, sourceId);
  }
  if (adTypeId && adTypeId !== 'null') {
    whereClause += ` AND o.AdTypeID = @adTypeId`;
    request.input('adTypeId', sql.Int, adTypeId);
  }
  if (stageId && stageId !== 'null') {
    whereClause += ` AND o.StageID = @stageId`;
    request.input('stageId', sql.Int, stageId);
  }
  if (dateFrom) {
    whereClause += ` AND CAST(o.CreatedAt AS DATE) >= @dateFrom`;
    request.input('dateFrom', sql.Date, dateFrom);
  }
  if (dateTo) {
    whereClause += ` AND CAST(o.CreatedAt AS DATE) <= @dateTo`;
    request.input('dateTo', sql.Date, dateTo);
  }

  // 2️⃣ الاستعلام الرئيسي (أعداد وقيم)
  const mainQuery = `
    SELECT 
      COUNT(*) as totalOpportunities,
      
      -- مراحل البيع
      SUM(CASE WHEN o.StageID = 1 THEN 1 ELSE 0 END) as leadCount,
      SUM(CASE WHEN o.StageID = 2 THEN 1 ELSE 0 END) as potentialCount,
      SUM(CASE WHEN o.StageID = 7 THEN 1 ELSE 0 END) as highInterestCount,
      SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) as wonCount,
      SUM(CASE WHEN o.StageID IN (4, 5) THEN 1 ELSE 0 END) as lostCount,

      -- المتابعة
      SUM(CASE WHEN CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) AND o.StageID NOT IN (3,4,5) THEN 1 ELSE 0 END) as overdueCount,
      SUM(CASE WHEN CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) as todayCount,
      
      -- الجدد هذا الشهر
      SUM(CASE WHEN MONTH(o.CreatedAt) = MONTH(GETDATE()) AND YEAR(o.CreatedAt) = YEAR(GETDATE()) THEN 1 ELSE 0 END) as newThisMonth,
      
      -- 💰 القيم المالية
      ISNULL(SUM(o.ExpectedValue), 0) as totalExpectedValue,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) as wonValue

    FROM SalesOpportunities o
    ${whereClause}
  `;

  // 3️⃣ استعلام المصادر (Top 5)
  const sourcesQuery = `
    SELECT TOP 5 cs.SourceNameAr as name, COUNT(*) as count
    FROM SalesOpportunities o
    LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
    ${whereClause}
    GROUP BY cs.SourceNameAr
    ORDER BY count DESC
  `;

  // 4️⃣ استعلام الحملات (Top 5)
  const adsQuery = `
    SELECT TOP 5 at.AdTypeNameAr as name, COUNT(*) as count
    FROM SalesOpportunities o
    LEFT JOIN AdTypes at ON o.AdTypeID = at.AdTypeID
    ${whereClause}
    GROUP BY at.AdTypeNameAr
    ORDER BY count DESC
  `;

  // تنفيذ الاستعلامات
  const mainResult = await request.query(mainQuery);
  const sourcesResult = await request.query(sourcesQuery);
  const adsResult = await request.query(adsQuery);

  return {
    stats: mainResult.recordset[0],
    topSources: sourcesResult.recordset,
    topCampaigns: adsResult.recordset
  };
}

// ===================================
// 🎯 الفرص - CRUD
// ===================================

async function getAllOpportunities(filters = {}) {
  const pool = await connectDB();
  const { 
    search, 
    stageId, 
    sourceId, 
    adTypeId, 
    employeeId, 
    followUpStatus, 
    sortBy,
    dateFrom,    // ✅ جديد
    dateTo,
    page = 1,
    limit = 30
  } = filters;

  const offset = (page - 1) * limit;

  let query = `
    SELECT 
      o.OpportunityID, o.PartyID, p.PartyName AS ClientName,
      p.Phone AS Phone1, p.Phone2, p.Address, p.Email,
      
      o.EmployeeID, e.FullName AS EmployeeName,
      
      o.SourceID, cs.SourceName, cs.SourceNameAr, cs.SourceIcon,
      
      o.AdTypeID, at.AdTypeName, at.AdTypeNameAr,
      
      o.CategoryID, ic.CategoryName, ic.CategoryNameAr,
      
      (SELECT COUNT(*) FROM CustomerInteractions ci WHERE ci.OpportunityID = o.OpportunityID) AS InteractionCount,
      
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

  // 🔍 فلتر البحث
  if (search && search.trim() !== '') {
    query += ` AND (p.PartyName LIKE @search OR p.Phone LIKE @search OR o.InterestedProduct LIKE @search)`;
    request.input('search', sql.NVarChar, `%${search}%`);
  }

  // 🎯 فلتر المرحلة
  if (stageId && stageId !== '0') {
    query += ` AND o.StageID = @stageId`;
    request.input('stageId', sql.Int, stageId);
  }

  // 📱 فلتر المصدر
  if (sourceId && sourceId !== '0') {
    query += ` AND o.SourceID = @sourceId`;
    request.input('sourceId', sql.Int, sourceId);
  }

  // 📢 فلتر الحملة الإعلانية
  if (adTypeId && adTypeId !== '0') {
    query += ` AND o.AdTypeID = @adTypeId`;
    request.input('adTypeId', sql.Int, adTypeId);
  }

  // 👤 فلتر الموظف
  if (employeeId && employeeId !== '0') {
    query += ` AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }

  // 📅 فلتر التاريخ (من)
  if (dateFrom) {
    query += ` AND CAST(o.CreatedAt AS DATE) >= @dateFrom`;
    request.input('dateFrom', sql.Date, dateFrom);
  }

  // 📅 فلتر التاريخ (إلى)
  if (dateTo) {
    query += ` AND CAST(o.CreatedAt AS DATE) <= @dateTo`;
    request.input('dateTo', sql.Date, dateTo);
  }

  // ⏰ فلتر حالة المتابعة
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

  // 📊 الترتيب
  if (sortBy) {
    switch (sortBy) {
      case 'newest': 
        query += ` ORDER BY o.CreatedAt DESC`; 
        break;
      case 'oldest': 
        query += ` ORDER BY o.CreatedAt ASC`; 
        break;
      case 'value_high': 
        query += ` ORDER BY o.ExpectedValue DESC`; 
        break;
      case 'value_low': 
        query += ` ORDER BY o.ExpectedValue ASC`; 
        break;
      case 'name': 
        query += ` ORDER BY p.PartyName ASC`; 
        break;
      case 'followup':
        query += ` ORDER BY o.NextFollowUpDate ASC`;
        break;
      case 'stage':
        query += ` ORDER BY ss.StageOrder, o.NextFollowUpDate, o.CreatedAt DESC`;
        break;
      default: 
        query += ` ORDER BY o.CreatedAt DESC`;
    }
} else {
  query += ` ORDER BY o.CreatedAt DESC`;
}

// ✅ Pagination
query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
request.input('offset', sql.Int, offset);
request.input('limit', sql.Int, parseInt(limit));

const result = await request.query(query);
return result.recordset;
}

// ===================================
// 🔍 التحقق والبحث
// ===================================

async function checkOpenOpportunity(partyId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('partyId', sql.Int, partyId)
    .query(`
      SELECT TOP 1 * 
      FROM SalesOpportunities 
      WHERE PartyID = @partyId 
        AND IsActive = 1 
        AND StageID NOT IN (3, 4, 5) 
      ORDER BY CreatedAt DESC
    `);
  return { 
    hasOpenOpportunity: result.recordset.length > 0, 
    opportunity: result.recordset[0] || null 
  };
}

async function getOpportunityById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        o.*,
        p.PartyName AS ClientName,
        p.Phone AS Phone1,
        p.Phone2,
        p.Email,
        p.Address,
        e.FullName AS EmployeeName,
        cs.SourceName,
        cs.SourceNameAr,
        at.AdTypeName,
        at.AdTypeNameAr,
        ss.StageName,
        ss.StageNameAr,
        ss.StageColor,
        cst.StatusName,
        cst.StatusNameAr,
        ic.CategoryName,
        ic.CategoryNameAr,
        lr.ReasonName AS LostReasonName,
        lr.ReasonNameAr AS LostReasonNameAr
      FROM SalesOpportunities o
      LEFT JOIN Parties p ON o.PartyID = p.PartyID
      LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
      LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
      LEFT JOIN AdTypes at ON o.AdTypeID = at.AdTypeID
      LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
      LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
      LEFT JOIN InterestCategories ic ON o.CategoryID = ic.CategoryID
      LEFT JOIN LostReasons lr ON o.LostReasonID = lr.LostReasonID
      WHERE o.OpportunityID = @id
    `);
  return result.recordset[0] || null;
}

// ===================================
// ➕ إنشاء فرصة جديدة
// ===================================

async function createOpportunity(data) {
  const pool = await connectDB();
  const {
    partyId,
    employeeId,
    sourceId,
    adTypeId,
    categoryId,
    stageId = 1,
    statusId = 1,
    interestedProduct,
    expectedValue,
    location,
    notes,
    guidance,
    nextFollowUpDate,
    lostReasonId,      // ✅ جديد
    lostNotes,         // ✅ جديد
    createdBy
  } = data;

  const result = await pool.request()
    .input('partyId', sql.Int, partyId)
    .input('employeeId', sql.Int, employeeId)
    .input('sourceId', sql.Int, sourceId)
    .input('adTypeId', sql.Int, adTypeId || null)
    .input('categoryId', sql.Int, categoryId || null)
    .input('stageId', sql.Int, stageId)
    .input('statusId', sql.Int, statusId)
    .input('interestedProduct', sql.NVarChar(255), interestedProduct || null)
    .input('expectedValue', sql.Decimal(18, 2), expectedValue || 0)
    .input('location', sql.NVarChar(255), location || null)
    .input('notes', sql.NVarChar(sql.MAX), notes || null)
    .input('guidance', sql.NVarChar(sql.MAX), guidance || null)
    .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate ? new Date(nextFollowUpDate) : null)
    .input('lostReasonId', sql.Int, lostReasonId || null)          // ✅ جديد
    .input('lostNotes', sql.NVarChar(sql.MAX), lostNotes || null)  // ✅ جديد
    .input('createdBy', sql.NVarChar(50), createdBy)
    .query(`
      INSERT INTO SalesOpportunities (
        PartyID, EmployeeID, SourceID, AdTypeID, CategoryID,
        StageID, StatusID, InterestedProduct, ExpectedValue, Location,
        Notes, Guidance, NextFollowUpDate, FirstContactDate,
        LostReasonID, LostNotes,
        CreatedBy, CreatedAt, IsActive
      ) 
      OUTPUT INSERTED.OpportunityID
      VALUES (
        @partyId, @employeeId, @sourceId, @adTypeId, @categoryId,
        @stageId, @statusId, @interestedProduct, @expectedValue, @location,
        @notes, @guidance, @nextFollowUpDate, GETDATE(),
        @lostReasonId, @lostNotes,
        @createdBy, GETDATE(), 1
      )
    `);

  return result.recordset[0];
}

// ===================================
// ✏️ تحديث فرصة - نسخة احترافية كاملة
// ===================================

async function updateOpportunity(id, data) {
  const pool = await connectDB();
  const {
    employeeId,
    sourceId,
    adTypeId,
    categoryId,
    stageId,
    statusId,
    interestedProduct,
    expectedValue,
    location,
    notes,
    guidance,
    summary,
    nextFollowUpDate,
    firstContactDate,
    lostReasonId,
    lostNotes,
    taskTypeId,
    updatedBy
  } = data;

  // منطق مثل بلازور: لو خسارة امسح المتابعة، لو مش خسارة امسح سبب الخسارة
  const isLost = stageId == 4 || stageId == 5;
  const isClosed = stageId == 3 || stageId == 4 || stageId == 5;

  await pool.request()
    .input('id', sql.Int, id)
    .input('employeeId', sql.Int, employeeId || null)
    .input('sourceId', sql.Int, sourceId || null)
    .input('adTypeId', sql.Int, adTypeId || null)
    .input('categoryId', sql.Int, categoryId || null)
    .input('stageId', sql.Int, stageId || null)
    .input('statusId', sql.Int, statusId || null)
    .input('taskTypeId', sql.Int, taskTypeId || null)
    .input('interestedProduct', sql.NVarChar(255), interestedProduct || null)
    .input('expectedValue', sql.Decimal(18, 2), expectedValue || 0)
    .input('location', sql.NVarChar(255), location || null)
    .input('notes', sql.NVarChar(sql.MAX), notes || summary || null)
    .input('guidance', sql.NVarChar(sql.MAX), guidance || null)
    .input('nextFollowUpDate', sql.DateTime, isLost ? null : (nextFollowUpDate ? new Date(nextFollowUpDate) : null))
    .input('firstContactDate', sql.DateTime, firstContactDate ? new Date(firstContactDate) : null)
    .input('lostReasonId', sql.Int, isLost ? (lostReasonId || null) : null)
    .input('lostNotes', sql.NVarChar(sql.MAX), isLost ? (lostNotes || null) : null)
    .input('updatedBy', sql.NVarChar(50), updatedBy || 'System')
    .query(`
      UPDATE SalesOpportunities SET
        EmployeeID = COALESCE(@employeeId, EmployeeID),
        SourceID = COALESCE(@sourceId, SourceID),
        AdTypeID = @adTypeId,
        CategoryID = @categoryId,
        StageID = COALESCE(@stageId, StageID),
        StatusID = COALESCE(@statusId, StatusID),
        InterestedProduct = COALESCE(@interestedProduct, InterestedProduct),
        ExpectedValue = COALESCE(@expectedValue, ExpectedValue),
        Location = COALESCE(@location, Location),
        Notes = COALESCE(@notes, Notes),
        Guidance = COALESCE(@guidance, Guidance),
        NextFollowUpDate = @nextFollowUpDate,
        FirstContactDate = COALESCE(@firstContactDate, FirstContactDate),
        LostReasonID = @lostReasonId,
        LostNotes = @lostNotes,
        LastUpdatedBy = @updatedBy,
        LastUpdatedAt = GETDATE(),
        ClosedAt = CASE 
          WHEN @stageId IN (3,4,5) THEN ISNULL(ClosedAt, GETDATE())
          WHEN @stageId NOT IN (3,4,5) THEN NULL
          ELSE ClosedAt
        END,
        ClosedBy = CASE 
          WHEN @stageId IN (3,4,5) THEN ISNULL(ClosedBy, @updatedBy)
          WHEN @stageId NOT IN (3,4,5) THEN NULL
          ELSE ClosedBy
        END
      WHERE OpportunityID = @id
    `);

  return true;
}

// ===================================
// 🎯 تحديث المرحلة فقط
// ===================================

async function updateOpportunityStage(id, stageId, updatedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('stageId', sql.Int, stageId)
    .input('updatedBy', sql.NVarChar(50), updatedBy)
    .query(`
      UPDATE SalesOpportunities SET 
        StageID = @stageId, 
        LastUpdatedBy = @updatedBy, 
        LastUpdatedAt = GETDATE() 
      WHERE OpportunityID = @id
    `);
  return true;
}

// ===================================
// 🗑️ حذف فرصة (Soft Delete)
// ===================================

async function deleteOpportunity(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('UPDATE SalesOpportunities SET IsActive = 0 WHERE OpportunityID = @id');
  return true;
}

// ===================================
// ➕ إنشاء فرصة مع عميل جديد (Flow كامل)
// ===================================

async function createOpportunityWithClient(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const {
      // بيانات العميل
      clientName,
      phone1,
      phone2,
      address,
      // بيانات الفرصة
      employeeId,
      sourceId,
      adTypeId,
      categoryId,
      stageId = 1,
      statusId,
      interestedProduct,
      expectedValue,
      location,
      notes,
      guidance,
      nextFollowUpDate,
      createdBy
    } = data;

    let partyId = null;

    // 1️⃣ البحث عن العميل بالتليفون
    const existingClient = await transaction.request()
      .input('phone1', sql.NVarChar(50), phone1)
      .query(`
        SELECT TOP 1 PartyID, PartyName 
        FROM Parties 
        WHERE (Phone = @phone1 OR Phone2 = @phone1) 
          AND IsActive = 1
      `);

    if (existingClient.recordset.length > 0) {
      // ✅ العميل موجود
      partyId = existingClient.recordset[0].PartyID;
    } else {
      // ✅ إنشاء عميل جديد
      const newClient = await transaction.request()
        .input('partyName', sql.NVarChar(200), clientName)
        .input('partyType', sql.Int, 1)
        .input('phone', sql.NVarChar(50), phone1)
        .input('phone2', sql.NVarChar(50), phone2 || null)
        .input('address', sql.NVarChar(250), address || null)
        .input('email', sql.NVarChar(100), data.email || null)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .query(`
          INSERT INTO Parties (
            PartyName, PartyType, Phone, Phone2, Address,
            Email, IsActive, CreatedBy, CreatedAt
          )
          VALUES (
            @partyName, @partyType, @phone, @phone2, @address,
            @email, 1, @createdBy, GETDATE()
          );
          
          SELECT SCOPE_IDENTITY() AS PartyID; -- 👈 الحل هنا
        `);

      partyId = newClient.recordset[0].PartyID;
    }

    // 2️⃣ التحقق من وجود فرصة مفتوحة للعميل
    const existingOpp = await transaction.request()
      .input('partyId', sql.Int, partyId)
      .query(`
        SELECT TOP 1 OpportunityID 
        FROM SalesOpportunities 
        WHERE PartyID = @partyId 
          AND IsActive = 1 
          AND StageID NOT IN (3, 4, 5)
        ORDER BY CreatedAt DESC
      `);
 
    if (existingOpp.recordset.length > 0) {
      // ❌ يوجد فرصة مفتوحة
      await transaction.rollback();
      return {
        success: false,
        message: 'يوجد فرصة مفتوحة لهذا العميل بالفعل',
        existingOpportunityId: existingOpp.recordset[0].OpportunityID,
        partyId: partyId
      };
    }

    // 3️⃣ إنشاء الفرصة الجديدة
    const newOpp = await transaction.request()
      .input('partyId', sql.Int, partyId)
      .input('employeeId', sql.Int, employeeId || null)
      .input('sourceId', sql.Int, sourceId || null)
      .input('adTypeId', sql.Int, adTypeId || null)
      .input('categoryId', sql.Int, categoryId || null)
      .input('stageId', sql.Int, stageId)
      .input('statusId', sql.Int, statusId || null)
      .input('interestedProduct', sql.NVarChar(200), interestedProduct || null)
      .input('expectedValue', sql.Decimal(18, 2), expectedValue || 0)
      .input('location', sql.NVarChar(200), location || null)
      .input('notes', sql.NVarChar(500), notes || null)
      .input('guidance', sql.NVarChar(500), guidance || null)
      .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate ? new Date(nextFollowUpDate) : null)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .query(`
          INSERT INTO SalesOpportunities (
            PartyID, EmployeeID, SourceID, AdTypeID, CategoryID,
            StageID, StatusID, InterestedProduct, ExpectedValue, Location,
            Notes, Guidance, NextFollowUpDate, FirstContactDate,
            IsActive, CreatedBy, CreatedAt
          )
          VALUES (
            @partyId, @employeeId, @sourceId, @adTypeId, @categoryId,
            @stageId, @statusId, @interestedProduct, @expectedValue, @location,
            @notes, @guidance, @nextFollowUpDate, GETDATE(),
            1, @createdBy, GETDATE()
          );
          
          SELECT SCOPE_IDENTITY() AS OpportunityID; -- 👈 الحل هنا
        `);

      const opportunityId = newOpp.recordset[0].OpportunityID;

    await transaction.commit();

    return {
      success: true,
      opportunityId: opportunityId,
      partyId: partyId,
      isNewClient: existingClient.recordset.length === 0,
      message: existingClient.recordset.length === 0 
        ? 'تم إضافة العميل والفرصة بنجاح' 
        : 'تم إضافة الفرصة بنجاح'
    };

  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ===================================
// 🔍 البحث عن عميل بالتليفون
// ===================================

async function searchClientByPhone(phone) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('phone', sql.NVarChar(50), phone)
    .query(`
      SELECT TOP 1 
        PartyID, PartyName, Phone, Phone2, Address, Email
      FROM Parties 
      WHERE (Phone LIKE '%' + @phone + '%' OR Phone2 LIKE '%' + @phone + '%')
        AND PartyType = 1
        AND IsActive = 1
      ORDER BY PartyID DESC
    `);

  if (result.recordset.length > 0) {
    return { found: true, client: result.recordset[0] };
  }
  return { found: false, client: null };
}

// ===================================
// 📊 حساب إجمالي عدد الفرص (للـ Pagination)
// ===================================

async function getTotalOpportunitiesCount(filters = {}) {
  const pool = await connectDB();
  const { 
    search, 
    stageId, 
    sourceId, 
    adTypeId, 
    employeeId, 
    followUpStatus,
    dateFrom,
    dateTo
  } = filters;

  let query = `SELECT COUNT(*) as total FROM SalesOpportunities o
    LEFT JOIN Parties p ON o.PartyID = p.PartyID
    WHERE o.IsActive = 1`;

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

  if (adTypeId && adTypeId !== '0') {
    query += ` AND o.AdTypeID = @adTypeId`;
    request.input('adTypeId', sql.Int, adTypeId);
  }

  if (employeeId && employeeId !== '0') {
    query += ` AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }

  if (dateFrom) {
    query += ` AND CAST(o.CreatedAt AS DATE) >= @dateFrom`;
    request.input('dateFrom', sql.Date, dateFrom);
  }

  if (dateTo) {
    query += ` AND CAST(o.CreatedAt AS DATE) <= @dateTo`;
    request.input('dateTo', sql.Date, dateTo);
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

  const result = await request.query(query);
  return result.recordset[0].total;
}
// ===================================
// 📊 Pipeline Summary (ديناميكي)
// ===================================

async function getPipelineSummary(filters = {}) {
  const pool = await connectDB();
  const { employeeId, sourceId, adTypeId, dateFrom, dateTo } = filters;

  // 1️⃣ بناء الفلاتر
  let whereClause = `WHERE o.IsActive = 1`;
  const request = pool.request();

  if (employeeId && employeeId !== '0' && employeeId !== 'null') {
    whereClause += ` AND o.EmployeeID = @employeeId`;
    request.input('employeeId', sql.Int, employeeId);
  }
  if (sourceId && sourceId !== '0' && sourceId !== 'null') {
    whereClause += ` AND o.SourceID = @sourceId`;
    request.input('sourceId', sql.Int, sourceId);
  }
  if (adTypeId && adTypeId !== '0' && adTypeId !== 'null') {
    whereClause += ` AND o.AdTypeID = @adTypeId`;
    request.input('adTypeId', sql.Int, adTypeId);
  }
  if (dateFrom) {
    whereClause += ` AND CAST(o.CreatedAt AS DATE) >= @dateFrom`;
    request.input('dateFrom', sql.Date, dateFrom);
  }
  if (dateTo) {
    whereClause += ` AND CAST(o.CreatedAt AS DATE) <= @dateTo`;
    request.input('dateTo', sql.Date, dateTo);
  }

  // 2️⃣ جلب كل المراحل مع الأعداد والقيم ديناميكياً
  const stagesQuery = `
    SELECT 
      s.StageID,
      s.StageName,
      s.StageNameAr,
      s.StageColor,
      s.StageOrder,
      COUNT(o.OpportunityID) AS Count,
      ISNULL(SUM(o.ExpectedValue), 0) AS ExpectedValue,
      
      -- عدد المتابعات المتأخرة في كل مرحلة
      SUM(CASE 
        WHEN o.NextFollowUpDate IS NOT NULL 
          AND CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) 
          AND s.StageID NOT IN (3, 4, 5)
        THEN 1 ELSE 0 
      END) AS OverdueCount,
      
      -- عدد متابعات اليوم في كل مرحلة
      SUM(CASE 
        WHEN o.NextFollowUpDate IS NOT NULL 
          AND CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) 
        THEN 1 ELSE 0 
      END) AS TodayCount

    FROM SalesStages s
    LEFT JOIN SalesOpportunities o 
      ON s.StageID = o.StageID AND o.IsActive = 1
      ${whereClause.replace('WHERE o.IsActive = 1', '')}
    WHERE s.IsActive = 1
    GROUP BY s.StageID, s.StageName, s.StageNameAr, s.StageColor, s.StageOrder
    ORDER BY s.StageOrder
  `;

  // 3️⃣ الإجماليات
  const totalsQuery = `
    SELECT 
      COUNT(*) AS TotalOpportunities,
      ISNULL(SUM(o.ExpectedValue), 0) AS TotalExpectedValue,
      
      -- الفرص المكسوبة
      SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) AS WonCount,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) AS WonValue,
      
      -- الفرص الخسرانة
      SUM(CASE WHEN o.StageID IN (4, 5) THEN 1 ELSE 0 END) AS LostCount,
      
      -- إجمالي المتابعات المتأخرة
      SUM(CASE 
        WHEN o.NextFollowUpDate IS NOT NULL 
          AND CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE)
          AND o.StageID NOT IN (3, 4, 5)
        THEN 1 ELSE 0 
      END) AS OverdueCount,
      
      -- إجمالي متابعات اليوم
      SUM(CASE 
        WHEN o.NextFollowUpDate IS NOT NULL 
          AND CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) 
        THEN 1 ELSE 0 
      END) AS TodayFollowUps,

      -- معدل التحويل
      CASE 
        WHEN COUNT(*) > 0 
        THEN CAST(
          ROUND(
            (SUM(CASE WHEN o.StageID = 3 THEN 1.0 ELSE 0 END) / COUNT(*)) * 100
          , 1) 
        AS DECIMAL(5,1))
        ELSE 0 
      END AS ConversionRate

    FROM SalesOpportunities o
    ${whereClause}
  `;

  const stagesResult = await request.query(stagesQuery);

  // Request جديد للـ totals عشان الـ inputs
  const totalsRequest = pool.request();
  if (employeeId && employeeId !== '0' && employeeId !== 'null') {
    totalsRequest.input('employeeId', sql.Int, employeeId);
  }
  if (sourceId && sourceId !== '0' && sourceId !== 'null') {
    totalsRequest.input('sourceId', sql.Int, sourceId);
  }
  if (adTypeId && adTypeId !== '0' && adTypeId !== 'null') {
    totalsRequest.input('adTypeId', sql.Int, adTypeId);
  }
  if (dateFrom) {
    totalsRequest.input('dateFrom', sql.Date, dateFrom);
  }
  if (dateTo) {
    totalsRequest.input('dateTo', sql.Date, dateTo);
  }

  const totalsResult = await totalsRequest.query(totalsQuery);

  // 4️⃣ حساب النسب المئوية
  const totalCount = totalsResult.recordset[0].TotalOpportunities || 1;
  const stages = stagesResult.recordset.map(stage => ({
    ...stage,
    Percentage: Math.round((stage.Count / totalCount) * 1000) / 10
  }));

  return {
    stages: stages,
    totals: totalsResult.recordset[0]
  };
}

// ===================================
// 🔍 بحث عن عملاء (مع تنظيف النص العربي)
// ===================================

async function searchClients(searchText) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('search', sql.NVarChar(200), searchText)
    .query(`
      SELECT TOP 20
        p.PartyID,
        p.PartyName,
        p.Phone,
        p.Phone2,
        p.Address,
        p.Email,
        -- آخر فرصة مفتوحة
        (SELECT TOP 1 o.OpportunityID 
         FROM SalesOpportunities o 
         WHERE o.PartyID = p.PartyID AND o.IsActive = 1 AND o.StageID NOT IN (3,4,5)
         ORDER BY o.CreatedAt DESC
        ) AS OpenOpportunityID,
        -- اسم المرحلة
        (SELECT TOP 1 ss.StageNameAr 
         FROM SalesOpportunities o 
         LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
         WHERE o.PartyID = p.PartyID AND o.IsActive = 1
         ORDER BY o.CreatedAt DESC
        ) AS CurrentStage,
        -- لون المرحلة
        (SELECT TOP 1 ss.StageColor 
         FROM SalesOpportunities o 
         LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
         WHERE o.PartyID = p.PartyID AND o.IsActive = 1
         ORDER BY o.CreatedAt DESC
        ) AS StageColor
      FROM Parties p
      WHERE p.IsActive = 1
        AND p.PartyType = 1
        AND (
          dbo.CleanArabicText(p.PartyName) LIKE '%' + dbo.CleanArabicText(@search) + '%'
          OR p.Phone LIKE '%' + @search + '%'
          OR p.Phone2 LIKE '%' + @search + '%'
        )
      ORDER BY p.PartyName
    `);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// 🛑 طلبات موافقة إغلاق الفرص - مطابقة بلازور OpportunityService
// ═══════════════════════════════════════════════════════════

const CLOSURE_STATUSES = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXECUTED: 'Executed',
};

async function requestClosureApproval(opportunityId, data = {}, userName = 'System') {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const oppRes = await new sql.Request(transaction)
      .input('id', sql.Int, opportunityId)
      .query(`SELECT OpportunityID, PartyID, StageID FROM SalesOpportunities WHERE OpportunityID = @id AND IsActive = 1`);
    const opp = oppRes.recordset[0];
    if (!opp) {
      await transaction.rollback();
      return { success: false, message: 'الفرصة غير موجودة' };
    }

    const currentStageId = opp.StageID;
    const requestedStageId = data.requestedStageId || data.stageId;
    if (!requestedStageId) {
      await transaction.rollback();
      return { success: false, message: 'المرحلة المطلوبة مطلوبة' };
    }

    const isExit = requestedStageId == 4 || requestedStageId == 5;
    const isWon = requestedStageId == 3;
    if (!isExit && !isWon) {
      await transaction.rollback();
      return { success: false, message: 'طلبات الموافقة متاحة فقط للبيع أو خسارة' };
    }

    if (!data.lostReasonId && isExit) {
      await transaction.rollback();
      return { success: false, message: 'سبب الخسارة مطلوب' };
    }

    // Check existing pending
    const existing = await new sql.Request(transaction)
      .input('oppId', sql.Int, opportunityId)
      .query(`SELECT TOP 1 RequestID FROM OpportunityClosureApprovalRequests WHERE OpportunityID = @oppId AND Status = N'Pending' ORDER BY RequestedAt DESC`);
    if (existing.recordset[0]) {
      await transaction.rollback();
      return { success: false, message: 'يوجد طلب موافقة معلق بالفعل لهذه الفرصة', requestId: existing.recordset[0].RequestID };
    }

    const reqResult = await new sql.Request(transaction)
      .input('oppId', sql.Int, opportunityId)
      .input('partyId', sql.Int, opp.PartyID)
      .input('currentStageId', sql.Int, currentStageId)
      .input('requestedStageId', sql.Int, requestedStageId)
      .input('lostReasonId', sql.Int, data.lostReasonId || null)
      .input('reasonNotes', sql.NVarChar(sql.MAX), data.requestReasonNotes || data.lostNotes || data.reason || '')
      .input('requestSource', sql.NVarChar(100), data.requestSource || 'Flutter')
      .input('requestedBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO OpportunityClosureApprovalRequests (
          OpportunityID, PartyID, CurrentStageID, RequestedStageID,
          LostReasonID, RequestReasonNotes, RequestSource,
          Status, RequestedBy, RequestedAt
        )
        OUTPUT INSERTED.RequestID
        VALUES (
          @oppId, @partyId, @currentStageId, @requestedStageId,
          @lostReasonId, @reasonNotes, @requestSource,
          N'Pending', @requestedBy, GETDATE()
        )
      `);

    const requestId = reqResult.recordset[0].RequestID;

    // Add interaction log
    await new sql.Request(transaction)
      .input('oppId', sql.Int, opportunityId)
      .input('partyId', sql.Int, opp.PartyID)
      .input('summary', sql.NVarChar(1000), `تم إرسال طلب موافقة لتحويل الفرصة إلى ${requestedStageId == 3 ? 'تم البيع' : 'خسارة'} بواسطة ${userName}`)
      .input('notes', sql.NVarChar(sql.MAX), data.requestReasonNotes || data.lostNotes || '')
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO CustomerInteractions (
          OpportunityID, PartyID, InteractionDate, Summary, Notes, CreatedBy, CreatedAt
        ) VALUES (
          @oppId, @partyId, GETDATE(), @summary, @notes, @createdBy, GETDATE()
        )
      `);

    await transaction.commit();

    // Notify SalesManager + GeneralManager
    try {
      const notificationsQueries = require('../notifications/notifications.queries');
      const clientRes = await pool.request().input('pid', sql.Int, opp.PartyID).query(`SELECT PartyName FROM Parties WHERE PartyID = @pid`);
      const clientName = clientRes.recordset[0]?.PartyName || `عميل #${opp.PartyID}`;
      const stageName = requestedStageId == 3 ? 'تم البيع' : (requestedStageId == 4 ? 'خسارة' : 'غير مهتم');
      const msg = `طلب ${userName} تحويل الفرصة #${opportunityId} الخاصة بالعميل ${clientName} إلى ${stageName}. السبب: ${data.requestReasonNotes || data.lostNotes || ''}`;

      // Notify both roles - FIXED for Flutter routing
      for (const role of ['SalesManager', 'GeneralManager', 'Admin']) {
        try {
          const usersRes = await pool.request().input('role', sql.NVarChar(50), role).query(`SELECT Username FROM Users WHERE Role = @role AND ISNULL(IsActive,1)=1`);
          for (const u of usersRes.recordset) {
            if (u.Username === userName) continue;
            await notificationsQueries.createNotification({
              title: '🛑 طلب موافقة إغلاق فرصة',
              message: msg + ` [طلب #${requestId}]`,
              recipientUser: u.Username,
              // FIXED: استخدم SalesOpportunities عشان الفلاتر يفتح تفاصيل الفرصة مباشرة
              relatedTable: 'SalesOpportunities',
              relatedId: opportunityId,
              // formName يطابق بلازور ويفتح في الفلاتر opportunityDetail
              formName: 'crm/opportunities',
              createdBy: userName,
            });
          }
        } catch (e) {
          console.error(`notify closure ${role}:`, e.message);
        }
      }
    } catch (e) {
      console.error('notify closure approval:', e.message);
    }

    return { success: true, message: 'تم إرسال طلب الموافقة إلى المدير العام ومدير المبيعات', requestId };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function getClosureApprovalRequests(status = null) {
  const pool = await connectDB();
  const req = pool.request();
  let where = ' WHERE 1=1 ';
  if (status) {
    req.input('status', sql.NVarChar(50), status);
    where += ' AND r.Status = @status ';
  }
  const result = await req.query(`
    SELECT
      r.RequestID, r.OpportunityID, r.PartyID,
      p.PartyName AS ClientName, p.Phone,
      r.CurrentStageID, csCurr.StageNameAr AS CurrentStageName,
      r.RequestedStageID, csReq.StageNameAr AS RequestedStageName,
      r.LostReasonID, lr.ReasonNameAr AS LostReasonName,
      r.RequestReasonNotes, r.RequestSource, r.Status,
      r.RequestedBy, r.RequestedAt, r.ReviewedBy, r.ReviewedAt, r.ReviewNotes
    FROM OpportunityClosureApprovalRequests r
    LEFT JOIN Parties p ON r.PartyID = p.PartyID
    LEFT JOIN SalesStages csCurr ON r.CurrentStageID = csCurr.StageID
    LEFT JOIN SalesStages csReq ON r.RequestedStageID = csReq.StageID
    LEFT JOIN LostReasons lr ON r.LostReasonID = lr.LostReasonID
    ${where}
    ORDER BY CASE WHEN r.Status = N'Pending' THEN 0 ELSE 1 END, r.RequestedAt DESC
  `);
  return result.recordset;
}

async function getPendingClosureByOpportunity(opportunityId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('oppId', sql.Int, opportunityId)
    .query(`
      SELECT TOP 1
        RequestID, OpportunityID, PartyID, CurrentStageID, RequestedStageID,
        LostReasonID, RequestReasonNotes, RequestSource, Status,
        RequestedBy, RequestedAt, ReviewedBy, ReviewedAt, ReviewNotes
      FROM OpportunityClosureApprovalRequests
      WHERE OpportunityID = @oppId AND Status = N'Pending'
      ORDER BY RequestedAt DESC
    `);
  return result.recordset[0] || null;
}

async function approveClosureRequest(requestId, userName, reviewNotes = null) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const reqRes = await new sql.Request(transaction)
      .input('id', sql.Int, requestId)
      .query(`SELECT * FROM OpportunityClosureApprovalRequests WHERE RequestID = @id AND Status = N'Pending'`);
    const reqRow = reqRes.recordset[0];
    if (!reqRow) {
      await transaction.rollback();
      return { success: false, message: 'طلب الموافقة غير موجود أو تم التعامل معه' };
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, requestId)
      .input('reviewedBy', sql.NVarChar(100), userName)
      .input('reviewNotes', sql.NVarChar(sql.MAX), reviewNotes || null)
      .query(`
        UPDATE OpportunityClosureApprovalRequests SET
          Status = N'Approved',
          ReviewedBy = @reviewedBy,
          ReviewedAt = GETDATE(),
          ReviewNotes = @reviewNotes
        WHERE RequestID = @id
      `);

    // Log interaction
    await new sql.Request(transaction)
      .input('oppId', sql.Int, reqRow.OpportunityID)
      .input('partyId', sql.Int, reqRow.PartyID)
      .input('summary', sql.NVarChar(1000), `تم اعتماد طلب تحويل الفرصة إلى ${reqRow.RequestedStageID == 3 ? 'تم البيع' : 'خسارة'} بواسطة ${userName}`)
      .input('notes', sql.NVarChar(sql.MAX), reviewNotes || 'تم اعتماد الطلب وبانتظار تنفيذ الإغلاق بواسطة مقدم الطلب')
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO CustomerInteractions (OpportunityID, PartyID, InteractionDate, Summary, Notes, CreatedBy, CreatedAt)
        VALUES (@oppId, @partyId, GETDATE(), @summary, @notes, @createdBy, GETDATE())
      `);

    await transaction.commit();

    // Notify requester
    try {
      const notificationsQueries = require('../notifications/notifications.queries');
      const clientRes = await pool.request().input('pid', sql.Int, reqRow.PartyID).query(`SELECT PartyName FROM Parties WHERE PartyID = @pid`);
      const clientName = clientRes.recordset[0]?.PartyName || `عميل #${reqRow.PartyID}`;
      const stageName = reqRow.RequestedStageID == 3 ? 'تم البيع' : 'خسارة';
      if (reqRow.RequestedBy && reqRow.RequestedBy !== userName) {
        await notificationsQueries.createNotification({
          title: '✅ تم اعتماد طلب إغلاق الفرصة',
          message: `وافق ${userName} على تحويل الفرصة #${reqRow.OpportunityID} الخاصة بالعميل ${clientName} إلى ${stageName}. برجاء فتح الفرصة وتنفيذ الإغلاق.`,
          recipientUser: reqRow.RequestedBy,
          relatedTable: 'SalesOpportunities',
          relatedId: reqRow.OpportunityID,
          formName: 'crm/opportunities',
          createdBy: userName,
        });
      }
    } catch (e) {
      console.error('notify approve:', e.message);
    }

    return { success: true, message: 'تم اعتماد الطلب وإرسال إشعار لمقدم الطلب' };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function rejectClosureRequest(requestId, userName, reviewNotes = null) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const reqRes = await new sql.Request(transaction)
      .input('id', sql.Int, requestId)
      .query(`SELECT * FROM OpportunityClosureApprovalRequests WHERE RequestID = @id AND Status = N'Pending'`);
    const reqRow = reqRes.recordset[0];
    if (!reqRow) {
      await transaction.rollback();
      return { success: false, message: 'طلب الموافقة غير موجود أو تم التعامل معه' };
    }

    await new sql.Request(transaction)
      .input('id', sql.Int, requestId)
      .input('reviewedBy', sql.NVarChar(100), userName)
      .input('reviewNotes', sql.NVarChar(sql.MAX), reviewNotes || null)
      .query(`
        UPDATE OpportunityClosureApprovalRequests SET
          Status = N'Rejected',
          ReviewedBy = @reviewedBy,
          ReviewedAt = GETDATE(),
          ReviewNotes = @reviewNotes
        WHERE RequestID = @id
      `);

    await new sql.Request(transaction)
      .input('oppId', sql.Int, reqRow.OpportunityID)
      .input('partyId', sql.Int, reqRow.PartyID)
      .input('summary', sql.NVarChar(1000), `تم رفض طلب تحويل الفرصة إلى ${reqRow.RequestedStageID == 3 ? 'تم البيع' : 'خسارة'} بواسطة ${userName}`)
      .input('notes', sql.NVarChar(sql.MAX), reviewNotes || 'رفض طلب الإغلاق')
      .input('createdBy', sql.NVarChar(100), userName)
      .query(`
        INSERT INTO CustomerInteractions (OpportunityID, PartyID, InteractionDate, Summary, Notes, CreatedBy, CreatedAt)
        VALUES (@oppId, @partyId, GETDATE(), @summary, @notes, @createdBy, GETDATE())
      `);

    await transaction.commit();

    // Notify requester
    try {
      const notificationsQueries = require('../notifications/notifications.queries');
      const clientRes = await pool.request().input('pid', sql.Int, reqRow.PartyID).query(`SELECT PartyName FROM Parties WHERE PartyID = @pid`);
      const clientName = clientRes.recordset[0]?.PartyName || `عميل #${reqRow.PartyID}`;
      const stageName = reqRow.RequestedStageID == 3 ? 'تم البيع' : 'خسارة';
      if (reqRow.RequestedBy && reqRow.RequestedBy !== userName) {
        await notificationsQueries.createNotification({
          title: '❌ تم رفض طلب إغلاق الفرصة',
          message: `رفض ${userName} طلب تحويل الفرصة #${reqRow.OpportunityID} الخاصة بالعميل ${clientName} إلى ${stageName}. ${reviewNotes || ''}`,
          recipientUser: reqRow.RequestedBy,
          relatedTable: 'SalesOpportunities',
          relatedId: reqRow.OpportunityID,
          formName: 'crm/opportunities',
          createdBy: userName,
        });
      }
    } catch (e) {
      console.error('notify reject:', e.message);
    }

    return { success: true, message: 'تم رفض طلب الإغلاق' };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function executeApprovedClosure(opportunityId, userName) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const reqRes = await new sql.Request(transaction)
      .input('oppId', sql.Int, opportunityId)
      .query(`SELECT TOP 1 * FROM OpportunityClosureApprovalRequests WHERE OpportunityID = @oppId AND Status = N'Approved' ORDER BY ReviewedAt DESC`);
    const approved = reqRes.recordset[0];
    if (!approved) {
      await transaction.rollback();
      return { success: false, message: 'لا يوجد طلب معتمد لتنفيذ الإغلاق' };
    }

    // Update opportunity to requested stage
    await new sql.Request(transaction)
      .input('oppId', sql.Int, opportunityId)
      .input('stageId', sql.Int, approved.RequestedStageID)
      .input('lostReasonId', sql.Int, approved.LostReasonID || null)
      .input('lostNotes', sql.NVarChar(sql.MAX), approved.RequestReasonNotes || null)
      .input('closedBy', sql.NVarChar(100), userName)
      .query(`
        UPDATE SalesOpportunities SET
          StageID = @stageId,
          LostReasonID = @lostReasonId,
          LostNotes = @lostNotes,
          ClosedAt = GETDATE(),
          ClosedBy = @closedBy,
          LastUpdatedBy = @closedBy,
          LastUpdatedAt = GETDATE(),
          NextFollowUpDate = NULL
        WHERE OpportunityID = @oppId
      `);

    // Mark request as Executed
    await new sql.Request(transaction)
      .input('id', sql.Int, approved.RequestID)
      .query(`UPDATE OpportunityClosureApprovalRequests SET Status = N'Executed' WHERE RequestID = @id`);

    // Close open tasks
    await new sql.Request(transaction)
      .input('oppId', sql.Int, opportunityId)
      .input('closedBy', sql.NVarChar(100), userName)
      .query(`
        UPDATE CRM_Tasks SET Status = N'Completed', CompletedDate = GETDATE(), CompletedBy = @closedBy, CompletionNotes = N'تم الإغلاق بعد موافقة الإدارة'
        WHERE OpportunityID = @oppId AND Status IN (N'Pending', N'In Progress')
      `);

    await transaction.commit();
    return { success: true, message: 'تم تنفيذ الإغلاق بنجاح', stageId: approved.RequestedStageID };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ===================================
// 📤 تصدير الدوال
// ===================================


// ═══════════════════════════════════════════════════════════
// 📋 KANBAN BOARD (مطابق لمنطق بلازور GetKanbanBoardAsync)
// ═══════════════════════════════════════════════════════════
async function getKanbanBoard(filters = {}) {
  const pool = await connectDB();
  const { employeeId, sourceId, adTypeId, dateFrom, dateTo, search, stageId, isOverdue, hasFollowUp } = filters;

  // 1️⃣ المراحل النشطة
  const stagesRes = await pool.request().query(`
    SELECT StageID, StageName, StageNameAr, StageColor, StageOrder
    FROM SalesStages WHERE IsActive = 1 ORDER BY StageOrder
  `);
  const stages = stagesRes.recordset;

  // 2️⃣ الفرص المفلترة
  let where = ' WHERE o.IsActive = 1';
  const req = pool.request();
  if (employeeId && employeeId !== '0' && employeeId !== 'null') {
    where += ' AND o.EmployeeID = @employeeId';
    req.input('employeeId', sql.Int, employeeId);
  }
  if (sourceId && sourceId !== '0' && sourceId !== 'null') {
    where += ' AND o.SourceID = @sourceId';
    req.input('sourceId', sql.Int, sourceId);
  }
  if (adTypeId && adTypeId !== '0' && adTypeId !== 'null') {
    where += ' AND o.AdTypeID = @adTypeId';
    req.input('adTypeId', sql.Int, adTypeId);
  }
  if (stageId && stageId !== '0' && stageId !== 'null') {
    where += ' AND o.StageID = @stageId';
    req.input('stageId', sql.Int, stageId);
  }
  if (dateFrom) {
    where += ' AND CAST(o.CreatedAt AS DATE) >= @dateFrom';
    req.input('dateFrom', sql.Date, dateFrom);
  }
  if (dateTo) {
    where += ' AND CAST(o.CreatedAt AS DATE) <= @dateTo';
    req.input('dateTo', sql.Date, dateTo);
  }
  if (search && String(search).trim()) {
    where += ' AND (p.PartyName LIKE @search OR p.Phone LIKE @search OR o.InterestedProduct LIKE @search)';
    req.input('search', sql.NVarChar(200), `%${String(search).trim()}%`);
  }

  const oppsRes = await req.query(`
    SELECT o.OpportunityID, o.PartyID, o.StageID, o.ExpectedValue, o.EmployeeID,
           o.NextFollowUpDate, o.InterestedProduct, o.SourceID, o.CreatedAt, o.ClosedAt,
           p.PartyName, p.Phone,
           e.FullName AS EmployeeName,
           cs.SourceName AS SourceName
    FROM SalesOpportunities o
    INNER JOIN Parties p ON o.PartyID = p.PartyID
    LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
    LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
    ${where}
  `);

  const opps = oppsRes.recordset;

  // فلاتر إضافية (على مستوى العميل)
  let filtered = opps;
  if (isOverdue === 'true' || isOverdue === '1') {
    filtered = filtered.filter(o => o.NextFollowUpDate && new Date(o.NextFollowUpDate) < new Date());
  }
  if (hasFollowUp === 'true' || hasFollowUp === '1') {
    filtered = filtered.filter(o => o.NextFollowUpDate != null);
  }

  // 3️⃣ عدد التفاعلات والمهام لكل فرصة
  const oppIds = filtered.map(o => o.OpportunityID);
  let icDict = {};
  let tcDict = {};
  if (oppIds.length) {
    const ids = oppIds.join(',');
    const ic = await pool.request().query(`
      SELECT OpportunityID, COUNT(*) AS Cnt FROM CustomerInteractions
      WHERE OpportunityID IN (${ids}) GROUP BY OpportunityID
    `);
    ic.recordset.forEach(r => icDict[r.OpportunityID] = r.Cnt);

    const tc = await pool.request().query(`
      SELECT OpportunityID, COUNT(*) AS Cnt FROM CRM_Tasks
      WHERE OpportunityID IN (${ids}) GROUP BY OpportunityID
    `);
    tc.recordset.forEach(r => tcDict[r.OpportunityID] = r.Cnt);
  }

  // 4️⃣ بناء الأعمدة
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const columns = stages.map(s => {
    const cards = filtered
      .filter(o => o.StageID === s.StageID)
      .map(o => {
        const created = new Date(o.CreatedAt);
        const closed = o.ClosedAt ? new Date(o.ClosedAt) : null;
        const lifecycleDays = Math.floor(
          ((closed || new Date()) - created) / (1000 * 60 * 60 * 24)
        );
        const followUp = o.NextFollowUpDate ? new Date(o.NextFollowUpDate) : null;
        return {
          OpportunityId: o.OpportunityID,
          PartyId: o.PartyID,
          ClientName: o.PartyName || '—',
          Phone: o.Phone,
          ExpectedValue: o.ExpectedValue || 0,
          EmployeeId: o.EmployeeID,
          EmployeeName: o.EmployeeName || null,
          InterestedProduct: o.InterestedProduct,
          SourceId: o.SourceID,
          SourceName: o.SourceName || null,
          NextFollowUpDate: o.NextFollowUpDate,
          StageId: o.StageID,
          InteractionsCount: icDict[o.OpportunityID] || 0,
          TasksCount: tcDict[o.OpportunityID] || 0,
          IsOverdue: followUp ? followUp < today : false,
          CreatedAt: o.CreatedAt,
          ClosedAt: o.ClosedAt,
          LifecycleDays: lifecycleDays,
        };
      });

    return {
      StageId: s.StageID,
      StageName: s.StageName,
      StageNameAr: s.StageNameAr || s.StageName,
      StageColor: s.StageColor || '#94a3b8',
      StageOrder: s.StageOrder,
      Count: cards.length,
      Value: cards.reduce((sum, c) => sum + (c.ExpectedValue || 0), 0),
      Cards: cards,
    };
  });

  return { columns };
}


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
  getPipelineSummary,
  getKanbanBoard,
  
  // CRUD
  getAllOpportunities,
  getTotalOpportunitiesCount,
  checkOpenOpportunity,
  getOpportunityById,
  createOpportunity,
  updateOpportunity,
  updateOpportunityStage,
  deleteOpportunity,
  
  // ✅ الجديد
  createOpportunityWithClient,
  searchClientByPhone,
  searchClients,

  // 🛑 Closure Approval - مطابقة بلازور
  requestClosureApproval,
  getClosureApprovalRequests,
  getPendingClosureByOpportunity,
  approveClosureRequest,
  rejectClosureRequest,
  executeApprovedClosure,
  CLOSURE_STATUSES,
};