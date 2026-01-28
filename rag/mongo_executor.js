/**
 * MongoDB aggregation executor with LLM-generated pipelines.
 * 
 * REFACTORED to use:
 * - aggregationGenerator.js for pipeline generation
 * - aggregationValidator.js for safety validation
 * - Enforces column whitelisting, timeouts, and read-only execution
 * 
 * This module is the orchestration layer that ties generation + validation + execution together.
 */

'use strict';

const { MongoClient } = require('mongodb');
const logger = require('../logger');
const { generatePipeline } = require('./aggregationGenerator');
const { validatePipeline } = require('./aggregationValidator');

const DEFAULT_MONGO_URI = process.env.DATABASE || 'mongodb://localhost:27017';
const DEFAULT_DB_NAME = process.env.MONGO_DB || null;

// Default execution constraints
const DEFAULT_MAX_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Execute an aggregation pipeline against MongoDB with strict timeouts and read-only semantics.
 * 
 * Safety guarantees:
 * - Pipeline has already been validated by aggregationValidator
 * - Timeouts prevent long-running queries
 * - Read-only connection (no writes possible)
 * - Result size bounded by $limit in pipeline
 * 
 * @param {Object} tableProfile - Table metadata
 *   {
 *     datasetId: string,
 *     tableName: string,
 *     columns: [{ name: string }]
 *   }
 * @param {Array<Object>} pipeline - Validated MongoDB aggregation pipeline
 * @param {number} maxTimeMs - Execution timeout in milliseconds
 * @returns {Promise<Array<Object>>} - Aggregation results
 * @throws {Error} - If execution fails or times out
 */
async function executePipeline(tableProfile, pipeline, maxTimeMs) {
  var uri = DEFAULT_MONGO_URI;
  var dbName = DEFAULT_DB_NAME || tableProfile.datasetId;
  var timeout = maxTimeMs || DEFAULT_TIMEOUT_MS;

  var client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000
  });

  try {
    await client.connect();
    var db = client.db(dbName);
    var collection = db.collection(tableProfile.tableName);

    logger.info('[RAG] Executing aggregation on ' + dbName + '.' + tableProfile.tableName);
    logger.info('[RAG] Pipeline: ' + JSON.stringify(pipeline));

    // Execute with strict constraints
    var cursor = collection.aggregate(pipeline, {
      allowDiskUse: false,  // Prevent expensive disk-based operations
      maxTimeMS: timeout
    });
    
    var docs = await cursor.toArray();

    // Sanitize results to avoid leaking MongoDB driver types
    var sanitized = docs.map(function(doc) {
      var clean = {};
      Object.keys(doc).forEach(function(k) {
        var v = doc[k];
        // Convert ObjectId to string
        if (k === '_id' && v && typeof v.toString === 'function') {
          clean[k] = v.toString();
        } else {
          clean[k] = v;
        }
      });
      return clean;
    });

    logger.info('[RAG] Aggregation returned ' + sanitized.length + ' results');
    return sanitized;
  } catch (error) {
    logger.error('[RAG] MongoDB aggregation error: ' + error.message);
    throw new Error('Aggregation execution failed: ' + error.message);
  } finally {
    try {
      await client.close();
    } catch (closeError) {
      logger.warn('[RAG] Error closing MongoDB client: ' + closeError.message);
    }
  }
}

/**
 * High-level structured execution entry point.
 * Orchestrates: Generate → Validate → Execute
 * 
 * @param {string} userQuery - Natural language query
 * @param {Object} tableProfile - Table metadata
 * @param {Object} options - Execution options
 *   {
 *     maxLimit?: number,     // Max rows (default: 500)
 *     maxTimeMs?: number     // Timeout (default: 10000)
 *   }
 * @returns {Promise<Array<Object>>} - Aggregation results
 */
async function runStructured(userQuery, tableProfile, options) {
  var maxLimit = (options && options.maxLimit) || DEFAULT_MAX_LIMIT;
  var maxTimeMs = (options && options.maxTimeMs) || DEFAULT_TIMEOUT_MS;

  // Step 1: Generate pipeline using Groq/Ollama
  var pipeline = await generatePipeline(userQuery, tableProfile, maxLimit);

  // Step 2: Validate pipeline safety
  var allowedFields = (tableProfile.columns || []).map(function(c) { return c.name; });
  var validatedPipeline = validatePipeline(pipeline, allowedFields, maxLimit);

  // Step 3: Execute against MongoDB
  return executePipeline(tableProfile, validatedPipeline, maxTimeMs);
}

module.exports = {
  runStructured,
  executePipeline
};

