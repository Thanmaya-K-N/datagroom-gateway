/**
 * MongoDB Aggregation Pipeline Generator using Groq qwen3-32b.
 * 
 * Responsibilities:
 * - Generate MongoDB aggregation pipelines from natural language queries
 * - Enforce column whitelisting
 * - Ensure read-only, safe aggregation stages
 * - Return machine-readable JSON only
 * 
 * Constraints:
 * - Temperature = 0 (deterministic output)
 * - Small prompts (Groq 32KB limit)
 * - No hallucinated columns or fields
 * - Explicit allowed stages list
 */

'use strict';

const logger = require('../logger');
const prompts = require('./prompts');
const { groqChat, ollamaChat } = require('./router');

// Feature flag: use Groq for aggregation generation if available
const USE_GROQ_FOR_AGGREGATION = process.env.USE_GROQ_FOR_AGGREGATION === 'true';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

/**
 * Generate MongoDB aggregation pipeline using Groq qwen3-32b.
 * 
 * Input validation:
 * - User query must be non-empty
 * - Table profile must include columns array
 * - Each column must have a name
 * 
 * Output guarantees:
 * - Valid JSON array of pipeline stages
 * - Only uses allowed fields from column whitelist
 * - Includes $limit stage (unless $count is used)
 * - All stages are safe (no write operations)
 * 
 * @param {string} userQuery - Natural language query
 * @param {Object} tableProfile - Table metadata
 *   {
 *     datasetId: string,
 *     tableName: string,
 *     columns: [{ name: string, dtype?: string, description?: string }],
 *     rowCount?: number
 *   }
 * @param {number} maxLimit - Maximum rows to return (default: 500)
 * @returns {Promise<Array<Object>>} - MongoDB aggregation pipeline
 * @throws {Error} - If pipeline generation or parsing fails
 */
