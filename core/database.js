const sql = require('mssql');
require('dotenv').config();

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

// متغير لحفظ الاتصال
let pool = null;

// دالة الاتصال بقاعدة البيانات
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

// دالة للحصول على الاتصال الحالي
function getPool() {
  return pool;
}

// تصدير الدوال والمتغيرات
module.exports = {
  sql,
  connectDB,
  getPool
};