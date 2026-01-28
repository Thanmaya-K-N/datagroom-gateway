/**
 * MongoDB Row Fetcher for Bounded Hybrid Grounding
 * 
 * PURPOSE:
 * Provide explanatory grounding for HYBRID queries by fetching a small number
 * of example rows from MongoDB. These rows give LLMs concrete evidence to
 * explain aggregation results without hallucinating.
 * 
 * CRITICAL CONSTRAINTS (DO NOT VIOLATE):
 * - Max 10 rows per fetch
 * - Explicit projection (no wildcard fields)
 * - Explicit sort order (deterministic)
 * - Explicit reason for fetch (logging/audit)
 * - Read-only operations only
 * - Time-bounded execution
 * - NO unbounded queries
 * - NO full scans
 * - NO random sampling
 * 
 * NON-GOALS:
 * - This is NOT for computation or aggregation
 * - This is NOT for data export
 * - This is NOT for end-user row browsing
 * - Rows are NEVER embedded or vector-indexed
 * 
 * USAGE:
 * Only called by HYBRID pipeline after aggregation completes,
 * to provide example rows that support the aggregation result.
 */

'use strict';

const { MongoClient } = require('mongodb');
const logger = require('../logger');

const DEFAULT_MONGO_URI = process.env.DATABASE || 'mongodb://localhost:27017';
const DEFAULT_DB_NAME = process.env.MONGO_DB || null;

// Hard limits to prevent abuse
const ABSOLUTE_MAX_ROWS = 10;
const DEFAULT_MAX_ROWS = 5;
const MAX_TIMEOUT_MS = 5000;

/**
 * Fetch types supported by this module.
 * Each type has explicit semantics and constraints.
 */
var FetchType = {
  LATEST: 'LATEST',           // Most recent rows (requires sort field)
  EARLIEST: 'EARLIEST',       // Oldest rows (requires sort field)
  TOP_VALUES: 'TOP_VALUES',   // Highest values for a numeric field
  BOTTOM_VALUES: 'BOTTOM_VALUES', // Lowest values for a numeric field
  SAMPLE_BY_GROUP: 'SAMPLE_BY_GROUP', // Representative rows per group
  FILTERED: 'FILTERED'        // Rows matching specific criteria
};

/**
 * Fetch bounded example rows from MongoDB for hybrid explanations.
 * 
 * This function enforces ALL safety constraints and should be the ONLY
 * way to fetch raw rows for LLM grounding.
 * 
 * @param {Object} options - Fetch configuration (all fields REQUIRED)
 *   {
 *     datasetId: string,      // Database name (or use DEFAULT_DB_NAME)
 *     tableName: string,      // Collection name
 *     fetchType: string,      // One of FetchType enum values
 *     fields: string[],       // EXPLICIT projection fields (no wildcards)
 *     sortField: string,      // Field to sort by (required for LATEST/EARLIEST/TOP/BOTTOM)
 *     sortOrder: 1|-1,        // Sort direction (1=asc, -1=desc)
 *     filter: Object,         // MongoDB filter criteria (optional, default: {})
 *     maxRows: number,        // Max rows (default: 5, hard cap: 10)
 *     reason: string          // Human-readable reason for audit log
 *   }
 * 
 * @returns {Promise<Array<Object>>} - Fetched rows (always <= maxRows)
 * @throws {Error} - If validation fails or MongoDB error occurs
 */
async function fetchBoundedRows(options) {
  // Mandatory input validation
  validateFetchOptions(options);

  var datasetId = options.datasetId;
  var tableName = options.tableName;
  var fetchType = options.fetchType;
  var fields = options.fields;
  var sortField = options.sortField;
  var sortOrder = options.sortOrder || -1;
  var filter = options.filter || {};
  var maxRows = Math.min(options.maxRows || DEFAULT_MAX_ROWS, ABSOLUTE_MAX_ROWS);
  var reason = options.reason;

  logger.info('[RAG] Fetching bounded rows: ' + reason);
  logger.info('[RAG] Fetch params: dataset=' + datasetId + ', table=' + tableName + 
              ', type=' + fetchType + ', maxRows=' + maxRows);

  // Build MongoDB query based on fetch type
  var query = buildRowQuery(fetchType, filter, sortField, sortOrder, maxRows);

  // Execute with strict timeout
  var rows = await executeFetch(datasetId, tableName, query, fields, maxRows);

  logger.info('[RAG] Fetched ' + rows.length + ' rows for: ' + reason);
  return rows;
}

