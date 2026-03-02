const { sql, connectDB } = require('../../core/database');

// ===================================
// جلب متابعات شكوى معينة
// ===================================
async function getFollowUpsByComplaintId(complaintId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('complaintId', sql.Int, complaintId)
    .query(`
      SELECT 
        cf.FollowUpID,
        cf.ComplaintID,
        cf.FollowUpDate,
        cf.FollowUpBy,
        e.FullName AS FollowUpByName,
        cf.Notes,
        cf.ActionTaken,
        cf.NextFollowUpDate
      FROM ComplaintFollowUps cf
      LEFT JOIN Employees e ON cf.FollowUpBy = e.EmployeeID
      WHERE cf.ComplaintID = @complaintId
      ORDER BY cf.FollowUpDate DESC
    `);
  return result.recordset;
}

// ===================================
// إضافة متابعة جديدة
// ===================================
async function createFollowUp(followUpData) {
  const pool = await connectDB();
  
  const result = await pool.request()
    .input('complaintId', sql.Int, followUpData.complaintId)
    .input('followUpBy', sql.Int, followUpData.followUpBy)
    .input('notes', sql.NVarChar(sql.MAX), followUpData.notes)
    .input('actionTaken', sql.NVarChar(500), followUpData.actionTaken || null)
    .input('nextFollowUpDate', sql.DateTime, followUpData.nextFollowUpDate || null)
    .input('followUpDate', sql.DateTime, followUpData.followUpDate || new Date())
    .query(`
      INSERT INTO ComplaintFollowUps (
        ComplaintID, FollowUpBy, Notes, ActionTaken, NextFollowUpDate, FollowUpDate
      )
      OUTPUT INSERTED.FollowUpID
      VALUES (
        @complaintId, @followUpBy, @notes, @actionTaken, @nextFollowUpDate, @followUpDate
      )
    `);
  
  return result.recordset[0].FollowUpID;
}

// ===================================
// تعديل متابعة
// ===================================
async function updateFollowUp(id, followUpData) {
  const pool = await connectDB();
  const request = pool.request()
    .input('id', sql.Int, id);
  
  let setClauses = [];
  
  if (followUpData.notes !== undefined) {
    request.input('notes', sql.NVarChar(sql.MAX), followUpData.notes);
    setClauses.push('Notes = @notes');
  }
  
  if (followUpData.actionTaken !== undefined) {
    request.input('actionTaken', sql.NVarChar(500), followUpData.actionTaken);
    setClauses.push('ActionTaken = @actionTaken');
  }
  
  if (followUpData.nextFollowUpDate !== undefined) {
    request.input('nextFollowUpDate', sql.DateTime, followUpData.nextFollowUpDate);
    setClauses.push('NextFollowUpDate = @nextFollowUpDate');
  }
  
  if (setClauses.length === 0) {
    return false;
  }
  
  const query = `
    UPDATE ComplaintFollowUps
    SET ${setClauses.join(', ')}
    WHERE FollowUpID = @id
  `;
  
  await request.query(query);
  return true;
}

// ===================================
// حذف متابعة
// ===================================
async function deleteFollowUp(id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query('DELETE FROM ComplaintFollowUps WHERE FollowUpID = @id');
  return true;
}

// ===================================
// التحقق من وجود متابعة
// ===================================
async function checkFollowUpExists(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT FollowUpID FROM ComplaintFollowUps WHERE FollowUpID = @id');
  return result.recordset.length > 0;
}

module.exports = {
  getFollowUpsByComplaintId,
  createFollowUp,
  updateFollowUp,
  deleteFollowUp,
  checkFollowUpExists
};