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
    .input('status', sql.TinyInt, complaintData.status || 1) // 1 = جديدة
    .input('assignedTo', sql.Int, complaintData.assignedTo || null)
    .input('createdBy', sql.NVarChar(100), complaintData.createdBy)
    .input('createdAt', sql.DateTime, complaintData.createdAt)
    .input('escalated', sql.Bit, false)
    .query(`
      INSERT INTO Complaints (
        PartyID, OpportunityID, TypeID, Subject, Details,
        Priority, Status, AssignedTo, CreatedBy, CreatedAt, Escalated
      )
      OUTPUT INSERTED.ComplaintID
      VALUES (
        @partyId, @opportunityId, @typeId, @subject, @details,
        @priority, @status, @assignedTo, @createdBy, @createdAt, @escalated
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
      p.Phone,
      c.TypeID,
      ct.TypeNameAr AS ComplaintType,
      c.Subject,
      c.Details,
      c.Priority,
      c.Status,
      c.AssignedTo,
      e.FullName AS AssignedToName,
      c.CreatedBy,
      c.CreatedAt,
      c.Escalated
    FROM Complaints c
    LEFT JOIN Parties p ON c.PartyID = p.PartyID
    LEFT JOIN ComplaintTypes ct ON c.TypeID = ct.TypeID
    LEFT JOIN Employees e ON c.AssignedTo = e.EmployeeID
    WHERE 1=1
  `;
  
  // تطبيق الفلاتر لو موجودة
  if (filters.status) {
    request.input('status', sql.TinyInt, filters.status);
    query += ` AND c.Status = @status`;
  }
  
  if (filters.priority) {
    request.input('priority', sql.TinyInt, filters.priority);
    query += ` AND c.Priority = @priority`;
  }
  
  if (filters.typeId) {
    request.input('typeId', sql.Int, filters.typeId);
    query += ` AND c.TypeID = @typeId`;
  }
  
  if (filters.assignedTo) {
    request.input('assignedTo', sql.Int, filters.assignedTo);
    query += ` AND c.AssignedTo = @assignedTo`;
  }
  
  if (filters.escalated !== undefined) {
    request.input('escalated', sql.Bit, filters.escalated);
    query += ` AND c.Escalated = @escalated`;
  }
  
  query += ` ORDER BY c.CreatedAt DESC`;
  
  const result = await request.query(query);
  return result.recordset;
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
        c.CreatedBy,
        c.CreatedAt,
        c.Escalated,
        c.EscalatedTo,
        e2.FullName AS EscalatedToName,
        c.EscalatedBy,
        e3.FullName AS EscalatedByName,
        c.EscalatedAt,
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
  
  // بناء جملة SET ديناميكياً حسب الحقول المرسلة
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
  
  // لو مفيش حاجة اتغيرت، نرجع false
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
      WHERE IsActive = -1
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
  checkComplaintExists
};