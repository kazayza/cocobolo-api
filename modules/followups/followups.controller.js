const followupsQueries = require('./followups.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

async function getAll(req, res) {
  try {
    const data = await followupsQueries.getFollowUps(req.query);
    return res.json(data);
  } catch (err) {
    console.error('followups.getAll:', err);
    return errorResponse(res, 'فشل تحميل المتابعات', 500, err.message);
  }
}

async function getSummary(req, res) {
  try {
    const summary = await followupsQueries.getFollowUpSummary(req.query);
    return res.json(summary);
  } catch (err) {
    console.error('followups.getSummary:', err);
    return errorResponse(res, 'فشل تحميل ملخص المتابعات', 500, err.message);
  }
}

async function completeLead(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const userName = req.body?.userName || req.headers['x-username'] || 'System';
    const result = await followupsQueries.completeLeadFollowUp(id, userName);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('followups.completeLead:', err);
    return errorResponse(res, 'فشل إنهاء المتابعة', 500, err.message);
  }
}

module.exports = {
  getAll,
  getSummary,
  completeLead,
};
