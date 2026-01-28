/**
 * Quick script to check MongoDB Atlas Vector Search Index status
 * Run this to verify your setup before querying
 */

const { MongoClient } = require('mongodb');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const MONGO_URI = process.env.DATABASE || process.env.MONGO_URI || 'mongodb://localhost:27017';
const VECTOR_DB = 'datagroom_vectors';
const COLLECTION = 'embeddings';
const INDEX_NAME = 'vector_index';

async function checkStatus() {
  console.log('\n🔍 MongoDB Atlas Vector Search - Status Check\n');
  console.log('='.repeat(60));
  
  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log('✅ MongoDB connection: SUCCESS');
    
    const db = client.db(VECTOR_DB);
    const collection = db.collection(COLLECTION);
    
    // Check if collection exists and has documents
    const count = await collection.countDocuments();
    console.log(`✅ Database: ${VECTOR_DB}`);
    console.log(`✅ Collection: ${COLLECTION}`);
    console.log(`✅ Total embeddings stored: ${count}`);
    
    if (count === 0) {
      console.log('\n⚠️  WARNING: No embeddings found!');
      console.log('   You need to initialize embeddings first.');
      console.log('   Run: POST http://localhost:8887/rag/YOUR_DATASET/initialize\n');
      return;
    }
    
    // Show breakdown by dataset - check different metadata field paths
    let datasets = await collection.distinct('metadata.datasetId');
    if (datasets.length === 0) {
      // Try alternative field paths
      datasets = await collection.distinct('datasetId');
    }
    if (datasets.length === 0) {
      datasets = await collection.distinct('dataset_id');
    }
    
    console.log(`\n📊 Datasets with embeddings: ${datasets.length}`);
    
    if (datasets.length === 0) {
      // Show a sample document to see the structure
      const sample = await collection.findOne({});
      console.log('\n📄 Sample document structure:');
      console.log(JSON.stringify(sample, null, 2).substring(0, 500));
    } else {
      for (const datasetId of datasets) {
        const datasetCount = await collection.countDocuments({ 
          $or: [
            { 'metadata.datasetId': datasetId },
            { 'datasetId': datasetId },
            { 'dataset_id': datasetId }
          ]
        });
        console.log(`   - ${datasetId}: ${datasetCount} embeddings`);
      }
    }
    
    // Try to test the vector index with a dummy query
    console.log('\n🔍 Testing Atlas Vector Search index...');
    console.log(`   Index name: ${INDEX_NAME}`);
    
    try {
      // Create a test vector with small non-zero values (384 dimensions)
      const testVector = new Array(384).fill(0.01);
      
      const pipeline = [
        {
          $vectorSearch: {
            index: INDEX_NAME,
            path: 'embedding',
            queryVector: testVector,
            numCandidates: 1,
            limit: 1
          }
        }
      ];
      
      const results = await collection.aggregate(pipeline).toArray();
      
      console.log('✅ Vector Search Index: ACTIVE and WORKING!');
      console.log('✅ Your setup is complete and ready to use.\n');
      
      console.log('🎉 SUCCESS! You can now:');
      console.log('   1. Open your dataset chat in the UI');
      console.log('   2. Ask questions about your data');
      console.log('   3. Get AI-powered insights\n');
      
    } catch (error) {
      if (error.message.includes('$vectorSearch') || 
          error.message.includes('index') ||
          error.code === 291) {
        console.log('❌ Vector Search Index: NOT FOUND\n');
        console.log('=' .repeat(60));
        console.log('📋 ACTION REQUIRED: Create Atlas Vector Search Index');
        console.log('='.repeat(60));
        console.log('\n1. Go to: https://cloud.mongodb.com');
        console.log('2. Select your cluster');
        console.log('3. Click "Search" tab → "Create Search Index"');
        console.log('4. Select "Atlas Vector Search"');
        console.log('5. Choose "JSON Editor"');
        console.log('\n6. Use these settings:');
        console.log('   Database: datagroom_vectors');
        console.log('   Collection: embeddings');
        console.log('   Index Name: vector_index');
        console.log('\n7. Paste this JSON configuration:');
        console.log('\n{');
        console.log('  "fields": [');
        console.log('    {');
        console.log('      "type": "vector",');
        console.log('      "path": "embedding",');
        console.log('      "numDimensions": 384,');
        console.log('      "similarity": "cosine"');
        console.log('    }');
        console.log('  ]');
        console.log('}\n');
        console.log('8. Click "Create Search Index"');
        console.log('9. Wait 2-5 minutes for it to build');
        console.log('10. Run this script again to verify\n');
        console.log('📖 Detailed guide: rag/setup-vector-index.md\n');
      } else {
        console.log(`❌ Error testing index: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.log(`\n❌ Connection Error: ${error.message}`);
    console.log('\nCheck your MongoDB connection string in .env file\n');
  } finally {
    await client.close();
  }
}

checkStatus().catch(console.error);
