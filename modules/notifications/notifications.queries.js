const { sql, connectDB } = require('../../core/database');

// جلب الإشعارات غير المقروءة
async function getUnreadNotifications(username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query(`
      SELECT 
        NotificationID, Title, Message, RelatedTable, RelatedID,
        FormName, CreatedBy,
        FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt,
        ReminderEnabled
      FROM Notifications 
      WHERE RecipientUser = @username AND IsRead = 0
      ORDER BY CreatedAt DESC
    `);
  return result.recordset;
}

// جلب كل الإشعارات
async function getAllNotifications(username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query(`
      SELECT 
        NotificationID, Title, Message, RelatedTable, RelatedID,
        FormName, IsRead, CreatedBy,
        FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt, ReadAt
      FROM Notifications 
      WHERE RecipientUser = @username
      ORDER BY CreatedAt DESC
    `);
  return result.recordset;
}

// تحديد كل الإشعارات كمقروءة
async function markAllAsRead(username) {
  const pool = await connectDB();
  await pool.request()
    .input('username', sql.NVarChar, username)
    .query(`
      UPDATE Notifications 
      SET IsRead = 1, ReadAt = GETDATE() 
      WHERE RecipientUser = @username AND IsRead = 0
    `);
  return true;
}

// تحديد إشعار واحد كمقروء
async function markAsRead(notificationId) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, notificationId)
    .query(`
      UPDATE Notifications 
      SET IsRead = 1, ReadAt = GETDATE() 
      WHERE NotificationID = @id
    `);
  return true;
}

// إنشاء إشعار جديد
async function createNotification(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('title', sql.NVarChar(200), data.title)
    .input('message', sql.NVarChar(sql.MAX), data.message)
    .input('recipientUser', sql.NVarChar(100), data.recipientUser)
    .input('relatedTable', sql.NVarChar(100), data.relatedTable || null)
    .input('relatedId', sql.Int, data.relatedId || null)
    .input('formName', sql.NVarChar(100), data.formName || null)
    .input('createdBy', sql.NVarChar(100), data.createdBy)
    .query(`
      INSERT INTO Notifications (
        Title, Message, RecipientUser, RelatedTable, RelatedID,
        FormName, IsRead, CreatedBy, CreatedAt, ReminderEnabled
      )
      OUTPUT INSERTED.NotificationID
      VALUES (
        @title, @message, @recipientUser, @relatedTable, @relatedId,
        @formName, 0, @createdBy, GETDATE(), 0
      )
    `);
  return result.recordset[0].NotificationID;
}

// جلب FCM Token للمستخدم
async function getFcmToken(username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query('SELECT FCMToken FROM Users WHERE Username = @username AND FCMToken IS NOT NULL');
  return result.recordset[0]?.FCMToken || null;
}

// تصدير الدوال
module.exports = {
  getUnreadNotifications,
  getAllNotifications,
  markAllAsRead,
  markAsRead,
  createNotification,
  getFcmToken
};