const { sql, connectDB } = require('../../core/database');

async function getDashboardData(filters = {}) {
  const pool = await connectDB();
  const { dateFrom, dateTo, employeeId } = filters;

  // شرط التاريخ والموظف (بيتكرر في كل الاستعلامات)
  let dateFilter = "";
  if (dateFrom && dateTo) {
    dateFilter = `AND CAST(o.CreatedAt AS DATE) BETWEEN @dateFrom AND @dateTo`;
  }
  
  let empFilter = "";
  if (employeeId) {
    empFilter = `AND o.EmployeeID = @employeeId`;
  }

  const request = pool.request();
  if (dateFrom) request.input('dateFrom', sql.Date, dateFrom);
  if (dateTo) request.input('dateTo', sql.Date, dateTo);
  if (employeeId) request.input('employeeId', sql.Int, employeeId);

  // ==========================================
  // 1. KPIs (الأرقام الرئيسية)
  // ==========================================
  const kpiQuery = `
    SELECT 
      -- إجمالي المبيعات (الفرص الناجحة فقط)
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) as totalRevenue,
      
      -- عدد الفرص الكلي
      COUNT(*) as totalOpportunities,
      
      -- الفرص الناجحة
      SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) as wonDeals,
      
      -- الفرص الخاسرة
      SUM(CASE WHEN o.StageID IN (4, 5) THEN 1 ELSE 0 END) as lostDeals,
      
      -- نسبة التحويل (Won / (Won + Lost) * 100)
      CASE 
        WHEN (SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) + SUM(CASE WHEN o.StageID IN (4, 5) THEN 1 ELSE 0 END)) = 0 THEN 0
        ELSE (CAST(SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) AS FLOAT) / (SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) + SUM(CASE WHEN o.StageID IN (4, 5) THEN 1 ELSE 0 END))) * 100
      END as conversionRate,

      -- متوسط قيمة الصفقة
      CASE 
        WHEN SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) = 0 THEN 0
        ELSE ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) / SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END)
      END as avgDealSize

    FROM SalesOpportunities o
    WHERE o.IsActive = 1 ${dateFilter} ${empFilter}
  `;

  // ==========================================
  // 2. Sales Funnel (قمع المبيعات - المراحل)
  // ==========================================
  const funnelQuery = `
    SELECT 
      ss.StageNameAr as stage, 
      COUNT(o.OpportunityID) as count,
      ss.StageOrder
    FROM SalesStages ss
    LEFT JOIN SalesOpportunities o ON ss.StageID = o.StageID AND o.IsActive = 1 ${dateFilter} ${empFilter}
    GROUP BY ss.StageNameAr, ss.StageOrder
    ORDER BY ss.StageOrder
  `;

  // ==========================================
  // 3. Sales Trend (اتجاه المبيعات - آخر 6 شهور)
  // ==========================================
  // ملاحظة: بنجيب الشهور حتى لو مفيهاش داتا
  const trendQuery = `
    SELECT 
      FORMAT(o.CreatedAt, 'yyyy-MM') as month,
      SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END) as revenue
    FROM SalesOpportunities o
    WHERE o.IsActive = 1 ${empFilter} 
    -- بنجيب آخر سنة دايمًا عشان التريند يبان
    AND o.CreatedAt >= DATEADD(YEAR, -1, GETDATE())
    GROUP BY FORMAT(o.CreatedAt, 'yyyy-MM')
    ORDER BY month
  `;

  // ==========================================
  // 4. Sources Analysis (تحليل المصادر)
  // ==========================================
  const sourcesQuery = `
    SELECT TOP 5 cs.SourceNameAr as name, COUNT(o.OpportunityID) as value
    FROM SalesOpportunities o
    JOIN ContactSources cs ON o.SourceID = cs.SourceID
    WHERE o.IsActive = 1 ${dateFilter} ${empFilter}
    GROUP BY cs.SourceNameAr
    ORDER BY value DESC
  `;

  // ==========================================
  // 5. Employee Leaderboard (أفضل الموظفين)
  // ==========================================
  const leaderboardQuery = `
    SELECT TOP 5
      e.FullName,
      COUNT(o.OpportunityID) as totalDeals,
      SUM(CASE WHEN o.StageID = 3 THEN 1 ELSE 0 END) as wonDeals,
      ISNULL(SUM(CASE WHEN o.StageID = 3 THEN o.ExpectedValue ELSE 0 END), 0) as totalRevenue
    FROM Employees e
    JOIN SalesOpportunities o ON e.EmployeeID = o.EmployeeID
    WHERE o.IsActive = 1 ${dateFilter}
    GROUP BY e.FullName
    ORDER BY totalRevenue DESC
  `;

  // ==========================================
  // 6. Lost Reasons Analysis (تحليل أسباب الخسارة)
  // ==========================================
  const lostReasonQuery = `
    SELECT TOP 5 lr.ReasonNameAr as name, COUNT(o.OpportunityID) as value
    FROM SalesOpportunities o
    JOIN LostReasons lr ON o.LostReasonID = lr.LostReasonID
    WHERE o.IsActive = 1 AND o.StageID IN (4, 5) ${dateFilter} ${empFilter}
    GROUP BY lr.ReasonNameAr
    ORDER BY value DESC
  `;

  // تنفيذ الكل
  const [kpi, funnel, trend, sources, leaderboard, lostReasons] = await Promise.all([
    request.query(kpiQuery),
    request.query(funnelQuery),
    request.query(trendQuery),
    request.query(sourcesQuery),
    request.query(leaderboardQuery),
    request.query(lostReasonQuery)
  ]);

  return {
    kpi: kpi.recordset[0],
    funnel: funnel.recordset,
    trend: trend.recordset,
    sources: sources.recordset,
    leaderboard: leaderboard.recordset,
    lostReasons: lostReasons.recordset
  };
}

module.exports = {
  getDashboardData
};