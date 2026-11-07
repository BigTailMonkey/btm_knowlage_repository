import base64
import io
import types
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sidecar.main import app, ParseIn, route_parse, quality
from sidecar import advanced


def output(parser='fixture', score=0.9):
    return {'title':'Fixture','blocks':[{'type':'paragraph','text':'Verified document text.','headingPath':[],'page':1,'bbox':[1,2,3,4],'order':0}], 'parser':parser,'quality':score,'meta':{}}

class ParsingTests(unittest.TestCase):
    def payload(self, filename='test.pdf', engine='auto'):
        return ParseIn(filename=filename,data=base64.b64encode(b'fixture').decode(),engine=engine)

    def test_quality_penalizes_corrupt_text(self):
        self.assertLess(quality('\ufffd'*100), quality('Readable text '*20))

    def test_low_quality_routes_to_next_engine_and_keeps_diagnostics(self):
        with patch.object(advanced,'docling_parse',side_effect=ImportError('unavailable')), patch('sidecar.main.parse_pdf',return_value=output('pypdf',0.1)), patch.object(advanced,'mineru_parse',return_value=output('mineru')):
            result=route_parse(self.payload())
        self.assertEqual(result['parser'],'mineru')
        self.assertEqual([row['engine'] for row in result['meta']['attempts']],['docling','pypdf','mineru'])

    def test_unreadable_documents_fail_instead_of_publishing_empty_text(self):
        with patch.object(advanced,'docling_parse',side_effect=ImportError()), patch('sidecar.main.parse_pdf',return_value=output('pypdf',0)), patch.object(advanced,'mineru_parse',side_effect=RuntimeError()), patch.object(advanced,'pdf_ocr',side_effect=RuntimeError()):
            with self.assertRaises(HTTPException) as failure:route_parse(self.payload())
        self.assertEqual(failure.exception.status_code,422)
        self.assertEqual(len(failure.exception.detail['attempts']),4)

    def test_invalid_base64_returns_400(self):
        with self.assertRaises(HTTPException) as failure:route_parse(ParseIn(filename='a.pdf',data='invalid!'))
        self.assertEqual(failure.exception.status_code,400)

    def test_ocr_and_asr_routes_keep_geometry_and_timestamps(self):
        client=TestClient(app)
        with patch.object(advanced,'image_ocr',return_value=output('ocr')):
            response=client.post('/ocr',json={'filename':'scan.png','data':self.payload().data})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['blocks'][0]['bbox'],[1,2,3,4])
        transcribed=output('asr');transcribed['meta']['segments']=[{'start':1.5,'end':3.0,'text':'Words'}]
        with patch.object(advanced,'transcribe',return_value=transcribed):
            response=client.post('/asr',json={'filename':'clip.wav','data':self.payload().data})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['meta']['segments'][0]['start'],1.5)

    def test_actual_docx_order_and_heading(self):
        from docx import Document
        doc=Document();doc.add_heading('Architecture',level=1);doc.add_paragraph('Before the table.');table=doc.add_table(rows=1,cols=2);table.cell(0,0).text='Key';table.cell(0,1).text='Value';doc.add_paragraph('After the table.')
        data=io.BytesIO();doc.save(data)
        result=route_parse(ParseIn(filename='doc.docx',data=base64.b64encode(data.getvalue()).decode(),engine='docx'))
        self.assertEqual([item['type'] for item in result['blocks']],['paragraph','table','paragraph'])
        self.assertEqual(result['blocks'][1]['headingPath'],['Architecture'])

    def test_docling_adapter_preserves_page_and_bbox(self):
        bbox=types.SimpleNamespace(l=1,t=2,r=30,b=40)
        item=types.SimpleNamespace(label=types.SimpleNamespace(value='paragraph'),text='Document content',prov=[types.SimpleNamespace(page_no=3,bbox=bbox)])
        document=types.SimpleNamespace(iterate_items=lambda:iter([(item,1)]),pages={1:None,2:None,3:None})
        converter=types.SimpleNamespace(DocumentConverter=lambda:types.SimpleNamespace(convert=lambda source:types.SimpleNamespace(document=document)))
        models=types.SimpleNamespace(DocumentStream=lambda **kwargs:kwargs)
        with patch.dict(sys.modules,{'docling':types.ModuleType('docling'),'docling.document_converter':converter,'docling.datamodel':types.ModuleType('docling.datamodel'),'docling.datamodel.base_models':models}):
            result=advanced.docling_parse(b'data','input.pdf','Title')
        self.assertEqual(result['blocks'][0]['page'],3)
        self.assertEqual(result['blocks'][0]['bbox'],[1,2,30,40])

    def test_mineru_uses_argv_and_reads_output_without_invented_geometry(self):
        def run(arguments,**kwargs):
            self.assertNotIn('shell',kwargs)
            Path(arguments[-1]).write_text('# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |',encoding='utf-8')
        with patch('sidecar.advanced.shutil.which',return_value='/bin/mineru'),patch('sidecar.advanced.subprocess.run',side_effect=run):
            result=advanced.mineru_parse(b'data','../../input.pdf','Title')
        self.assertEqual(result['meta']['format'],'markdown')
        self.assertFalse(result['meta']['geometry_available'])

    def test_rapidocr_adapter_retains_line_boxes_and_confidence(self):
        result=types.SimpleNamespace(boxes=[[[1,2],[10,2],[10,8],[1,8]]],txts=['Recognized text'],scores=[0.97])
        module=types.SimpleNamespace(RapidOCR=lambda:lambda data:result)
        with patch.dict(sys.modules,{'rapidocr':module}):parsed=advanced.rapid_ocr(b'fixture','Scan')
        self.assertEqual(parsed['blocks'][0]['bbox'],[1.0,2.0,10.0,8.0])
        self.assertEqual(parsed['meta']['ocr_confidence'],0.97)

    def test_asr_adapter_retains_segment_times_in_searchable_text(self):
        segments=[types.SimpleNamespace(start=1.25,end=2.5,text='Words from audio')]
        module=types.SimpleNamespace(WhisperModel=lambda *a,**kw:types.SimpleNamespace(transcribe=lambda path:(segments,types.SimpleNamespace(language='en'))))
        with patch.dict(sys.modules,{'faster_whisper':module}):parsed=advanced.transcribe(b'fixture','input.wav','Audio')
        self.assertIn('[1.250s–2.500s]',parsed['blocks'][0]['text'])
        self.assertEqual(parsed['meta']['segments'][0]['start'],1.25)

if __name__=='__main__':unittest.main()
