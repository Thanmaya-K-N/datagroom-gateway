/**
 * MongoDB Atlas Vector Search Diagnostic Tool
 * 
 * This script helps diagnose issues with MongoDB Atlas Vector Search setup
 * Run this to verify your configuration before using the RAG system
 * 
 * Usage:
 *   node test-vector-search.js
 * 
 * Environment Variables Required:
 *   DATABASE - MongoDB connection string
 *   MONGO_DB - Database name (default: datagroom_vectors)
 */

const { MongoClient } = require('mongodb');

const DEFAULT_MONGO_URI = process.env.DATABASE || 'mongodb://localhost:27017';
const DEFAULT_DB_NAME = process.env.MONGO_DB || 'datagroom_vectors';
const EMBEDDINGS_COLLECTION = 'embeddings';
const VECTOR_INDEX_NAME = 'vector_index';

console.log('\n═══════════════════════════════════════════════════════════');
console.log('MongoDB Atlas Vector Search Diagnostic Tool');
console.log('═══════════════════════════════════════════════════════════\n');

async function runDiagnostics() {
  let client;
  
  try {
    console.log('Step 1: Testing MongoDB Connection');
    console.log('───────────────────────────────────────────────────────────');
    console.log('Connection String: ' + DEFAULT_MONGO_URI.replace(/:[^:]*@/, ':***@'));
    console.log('Database: ' + DEFAULT_DB_NAME);
    console.log('Collection: ' + EMBEDDINGS_COLLECTION);
    console.log('');
    
    client = new MongoClient(DEFAULT_MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000
    });
    
    await client.connect();
    console.log('✓ Successfully connected to MongoDB');
    
    const db = client.db(DEFAULT_DB_NAME);
    await db.admin().ping();
    console.log('✓ Database ping successful');
    console.log('');
    
    // Check collection exists
    console.log('Step 2: Checking Collection');
    console.log('───────────────────────────────────────────────────────────');
    
    const collections = await db.listCollections({ name: EMBEDDINGS_COLLECTION }).toArray();
    
    if (collections.length === 0) {
      console.log('⚠ Collection "' + EMBEDDINGS_COLLECTION + '" does not exist');
      console.log('  This is normal if you haven\'t initialized embeddings yet');
      console.log('');
    } else {
      console.log('✓ Collection "' + EMBEDDINGS_COLLECTION + '" exists');
      
      const collection = db.collection(EMBEDDINGS_COLLECTION);
      const count = await collection.countDocuments();
      console.log('✓ Documents in collection: ' + count);
      
      if (count > 0) {
        // Check a sample document
        const sample = await collection.findOne();
        console.log('✓ Sample document structure:');
        console.log('  - Has _id: ' + (sample._id ? 'YES' : 'NO'));
        console.log('  - Has text: ' + (sample.text ? 'YES' : 'NO'));
        console.log('  - Has embedding: ' + (sample.embedding ? 'YES' : 'NO'));
        console.log('  - Has datasetId: ' + (sample.datasetId ? 'YES' : 'NO'));
        
        if (sample.embedding) {
          console.log('  - Embedding dimensions: ' + (Array.isArray(sample.embedding) ? sample.embedding.length : 'N/A'));
          if (Array.isArray(sample.embedding) && sample.embedding.length !== 384) {
            console.log('  ⚠ WARNING: Expected 384 dimensions, got ' + sample.embedding.length);
          } else {
            console.log('  ✓ Embedding dimensions correct (384)');
          }
        }
        
        // Check datasets
        const datasets = await collection.distinct('datasetId');
        console.log('✓ Datasets with embeddings: ' + datasets.join(', '));
      }
      
      console.log('');
    }
    
    // Check regular MongoDB indexes
    console.log('Step 3: Checking Regular MongoDB Indexes');
    console.log('───────────────────────────────────────────────────────────');
    
    const collection = db.collection(EMBEDDINGS_COLLECTION);
    const indexes = await collection.listIndexes().toArray();
    
    console.log('Found ' + indexes.length + ' regular MongoDB index(es):');
    indexes.forEach(idx => {
      console.log('  - ' + idx.name + ' (' + JSON.stringify(idx.key) + ')');
    });
    console.log('');
    console.log('ℹ Note: Atlas Vector Search indexes are NOT shown by listIndexes()');
    console.log('  They must be viewed in the Atlas UI under Database → Search');
    console.log('');
    
    // Test Atlas Vector Search index
    console.log('Step 4: Testing Atlas Vector Search Index');
    console.log('───────────────────────────────────────────────────────────');
    console.log('Index Name: ' + VECTOR_INDEX_NAME);
    console.log('Testing with zero vector query...');
    console.log('');
    
    try {
      const testVector = Array(384).fill(0);
      const testPipeline = [
        {
          $vectorSearch: {
            index: VECTOR_INDEX_NAME,
            path: 'embedding',
            queryVector: testVector,
            numCandidates: 10,
            limit: 1
          }
        },
        { $limit: 1 }
      ];
      
      const startTime = Date.now();
      const results = await collection.aggregate(testPipeline).toArray();
      const executionTime = Date.now() - startTime;
      
      console.log('✓ Vector search index is OPERATIONAL!');
      console.log('✓ Query executed in ' + executionTime + 'ms');
      console.log('✓ Results returned: ' + results.length);
      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('✓✓✓ ALL CHECKS PASSED ✓✓✓');
      console.log('Your MongoDB Atlas Vector Search is properly configured!');
      console.log('═══════════════════════════════════════════════════════════\n');
      
    } catch (error) {
      console.log('✗ Vector search index test FAILED');
      console.log('✗ Error: ' + error.message);
      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('✗✗✗ VECTOR INDEX NOT FOUND ✗✗✗');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
      console.log('The Atlas Vector Search index is missing or misconfigured.');
      console.log('');
      console.log('RESOLUTION STEPS:');
      console.log('');
      console.log('1. Open MongoDB Atlas Dashboard');
      console.log('   → https://cloud.mongodb.com');
      console.log('');
      console.log('2. Navigate to your cluster');
      console.log('   → Database → Search → Create Search Index');
      console.log('');
      console.log('3. Select "Atlas Vector Search"');
      console.log('');
      console.log('4. Configuration:');
      console.log('   - Database: ' + DEFAULT_DB_NAME);
      console.log('   - Collection: ' + EMBEDDINGS_COLLECTION);
      console.log('   - Index Name: ' + VECTOR_INDEX_NAME);
      console.log('');
      console.log('5. Use this JSON definition:');
      console.log('');
      console.log('{');
      console.log('  "fields": [');
      console.log('    {');
      console.log('      "type": "vector",');
      console.log('      "path": "embedding",');
      console.log('      "numDimensions": 384,');
      console.log('      "similarity": "cosine"');
      console.log('    }');
      console.log('  ]');
      console.log('}');
      console.log('');
      console.log('6. Click "Create Search Index"');
      console.log('');
      console.log('7. Wait 1-2 minutes for index to build');
      console.log('   Status should change to "Active"');
      console.log('');
      console.log('8. Run this diagnostic script again to verify');
      console.log('');
      console.log('═══════════════════════════════════════════════════════════\n');
    }
    
  } catch (error) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✗✗✗ DIAGNOSTIC FAILED ✗✗✗');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('Error Type: ' + error.name);
    console.log('Error Message: ' + error.message);
    console.log('');
    
    if (error.name === 'MongoServerSelectionError') {
      console.log('DIAGNOSIS: Cannot connect to MongoDB');
      console.log('');
      console.log('Possible causes:');
      console.log('1. MongoDB server is not running');
      console.log('2. Connection string is incorrect');
      console.log('3. Network/firewall blocking connection');
      console.log('4. MongoDB Atlas IP whitelist not configured');
      console.log('');
      console.log('Check your DATABASE environment variable:');
      console.log(DEFAULT_MONGO_URI.replace(/:[^:]*@/, ':***@'));
      console.log('');
    } else {
      console.log('Stack trace:');
      console.log(error.stack);
      console.log('');
    }
    
    console.log('═══════════════════════════════════════════════════════════\n');
    process.exit(1);
    
  } finally {
    if (client) {
      await client.close();
      console.log('Connection closed.\n');
    }
  }
}

// Run diagnostics
runDiagnostics().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
