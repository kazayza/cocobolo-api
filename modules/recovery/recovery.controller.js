const recoveryQueries = require('./recovery.queries');

// 📊 Stats
async function getStats(req, res) {
  try {
    const stats = await recoveryQueries.getStats();
    res.json(stats);
  } catch (err) {
    console.error('getStats:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// 📋 Queue with filters & pagination
async function getQueue(req, res) {
  try {
    const {
      search, q,
      kind = 'all',
      candidateOnly,
      mineOnly,
      lateOnly,
      unassignedOnly,
      uncontactedOnly,
      sortBy = 'value',
      minValue,
      closedFrom,
      closedTo,
      pageIndex = 1,
      pageSize = 12,
      page = 1,
      limit = 12,
    } = req.query;

    const filters = {
      SearchText: search || q || null,
      Kind: kind,
      CandidateOnly: candidateOnly === 'true' || candidateOnly === '1',
      MineOnly: mineOnly === 'true' || mineOnly === '1',
      LateOnly: lateOnly === 'true' || lateOnly === '1',
      UnassignedOnly: unassignedOnly === 'true' || unassignedOnly === '1',
      UncontactedOnly: uncontactedOnly === 'true' || uncontactedOnly === '1',
      SortBy: sortBy,
      MinValue: minValue ? parseFloat(minValue) : null,
      ClosedFrom: closedFrom || null,
      ClosedTo: closedTo || null,
    };

    const pIndex = parseInt(pageIndex || page) || 1;
    const pSize = parseInt(pageSize || limit) || 12;
    const username = req.query.username || req.headers['x-username'] || req.body?.username || null;

    const result = await recoveryQueries.getQueue(filters, pIndex, pSize, username);
    res.json(result);
  } catch (err) {
    console.error('getQueue:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// 📊 Report - مطابق LostRecoveryReport.razor
async function getReport(req, res) {
  try {
    const {
      from, to,
      status = 'all',
      emp, employeeId,
      q, search,
      pageIndex = 1,
      pageSize = 50,
      page = 1,
      limit = 50,
    } = req.query;

    const filters = {
      From: from || null,
      To: to || null,
      Status: status,
      CsEmployeeId: emp ? parseInt(emp) : (employeeId ? parseInt(employeeId) : null),
      SearchText: q || search || null,
    };

    const pIndex = parseInt(pageIndex || page) || 1;
    const pSize = parseInt(pageSize || limit);
    const result = await recoveryQueries.getRecoveryReport(filters, pIndex, isNaN(pSize) ? 50 : pSize);
    res.json(result);
  } catch (err) {
    console.error('getReport:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getTrend(req, res) {
  try {
    const months = parseInt(req.query.months) || 12;
    const trend = await recoveryQueries.getReportTrend(months);
    res.json(trend);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getStaffPerformance(req, res) {
  try {
    const staff = await recoveryQueries.getEmployeePerformance();
    res.json(staff);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getReasons(req, res) {
  try {
    const reasons = await recoveryQueries.getLostReasonAnalysis();
    res.json(reasons);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 🔢 Late count
async function getLateCount(req, res) {
  try {
    const cnt = await recoveryQueries.getLateCount();
    res.json({ count: cnt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 🆕 Unprocessed count
async function getUnprocessedCount(req, res) {
  try {
    const cnt = await recoveryQueries.getUnprocessedNewLossesCount();
    res.json({ count: cnt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 🔄 Maintenance (sync + reminders)
async function runMaintenance(req, res) {
  try {
    const result = await recoveryQueries.runQueueMaintenance();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 📝 Log contact
async function logContact(req, res) {
  try {
    const { OpportunityId, PartyId, Channel, Outcome, Summary, NextFollowUpDate, userName, username } = req.body;
    const actor = userName || username || req.headers['x-username'] || 'System';
    const result = await recoveryQueries.logContact(
      { OpportunityId, PartyId, Channel, Outcome, Summary, NextFollowUpDate },
      actor
    );
    res.json(result);
  } catch (err) {
    console.error('logContact:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// 🕘 History
async function getHistory(req, res) {
  try {
    const { opportunityId } = req.params;
    const history = await recoveryQueries.getRecoveryHistory(parseInt(opportunityId));
    res.json(history);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 🔁 Revive
async function revive(req, res) {
  try {
    const { OpportunityId, SameOpportunity, NewStageId, ExpectedValue, NextFollowUpDate, NewInterestedProduct, Notes, userName, username } = req.body;
    const actor = userName || username || req.headers['x-username'] || 'System';
    const result = await recoveryQueries.revive(
      { OpportunityId, SameOpportunity, NewStageId, ExpectedValue, NextFollowUpDate, NewInterestedProduct, Notes },
      actor
    );
    res.json(result);
  } catch (err) {
    console.error('revive:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// 📋 Stages
async function getStages(req, res) {
  try {
    const stages = await recoveryQueries.getRecoveryStages();
    res.json(stages);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 👥 CS employees
async function getCsEmployees(req, res) {
  try {
    const emps = await recoveryQueries.getCustomerServiceEmployeesLight();
    res.json(emps);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// 👤 Current employee id
async function getCurrentEmployee(req, res) {
  try {
    const { username } = req.params;
    const empId = await recoveryQueries.getEmployeeIdByUsername(username);
    res.json({ employeeId: empId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  getStats,
  getQueue,
  getReport,
  getTrend,
  getStaffPerformance,
  getReasons,
  getLateCount,
  getUnprocessedCount,
  runMaintenance,
  logContact,
  getHistory,
  revive,
  getStages,
  getCsEmployees,
  getCurrentEmployee,
};
