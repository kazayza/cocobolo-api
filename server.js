const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const admin = require('firebase-admin'); // أضفنا Firebase Admin
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// إعدادات الاتصال
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT || '1433'),
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// اتصال واحد مرة واحدة فقط
let pool;
async function connectDB() {
  try {
    if (!pool) {
      pool = await sql.connect(config);
      console.log('✅ متصل بقاعدة البيانات بنجاح');
    }
    return pool;
  } catch (err) {
    console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
    throw err;
  }
}

// تهيئة Firebase Admin SDK من Railway Variables (آمن 100%)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
  console.log('Firebase Admin SDK شغال بنجاح');
}

// تشغيل الاتصال
connectDB();

// ==========================
// 🏠 الصفحة الرئيسية - للتأكد إن السيرفر شغال
// ==========================
app.get('/', (req, res) => {
  res.json({ 
    message: 'COCOBOLO API شغال بنجاح! 🚀', 
    time: new Date().toISOString() 
  });
});

// ==========================
// ✅ اختبار الاتصال
// ==========================
app.get('/api/test', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request().query('SELECT 1 as test');
    res.json({ 
      success: true, 
      message: 'الاتصال بقاعدة البيانات ناجح',
      data: result.recordset 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      message: 'فشل الاتصال بقاعدة البيانات',
      error: err.message 
    });
  }
});