/**
 * Validate fetch options against safety constraints.
 * Throws detailed errors if validation fails.
 * 
 * @param {Object} options - Fetch options to validate
 * @throws {Error} - If any constraint is violated
 */
function validateFetchOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Fetch options required');
  }

  // Required fields
  var required = ['datasetId', 'tableName', 'fetchType', 'fields', 'reason'];
  required.forEach(function(field) {
    if (!options[field]) {
      throw new Error('Fetch option required: ' + field);
    }
  });

  // Validate datasetId and tableName
  if (typeof options.datasetId !== 'string' || !options.datasetId.trim()) {
    throw new Error('Invalid datasetId: must be non-empty string');
  }
  if (typeof options.tableName !== 'string' || !options.tableName.trim()) {
    throw new Error('Invalid tableName: must be non-empty string');
  }

  // Validate fetchType
  if (!FetchType[options.fetchType]) {
    throw new Error('Invalid fetchType: must be one of ' + Object.keys(FetchType).join(', '));
  }

  // Validate fields projection (NO WILDCARDS)
  if (!Array.isArray(options.fields) || options.fields.length === 0) {
    throw new Error('Fields projection required: must be non-empty array');
  }
  
  options.fields.forEach(function(field) {
    if (typeof field !== 'string' || !field.trim()) {
      throw new Error('Invalid field in projection: must be non-empty string');
    }
    if (field.indexOf('*') !== -1 || field === '') {
      throw new Error('Wildcard fields not allowed in projection');
    }
  });

  // Validate sortField for fetch types that require it
  var requiresSort = [
    FetchType.LATEST,
    FetchType.EARLIEST,
    FetchType.TOP_VALUES,
    FetchType.BOTTOM_VALUES
  ];
  
  if (requiresSort.indexOf(options.fetchType) !== -1) {
    if (!options.sortField || typeof options.sortField !== 'string') {
      throw new Error('sortField required for fetchType: ' + options.fetchType);
    }
  }

  // Validate maxRows
  if (options.maxRows && (typeof options.maxRows !== 'number' || options.maxRows < 1)) {
    throw new Error('maxRows must be positive number');
  }
  if (options.maxRows > ABSOLUTE_MAX_ROWS) {
    throw new Error('maxRows exceeds absolute maximum: ' + ABSOLUTE_MAX_ROWS);
  }

  // Validate reason (for audit logging)
  if (typeof options.reason !== 'string' || options.reason.length < 10) {
    throw new Error('Reason required: must be descriptive string (min 10 chars)');
  }
}

/**
 * Build MongoDB query object based on fetch type.
 * 
 * @param {string} fetchType - One of FetchType enum values
 * @param {Object} filter - Base filter criteria
 * @param {string} sortField - Field to sort by
 * @param {number} sortOrder - Sort direction (1 or -1)
 * @param {number} limit - Max rows
 * @returns {Object} - Query configuration { filter, sort, limit }
 */
