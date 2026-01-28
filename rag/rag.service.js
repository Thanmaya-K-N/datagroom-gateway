/**
 * RAG Service - PRODUCTION GRADE
 * 
 * Refactored to use:
 * - MongoDB Atlas Vector Search (replaces ChromaDB)
 * - Metadata filtering (BEFORE vector search)
 * - Heuristic re-ranking
 * - Enhanced router with confidence scoring
 * - Comprehensive structured logging
 * - Validated aggregation pipelines
 */

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const mongoVectorStore = require('./mongodb.vector.store');
const ragPipeline = require('./pipeline');
const { indexEmbeddings } = require('./embeddings');
require('dotenv').config();

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || 'http://localhost:5001';

class RAGService {
  constructor() {
    this.embeddingServiceHealthy = false;
    this.checkEmbeddingServiceHealth();
  }

  /**
   * Extract rich column metadata from dataset
   * Infers dtypes, computes stats, and generates descriptions
   * @param {Array<string>} columnNames 
   * @param {Array<Object>} rows 
   * @returns {Array<Object>}
   */
  _extractColumnMetadata(columnNames, rows) {
    return columnNames.map(name => {
      const values = rows.map(row => row[name]).filter(v => v !== null && v !== undefined && v !== '');
      
      // Infer data type from sample values
      let dtype = 'string';
      let isNumeric = false;
      let isDate = false;
      
      if (values.length > 0) {
        const sampleValue = values[0];
        
        if (typeof sampleValue === 'number') {
          dtype = Number.isInteger(sampleValue) ? 'integer' : 'float';
          isNumeric = true;
        } else if (typeof sampleValue === 'boolean') {
          dtype = 'boolean';
        } else if (sampleValue instanceof Date) {
          dtype = 'date';
          isDate = true;
        } else if (typeof sampleValue === 'string') {
          // Try to detect numeric strings
          const numericValues = values.filter(v => !isNaN(parseFloat(v)) && isFinite(v));
          if (numericValues.length > values.length * 0.8) {
            dtype = 'numeric_string';
            isNumeric = true;
          } else if (/^\d{4}-\d{2}-\d{2}/.test(sampleValue)) {
            dtype = 'date_string';
            isDate = true;
          } else {
            dtype = 'string';
          }
        }
      }
      
      // Compute basic statistics
      const stats = {};
      stats.total_values = rows.length;
      stats.non_null_values = values.length;
      stats.null_count = rows.length - values.length;
      stats.null_percentage = rows.length > 0 ? ((stats.null_count / rows.length) * 100).toFixed(1) + '%' : '0%';
      
      if (isNumeric && values.length > 0) {
        const numericValues = values.map(v => parseFloat(v)).filter(v => !isNaN(v));
        if (numericValues.length > 0) {
          stats.min = Math.min(...numericValues);
          stats.max = Math.max(...numericValues);
          stats.mean = (numericValues.reduce((a, b) => a + b, 0) / numericValues.length).toFixed(2);
        }
      }
      
      // Get unique values for categorical columns
      if (!isNumeric && !isDate && values.length > 0) {
        const uniqueValues = [...new Set(values)];
        stats.unique_count = uniqueValues.length;
        stats.cardinality = values.length > 0 ? (uniqueValues.length / values.length).toFixed(2) : '0';
        
        // Show sample values if cardinality is low (likely categorical)
        if (uniqueValues.length <= 10) {
          stats.sample_values = uniqueValues.slice(0, 5).join(', ');
        }
      }
      
      // Generate intelligent description based on column name and data
      let description = this._generateColumnDescription(name, dtype, stats, values);
      
      return {
        name,
        dtype,
        description,
        stats
      };
    });
  }

