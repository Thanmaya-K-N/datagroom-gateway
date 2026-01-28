/**
 * MongoDB Aggregation Pipeline Validator
 * 
 * MANDATORY safety layer that enforces:
 * - No unknown/hallucinated fields
 * - No write stages ($out, $merge, etc.)
 * - Bounded result sets ($limit always present unless $count)
 * - Maximum stage count limits
 * - Read-only operations only
 * 
 * This module prevents:
 * - LLM hallucinations from becoming security vulnerabilities
 * - Unbounded queries that could overwhelm MongoDB
 * - Data corruption from write operations
 * - Column name guessing
 */

'use strict';

const logger = require('../logger');

// Maximum stages allowed in a pipeline to prevent complexity attacks
const MAX_PIPELINE_STAGES = 20;

// Safe read-only stages that are allowed
const SAFE_STAGES = {
  '$match': true,
  '$group': true,
  '$project': true,
  '$sort': true,
  '$limit': true,
  '$skip': true,
  '$addFields': true,
  '$count': true,
  '$unwind': true,
  '$lookup': false,  // Disabled: can cause performance issues
  '$facet': false,   // Disabled: too complex for LLM-generated queries
  '$bucket': true,
  '$sortByCount': true,
  '$replaceRoot': false  // Disabled: can be misused
};

// Forbidden write stages - these should NEVER appear in LLM-generated pipelines
const FORBIDDEN_STAGES = {
  '$out': true,
  '$merge': true,
  '$update': true,
  '$delete': true,
  '$replace': true
};

/**
 * Validate MongoDB aggregation pipeline against safety rules.
 * 
 * Validation rules (MANDATORY):
 * 1. Pipeline must be non-empty array
 * 2. All stages must be safe (no writes, no dangerous reads)
 * 3. All referenced fields must be in the whitelist
 * 4. Must have $limit or $count (no unbounded queries)
 * 5. Stage count must not exceed MAX_PIPELINE_STAGES
 * 
 * @param {Array<Object>} pipeline - MongoDB aggregation pipeline
 * @param {string[]} allowedFields - Column whitelist
 * @param {number} maxLimit - Maximum allowed $limit value
 * @returns {Array<Object>} - Validated (and possibly modified) pipeline
 * @throws {Error} - If validation fails
 */
function validatePipeline(pipeline, allowedFields, maxLimit) {
  // Rule 1: Pipeline must be non-empty array
  if (!Array.isArray(pipeline) || !pipeline.length) {
    var error = 'Pipeline validation failed: empty or invalid pipeline';
    logger.error('[Aggregation Validator] REJECTED: ' + error);
    logger.error('[Aggregation Validator] Pipeline: ' + JSON.stringify(pipeline));
    throw new Error(error);
  }

  // Rule 5: Stage count limit
  if (pipeline.length > MAX_PIPELINE_STAGES) {
    var error = 'Pipeline validation failed: too many stages (' + pipeline.length + ' > ' + MAX_PIPELINE_STAGES + ')';
    logger.error('[Aggregation Validator] REJECTED: ' + error);
    logger.error('[Aggregation Validator] Pipeline: ' + JSON.stringify(pipeline, null, 2));
    throw new Error(error);
  }

  var hasLimit = false;
  var hasCount = false;

  // Rule 2: Validate each stage is safe
  pipeline.forEach(function(stage, idx) {
    if (!stage || typeof stage !== 'object') {
      var error = 'Pipeline validation failed: stage ' + idx + ' is not an object';
      logger.error('[Aggregation Validator] REJECTED: ' + error);
      logger.error('[Aggregation Validator] Stage: ' + JSON.stringify(stage));
      throw new Error(error);
    }

    var keys = Object.keys(stage);
    if (!keys.length) {
      var error = 'Pipeline validation failed: stage ' + idx + ' is empty';
      logger.error('[Aggregation Validator] REJECTED: ' + error);
      throw new Error(error);
    }

    var operator = keys[0];

    // Check for forbidden write stages
    if (FORBIDDEN_STAGES[operator]) {
      var error = 'Pipeline validation failed: forbidden stage ' + operator + ' at position ' + idx;
      logger.error('[Aggregation Validator] REJECTED: ' + error);
      logger.error('[Aggregation Validator] Reason: Write operations are not allowed');
      logger.error('[Aggregation Validator] Pipeline: ' + JSON.stringify(pipeline, null, 2));
      throw new Error(error);
    }

    // Check if stage is in allowed list
    if (!SAFE_STAGES[operator]) {
      var error = 'Pipeline validation failed: disallowed stage ' + operator + ' at position ' + idx;
      logger.error('[Aggregation Validator] REJECTED: ' + error);
      logger.error('[Aggregation Validator] Reason: Stage not in whitelist');
      logger.error('[Aggregation Validator] Allowed stages: ' + Object.keys(SAFE_STAGES).filter(function(k) { return SAFE_STAGES[k]; }).join(', '));
      logger.error('[Aggregation Validator] Pipeline: ' + JSON.stringify(pipeline, null, 2));
      throw new Error(error);
    }
    if (!SAFE_STAGES[operator]) {
      throw new Error('Pipeline validation failed: disallowed stage ' + operator + ' at position ' + idx);
    }

    // Track $limit and $count for Rule 4
    if (operator === '$limit') {
      hasLimit = true;
      // Enforce maximum limit
      if (typeof stage.$limit === 'number' && stage.$limit > maxLimit) {
        logger.warn('[RAG] Capping $limit from ' + stage.$limit + ' to ' + maxLimit);
        stage.$limit = maxLimit;
      }
    }

    if (operator === '$count') {
      hasCount = true;
    }
  });

  // Rule 4: Must have bounded output (unless it's just $count)
  if (!hasLimit && !hasCount) {
    logger.info('[RAG] No $limit or $count found, appending $limit: ' + maxLimit);
    pipeline.push({ $limit: maxLimit });
  }

  // Rule 3: Validate field whitelist
  validateFieldWhitelist(pipeline, allowedFields);

  logger.info('[RAG] Pipeline validation passed: ' + pipeline.length + ' stages');
  return pipeline;
}

