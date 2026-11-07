"""Optional document engines. Imports are lazy so plain parsing stays lightweight."""
from __future__ import annotations
import io
import os
import shutil
import subprocess
import sys
import json
import tempfile
from pathlib import Path


def docling_parse(data: bytes, filename: str, title: str) -> dict:
    from docling.document_converter import DocumentConverter
    from docling.datamodel.base_models import DocumentStream
    from sidecar.main import Block, blocks_document
    document = DocumentConverter().convert(DocumentStream(name=Path(filename).name, stream=io.BytesIO(data))).document
    blocks = []
    headings = []
    for item, _ in document.iterate_items():
        label = str(getattr(item.label, 'value', item.label))
        text = getattr(item, 'text', '') or ''
        if label in ('section_header', 'title'):
            level = int(getattr(item, 'level', 1) or 1)
            headings = headings[:max(0, level - 1)] + [text]
        kind = {'table': 'table', 'code': 'code', 'formula': 'formula', 'list_item': 'list'}.get(label, 'paragraph')
        if label == 'table':
            text = item.export_to_markdown(doc=document)
        if not text.strip():
            continue
        provenance = item.prov[0] if getattr(item, 'prov', None) else None
        bbox = provenance.bbox if provenance else None
        blocks.append(Block(type=kind, text=text, headingPath=list(headings), page=provenance.page_no if provenance else None,
                            bbox=[bbox.l, bbox.t, bbox.r, bbox.b] if bbox else None, order=len(blocks)))
    return blocks_document(title, blocks, 'docling', {'engine': 'docling', 'pages': len(document.pages)})


def mineru_parse(data: bytes, filename: str, title: str) -> dict:
    from sidecar.main import Block, blocks_document
    executable = os.environ.get('KNOWWEAVE_MINERU_BIN', 'mineru')
    if not shutil.which(executable):
        raise RuntimeError('MinerU CLI 未安装')
    with tempfile.TemporaryDirectory(prefix='knowweave-mineru-') as directory:
        source = Path(directory) / ('input' + Path(filename).suffix)
        target = Path(directory) / 'output.md'
        source.write_bytes(data)
        subprocess.run([executable, 'parse', str(source), '-o', str(target)], check=True, capture_output=True, timeout=180)
        text = target.read_text(encoding='utf-8')
    # Markdown is retained intact; no invented PDF geometry is attached.
    return blocks_document(title, [Block(type='markdown', text=text, order=0)], 'mineru', {'format': 'markdown', 'geometry_available': False})


def rapid_ocr(data: bytes, title: str) -> dict:
    from rapidocr import RapidOCR
    from sidecar.main import Block, blocks_document
    result = RapidOCR()(data)
    blocks = []
    for polygon, text, score in zip(result.boxes if result.boxes is not None else [], result.txts or [], result.scores if result.scores is not None else []):
        if not text.strip():
            continue
        xs = [float(point[0]) for point in polygon]
        ys = [float(point[1]) for point in polygon]
        blocks.append(Block(type='paragraph', text=text, page=1, bbox=[min(xs),min(ys),max(xs),max(ys)], order=len(blocks)))
    scores = list(result.scores) if result.scores is not None else []
    parsed = blocks_document(title, blocks, 'rapidocr', {'bbox_unit': 'pixels', 'ocr_confidence': float(sum(scores) / max(1,len(scores)))})
    parsed['quality'] = min(parsed['quality'], parsed['meta']['ocr_confidence'])
    return parsed


def native_ocr(data: bytes, title: str, suffix: str = '.png') -> dict:
    from sidecar.main import Block, blocks_document
    if sys.platform != 'darwin' or not shutil.which('swift'):
        raise RuntimeError('Apple Vision仅支持安装Swift的macOS')
    cache = Path(tempfile.gettempdir()) / 'knowweave-swift-modules'
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='knowweave-vision-') as directory:
        path = Path(directory) / ('source' + suffix)
        path.write_bytes(data)
        completed = subprocess.run(['swift', '-module-cache-path', str(cache), str(Path(__file__).with_name('vision_ocr.swift')), str(path)],
                                   check=True, capture_output=True, text=True, timeout=180)
        rows = json.loads(completed.stdout)
    blocks = [Block(type='paragraph', text=row['text'], page=row['page'], bbox=row['bbox'], order=index) for index,row in enumerate(rows)]
    confidence = sum(row['confidence'] for row in rows) / max(1,len(rows))
    parsed = blocks_document(title, blocks, 'apple-vision', {'ocr_confidence':confidence,'bbox_unit':'rendered-pdf-points' if suffix == '.pdf' else 'pixels','on_device':True})
    parsed['quality'] = min(parsed['quality'],confidence)
    return parsed


