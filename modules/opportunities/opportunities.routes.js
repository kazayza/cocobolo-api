const express = require('express');
const router = express.Router();
const opportunitiesController = require('./opportunities.controller');

// ===================================
// 📋 Lookups Routes
// ===================================

// جلب مراحل البيع
// GET /api/opportunities/stages
router.get('/stages', opportunitiesController.getStages);

// جلب مصادر التواصل
// GET /api/opportunities/sources
router.get('/sources', opportunitiesController.getSources);

// جلب حالات التواصل
// GET /api/opportunities/statuses
router.get('/statuses', opportunitiesController.getStatuses);

// جلب أنواع الإعلانات
// GET /api/opportunities/ad-types
router.get('/ad-types', opportunitiesController.getAdTypes);

// جلب فئات الاهتمام
// GET /api/opportunities/categories
router.get('/categories', opportunitiesController.getCategories);

// جلب أسباب الخسارة
// GET /api/opportunities/lost-reasons
router.get('/lost-reasons', opportunitiesController.getLostReasons);

// جلب أنواع المهام
// GET /api/opportunities/task-types
router.get('/task-types', opportunitiesController.getTaskTypes);

// جلب الموظفين
// GET /api/opportunities/employees
router.get('/employees', opportunitiesController.getEmployees);

// ===================================
// ➕ إنشاء فرصة مع عميل
// ===================================

// إنشاء فرصة مع عميل جديد أو موجود
// POST /api/opportunities/create-with-client
router.post('/create-with-client', opportunitiesController.createWithClient);

// البحث عن عميل بالتليفون
// GET /api/opportunities/search-by-phone?phone=01xxxxxxxx
router.get('/search-by-phone', opportunitiesController.searchByPhone);

// ===================================
// 📊 الإحصائيات
// ===================================

// ملخص الفرص
// GET /api/opportunities/summary
router.get('/summary', opportunitiesController.getSummary);

// ✅ ملخص الـ Pipeline - لازم يكون قبل /:id
router.get('/pipeline-summary', opportunitiesController.getPipelineSummary);

// ===================================
// 🎯 الفرص - CRUD
// ===================================

// التحقق من وجود فرصة مفتوحة للعميل
// GET /api/opportunities/check-open/:partyId
router.get('/check-open/:partyId', opportunitiesController.checkOpenOpportunity);

// جلب كل الفرص
// GET /api/opportunities?search=xxx&stageId=xxx&sourceId=xxx&employeeId=xxx&followUpStatus=xxx
router.get('/', opportunitiesController.getAll);

// جلب فرصة بالـ ID
// GET /api/opportunities/:id
router.get('/:id', opportunitiesController.getById);

// إضافة فرصة جديدة
// POST /api/opportunities
router.post('/', opportunitiesController.create);

// تعديل فرصة
// PUT /api/opportunities/:id
router.put('/:id', opportunitiesController.update);

// تغيير مرحلة الفرصة
// PUT /api/opportunities/:id/stage
router.put('/:id/stage', opportunitiesController.updateStage);

// حذف فرصة
// DELETE /api/opportunities/:id
router.delete('/:id', opportunitiesController.remove);

// بحث عن عملاء
//// GET /api/opportunities/search-clients?q=أحمد
router.get('/search-clients', opportunitiesController.searchClients);


// تصدير الراوتر
module.exports = router;