/**
 * Extract all field references from a pipeline and validate against whitelist.
 * 
 * Extraction rules:
 * - $match keys are field names
 * - "$fieldName" strings are field references
 * - Nested objects are recursively checked
 * - System fields like "$$ROOT" are ignored
 * - _id is always allowed
 * 
 * @param {Array<Object>} pipeline - MongoDB aggregation pipeline
 * @param {string[]} allowedFields - Column whitelist
 * @throws {Error} - If unknown fields are referenced
 */
function validateFieldWhitelist(pipeline, allowedFields) {
  var allowedSet = {};
  (allowedFields || []).forEach(function(f) {
    if (f && typeof f === 'string') {
      allowedSet[f] = true;
    }
  });
  
  // Always allow _id (MongoDB internal field)
  allowedSet['_id'] = true;

  var usedFields = new Set();
  
  // Extract all field references from pipeline
  pipeline.forEach(function(stage) {
    extractFieldsFromStage(stage, usedFields);
  });

  // Check for unknown fields
  var unknownFields = [];
  usedFields.forEach(function(field) {
    if (field && !allowedSet[field]) {
      unknownFields.push(field);
    }
  });

  if (unknownFields.length > 0) {
    var error = 'Pipeline validation failed: unknown fields referenced: ' + 
      unknownFields.join(', ') + 
      '. Allowed fields: ' + 
      Object.keys(allowedSet).join(', ');
    
    logger.error('[Aggregation Validator] REJECTED: ' + error);
    logger.error('[Aggregation Validator] Unknown fields: ' + JSON.stringify(unknownFields));
    logger.error('[Aggregation Validator] Allowed fields: ' + JSON.stringify(Object.keys(allowedSet)));
    logger.error('[Aggregation Validator] This prevents LLM hallucination of non-existent columns');
    
    throw new Error(error);
  }
}

/**
 * Recursively extract field names from a pipeline stage.
 * 
 * Handles:
 * - $match: { fieldName: value } → fieldName
 * - $group: { _id: "$fieldName" } → fieldName
 * - $project: { newField: "$oldField" } → oldField
 * - Nested expressions like { $sum: "$field" }
 * - Array stages like $facet
 * 
 * Special cases:
 * - $count: "outputName" → outputName is NOT a field reference (it's the output field name)
 * - $sortByCount: "$field" → field IS a reference
 * 
 * @param {*} value - Pipeline stage or sub-expression
 * @param {Set<string>} accumulator - Set to collect field names
 * @param {string|null} parentStage - Name of parent stage operator
 */