  /**
   * Generate an intelligent description for a column based on its name, type, and stats
   * @param {string} name 
   * @param {string} dtype 
   * @param {Object} stats 
   * @param {Array} values 
   * @returns {string}
   */
  _generateColumnDescription(name, dtype, stats, values) {
    const parts = [];
    
    // Describe the column based on its name (common patterns)
    const nameLower = name.toLowerCase();
    if (nameLower.includes('id') || nameLower === '_id') {
      parts.push('Identifier or unique key field');
    } else if (nameLower.includes('key') && !nameLower.includes('keyword')) {
      parts.push('Key identifier field for referencing records');
    } else if (nameLower.includes('name') || nameLower.includes('title')) {
      parts.push('Descriptive name or title field');
    } else if (nameLower.includes('date') || nameLower.includes('time') || nameLower.includes('timestamp')) {
      parts.push('Temporal field indicating date/time information');
    } else if (nameLower.includes('status') || nameLower.includes('state')) {
      parts.push('Status or state indicator');
    } else if (nameLower.includes('count') || nameLower === 'total') {
      parts.push('Numeric count or total value');
    } else if (nameLower.includes('priority') || nameLower.includes('severity')) {
      parts.push('Priority or severity level indicator');
    } else if (nameLower.includes('owner') || nameLower.includes('lead') || nameLower.includes('assignee')) {
      parts.push('Person responsible or assigned to this record');
    } else if (nameLower.includes('version') || nameLower.includes('release')) {
      parts.push('Version or release identifier');
    } else if (nameLower.includes('comment') || nameLower.includes('note') || nameLower.includes('description')) {
      parts.push('Text field containing comments or notes');
    } else if (nameLower.includes('team') || nameLower.includes('group')) {
      parts.push('Team or group assignment field');
    } else {
      parts.push('Data field');
    }
    
    // Add data type information
    parts.push(`(${dtype})`);
    
    // Add statistical insights
    if (stats.unique_count && stats.unique_count <= 20) {
      parts.push(`with ${stats.unique_count} unique values`);
    }
    
    if (stats.sample_values) {
      parts.push(`Examples: ${stats.sample_values}`);
    }
    
    if (stats.null_percentage && parseFloat(stats.null_percentage) > 20) {
      parts.push(`(${stats.null_percentage} null values)`);
    }
    
    return parts.join(' ');
  }

  /**
   * Get column schema from MongoDB by sampling a document
   * Uses the existing DbAbstraction singleton to reuse the main app's MongoDB connection
   * @param {string} datasetId 
   * @returns {Promise<Array<Object>>}
   */
  async getDatasetSchema(datasetId) {
    const DbAbstraction = require('../dbAbstraction');
    
    try {
      const dba = new DbAbstraction();
      await dba.connect();
      
      // Use datasetId as database name (Datagroom convention)
      const db = dba.client.db(datasetId);
      const collection = db.collection('data');

      // Sample one document to get field names
      const sample = await collection.findOne({});
      
      if (!sample) {
        logger.warn(`No documents found in ${datasetId}.data`);
        return [];
      }

      // Extract column names from sample document
      const columns = Object.keys(sample)
        .filter(key => key !== '_id') // Optionally exclude MongoDB _id
        .map(name => ({
          name,
          dtype: typeof sample[name],
          description: '',
          stats: {}
        }));

      logger.info(`[RAG Service] Found ${columns.length} columns in dataset ${datasetId}`);
      logger.info(`[RAG Service] Column names: ${columns.map(c => c.name).join(', ')}`);
      logger.info(`[RAG Service] Sample document keys: ${Object.keys(sample).join(', ')}`);
      return columns;
    } catch (error) {
      logger.error(`Error fetching schema for dataset ${datasetId}:`, error);
      return [];
    }
    // Note: Don't close the connection - it's managed by the DbAbstraction singleton
  }

  /**
   * Check if embedding service is available
   */
  async checkEmbeddingServiceHealth() {
    try {
      const response = await fetch(`${EMBEDDING_SERVICE_URL}/health`, {
        method: 'GET',
        timeout: 5000
      });
      
      if (response.ok) {
        const data = await response.json();
        this.embeddingServiceHealthy = data.model_loaded;
        logger.info(`Embedding service health check: ${this.embeddingServiceHealthy ? 'OK' : 'NOT READY'}`);
      } else {
        this.embeddingServiceHealthy = false;
        logger.warn('Embedding service health check failed');
      }
    } catch (error) {
      this.embeddingServiceHealthy = false;
      logger.warn('Embedding service not available:', error.message);
    }
  }

