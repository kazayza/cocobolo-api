const { sql, connectDB } = require('../../core/database');

// ===================================
// إنشاء شكوى جديدة
// ===================================
async function createComplaint(complaintData) {
  const pool = await connectDB();
  
  const result = await pool.request()
    .input('partyId', sql.Int, complaintData.partyId)
    .input('opportunityId', sql.Int, complaintData.opportunityId || null)
    .input('typeId', sql.Int, complaintData.typeId)
    .input('subject', sql.NVarChar(255), complaintData.subject)
    .input('details', sql.NVarChar(sql.MAX), complaintData.details)
    .input('priority', sql.TinyInt, complaintData.priority)
    .input('status', sql.TinyInt, complaintData.status || 1)
    .input('assignedTo', sql.Int, complaintData.assignedTo || null)
    .input('complaintDate', sql.Date, complaintData.complaintDate) // 👈 تاريخ فقط
    .input('createdBy', sql.NVarChar(100), complaintData.createdBy)
    .input('createdAt', sql.DateTime, complaintData.createdAt)
    .query(`
      INSERT INTO Complaints (
        PartyID, OpportunityID, TypeID, Subject, Details,
        Priority, Status, AssignedTo, ComplaintDate, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.ComplaintID
      VALUES (
        @partyId, @opportunityId, @typeId, @subject, @details,
        @priority, @status, @assignedTo, @complaintDate, @createdBy, @createdAt
      )
    `);
  
  return result.recordset[0].ComplaintID;
}

// ===================================
// جلب كل الشكاوى (للـ List)
// ===================================
async function getAllComplaints(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();

  let query = `
    SELECT 
      c.ComplaintID,
      c.PartyID,
      p.PartyName AS ClientName,
      p.Phone AS ClientPhone,
      c.TypeID,
      ct.TypeNameAr AS ComplaintType,
      c.Subject,
      c.Details,
      c.Priority,
      c.Status,
      c.AssignedTo,
      e.FullName AS EmployeeName,
      c.ComplaintDate,
      c.SolvedDate,
      c.CreatedBy,
      c.CreatedAt,
      c.TransactionID,
      c.ProductID,
      pr.ProductName,
      c.SatisfactionLevel,
      ISNULL(c.Escalated, 0) AS Escalated,
      DATEDIFF(DAY, c.ComplaintDate, GETDATE()) AS DaysOpen,
      (SELECT COUNT(*) FROM ComplaintAttachments ca WHERE ca.ComplaintId = c.ComplaintID) AS AttachmentsCount,
      (SELECT COUNT(*) FROM ComplaintFollowUps cf WHERE cf.ComplaintID = c.ComplaintID) AS FollowUpsCount
    FROM Complaints c
    LEFT JOIN Parties p ON c.PartyID = p.PartyID
    LEFT JOIN ComplaintTypes ct ON c.TypeID = ct.TypeID
    LEFT JOIN Employees e ON c.AssignedTo = e.EmployeeID
    LEFT JOIN Products pr ON c.ProductID = pr.ProductID
    WHERE 1=1 AND ISNULL(c.IsActive, 1) = 1
  `;

  // ── الفلاتر الكاملة (مطابقة لبلازور) ──
  if (filters.status) {
    request.input('status', sql.TinyInt, filters.status);
    query += ' AND c.Status = @status';
  }
  if (filters.priority) {
    request.input('priority', sql.TinyInt, filters.priority);
    query += ' AND c.Priority = @priority';
  }
  if (filters.typeId) {
    request.input('typeId', sql.Int, filters.typeId);
    query += ' AND c.TypeID = @typeId';
  }
  if (filters.assignedTo) {
    request.input('assignedTo', sql.Int, filters.assignedTo);
    query += ' AND c.AssignedTo = @assignedTo';
  }
  if (filters.partyId) {
    request.input('partyId', sql.Int, filters.partyId);
    query += ' AND c.PartyID = @partyId';
  }
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    query += ` AND (c.Subject LIKE @search OR c.Details LIKE @search OR p.PartyName LIKE @search OR p.Phone LIKE @search)`;
  }
  if (filters.dateFrom) {
    request.input('dateFrom', sql.Date, filters.dateFrom);
    query += ' AND CAST(c.ComplaintDate AS DATE) >= @dateFrom';
  }
  if (filters.dateTo) {
    request.input('dateTo', sql.Date, filters.dateTo);
    query += ' AND CAST(c.ComplaintDate AS DATE) <= @dateTo';
  }
  // المفتوحة فقط (غير المغلقة: مش 4 ولا 5)
  if (filters.openOnly === 'true' || filters.openOnly === '1') {
    query += ' AND c.Status NOT IN (4, 5)';
  }
  if (filters.escalated !== undefined && filters.escalated !== '') {
    const esc = filters.escalated === 'true' || filters.escalated === '1';
    request.input('escalated', sql.Bit, esc ? 1 : 0);
    query += ' AND ISNULL(c.Escalated, 0) = @escalated';
  }

  query += ' ORDER BY c.CreatedAt DESC';

  const result = await request.query(query);
  return result.recordset;
}