async function generatePipeline(userQuery, tableProfile, maxLimit) {
  // Input validation
  logger.info('[Aggregation Generator] Starting pipeline generation');
  logger.info('[Aggregation Generator] Query: ' + userQuery);
  
  if (!userQuery || typeof userQuery !== 'string') {
    logger.error('[Aggregation Generator] Invalid query: ' + JSON.stringify(userQuery));
    throw new Error('Invalid user query: must be non-empty string');
  }

  logger.info('[Aggregation Generator] Table profile received:');
  logger.info('[Aggregation Generator]   - datasetId: ' + (tableProfile ? tableProfile.datasetId : 'undefined'));
  logger.info('[Aggregation Generator]   - tableName: ' + (tableProfile ? tableProfile.tableName : 'undefined'));
  logger.info('[Aggregation Generator]   - columns type: ' + (tableProfile && tableProfile.columns ? typeof tableProfile.columns : 'undefined'));
  logger.info('[Aggregation Generator]   - columns isArray: ' + (tableProfile && Array.isArray(tableProfile.columns)));
  logger.info('[Aggregation Generator]   - columns length: ' + (tableProfile && tableProfile.columns ? tableProfile.columns.length : 'N/A'));
  
  if (!tableProfile || !Array.isArray(tableProfile.columns)) {
    logger.error('[Aggregation Generator] Invalid table profile structure');
    logger.error('[Aggregation Generator] tableProfile: ' + JSON.stringify(tableProfile));
    throw new Error('Invalid table profile: columns array required');
  }

  logger.info('[Aggregation Generator] Raw columns: ' + JSON.stringify(tableProfile.columns.slice(0, 5)));

  var limit = maxLimit || 500;
  var allowedFields = tableProfile.columns
    .map(function(c) { return c.name; })
    .filter(function(name) { return name && typeof name === 'string'; });

  logger.info('[Aggregation Generator] Extracted field names: ' + allowedFields.join(', '));
  logger.info('[Aggregation Generator] Allowed fields count: ' + allowedFields.length);

  if (!allowedFields.length) {
    logger.error('[Aggregation Generator] No valid columns found after filtering');
    logger.error('[Aggregation Generator] Original columns: ' + JSON.stringify(tableProfile.columns));
    throw new Error('No valid columns found in table profile');
  }

  // Build minimal context prompt to stay within Groq 32KB limit
  var allowedStages = [
    '$match', '$group', '$project', '$sort', '$limit',
    '$addFields', '$count', '$unwind', '$skip'
  ];

  var systemPrompt = prompts.AGGREGATION_SYSTEM_PROMPT
    .replace('{max_limit}', String(limit))
    .replace('{allowed_stages}', allowedStages.join(', '));

  // Identify person-related fields for better name matching
  var personFields = allowedFields.filter(function(f) {
    var lower = f.toLowerCase();
    return lower.includes('lead') || lower.includes('owner') || 
           lower.includes('reporter') || lower.includes('assignee') ||
           lower.includes('author') || lower.includes('user') ||
           lower.includes('created_by') || lower.includes('assigned');
  });
  
  // Build column info with sample values for better field matching
  var columnInfo = [];
  if (tableProfile.columns && Array.isArray(tableProfile.columns)) {
    tableProfile.columns.forEach(function(col) {
      if (col.name) {
        var info = col.name;
        // Add sample values if available to help LLM understand column content
        if (col.sampleValues && Array.isArray(col.sampleValues) && col.sampleValues.length > 0) {
          info += ' (values: ' + col.sampleValues.slice(0, 3).join(', ') + ')';
        } else if (col.uniqueValues && Array.isArray(col.uniqueValues) && col.uniqueValues.length > 0) {
          info += ' (values: ' + col.uniqueValues.slice(0, 3).join(', ') + ')';
        }
        columnInfo.push(info);
      }
    });
  }
  
  var userMessage = [
    'Generate a MongoDB aggregation pipeline as JSON array.',
    'Collection: ' + tableProfile.tableName,
    '',
    '═══ AVAILABLE COLUMNS ═══',
    columnInfo.length > 0 ? columnInfo.join('\n') : 'Allowed fields: ' + allowedFields.join(', '),
    '',
    personFields.length > 0 ? '═══ PERSON FIELDS (use $regex for names) ═══\n' + personFields.join(', ') : '',
    '',
    '═══ USER QUESTION ═══',
    userQuery,
    '',
    '═══ CRITICAL RULES ═══',
    '1. Use EXACT column names as listed above (case-sensitive)',
    '2. ALWAYS use $regex for string matching (IDs, names, text) - data may be embedded in larger strings',
    '3. Example: {"$match": {"jobId": {"$regex": "the_value", "$options": "i"}}}',
    '4. For person names, use $regex with $options: "i" for case-insensitive matching',
    '5. Only use exact match for numeric comparisons',
    '',
    'IMPORTANT: Your response MUST be ONLY a valid JSON array starting with [ and ending with ].',
    'Do NOT include any explanation, commentary, or markdown.',
    'Example: [{"$match": {"jobId": {"$regex": "abc123", "$options": "i"}}}, {"$project": {"logContent": 1}}, {"$limit": 10}]'
  ].filter(function(line) { return line; }).join('\n');
  
  logger.info('[Aggregation Generator] User message: ' + userMessage.substring(0, 500) + '...');

  // Use Groq if available and enabled, otherwise fall back to Ollama
  var chatFunction = (USE_GROQ_FOR_AGGREGATION && GROQ_API_KEY) ? groqChat : ollamaChat;
  
  logger.info('[RAG] Generating aggregation pipeline for query: ' + userQuery);
  logger.info('[RAG] Using ' + (chatFunction === groqChat ? 'Groq' : 'Ollama') + ' for generation');

  var raw = await chatFunction(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    0.0,   // Temperature MUST be 0 for deterministic output
    1024   // Increased for reasoning models that need tokens for thinking + output
  );

  // Parse and clean LLM output
  var pipeline = parsePipelineJSON(raw);

  // Validate pipeline structure
  if (!Array.isArray(pipeline)) {
    logger.error('[RAG] Pipeline is not an array. Raw: ' + raw.substring(0, 500));
    throw new Error('Generated pipeline must be a JSON array');
  }

  if (pipeline.length === 0) {
    logger.warn('[RAG] Generated empty pipeline, using default $limit');
    pipeline = [{ $limit: limit }];
  }

  // Validate and fix common LLM mistakes
  pipeline = validateAndFixPipeline(pipeline, userQuery, limit);

  logger.info('[RAG] Generated pipeline with ' + pipeline.length + ' stages');
  return pipeline;
}

/**
 * Validate and fix common LLM mistakes in aggregation pipelines.
 * 
 * Common issues:
 * 1. Adding unnecessary $match filters for row retrieval queries
 * 2. Missing $limit stages
 * 3. Incorrect $skip values
 * 
 * @param {Array<Object>} pipeline - Generated pipeline
 * @param {string} userQuery - Original query for context
 * @param {number} maxLimit - Maximum allowed limit
 * @returns {Array<Object>} - Validated/fixed pipeline
 */
