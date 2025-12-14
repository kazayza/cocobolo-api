const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const admin = require('firebase-admin');
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

// تهيئة Firebase Admin SDK
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

connectDB();

// ==========================
// 🏠 الصفحة الرئيسية
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
// ✅ Health Check
// ==========================
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString() 
  });
});

// ==========================
// 🔐 تسجيل الدخول
// ==========================
app.post('/api/login', async (req, res) => {
  try {
    const pool = await connectDB();
    
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

    const permissionsResult = await pool.request()
      .input('userId', sql.Int, user.UserID)
      .query(`
        SELECT 
          p.PermissionID, p.PermissionName, p.FormName, p.Category,
          up.CanView, up.CanAdd, up.CanEdit, up.CanDelete
        FROM UserPermissions up
        INNER JOIN Permissions p ON up.PermissionID = p.PermissionID
        WHERE up.UserID = @userId
      `);

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

    res.json({ success: true, user, permissions });

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
          (SELECT COUNT(*) FROM SalesOpportunities WHERE IsActive = 1 AND StageID NOT IN (3,4,5)) as openOpportunities,
          (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed') as tasksToday,
          (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale') as salesToday,
          (SELECT COUNT(*) FROM Notifications WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
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

// ✅ بحث عن عميل بالاسم أو التليفون
app.get('/api/clients/search', async (req, res) => {
  try {
    const { q } = req.query;
    const pool = await connectDB();
    
    const result = await pool.request()
      .input('search', sql.NVarChar, `%${q}%`)
      .query(`
        SELECT TOP 20 
          PartyID, PartyName, Phone, Phone2, Address
        FROM Parties 
        WHERE IsActive = 1 
          AND PartyType = 1
          AND (PartyName LIKE @search OR Phone LIKE @search OR Phone2 LIKE @search)
        ORDER BY PartyName
      `);
    
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في البحث عن العميل:', err);
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
    
    const checkResult = await pool.request()
      .input('partyName', sql.NVarChar(200), partyName)
      .query('SELECT PartyID FROM Parties WHERE PartyName = @partyName AND IsActive = 1');
    
    if (checkResult.recordset.length > 0) {
      return res.json({ success: false, message: 'اسم العميل موجود مسبقاً' });
    }
    
    const result = await pool.request()
      .input('partyName', sql.NVarChar(200), partyName)
      .input('partyType', sql.Int, 1)
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

// ✅ حذف عميل
app.delete('/api/clients/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    
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

// ✅ مصادر الإحالة
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
          NotificationID, Title, Message, RelatedTable, RelatedID,
          FormName, CreatedBy,
          FORMAT(CreatedAt, 'yyyy-MM-dd hh:mm tt') as CreatedAt,
          ReminderEnabled
        FROM Notifications 
        WHERE RecipientUser = @username AND IsRead = 0
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

app.get('/api/notifications', async (req, res) => {
  try {
    const { username } = req.query;
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
    
    res.json(result.recordset);
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
    const { title, message, recipientUser, relatedTable, relatedId, formName, createdBy } = req.body;
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
    
    res.json({ success: true, notificationId: result.recordset[0].NotificationID });
  } catch (err) {
    console.error('خطأ في إرسال الإشعار:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// 📱 FCM Token & Push
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

    res.json({ success: true, message: 'تم حفظ التوكن بنجاح' });
  } catch (err) {
    console.error('خطأ في حفظ FCM Token:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

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

    const payload = {
      token: tokenResult.recordset[0].FCMToken,
      notification: { title, body: message },
      data: data || {},
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'high_importance_channel' },
      },
      apns: { payload: { aps: { sound: 'default' } } },
    };

    await admin.messaging().send(payload);
    res.json({ success: true, message: 'تم إرسال الإشعار بنجاح' });
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
        SELECT ProductImagesID, ImageNote, CAST(ImageProduct AS VARBINARY(MAX)) AS ImageProduct
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

// ==========================
// 📊 النشاطات الأخيرة
// ==========================
app.get('/api/activities/recent', async (req, res) => {
  try {
    const pool = await connectDB();
    let allActivities = [];
    
    // العملاء الجدد
    try {
      const clients = await pool.request().query(`
        SELECT TOP 5
          'client' as type, N'عميل جديد' as title,
          PartyName as description, CreatedAt as createdAt,
          'person_add' as icon, '#4CAF50' as color
        FROM Parties 
        WHERE PartyType = 1 AND IsActive = 1
        ORDER BY CreatedAt DESC
      `);
      allActivities = [...allActivities, ...clients.recordset];
    } catch (e) {
      console.error('خطأ في جلب العملاء:', e.message);
    }
    
    // المصروفات
    try {
      const expenses = await pool.request().query(`
        SELECT TOP 5
          'expense' as type, N'مصروف' as title,
          ExpenseName + N' - ' + CAST(Amount AS NVARCHAR) + N' ج.م' as description,
          CreatedAt as createdAt, 'money_off' as icon, '#F44336' as color
        FROM Expenses
        ORDER BY CreatedAt DESC
      `);
      allActivities = [...allActivities, ...expenses.recordset];
    } catch (e) {
      console.error('خطأ في جلب المصروفات:', e.message);
    }
    
    // الفرص
    try {
      const opportunities = await pool.request().query(`
        SELECT TOP 5
          'opportunity' as type, N'فرصة جديدة' as title,
          p.PartyName + N' - ' + CAST(ISNULL(o.ExpectedValue, 0) AS NVARCHAR) + N' ج.م' as description,
          o.CreatedAt as createdAt, 'lightbulb' as icon, '#FF9800' as color
        FROM SalesOpportunities o
        LEFT JOIN Parties p ON o.PartyID = p.PartyID
        WHERE o.IsActive = 1
        ORDER BY o.CreatedAt DESC
      `);
      allActivities = [...allActivities, ...opportunities.recordset];
    } catch (e) {
      console.error('خطأ في جلب الفرص:', e.message);
    }
    
    allActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    allActivities = allActivities.slice(0, 10);
    
    const activities = allActivities.map(activity => {
      const now = new Date();
      const created = new Date(activity.createdAt);
      const diffMs = now - created;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      let timeAgo;
      if (diffMins < 1) timeAgo = 'الآن';
      else if (diffMins < 60) timeAgo = `منذ ${diffMins} د`;
      else if (diffHours < 24) timeAgo = `منذ ${diffHours} س`;
      else timeAgo = `منذ ${diffDays} يوم`;
      
      return { ...activity, timeAgo };
    });
    
    res.json({ success: true, count: activities.length, activities });
  } catch (err) {
    console.error('Error fetching activities:', err);
    res.status(500).json({ success: false, error: 'فشل في جلب النشاطات', details: err.message });
  }
});

app.get('/api/activities/debug', async (req, res) => {
  try {
    const pool = await connectDB();
    const results = {};
    
    try {
      const parties = await pool.request().query(`SELECT TOP 1 PartyName, CreatedAt FROM Parties WHERE PartyType = 1`);
      results.parties = { success: true, count: parties.recordset.length, sample: parties.recordset[0] || null };
    } catch (e) {
      results.parties = { success: false, error: e.message };
    }
    
    try {
      const expenses = await pool.request().query(`SELECT TOP 1 ExpenseName, Amount, CreatedAt FROM Expenses`);
      results.expenses = { success: true, count: expenses.recordset.length, sample: expenses.recordset[0] || null };
    } catch (e) {
      results.expenses = { success: false, error: e.message };
    }
    
    try {
      const opportunities = await pool.request().query(`SELECT TOP 1 OpportunityID, ExpectedValue, CreatedAt FROM SalesOpportunities`);
      results.salesOpportunities = { success: true, count: opportunities.recordset.length, sample: opportunities.recordset[0] || null };
    } catch (e) {
      results.salesOpportunities = { success: false, error: e.message };
    }
    
    res.json({ success: true, message: 'نتائج التشخيص', results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================
// 🎯 فرص البيع - Lookups
// ==========================
app.get('/api/opportunities/stages', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT StageID, StageName, StageNameAr, StageOrder, StageColor FROM SalesStages WHERE IsActive = 1 ORDER BY StageOrder`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب المراحل:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/sources', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT SourceID, SourceName, SourceNameAr, SourceIcon FROM ContactSources WHERE IsActive = 1 ORDER BY SourceName`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب مصادر التواصل:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/statuses', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT StatusID, StatusName, StatusNameAr FROM ContactStatus WHERE IsActive = 1 ORDER BY StatusID`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب حالات التواصل:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/ad-types', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT AdTypeID, AdTypeName, AdTypeNameAr FROM AdTypes WHERE IsActive = 1 ORDER BY AdTypeName`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب أنواع الإعلانات:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/categories', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT CategoryID, CategoryName, CategoryNameAr FROM InterestCategories WHERE IsActive = 1 ORDER BY CategoryName`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب فئات الاهتمام:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/lost-reasons', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT LostReasonID, ReasonName, ReasonNameAr FROM LostReasons WHERE IsActive = 1 ORDER BY ReasonName`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب أسباب الخسارة:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/task-types', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT TaskTypeID, TaskTypeName, TaskTypeNameAr FROM TaskTypes WHERE IsActive = 1 ORDER BY TaskTypeName`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب أنواع المهام:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/employees', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`SELECT EmployeeID, FullName, JobTitle FROM Employees WHERE Status = N'نشط' ORDER BY FullName`);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب الموظفين:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/users/:userId/employee', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('userId', sql.Int, req.params.userId)
      .query(`
        SELECT u.employeeID, e.FullName
        FROM Users u
        LEFT JOIN Employees e ON u.employeeID = e.EmployeeID
        WHERE u.UserID = @userId
      `);
    res.json(result.recordset[0] || { employeeID: null, FullName: null });
  } catch (err) {
    console.error('خطأ في جلب الموظف:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==========================
// 🎯 فرص البيع - CRUD
// ==========================
app.get('/api/opportunities/summary', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT 
          COUNT(*) as totalOpportunities,
          SUM(CASE WHEN StageID = 1 THEN 1 ELSE 0 END) as leadCount,
          SUM(CASE WHEN StageID = 2 THEN 1 ELSE 0 END) as potentialCount,
          SUM(CASE WHEN StageID = 3 THEN 1 ELSE 0 END) as closedCount,
          SUM(CASE WHEN StageID = 4 THEN 1 ELSE 0 END) as lostCount,
          SUM(CASE WHEN StageID = 5 THEN 1 ELSE 0 END) as notInterestedCount,
          SUM(CASE WHEN CAST(NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) as todayFollowUp,
          SUM(CASE WHEN CAST(NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) AND StageID NOT IN (3,4,5) THEN 1 ELSE 0 END) as overdueFollowUp,
          ISNULL(SUM(CASE WHEN StageID = 3 THEN ExpectedValue ELSE 0 END), 0) as totalClosedValue
        FROM SalesOpportunities WHERE IsActive = 1
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('خطأ في جلب ملخص الفرص:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities', async (req, res) => {
  try {
    const { search, stageId, sourceId, employeeId, followUpStatus } = req.query;
    const pool = await connectDB();
    
    let query = `
      SELECT 
        o.OpportunityID, o.PartyID, p.PartyName AS ClientName,
        p.Phone AS Phone1, p.Phone2, p.Address,
        o.EmployeeID, e.FullName AS EmployeeName,
        o.SourceID, cs.SourceName, cs.SourceNameAr, cs.SourceIcon,
        o.StageID, ss.StageName, ss.StageNameAr, ss.StageColor, ss.StageOrder,
        o.StatusID, cst.StatusName, cst.StatusNameAr,
        o.InterestedProduct, o.ExpectedValue, o.Location,
        o.FirstContactDate, o.NextFollowUpDate, o.LastContactDate,
        o.Notes, o.CreatedBy, o.CreatedAt,
        DATEDIFF(DAY, o.FirstContactDate, GETDATE()) AS DaysSinceFirstContact,
        CASE 
          WHEN o.NextFollowUpDate IS NULL THEN N'NotSet'
          WHEN CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) THEN N'Overdue'
          WHEN CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE) THEN N'Today'
          WHEN CAST(o.NextFollowUpDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE)) THEN N'Tomorrow'
          ELSE N'Upcoming'
        END AS FollowUpStatus
      FROM SalesOpportunities o
      LEFT JOIN Parties p ON o.PartyID = p.PartyID
      LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
      LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
      LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
      LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
      WHERE o.IsActive = 1
    `;
    
    const request = pool.request();
    
    if (search && search.trim() !== '') {
      query += ` AND (p.PartyName LIKE @search OR p.Phone LIKE @search OR o.InterestedProduct LIKE @search)`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    
    if (stageId && stageId !== '' && stageId !== '0') {
      query += ` AND o.StageID = @stageId`;
      request.input('stageId', sql.Int, stageId);
    }
    
    if (sourceId && sourceId !== '' && sourceId !== '0') {
      query += ` AND o.SourceID = @sourceId`;
      request.input('sourceId', sql.Int, sourceId);
    }
    
    if (employeeId && employeeId !== '' && employeeId !== '0') {
      query += ` AND o.EmployeeID = @employeeId`;
      request.input('employeeId', sql.Int, employeeId);
    }
    
    if (followUpStatus && followUpStatus !== '') {
      switch (followUpStatus) {
        case 'Overdue':
          query += ` AND CAST(o.NextFollowUpDate AS DATE) < CAST(GETDATE() AS DATE) AND o.StageID NOT IN (3,4,5)`;
          break;
        case 'Today':
          query += ` AND CAST(o.NextFollowUpDate AS DATE) = CAST(GETDATE() AS DATE)`;
          break;
        case 'Tomorrow':
          query += ` AND CAST(o.NextFollowUpDate AS DATE) = DATEADD(DAY, 1, CAST(GETDATE() AS DATE))`;
          break;
        case 'Upcoming':
          query += ` AND CAST(o.NextFollowUpDate AS DATE) > DATEADD(DAY, 1, CAST(GETDATE() AS DATE))`;
          break;
      }
    }
    
    query += ` ORDER BY ss.StageOrder, o.NextFollowUpDate, o.CreatedAt DESC`;
    
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('خطأ في جلب الفرص:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/check-open/:partyId', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('partyId', sql.Int, req.params.partyId)
      .query(`
        SELECT TOP 1 
          o.OpportunityID, o.EmployeeID, o.SourceID, o.AdTypeID,
          o.StageID, o.StatusID, o.CategoryID, o.InterestedProduct,
          o.ExpectedValue, o.Notes, o.Guidance,
          e.FullName AS EmployeeName, ss.StageNameAr
        FROM SalesOpportunities o
        LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
        LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
        WHERE o.PartyID = @partyId AND o.IsActive = 1 AND o.StageID NOT IN (3, 4, 5)
        ORDER BY o.CreatedAt DESC
      `);
    
    res.json({
      hasOpenOpportunity: result.recordset.length > 0,
      opportunity: result.recordset[0] || null
    });
  } catch (err) {
    console.error('خطأ في التحقق من الفرصة:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/opportunities/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT 
          o.*, p.PartyName AS ClientName, p.Phone AS Phone1, p.Phone2, p.Email, p.Address,
          e.FullName AS EmployeeName,
          cs.SourceName, cs.SourceNameAr, cs.SourceIcon,
          ss.StageName, ss.StageNameAr, ss.StageColor,
          cst.StatusName, cst.StatusNameAr,
          lr.ReasonName AS LostReasonName, lr.ReasonNameAr AS LostReasonNameAr
        FROM SalesOpportunities o
        LEFT JOIN Parties p ON o.PartyID = p.PartyID
        LEFT JOIN Employees e ON o.EmployeeID = e.EmployeeID
        LEFT JOIN ContactSources cs ON o.SourceID = cs.SourceID
        LEFT JOIN SalesStages ss ON o.StageID = ss.StageID
        LEFT JOIN ContactStatus cst ON o.StatusID = cst.StatusID
        LEFT JOIN LostReasons lr ON o.LostReasonID = lr.LostReasonID
        WHERE o.OpportunityID = @id
      `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'الفرصة غير موجودة' });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('خطأ في جلب تفاصيل الفرصة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/opportunities', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      partyId, employeeId, sourceId, stageId, statusId,
      interestedProduct, expectedValue, location,
      nextFollowUpDate, notes, createdBy
    } = req.body;
    
    const result = await pool.request()
      .input('partyId', sql.Int, partyId)
      .input('employeeId', sql.Int, employeeId || null)
      .input('sourceId', sql.Int, sourceId || null)
      .input('stageId', sql.Int, stageId || 1)
      .input('statusId', sql.Int, statusId || 1)
      .input('interestedProduct', sql.NVarChar(200), interestedProduct || null)
      .input('expectedValue', sql.Decimal(18, 2), expectedValue || 0)
      .input('location', sql.NVarChar(200), location || null)
      .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
      .input('notes', sql.NVarChar(500), notes || null)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .query(`
        INSERT INTO SalesOpportunities (
          PartyID, EmployeeID, SourceID, StageID, StatusID,
          InterestedProduct, ExpectedValue, Location,
          FirstContactDate, NextFollowUpDate, Notes,
          IsActive, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.OpportunityID
        VALUES (
          @partyId, @employeeId, @sourceId, @stageId, @statusId,
          @interestedProduct, @expectedValue, @location,
          GETDATE(), @nextFollowUpDate, @notes,
          1, @createdBy, GETDATE()
        )
      `);
    
    res.json({ success: true, opportunityId: result.recordset[0].OpportunityID, message: 'تم إضافة الفرصة بنجاح' });
  } catch (err) {
    console.error('خطأ في إضافة الفرصة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/opportunities/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const {
      partyId, employeeId, sourceId, stageId, statusId,
      interestedProduct, expectedValue, location,
      nextFollowUpDate, notes, lostReasonId, lostNotes, updatedBy
    } = req.body;
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('partyId', sql.Int, partyId)
      .input('employeeId', sql.Int, employeeId || null)
      .input('sourceId', sql.Int, sourceId || null)
      .input('stageId', sql.Int, stageId)
      .input('statusId', sql.Int, statusId || null)
      .input('interestedProduct', sql.NVarChar(200), interestedProduct || null)
      .input('expectedValue', sql.Decimal(18, 2), expectedValue || 0)
      .input('location', sql.NVarChar(200), location || null)
      .input('nextFollowUpDate', sql.DateTime, nextFollowUpDate || null)
      .input('notes', sql.NVarChar(500), notes || null)
      .input('lostReasonId', sql.Int, lostReasonId || null)
      .input('lostNotes', sql.NVarChar(500), lostNotes || null)
      .input('updatedBy', sql.NVarChar(50), updatedBy)
      .query(`
        UPDATE SalesOpportunities SET
          PartyID = @partyId, EmployeeID = @employeeId, SourceID = @sourceId,
          StageID = @stageId, StatusID = @statusId,
          InterestedProduct = @interestedProduct, ExpectedValue = @expectedValue,
          Location = @location, NextFollowUpDate = @nextFollowUpDate,
          Notes = @notes, LostReasonID = @lostReasonId, LostNotes = @lostNotes,
          LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE()
        WHERE OpportunityID = @id
      `);
    
    res.json({ success: true, message: 'تم تعديل الفرصة بنجاح' });
  } catch (err) {
    console.error('خطأ في تعديل الفرصة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/opportunities/:id/stage', async (req, res) => {
  try {
    const pool = await connectDB();
    const { stageId, updatedBy } = req.body;
    
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('stageId', sql.Int, stageId)
      .input('updatedBy', sql.NVarChar(50), updatedBy)
      .query(`
        UPDATE SalesOpportunities SET
          StageID = @stageId, LastContactDate = GETDATE(),
          LastUpdatedBy = @updatedBy, LastUpdatedAt = GETDATE()
        WHERE OpportunityID = @id
      `);
    
    res.json({ success: true, message: 'تم تغيير المرحلة بنجاح' });
  } catch (err) {
    console.error('خطأ في تغيير المرحلة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/opportunities/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('UPDATE SalesOpportunities SET IsActive = 0 WHERE OpportunityID = @id');
    
    res.json({ success: true, message: 'تم حذف الفرصة بنجاح' });
  } catch (err) {
    console.error('خطأ في حذف الفرصة:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// 🎯 تسجيل تواصل جديد (الـ Flow الكامل)
// ==========================
app.post('/api/interactions/create', async (req, res) => {
  const transaction = new sql.Transaction(await connectDB());
  
  try {
    await transaction.begin();
    
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
    } = req.body;
    
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
        SELECT TOP 1 OpportunityID 
        FROM SalesOpportunities 
        WHERE PartyID = @partyId 
          AND IsActive = 1 
          AND StageID NOT IN (3, 4, 5)
        ORDER BY CreatedAt DESC
      `);
    
    if (existingOpp.recordset.length > 0) {
      // 3️⃣ تحديث الفرصة الموجودة
      opportunityId = existingOpp.recordset[0].OpportunityID;
      
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
    
    // 5️⃣ إنشاء مهمة متابعة
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
    
    res.json({
      success: true,
      data: {
        partyId: finalPartyId,
        opportunityId: opportunityId,
        interactionId: interaction.recordset[0].InteractionID,
        taskId: taskId,
        isNewClient: isNewClient || false,
        isNewOpportunity: isNewOpportunity
      },
      message: 'تم تسجيل التواصل بنجاح'
    });
    
  } catch (err) {
    await transaction.rollback();
    console.error('خطأ في تسجيل التواصل:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================
// 🚀 تشغيل السيرفر
// ==========================
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 السيرفر شغال على البورت: ${PORT}`);
});