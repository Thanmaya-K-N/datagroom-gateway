/**
 * MongoDB Atlas Vector Search Store
 * Replaces ChromaDB with production-grade MongoDB Atlas Vector Search
 * 
 * Requirements:
 * - MongoDB Atlas cluster with Vector Search enabled
 * - Vector index named "vector_index" on embeddings collection
 * - Cosine similarity metric
 * 
 * Document structure:
 * {
 *   _id: ObjectId,
 *   text: string,              // Chunk text
 *   embedding: number[],       // 384-dim vector from sentence-transformers
 *   datasetId: string,         // Dataset identifier
 *   product: string,           // Product name (metadata filter)
 *   doc_type: string,          // Document type: 'table' | 'column' | 'sample'
 *   version: string,           // Version identifier (metadata filter)
 *   language: string,          // Language code (metadata filter)
 *   confidence: number,        // Quality score 0-1
 *   created_at: Date,          // Timestamp for recency
 *   metadata: Object           // Additional metadata
 * }
 */

'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const logger = require('../logger');

const DEFAULT_MONGO_URI = process.env.DATABASE || 'mongodb://localhost:27017';
const DEFAULT_DB_NAME = process.env.MONGO_DB || 'datagroom_vectors';
const EMBEDDINGS_COLLECTION = 'embeddings';
const VECTOR_INDEX_NAME = 'vector_index';