function validateAndFixPipeline(pipeline, userQuery, maxLimit) {
  // Detect if this is a simple row retrieval query
  var queryLower = userQuery.toLowerCase();
  var isSimpleRowQuery = /\b(first|1st|second|2nd|third|3rd|\d+(?:st|nd|rd|th))\s+(row|record|document|entry)\b/i.test(userQuery) ||
                        /\b(row|record)\s+(\d+|one|two|three)\b/i.test(userQuery) ||
                        /\bsummary\s+of\s+the\s+(first|1st|last)\s+row\b/i.test(userQuery);
  
  if (isSimpleRowQuery) {
    // Check if pipeline has unnecessary $match stage
    var hasUnnecessaryMatch = false;
    var matchStageIndex = -1;
    
    for (var i = 0; i < pipeline.length; i++) {
      var stage = pipeline[i];
      if (stage.$match) {
        // Check if match is filtering for empty values or single fields without clear intent
        var matchKeys = Object.keys(stage.$match);
        if (matchKeys.length === 1) {
          var key = matchKeys[0];
          var value = stage.$match[key];
          // If matching empty string or single value without explicit filter in query
          if (value === '' || (!queryLower.includes(key.toLowerCase()) && !queryLower.includes('where') && !queryLower.includes('filter'))) {
            hasUnnecessaryMatch = true;
            matchStageIndex = i;
            logger.warn('[Aggregation Validator] Detected unnecessary $match for row retrieval: ' + JSON.stringify(stage));
          }
        }
      }
    }
    
    // Remove unnecessary match stage
    if (hasUnnecessaryMatch && matchStageIndex >= 0) {
      logger.info('[Aggregation Validator] Removing unnecessary $match stage');
      pipeline.splice(matchStageIndex, 1);
    }
  }
  
  // Ensure $limit is present and reasonable
  var hasLimit = pipeline.some(function(stage) { return stage.$limit; });
  var hasCount = pipeline.some(function(stage) { return stage.$count; });
  
  if (!hasLimit && !hasCount) {
    logger.warn('[Aggregation Validator] No $limit or $count stage found, adding default $limit');
    pipeline.push({ $limit: Math.min(maxLimit, 100) });
  }
  
  return pipeline;
}

/**
 * Parse MongoDB aggregation pipeline from LLM output.
 * Handles common LLM formatting issues:
 * - Markdown code blocks (```json ... ```)
 * - Unquoted MongoDB operators ($sum: 1)
 * - Wrapped objects ({ pipeline: [...] })
 * - Multiple arrays concatenated (LLM mistake)
 * - Extra whitespace and newlines
 * - Think tags from reasoning models
 * - Reasoning text before/after JSON (Nemotron style)
 * 
 * @param {string} raw - Raw LLM output
 * @returns {Array<Object>} - Parsed pipeline array
 * @throws {Error} - If JSON parsing fails
 */
