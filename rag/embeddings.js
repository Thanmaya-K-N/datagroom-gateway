/**
 * Embedding generation restricted to table-level, column-level, and optional sample rows.
 * Row-level embeddings of full datasets are explicitly disallowed.
 * 
 * REFACTORED: Uses MongoDB Atlas Vector Search instead of ChromaDB
 */

'use strict';

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const mongoVectorStore = require('./mongodb.vector.store');

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:5001';

/**
 * Build the text to embed for the table-level document.
 * @param {Object} tableProfile
 * @returns {string}
 */
function buildTableText(tableProfile) {
  var parts = [];
  parts.push('Table: ' + tableProfile.tableName);
  parts.push('Purpose: ' + (tableProfile.purpose || ''));
  parts.push('Row count: ' + (tableProfile.rowCount || 0));
  parts.push('Primary keys: ' + (Array.isArray(tableProfile.primaryKeys) && tableProfile.primaryKeys.length
    ? tableProfile.primaryKeys.join(', ')
    : 'none'));
  return parts.join('\n');
}

/**
 * Build the text to embed for a column-level document.
 * @param {Object} column
 * @param {string} tableName
 * @returns {string}
 */
function buildColumnText(column, tableName) {
  var statsParts = [];
  if (column.stats) {
    Object.keys(column.stats).forEach(function (k) {
      statsParts.push(k + '=' + column.stats[k]);
    });
  }
  if (!statsParts.length) {
    statsParts.push('no stats');
  }
  var statsText = statsParts.join(', ');

  return [
    'Table: ' + tableName,
    'Column: ' + column.name,
    'Type: ' + (column.dtype || column.type || 'unknown'),
    'Description: ' + (column.description || ''),
    'Stats: ' + statsText
  ].join('\n');
}

/**
 * Build text for a clearly labeled sample row (never used for numeric reasoning).
 * @param {Object} row
 * @param {string} tableName
 * @param {number} index
 * @returns {string}
 */
function buildSampleRowText(row, tableName, index) {
  var lines = [];
  lines.push('SAMPLE ROW ' + (index + 1) + ' from table ' + tableName);
  Object.keys(row).forEach(function (key) {
    lines.push(key + ': ' + row[key]);
  });
  return lines.join('\n');
}

/**
 * Call Python embedding microservice for a batch of texts.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts) {
  if (!texts || !texts.length) {
    return [];
  }

  var response = await fetch(EMBEDDING_SERVICE_URL + '/embed/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: texts, batch_size: 32 }),
    timeout: 60000
  });

  if (!response.ok) {
    var errorText = await response.text();
    throw new Error('Embedding service error: ' + response.status + ' - ' + errorText);
  }

  var data = await response.json();
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error('Embedding service returned invalid response');
  }
  return data.embeddings;
}

/**
 * Build the logical embedding "documents" for a table profile.
 * @param {Object} tableProfile
 * @returns {{id:string, text:string, metadata:Object}[]}
 */
function buildEmbeddingDocs(tableProfile) {
  var docs = [];

  // Table-level document
  docs.push({
    id: uuidv4(),
    text: buildTableText(tableProfile),
    metadata: {
      dataset_id: tableProfile.datasetId,
      table_name: tableProfile.tableName,
      column_name: null,
      doc_type: 'table',  // Changed from embedding_type
      product: tableProfile.datasetId,  // Use datasetId as product
      version: '1.0',
      language: 'en',
      confidence: 0.9,  // High confidence for table metadata
      source: 'table_profile'
    }
  });

  // Column-level documents
  (tableProfile.columns || []).forEach(function (col) {
    docs.push({
      id: uuidv4(),
      text: buildColumnText(col, tableProfile.tableName),
      metadata: {
        dataset_id: tableProfile.datasetId,
        table_name: tableProfile.tableName,
        column_name: col.name,
        doc_type: 'column',
        product: tableProfile.datasetId,
        version: '1.0',
        language: 'en',
        confidence: 0.85,  // High confidence for column metadata
        source: 'column_schema'
      }
    });
  });

  // Optional sample rows (strict max 5)
  var sampleRows = (tableProfile.sampleRows || []).slice(0, 5);
  sampleRows.forEach(function (row, idx) {
    docs.push({
      id: uuidv4(),
      text: buildSampleRowText(row, tableProfile.tableName, idx),
      metadata: {
        dataset_id: tableProfile.datasetId,
        table_name: tableProfile.tableName,
        column_name: null,
        doc_type: 'sample',
        product: tableProfile.datasetId,
        version: '1.0',
        language: 'en',
        confidence: 0.7,  // Lower confidence for samples
        source: 'sample_row'
      }
    });
  });

  return docs;
}

