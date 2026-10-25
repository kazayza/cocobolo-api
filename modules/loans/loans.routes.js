const express=require('express'); const router=express.Router(); const ctrl=require('./loans.controller'); const {authenticate}=require('../../core/auth.middleware');
router.get('/stats', authenticate, ctrl.getStats);
router.get('/', authenticate, ctrl.getAll);
router.post('/', authenticate, ctrl.create);
module.exports=router;
