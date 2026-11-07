import unittest
import types
from unittest.mock import patch
from fastapi.testclient import TestClient
from sidecar.main import app
from sidecar import models

class ModelsTests(unittest.TestCase):
    def test_bge_preserves_learned_sparse_token_ids(self):
        class Vector(list):
            def tolist(self): return list(self)
        model=types.SimpleNamespace(encode=lambda texts,**kwargs:{'dense_vecs':[Vector([1,0])],'lexical_weights':[{123:0.7}]})
        with patch.object(models,'embedding_model',return_value=model):
            response=TestClient(app).post('/embed',json={'input':['fixture'],'model':'BAAI/bge-m3'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['data'][0]['sparse_embedding'],{'123':0.7})

    def test_cross_encoder_scores_are_bounded_and_keep_input_indices(self):
        model=types.SimpleNamespace(predict=lambda pairs,**kwargs:[-2,2])
        torch=types.SimpleNamespace(nn=types.SimpleNamespace(Identity=lambda:object()))
        with patch.object(models,'reranking_model',return_value=model),patch.dict('sys.modules',{'torch':torch}):
            response=TestClient(app).post('/rerank',json={'query':'q','documents':['a','b']})
        self.assertEqual(response.status_code,200)
        scores=response.json()['results']
        self.assertEqual([row['index'] for row in scores],[0,1])
        self.assertLess(scores[0]['relevance_score'],0.5)
        self.assertGreater(scores[1]['relevance_score'],0.5)
