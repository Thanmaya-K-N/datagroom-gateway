/**
 * Semantic retrieval utilities backed by MongoDB Atlas Vector Search.
 * 
 * REFACTORED from ChromaDB to MongoDB Atlas with:
 * - Metadata filtering (BEFORE vector search)
 * - Heuristic re-ranking
 * - Broad candidate retrieval
 * - Top-K selection
 * 
 * Embeddings are stored at table/column/sample granularity only; no row-level vectors.
 */

'use strict';

const fetch = require('node-fetch');
const logger = require('../logger');
const mongoVectorStore = require('./mongodb.vector.store');
const { rerank, getRetrievalConfig } = require('./reranker');

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:5001';

/**
 * Embed a single query text using the Python microservice.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedQuery(text) {
  var response = await fetch(EMBEDDING_SERVICE_URL + '/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: text }),
    timeout: 30000
  });

  if (!response.ok) {
    throw new Error('Embedding service error: ' + response.status);
  }

  var data = await response.json();
  if (!data.embeddings || !data.embeddings.length) {
    throw new Error('Embedding service returned empty embeddings');
  }
  return data.embeddings[0];
}

/**
 * Extract metadata filters from query using simple heuristics
 * 
 * Future enhancement: Use LLM to extract filters
 * Current: Simple keyword matching
 * 
 * IMPORTANT: Be conservative with doc_type filtering - most questions benefit
 * from having access to all metadata types (table, column, sample) together.
 * 
 * @param {string} query - User query
 * @returns {Object|null} - Metadata filters or null
 */
function extractMetadataFilters(query) {
  var filters = {};
  var queryLower = query.toLowerCase();

  // Product detection (simple keyword matching)
  // Customize these keywords for your domain
  if (queryLower.includes('product a') || queryLower.includes('app1')) {
    filters.product = 'app1';
  } else if (queryLower.includes('product b') || queryLower.includes('app2')) {
    filters.product = 'app2';
  }

  // Doc type detection - BE VERY CONSERVATIVE
  // Only filter to specific doc_type if the query EXPLICITLY asks for ONLY that type
  // Most questions benefit from seeing table + column + sample metadata together
  
  // ONLY filter for samples if explicitly asking for examples/samples
  if ((queryLower.includes('sample') || queryLower.includes('example')) && 
      !queryLower.includes('column') && !queryLower.includes('table')) {
    filters.doc_type = 'sample';
  }
  // ONLY filter for table if explicitly asking ONLY about table-level info
  else if (queryLower.includes('table info') || queryLower.includes('dataset purpose')) {
    filters.doc_type = 'table';
  }
  // DO NOT filter by doc_type for column questions - we want table + column + sample context!
  // This was the bug causing poor results - filtering to only 'column' docs lost valuable context

  // Version detection
  var versionMatch = queryLower.match(/version\s+(\d+\.\d+|\d+)/);
  if (versionMatch) {
    filters.version = versionMatch[1];
  }

  // Language detection
  if (queryLower.includes('spanish') || queryLower.includes('español')) {
    filters.language = 'es';
  } else if (queryLower.includes('french') || queryLower.includes('français')) {
    filters.language = 'fr';
  }
  // Default: no language filter (returns all languages)

  // Return null if no filters detected
  return Object.keys(filters).length > 0 ? filters : null;
}

/**
 * Semantic retrieval with MongoDB Atlas Vector Search + re-ranking
 * 
 * Flow:
 * 1. Extract metadata filters from query
 * 2. Embed query
 * 3. Retrieve broad candidate set (numCandidates: 100-200)
 * 4. Get initial results (limit: ~30)
 * 5. Apply heuristic re-ranking
 * 6. Return top-K (default: 8)
 * 
 * @param {string} datasetId - Dataset identifier
 * @param {string} query - User query
 * @param {number} topK - Final number of results (default: 8)
 * @param {Object|null} explicitFilters - Explicitly provided filters (overrides extraction)
 * @returns {Promise<Array<{text:string, score:number, metadata:Object, final_score:number}>>}
 */
