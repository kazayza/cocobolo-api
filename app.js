const express = require('express');

// إنشاء التطبيق أولاً
const app = express();

// استيراد الـ Core
const { connectDB, sql } = require('./core/database');
const { initializeFirebase } = require('./core/firebase');
const { applyMiddleware } = require('./core/middleware');

// استيراد الـ Error Handlers
const { globalErrorHandler, notFoundHandler } = require('./shared/error-handler');

// تطبيق الـ Middleware
applyMiddleware(app);

// تهيئة Firebase
initializeFirebase();
// ===================================
// 🔄 Backward Compatibility (المسارات القديمة)
// ===================================

const authController = require('./modules/auth/auth.controller');
const clientsController = require('./modules/clients/clients.controller');
const dashboardController = require('./modules/dashboard/dashboard.controller');
const notificationsController = require('./modules/notifications/notifications.controller');

// Auth
app.post('/api/login', authController.login);
app.post('/api/users/save-token', authController.saveFcmToken);
app.get('/api/users/:userId/employee', authController.getEmployeeByUserId);

// Dashboard
app.get('/api/dashboard', dashboardController.getStats);
app.get('/api/activities/recent', dashboardController.getRecentActivities);
app.get('/api/activities/debug', dashboardController.getDebug);

// Clients
app.get('/api/clients', clientsController.getAll);
app.get('/api/clients/summary', clientsController.getSummary);
app.get('/api/clients/search', clientsController.search);
app.get('/api/customers-list', clientsController.getList);
app.get('/api/clients/:id', clientsController.getById);
app.post('/api/clients', clientsController.create);
app.put('/api/clients/:id', clientsController.update);
app.delete('/api/clients/:id', clientsController.remove);
app.get('/api/referral-sources', clientsController.getReferralSources);

// Notifications
app.get('/api/notifications', notificationsController.getAll);
app.get('/api/notifications/unread', notificationsController.getUnread);
app.put('/api/notifications/read-all', notificationsController.markAllAsRead);
app.put('/api/notifications/:id/read', notificationsController.markAsRead);
app.post('/api/notifications', notificationsController.create);
app.post('/api/notifications/send-push', notificationsController.sendPush);

// ===================================
// 🖼️ Product Images (for thumbnails)
// ===================================
app.get('/api/product-images/:id', async (req, res) => {
  try {
    const pool = await connectDB();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT TOP 1 ImageProduct
        FROM ProductImages
        WHERE ProductImagesID = @id
      `);

    if (!result.recordset.length || !result.recordset[0].ImageProduct) {
      return res.status(404).send('Image not found');
    }

    const imgBuffer = Buffer.from(result.recordset[0].ImageProduct);

    // تقدر تغيّر الـ Content-Type لو صورك PNG مثلاً
    res.set('Content-Type', 'image/jpeg');
    return res.send(imgBuffer);
  } catch (err) {
    console.error('خطأ في جلب صورة المنتج:', err);
    return res.status(500).send('Error fetching image');
  }
});

// ===================================
// 🏠 الصفحة الرئيسية واختبار الاتصال
// ===================================

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'COCOBOLO API شغال بنجاح! 🚀',
    version: '2.0.0',
    time: new Date().toISOString()
  });
});

// اختبار الاتصال بقاعدة البيانات
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

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// ===================================
// 📦 تسجيل الـ Modules (هنضيفهم لاحقاً)
// ===================================

// TODO: هنا هنضيف الـ routes الخاصة بكل module

// ===================================
// 📦 تسجيل الـ Modules
// ===================================

// Auth Module
app.use('/api/auth', require('./modules/auth/auth.routes'));


// Clients Module
app.use('/api/clients', require('./modules/clients/clients.routes'));


// Products Module
app.use('/api/products', require('./modules/products/products.routes'));


// Expenses Module
app.use('/api/expenses', require('./modules/expenses/expenses.routes'));


// Opportunities Module
app.use('/api/opportunities', require('./modules/opportunities/opportunities.routes'));


// Notifications Module
app.use('/api/notifications', require('./modules/notifications/notifications.routes'));


// Dashboard Module
app.use('/api/dashboard', require('./modules/dashboard/dashboard.routes'));


// Interactions Module
app.use('/api/interactions', require('./modules/interactions/interactions.routes'));


// Employees Module
app.use('/api/employees', require('./modules/employees/employees.routes'));

// Attendance Module
app.use('/api/attendance', require('./modules/attendance/attendance.routes'));

// Payroll Module
app.use('/api/payroll', require('./modules/payroll/payroll.routes'));

// Inventory Module
app.use('/api/inventory', require('./modules/inventory/inventory.routes'));

// Transactions Module
app.use('/api/transactions', require('./modules/transactions/transactions.routes'));

// Quotations Module
app.use('/api/quotations', require('./modules/quotations/quotations.routes'));

// Cashbox Module
app.use('/api/cashbox', require('./modules/cashbox/cashbox.routes'));

// Tasks Module
app.use('/api/tasks', require('./modules/tasks/tasks.routes'));

// Commissions Module
app.use('/api/commissions', require('./modules/commissions/commissions.routes'));

// Settings Module
app.use('/api/settings', require('./modules/settings/settings.routes'));

// في app.js
app.use('/api/reports', require('./modules/reports/reports.routes'));

// ===================================
// ⚠️ Error Handling
// ===================================

// التعامل مع الـ routes غير الموجودة
app.use(notFoundHandler);

// التعامل مع الأخطاء العامة
app.use(globalErrorHandler);

// تصدير التطبيق
module.exports = app;