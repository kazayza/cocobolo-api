const { sql, connectDB } = require('../../core/database');
const bcrypt = require('bcryptjs');

// ═══════════════════════════════════════════════════════════
// تسجيل الدخول — "تحقق ذكي" (زي الـ Blazor بالظبط)
//
// الحالات:
// 1) المستخدم عنده HashedPassword → تحقق بـ bcrypt
// 2) المستخدم قديم (plain فقط) → تحقق بالمقارنة المباشرة،
//    وعند النجاح نعمل ترحيل تلقائي → نحفظ bcrypt hash فوراً
//    (فأول دخول بعد التحديث بيحوّله للتشفير من غير ما يحس)
// ═══════════════════════════════════════════════════════════
async function findUserByCredentials(username, password) {
  const pool = await connectDB();

  // نجيب المستخدم بـ username فقط (مش بنقارن الباسورد في الـ SQL)
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query(`
      SELECT UserID, Username, FullName, Email, employeeID, Role,
             Password, HashedPassword, IsActive
      FROM Users 
      WHERE Username = @username AND IsActive = 1
    `);

  const user = result.recordset[0];
  if (!user) return null;

  // ── 1) عنده Hash → تحقق بـ bcrypt ─────────────────────
  if (user.HashedPassword) {
    const valid = await bcrypt.compare(password, user.HashedPassword);
    return valid ? user : null;
  }

  // ── 2) قديم (plain) → مقارنة مباشرة + ترحيل تلقائي ────
  if (user.Password === password) {
    // أول دخول ناجح → نشفر فوراً ونحفظ (المرة الجاية هيدخل بـ bcrypt)
    try {
      const hashed = await bcrypt.hash(password, 10);
      await pool.request()
        .input('uid', sql.Int, user.UserID)
        .input('hash', sql.NVarChar(255), hashed)
        .query('UPDATE Users SET HashedPassword = @hash WHERE UserID = @uid');
    } catch (e) {
      console.error('⚠️ فشل ترحيل كلمة المرور للتشفير:', e.message);
      // مش فشل الدخول — بنكمّل عادي
    }
    return user;
  }

  return null;
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

async function updateUserPassword(userId, newPassword, hashedPassword = null) {
  const pool = await connectDB();
  const request = pool.request()
    .input('uid', sql.Int, userId)
    .input('pass', sql.NVarChar, newPassword);

  let query = 'UPDATE Users SET Password = @pass';
  if (hashedPassword) {
    request.input('hash', sql.NVarChar(255), hashedPassword);
    query += ', HashedPassword = @hash';
  }
  query += ' WHERE UserID = @uid';

  await request.query(query);
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