function extractFieldsFromStage(value, accumulator, parentStage) {
  if (!value) {
    return;
  }

  // Special case: $count stage - its string value is NOT a field reference
  if (parentStage === '$count' && typeof value === 'string') {
    // The string in $count is the output field name, not a reference
    return;
  }

  // Handle objects recursively
  if (typeof value === 'object' && !Array.isArray(value)) {
    Object.keys(value).forEach(function(key) {
      var val = value[key];
      
      // MongoDB operators start with $
      if (key.charAt(0) === '$') {
        // This is an operator, recurse into its value
        extractFieldsFromStage(val, accumulator, key);
      } else {
        // This is a field name (in $match, $project, etc.)
        // But NOT in $group._id or computed fields - only add keys in $match
        if (parentStage === '$match') {
          accumulator.add(key);
        }
        // Recurse into the value
        extractFieldsFromStage(val, accumulator, parentStage);
      }
    });
    return;
  }

  // Handle arrays recursively
  if (Array.isArray(value)) {
    value.forEach(function(item) {
      extractFieldsFromStage(item, accumulator, parentStage);
    });
    return;
  }

  // Handle field references like "$fieldName" or "$field.subfield"
  if (typeof value === 'string' && value.charAt(0) === '$') {
    // System variables like $$ROOT, $$NOW should be ignored
    if (value.indexOf('$$') === 0) {
      return;
    }
    
    // Extract field name (before any dot notation)
    var fieldPath = value.substring(1); // Remove leading $
    var fieldName = fieldPath.split('.')[0]; // Get first part before dot
    
    if (fieldName) {
      accumulator.add(fieldName);
    }
  }
}

/**
 * Validate that a pipeline is deterministic (no random sampling, etc.).
 * This is important for reproducible results.
 * 
 * @param {Array<Object>} pipeline - MongoDB aggregation pipeline
 * @returns {boolean} - True if deterministic
 */
function isDeterministic(pipeline) {
  for (var i = 0; i < pipeline.length; i++) {
    var stage = pipeline[i];
    var operator = Object.keys(stage)[0];
    
    // $sample is non-deterministic
    if (operator === '$sample') {
      return false;
    }
    
    // $rand in expressions is non-deterministic
    var stageStr = JSON.stringify(stage);
    if (stageStr.indexOf('$rand') !== -1) {
      return false;
    }
  }
  
  return true;
}

/**
 * Estimate the complexity/cost of a pipeline.
 * Higher scores indicate more expensive operations.
 * 
 * Complexity factors:
 * - $match (early): 1 point (cheap, uses indexes)
 * - $group: 5 points (requires aggregation)
 * - $lookup: 10 points (expensive joins)
 * - $sort without $limit: 8 points (expensive)
 * - $unwind: 3 points (can explode docs)
 * 
 * @param {Array<Object>} pipeline - MongoDB aggregation pipeline
 * @returns {number} - Complexity score
 */
function estimateComplexity(pipeline) {
  var complexity = 0;
  var hasLimit = false;

  pipeline.forEach(function(stage) {
    var operator = Object.keys(stage)[0];
    
    switch (operator) {
      case '$match':
        complexity += 1;
        break;
      case '$group':
        complexity += 5;
        break;
      case '$lookup':
        complexity += 10;
        break;
      case '$sort':
        // $sort is much cheaper after $limit
        complexity += hasLimit ? 2 : 8;
        break;
      case '$unwind':
        complexity += 3;
        break;
      case '$limit':
      case '$skip':
        hasLimit = true;
        complexity += 1;
        break;
      case '$project':
      case '$addFields':
        complexity += 2;
        break;
      default:
        complexity += 1;
    }
  });

  return complexity;
}

module.exports = {
  validatePipeline,
  validateFieldWhitelist,
  extractFieldsFromStage,
  isDeterministic,
  estimateComplexity,
  SAFE_STAGES,
  FORBIDDEN_STAGES,
  MAX_PIPELINE_STAGES
};