// ═══════════════════════════════════════════════
// إحصائيات الشكاوى (مطابقة لكروت بلازور)
// ═══════════════════════════════════════════════
async function getComplaintStats(filters = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let where = ' WHERE 1=1 AND ISNULL(IsActive, 1) = 1';

  if (filters.status) {
    request.input('status', sql.TinyInt, filters.status);
    where += ' AND Status = @status';
  }
  if (filters.priority) {
    request.input('priority', sql.TinyInt, filters.priority);
    where += ' AND Priority = @priority';
  }
  if (filters.typeId) {
    request.input('typeId', sql.Int, filters.typeId);
    where += ' AND TypeID = @typeId';
  }
  if (filters.assignedTo) {
    request.input('assignedTo', sql.Int, filters.assignedTo);
    where += ' AND AssignedTo = @assignedTo';
  }
  if (filters.search && String(filters.search).trim()) {
    request.input('search', sql.NVarChar(200), `%${String(filters.search).trim()}%`);
    where += ` AND (Subject LIKE @search OR Details LIKE @search)`;
  }
  if (filters.dateFrom) {
    request.input('dateFrom', sql.Date, filters.dateFrom);
    where += ' AND CAST(ComplaintDate AS DATE) >= @dateFrom';
  }
  if (filters.dateTo) {
    request.input('dateTo', sql.Date, filters.dateTo);
    where += ' AND CAST(ComplaintDate AS DATE) <= @dateTo';
  }

  const result = await request.query(`
    SELECT
      COUNT(*) AS TotalCount,
      SUM(CASE WHEN Status = 1 THEN 1 ELSE 0 END) AS NewCount,
      SUM(CASE WHEN Status = 2 THEN 1 ELSE 0 END) AS InProgressCount,
      SUM(CASE WHEN Status = 3 THEN 1 ELSE 0 END) AS AwaitingClientCount,
      SUM(CASE WHEN Status = 4 THEN 1 ELSE 0 END) AS ResolvedCount,
      SUM(CASE WHEN Status = 5 THEN 1 ELSE 0 END) AS RejectedCount,
      SUM(CASE WHEN Status = 6 THEN 1 ELSE 0 END) AS EscalatedCount
    FROM Complaints
    ${where}
  `);
  const r = result.recordset[0] || {};
  return {
    totalCount: r.TotalCount || 0,
    newCount: r.NewCount || 0,
    inProgressCount: r.InProgressCount || 0,
    awaitingClientCount: r.AwaitingClientCount || 0,
    resolvedCount: r.ResolvedCount || 0,
    rejectedCount: r.RejectedCount || 0,
    escalatedCount: r.EscalatedCount || 0,
  };
}

