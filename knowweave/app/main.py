"""FastAPI application factory and Web UI host."""
from __future__ import annotations

import asyncio
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .api_ask import router as query_router
from .api_documents import router as documents_router
from .api_learn import router as knowledge_router
from .api_mcp import router as mcp_router
from .api_ops import router as ops_router
from .config import WEB_DIR, settings
from .embeddings import embedder
from .harness import assert_model_ready
from .learning import run_reflection
from .security import Principal, get_principal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("knowweave")


def _reflection_loop(stop: threading.Event):
    while not stop.wait(settings.reflection_interval_seconds):
        try:
            with db.SessionLocal() as session:
                summary = run_reflection(session, settings.default_tenant_id)
                logger.info("reflection finished: %s", summary)
        except Exception:  # noqa: BLE001 - background job boundary
            logger.exception("reflection failed")


def create_app() -> FastAPI:
    db.configure()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(assert_model_ready)
        db.init_db(seed=settings.seed_demo)
        stop = threading.Event()
        thread = None
        if settings.reflection_enabled:
            thread = threading.Thread(
                target=_reflection_loop, args=(stop,), name="reflection", daemon=True
            )
            thread.start()
        yield
        stop.set()
        if thread:
            thread.join(timeout=2)

    app = FastAPI(
        title="KnoWeave 知织",
        description="以事实为中心、带权限与可追溯引用的个人 AI 知识库。",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in (
        documents_router,
        query_router,
        knowledge_router,
        ops_router,
        mcp_router,
    ):
        app.include_router(router, prefix="/api/v1")

    @app.get("/api/v1/health")
    def health():
        return {
            "status": "ok",
            "service": "knowweave",
            "version": "0.1.0",
            "tenant": settings.default_tenant_id,
        }

    @app.get("/api/v1/auth/me")
    def me(principal: Principal = Depends(get_principal)):
        return {
            "user_id": principal.user_id,
            "tenant_id": principal.tenant_id,
            "name": principal.name,
            "role": principal.role,
            "groups": list(principal.groups),
            "principals": sorted(principal.principals),
        }

    @app.get("/api/v1/meta")
    def meta():
        return {
            "product": "KnoWeave 知织",
            "modes": [
                {"id": "quick", "name": "快速", "description": "单轮混合召回，适合定义与参数"},
                {"id": "deep", "name": "深度", "description": "问题拆解与多轮检索，适合跨文档"},
                {"id": "graph", "name": "图谱", "description": "实体链接 + 事实一跳"},
                {"id": "timeline", "name": "时间线", "description": "按事实有效期回答"},
                {"id": "compare", "name": "对比", "description": "多实体并行召回"},
            ],
            "rerank_threshold": settings.rerank_threshold,
            "model": settings.model,
            "embedding_model": embedder.model,
            "embedding_dim": embedder.dim,
            "source_types": ["text", "md", "markdown", "pdf", "docx", "html", "web", "csv", "json", "yaml"],
        }

    if WEB_DIR.exists():
        app.mount("/assets", StaticFiles(directory=str(WEB_DIR)), name="assets")

        @app.get("/")
        def index():
            return FileResponse(WEB_DIR / "index.html")

    return app


app = create_app()
