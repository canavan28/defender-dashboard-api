const express = require('express');
const router = express.Router();
const { ghlClient } = require('../utils/ghl');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// These are looked up by name, not hardcoded IDs, so this keeps working
// even if the pipeline gets rebuilt or stages get reordered later.
const OUTSIDE_SALES_PIPELINE_NAME = 'Outside Sales';
const SQL_THRESHOLD_STAGE_NAME = 'Lead';

async function getQualifyingStageIds() {
  const response = await ghlClient.get('/opportunities/pipelines', {
    locationId: process.env.GHL_LOCATION_ID
  });
  const pipeline = response.data.pipelines.find(p => p.name === OUTSIDE_SALES_PIPELINE_NAME);
  if (!pipeline) throw new Error(`Pipeline "${OUTSIDE_SALES_PIPELINE_NAME}" not found`);

  const thresholdStage = pipeline.stages.find(s => s.name === SQL_THRESHOLD_STAGE_NAME);
  if (!thresholdStage) throw new Error(`Stage "${SQL_THRESHOLD_STAGE_NAME}" not found in pipeline "${OUTSIDE_SALES_PIPELINE_NAME}"`);

  const qualifyingStageIds = new Set(
    pipeline.stages.filter(s => s.position >= thresholdStage.position).map(s => s.id)
  );

  return { pipelineId: pipeline.id, qualifyingStageIds };
}

async function fetchAllOpportunities(pipelineId) {
  let all = [];
  let startAfter = null;
  let startAfterId = null;

  while (true) {
    const params = {
      location_id: process.env.GHL_LOCATION_ID,
      pipeline_id: pipelineId,
      limit: 100
    };
    if (startAfter && startAfterId) {
      params.startAfter = startAfter;
      params.startAfterId = startAfterId;
    }

    const response = await ghlClient.get('/opportunities/search', params);
    const opps = response.data.opportunities || [];
    all = [...all, ...opps];

    const meta = response.data.meta;
    if (meta?.nextPage && opps.length > 0) {
      startAfter = meta.startAfter;
      startAfterId = meta.startAfterId;
      await sleep(200);
    } else {
      break;
    }
  }
  return all;
}

// GET /api/sales/sql-count
router.get('/sql-count', async (req, res, next) => {
  try {
    const { pipelineId, qualifyingStageIds } = await getQualifyingStageIds();
    const opportunities = await fetchAllOpportunities(pipelineId);

    // Status is separate from stage - a lost/won deal can still be parked
    // in an earlier stage, so both conditions matter.
    const sqlOpportunities = opportunities.filter(o =>
      o.status === 'open' && qualifyingStageIds.has(o.pipelineStageId)
    );

    res.json({
      sqlCount: sqlOpportunities.length,
      totalOpenInPipeline: opportunities.filter(o => o.status === 'open').length,
      builtAt: new Date().toISOString(),
      sqlOpportunities: sqlOpportunities.map(o => ({
        id: o.id,
        name: o.name,
        companyName: o.contact?.companyName || null,
        stageId: o.pipelineStageId,
        createdAt: o.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;