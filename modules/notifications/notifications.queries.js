const { sql, connectDB } = require('../../core/database');
const { sendPushNotification, isFirebaseReady } = require('../../core/firebase');

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

// إنشاء إشعار جديد (مع إرسال Push Notification لحظي عبر Firebase)
async function createNotification(data) {
  const pool = await connectDB();
  
  // 1. حفظ الإشعار في قاعدة البيانات
  const result = await pool.request()
    .input('title', sql.NVarChar(200), data.title)
    .input('message', sql.NVarChar(sql.MAX), data.message)
    .input('recipientUser', sql.NVarChar(100), data.recipientUser)
    .input('relatedTable', sql.NVarChar(100), data.relatedTable || null)
    .input('relatedId', sql.Int, data.relatedId || null)
    .input('formName', sql.NVarChar(100), data.formName || null)
    .input('createdBy', sql.NVarChar(100), data.createdBy)
    .query(`
      DECLARE @NewID TABLE (NotificationID int);
        INSERT INTO Notifications (
          Title, Message, RecipientUser, RelatedTable, RelatedID,
          FormName, IsRead, CreatedBy, CreatedAt, ReminderEnabled
        )
        OUTPUT INSERTED.NotificationID INTO @NewID
        VALUES (
          @title, @message, @recipientUser, @relatedTable, @relatedId,
          @formName, 0, @createdBy, GETDATE(), 0
        );
        SELECT NotificationID FROM @NewID;
      `);

  const notificationId = result.recordset[0].NotificationID;

  // 2. إرسال Push Notification فوراً (حتى لو التطبيق مقفول)
  try {
    if (isFirebaseReady()) {
      const tokenResult = await pool.request()
        .input('username', sql.NVarChar(100), data.recipientUser)
        .query('SELECT FCMToken FROM Users WHERE Username = @username AND FCMToken IS NOT NULL');

      const fcmToken = tokenResult.recordset[0]?.FCMToken;

      if (fcmToken) {
        await sendPushNotification(fcmToken, data.title, data.message, {
          formName: data.formName || '',
          relatedId: String(data.relatedId || ''),
          notificationId: String(notificationId)
        });
        console.log(`🔥 [FCM Push] تم إرسال إشعار لحظي بنجاح إلى المستخدم: ${data.recipientUser}`);
      } else {
        console.log(`⚠️ [FCM Push] المستخدم ${data.recipientUser} ليس لديه FCM Token مسجل.`);
      }
    }
  } catch (pushErr) {
    console.error('❌ خطأ في إرسال Push Notification اللحظي:', pushErr.message);
  }

  return notificationId;
}

// إرسال إشعار ذكي (لرول أو ليوزر محدد)
async function createNotificationSmart(data, target) {
  const pool = await connectDB();
  
  // 1. تحديد المستلمين
  const usersResult = await pool.request()
    .input('target', sql.NVarChar, target)
    .query(`
      SELECT Username 
      FROM Users 
      WHERE 
         Role = @target        -- لو هو رول (زي SalesManager)
         OR Username = @target -- لو هو يوزر محدد (زي Factory)
    `);

  const recipients = usersResult.recordset;
  if (recipients.length === 0) return 0;

  let insertedCount = 0;
  for (const user of recipients) {
    if (user.Username === data.createdBy) continue;

    // استدعاء دالة createNotification لضمان حفظ الإشعار وإرسال الـ Push للجميع
    await createNotification({
      ...data,
      recipientUser: user.Username
    });
    
    insertedCount++;
  }
  return insertedCount;
}

// جلب FCM Tokens لدور محدد
async function getFcmTokensByRole(role) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('role', sql.NVarChar, role)
    .query(`
      SELECT Username, FCMToken
      FROM Users
      WHERE IsActive = 1 AND FCMToken IS NOT NULL AND FCMToken != ''
        AND LOWER(LTRIM(RTRIM(Role))) = LOWER(LTRIM(RTRIM(@role)))
    `);
  return result.recordset;
}

// جلب FCM Token للمستخدم
async function getFcmToken(username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar, username)
    .query('SELECT FCMToken FROM Users WHERE Username = @username AND FCMToken IS NOT NULL');
  return result.recordset[0]?.FCMToken || null;
}

// ═══════════════════════════════════════════════════════════
// كل توكنات FCM للمستخدمين النشطين (للبث المباشر)
// ═══════════════════════════════════════════════════════════
async function getAllFcmTokens() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT Username, FCMToken
    FROM Users
    WHERE IsActive = 1 AND FCMToken IS NOT NULL AND FCMToken != ''
  `);
  return result.recordset;
}

// تصدير الدوال
module.exports = {
  getUnreadNotifications,
  getAllNotifications,
  markAllAsRead,
  markAsRead,
  createNotification,
  createNotificationSmart,
  getFcmToken,
  getAllFcmTokens,
  getFcmTokensByRole
};