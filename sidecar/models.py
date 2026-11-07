"""Optional on-device BGE-M3 and Cross-Encoder endpoints; models are loaded lazily."""
from functools import lru_cache
import math
import os
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()

@lru_cache(maxsize=1)
def embedding_model():
    from FlagEmbedding import BGEM3FlagModel
    return BGEM3FlagModel(os.environ.get('KNOWWEAVE_EMBED_MODEL', 'BAAI/bge-m3'), use_fp16=False, devices='cpu')

@lru_cache(maxsize=1)
def reranking_model():
    from sentence_transformers import CrossEncoder
    return CrossEncoder(os.environ.get('KNOWWEAVE_RERANK_MODEL', 'BAAI/bge-reranker-v2-m3'), device='cpu')

class EmbeddingIn(BaseModel):
    input: list[str] = Field(min_length=1, max_length=64)
    model: str | None = None

@router.post('/embed')
def embed(payload: EmbeddingIn):
    model_name=os.environ.get('KNOWWEAVE_EMBED_MODEL', 'BAAI/bge-m3')
    if payload.model and payload.model != model_name:
        from fastapi import HTTPException
        raise HTTPException(status_code=400,detail='请求模型与本地配置不一致')
    result=embedding_model().encode(payload.input, batch_size=8, max_length=8192, return_dense=True, return_sparse=True, return_colbert_vecs=False)
    return {'model':model_name,'data':[{'index':i,'embedding':dense.tolist(),'sparse_embedding':{str(k):float(v) for k,v in sparse.items()}}
        for i,(dense,sparse) in enumerate(zip(result['dense_vecs'],result['lexical_weights']))]}

class RerankIn(BaseModel):
    query: str
    documents: list[str] = Field(min_length=1,max_length=100)
    model: str | None = None

@router.post('/rerank')
def rerank(payload: RerankIn):
    import torch
    model_name=os.environ.get('KNOWWEAVE_RERANK_MODEL', 'BAAI/bge-reranker-v2-m3')
    if payload.model and payload.model != model_name:
        from fastapi import HTTPException
        raise HTTPException(status_code=400,detail='请求模型与本地配置不一致')
    logits=reranking_model().predict([(payload.query,text) for text in payload.documents], activation_fn=torch.nn.Identity())
    return {'results':[{'index':i,'relevance_score':1/(1+math.exp(-max(-700,min(700,float(score)))))} for i,score in enumerate(logits)]}
