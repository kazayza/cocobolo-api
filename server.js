require('dotenv').config();

// استيراد التطبيق
const app = require('./app');

// استيراد دالة الاتصال بقاعدة البيانات
const { connectDB } = require('./core/database');
const { startNotificationScheduler } = require('./modules/notifications/notification.scheduler');

// تحديد البورت
const PORT = process.env.PORT || 8080;

// دالة تشغيل السيرفر
async function startServer() {
  try {
    // الاتصال بقاعدة البيانات أولاً
    await connectDB();

    // تشغيل نظام الإشعارات المجدولة
    startNotificationScheduler();

    // تشغيل السيرفر
    app.listen(PORT, '0.0.0.0', () => {
      console.log('🚀 ================================');
      console.log(`🚀 السيرفر شغال على البورت: ${PORT}`);
      console.log('🚀 ================================');
    });
  } catch (err) {
    console.error('❌ فشل تشغيل السيرفر:', err.message);
    process.exit(1);
  }
}

// تشغيل السيرفر
startServer();