/**
 * Index embeddings for a table profile into MongoDB Atlas Vector Search.
 * 
 * @param {Object} tableProfile
 *  {
 *    datasetId: string,
 *    tableName: string,
 *    purpose: string,
 *    rowCount: number,
 *    primaryKeys: string[],
 *    columns: [{ name, dtype, description, stats }],
 *    sampleRows?: [ {...}, ... ]  // at most 5
 *  }
 */
async function indexEmbeddings(tableProfile) {
  logger.info('[RAG Embeddings] ═══════════════════════════════════════════════════════════');
  logger.info('[RAG Embeddings] INDEXING EMBEDDINGS');
  logger.info('[RAG Embeddings] ═══════════════════════════════════════════════════════════');
  logger.info('[RAG Embeddings] Dataset ID: ' + tableProfile.datasetId);
  logger.info('[RAG Embeddings] Table name: ' + tableProfile.tableName);
  logger.info('[RAG Embeddings] Row count: ' + (tableProfile.rowCount || 0));
  logger.info('[RAG Embeddings] Columns: ' + (tableProfile.columns ? tableProfile.columns.length : 0));

  logger.info('[RAG Embeddings] ───────────────────────────────────────────────────────────');
  logger.info('[RAG Embeddings] STEP 1: Building embedding documents');
  
  var docs = buildEmbeddingDocs(tableProfile);
  
  logger.info('[RAG Embeddings] ✓ Built ' + docs.length + ' embedding documents');
  
  // Count document types
  var docTypeCounts = {};
  docs.forEach(function(d) {
    var type = d.metadata.doc_type || 'unknown';
    docTypeCounts[type] = (docTypeCounts[type] || 0) + 1;
  });
  
  logger.info('[RAG Embeddings] Document breakdown:');
  Object.keys(docTypeCounts).forEach(function(type) {
    logger.info('[RAG Embeddings]   - ' + type + ': ' + docTypeCounts[type]);
  });

  logger.info('[RAG Embeddings] ───────────────────────────────────────────────────────────');
  logger.info('[RAG Embeddings] STEP 2: Generating embeddings');
  logger.info('[RAG Embeddings] Calling embedding service at: ' + EMBEDDING_SERVICE_URL);
  logger.info('[RAG Embeddings] Texts to embed: ' + docs.length);
  
  var texts = docs.map(function (d) { return d.text; });
  
  // Log sample text
  if (texts.length > 0) {
    logger.info('[RAG Embeddings] Sample text (first 100 chars): ' + 
      texts[0].substring(0, 100).replace(/\n/g, ' ') + '...');
  }
  
  var embeddingStartTime = Date.now();
  var embeddings = await embedBatch(texts);
  var embeddingTime = Date.now() - embeddingStartTime;
  
  logger.info('[RAG Embeddings] ✓ Embeddings generated in ' + embeddingTime + 'ms');
  logger.info('[RAG Embeddings] ✓ Embeddings count: ' + embeddings.length);
  
  if (embeddings.length > 0) {
    logger.info('[RAG Embeddings] ✓ Embedding dimensions: ' + embeddings[0].length);
    logger.info('[RAG Embeddings] ✓ Sample embedding (first 5 values): [' + 
      embeddings[0].slice(0, 5).map(function(v) { return v.toFixed(4); }).join(', ') + ', ...]');
  }

  logger.info('[RAG Embeddings] ───────────────────────────────────────────────────────────');
  logger.info('[RAG Embeddings] STEP 3: Storing in MongoDB Atlas');
  
  var chunks = docs.map(function (doc, idx) {
    return {
      id: doc.id,
      text: doc.text,
      embedding: embeddings[idx],
      metadata: doc.metadata
    };
  });

  logger.info('[RAG Embeddings] Chunks prepared: ' + chunks.length);
  logger.info('[RAG Embeddings] Calling MongoDB Vector Store...');
  
  var storeStartTime = Date.now();
  await mongoVectorStore.storeEmbeddings(tableProfile.datasetId, chunks);
  var storeTime = Date.now() - storeStartTime;
  
  logger.info('[RAG Embeddings] ✓ Embeddings stored in ' + storeTime + 'ms');
  logger.info('[RAG Embeddings] ═══════════════════════════════════════════════════════════');
  logger.info('[RAG Embeddings] INDEXING COMPLETE');
  logger.info('[RAG Embeddings] Total time: ' + (embeddingTime + storeTime) + 'ms');
  logger.info('[RAG Embeddings] ═══════════════════════════════════════════════════════════');
}

module.exports = {
  indexEmbeddings,
  buildEmbeddingDocs
};


