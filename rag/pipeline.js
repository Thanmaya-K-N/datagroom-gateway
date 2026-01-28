/**
 * End-to-end RAG pipeline orchestrating routing, semantic retrieval, and MongoDB execution.
 * 
 * REFACTORED to implement bounded MongoDB row grounding and dual-LLM architecture:
 * - Groq: Routing + aggregation generation (temp=0, deterministic)
 * - OpenRouter (Nemotron): Semantic queries, hybrid explanations (primary LLM)
 * - Ollama: Fallback if OpenRouter unavailable
 * 
 * Key changes:
 * - HYBRID path now fetches bounded example rows (max 10) for grounding
 * - Strict separation of concerns: computation vs explanation
 * - Enhanced prompting with explicit no-hallucination rules
 */

'use strict';

const logger = require('../logger');
const { routeQuery, QueryType, ollamaChat, ollamaChatHybrid, OPENROUTER_MODEL, OLLAMA_HYBRID_MODEL } = require('./router');
const prompts = require('./prompts');
const { indexEmbeddings } = require('./embeddings');
const { semanticSearch } = require('./retrievers');
const { runStructured } = require('./mongo_executor');
const { fetchBoundedRows, shouldFetchExampleRows, FetchType } = require('./mongoRowFetcher');

// Feature flags
const ENABLE_HYBRID_ROW_GROUNDING = process.env.ENABLE_HYBRID_ROW_GROUNDING !== 'false'; // Default: enabled

/**
 * Ingest table metadata and index table/column/sample embeddings.
 * @param {Object} tableProfile
 *  {
 *    datasetId, tableName, purpose, rowCount,
 *    primaryKeys: string[],
 *    columns: [{ name, dtype, description, stats }],
 *    sampleRows?: [ {...}, ... ]
 *  }
 */
async function ingest(tableProfile) {
  await indexEmbeddings(tableProfile);
}

/**
 * Answer semantic-only queries using MongoDB Vector Search + LLM.
 * 
 * Flow:
 * 1. Semantic search in MongoDB (table/column metadata)
 * 2. Pass retrieved context to Ollama for explanation
 * 
 * @param {Object} tableProfile - Table metadata
 * @param {string} userQuery - User's question
 * @returns {Promise<Object>}
 */