// ═══════════════════════════════════════════════
// إسناد شكوى لموظف
// ═══════════════════════════════════════════════
async function assignComplaint(id, assignedTo, updatedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('assignedTo', sql.Int, assignedTo || null)
    .input('updatedBy', sql.NVarChar(100), updatedBy || 'System')
    .query(`
      UPDATE Complaints SET
        AssignedTo = @assignedTo,
        Status = CASE WHEN Status = 1 THEN 2 ELSE Status END
      WHERE ComplaintID = @id
    `);
  return true;
}

// ═══════════════════════════════════════════════
// تغيير حالة الشكوى (مع الحل عند الإغلاق)
// ═══════════════════════════════════════════════
async function changeComplaintStatus(id, newStatus, solution, updatedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('newStatus', sql.TinyInt, newStatus)
    .input('solution', sql.NVarChar(sql.MAX), solution || null)
    .input('updatedBy', sql.NVarChar(100), updatedBy || 'System')
    .query(`
      UPDATE Complaints SET
        Status = @newStatus,
        Solution = CASE WHEN @newStatus = 4 THEN @solution ELSE Solution END,
        SolvedDate = CASE WHEN @newStatus = 4 THEN GETDATE() ELSE SolvedDate END
      WHERE ComplaintID = @id
    `);
  return true;
}

// ═══════════════════════════════════════════════
// تقييم رضا العميل (بعد الحل)
// ═══════════════════════════════════════════════
async function rateComplaint(id, satisfactionLevel, updatedBy) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('satisfactionLevel', sql.TinyInt, satisfactionLevel)
    .input('updatedBy', sql.NVarChar(100), updatedBy || 'System')
    .query(`
      UPDATE Complaints SET
        SatisfactionLevel = @satisfactionLevel
      WHERE ComplaintID = @id
    `);
  return true;
}


