const { sql, connectDB } = require('../../core/database');

// تسجيل تواصل جديد (الـ Flow الكامل)
async function createInteraction(data) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();
        // متغير لحفظ المرحلة السابقة
    let stageBeforeId = null;

    const {
      isNewClient,
      clientName,
      phone1,
      phone2,
      address,
      partyId,
      employeeId,
      sourceId,
      adTypeId,
      stageId,
      statusId,
      categoryId,
      interestedProduct,
      expectedValue,
      summary,
      guidance,
      lostReasonId,
      nextFollowUpDate,
      taskTypeId,
      createdBy
    } = data;

    let finalPartyId = partyId;
    let opportunityId = null;
    let isNewOpportunity = false;

    // 1️⃣ حفظ العميل الجديد
    if (isNewClient) {
      const newClient = await transaction.request()
        .input('partyName', sql.NVarChar(200), clientName)
        .input('partyType', sql.Int, 1)
        .input('phone', sql.NVarChar(50), phone1)
        .input('phone2', sql.NVarChar(50), phone2 || null)
        .input('address', sql.NVarChar(250), address || null)
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

      finalPartyId = newClient.recordset[0].PartyID;
    }

    // 2️⃣ التحقق من فرصة مفتوحة
    const existingOpp = await transaction.request()
      .input('partyId', sql.Int, finalPartyId)
      .query(`
        SELECT TOP 1 OpportunityID, StageID 
        FROM SalesOpportunities 
        WHERE PartyID = @partyId 
          AND IsActive = 1 
          AND StageID NOT IN (3, 4, 5)
        ORDER BY CreatedAt DESC
      `);

    if (existingOpp.recordset.length > 0) {
      // 3️⃣ تحديث الفرصة الموجودة
      opportunityId = existingOpp.recordset[0].OpportunityID;
      stageBeforeId = existingOpp.recordset[0].StageID;

      await transaction.request()
        .input('oppId', sql.Int, opportunityId)
        .input('employeeId', sql.Int, employeeId || null)
        .input('stageId', sql.Int, stageId || null)
        .input('statusId', sql.Int, statusId || null)
        .input('categoryId', sql.Int, categoryId || null)
        .input('interestedProduct', sql.NVarChar(200), interestedProduct || null)
        .input('expectedValue', sql.Decimal(18, 2), expectedValue || null)
        .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
        .input('lostReasonId', sql.Int, lostReasonId || null)
        .input('notes', sql.NVarChar(500), summary || null)
        .input('guidance', sql.NVarChar(500), guidance || null)
        .input('updatedBy', sql.NVarChar(50), createdBy)
        .query(`
          UPDATE SalesOpportunities SET
            EmployeeID = COALESCE(@employeeId, EmployeeID),
            StageID = COALESCE(@stageId, StageID),
            StatusID = COALESCE(@statusId, StatusID),
            CategoryID = COALESCE(@categoryId, CategoryID),
            InterestedProduct = COALESCE(@interestedProduct, InterestedProduct),
            ExpectedValue = COALESCE(@expectedValue, ExpectedValue),
            NextFollowUpDate = @nextFollowUpDate,
            LostReasonID = @lostReasonId,
            Notes = @notes,
            Guidance = @guidance,
            LastContactDate = GETDATE(),
            LastUpdatedBy = @updatedBy,
            LastUpdatedAt = GETDATE()
          WHERE OpportunityID = @oppId
        `);

    } else {
      // 3️⃣ إنشاء فرصة جديدة
      isNewOpportunity = true;

      const newOpp = await transaction.request()
        .input('partyId', sql.Int, finalPartyId)
        .input('employeeId', sql.Int, employeeId || null)
        .input('sourceId', sql.Int, sourceId || null)
        .input('adTypeId', sql.Int, adTypeId || null)
        .input('stageId', sql.Int, stageId || 1)
        .input('statusId', sql.Int, statusId || null)
        .input('categoryId', sql.Int, categoryId || null)
        .input('interestedProduct', sql.NVarChar(200), interestedProduct || null)
        .input('expectedValue', sql.Decimal(18, 2), expectedValue || null)
        .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
        .input('notes', sql.NVarChar(500), summary || null)
        .input('guidance', sql.NVarChar(500), guidance || null)
        .input('createdBy', sql.NVarChar(50), createdBy)
        .query(`
          INSERT INTO SalesOpportunities (
            PartyID, EmployeeID, SourceID, AdTypeID, StageID, StatusID, CategoryID,
            InterestedProduct, ExpectedValue, FirstContactDate, NextFollowUpDate,
            Notes, Guidance, IsActive, CreatedBy, CreatedAt
          )
          OUTPUT INSERTED.OpportunityID
          VALUES (
            @partyId, @employeeId, @sourceId, @adTypeId, @stageId, @statusId, @categoryId,
            @interestedProduct, @expectedValue, GETDATE(), @nextFollowUpDate,
            @notes, @guidance, 1, @createdBy, GETDATE()
          )
        `);

      opportunityId = newOpp.recordset[0].OpportunityID;
    }

    // 4️⃣ إضافة سجل التواصل
    const interaction = await transaction.request()
      .input('oppId', sql.Int, opportunityId)
      .input('partyId', sql.Int, finalPartyId)
      .input('employeeId', sql.Int, employeeId || null)
      .input('sourceId', sql.Int, sourceId || null)
      .input('statusId', sql.Int, statusId || null)
      .input('summary', sql.NVarChar(1000), summary || null)
      .input('stageAfterId', sql.Int, stageId || null)
      .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
      .input('notes', sql.NVarChar(500), guidance || null)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .input('stageBeforeId', sql.Int, stageBeforeId)
      .query(`
        INSERT INTO CustomerInteractions (
          OpportunityID, PartyID, EmployeeID, SourceID, StatusID,
          InteractionDate, Summary, StageAfterID, NextFollowUpDate,
          Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.InteractionID
        VALUES (
          @oppId, @partyId, @employeeId, @sourceId, @statusId,
          GETDATE(), @summary, @stageAfterId, @nextFollowUpDate,
          @notes, @createdBy, GETDATE()
        )
      `);

        // 5️⃣ إدارة المهام (Tasks Management)
    
    // ✅ (جديد) إغلاق كل المهام المفتوحة لهذه الفرصة
    await transaction.request()
      .input('oppId', sql.Int, opportunityId)
      .input('completedBy', sql.NVarChar(50), createdBy)
      .query(`
        UPDATE CRM_Tasks 
        SET Status = 'Completed',
            CompletedDate = GETDATE(),
            CompletedBy = @completedBy,
            CompletionNotes = N'تم الإغلاق تلقائياً - تم تسجيل تواصل جديد'
        WHERE OpportunityID = @oppId 
          AND Status IN ('Pending', 'In Progress')
      `);

    // ✅ إنشاء مهمة جديدة (زي ما هو)
    let taskId = null;
    if (nextFollowUpDate && stageId !== 3 && stageId !== 4 && stageId !== 5) {
      const task = await transaction.request()
        .input('oppId', sql.Int, opportunityId)
        .input('partyId', sql.Int, finalPartyId)
        .input('assignedTo', sql.Int, employeeId || null)
        .input('taskTypeId', sql.Int, taskTypeId || null)
        .input('description', sql.NVarChar(500), guidance || 'متابعة العميل')
        .input('dueDate', sql.DateTime, nextFollowUpDate)
        .input('createdBy', sql.NVarChar(50), createdBy)
        .query(`
          INSERT INTO CRM_Tasks (
            OpportunityID, PartyID, AssignedTo, TaskTypeID,
            TaskDescription, DueDate, Priority, Status,
            ReminderEnabled, IsActive, CreatedBy, CreatedAt
          )
          OUTPUT INSERTED.TaskID
          VALUES (
            @oppId, @partyId, @assignedTo, @taskTypeId,
            @description, @dueDate, 'Normal', 'Pending',
            1, 1, @createdBy, GETDATE()
          )
        `);

      taskId = task.recordset[0].TaskID;
    }

    await transaction.commit();

    return {
      partyId: finalPartyId,
      opportunityId: opportunityId,
      interactionId: interaction.recordset[0].InteractionID,
      taskId: taskId,
      isNewClient: isNewClient || false,
      isNewOpportunity: isNewOpportunity
    };

  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// جلب سجل التفاعلات لفرصة معينة (Timeline)
async function getInteractionsByOpportunityId(opportunityId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('oppId', sql.Int, opportunityId)
    .query(`
      SELECT 
        i.InteractionID,
        i.InteractionDate,
        i.Summary,
        i.Notes,
        i.NextFollowUpDate,
        e.FullName AS EmployeeName,
        cs.SourceName, cs.SourceIcon,
        cst.StatusName, cst.StatusNameAr,
        sb.StageNameAr AS StageBefore,
        sa.StageNameAr AS StageAfter,
        i.CreatedAt
      FROM CustomerInteractions i
      LEFT JOIN Employees e ON i.EmployeeID = e.EmployeeID
      LEFT JOIN ContactSources cs ON i.SourceID = cs.SourceID
      LEFT JOIN ContactStatus cst ON i.StatusID = cst.StatusID
      LEFT JOIN SalesStages sb ON i.StageBeforeID = sb.StageID
      LEFT JOIN SalesStages sa ON i.StageAfterID = sa.StageID
      WHERE i.OpportunityID = @oppId
      ORDER BY i.CreatedAt DESC
    `);
  return result.recordset;
}


// تصدير الدوال
module.exports = {
  createInteraction,
  getInteractionsByOpportunityId // <--- ضيف دي
};