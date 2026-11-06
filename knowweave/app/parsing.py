"""Format-routed parsers. Every parser returns the same structured block AST."""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from bs4 import BeautifulSoup
from docx import Document as DocxDocument
from pypdf import PdfReader


@dataclass
class ParsedBlock:
    type: str
    text: str
    heading_path: list[str] = field(default_factory=list)
    page: int | None = None
    bbox: list[float] | None = None
    order: int = 0


@dataclass
class ParsedDocument:
    title: str
    blocks: list[ParsedBlock]
    parser: str
    quality: float
    meta: dict = field(default_factory=dict)


HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
CJK_SPACE = re.compile(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])")


def normalize_cjk_spaces(text: str) -> str:
    """去掉中文之间的空格，修复 PDF 换行造成的词内断字。"""
    return CJK_SPACE.sub("", text or "")


def _quality(text: str) -> float:
    if not text.strip():
        return 0.0
    printable = sum(1 for ch in text if ch.isprintable() and not ch.isspace())
    length = max(1, len(text))
    coverage = printable / length
    size = min(1.0, len(text) / 600)
    return round(0.5 * coverage + 0.5 * size, 3)


def parse_markdown(text: str, title: str) -> ParsedDocument:
    blocks: list[ParsedBlock] = []
    heading_stack: list[tuple[int, str]] = []
    buffer: list[str] = []
    order = 0
    in_code = False
    code_lines: list[str] = []

    def flush():
        nonlocal order
        body = "\n".join(buffer).strip()
        buffer.clear()
        if body:
            is_table = all(l.strip().startswith("|") for l in body.splitlines())
            blocks.append(
                ParsedBlock(
                    type="table" if is_table else "paragraph",
                    text=body,
                    heading_path=[h for _, h in heading_stack],
                    order=order,
                )
            )
            order += 1

    for raw in text.splitlines():
        line = raw.rstrip()
        if line.strip().startswith("```"):
            if in_code:
                code = "\n".join(code_lines).strip()
                if code:
                    blocks.append(
                        ParsedBlock(
                            type="code",
                            text=code,
                            heading_path=[h for _, h in heading_stack],
                            order=order,
                        )
                    )
                    order += 1
                code_lines.clear()
                in_code = False
            else:
                flush()
                in_code = True
            continue
        if in_code:
            code_lines.append(raw)
            continue
        match = HEADING.match(line)
        if match:
            flush()
            level = len(match.group(1))
            name = match.group(2).strip()
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, name))
            continue
        if not line.strip():
            flush()
            continue
        buffer.append(line)
    flush()
    if in_code and code_lines:
        blocks.append(ParsedBlock(type="code", text="\n".join(code_lines), order=order))
    # merge markdown table fragments produced above
    merged: list[ParsedBlock] = []
    for block in blocks:
        if merged and block.text.startswith("|") and merged[-1].text.startswith("|"):
            merged[-1].text += "\n" + block.text
        else:
            merged.append(block)
    for block in merged:
        if block.text.startswith("|"):
            block.type = "table"
    return ParsedDocument(title, merged, "markdown", _quality(text), {"chars": len(text)})


def parse_html(html: str, title: str, parser_name: str = "html") -> ParsedDocument:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "noscript"]):
        tag.decompose()
    blocks: list[ParsedBlock] = []
    heading_path: list[tuple[int, str]] = []
    order = 0
    root = soup.body or soup
    for element in root.find_all(
        ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "table", "blockquote"]
    ):
        name = element.name
        text = " ".join(element.get_text(" ", strip=True).split())
        if not text:
            continue
        if name.startswith("h"):
            level = int(name[1])
            while heading_path and heading_path[-1][0] >= level:
                heading_path.pop()
            heading_path.append((level, text))
            continue
        block_type = "paragraph"
        if name == "pre":
            block_type = "code"
        elif name == "table":
            block_type = "table"
            text = "\n".join(
                " | ".join(cell.get_text(" ", strip=True) for cell in row.find_all(["th", "td"]))
                for row in element.find_all("tr")
            )
        elif name == "li":
            block_type = "list"
        blocks.append(
            ParsedBlock(
                type=block_type,
                text=text,
                heading_path=[h for _, h in heading_path],
                order=order,
            )
        )
        order += 1
    page_title = soup.title.get_text(strip=True) if soup.title else title
    body_text = "\n".join(block.text for block in blocks)
    return ParsedDocument(page_title or title, blocks, parser_name, _quality(body_text), {})


def parse_pdf(data: bytes, title: str) -> ParsedDocument:
    reader = PdfReader(io.BytesIO(data))
    blocks: list[ParsedBlock] = []
    order = 0
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not paragraphs:
            paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
        for paragraph in paragraphs:
            line = normalize_cjk_spaces(paragraph.replace("\n", " ").strip())
            is_heading = len(line) <= 32 and not re.search(r"[。！？.,;；:：]$", line)
            blocks.append(
                ParsedBlock(
                    type="heading" if is_heading and len(line) < 28 else "paragraph",
                    text=line,
                    page=page_number,
                    order=order,
                )
            )
            order += 1
    body = "\n".join(block.text for block in blocks)
    return ParsedDocument(title, blocks, "pypdf", _quality(body), {"pages": len(reader.pages)})


def parse_docx(data: bytes, title: str) -> ParsedDocument:
    document = DocxDocument(io.BytesIO(data))
    blocks: list[ParsedBlock] = []
    heading_path: list[tuple[int, str]] = []
    order = 0
    for paragraph in document.paragraphs:
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
            ParsedBlock(
                type="paragraph",
                text=text,
                heading_path=[h for _, h in heading_path],
                order=order,
            )
        )
        order += 1
    for table in document.tables:
        rows = [" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows]
        blocks.append(
            ParsedBlock(
                type="table",
                text="\n".join(rows),
                heading_path=[h for _, h in heading_path],
                order=order,
            )
        )
        order += 1
    body = "\n".join(block.text for block in blocks)
    return ParsedDocument(title, blocks, "python-docx", _quality(body), {})


def parse_text(text: str, title: str) -> ParsedDocument:
    blocks: list[ParsedBlock] = []
    order = 0
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        blocks.append(ParsedBlock(type="paragraph", text=paragraph, order=order))
        order += 1
    return ParsedDocument(title, blocks, "plain-text", _quality(text), {"chars": len(text)})


def parse_bytes(filename: str, data: bytes, title: str | None = None) -> ParsedDocument:
    suffix = Path(filename).suffix.lower()
    base_title = title or Path(filename).stem or "未命名文档"
    if suffix in {".md", ".markdown"}:
        return parse_markdown(data.decode("utf-8", "ignore"), base_title)
    if suffix in {".html", ".htm"}:
        return parse_html(data.decode("utf-8", "ignore"), base_title)
    if suffix == ".pdf":
        return parse_pdf(data, base_title)
    if suffix in {".docx", ".doc"}:
        if suffix == ".doc":
            raise ValueError("暂不支持 .doc，请转换为 .docx 或 PDF")
        return parse_docx(data, base_title)
    if suffix in {".txt", ".log", ".csv", ".json", ".yaml", ".yml"}:
        return parse_markdown(data.decode("utf-8", "ignore"), base_title)
    return parse_text(data.decode("utf-8", "ignore"), base_title)


def parse_text_content(text: str, title: str | None = None) -> ParsedDocument:
    if HEADING.search(text or ""):
        return parse_markdown(text, title or "粘贴的文本")
    return parse_text(text, title or "粘贴的文本")
