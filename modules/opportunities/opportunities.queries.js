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
        ic.CategoryNameAr
      FROM SalesOpportunities o
      LEFT JOIN Parties p ON o.PartyID = p.PartyID
      LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
      LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
      LEFT JOIN AdTypes at ON o.AdTypeID = at.AdTypeID
      LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
      LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
      LEFT JOIN InterestCategories ic ON o.CategoryID = ic.CategoryID
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
    .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
    .input('createdBy', sql.NVarChar(50), createdBy)
    .query(`
      INSERT INTO SalesOpportunities (
        PartyID, EmployeeID, SourceID, AdTypeID, CategoryID,
        StageID, StatusID, InterestedProduct, ExpectedValue, Location,
        Notes, Guidance, NextFollowUpDate, FirstContactDate,
        CreatedBy, CreatedAt, IsActive
      ) 
      OUTPUT INSERTED.OpportunityID
      VALUES (
        @partyId, @employeeId, @sourceId, @adTypeId, @categoryId,
        @stageId, @statusId, @interestedProduct, @expectedValue, @location,
        @notes, @guidance, @nextFollowUpDate, GETDATE(),
        @createdBy, GETDATE(), 1
      )
    `);

  return result.recordset[0];
}

// ===================================
// ✏️ تحديث فرصة
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
    nextFollowUpDate,
    updatedBy
  } = data;

  await pool.request()
    .input('id', sql.Int, id)
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
    .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
    .input('updatedBy', sql.NVarChar(50), updatedBy)
    .query(`
      UPDATE SalesOpportunities SET
        EmployeeID = @employeeId,
        SourceID = @sourceId,
        AdTypeID = @adTypeId,
        CategoryID = @categoryId,
        StageID = @stageId,
        StatusID = @statusId,
        InterestedProduct = @interestedProduct,
        ExpectedValue = @expectedValue,
        Location = @location,
        Notes = @notes,
        Guidance = @guidance,
        NextFollowUpDate = @nextFollowUpDate,
        LastUpdatedBy = @updatedBy,
        LastUpdatedAt = GETDATE()
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
        .input('partyType', sql.Int, 1) // 1 = عميل
        .input('phone', sql.NVarChar(50), phone1)
        .input('phone2', sql.NVarChar(50), phone2 || null)
        .input('address', sql.NVarChar(250), address || null)
        .input('email', sql.NVarChar(100), data.email || null)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .query(`
          INSERT INTO Parties (
          PartyName, PartyType, Phone, Phone2, Address,
           IsActive, CreatedBy, CreatedAt
         )
          OUTPUT INSERTED.PartyID
          VALUES (
  @partyName, @partyType, @phone, @phone2, @address,
  1, @createdBy, GETDATE()
)
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
      .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .query(`
        INSERT INTO SalesOpportunities (
          PartyID, EmployeeID, SourceID, AdTypeID, CategoryID,
          StageID, StatusID, InterestedProduct, ExpectedValue, Location,
          Notes, Guidance, NextFollowUpDate, FirstContactDate,
          IsActive, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.OpportunityID
        VALUES (
          @partyId, @employeeId, @sourceId, @adTypeId, @categoryId,
          @stageId, @statusId, @interestedProduct, @expectedValue, @location,
          @notes, @guidance, @nextFollowUpDate, GETDATE(),
          1, @createdBy, GETDATE()
        )
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
// 📤 تصدير الدوال
// ===================================

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
  getTotalOpportunitiesCount,
  checkOpenOpportunity,
  getOpportunityById,
  createOpportunity,
  updateOpportunity,
  updateOpportunityStage,
  deleteOpportunity,
  
  // ✅ الجديد
  createOpportunityWithClient,
  searchClientByPhone
};