const { sql, connectDB } = require('../../core/database');

// استعلام تسجيل الدخول
async function findUserByCredentials(username, password) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .input('password', sql.NVarChar, password)
    .query(`
      SELECT UserID, Username, FullName, Email, employeeID 
      FROM Users 
      WHERE Username = @username 
        AND Password = @password 
        AND IsActive = 1
    `);
  return result.recordset[0] || null;
}

// استعلام صلاحيات المستخدم
async function getUserPermissions(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT 
        p.PermissionID, p.PermissionName, p.FormName, p.Category,
        up.CanView, up.CanAdd, up.CanEdit, up.CanDelete
      FROM UserPermissions up
      INNER JOIN Permissions p ON up.PermissionID = p.PermissionID
      WHERE up.UserID = @userId
    `);
  return result.recordset;
}

// استعلام حفظ FCM Token
async function saveFcmToken(userId, fcmToken) {
  const pool = await connectDB();
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('fcmToken', sql.NVarChar(500), fcmToken)
    .query('UPDATE Users SET FCMToken = @fcmToken WHERE UserID = @userId');
  return true;
}

// استعلام جلب FCM Token للمستخدم
async function getFcmTokenByUsername(username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query('SELECT FCMToken FROM Users WHERE Username = @username AND FCMToken IS NOT NULL');
  return result.recordset[0]?.FCMToken || null;
}

// استعلام جلب بيانات الموظف المرتبط بالمستخدم
async function getEmployeeByUserId(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT u.employeeID, e.FullName
      FROM Users u
      LEFT JOIN Employees e ON u.employeeID = e.EmployeeID
      WHERE u.UserID = @userId
    `);
  return result.recordset[0] || null;
}

async function getUserById(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('uid', sql.Int, userId)
    .query('SELECT * FROM Users WHERE UserID = @uid');
  
  return result.recordset[0];
}

async function updateUserPassword(userId, newPassword) {
  const pool = await connectDB();
  await pool.request()
    .input('uid', sql.Int, userId)
    .input('pass', sql.NVarChar, newPassword)
    .query('UPDATE Users SET Password = @pass WHERE UserID = @uid');
}

// تصدير الدوال
module.exports = {
  findUserByCredentials,
  getUserPermissions,
  saveFcmToken,
  getFcmTokenByUsername,
  getEmployeeByUserId,
  getUserById,
  updateUserPassword
};