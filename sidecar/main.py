"""无状态解析边车：只做「格式进、结构出」。

主服务是 Node.js；Python 仅承担 PDF/DOCX 的版面解析，不参与问答、检索或
权限判定。所有解析结果都是纯数据，失败不影响主路径。
"""
from __future__ import annotations

import base64
import io
import re
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
    return round(0.5 * coverage + 0.5 * size, 3)


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


class ParseIn(BaseModel):
    filename: str
    data: str
    title: str | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "knowweave-parser"}


@app.post("/parse")
def parse(payload: ParseIn) -> dict:
    suffix = ("." + payload.filename.rsplit(".", 1)[1].lower()) if "." in payload.filename else ""
    title = payload.title or (payload.filename.rsplit(".", 1)[0] if "." in payload.filename else payload.filename)
    try:
        raw = base64.b64decode(payload.data)
    except Exception as exc:  # noqa: BLE001 - 输入边界
        raise HTTPException(status_code=400, detail="data 不是合法 base64") from exc
    try:
        if suffix == ".pdf":
            return parse_pdf(raw, title)
        if suffix == ".docx":
            return parse_docx(raw, title)
        raise HTTPException(status_code=415, detail=f"边车不支持 {suffix or '未知格式'}")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - 解析边界
        raise HTTPException(status_code=422, detail=f"解析失败：{exc}") from exc
