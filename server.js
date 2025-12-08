const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

// اتصال واحد مرة واحدة فقط (أفضل أداء)
let pool;
async function connectDB() {
  try {
    if (!pool) {
      pool = await sql.connect(config);
      console.log('متصل بقاعدة البيانات بنجاح');
    }
    return pool;
  } catch (err) {
    console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
    throw err;
  }
}

// تشغيل الاتصال من أول ما السيرفر يشتغل
connectDB();

// ==========================
// الـ Endpoints
// ==========================

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('username', sql.NVarChar, req.body.username)
      .input('password', sql.NVarChar, req.body.password)
      .query(`
        SELECT UserID, Username, FullName, Email, employeeID 
        FROM Users 
        WHERE Username = @username 
          AND Password = @password 
          AND IsActive = 1
      `);

    if (result.recordset.length > 0) {
      res.json({ success: true, user: result.recordset[0] });
    } else {
      res.json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
  } catch (err) {
    console.error('خطأ في تسجيل الدخول:', err);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
});

// جلب العملاء (المهم جدًا للشاشة الجاية)
app.get('/api/clients', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .query(`
        SELECT 
          PartyID,
          PartyName,
          Phone,
          Phone2,
          Email,
          Address,
          TaxNumber,
          OpeningBalance,
          BalanceType,
          ContactPerson,
          NationalID
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

// لوحة التحكم + الإشعارات
app.get('/api/dashboard', async (req, res) => {
  try {
    const userId = req.query.userId;
    const pool = await connectDB();

    const summary = await pool.request().query(`
      SELECT 
        (SELECT COUNT(*) FROM Parties WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newClientsToday,
        (SELECT COUNT(*) FROM SalesOpportunities WHERE StageID != 6 AND StageID != 7) as openOpportunities,
        (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed') as tasksToday,
        (SELECT ISNULL(SUM(GrandTotal), 0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale') as salesToday
    `);

    const notifs = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT TOP 10 * FROM Notifications 
        WHERE RecipientUser = (SELECT Username FROM Users WHERE UserID = @userId)
        ORDER BY CreatedAt DESC
      `);

    res.json({
      summary: summary.recordset[0],
      notifications: notifs.recordset
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// اختبار سريع للسيرفر
app.get('/', (req, res) => {
  res.json({ message: 'COCOBOLO API شغال بنجاح!', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`السيرفر شغال على الرابط: https://cocobolo-api-production.up.railway.app`);
  console.log(`بورت: ${PORT}`);
});