async function semanticAnswer(tableProfile, userQuery) {
  const { extractMetadataFilters } = require('./retrievers');
  
  try {
    // Extract metadata filters
    var metadataFilter = extractMetadataFilters(userQuery);
    
    logger.info('[RAG] Semantic search starting for query: ' + userQuery.substring(0, 100));
    
    // INCREASED from 8 to 20 for comprehensive column coverage
    // For datasets with many columns, we need more results to see all metadata
    var topK = 20;
    var results = await semanticSearch(tableProfile.datasetId, userQuery, topK, metadataFilter);
    
    logger.info('[RAG] Semantic search returned ' + results.length + ' results');

    if (!results.length) {
      logger.warn('[RAG] No semantic results found - check if embeddings are initialized');
      return {
        route: QueryType.SEMANTIC,
        answer: 'No metadata embeddings found for this dataset. This could mean:\\n\\n' +
                '1. The dataset embeddings have not been initialized yet\\n' +
                '2. The MongoDB Atlas Vector Search index \"vector_index\" is not created\\n\\n' +
                'Please initialize embeddings for this dataset first or create the required vector index in MongoDB Atlas.',
        retrievedDocs: 0,
        contextChunks: 0
      };
    }

    // REDUCED limits for faster Ollama processing
    // Large context causes timeouts with local Ollama on limited hardware
    var maxDocs = 5; // Reduced from 15 for faster processing
    var maxChars = 500; // Reduced from 1500 for faster processing
    var trimmed = results.slice(0, maxDocs).map(function(r) {
      var t = r.text || '';
      return t.length > maxChars ? t.substring(0, maxChars) + '...' : t;
    });

    var chunks = trimmed;
    logger.info('[RAG] Using ' + chunks.length + ' chunks for semantic answer (topK was ' + topK + ')');
    
    var userPrompt = prompts.buildSemanticUserPrompt(chunks, userQuery);

    // Use Ollama for semantic explanations (allows higher temp + larger context)
    var answer = await ollamaChat(
      [
        { role: 'system', content: prompts.SEMANTIC_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      0.2,  // Slightly higher temp for natural explanations
      1024  // Increased from 512 to allow longer, more comprehensive answers
    );

    return {
      route: QueryType.SEMANTIC,
      answer: answer,
      retrievedDocs: results.length,
      contextChunks: chunks.length
    };
  } catch (error) {
    logger.error('[RAG] Semantic answer error:', error);
    return {
      route: QueryType.SEMANTIC,
      answer: 'Error retrieving semantic context: ' + error.message
    };
  }
}

/**
 * Answer structured-only queries with Mongo aggregation + LLM explanation.
 * 
 * Flow:
 * 1. Execute MongoDB aggregation pipeline
 * 2. Pass results to LLM for natural language explanation
 * 3. Return both raw results and human-friendly answer
 * 
 * @param {Object} tableProfile
 * @param {string} userQuery
 * @returns {Promise<Object>}
 */
async function structuredAnswer(tableProfile, userQuery) {
  logger.info('[RAG] Starting STRUCTURED answer flow');
  
  // Step 1: Execute the aggregation
  var aggregationResult = await runStructured(userQuery, tableProfile, {});
  
  logger.info('[RAG] Aggregation returned ' + 
    (Array.isArray(aggregationResult) ? aggregationResult.length : 1) + ' results');
  
  // Step 2: Generate natural language explanation using LLM
  var answer;
  try {
    // Build the explanation prompt
    var userPrompt = prompts.buildStructuredExplanationPrompt(
      aggregationResult,
      userQuery,
      null // pipeline description - could be added later
    );
    
    logger.info('[RAG] Generating natural language explanation for structured results');
    
    // Use Ollama for explanation (same as hybrid)
    answer = await ollamaChat(
      [
        { role: 'system', content: prompts.STRUCTURED_EXPLANATION_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      0.3,  // Slightly higher temp for natural language
      2048  // Increased token limit for longer log content explanations
    );
    
    logger.info('[RAG] Natural language explanation generated successfully');
  } catch (llmError) {
    // Fallback to formatted JSON if LLM fails
    logger.warn('[RAG] LLM explanation failed, falling back to formatted JSON: ' + llmError.message);
    
    if (Array.isArray(aggregationResult)) {
      if (aggregationResult.length === 0) {
        answer = 'No results found matching your query.';
      } else if (aggregationResult.length === 1 && (aggregationResult[0].count !== undefined || aggregationResult[0].total !== undefined)) {
        var countValue = aggregationResult[0].count || aggregationResult[0].total;
        answer = 'Total count: ' + countValue;
      } else if (aggregationResult.length <= 10) {
        answer = JSON.stringify(aggregationResult, null, 2);
      } else {
        answer = 'Found ' + aggregationResult.length + ' results. Showing first 10:\n\n' + 
                 JSON.stringify(aggregationResult.slice(0, 10), null, 2);
      }
    } else {
      answer = JSON.stringify(aggregationResult, null, 2);
    }
  }
  
  return {
    route: QueryType.STRUCTURED,
    aggregationResult: aggregationResult,
    answer: answer
  };
}

/**
 * Answer hybrid queries: Mongo aggregation + LLM explanation.
 * 
 * CRITICAL: This is the bounded hybrid grounding implementation.
 * 
 * Flow:
 * 1. Use Groq to generate aggregation pipeline
 * 2. Execute aggregation in MongoDB
 * 3. Determine if example rows are needed for explanation
 * 4. Fetch bounded rows (max 10) via mongoRowFetcher
 * 5. Build explanation prompt with aggregation + rows + metadata
 * 6. Use Ollama to generate explanation (NOT Groq - needs larger context)
 * 
 * Key constraints:
 * - Example rows are for grounding only, NOT computation
 * - Max 10 rows fetched with explicit projection
 * - LLM instructed to NOT recalculate or invent numbers
 * 
 * @param {Object} tableProfile - Table metadata
 * @param {string} userQuery - User's question
 * @returns {Promise<Object>}
 */
async function hybridAnswer(tableProfile, userQuery) {
  const { extractMetadataFilters } = require('./retrievers');
  
  logger.info('[RAG] Starting HYBRID answer flow');

  // Step 1: Generate and execute aggregation
  var aggregationResult = await runStructured(userQuery, tableProfile, {});
  logger.info('[RAG] Aggregation returned ' + 
    (Array.isArray(aggregationResult) ? aggregationResult.length : 1) + ' results');

  // Step 2: Retrieve semantic metadata (column descriptions, etc.)
  var metadataFilter = extractMetadataFilters(userQuery);
  var metaResults = await semanticSearch(tableProfile.datasetId, userQuery, 5, metadataFilter);
  var metaBlob = null;
  
  if (metaResults && metaResults.length) {
    var maxDocs = 4;
    var maxChars = 600;
    metaBlob = {};
    metaResults.slice(0, maxDocs).forEach(function(doc, idx) {
      var t = doc.text || '';
      if (t.length > maxChars) {
        t = t.substring(0, maxChars);
      }
      metaBlob['doc_' + idx] = t;
    });
  }

  // Step 3: Determine if example rows are needed (NEW)
  var exampleRows = null;
  
  if (ENABLE_HYBRID_ROW_GROUNDING && shouldFetchExampleRows(aggregationResult)) {
    logger.info('[RAG] Fetching bounded example rows for hybrid grounding');
    
    try {
      // Fetch strategy: get latest/top rows that are relevant to the aggregation
      var fetchConfig = determineFetchStrategy(aggregationResult, tableProfile, userQuery);
      
      if (fetchConfig) {
        exampleRows = await fetchBoundedRows(fetchConfig);
        logger.info('[RAG] Fetched ' + exampleRows.length + ' example rows');
      }
    } catch (fetchError) {
      logger.warn('[RAG] Failed to fetch example rows: ' + fetchError.message);
      // Continue without example rows - explanation will be based on aggregation only
    }
  } else {
    logger.info('[RAG] Skipping example row fetch (not needed or disabled)');
  }

  // Step 4: Build explanation prompt with aggregation + rows + metadata
  var userPrompt = prompts.buildExplanationPrompt(
    aggregationResult,
    exampleRows,        // NEW: includes bounded example rows
    metaBlob,
    userQuery
  );

  // Step 5: Use Ollama llama3.2 (NOT qwen3-32b) for hybrid explanations
  // llama3.2 allows larger context and higher temperature for natural explanations
  var answer = await ollamaChatHybrid(
    [
      { role: 'system', content: prompts.HYBRID_EXPLANATION_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    parseFloat(process.env.OLLAMA_EXPLANATION_TEMPERATURE || '0.35'),
    1024
  );

  return {
    route: QueryType.HYBRID,
    aggregationResult: aggregationResult,
    exampleRows: exampleRows,  // NEW: include in response for debugging
    answer: answer,
    retrievedMetadata: metaResults ? metaResults.length : 0,
    contextChunks: metaBlob ? Object.keys(metaBlob).length : 0
  };
}

/**
 * Determine the best fetch strategy for example rows based on aggregation result.
 * 
 * Decision logic:
 * - If aggregation is a count by group → fetch 1-2 rows per top group
 * - If aggregation has numeric results → fetch rows with extreme values
 * - If aggregation is empty → fetch latest rows to show what data looks like
 * - Default: fetch latest rows
 * 
 * @param {Array|Object} aggregationResult - MongoDB aggregation output
 * @param {Object} tableProfile - Table metadata
 * @param {string} userQuery - Original query
 * @returns {Object|null} - Fetch configuration or null if no rows needed
 */
function determineFetchStrategy(aggregationResult, tableProfile, userQuery) {
  var columns = (tableProfile.columns || []).map(function(c) { return c.name; });
  
  if (!columns.length) {
    logger.warn('[RAG] No columns available for row fetching');
    return null;
  }

  // Default: fetch latest rows with all available fields (up to first 10 columns)
  var fieldsToFetch = columns.slice(0, 10);
  
  // Try to find a timestamp/date field for sorting
  var sortField = null;
  var sortOrder = -1; // Descending (latest first)
  
  for (var i = 0; i < columns.length; i++) {
    var col = columns[i].toLowerCase();
    if (col.indexOf('date') !== -1 || 
        col.indexOf('time') !== -1 || 
        col.indexOf('created') !== -1 ||
        col.indexOf('updated') !== -1) {
      sortField = columns[i];
      break;
    }
  }
  
  // If no timestamp field, use _id (MongoDB default)
  if (!sortField) {
    sortField = '_id';
  }

  // Strategy 1: Grouped aggregation results
  if (Array.isArray(aggregationResult) && 
      aggregationResult.length > 0 && 
      aggregationResult[0]._id !== undefined &&
      aggregationResult[0]._id !== null) {
    
    logger.info('[RAG] Detected grouped aggregation, fetching sample by group');
    
    // Get the top group's _id value
    var topGroupId = aggregationResult[0]._id;
    
    return {
      datasetId: tableProfile.datasetId,
      tableName: tableProfile.tableName,
      fetchType: FetchType.FILTERED,
      fields: fieldsToFetch,
      sortField: sortField,
      sortOrder: sortOrder,
      filter: {}, // Could filter by group if we knew the field name
      maxRows: 5,
      reason: 'Hybrid grounding: example rows for grouped aggregation result'
    };
  }

  // Strategy 2: Empty results - fetch sample to show data structure
  if (Array.isArray(aggregationResult) && aggregationResult.length === 0) {
    logger.info('[RAG] Empty aggregation, fetching sample rows');
    
    return {
      datasetId: tableProfile.datasetId,
      tableName: tableProfile.tableName,
      fetchType: FetchType.LATEST,
      fields: fieldsToFetch,
      sortField: sortField,
      sortOrder: sortOrder,
      filter: {},
      maxRows: 5,
      reason: 'Hybrid grounding: sample rows for empty aggregation result'
    };
  }

  // Strategy 3: Default - fetch latest rows
  logger.info('[RAG] Using default strategy: fetch latest rows');
  
  return {
    datasetId: tableProfile.datasetId,
    tableName: tableProfile.tableName,
    fetchType: FetchType.LATEST,
    fields: fieldsToFetch,
    sortField: sortField,
    sortOrder: sortOrder,
    filter: {},
    maxRows: 5,
    reason: 'Hybrid grounding: latest example rows to support aggregation explanation'
  };
}

/**
 * Main pipeline entrypoint with comprehensive logging.
 * 
 * @param {Object} tableProfile
 * @param {string} userQuery
 * @returns {Promise<Object>}
 */
async function run(tableProfile, userQuery) {
  const { createLogger } = require('./rag.logger');
  const ragLogger = createLogger();

  try {
    logger.info('[Pipeline] Starting pipeline execution');
    logger.info('[Pipeline] Query: ' + userQuery);
    logger.info('[Pipeline] Dataset: ' + tableProfile.datasetId);
    logger.info('[Pipeline] Columns available: ' + (tableProfile.columns ? tableProfile.columns.length : 0));
    
    // Stage 1: Routing
    ragLogger.startStage('routing');
    var routerDecision = await routeQuery(userQuery);
    ragLogger.endStage('routing');

    // Router now returns structured output: {route, confidence, reason}
    var route = routerDecision.route || routerDecision; // Backward compat if router returns string
    var confidence = routerDecision.confidence || 1.0;
    var reason = routerDecision.reason || 'No reason provided';
    
    logger.info('[Pipeline] Router decision: ' + route);
    logger.info('[Pipeline] Confidence: ' + confidence);
    logger.info('[Pipeline] Reason: ' + reason);

    // Log router decision
    const routingModel = process.env.USE_GROQ_FOR_ROUTING === 'true' ? 'Groq Qwen3-32B' : 'OpenRouter ' + OPENROUTER_MODEL;
    ragLogger.logRouter(
      { route: route, confidence: confidence, reason: reason },
      routingModel
    );

    logger.info('[RAG] Pipeline route for query: ' + route + ' (confidence: ' + confidence.toFixed(2) + ')');

    var result;

    // Stage 2-N: Execute based on route
    if (route === QueryType.STRUCTURED) {
      logger.info('[Pipeline] Executing STRUCTURED path');
      logger.info('[Pipeline] Passing tableProfile with ' + tableProfile.columns.length + ' columns to structuredAnswer');
      ragLogger.startStage('structured_execution');
      result = await structuredAnswer(tableProfile, userQuery);
      ragLogger.endStage('structured_execution');
      ragLogger.logGeneration(0, 'MongoDB only (no LLM)');
    } else if (route === QueryType.SEMANTIC) {
      ragLogger.startStage('semantic_retrieval');
      ragLogger.startStage('generation');
      result = await semanticAnswer(tableProfile, userQuery);
      ragLogger.endStage('semantic_retrieval');
      ragLogger.endStage('generation');
      ragLogger.logGeneration(result.contextChunks || 0, 'OpenRouter ' + OPENROUTER_MODEL);
    } else {
      // HYBRID
      ragLogger.startStage('hybrid_execution');
      result = await hybridAnswer(tableProfile, userQuery);
      ragLogger.endStage('hybrid_execution');
      ragLogger.logGeneration(result.contextChunks || 0, 'OpenRouter ' + OPENROUTER_MODEL + ' (hybrid explanations)');
    }

    // Add request_id to result
    result.request_id = ragLogger.requestId;

    // Log summary
    ragLogger.logSummary();

    return result;
  } catch (error) {
    logger.error('[RAG] Pipeline error:', error);
    ragLogger.logSummary(); // Log even on error for debugging
    throw error;
  }
}

module.exports = {
  ingest,
  run
};


