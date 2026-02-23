const express = require('express');
const router = express.Router();
const clientsController = require('./clients.controller');

// ===================================
// 👥 Clients Routes
// ===================================

// ✅ Middleware للتحقق من الـ id
const validateId = (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({
      success: false,
      message: 'معرف العميل غير صالح'
    });
  }
  req.params.id = id;
  next();
};

// الـ Routes الثابتة
router.get('/summary', clientsController.getSummary);
router.get('/search', clientsController.search);
router.get('/list', clientsController.getList);
router.get('/referral-sources', clientsController.getReferralSources);
router.get('/check-phone', clientsController.checkPhone);

// الـ Route الرئيسي
router.get('/', clientsController.getAll);
router.post('/', clientsController.create);

// الـ Routes اللي فيها :id مع الـ middleware
router.get('/:id', validateId, clientsController.getById);
router.put('/:id', validateId, clientsController.update);
router.delete('/:id', validateId, clientsController.remove);

module.exports = router;