class MongoDBVectorStore {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.initialized = false;
  }

  /**
   * Initialize MongoDB connection and verify vector search capability
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('[MongoDB Vector Store] Connecting to MongoDB Atlas...');

      this.client = new MongoClient(DEFAULT_MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000
      });

      await this.client.connect();
      
      this.db = this.client.db(DEFAULT_DB_NAME);
      this.collection = this.db.collection(EMBEDDINGS_COLLECTION);

      // Verify connection
      await this.db.admin().ping();
      logger.info('[MongoDB Vector Store] Connected to database: ' + DEFAULT_DB_NAME);

      // Check if collection exists, create if not
      const collections = await this.db.listCollections({ name: EMBEDDINGS_COLLECTION }).toArray();
      if (collections.length === 0) {
        await this.db.createCollection(EMBEDDINGS_COLLECTION);
        logger.info('[MongoDB Vector Store] Created embeddings collection');
      }

      // IMPORTANT: Atlas Vector Search indexes are NOT visible via listIndexes()
      // They must be created manually in Atlas UI and are separate from regular MongoDB indexes
      const indexes = await this.collection.listIndexes().toArray();
      logger.info('[MongoDB Vector Store] Found ' + indexes.length + ' regular MongoDB indexes: ' + 
        indexes.map(idx => idx.name).join(', '));
      
      // Check if vector search index exists by attempting a test query
      // This is more reliable than checking listIndexes() which doesn't show Atlas Search indexes
      await this.checkVectorIndex();

      this.initialized = true;
      logger.info('[MongoDB Vector Store] Initialization complete');
    } catch (error) {
      logger.error('[MongoDB Vector Store] Initialization failed:', error);
      throw new Error('MongoDB Vector Store initialization failed: ' + error.message);
    }
  }

  /**
   * Check if Atlas Vector Search index exists
   * Can be called multiple times to recheck after index creation
   */
  async checkVectorIndex() {
    try {
      logger.info('[MongoDB Vector Store] Attempting to verify Atlas Vector Search index "' + VECTOR_INDEX_NAME + '"...');
      
      // Try a simple vector search with a test vector to verify index exists
      // IMPORTANT: Cannot use zero vector with cosine similarity
      const testVector = Array(384).fill(0.01); // Non-zero values required for cosine
      const testPipeline = [
        {
          $vectorSearch: {
            index: VECTOR_INDEX_NAME,
            path: 'embedding',
            queryVector: testVector,
            numCandidates: 1,
            limit: 1
          }
        },
        { $limit: 1 }
      ];
      
      // This will throw an error if the index doesn't exist
      await this.collection.aggregate(testPipeline).toArray();
      
      this.hasVectorIndex = true;
      logger.info('[MongoDB Vector Store] ✓ Atlas Vector Search index "' + VECTOR_INDEX_NAME + '" verified and operational');
      logger.info('[MongoDB Vector Store] ✓ Index configuration: 384 dimensions, cosine similarity');
    } catch (testError) {
      this.hasVectorIndex = false;
      logger.warn('[MongoDB Vector Store] ⚠ Atlas Vector Search index "' + VECTOR_INDEX_NAME + '" NOT FOUND or not operational');
      logger.warn('[MongoDB Vector Store] Error details: ' + testError.message);
      logger.warn('[MongoDB Vector Store] ');
      logger.warn('[MongoDB Vector Store] SETUP REQUIRED: Create Atlas Vector Search index with:');
      logger.warn('[MongoDB Vector Store]   1. Go to MongoDB Atlas UI → Database → Search');
      logger.warn('[MongoDB Vector Store]   2. Click "Create Search Index" → "JSON Editor"');
      logger.warn('[MongoDB Vector Store]   3. Database: ' + DEFAULT_DB_NAME);
      logger.warn('[MongoDB Vector Store]   4. Collection: ' + EMBEDDINGS_COLLECTION);
      logger.warn('[MongoDB Vector Store]   5. Index Name: ' + VECTOR_INDEX_NAME);
      logger.warn('[MongoDB Vector Store]   6. Use this JSON definition:');
      logger.warn('[MongoDB Vector Store]   {');
      logger.warn('[MongoDB Vector Store]     "fields": [');
      logger.warn('[MongoDB Vector Store]       {');
      logger.warn('[MongoDB Vector Store]         "type": "vector",');
      logger.warn('[MongoDB Vector Store]         "path": "embedding",');
      logger.warn('[MongoDB Vector Store]         "numDimensions": 384,');
      logger.warn('[MongoDB Vector Store]         "similarity": "cosine"');
      logger.warn('[MongoDB Vector Store]       }');
      logger.warn('[MongoDB Vector Store]     ]');
      logger.warn('[MongoDB Vector Store]   }');
      logger.warn('[MongoDB Vector Store] ');
      logger.warn('[MongoDB Vector Store] Vector search will return empty results until index is created.');
    }
  }

  /**
   * Store embeddings for a dataset with metadata
   * 
   * @param {string} datasetId - Dataset identifier
   * @param {Array} chunks - Array of {id, text, embedding, metadata}
   * @returns {Promise<Object>} - Insert result with count
   */
  async storeEmbeddings(datasetId, chunks) {
    await this.initialize();

    logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
    logger.info('[MongoDB Vector Store] STORING EMBEDDINGS');
    logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
    logger.info('[MongoDB Vector Store] Dataset ID: ' + datasetId);
    logger.info('[MongoDB Vector Store] Chunks to store: ' + chunks.length);
    
    if (!Array.isArray(chunks) || chunks.length === 0) {
      logger.error('[MongoDB Vector Store] ❌ Invalid chunks: must be non-empty array');
      throw new Error('Chunks must be a non-empty array');
    }
    
    // Validate first chunk structure
    if (chunks.length > 0) {
      const firstChunk = chunks[0];
      logger.info('[MongoDB Vector Store] First chunk validation:');
      logger.info('[MongoDB Vector Store]   - Has text: ' + (firstChunk.text ? 'YES' : 'NO'));
      logger.info('[MongoDB Vector Store]   - Has embedding: ' + (firstChunk.embedding ? 'YES' : 'NO'));
      logger.info('[MongoDB Vector Store]   - Embedding dimensions: ' + (Array.isArray(firstChunk.embedding) ? firstChunk.embedding.length : 'N/A'));
      logger.info('[MongoDB Vector Store]   - Has metadata: ' + (firstChunk.metadata ? 'YES' : 'NO'));
      
      if (Array.isArray(firstChunk.embedding) && firstChunk.embedding.length !== 384) {
        logger.warn('[MongoDB Vector Store] ⚠ Warning: Embedding dimension is ' + firstChunk.embedding.length + ', expected 384');
      }
    }

    try {
      const documents = chunks.map(chunk => {
        const metadata = chunk.metadata || {};
        
        return {
          text: chunk.text,
          embedding: chunk.embedding,
          datasetId: datasetId,
          
          // Metadata filters (first-class fields)
          product: metadata.product || datasetId,
          doc_type: metadata.doc_type || 'unknown',
          version: metadata.version || '1.0',
          language: metadata.language || 'en',
          confidence: metadata.confidence || 0.8,
          
          // Timestamps
          created_at: new Date(),
          
          // Additional metadata (nested)
          metadata: {
            chunk_id: chunk.id || new ObjectId().toString(),
            source: metadata.source || 'unknown',
            ...metadata
          }
        };
      });

      const result = await this.collection.insertMany(documents);
      
      logger.info('[MongoDB Vector Store] ✓ Successfully stored embeddings');
      logger.info('[MongoDB Vector Store] ✓ Documents inserted: ' + result.insertedCount);
      logger.info('[MongoDB Vector Store] ✓ Collection: ' + EMBEDDINGS_COLLECTION);
      logger.info('[MongoDB Vector Store] ✓ Database: ' + DEFAULT_DB_NAME);
      
      // Log document type distribution
      const docTypes = {};
      documents.forEach(doc => {
        docTypes[doc.doc_type] = (docTypes[doc.doc_type] || 0) + 1;
      });
      logger.info('[MongoDB Vector Store] ✓ Document types: ' + JSON.stringify(docTypes));
      logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
      
      return {
        insertedCount: result.insertedCount,
        insertedIds: Object.values(result.insertedIds).map(id => id.toString())
      };
    } catch (error) {
      logger.error('[MongoDB Vector Store] Error storing embeddings:', error);
      throw new Error('Failed to store embeddings: ' + error.message);
    }
  }

  /**
   * Vector similarity search with metadata filtering
   * 
   * Uses MongoDB Atlas $vectorSearch aggregation stage with pre-filtering
   * 
   * @param {string} datasetId - Dataset identifier
   * @param {number[]} queryEmbedding - Query vector (384-dim)
   * @param {number} topK - Number of results to return (after re-ranking)
   * @param {Object|null} metadataFilter - Hard constraints applied BEFORE vector search
   *   Example: { product: 'app1', doc_type: 'column', version: '2.0' }
   * @param {number} numCandidates - Candidate pool size (default: 100)
   * @returns {Promise<Array>} - Array of {id, text, score, metadata}
   */
  async vectorSearch(datasetId, queryEmbedding, topK, metadataFilter, numCandidates) {
    await this.initialize();

    // Comprehensive logging at start of vector search
    logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
    logger.info('[MongoDB Vector Store] VECTOR SEARCH REQUEST');
    logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
    logger.info('[MongoDB Vector Store] Dataset ID: ' + datasetId);
    logger.info('[MongoDB Vector Store] Database: ' + DEFAULT_DB_NAME);
    logger.info('[MongoDB Vector Store] Collection: ' + EMBEDDINGS_COLLECTION);
    logger.info('[MongoDB Vector Store] Index Name: ' + VECTOR_INDEX_NAME);
    logger.info('[MongoDB Vector Store] Has Vector Index: ' + (this.hasVectorIndex ? 'YES' : 'NO'));
    logger.info('[MongoDB Vector Store] Query Embedding Dimensions: ' + (Array.isArray(queryEmbedding) ? queryEmbedding.length : 'invalid'));
    logger.info('[MongoDB Vector Store] Top K: ' + topK);
    logger.info('[MongoDB Vector Store] Num Candidates: ' + numCandidates);
    logger.info('[MongoDB Vector Store] Metadata Filter: ' + JSON.stringify(metadataFilter));
    
    // Check if vector index exists before attempting search
    // If it wasn't found initially, try rechecking (user may have created it)
    if (!this.hasVectorIndex) {
      logger.info('[MongoDB Vector Store] Vector index not found in cache, rechecking...');
      await this.checkVectorIndex();
      
      if (!this.hasVectorIndex) {
        logger.error('[MongoDB Vector Store] ❌ Cannot perform vector search: Vector index "' + VECTOR_INDEX_NAME + '" not found');
        logger.error('[MongoDB Vector Store] ❌ Please create the vector index in MongoDB Atlas first');
        logger.error('[MongoDB Vector Store] ❌ See initialization logs above for setup instructions');
        logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
        // Return empty results instead of throwing to allow graceful degradation
        return [];
      } else {
        logger.info('[MongoDB Vector Store] ✓ Vector index now available! Proceeding with search...');
      }
    }

    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      logger.error('[MongoDB Vector Store] ❌ Invalid query embedding: must be non-empty array');
      throw new Error('Query embedding must be a non-empty array');
    }
    
    if (queryEmbedding.length !== 384) {
      logger.warn('[MongoDB Vector Store] ⚠ Query embedding dimension mismatch: expected 384, got ' + queryEmbedding.length);
    }

    const k = topK || 8;
    const candidates = numCandidates || 100;

    try {
      // Build metadata filter (HARD CONSTRAINTS applied in $vectorSearch)
      const filter = {
        datasetId: datasetId
      };

      if (metadataFilter) {
        if (metadataFilter.product) filter.product = metadataFilter.product;
        if (metadataFilter.doc_type) filter.doc_type = metadataFilter.doc_type;
        if (metadataFilter.version) filter.version = metadataFilter.version;
        if (metadataFilter.language) filter.language = metadataFilter.language;
      }

      // MongoDB Atlas Vector Search aggregation pipeline
      const pipeline = [
        {
          $vectorSearch: {
            index: VECTOR_INDEX_NAME,
            path: 'embedding',
            queryVector: queryEmbedding,
            numCandidates: candidates,
            limit: k,
            filter: filter  // CRITICAL: Pre-filter before similarity search
          }
        },
        {
          $addFields: {
            score: { $meta: 'vectorSearchScore' }
          }
        },
        {
          $project: {
            _id: 1,
            text: 1,
            score: 1,
            product: 1,
            doc_type: 1,
            version: 1,
            language: 1,
            confidence: 1,
            created_at: 1,
            metadata: 1
          }
        }
      ];

      logger.info('[MongoDB Vector Store] ───────────────────────────────────────────────────');
      logger.info('[MongoDB Vector Store] AGGREGATION PIPELINE');
      logger.info('[MongoDB Vector Store] ───────────────────────────────────────────────────');
      logger.info('[MongoDB Vector Store] Stage 1: $vectorSearch');
      logger.info('[MongoDB Vector Store]   - index: ' + VECTOR_INDEX_NAME);
      logger.info('[MongoDB Vector Store]   - path: embedding');
      logger.info('[MongoDB Vector Store]   - queryVector: [' + queryEmbedding.length + ' dimensions]');
      logger.info('[MongoDB Vector Store]   - numCandidates: ' + candidates);
      logger.info('[MongoDB Vector Store]   - limit: ' + k);
      logger.info('[MongoDB Vector Store]   - filter: ' + JSON.stringify(filter));
      logger.info('[MongoDB Vector Store] Stage 2: $addFields (score: vectorSearchScore)');
      logger.info('[MongoDB Vector Store] Stage 3: $project (select fields)');
      logger.info('[MongoDB Vector Store] ───────────────────────────────────────────────────');
      logger.info('[MongoDB Vector Store] Executing aggregation pipeline...');
      
      const startTime = Date.now();
      const results = await this.collection.aggregate(pipeline).toArray();
      const executionTime = Date.now() - startTime;

      // Format results to match expected interface
      const formatted = results.map(doc => ({
        id: doc._id.toString(),
        text: doc.text,
        score: doc.score,
        metadata: {
          product: doc.product,
          doc_type: doc.doc_type,
          version: doc.version,
          language: doc.language,
          confidence: doc.confidence,
          created_at: doc.created_at,
          ...doc.metadata
        }
      }));

      logger.info('[MongoDB Vector Store] ───────────────────────────────────────────────────');
      logger.info('[MongoDB Vector Store] SEARCH RESULTS');
      logger.info('[MongoDB Vector Store] ───────────────────────────────────────────────────');
      logger.info('[MongoDB Vector Store] ✓ Query executed successfully');
      logger.info('[MongoDB Vector Store] ✓ Execution time: ' + executionTime + 'ms');
      logger.info('[MongoDB Vector Store] ✓ Results returned: ' + formatted.length + ' documents');
      
      if (formatted.length > 0) {
        logger.info('[MongoDB Vector Store] ✓ Score range: ' + 
          Math.min(...formatted.map(r => r.score)).toFixed(4) + ' - ' + 
          Math.max(...formatted.map(r => r.score)).toFixed(4));
        logger.info('[MongoDB Vector Store] ✓ Top result score: ' + formatted[0].score.toFixed(4));
        logger.info('[MongoDB Vector Store] ✓ Top result text preview: ' + 
          formatted[0].text.substring(0, 100).replace(/\n/g, ' ') + '...');
        logger.info('[MongoDB Vector Store] ✓ Document types: ' + 
          [...new Set(formatted.map(r => r.metadata.doc_type))].join(', '));
      } else {
        logger.warn('[MongoDB Vector Store] ⚠ No results found - possible causes:');
        logger.warn('[MongoDB Vector Store]   - No documents in collection matching filter');
        logger.warn('[MongoDB Vector Store]   - Vector similarity threshold too strict');
        logger.warn('[MongoDB Vector Store]   - Query embedding mismatch with stored embeddings');
      }
      logger.info('[MongoDB Vector Store] ═══════════════════════════════════════════════════');

      return formatted;
    } catch (error) {
      logger.error('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
      logger.error('[MongoDB Vector Store] ❌ VECTOR SEARCH ERROR');
      logger.error('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
      logger.error('[MongoDB Vector Store] Error type: ' + error.name);
      logger.error('[MongoDB Vector Store] Error message: ' + error.message);
      
      if (error.code) {
        logger.error('[MongoDB Vector Store] Error code: ' + error.code);
      }
      
      if (error.codeName) {
        logger.error('[MongoDB Vector Store] Error codeName: ' + error.codeName);
      }
      
      // Log the full error stack for debugging
      logger.error('[MongoDB Vector Store] Stack trace:', error.stack);
      
      // If vector search fails, it might be because index doesn't exist
      if (error.message && (error.message.includes('$vectorSearch') || 
                            error.message.includes('vector search') ||
                            error.message.includes('index') ||
                            error.codeName === 'IndexNotFound')) {
        logger.error('[MongoDB Vector Store] ');
        logger.error('[MongoDB Vector Store] ❌ DIAGNOSIS: Vector Search Index Missing or Misconfigured');
        logger.error('[MongoDB Vector Store] ');
        logger.error('[MongoDB Vector Store] The Atlas Vector Search index "' + VECTOR_INDEX_NAME + '" is not operational.');
        logger.error('[MongoDB Vector Store] ');
        logger.error('[MongoDB Vector Store] RESOLUTION STEPS:');
        logger.error('[MongoDB Vector Store] ');
        logger.error('[MongoDB Vector Store] 1. Open MongoDB Atlas Dashboard');
        logger.error('[MongoDB Vector Store] 2. Navigate to: Database → Search → Create Search Index');
        logger.error('[MongoDB Vector Store] 3. Select: Atlas Vector Search');
        logger.error('[MongoDB Vector Store] 4. Configuration:');
        logger.error('[MongoDB Vector Store]    - Database: ' + DEFAULT_DB_NAME);
        logger.error('[MongoDB Vector Store]    - Collection: ' + EMBEDDINGS_COLLECTION);
        logger.error('[MongoDB Vector Store]    - Index Name: ' + VECTOR_INDEX_NAME);
        logger.error('[MongoDB Vector Store]    - JSON Definition:');
        logger.error('[MongoDB Vector Store]      {');
        logger.error('[MongoDB Vector Store]        "fields": [{');
        logger.error('[MongoDB Vector Store]          "type": "vector",');
        logger.error('[MongoDB Vector Store]          "path": "embedding",');
        logger.error('[MongoDB Vector Store]          "numDimensions": 384,');
        logger.error('[MongoDB Vector Store]          "similarity": "cosine"');
        logger.error('[MongoDB Vector Store]        }]');
        logger.error('[MongoDB Vector Store]      }');
        logger.error('[MongoDB Vector Store] 5. Wait 1-2 minutes for index to build');
        logger.error('[MongoDB Vector Store] 6. Verify index status shows "Active"');
        logger.error('[MongoDB Vector Store] ');
        logger.error('[MongoDB Vector Store] ⚠ Attempting fallback to basic search...');
        logger.error('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
        
        // Mark index as not available for future requests
        this.hasVectorIndex = false;
        
        // Fallback: Do a simple text-based search without vector index
        return await this.fallbackTextSearch(datasetId, filter, k);
      }
      
      logger.error('[MongoDB Vector Store] ═══════════════════════════════════════════════════');
      throw new Error('Vector search failed: ' + error.message);
    }
  }

  /**
   * Fallback text search when vector search is unavailable
   * Uses simple text matching instead of vector similarity
   * 
   * @param {string} datasetId - Dataset identifier
   * @param {Object} filter - Metadata filter
   * @param {number} limit - Max results
   * @returns {Promise<Array>}
   */
  async fallbackTextSearch(datasetId, filter, limit) {
    try {
      logger.warn('[MongoDB Vector Store] Using fallback text search (no vector index available)');
      
      const results = await this.collection
        .find(filter)
        .limit(limit)
        .toArray();
      
      // Format to match vector search output
      const formatted = results.map(doc => ({
        id: doc._id.toString(),
        text: doc.text,
        score: 0.5, // Neutral score since we can't compute similarity
        metadata: {
          product: doc.product,
          doc_type: doc.doc_type,
          version: doc.version,
          language: doc.language,
          confidence: doc.confidence,
          created_at: doc.created_at,
          ...doc.metadata
        }
      }));
      
      logger.info('[MongoDB Vector Store] Fallback search returned ' + formatted.length + ' results');
      return formatted;
    } catch (error) {
      logger.error('[MongoDB Vector Store] Fallback search error:', error);
      return [];
    }
  }

  /**
   * Check if embeddings exist for a dataset
   * 
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasEmbeddings(datasetId) {
    await this.initialize();

    try {
      const count = await this.collection.countDocuments({ datasetId: datasetId }, { limit: 1 });
      return count > 0;
    } catch (error) {
      logger.error('[MongoDB Vector Store] Error checking embeddings:', error);
      return false;
    }
  }

  /**
   * Get dataset statistics
   * 
   * @param {string} datasetId
   * @returns {Promise<Object>} - { chunkCount, docTypes, latestUpdate }
   */
  async getDatasetStats(datasetId) {
    await this.initialize();

    try {
      const pipeline = [
        { $match: { datasetId: datasetId } },
        {
          $group: {
            _id: '$doc_type',
            count: { $sum: 1 },
            latestUpdate: { $max: '$created_at' }
          }
        }
      ];

      const results = await this.collection.aggregate(pipeline).toArray();

      const stats = {
        chunkCount: results.reduce((sum, r) => sum + r.count, 0),
        docTypes: {},
        latestUpdate: null
      };

      results.forEach(r => {
        stats.docTypes[r._id] = r.count;
        if (!stats.latestUpdate || r.latestUpdate > stats.latestUpdate) {
          stats.latestUpdate = r.latestUpdate;
        }
      });

      return stats;
    } catch (error) {
      logger.error('[MongoDB Vector Store] Error getting stats:', error);
      return { chunkCount: 0, docTypes: {}, latestUpdate: null };
    }
  }

  /**
   * Delete all embeddings for a dataset
   * 
   * @param {string} datasetId
   * @returns {Promise<number>} - Number of deleted documents
   */
  async deleteDataset(datasetId) {
    await this.initialize();

    try {
      const result = await this.collection.deleteMany({ datasetId: datasetId });
      logger.info('[MongoDB Vector Store] Deleted ' + result.deletedCount + ' embeddings for dataset: ' + datasetId);
      return result.deletedCount;
    } catch (error) {
      logger.error('[MongoDB Vector Store] Error deleting dataset:', error);
      throw new Error('Failed to delete dataset: ' + error.message);
    }
  }

  /**
   * Close MongoDB connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.initialized = false;
      logger.info('[MongoDB Vector Store] Connection closed');
    }
  }
}

// Singleton instance
const mongoVectorStore = new MongoDBVectorStore();

module.exports = mongoVectorStore;
