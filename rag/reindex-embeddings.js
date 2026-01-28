/**
 * Re-index embeddings for a dataset with enhanced metadata extraction
 * 
 * This script:
 * 1. Connects to MongoDB to get the actual dataset
 * 2. Deletes existing embeddings for the dataset
 * 3. Rebuilds embeddings with enhanced column metadata (dtypes, stats, descriptions)
 * 4. Stores new embeddings in MongoDB Atlas Vector Store
 * 
 * Usage: node reindex-embeddings.js <datasetId>
 * Example: node reindex-embeddings.js jira_stale_issue
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');
const logger = require('../logger');
const mongoVectorStore = require('./mongodb.vector.store');
const ragService = require('./rag.service');

const DEFAULT_MONGO_URI = process.env.DATABASE || 'mongodb://localhost:27017';

async function reindexDataset(datasetId) {
  const client = new MongoClient(DEFAULT_MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000
  });

  try {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('RE-INDEXING EMBEDDINGS WITH ENHANCED METADATA');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Dataset ID:', datasetId);
    console.log('');

    // Step 1: Connect to MongoDB and fetch dataset
    console.log('Step 1: Connecting to MongoDB...');
    await client.connect();
    const db = client.db(datasetId);
    const collection = db.collection('data');

    // Fetch all rows
    console.log('Step 2: Fetching dataset rows...');
    const rows = await collection.find({}).toArray();
    console.log('✓ Fetched', rows.length, 'rows');

    if (rows.length === 0) {
      console.error('✗ No rows found in dataset!');
      process.exit(1);
    }

    // Extract column names from first row
    const columnNames = Object.keys(rows[0]).filter(key => key !== '__v');
    console.log('✓ Found', columnNames.length, 'columns:', columnNames.slice(0, 5).join(', '), '...');

    // Step 3: Delete existing embeddings
    console.log('');
    console.log('Step 3: Deleting old embeddings...');
    await mongoVectorStore.initialize();
    const deleted = await mongoVectorStore.deleteDataset(datasetId);
    console.log('✓ Deleted old embeddings:', deleted ? 'SUCCESS' : 'NONE FOUND');

    // Step 4: Build dataset content object
    console.log('');
    console.log('Step 4: Preparing dataset content...');
    const datasetContent = {
      rows: rows,
      columns: columnNames
    };
    console.log('✓ Dataset prepared');

    // Step 5: Initialize new embeddings with enhanced metadata
    console.log('');
    console.log('Step 5: Generating new embeddings with enhanced metadata...');
    console.log('(This may take a minute...)');
    console.log('');
    
    const result = await ragService.initializeEmbeddings(datasetId, datasetContent);
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✓ RE-INDEXING COMPLETE!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Status:', result.status);
    console.log('Message:', result.message);
    console.log('Chunks created:', result.chunkCount);
    console.log('Rows in dataset:', result.rowCount);
    console.log('');
    console.log('You can now query this dataset with improved metadata!');
    console.log('');

    // Step 6: Show sample of new embeddings
    console.log('Sample of new embeddings:');
    const vectorDb = client.db('datagroom_vectors');
    const embeddings = await vectorDb.collection('embeddings')
      .find({ datasetId: datasetId })
      .project({ text: 1, doc_type: 1, _id: 0 })
      .limit(5)
      .toArray();
    
    embeddings.forEach((emb, idx) => {
      console.log('');
      console.log('Embedding', idx + 1, '(' + emb.doc_type + '):');
      console.log(emb.text.substring(0, 200) + (emb.text.length > 200 ? '...' : ''));
    });

  } catch (error) {
    console.error('');
    console.error('✗ Error during re-indexing:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await client.close();
    process.exit(0);
  }
}

// Main
const datasetId = process.argv[2];

if (!datasetId) {
  console.error('Usage: node reindex-embeddings.js <datasetId>');
  console.error('Example: node reindex-embeddings.js jira_stale_issue');
  process.exit(1);
}

reindexDataset(datasetId);
