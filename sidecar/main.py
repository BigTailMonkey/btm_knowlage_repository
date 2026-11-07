"""无状态解析边车：只做「格式进、结构出」。

主服务是 Node.js；Python 仅承担 PDF/DOCX 的版面解析，不参与问答、检索或
权限判定。所有解析结果都是纯数据，失败不影响主路径。
"""
from __future__ import annotations

import base64
import io
import re
import os
import importlib.util
import shutil
import sys
from pathlib import Path
from dataclasses import asdict, dataclass, field

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

CJK_SPACE = re.compile(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])")


@dataclass
class Block:
    type: str
    text: str
    headingPath: list[str] = field(default_factory=list)
    page: int | None = None
    bbox: list[float] | None = None
    order: int = 0


def quality(text: str) -> float:
    if not text.strip():
        return 0.0
    printable = sum(1 for ch in text if not ch.isspace())
    coverage = printable / max(1, len(text))
    size = min(1.0, len(text) / 600)
    corrupted = (text.count('\ufffd') + sum(ord(ch) < 32 and not ch.isspace() for ch in text)) / max(1, len(text))
    return round(max(0, (0.5 * coverage + 0.5 * size) * (1 - min(1, corrupted * 10))), 3)


def blocks_document(title: str, blocks: list[Block], parser: str, meta: dict) -> dict:
    body = "\n".join(block.text for block in blocks)
    return {
        "title": title,
        "blocks": [asdict(block) for block in blocks],
        "parser": parser,
        "quality": quality(body),
        "meta": meta,
    }


def parse_pdf(data: bytes, title: str) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    blocks: list[Block] = []
    order = 0
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
        if not paragraphs:
            paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
        for paragraph in paragraphs:
            line = CJK_SPACE.sub("", paragraph.replace("\n", " ").strip())
            is_heading = len(line) <= 32 and not re.search(r"[。！？.,;；:：]$", line)
            blocks.append(
                Block(
                    type="heading" if is_heading and len(line) < 28 else "paragraph",
                    text=line,
                    page=page_number,
                    order=order,
                )
            )
            order += 1
    return blocks_document(title, blocks, "pypdf", {"pages": len(reader.pages)})


def parse_docx(data: bytes, title: str) -> dict:
    from docx import Document as DocxDocument
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = DocxDocument(io.BytesIO(data))
    blocks: list[Block] = []
    heading_path: list[tuple[int, str]] = []
    order = 0
    # Iterate the body once so tables retain their source position and heading.
    # Appending document.tables after every paragraph loses both.
    for element in document.element.body.iterchildren():
        if element.tag.endswith("}tbl"):
            table = Table(element, document)
            rows = [" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows]
            blocks.append(
                Block(
                    type="table",
                    text="\n".join(rows),
                    headingPath=[name for _, name in heading_path],
                    order=order,
                )
            )
            order += 1
            continue
        if not element.tag.endswith("}p"):
            continue
        paragraph = Paragraph(element, document)
        text = paragraph.text.strip()
        if not text:
            continue
        style = (paragraph.style.name if paragraph.style else "") or ""
        if style.lower().startswith("heading"):
            digits = re.findall(r"\d+", style)
            level = int(digits[0]) if digits else 1
            while heading_path and heading_path[-1][0] >= level:
                heading_path.pop()
            heading_path.append((level, text))
            continue
        blocks.append(
            Block(
                type="paragraph",
                text=text,
                headingPath=[name for _, name in heading_path],
                order=order,
            )
        )
        order += 1
    return blocks_document(title, blocks, "python-docx", {})


app = FastAPI(title="KnoWeave parsing sidecar", version="0.1.0")
from sidecar.models import router as model_router
app.include_router(model_router)


class ParseIn(BaseModel):
    filename: str
    data: str
    title: str | None = None
    engine: str = 'auto'


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "knowweave-parser"}


def route_parse(payload: ParseIn, engines: list[str] | None = None) -> dict:
    from sidecar import advanced
    filename = Path(payload.filename).name
    suffix = Path(filename).suffix.lower()
    title = payload.title or Path(filename).stem
    try:
        raw = base64.b64decode(payload.data, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="data 不是合法 base64") from exc
    if not raw or len(raw) > 30 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件为空或超过30MB")
    image = suffix in {'.png', '.jpg', '.jpeg', '.tiff', '.tif', '.webp', '.bmp'}
    audio = suffix in {'.wav', '.mp3', '.m4a', '.mp4', '.webm', '.ogg', '.flac'}
    routes = engines or ([payload.engine] if payload.engine != 'auto' else
        ['asr'] if audio else ['docling', 'ocr'] if image else
        ['docling', 'pypdf', 'mineru', 'ocr'] if suffix == '.pdf' else ['docling', 'docx'] if suffix == '.docx' else [])
    if not routes:
        raise HTTPException(status_code=415, detail=f"边车不支持 {suffix}")
    diagnostics = []
    best = None
    threshold = float(os.environ.get('KNOWWEAVE_PARSE_MIN_QUALITY', '0.25'))
    for engine in routes:
        try:
            if engine == 'docling':
                parsed = advanced.docling_parse(raw, filename, title)
            elif engine == 'mineru':
                parsed = advanced.mineru_parse(raw, filename, title)
            elif engine == 'pypdf' and suffix == '.pdf':
                parsed = parse_pdf(raw, title)
            elif engine == 'docx' and suffix == '.docx':
                parsed = parse_docx(raw, title)
            elif engine == 'ocr':
                parsed = advanced.pdf_ocr(raw, title) if suffix == '.pdf' else advanced.image_ocr(raw, title)
            elif engine == 'asr' and audio:
                parsed = advanced.transcribe(raw, filename, title)
            else:
                raise ValueError('解析引擎不适用于该文件')
            if best is None or parsed['quality'] > best['quality']:
                best = parsed
            if parsed['blocks'] and parsed['quality'] >= threshold:
                parsed['meta']['attempts'] = diagnostics + [{'engine': engine, 'status': 'accepted'}]
                return parsed
            diagnostics.append({'engine': engine, 'status': 'low_quality', 'quality': parsed['quality']})
        except Exception as exc:
            diagnostics.append({'engine': engine, 'status': 'failed', 'error': str(exc)[:180]})
    raise HTTPException(status_code=422, detail={'message': '解析质量不足或所需引擎不可用，需重试或人工修正', 'attempts': diagnostics, 'best_quality': best['quality'] if best else 0})


@app.post('/parse')
def parse(payload: ParseIn) -> dict:
    return route_parse(payload)


@app.post('/ocr')
def ocr(payload: ParseIn) -> dict:
    return route_parse(payload, ['ocr'])


@app.post('/asr')
def asr(payload: ParseIn) -> dict:
    return route_parse(payload, ['asr'])


@app.get('/capabilities')
def capabilities() -> dict:
    available = lambda module: importlib.util.find_spec(module) is not None
    return {'docling': available('docling'), 'mineru': shutil.which(os.environ.get('KNOWWEAVE_MINERU_BIN', 'mineru')) is not None,
            'ocr': sys.platform == 'darwin' and shutil.which('swift') is not None or available('rapidocr') or available('pytesseract') and available('PIL') and shutil.which('tesseract') is not None,
            'asr': available('faster_whisper'), 'pdf': available('pypdf'), 'docx': available('docx'),
            'embedding': available('FlagEmbedding'), 'reranking': available('sentence_transformers')}