function buildRowQuery(fetchType, filter, sortField, sortOrder, limit) {
  var query = {
    filter: filter || {},
    sort: {},
    limit: limit
  };

  switch (fetchType) {
    case FetchType.LATEST:
      // Most recent rows (descending sort)
      query.sort[sortField] = -1;
      break;

    case FetchType.EARLIEST:
      // Oldest rows (ascending sort)
      query.sort[sortField] = 1;
      break;

    case FetchType.TOP_VALUES:
      // Highest values (descending sort)
      query.sort[sortField] = -1;
      break;

    case FetchType.BOTTOM_VALUES:
      // Lowest values (ascending sort)
      query.sort[sortField] = 1;
      break;

    case FetchType.FILTERED:
      // Just apply filter, optionally sort
      if (sortField) {
        query.sort[sortField] = sortOrder || 1;
      }
      break;

    case FetchType.SAMPLE_BY_GROUP:
      // For grouped samples, caller should provide appropriate filter
      if (sortField) {
        query.sort[sortField] = sortOrder || 1;
      }
      break;

    default:
      throw new Error('Unknown fetchType: ' + fetchType);
  }

  return query;
}

/**
 * Execute MongoDB fetch with strict timeout and safety limits.
 * 
 * @param {string} datasetId - Database name
 * @param {string} tableName - Collection name
 * @param {Object} query - Query configuration from buildRowQuery()
 * @param {string[]} fields - Projection fields
 * @param {number} maxRows - Maximum rows to return
 * @returns {Promise<Array<Object>>} - Fetched rows
 */
async function executeFetch(datasetId, tableName, query, fields, maxRows) {
  var uri = DEFAULT_MONGO_URI;
  var dbName = DEFAULT_DB_NAME || datasetId;

  var client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: MAX_TIMEOUT_MS
  });

  try {
    await client.connect();
    var db = client.db(dbName);
    var collection = db.collection(tableName);

    // Build projection object (MongoDB expects { field: 1 } format)
    var projection = {};
    fields.forEach(function(field) {
      projection[field] = 1;
    });

    // Execute find with explicit projection, sort, and limit
    var cursor = collection
      .find(query.filter, { projection: projection })
      .sort(query.sort)
      .limit(maxRows);

    // Add maxTimeMS to prevent long-running queries
    cursor = cursor.maxTimeMS(MAX_TIMEOUT_MS);

    var docs = await cursor.toArray();

    // Sanitize _id fields (convert ObjectId to string)
    var sanitized = docs.map(function(doc) {
      var clean = {};
      Object.keys(doc).forEach(function(key) {
        var value = doc[key];
        if (key === '_id' && value && typeof value.toString === 'function') {
          clean[key] = value.toString();
        } else {
          clean[key] = value;
        }
      });
      return clean;
    });

    return sanitized;
  } catch (error) {
    logger.error('[RAG] MongoDB fetch error: ' + error.message);
    throw new Error('Failed to fetch bounded rows: ' + error.message);
  } finally {
    try {
      await client.close();
    } catch (closeError) {
      logger.warn('[RAG] Error closing MongoDB client: ' + closeError.message);
    }
  }
}

/**
 * Determine if example rows are needed for a hybrid explanation.
 * 
 * Decision logic:
 * - If aggregation is just a count → no rows needed
 * - If aggregation has groups → fetch 1-2 rows per group
 * - If aggregation has trends → fetch extreme values
 * - If aggregation is empty → maybe fetch sample rows
 * 
 * @param {Array|Object} aggregationResult - Result from MongoDB aggregation
 * @returns {boolean} - True if example rows would be helpful
 */
function shouldFetchExampleRows(aggregationResult) {
  if (!aggregationResult) {
    return false;
  }

  // Single count result: no rows needed
  if (Array.isArray(aggregationResult) && 
      aggregationResult.length === 1 && 
      aggregationResult[0].count !== undefined) {
    return false;
  }

  // Empty result: might want sample rows to show what data looks like
  if (Array.isArray(aggregationResult) && aggregationResult.length === 0) {
    return true;
  }

  // Grouped results: fetch example rows per group
  if (Array.isArray(aggregationResult) && 
      aggregationResult.length > 0 && 
      aggregationResult[0]._id !== undefined) {
    return true;
  }

  // Default: fetch rows for richer explanations
  return true;
}

module.exports = {
  fetchBoundedRows,
  shouldFetchExampleRows,
  FetchType,
  ABSOLUTE_MAX_ROWS,
  DEFAULT_MAX_ROWS
};
