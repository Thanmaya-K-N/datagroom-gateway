/**
 * RAG Controller
 * Handles HTTP requests for RAG operations
 */

const express = require('express');
const router = express.Router();
const ragService = require('./rag.service');
const logger = require('../logger');
const DbAbstraction = require('../dbAbstraction');

/**
 * POST /rag/:datasetId/initialize
 * Initialize embeddings for a dataset
 */
router.post('/:datasetId/initialize', async (req, res) => {
  const { datasetId } = req.params;

  try {
    logger.info(`Initializing RAG for dataset: ${datasetId}`);

    // Fetch dataset from database
    const dataset = await fetchDatasetContent(datasetId);

    if (!dataset) {
      return res.status(404).json({
        success: false,
        error: 'Dataset not found'
      });
    }

    // Initialize embeddings
    const result = await ragService.initializeEmbeddings(datasetId, dataset);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error(`Error initializing RAG for dataset ${datasetId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to initialize embeddings'
    });
  }
});

/**
 * POST /rag/:datasetId/query
 * Query a dataset using RAG
 */
router.post('/:datasetId/query', async (req, res) => {
  const { datasetId } = req.params;
  const { question } = req.body;

  try {
    if (!question || typeof question !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Question is required'
      });
    }

    logger.info(`RAG query for dataset ${datasetId}: ${question}`);

    // Process query
    const result = await ragService.query(datasetId, question);

    res.json({
      success: true,
      answer: result.answer,
      aggregationResult: result.aggregationResult || null,
      route: result.route || null,
      datasetId
    });
  } catch (error) {
    logger.error(`Error processing RAG query for dataset ${datasetId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process query'
    });
  }
});

/**
 * GET /rag/:datasetId/status
 * Check if embeddings exist for a dataset
 */
router.get('/:datasetId/status', async (req, res) => {
  const { datasetId } = req.params;

  try {
    const hasEmbeddings = await ragService.hasEmbeddings(datasetId);

    res.json({
      success: true,
      datasetId,
      hasEmbeddings,
      status: hasEmbeddings ? 'ready' : 'not_initialized'
    });
  } catch (error) {
    logger.error(`Error checking RAG status for dataset ${datasetId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check status'
    });
  }
});

/**
 * DELETE /rag/:datasetId
 * Delete embeddings for a dataset
 */
router.delete('/:datasetId', async (req, res) => {
  const { datasetId } = req.params;

  try {
    const deleted = await ragService.deleteEmbeddings(datasetId);

    res.json({
      success: true,
      deleted,
      message: deleted ? 'Embeddings deleted' : 'No embeddings found'
    });
  } catch (error) {
    logger.error(`Error deleting RAG embeddings for dataset ${datasetId}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete embeddings'
    });
  }
});

/**
 * Helper function to fetch dataset content from database
 * @param {string} datasetId 
 * @returns {Promise<Object>}
 */
/**
 * Helper function to fetch dataset content from database
 * @param {string} datasetId 
 * @returns {Promise<Object>}
 */
async function fetchDatasetContent(datasetId) {
  const dbAbstraction = new DbAbstraction();
  
  try {
    logger.info(`Fetching dataset content for: ${datasetId}`);
    
    // Fetch all data from the dataset (limit to 1000 rows for embedding)
    const dataRows = await dbAbstraction.find(datasetId, 'data', {}, {});
    const limitedRows = dataRows.slice(0, 1000); // Limit to avoid memory issues
    
    logger.info(`Found ${dataRows.length} rows, using ${limitedRows.length} for embeddings`);
    
    if (limitedRows.length === 0) {
      logger.warn(`No data found in dataset: ${datasetId}`);
      return {
        metadata: {
          name: datasetId,
          id: datasetId
        },
        rows: [],
        columns: []
      };
    }

    // Build dataset content object
    const datasetContent = {
      metadata: {
        name: datasetId,
        id: datasetId
      },
      columns: Object.keys(limitedRows[0] || {}),
      rows: limitedRows
    };

    return datasetContent;
  } catch (error) {
    logger.error('Error fetching dataset content:', error);
    throw error;
  }
}

module.exports = router;