// ===================================
// جلب شكوى واحدة بالتفاصيل
// ===================================
async function getComplaintById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT 
        c.ComplaintID,
        c.PartyID,
        p.PartyName AS ClientName,
        p.Phone,
        p.Phone2,
        p.Address,
        c.OpportunityID,
        so.InterestedProduct AS OpportunityProduct,
        c.TypeID,
        ct.TypeNameAr AS ComplaintType,
        c.Subject,
        c.Details,
        c.Priority,
        c.Status,
        c.AssignedTo,
        e.FullName AS AssignedToName,
        e.MobilePhone AS AssignedToPhone,
        CAST(c.ComplaintDate AS DATE) AS ComplaintDate,
        c.CreatedBy,
        c.CreatedAt,
        ISNULL(c.Escalated, 0) AS Escalated,
        c.EscalatedTo,
        e2.FullName AS EscalatedToName,
        c.EscalatedBy,
        e3.FullName AS EscalatedByName,
        c.EscalatedDate,
        c.EscalationReason
      FROM Complaints c
      LEFT JOIN Parties p ON c.PartyID = p.PartyID
      LEFT JOIN ComplaintTypes ct ON c.TypeID = ct.TypeID
      LEFT JOIN Employees e ON c.AssignedTo = e.EmployeeID
      LEFT JOIN Employees e2 ON c.EscalatedTo = e2.EmployeeID
      LEFT JOIN Employees e3 ON c.EscalatedBy = e3.EmployeeID
      LEFT JOIN SalesOpportunities so ON c.OpportunityID = so.OpportunityID
      WHERE c.ComplaintID = @id
    `);
  
  return result.recordset[0] || null;
}

// ===================================
// تحديث شكوى
// ===================================
async function updateComplaint(id, complaintData) {
  const pool = await connectDB();
  const request = pool.request()
    .input('id', sql.Int, id);
  
  let setClauses = [];
  
  if (complaintData.typeId !== undefined) {
    request.input('typeId', sql.Int, complaintData.typeId);
    setClauses.push('TypeID = @typeId');
  }
  
  if (complaintData.subject !== undefined) {
    request.input('subject', sql.NVarChar(255), complaintData.subject);
    setClauses.push('Subject = @subject');
  }
  
  if (complaintData.details !== undefined) {
    request.input('details', sql.NVarChar(sql.MAX), complaintData.details);
    setClauses.push('Details = @details');
  }
  
  if (complaintData.priority !== undefined) {
    request.input('priority', sql.TinyInt, complaintData.priority);
    setClauses.push('Priority = @priority');
  }
  
  if (complaintData.status !== undefined) {
    request.input('status', sql.TinyInt, complaintData.status);
    setClauses.push('Status = @status');
  }
  
  if (complaintData.assignedTo !== undefined) {
    request.input('assignedTo', sql.Int, complaintData.assignedTo);
    setClauses.push('AssignedTo = @assignedTo');
  }
  
  if (complaintData.complaintDate !== undefined) {
    request.input('complaintDate', sql.Date, complaintData.complaintDate);
    setClauses.push('ComplaintDate = @complaintDate');
  }
  
  if (complaintData.escalated !== undefined) {
    request.input('escalated', sql.Bit, complaintData.escalated);
    setClauses.push('Escalated = @escalated');
  }
  
  if (complaintData.escalatedTo !== undefined) {
    request.input('escalatedTo', sql.Int, complaintData.escalatedTo);
    setClauses.push('EscalatedTo = @escalatedTo');
  }
  
  if (complaintData.escalatedBy !== undefined) {
    request.input('escalatedBy', sql.Int, complaintData.escalatedBy);
    setClauses.push('EscalatedBy = @escalatedBy');
  }
  
  if (complaintData.escalatedDate !== undefined) {
  request.input('escalatedDate', sql.DateTime, complaintData.escalatedDate);
  setClauses.push('EscalatedDate = @escalatedDate');
}
  
  if (complaintData.escalationReason !== undefined) {
    request.input('escalationReason', sql.NVarChar(500), complaintData.escalationReason);
    setClauses.push('EscalationReason = @escalationReason');
  }

  if (complaintData.solution !== undefined) {
  request.input('solution', sql.NVarChar(sql.MAX), complaintData.solution);
  setClauses.push('Solution = @solution');
}

if (complaintData.solvedDate !== undefined) {
  request.input('solvedDate', sql.DateTime, complaintData.solvedDate);
  setClauses.push('SolvedDate = @solvedDate');
}

if (complaintData.satisfactionLevel !== undefined) {
  request.input('satisfactionLevel', sql.Int, complaintData.satisfactionLevel);
  setClauses.push('SatisfactionLevel = @satisfactionLevel');
}
  
  if (setClauses.length === 0) {
    return false;
  }
  
  const query = `
    UPDATE Complaints
    SET ${setClauses.join(', ')}
    WHERE ComplaintID = @id
  `;
  
  await request.query(query);
  return true;
}

// ===================================
// حذف شكوى (Soft Delete)
// ===================================
async function deleteComplaint(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE Complaints 
      SET IsActive = 0 
      WHERE ComplaintID = @id
    `);
  return true;
}

// ===================================
// جلب أنواع الشكاوى (النشطة فقط)
// ===================================
async function getComplaintTypes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT TypeID, TypeName, TypeNameAr
      FROM ComplaintTypes
      WHERE IsActive = 1  -- 👈 True مش -1
      ORDER BY TypeNameAr
    `);
  return result.recordset;
}

// ===================================
// التحقق من وجود الشكوى
// ===================================
async function checkComplaintExists(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT ComplaintID FROM Complaints WHERE ComplaintID = @id');
  return result.recordset.length > 0;
}

// ===================================
// تصدير الدوال
// ===================================
module.exports = {
  createComplaint,
  getAllComplaints,
  getComplaintById,
  updateComplaint,
  deleteComplaint,
  getComplaintTypes,
  checkComplaintExists,
  getComplaintStats,
  assignComplaint,
  changeComplaintStatus,
  rateComplaint
};