function parsePipelineJSON(raw) {
  // Remove <think>...</think> tags from reasoning models
  var jsonStr = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  
  // Try to extract JSON from markdown code blocks first (most reliable)
  var jsonMatch = jsonStr.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
    logger.info('[RAG] Extracted JSON from markdown code block');
  } else {
    // If no code block, try to find a JSON array anywhere in the text
    // This handles reasoning models that output text before/after JSON
    var arrayMatches = jsonStr.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
    if (arrayMatches && arrayMatches.length > 0) {
      // Find the most likely MongoDB aggregation pipeline (contains $ operators)
      var bestMatch = null;
      for (var i = 0; i < arrayMatches.length; i++) {
        if (arrayMatches[i].indexOf('$') !== -1) {
          bestMatch = arrayMatches[i];
          break;
        }
      }
      if (bestMatch) {
        jsonStr = bestMatch;
        logger.info('[RAG] Extracted JSON array containing MongoDB operators from text');
      } else if (arrayMatches.length > 0) {
        // Use the last array match (often the final answer in reasoning)
        jsonStr = arrayMatches[arrayMatches.length - 1];
        logger.info('[RAG] Extracted last JSON array from text');
      }
    }
  }

  // Remove leading/trailing whitespace
  jsonStr = jsonStr.trim();
  
  // Handle LLM mistake: multiple arrays concatenated like "[...], [...]"
  // Take only the FIRST valid JSON array
  if (jsonStr.startsWith('[')) {
    var bracketCount = 0;
    var firstArrayEnd = -1;
    for (var idx = 0; idx < jsonStr.length; idx++) {
      if (jsonStr[idx] === '[') bracketCount++;
      if (jsonStr[idx] === ']') bracketCount--;
      if (bracketCount === 0) {
        firstArrayEnd = idx;
        break;
      }
    }
    if (firstArrayEnd > 0 && firstArrayEnd < jsonStr.length - 1) {
      var afterFirstArray = jsonStr.substring(firstArrayEnd + 1).trim();
      if (afterFirstArray.startsWith(',') || afterFirstArray.startsWith('[')) {
        logger.warn('[RAG] LLM returned multiple arrays, taking only the first one');
        logger.warn('[RAG] Discarded: ' + afterFirstArray.substring(0, 100));
        jsonStr = jsonStr.substring(0, firstArrayEnd + 1);
      }
    }
  }

  // Fix unquoted MongoDB operators like $sum: 1, $avg: "$field"
  // This is a common LLM mistake that breaks JSON parsing
  jsonStr = jsonStr.replace(/(\$\w+):\s*([^",}\]]+)/g, function(match, operator, value) {
    var trimmedValue = value.trim();
    // If value is not already quoted and not a number/boolean/null
    if (!/^[0-9\-\.\[\{]|^(true|false|null)$/.test(trimmedValue)) {
      return '"' + operator + '": ' + value;
    }
    return '"' + operator + '": ' + value;
  });

  var pipeline;
  try {
    pipeline = JSON.parse(jsonStr);
  } catch (parseError) {
    // Try harder: extract any JSON array pattern from original raw text
    var lastResortMatch = raw.match(/\[\s*\{\s*"\$\w+"[\s\S]*?\}\s*\]/);
    if (lastResortMatch) {
      try {
        pipeline = JSON.parse(lastResortMatch[0]);
        logger.warn('[RAG] Recovered pipeline using last-resort MongoDB pattern match');
      } catch (e) {
        logger.error('[RAG] Failed to parse pipeline JSON. Error: ' + parseError.message);
        logger.error('[RAG] Raw output (first 500 chars): ' + raw.substring(0, 500));
        throw new Error('Invalid aggregation pipeline JSON from LLM: ' + parseError.message);
      }
    } else {
      logger.error('[RAG] Failed to parse pipeline JSON. Error: ' + parseError.message);
      logger.error('[RAG] Raw output (first 500 chars): ' + raw.substring(0, 500));
      throw new Error('Invalid aggregation pipeline JSON from LLM: ' + parseError.message);
    }
  }

  // Handle wrapped responses like { pipeline: [...] } or { result: [...] }
  if (!Array.isArray(pipeline) && pipeline && typeof pipeline === 'object') {
    if (Array.isArray(pipeline.pipeline)) {
      pipeline = pipeline.pipeline;
    } else if (Array.isArray(pipeline.result)) {
      pipeline = pipeline.result;
    } else if (Array.isArray(pipeline.stages)) {
      pipeline = pipeline.stages;
    }
  }

  return pipeline;
}

/**
 * Generate test/example pipeline for a given query type.
 * Useful for testing without LLM calls.
 * 
 * @param {string} queryType - 'count' | 'filter' | 'group' | 'rows'
 * @param {Object} tableProfile - Table metadata
 * @param {number} maxLimit - Maximum rows
 * @returns {Array<Object>} - Sample pipeline
 */
function generateSamplePipeline(queryType, tableProfile, maxLimit) {
  var limit = maxLimit || 500;
  
  switch (queryType) {
    case 'count':
      return [{ $count: 'total' }];
    
    case 'filter':
      // Simple filter example (requires knowing a field name)
      var firstField = tableProfile.columns[0] ? tableProfile.columns[0].name : '_id';
      return [
        { $match: {} },
        { $limit: limit }
      ];
    
    case 'group':
      // Simple grouping example
      return [
        { $group: { _id: null, count: { $sum: 1 } } },
        { $limit: 1 }
      ];
    
    case 'rows':
      // Just return first N rows
      return [{ $limit: Math.min(limit, 10) }];
    
    default:
      return [{ $limit: limit }];
  }
}

module.exports = {
  generatePipeline,
  parsePipelineJSON,
  generateSamplePipeline
};