  /**
   * Initialize embeddings for a dataset using table/column-level summaries only.
   * Row-level embeddings are not created.
   * @param {string} datasetId 
   * @param {Object} datasetContent 
   * @returns {Promise<Object>}
   */
  async initializeEmbeddings(datasetId, datasetContent) {
    try {
      logger.info(`[PRODUCTION] Initializing metadata embeddings for dataset ${datasetId}`);

      await mongoVectorStore.initialize();

      const exists = await mongoVectorStore.hasEmbeddings(datasetId);
      if (exists) {
        logger.info(`Embeddings already exist for dataset ${datasetId}`);
        const stats = await mongoVectorStore.getDatasetStats(datasetId);
        return { 
          status: 'ready', 
          message: 'Embeddings already exist',
          chunkCount: stats.chunkCount
        };
      }

      const rows = Array.isArray(datasetContent.rows) ? datasetContent.rows : [];
      const columns = Array.isArray(datasetContent.columns) ? datasetContent.columns : [];
      const sampleRows = rows.slice(0, 5);

      // Build an ENHANCED table profile with intelligent column metadata extraction
      const tableProfile = {
        datasetId,
        tableName: 'data',
        purpose: 'Tabular dataset stored in MongoDB (Datagroom style)',
        rowCount: rows.length,
        primaryKeys: [],
        columns: this._extractColumnMetadata(columns, rows),
        sampleRows
      };

      logger.info(`[RAG Service] Enhanced table profile:`);
      logger.info(`[RAG Service]   - Columns: ${tableProfile.columns.length}`);
      logger.info(`[RAG Service]   - Sample rows: ${sampleRows.length}`);
      logger.info(`[RAG Service]   - Row count: ${rows.length}`);
      if (tableProfile.columns.length > 0) {
        logger.info(`[RAG Service]   - Sample column: ${tableProfile.columns[0].name} (${tableProfile.columns[0].dtype})`);
      }

      await indexEmbeddings(tableProfile);

      const stats = await mongoVectorStore.getDatasetStats(datasetId);

      return {
        status: 'ready',
        message: `Initialized metadata embeddings for dataset ${datasetId}`,
        chunkCount: stats.chunkCount,
        rowCount: rows.length
      };
    } catch (error) {
      logger.error(`Error initializing embeddings for dataset ${datasetId}:`, error);
      throw error;
    }
  }

  /**
   * Query the dataset using the new Mongo-native RAG pipeline.
   * STRUCTURED -> Mongo aggregation only
   * SEMANTIC  -> MongoDB Vector Search + LLM
   * HYBRID    -> Mongo aggregation + LLM explanation
   * @param {string} datasetId 
   * @param {string} question 
   * @returns {Promise<Object>}
   */
  async query(datasetId, question) {
    try {
      await mongoVectorStore.initialize();

      const exists = await mongoVectorStore.hasEmbeddings(datasetId);
      if (!exists) {
        throw new Error('Embeddings not initialized for this dataset. Please initialize first.');
      }

      logger.info(`[PRODUCTION] Processing query for dataset ${datasetId}: ${question}`);

      // Fetch actual column schema from MongoDB for field whitelist validation
      logger.info(`[RAG Service] Fetching schema for dataset ${datasetId}...`);
      const columns = await this.getDatasetSchema(datasetId);
      logger.info(`[RAG Service] Schema fetched, ${columns.length} columns retrieved`);
      
      if (columns.length === 0) {
        logger.error(`[RAG Service] ERROR: No columns retrieved from dataset ${datasetId}`);
        throw new Error('No columns found in dataset. Ensure the dataset exists and has documents.');
      }
      
      // Build a lightweight table profile for pipeline execution.
      const tableProfile = {
        datasetId,
        tableName: 'data',
        purpose: 'Tabular dataset stored in MongoDB (Datagroom style)',
        rowCount: 0,
        primaryKeys: [],
        columns: columns,
        sampleRows: []
      };

      logger.info(`[RAG Service] Table profile built:`);
      logger.info(`[RAG Service]   - datasetId: ${tableProfile.datasetId}`);
      logger.info(`[RAG Service]   - tableName: ${tableProfile.tableName}`);
      logger.info(`[RAG Service]   - columns count: ${tableProfile.columns.length}`);
      logger.info(`[RAG Service]   - columns: ${tableProfile.columns.map(c => c.name).join(', ')}`);

      const result = await ragPipeline.run(tableProfile, question);

      return {
        answer: result.answer,
        aggregationResult: result.aggregationResult || null,
        route: result.route
      };
    } catch (error) {
      logger.error(`Error processing query for dataset ${datasetId}:`, error);
      throw error;
    }
  }

