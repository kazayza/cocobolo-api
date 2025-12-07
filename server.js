const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// إعدادات الاتصال بـ MonsterASP
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT),
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

// اختبار الاتصال
sql.connect(config).then(pool => {
  console.log('متصل بقاعدة البيانات بنجاح');
}).catch(err => {
  console.log('خطأ في الاتصال:', err.message);
});

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request()
      .input('username', sql.NVarChar, req.body.username)
      .input('password', sql.NVarChar, req.body.password)
      .query('SELECT * FROM Users WHERE Username = @username AND Password = @password AND IsActive = 1');

    if (result.recordset.length > 0) {
      res.json({ success: true, user: result.recordset[0] });
    } else {
      res.json({ success: false, message: 'بيانات خاطئة' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// جلب كل العملاء
app.get('/api/clients', async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query('SELECT * FROM Parties WHERE PartyType = 1 ORDER BY PartyName');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر شغال على بورت ${PORT}`));