def image_ocr(data: bytes, title: str) -> dict:
    if sys.platform == 'darwin' and os.environ.get('KNOWWEAVE_OCR_ENGINE', 'auto') in ('auto', 'vision'):
        try:
            return native_ocr(data,title)
        except Exception:
            if os.environ.get('KNOWWEAVE_OCR_ENGINE') == 'vision':
                raise
    if not shutil.which('tesseract') or os.environ.get('KNOWWEAVE_OCR_ENGINE') == 'rapidocr':
        return rapid_ocr(data, title)
    from PIL import Image
    import pytesseract
    from sidecar.main import Block, blocks_document
    image = Image.open(io.BytesIO(data)).convert('RGB')
    languages = pytesseract.get_languages(config='')
    language = os.environ.get('KNOWWEAVE_OCR_LANG') or '+'.join(name for name in ('chi_sim', 'eng') if name in languages)
    if not language:
        raise RuntimeError('未安装可用的 Tesseract 语言包')
    result = pytesseract.image_to_data(image, lang=language, output_type=pytesseract.Output.DICT)
    groups = {}
    for i, text in enumerate(result['text']):
        if not text.strip() or float(result['conf'][i]) < 0:
            continue
        key = (result['block_num'][i], result['par_num'][i])
        groups.setdefault(key, []).append(i)
    blocks = []
    confidences = []
    for indices in groups.values():
        words = [result['text'][i] for i in indices]
        left = min(result['left'][i] for i in indices)
        top = min(result['top'][i] for i in indices)
        right = max(result['left'][i] + result['width'][i] for i in indices)
        bottom = max(result['top'][i] + result['height'][i] for i in indices)
        confidences.extend(float(result['conf'][i]) / 100 for i in indices)
        blocks.append(Block(type='paragraph', text=' '.join(words), page=1, bbox=[left, top, right, bottom], order=len(blocks)))
    document = blocks_document(title, blocks, 'tesseract', {'ocr_confidence': sum(confidences) / max(1, len(confidences)), 'bbox_unit': 'pixels', 'image_size': list(image.size)})
    document['quality'] = min(document['quality'], document['meta']['ocr_confidence'])
    return document


def pdf_ocr(data: bytes, title: str) -> dict:
    if sys.platform == 'darwin' and os.environ.get('KNOWWEAVE_OCR_ENGINE', 'auto') in ('auto', 'vision'):
        try:
            return native_ocr(data,title,'.pdf')
        except Exception:
            if os.environ.get('KNOWWEAVE_OCR_ENGINE') == 'vision':
                raise
    import pymupdf
    from sidecar.main import Block, blocks_document
    blocks = []
    engines = set()
    confidence = 1.0
    with pymupdf.open(stream=data, filetype='pdf') as document:
        for page in document:
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2))
            parsed = image_ocr(pixmap.tobytes('png'), title)
            engines.add(parsed['parser'])
            confidence = min(confidence, parsed['meta'].get('ocr_confidence', 1))
            for item in parsed['blocks']:
                item.update(page=page.number + 1, bbox=[coordinate / 2 for coordinate in item['bbox']], order=len(blocks))
                blocks.append(Block(**item))
        parsed = blocks_document(title, blocks, 'ocr-pdf', {'pages': len(document), 'bbox_unit': 'pdf-points', 'engines':sorted(engines), 'ocr_confidence':confidence})
        parsed['quality'] = min(parsed['quality'],confidence)
        return parsed


def transcribe(data: bytes, filename: str, title: str) -> dict:
    from faster_whisper import WhisperModel
    from sidecar.main import Block, blocks_document
    model = WhisperModel(os.environ.get('KNOWWEAVE_ASR_MODEL', 'base'), device='cpu', compute_type='int8')
    with tempfile.TemporaryDirectory(prefix='knowweave-asr-') as directory:
        path = Path(directory) / ('audio' + Path(filename).suffix)
        path.write_bytes(data)
        segments, info = model.transcribe(str(path))
        rows = [{'start': segment.start, 'end': segment.end, 'text': segment.text.strip()} for segment in segments]
    blocks = [Block(type='transcript', text=f"[{row['start']:.3f}s–{row['end']:.3f}s] {row['text']}", order=i) for i, row in enumerate(rows) if row['text']]
    return blocks_document(title, blocks, 'faster-whisper', {'language': info.language, 'segments': rows})