  /**
   * Generate embeddings using Python microservice
   * @param {Array<string>} textChunks 
   * @param {string} datasetId 
   * @returns {Promise<Array>}
   */
  async generateEmbeddings(textChunks, datasetId) {
    try {
      logger.info(`Generating embeddings for ${textChunks.length} chunks using sentence-transformers`);

      // Check service health
      if (!this.embeddingServiceHealthy) {
        await this.checkEmbeddingServiceHealth();
        if (!this.embeddingServiceHealthy) {
          throw new Error('Embedding service is not available. Make sure Python service is running on port 5001.');
        }
      }

      // Extract text from chunks (chunks may be strings or objects with metadata)
      const texts = textChunks.map(chunk => 
        typeof chunk === 'string' ? chunk : chunk.text
      );

      // Use batch endpoint for efficiency
      const response = await fetch(`${EMBEDDING_SERVICE_URL}/embed/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          texts: texts,
          batch_size: 32
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Embedding service error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (!data.embeddings || data.embeddings.length !== textChunks.length) {
        throw new Error('Embedding service returned invalid response');
      }

      logger.info(`Successfully generated ${data.embeddings.length} embeddings (dimension: ${data.dimension})`);

      // Combine chunks with embeddings and preserve metadata from LangChain
      const chunksWithEmbeddings = textChunks.map((chunk, idx) => {
        // If chunk is string, extract from chunks array, otherwise it has metadata
        const chunkText = typeof chunk === 'string' ? chunk : chunk.text;
        const metadata = typeof chunk === 'object' && chunk.metadata ? chunk.metadata : { type: 'data' };
        
        return {
          id: uuidv4(),
          text: chunkText,
          embedding: data.embeddings[idx],
          metadata: metadata  // Preserve type: schema/columns/count/data
        };
      });

      return chunksWithEmbeddings;
    } catch (error) {
      logger.error('Error generating embeddings:', error);
      throw error;
    }
  }

  // NOTE: Previous LangChain-based row-level chunking has been retired.
  // Row-level embeddings are no longer created to keep MongoDB as the
  // single source of truth for numeric reasoning and aggregations.

  /**
   * Embed a single text using Python microservice
   * @param {string} text 
   * @returns {Promise<Array>}
   */
  async embedText(text) {
    try {
      const response = await fetch(`${EMBEDDING_SERVICE_URL}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          texts: text
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding service error: ${response.status}`);
      }

      const data = await response.json();
      return data.embeddings[0];
    } catch (error) {
      logger.error('Error embedding text:', error);
      throw error;
    }
  }

  async hasEmbeddings(datasetId) {
    try {
      await mongoVectorStore.initialize();
      return await mongoVectorStore.hasEmbeddings(datasetId);
    } catch (error) {
      logger.error(`Error checking embeddings for dataset ${datasetId}:`, error);
      return false;
    }
  }

  /**
   * Delete embeddings for a dataset
   * @param {string} datasetId 
   * @returns {Promise<boolean>}
   */
  async deleteEmbeddings(datasetId) {
    try {
      await mongoVectorStore.initialize();
      return await mongoVectorStore.deleteDataset(datasetId);
    } catch (error) {
      logger.error(`Error deleting embeddings for dataset ${datasetId}:`, error);
      throw error;
    }
  }

  /**
   * Get dataset statistics
   * @param {string} datasetId 
   * @returns {Promise<Object>}
   */
  async getDatasetStats(datasetId) {
    try {
      await mongoVectorStore.initialize();
      return await mongoVectorStore.getDatasetStats(datasetId);
    } catch (error) {
      logger.error(`Error getting stats for dataset ${datasetId}:`, error);
      throw error;
    }
  }
}

module.exports = new RAGService();
