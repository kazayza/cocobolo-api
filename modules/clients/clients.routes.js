const express = require('express');
const router = express.Router();
const clientsController = require('./clients.controller');
const { authenticate } = require('../../core/auth.middleware');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// ===================================
// 👥 Clients Routes
// ===================================

// ✅ TEST - للتجربة
router.get('/test', (req, res) => {
  res.json({ message: 'Test route works!' });
});

// ✅ check-phone - قبل أي حاجة
router.get('/check-phone', (req, res) => {
  console.log('check-phone route hit!');
  clientsController.checkPhone(req, res);
});

// الـ Routes الثابتة
router.get('/summary', clientsController.getSummary);
router.get('/search', clientsController.search);
router.get('/list', clientsController.getList);
router.get('/referral-sources', clientsController.getReferralSources);
router.get('/party-types', clientsController.getPartyTypes);
router.get('/sales-stages', clientsController.getSalesStages);
router.get('/contact-sources', clientsController.getContactSources);

// الـ Route الرئيسي
router.get('/', clientsController.getAll);
router.post('/', clientsController.create);

// الـ Routes اللي فيها :id
router.get('/:id', (req, res) => {
  console.log('getById route hit with id:', req.params.id);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: 'معرف العميل غير صالح',
      receivedId: req.params.id
    });
  }
  clientsController.getById(req, res);
});

router.put('/:id', clientsController.update);
router.delete('/:id', clientsController.remove);

module.exports = router;