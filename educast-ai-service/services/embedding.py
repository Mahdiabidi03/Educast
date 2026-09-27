from sentence_transformers import SentenceTransformer
from typing import List, Dict, Any

# Load the model once when the module is imported
# all-MiniLM-L6-v2 is a fast, free local model with dimension 384
model = SentenceTransformer('all-MiniLM-L6-v2')

def get_embeddings(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Computes embeddings for a list of chunks and adds them to the dictionaries.
    """
    if not chunks:
        return []
        
    texts = [chunk["text"] for chunk in chunks]
    
    # Compute embeddings
    # The model returns a numpy array or torch tensor, convert to list of floats for Pinecone
    embeddings = model.encode(texts, convert_to_numpy=True).tolist()
    
    # Add embeddings back to the chunks
    for i, chunk in enumerate(chunks):
        chunk["embedding"] = embeddings[i]
        
    return chunks
