"""
Embedding Service
Production-ready semantic embeddings using sentence-transformers
Includes LangChain-based document chunking with metadata support
"""

from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer
import logging
import sys
import json

# Import LangChain for intelligent chunking
try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    from langchain_core.documents import Document
    LANGCHAIN_AVAILABLE = True
except ImportError as e:
    LANGCHAIN_AVAILABLE = False
    logging.error(f"LangChain not available: {e}")
    sys.exit(1)  # Fail fast if LangChain is missing

app = Flask(__name__)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Load model on startup (all-MiniLM-L6-v2: 384 dimensions, fast, good quality)
model = None

def load_model():
    global model
    try:
        logger.info("Loading sentence-transformers model: all-MiniLM-L6-v2")
        model = SentenceTransformer('all-MiniLM-L6-v2')
        logger.info(f"Model loaded successfully. Embedding dimension: {model.get_sentence_embedding_dimension()}")
        return True
    except Exception as e:
        logger.error(f"Failed to load model: {str(e)}")
        return False

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'model_loaded': model is not None,
        'model_name': 'all-MiniLM-L6-v2',
        'embedding_dimension': 384
    })

@app.route('/embed', methods=['POST'])
def embed():
    """
    Embed text(s) using sentence-transformers
    
    Request body:
    {
        "texts": ["text1", "text2", ...] or "single text"
    }
    
    Response:
    {
        "embeddings": [[...], [...], ...],
        "dimension": 384
    }
    """
    try:
        if model is None:
            return jsonify({'error': 'Model not loaded'}), 500
        
        data = request.get_json()
        
        if not data or 'texts' not in data:
            return jsonify({'error': 'Missing "texts" field in request body'}), 400
        
        texts = data['texts']
        
        # Handle single string or array
        if isinstance(texts, str):
            texts = [texts]
        
        if not isinstance(texts, list) or len(texts) == 0:
            return jsonify({'error': '"texts" must be a non-empty string or array'}), 400
        
        # Validate all items are strings
        if not all(isinstance(t, str) for t in texts):
            return jsonify({'error': 'All texts must be strings'}), 400
        
        logger.info(f"Embedding {len(texts)} text(s)")
        
        # Generate embeddings
        embeddings = model.encode(texts, convert_to_numpy=True)
        
        # Convert numpy arrays to lists for JSON serialization
        embeddings_list = embeddings.tolist()
        
        return jsonify({
            'embeddings': embeddings_list,
            'dimension': len(embeddings_list[0]) if embeddings_list else 0,
            'count': len(embeddings_list)
        })
        
    except Exception as e:
        logger.error(f"Error during embedding: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/embed/batch', methods=['POST'])
def embed_batch():
    """
    Batch embedding with progress tracking (for large datasets)
    
    Request body:
    {
        "texts": [...],
        "batch_size": 32  // optional, default 32
    }
    """
    try:
        if model is None:
            return jsonify({'error': 'Model not loaded'}), 500
        
        data = request.get_json()
        texts = data.get('texts', [])
        batch_size = data.get('batch_size', 32)
        
        if not texts:
            return jsonify({'error': 'No texts provided'}), 400
        
        logger.info(f"Batch embedding {len(texts)} texts with batch_size={batch_size}")
        
        # Process in batches
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            embeddings = model.encode(batch, convert_to_numpy=True, show_progress_bar=False)
            all_embeddings.extend(embeddings.tolist())
            logger.info(f"Processed batch {i//batch_size + 1}/{(len(texts) + batch_size - 1)//batch_size}")
        
        return jsonify({
            'embeddings': all_embeddings,
            'dimension': len(all_embeddings[0]) if all_embeddings else 0,
            'count': len(all_embeddings)
        })
        
    except Exception as e:
        logger.error(f"Error during batch embedding: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/chunk', methods=['POST'])
def chunk_dataset():
    """
    Chunk dataset using LangChain's RecursiveCharacterTextSplitter with metadata tagging
    
    Request: { "dataset": {...}, "chunk_size": 600, "chunk_overlap": 100 }
    Response: { "chunks": [...], "total_chunks": N, "total_rows": M }
    """
    try:
        if not LANGCHAIN_AVAILABLE:
            return jsonify({'error': 'LangChain not available'}), 500
        
        data = request.get_json()
        
        if not data or 'dataset' not in data:
            return jsonify({'error': 'Missing "dataset" field in request body'}), 400
        
        dataset_content = data['dataset']
        chunk_size = data.get('chunk_size', 600)
        chunk_overlap = data.get('chunk_overlap', 100)
        
        # Initialize text splitter
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            length_function=len,
            separators=[
                "\n\n",  # Paragraph breaks
                "\n",    # Line breaks
                ". ",    # Sentence ends
                ", ",    # Clause breaks
                " ",     # Word breaks
                ""       # Character breaks
            ],
            keep_separator=True
        )
        
        documents = []
        
        # Document 1: Schema and metadata
        schema_parts = []
        if dataset_content.get('schema'):
            schema_parts.append("Dataset Schema:")
            schema_parts.append(json.dumps(dataset_content['schema'], indent=2))
        
        if dataset_content.get('metadata'):
            schema_parts.append("\nDataset Metadata:")
            schema_parts.append(json.dumps(dataset_content['metadata'], indent=2))
        
        if schema_parts:
            schema_doc = Document(
                page_content="\n".join(schema_parts),
                metadata={"type": "schema", "priority": "high"}
            )
            documents.append(schema_doc)
        
        # Document 2: Column information
        if dataset_content.get('columns'):
            columns_text = f"Columns ({len(dataset_content['columns'])}):\n"
            columns_text += ", ".join(dataset_content['columns'])
            columns_doc = Document(
                page_content=columns_text,
                metadata={"type": "columns", "priority": "high"}
            )
            documents.append(columns_doc)
        
        # Document 3: Row count (IMPORTANT for count queries)
        rows = dataset_content.get('rows', [])
        if rows:
            count_text = f"\nTotal Rows in Dataset: {len(rows)}\n\n"
            documents.append(Document(
                page_content=count_text,
                metadata={"type": "count", "priority": "high", "row_count": len(rows)}
            ))
        
        # Document 4: ALL row data
        columns = dataset_content.get('columns', [])
        if rows:
            all_rows_text = f"Dataset Rows (1 to {len(rows)}):\n\n"
            
            for idx, row in enumerate(rows):
                row_text = f"Row {idx + 1}:\n"
                
                if columns:
                    for col in columns:
                        if col in row and row[col] not in [None, '', 'null']:
                            value = str(row[col])
                            row_text += f"  {col}: {value}\n"
                else:
                    for key, value in row.items():
                        if value not in [None, '', 'null']:
                            row_text += f"  {key}: {str(value)}\n"
                
                all_rows_text += row_text + "\n"
            
            row_doc = Document(
                page_content=all_rows_text,
                metadata={"type": "data", "priority": "medium", "total_rows": len(rows)}
            )
            documents.append(row_doc)
        
        # Split documents into chunks
        logger.info(f"Chunking dataset with {len(rows)} rows using LangChain")
        chunks = text_splitter.split_documents(documents)
        logger.info(f"Created {len(chunks)} chunks")
        
        # Convert to result format
        result_chunks = []
        for i, chunk in enumerate(chunks):
            result_chunks.append({
                "text": chunk.page_content,
                "metadata": {
                    **chunk.metadata,
                    "chunk_id": i,
                    "total_chunks": len(chunks)
                }
            })
        
        return jsonify({
            'chunks': result_chunks,
            'total_chunks': len(result_chunks),
            'total_rows': len(rows)
        })
        
    except Exception as e:
        logger.error(f"Error during chunking: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Load model before starting server
    if not load_model():
        logger.error("Failed to load model. Exiting.")
        sys.exit(1)
    
    # Start server
    logger.info("Starting embedding service on http://localhost:5001")
    app.run(host='0.0.0.0', port=5001, debug=False)
