const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════
// قائمة المستخدمين (مع عدّاد الصلاحيات المفعلة)
// ═══════════════════════════════════════════════════════════
async function getAllUsers() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT
      u.UserID,
      u.Username,
      u.FullName,
      u.Email,
      u.Role,
      u.IsActive,
      u.CreatedBy,
      u.CreatedAt,
      u.LastLogin,
      u.employeeID,
      ISNULL(e.FullName, N'') AS EmployeeName,
      (SELECT COUNT(*) FROM UserPermissions up WHERE up.UserID = u.UserID) AS PermissionsCount
    FROM Users u
    LEFT JOIN Employees e ON u.employeeID = e.EmployeeID
    ORDER BY u.CreatedAt DESC
  `);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// مستخدم واحد (بدون كلمة المرور)
// ═══════════════════════════════════════════════════════════
async function getUserById(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT
        u.UserID, u.Username, u.FullName, u.Email, u.Role,
        u.IsActive, u.CreatedBy, u.CreatedAt, u.LastLogin, u.employeeID
      FROM Users u
      WHERE u.UserID = @userId
    `);
  return result.recordset[0] || null;
}

// ═══════════════════════════════════════════════════════════
// التحقق من وجود اسم مستخدم
// ═══════════════════════════════════════════════════════════
async function usernameExists(username, excludeUserId) {
  const pool = await connectDB();
  const request = pool.request()
    .input('username', sql.NVarChar, username);

  let query = 'SELECT COUNT(*) AS cnt FROM Users WHERE Username = @username';
  if (excludeUserId) {
    request.input('excludeId', sql.Int, excludeUserId);
    query += ' AND UserID != @excludeId';
  }

  const result = await request.query(query);
  return result.recordset[0].cnt > 0;
}

// ═══════════════════════════════════════════════════════════
// إضافة مستخدم جديد
// - HashedPassword: bcrypt hash (للـ login الجديد)
// - Password: نحفظه مؤقتاً للتوافق مع الـ login الحالي
//   (حتى يتم ترحيل الـ login للتشفير — المرحلة القادمة)
// ═══════════════════════════════════════════════════════════
async function createUser({
  username, hashedPassword, plainPassword,
  fullName, email, role, isActive, employeeId, createdBy,
}) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar(100), username)
    .input('hashedPassword', sql.NVarChar(255), hashedPassword)
    .input('plainPassword', sql.NVarChar(255), plainPassword)
    .input('fullName', sql.NVarChar(255), fullName)
    .input('email', sql.NVarChar(255), email || null)
    .input('role', sql.NVarChar(50), role || 'User')
    .input('isActive', sql.Bit, isActive ? 1 : 0)
    .input('employeeId', sql.Int, employeeId || null)
    .input('createdBy', sql.NVarChar(100), createdBy || 'System')
    .query(`
      INSERT INTO Users (
        Username, Password, HashedPassword, FullName, Email,
        Role, IsActive, CreatedBy, CreatedAt, employeeID
      )
      OUTPUT INSERTED.UserID
      VALUES (
        @username, @plainPassword, @hashedPassword, @fullName, @email,
        @role, @isActive, @createdBy, GETDATE(), @employeeId
      )
    `);
  return result.recordset[0]?.UserID || null;
}

// ═══════════════════════════════════════════════════════════
// تعديل مستخدم
// ═══════════════════════════════════════════════════════════
async function updateUser(userId, {
  fullName, email, role, isActive, employeeId,
  hashedPassword, plainPassword,
}) {
  const pool = await connectDB();
  const request = pool.request()
    .input('userId', sql.Int, userId)
    .input('fullName', sql.NVarChar(255), fullName)
    .input('email', sql.NVarChar(255), email || null)
    .input('role', sql.NVarChar(50), role || 'User')
    .input('isActive', sql.Bit, isActive ? 1 : 0)
    .input('employeeId', sql.Int, employeeId || null);

  let query = `
    UPDATE Users SET
      FullName = @fullName,
      Email = @email,
      Role = @role,
      IsActive = @isActive,
      employeeID = @employeeId
  `;

  if (hashedPassword) {
    request.input('hashedPassword', sql.NVarChar(255), hashedPassword);
    request.input('plainPassword', sql.NVarChar(255), plainPassword || '');
    query += `, HashedPassword = @hashedPassword, Password = @plainPassword`;
  }

  query += ' WHERE UserID = @userId';

  await request.query(query);
  return true;
}

// ═══════════════════════════════════════════════════════════
// حذف مستخدم + صلاحياته
// ═══════════════════════════════════════════════════════════
async function deleteUser(userId) {
  const pool = await connectDB();
  await pool.request()
    .input('userId', sql.Int, userId)
    .query('DELETE FROM UserPermissions WHERE UserID = @userId');
  await pool.request()
    .input('userId', sql.Int, userId)
    .query('DELETE FROM Users WHERE UserID = @userId');
  return true;
}

// ═══════════════════════════════════════════════════════════
// كل صلاحيات النظام (مجمعة بالفئات)
// ═══════════════════════════════════════════════════════════
async function getAllPermissions() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT PermissionID, PermissionName, Description, Category, FormName
    FROM Permissions
    ORDER BY Category, PermissionName
  `);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// صلاحيات مستخدم معين
// ═══════════════════════════════════════════════════════════
async function getUserPermissions(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT
        up.PermissionID,
        up.CanView, up.CanAdd, up.CanEdit, up.CanDelete,
        up.AssignedBy, up.AssignedDate
      FROM UserPermissions up
      WHERE up.UserID = @userId
    `);
  return result.recordset;
}

// ═══════════════════════════════════════════════════════════
// حفظ صلاحيات مستخدم (حذف الكل ثم إضافة المفعل فقط)
// ═══════════════════════════════════════════════════════════
async function replaceUserPermissions(userId, permissions, assignedBy) {
  const pool = await connectDB();

  // 1. حذف كل الصلاحيات الحالية
  await pool.request()
    .input('userId', sql.Int, userId)
    .query('DELETE FROM UserPermissions WHERE UserID = @userId');

  // 2. إضافة المفعل فقط
  for (const perm of permissions) {
    if (!perm.canView && !perm.canAdd && !perm.canEdit && !perm.canDelete) {
      continue; // مش مفعل → نتخطاه
    }
    await pool.request()
      .input('userId', sql.Int, userId)
      .input('permissionId', sql.Int, perm.permissionId)
      .input('canView', sql.Bit, perm.canView ? 1 : 0)
      .input('canAdd', sql.Bit, perm.canAdd ? 1 : 0)
      .input('canEdit', sql.Bit, perm.canEdit ? 1 : 0)
      .input('canDelete', sql.Bit, perm.canDelete ? 1 : 0)
      .input('assignedBy', sql.NVarChar(100), assignedBy || 'System')
      .query(`
        INSERT INTO UserPermissions (
          UserID, PermissionID, CanView, CanAdd, CanEdit, CanDelete,
          AssignedBy, AssignedDate
        )
        VALUES (
          @userId, @permissionId, @canView, @canAdd, @canEdit, @canDelete,
          @assignedBy, GETDATE()
        )
      `);
  }
  return true;
}

module.exports = {
  getAllUsers,
  getUserById,
  usernameExists,
  createUser,
  updateUser,
  deleteUser,
  getAllPermissions,
  getUserPermissions,
  replaceUserPermissions,
};