async function semanticSearch(datasetId, query, topK, explicitFilters) {
  var k = topK || 8;

  logger.info('[RAG Retrievers] ═══════════════════════════════════════════════════════════════');
  logger.info('[RAG Retrievers] SEMANTIC SEARCH REQUEST');
  logger.info('[RAG Retrievers] ═══════════════════════════════════════════════════════════════');
  logger.info('[RAG Retrievers] Dataset ID: ' + datasetId);
  logger.info('[RAG Retrievers] Query: ' + query);
  logger.info('[RAG Retrievers] Requested top-K: ' + k);
  logger.info('[RAG Retrievers] Explicit filters provided: ' + (explicitFilters ? 'YES' : 'NO'));

  // Step 1: Extract metadata filters (unless explicitly provided)
  var metadataFilter = explicitFilters || extractMetadataFilters(query);
  
  logger.info('[RAG Retrievers] ───────────────────────────────────────────────────────────────');
  logger.info('[RAG Retrievers] STEP 1: Metadata Filter Extraction');
  if (metadataFilter) {
    logger.info('[RAG Retrievers] ✓ Extracted metadata filters: ' + JSON.stringify(metadataFilter));
    Object.keys(metadataFilter).forEach(key => {
      logger.info('[RAG Retrievers]   - ' + key + ': ' + metadataFilter[key]);
    });
  } else {
    logger.info('[RAG Retrievers] ℹ No metadata filters extracted (will search all documents)');
  }

  // Step 2: Get retrieval configuration
  var config = getRetrievalConfig(k);
  logger.info('[RAG Retrievers] ───────────────────────────────────────────────────────────────');
  logger.info('[RAG Retrievers] STEP 2: Retrieval Configuration');
  logger.info('[RAG Retrievers] ✓ Candidates to scan: ' + config.numCandidates);
  logger.info('[RAG Retrievers] ✓ Initial results limit: ' + config.initialLimit);
  logger.info('[RAG Retrievers] ✓ Final top-K: ' + k);

  // Step 3: Embed query
  logger.info('[RAG Retrievers] ───────────────────────────────────────────────────────────────');
  logger.info('[RAG Retrievers] STEP 3: Query Embedding');
  logger.info('[RAG Retrievers] Calling embedding service at: ' + EMBEDDING_SERVICE_URL);
  
  var embeddingStartTime = Date.now();
  var embedding = await embedQuery(query);
  var embeddingTime = Date.now() - embeddingStartTime;
  
  logger.info('[RAG Retrievers] ✓ Query embedded successfully');
  logger.info('[RAG Retrievers] ✓ Embedding dimensions: ' + embedding.length);
  logger.info('[RAG Retrievers] ✓ Embedding time: ' + embeddingTime + 'ms');
  logger.info('[RAG Retrievers] ✓ Embedding sample (first 5 values): [' + 
    embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ') + ', ...]');

  // Step 4: Vector search with metadata filtering
  logger.info('[RAG Retrievers] ───────────────────────────────────────────────────────────────');
  logger.info('[RAG Retrievers] STEP 4: Vector Search');
  logger.info('[RAG Retrievers] Calling MongoDB Vector Store...');
  logger.info('[RAG Retrievers] Parameters:');
  logger.info('[RAG Retrievers]   - datasetId: ' + datasetId);
  logger.info('[RAG Retrievers]   - numCandidates: ' + config.numCandidates);
  logger.info('[RAG Retrievers]   - initialLimit: ' + config.initialLimit);
  logger.info('[RAG Retrievers]   - metadataFilter: ' + JSON.stringify(metadataFilter));
  
  var searchStartTime = Date.now();
  var results = await mongoVectorStore.vectorSearch(
    datasetId, 
    embedding, 
    config.initialLimit,  // Get more candidates than final topK
    metadataFilter,       // CRITICAL: Applied BEFORE similarity search
    config.numCandidates  // Broad candidate pool for better recall
  );
  var searchTime = Date.now() - searchStartTime;

  logger.info('[RAG Retrievers] ✓ Vector search completed in ' + searchTime + 'ms');
  logger.info('[RAG Retrievers] ✓ Raw results returned: ' + results.length + ' documents');

  if (results.length === 0) {
    logger.warn('[RAG Retrievers] ⚠ WARNING: No results from vector search');
    logger.warn('[RAG Retrievers] ⚠ Possible causes:');
    logger.warn('[RAG Retrievers]   1. No embeddings in database for dataset: ' + datasetId);
    logger.warn('[RAG Retrievers]   2. Metadata filters too restrictive');
    logger.warn('[RAG Retrievers]   3. Vector index not created in MongoDB Atlas');
    logger.warn('[RAG Retrievers]   4. Query embedding dimension mismatch');
    logger.info('[RAG Retrievers] ═══════════════════════════════════════════════════════════════');
    return [];
  }

  logger.info('[RAG Retrievers] ✓ Results score range: ' + 
    Math.min(...results.map(r => r.score)).toFixed(4) + ' - ' + 
    Math.max(...results.map(r => r.score)).toFixed(4));

  // Step 5: Heuristic re-ranking
  logger.info('[RAG Retrievers] ───────────────────────────────────────────────────────────────');
  logger.info('[RAG Retrievers] STEP 5: Re-ranking');
  logger.info('[RAG Retrievers] Applying heuristic re-ranking to ' + results.length + ' results...');
  
  var rerankStartTime = Date.now();
  var reranked = rerank(results, query, k);
  var rerankTime = Date.now() - rerankStartTime;
  
  logger.info('[RAG Retrievers] ✓ Re-ranking complete in ' + rerankTime + 'ms');
  logger.info('[RAG Retrievers] ✓ Final top-' + k + ' chunks selected: ' + reranked.length + ' documents');
  
  if (reranked.length > 0) {
    logger.info('[RAG Retrievers] ✓ Final score range: ' + 
      Math.min(...reranked.map(r => r.final_score || r.score)).toFixed(4) + ' - ' + 
      Math.max(...reranked.map(r => r.final_score || r.score)).toFixed(4));
    logger.info('[RAG Retrievers] ✓ Top result preview: ' + 
      reranked[0].text.substring(0, 100).replace(/\n/g, ' ') + '...');
  }
  
  logger.info('[RAG Retrievers] ═══════════════════════════════════════════════════════════════');
  logger.info('[RAG Retrievers] SEARCH COMPLETE');
  logger.info('[RAG Retrievers] Total time: ' + (embeddingTime + searchTime + rerankTime) + 'ms');
  logger.info('[RAG Retrievers] ═══════════════════════════════════════════════════════════════');

  return reranked;
}

module.exports = {
  semanticSearch,
  embedQuery,
  extractMetadataFilters
};