// ==========================
// 🔐 تسجيل الدخول مع الصلاحيات (مرة واحدة فقط!)
// ==========================
app.post('/api/login', async (req, res) => {
  try {
    const pool = await connectDB();
    
    // 1️⃣ التحقق من المستخدم
    const userResult = await pool.request()
      .input('username', sql.NVarChar, req.body.username)
      .input('password', sql.NVarChar, req.body.password)
      .query(`
        SELECT UserID, Username, FullName, Email, employeeID 
        FROM Users 
        WHERE Username = @username 
          AND Password = @password 
          AND IsActive = 1
      `);

    if (userResult.recordset.length === 0) {
      return res.json({ 
        success: false, 
        message: 'اسم المستخدم أو كلمة المرور غير صحيحة' 
      });
    }

    const user = userResult.recordset[0];

    // 2️⃣ جلب صلاحيات المستخدم
    const permissionsResult = await pool.request()
      .input('userId', sql.Int, user.UserID)
      .query(`
        SELECT 
          p.PermissionID,
          p.PermissionName,
          p.FormName,
          p.Category,
          up.CanView,
          up.CanAdd,
          up.CanEdit,
          up.CanDelete
        FROM UserPermissions up
        INNER JOIN Permissions p ON up.PermissionID = p.PermissionID
        WHERE up.UserID = @userId
      `);

    // 3️⃣ تحويل الصلاحيات لـ Object
    const permissions = {};
    permissionsResult.recordset.forEach(perm => {
      permissions[perm.FormName] = {
        permissionId: perm.PermissionID,
        permissionName: perm.PermissionName,
        category: perm.Category,
        canView: perm.CanView,
        canAdd: perm.CanAdd,
        canEdit: perm.CanEdit,
        canDelete: perm.CanDelete
      };
    });

    // 4️⃣ إرسال البيانات
    res.json({ 
      success: true, 
      user: user,
      permissions: permissions
    });

  } catch (err) {
    console.error('خطأ في تسجيل الدخول:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// ==========================
// 🏠 لوحة التحكم
// ==========================
app.get('/api/dashboard', async (req, res) => {
  try {
    const { userId, username } = req.query;
    const pool = await connectDB();

    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .input('username', sql.NVarChar, username)
      .query(`
        SELECT 
          (SELECT COUNT(*) FROM Parties WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newClientsToday,
          (SELECT COUNT(*) FROM SalesOpportunities WHERE StageID NOT IN (6,7)) as openOpportunities,
          (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed') as tasksToday,
          (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale') as salesToday,
          (SELECT COUNT(*) FROM Notifications 
           WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
      `);

    res.json({
      summary: result.recordset[0],
      unreadCount: result.recordset[0]?.unreadCount || 0
    });
  } catch (err) {
    console.error('خطأ في الداشبورد:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================
// 👥 العملاء
// ==========================
app.get('/api/clients', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT 
          PartyID, PartyName, Phone, Phone2, Email,
          Address, TaxNumber, OpeningBalance, BalanceType,
          ContactPerson, NationalID
        FROM Parties 
        WHERE PartyType = 1 AND IsActive = 1 
        ORDER BY PartyName
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب العملاء:', err);
    res.status(500).json({ message: 'فشل تحميل العملاء' });
  }
});

app.get('/api/customers-list', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT PartyID, PartyName, Phone
        FROM Parties 
        WHERE PartyType = 1 AND IsActive = 1
        ORDER BY PartyName
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب العملاء:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================
// 👥 العملاء - APIs إضافية
// ==========================

// ✅ جلب تفاصيل عميل واحد
app.get('/api/clients/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT 
          p.PartyID, p.PartyName, p.PartyType, p.ContactPerson,
          p.Phone, p.Phone2, p.Email, p.Address, p.TaxNumber,
          p.OpeningBalance, p.BalanceType, p.Notes, p.IsActive,
          p.NationalID, p.FloorNumber, p.CreatedBy, p.CreatedAt,
          p.ReferralSourceID, p.ReferralSourceClient,
          rs.SourceName AS ReferralSourceName
        FROM Parties p
        LEFT JOIN ReferralSources rs ON p.ReferralSourceID = rs.ReferralSourceID
        WHERE p.PartyID = @id
      `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'العميل غير موجود' });
    }
    
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('خطأ في جلب تفاصيل العميل:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ إضافة عميل جديد
app.post('/api/clients', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      partyName, contactPerson, phone, phone2, email, address,
      taxNumber, openingBalance, balanceType, notes, nationalId,
      floorNumber, referralSourceId, referralSourceClient, createdBy
    } = req.body;
    
    // التحقق من عدم تكرار الاسم
    const checkResult = await pool.request()
      .input('partyName', sql.NVarChar(200), partyName)
      .query('SELECT PartyID FROM Parties WHERE PartyName = @partyName AND IsActive = 1');
    
    if (checkResult.recordset.length > 0) {
      return res.json({ success: false, message: 'اسم العميل موجود مسبقاً' });
    }
    
    const result = await pool.request()
      .input('partyName', sql.NVarChar(200), partyName)
      .input('partyType', sql.Int, 1) // عميل
      .input('contactPerson', sql.NVarChar(100), contactPerson || null)
      .input('phone', sql.NVarChar(50), phone || null)
      .input('phone2', sql.NVarChar(50), phone2 || null)
      .input('email', sql.NVarChar(100), email || null)
      .input('address', sql.NVarChar(250), address || null)
      .input('taxNumber', sql.NVarChar(50), taxNumber || null)
      .input('openingBalance', sql.Decimal(18, 2), openingBalance || 0)
      .input('balanceType', sql.Char(1), balanceType || 'D')
      .input('notes', sql.NVarChar(255), notes || null)
      .input('nationalId', sql.NVarChar(14), nationalId || null)
      .input('floorNumber', sql.NVarChar(50), floorNumber || null)
      .input('referralSourceId', sql.Int, referralSourceId || null)
      .input('referralSourceClient', sql.Int, referralSourceClient || null)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO Parties (
          PartyName, PartyType, ContactPerson, Phone, Phone2, Email,
          Address, TaxNumber, OpeningBalance, BalanceType, Notes,
          NationalID, FloorNumber, ReferralSourceID, ReferralSourceClient,
          IsActive, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.PartyID
        VALUES (
          @partyName, @partyType, @contactPerson, @phone, @phone2, @email,
          @address, @taxNumber, @openingBalance, @balanceType, @notes,
          @nationalId, @floorNumber, @referralSourceId, @referralSourceClient,
          1, @createdBy, GETDATE()
        )
      `);
    
    res.json({ 
      success: true, 
      partyId: result.recordset[0].PartyID,
      message: 'تم إضافة العميل بنجاح' 
    });
  } catch (err) {
    console.error('خطأ في إضافة العميل:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ تعديل عميل
app.put('/api/clients/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      partyName, contactPerson, phone, phone2, email, address,
      taxNumber, openingBalance, balanceType, notes, nationalId,
      floorNumber, referralSourceId, referralSourceClient
    } = req.body;
    
    // التحقق من عدم تكرار الاسم (ما عدا نفس العميل)
    const checkResult = await pool.request()
      .input('partyName', sql.NVarChar(200), partyName)
      .input('id', sql.Int, req.params.id)
      .query('SELECT PartyID FROM Parties WHERE PartyName = @partyName AND PartyID != @id AND IsActive = 1');
    
    if (checkResult.recordset.length > 0) {
      return res.json({ success: false, message: 'اسم العميل موجود مسبقاً' });
    }
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('partyName', sql.NVarChar(200), partyName)
      .input('contactPerson', sql.NVarChar(100), contactPerson || null)
      .input('phone', sql.NVarChar(50), phone || null)
      .input('phone2', sql.NVarChar(50), phone2 || null)
      .input('email', sql.NVarChar(100), email || null)
      .input('address', sql.NVarChar(250), address || null)
      .input('taxNumber', sql.NVarChar(50), taxNumber || null)
      .input('openingBalance', sql.Decimal(18, 2), openingBalance || 0)
      .input('balanceType', sql.Char(1), balanceType || 'D')
      .input('notes', sql.NVarChar(255), notes || null)
      .input('nationalId', sql.NVarChar(14), nationalId || null)
      .input('floorNumber', sql.NVarChar(50), floorNumber || null)
      .input('referralSourceId', sql.Int, referralSourceId || null)
      .input('referralSourceClient', sql.Int, referralSourceClient || null)
      .query(`
        UPDATE Parties SET
          PartyName = @partyName, ContactPerson = @contactPerson,
          Phone = @phone, Phone2 = @phone2, Email = @email,
          Address = @address, TaxNumber = @taxNumber,
          OpeningBalance = @openingBalance, BalanceType = @balanceType,
          Notes = @notes, NationalID = @nationalId, FloorNumber = @floorNumber,
          ReferralSourceID = @referralSourceId, ReferralSourceClient = @referralSourceClient
        WHERE PartyID = @id
      `);
    
    res.json({ success: true, message: 'تم تعديل العميل بنجاح' });
  } catch (err) {
    console.error('خطأ في تعديل العميل:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ حذف عميل (Soft Delete)
app.delete('/api/clients/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    
    // التحقق من عدم وجود معاملات مرتبطة
    const checkResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT COUNT(*) as count FROM Transactions WHERE PartyID = @id');
    
    if (checkResult.recordset[0].count > 0) {
      return res.json({ 
        success: false, 
        message: 'لا يمكن حذف العميل لوجود معاملات مرتبطة به' 
      });
    }
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('UPDATE Parties SET IsActive = 0 WHERE PartyID = @id');
    
    res.json({ success: true, message: 'تم حذف العميل بنجاح' });
  } catch (err) {
    console.error('خطأ في حذف العميل:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ جلب مصادر الإحالة
app.get('/api/referral-sources', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query('SELECT ReferralSourceID, SourceName FROM ReferralSources WHERE IsActive = 1 ORDER BY SourceName');
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب مصادر الإحالة:', err);
    res.status(500).json({ message: err.message });
  }
});

// ✅ ملخص العملاء
app.get('/api/clients/summary', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT 
          (SELECT COUNT(*) FROM Parties WHERE PartyType = 1 AND IsActive = 1) as totalClients,
          (SELECT COUNT(*) FROM Parties WHERE PartyType = 1 AND IsActive = 1 
           AND CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newToday,
          (SELECT COUNT(*) FROM Parties WHERE PartyType = 1 AND IsActive = 1 
           AND MONTH(CreatedAt) = MONTH(GETDATE()) AND YEAR(CreatedAt) = YEAR(GETDATE())) as newThisMonth
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('خطأ في جلب ملخص العملاء:', err);
    res.status(500).json({ message: err.message });
  }
});



// ==========================
// 🔔 الإشعارات
// ==========================
app.get('/api/notifications/unread', async (req, res) => {
  try {
    const { username } = req.query;
    const pool = await connectDB();
    
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`
        SELECT 
          NotificationID,
          Title,
          Message,
          RelatedTable,
          RelatedID,
          FormName,
          CreatedBy,
          FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt,
          ReminderEnabled
        FROM Notifications 
        WHERE RecipientUser = @username 
          AND IsRead = 0
        ORDER BY CreatedAt DESC
      `);
    
    res.json({
      count: result.recordset.length,
      notifications: result.recordset
    });
  } catch (err) {
    console.error('خطأ في جلب الإشعارات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/notifications/read-all', async (req, res) => {
  try {
    const { username } = req.body;
    const pool = await connectDB();
    
    await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`
        UPDATE Notifications 
        SET IsRead = 1, ReadAt = GETDATE() 
        WHERE RecipientUser = @username AND IsRead = 0
      `);
    
    res.json({ success: true, message: 'تم تحديد الكل كمقروء' });
  } catch (err) {
    console.error('خطأ في تحديث الإشعارات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const { username } = req.query;
    const pool = await connectDB();
    
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .query(`
        SELECT 
          NotificationID,
          Title,
          Message,
          RelatedTable,
          RelatedID,
          FormName,
          IsRead,
          CreatedBy,
          FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt,
          ReadAt
        FROM Notifications 
        WHERE RecipientUser = @username
        ORDER BY CreatedAt DESC
      `);
    
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب الإشعارات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const pool = await connectDB();
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        UPDATE Notifications 
        SET IsRead = 1, ReadAt = GETDATE() 
        WHERE NotificationID = @id
      `);
    
    res.json({ success: true });
  } catch (err) {
    console.error('خطأ في تحديث الإشعار:', err);
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/notifications', async (req, res) => {
  try {
    const {
      title,
      message,
      recipientUser,
      relatedTable,
      relatedId,
      formName,
      createdBy
    } = req.body;
    
    const pool = await connectDB();
    
    const result = await pool.request()
      .input('title', sql.NVarChar(200), title)
      .input('message', sql.NVarChar(sql.MAX), message)
      .input('recipientUser', sql.NVarChar(100), recipientUser)
      .input('relatedTable', sql.NVarChar(100), relatedTable || null)
      .input('relatedId', sql.Int, relatedId || null)
      .input('formName', sql.NVarChar(100), formName || null)
      .input('createdBy', sql.NVarChar(100), createdBy)
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
    
    res.json({ 
      success: true, 
      notificationId: result.recordset[0].NotificationID 
    });
  } catch (err) {
    console.error('خطأ في إرسال الإشعار:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// حفظ FCM Token للمستخدم
// ==========================
app.post('/api/users/save-token', async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;
    
    if (!userId || !fcmToken) {
      return res.status(400).json({ success: false, message: 'userId و fcmToken مطلوبين' });
    }

    const pool = await connectDB();
    await pool.request()
      .input('userId', sql.Int, userId)
      .input('fcmToken', sql.NVarChar(500), fcmToken)
      .query('UPDATE Users SET FCMToken = @fcmToken WHERE UserID = @userId');

    console.log(`تم حفظ FCM Token للمستخدم ${userId}`);
    res.json({ success: true, message: 'تم حفظ التوكن بنجاح' });

  } catch (err) {
    console.error('خطأ في حفظ FCM Token:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// إرسال Push Notification لمستخدم معين
// ==========================
app.post('/api/notifications/send-push', async (req, res) => {
  try {
    const { recipientUser, title, message, data } = req.body;

    if (!recipientUser || !title || !message) {
      return res.status(400).json({ success: false, message: 'البيانات ناقصة' });
    }

    const pool = await connectDB();
    
    const tokenResult = await pool.request()
      .input('username', sql.NVarChar, recipientUser)
      .query('SELECT FCMToken FROM Users WHERE Username = @username AND FCMToken IS NOT NULL');

    if (tokenResult.recordset.length === 0) {
      return res.json({ success: false, message: 'المستخدم لا يملك توكن FCM' });
    }

    const fcmToken = tokenResult.recordset[0].FCMToken;

    const payload = {
      token: fcmToken,
      notification: {
        title: title,
        body: message,
      },
      data: data || {},
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'high_importance_channel',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    };

    await admin.messaging().send(payload);
    console.log(`تم إرسال Push بنجاح لـ ${recipientUser}`);

    res.json({ 
      success: true, 
      message: 'تم إرسال الإشعار بنجاح'
    });

  } catch (err) {
    console.error('خطأ في إرسال Push:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// 📦 المنتجات
// ==========================
app.get('/api/product-groups', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query('SELECT ProductGroupID, GroupName FROM ProductGroups ORDER BY GroupName');
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب المجموعات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { search, groupId } = req.query;
    const pool = await connectDB();
    
    let query = `
      SELECT 
        p.ProductID, p.ProductName, p.ProductDescription,
        p.SuggestedSalePrice, p.PurchasePrice, p.QTY, p.Period,
        p.PricingType, p.Customer,
        pg.ProductGroupID, pg.GroupName,
        pa.PartyName AS CustomerName,
        (SELECT TOP 1 CAST(ImageProduct AS VARBINARY(MAX)) 
         FROM ProductImages WHERE ProductID = p.ProductID) AS ProductImage
      FROM Products p
      INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
      LEFT JOIN Parties pa ON p.Customer = pa.PartyID
      WHERE 1=1
    `;
    
    const request = pool.request();
    
    if (search && search.trim() !== '') {
      query += ` AND (p.ProductName LIKE @search OR pa.PartyName LIKE @search)`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    
    if (groupId && groupId !== '' && groupId !== '0') {
      query += ` AND p.ProductGroupID = @groupId`;
      request.input('groupId', sql.Int, groupId);
    }
    
    query += ` ORDER BY p.ProductID DESC`;
    
    const result = await request.query(query);
    
    const products = result.recordset.map(product => ({
      ...product,
      ProductImage: product.ProductImage 
        ? Buffer.from(product.ProductImage).toString('base64')
        : null
    }));
    
    res.json(products);
  } catch (err) {
    console.error('خطأ في جلب المنتجات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    
    const productResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT p.*, pg.GroupName, pa.PartyName AS CustomerName
        FROM Products p
        INNER JOIN ProductGroups pg ON p.ProductGroupID = pg.ProductGroupID
        LEFT JOIN Parties pa ON p.Customer = pa.PartyID
        WHERE p.ProductID = @id
      `);
    
    if (productResult.recordset.length === 0) {
      return res.status(404).json({ message: 'المنتج غير موجود' });
    }
    
    const imagesResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT ProductImagesID, ImageNote,
               CAST(ImageProduct AS VARBINARY(MAX)) AS ImageProduct
        FROM ProductImages WHERE ProductID = @id
      `);
    
    const componentsResult = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT ComponentID, ComponentName, Quantity FROM ProductComponents WHERE ProductID = @id');
    
    res.json({
      ...productResult.recordset[0],
      images: imagesResult.recordset.map(img => ({
        id: img.ProductImagesID,
        note: img.ImageNote,
        image: img.ImageProduct ? Buffer.from(img.ImageProduct).toString('base64') : null
      })),
      components: componentsResult.recordset
    });
  } catch (err) {
    console.error('خطأ في جلب المنتج:', err);
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      productName, productDescription, manufacturingDescription,
      productGroupId, customerId, purchasePrice, suggestedSalePrice,
      pricingType, qty, period, createdBy
    } = req.body;
    
    const result = await pool.request()
      .input('productName', sql.NVarChar(100), productName)
      .input('productDescription', sql.NVarChar(150), productDescription || '')
      .input('manufacturingDescription', sql.NVarChar(sql.MAX), manufacturingDescription)
      .input('productGroupId', sql.Int, productGroupId)
      .input('customerId', sql.Int, customerId || null)
      .input('purchasePrice', sql.Decimal(18, 2), purchasePrice || 0)
      .input('suggestedSalePrice', sql.Decimal(18, 2), suggestedSalePrice || 0)
      .input('pricingType', sql.NVarChar(50), pricingType)
      .input('qty', sql.Int, qty || 1)
      .input('period', sql.Int, period || 0)
      .input('createdBy', sql.NVarChar(100), createdBy)
      .query(`
        INSERT INTO Products (
          ProductName, ProductDescription, ManufacturingDescription,
          ProductGroupID, Customer, PurchasePrice, SuggestedSalePrice,
          PricingType, QTY, Period, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.ProductID
        VALUES (
          @productName, @productDescription, @manufacturingDescription,
          @productGroupId, @customerId, @purchasePrice, @suggestedSalePrice,
          @pricingType, @qty, @period, @createdBy, GETDATE()
        )
      `);
    
    res.json({ success: true, productId: result.recordset[0].ProductID, message: 'تم إضافة المنتج بنجاح' });
  } catch (err) {
    console.error('خطأ في إضافة المنتج:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      productName, productDescription, manufacturingDescription,
      productGroupId, customerId, purchasePrice, suggestedSalePrice,
      pricingType, qty, period
    } = req.body;
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('productName', sql.NVarChar(100), productName)
      .input('productDescription', sql.NVarChar(150), productDescription || '')
      .input('manufacturingDescription', sql.NVarChar(sql.MAX), manufacturingDescription)
      .input('productGroupId', sql.Int, productGroupId)
      .input('customerId', sql.Int, customerId || null)
      .input('purchasePrice', sql.Decimal(18, 2), purchasePrice || 0)
      .input('suggestedSalePrice', sql.Decimal(18, 2), suggestedSalePrice || 0)
      .input('pricingType', sql.NVarChar(50), pricingType)
      .input('qty', sql.Int, qty || 1)
      .input('period', sql.Int, period || 0)
      .query(`
        UPDATE Products SET
          ProductName = @productName, ProductDescription = @productDescription,
          ManufacturingDescription = @manufacturingDescription,
          ProductGroupID = @productGroupId, Customer = @customerId,
          PurchasePrice = @purchasePrice, SuggestedSalePrice = @suggestedSalePrice,
          PricingType = @pricingType, QTY = @qty, Period = @period
        WHERE ProductID = @id
      `);
    
    res.json({ success: true, message: 'تم تعديل المنتج بنجاح' });
  } catch (err) {
    console.error('خطأ في تعديل المنتج:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/products/:id/images', async (req, res) => {
  try {
    const pool = await connectDB();
    const { imageBase64, imageNote } = req.body;
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    
    await pool.request()
      .input('productId', sql.Int, req.params.id)
      .input('imageProduct', sql.VarBinary(sql.MAX), imageBuffer)
      .input('imageNote', sql.NVarChar(255), imageNote || '')
      .query(`
        INSERT INTO ProductImages (ProductID, ImageProduct, ImagePath, ImageNote, CreatedAt)
        VALUES (@productId, @imageProduct, '', @imageNote, GETDATE())
      `);
    
    res.json({ success: true, message: 'تم إضافة الصورة بنجاح' });
  } catch (err) {
    console.error('خطأ في إضافة الصورة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/product-images/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM ProductImages WHERE ProductImagesID = @id');
    res.json({ success: true, message: 'تم حذف الصورة' });
  } catch (err) {
    console.error('خطأ في حذف الصورة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/products/:id/components', async (req, res) => {
  try {
    const pool = await connectDB();
    const { components, createdBy } = req.body;
    
    await pool.request()
      .input('productId', sql.Int, req.params.id)
      .query('DELETE FROM ProductComponents WHERE ProductID = @productId');
    
    for (const comp of components) {
      await pool.request()
        .input('productId', sql.Int, req.params.id)
        .input('componentName', sql.NVarChar(100), comp.componentName)
        .input('quantity', sql.Int, comp.quantity)
        .input('createdBy', sql.NVarChar(100), createdBy)
        .query(`
          INSERT INTO ProductComponents (ProductID, ComponentName, Quantity, CreatedBy, CreatedAt)
          VALUES (@productId, @componentName, @quantity, @createdBy, GETDATE())
        `);
    }
    
    res.json({ success: true, message: 'تم حفظ المكونات بنجاح' });
  } catch (err) {
    console.error('خطأ في حفظ المكونات:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// 💰 المصروفات
// ==========================
app.get('/api/expense-groups', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query('SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID FROM ExpenseGroups ORDER BY ExpenseGroupName');
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب مجموعات المصروفات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/cashboxes', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query('SELECT CashBoxID, CashBoxName, Description FROM CashBoxes ORDER BY CashBoxName');
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب الخزائن:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/expenses/summary', async (req, res) => {
  try {
    const pool = await connectDB();
    
    const result = await pool.request()
      .query(`
        SELECT 
          COUNT(*) as totalCount,
          ISNULL(SUM(Amount), 0) as totalAmount,
          (SELECT COUNT(*) FROM Expenses WHERE CAST(ExpenseDate AS DATE) = CAST(GETDATE() AS DATE)) as todayCount,
          (SELECT ISNULL(SUM(Amount), 0) FROM Expenses WHERE CAST(ExpenseDate AS DATE) = CAST(GETDATE() AS DATE)) as todayAmount
        FROM Expenses
      `);
    
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('خطأ في جلب ملخص المصروفات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/expenses', async (req, res) => {
  try {
    const { search, groupId, startDate, endDate } = req.query;
    const pool = await connectDB();
    
    let query = `
      SELECT 
        e.ExpenseID, e.ExpenseName, e.ExpenseDate, e.Amount,
        e.Notes, e.Torecipient, e.IsAdvance, e.AdvanceMonths,
        e.CreatedBy, e.CreatedAt,
        eg.ExpenseGroupID, eg.ExpenseGroupName,
        cb.CashBoxID, cb.CashBoxName
      FROM Expenses e
      INNER JOIN ExpenseGroups eg ON e.ExpenseGroupID = eg.ExpenseGroupID
      INNER JOIN CashBoxes cb ON e.CashBoxID = cb.CashBoxID
      WHERE 1=1
    `;
    
    const request = pool.request();
    
    if (search && search.trim() !== '') {
      query += ` AND (e.ExpenseName LIKE @search OR e.Torecipient LIKE @search)`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    
    if (groupId && groupId !== '' && groupId !== '0') {
      query += ` AND e.ExpenseGroupID = @groupId`;
      request.input('groupId', sql.Int, groupId);
    }
    
    if (startDate) {
      query += ` AND CAST(e.ExpenseDate AS DATE) >= @startDate`;
      request.input('startDate', sql.Date, startDate);
    }
    
    if (endDate) {
      query += ` AND CAST(e.ExpenseDate AS DATE) <= @endDate`;
      request.input('endDate', sql.Date, endDate);
    }
    
    query += ` ORDER BY e.ExpenseDate DESC, e.ExpenseID DESC`;
    
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب المصروفات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  const transaction = new sql.Transaction(await connectDB());
  
  try {
    await transaction.begin();
    
    const {
      expenseName, expenseGroupId, cashBoxId, amount, expenseDate,
      notes, toRecipient, isAdvance, advanceMonths, createdBy
    } = req.body;
    
    // إضافة المصروف
    const expenseResult = await transaction.request()
      .input('expenseName', sql.NVarChar(100), expenseName)
      .input('expenseGroupId', sql.Int, expenseGroupId)
      .input('cashBoxId', sql.Int, cashBoxId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, expenseDate || new Date())
      .input('notes', sql.NVarChar(255), notes || null)
      .input('toRecipient', sql.NVarChar(100), toRecipient || null)
      .input('isAdvance', sql.Bit, isAdvance || false)
      .input('advanceMonths', sql.Int, advanceMonths || null)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .query(`
        INSERT INTO Expenses (
          ExpenseName, ExpenseGroupID, CashBoxID, Amount, ExpenseDate,
          Notes, Torecipient, IsAdvance, AdvanceMonths, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.ExpenseID
        VALUES (
          @expenseName, @expenseGroupId, @cashBoxId, @amount, @expenseDate,
          @notes, @toRecipient, @isAdvance, @advanceMonths, @createdBy, GETDATE()
        )
      `);
    
    const expenseId = expenseResult.recordset[0].ExpenseID;
    
    // إضافة حركة الخزينة
    await transaction.request()
      .input('cashBoxId', sql.Int, cashBoxId)
      .input('referenceId', sql.Int, expenseId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(sql.MAX), notes || null)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
          Amount, TransactionDate, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
          @amount, GETDATE(), @notes, @createdBy, GETDATE()
        )
      `);
    
    await transaction.commit();
    res.json({ success: true, expenseId, message: 'تم إضافة المصروف بنجاح' });
    
  } catch (err) {
    await transaction.rollback();
    console.error('خطأ في إضافة المصروف:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      expenseName, expenseGroupId, amount, expenseDate,
      notes, toRecipient, isAdvance, advanceMonths
    } = req.body;
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('expenseName', sql.NVarChar(100), expenseName)
      .input('expenseGroupId', sql.Int, expenseGroupId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, expenseDate)
      .input('notes', sql.NVarChar(255), notes || null)
      .input('toRecipient', sql.NVarChar(100), toRecipient || null)
      .input('isAdvance', sql.Bit, isAdvance || false)
      .input('advanceMonths', sql.Int, advanceMonths || null)
      .query(`
        UPDATE Expenses SET
          ExpenseName = @expenseName, ExpenseGroupID = @expenseGroupId,
          Amount = @amount, ExpenseDate = @expenseDate, Notes = @notes,
          Torecipient = @toRecipient, IsAdvance = @isAdvance, AdvanceMonths = @advanceMonths
        WHERE ExpenseID = @id
      `);
    
    // تحديث حركة الخزينة
    await pool.request()
      .input('referenceId', sql.Int, req.params.id)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('notes', sql.NVarChar(sql.MAX), notes || null)
      .query(`
        UPDATE CashboxTransactions SET Amount = @amount, Notes = @notes
        WHERE ReferenceID = @referenceId AND ReferenceType = 'Expense'
      `);
    
    res.json({ success: true, message: 'تم تعديل المصروف بنجاح' });
  } catch (err) {
    console.error('خطأ في تعديل المصروف:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  const transaction = new sql.Transaction(await connectDB());
  
  try {
    await transaction.begin();
    
    await transaction.request()
      .input('referenceId', sql.Int, req.params.id)
      .query(`DELETE FROM CashboxTransactions WHERE ReferenceID = @referenceId AND ReferenceType = 'Expense'`);
    
    await transaction.request()
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM Expenses WHERE ExpenseID = @id');
    
    await transaction.commit();
    res.json({ success: true, message: 'تم حذف المصروف بنجاح' });
  } catch (err) {
    await transaction.rollback();
    console.error('خطأ في حذف المصروف:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Health Check (مهم لـ Railway)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString() 
  });
});


// ===== 🔧 تشخيص جداول النشاطات =====
app.get('/api/activities/debug', async (req, res) => {
  try {
    const pool = await connectDB();
    const results = {};
    
    // اختبار جدول Parties
    try {
      const parties = await pool.request().query(`
        SELECT TOP 1 PartyName, CreatedAt FROM Parties WHERE PartyType = 1
      `);
      results.parties = { 
        success: true, 
        count: parties.recordset.length,
        sample: parties.recordset[0] || null
      };
    } catch (e) {
      results.parties = { success: false, error: e.message };
    }
    
    // اختبار جدول Expenses
    try {
      const expenses = await pool.request().query(`
        SELECT TOP 1 ExpenseName, Amount, CreatedAt FROM Expenses
      `);
      results.expenses = { 
        success: true, 
        count: expenses.recordset.length,
        sample: expenses.recordset[0] || null
      };
    } catch (e) {
      results.expenses = { success: false, error: e.message };
    }
    
    // اختبار جدول SalesOpportunities
    try {
      const opportunities = await pool.request().query(`
        SELECT TOP 1 OpportunityName, ExpectedValue, CreatedAt FROM SalesOpportunities
      `);
      results.salesOpportunities = { 
        success: true, 
        count: opportunities.recordset.length,
        sample: opportunities.recordset[0] || null
      };
    } catch (e) {
      results.salesOpportunities = { success: false, error: e.message };
    }
    
    res.json({
      success: true,
      message: 'نتائج التشخيص',
      results
    });
    
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ===== آخر النشاطات (نسخة محسنة) =====
app.get('/api/activities/recent', async (req, res) => {
  try {
    const pool = await connectDB();
    
    // نجيب كل نوع لوحده عشان نعرف مين فيهم فيه مشكلة
    let allActivities = [];
    
    // 1️⃣ العملاء الجدد
    try {
      const clients = await pool.request().query(`
        SELECT TOP 5
          'client' as type,
          N'عميل جديد' as title,
          PartyName as description,
          CreatedAt as createdAt,
          'person_add' as icon,
          '#4CAF50' as color
        FROM Parties 
        WHERE PartyType = 1 AND IsActive = 1
        ORDER BY CreatedAt DESC
      `);
      allActivities = [...allActivities, ...clients.recordset];
    } catch (e) {
      console.error('خطأ في جلب العملاء:', e.message);
    }
    
    // 2️⃣ المصروفات
    try {
      const expenses = await pool.request().query(`
        SELECT TOP 5
          'expense' as type,
          N'مصروف' as title,
          ExpenseName + N' - ' + CAST(Amount AS NVARCHAR) + N' ج.م' as description,
          CreatedAt as createdAt,
          'money_off' as icon,
          '#F44336' as color
        FROM Expenses
        ORDER BY CreatedAt DESC
      `);
      allActivities = [...allActivities, ...expenses.recordset];
    } catch (e) {
      console.error('خطأ في جلب المصروفات:', e.message);
    }
    
    // 3️⃣ الفرص (لو الجدول موجود)
    try {
      const opportunities = await pool.request().query(`
        SELECT TOP 5
          'opportunity' as type,
          N'فرصة جديدة' as title,
          OpportunityName + N' - ' + CAST(ExpectedValue AS NVARCHAR) + N' ج.م' as description,
          CreatedAt as createdAt,
          'lightbulb' as icon,
          '#FF9800' as color
        FROM SalesOpportunities
        ORDER BY CreatedAt DESC
      `);
      allActivities = [...allActivities, ...opportunities.recordset];
    } catch (e) {
      console.error('خطأ في جلب الفرص:', e.message);
      // مش مشكلة لو الجدول مش موجود
    }
    
    // ترتيب حسب التاريخ وأخذ آخر 10
    allActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    allActivities = allActivities.slice(0, 10);
    
    // حساب الوقت المنقضي
    const activities = allActivities.map(activity => {
      const now = new Date();
      const created = new Date(activity.createdAt);
      const diffMs = now - created;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      let timeAgo;
      if (diffMins < 1) {
        timeAgo = 'الآن';
      } else if (diffMins < 60) {
        timeAgo = `منذ ${diffMins} د`;
      } else if (diffHours < 24) {
        timeAgo = `منذ ${diffHours} س`;
      } else {
        timeAgo = `منذ ${diffDays} يوم`;
      }
      
      return {
        ...activity,
        timeAgo
      };
    });
    
    res.json({
      success: true,
      count: activities.length,
      activities
    });
    
  } catch (err) {
    console.error('Error fetching activities:', err);
    res.status(500).json({ 
      success: false,
      error: 'فشل في جلب النشاطات',
      details: err.message  // ← ده المهم عشان نعرف المشكلة
    });
  }
});


// ==========================
// 🚀 تشغيل السيرفر
// ==========================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 السيرفر شغال على البورت: ${PORT}`);
});