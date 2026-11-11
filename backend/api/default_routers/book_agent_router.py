"""全自动智能体：启动、查看进度、留言、停止、继续（可换模型）、撤销改动。任务在服务端后台运行，界面按序号轮询过程记录。"""

from typing import Literal

from fastapi import APIRouter, Query
from pydantic import Field

from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.api.error_protocol import DomainApiError
from backend.services.novel import agent_library
from backend.services.novel import book_agent_jobs as jobs
from backend.services.novel.book_agent import MessageInput, ResumeInput, StartInput

router = APIRouter(tags=["book-agent"])
BASE = "/api/novels/{novel_id}/book-agent"


@router.get(BASE + "/workflows")
async def workflows(novel_id: ObjectIdString):
    from backend.services.novel.book_agent_workflows import catalog
    return {"workflows": catalog()}


@router.get("/api/book-agent/active")
async def active():
    """有智能体任务正在运行的书，供顶栏书签页显示运行状态。"""
    return {"novel_ids": jobs.active_novels()}


@router.get(BASE + "/jobs")
async def list_jobs(novel_id: ObjectIdString):
    try:
        return {"jobs": await jobs.list_jobs(novel_id)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/jobs")
async def start(novel_id: ObjectIdString, req: StartInput):
    try:
        return await jobs.start(novel_id, req)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get(BASE + "/jobs/{job_id}")
async def view(novel_id: ObjectIdString, job_id: ObjectIdString, after: int = Query(default=0, ge=0),
               changes_seen: str = Query(default="", max_length=80)):
    try:
        return await jobs.view(novel_id, job_id, after, changes_seen)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/jobs/{job_id}/messages")
async def message(novel_id: ObjectIdString, job_id: ObjectIdString, req: MessageInput):
    try:
        return await jobs.post_message(novel_id, job_id, req.text, req.question_id)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


class ConcurrencyInput(StrictRequestModel):
    parallel_agents: int = Field(ge=1, le=16)


@router.post(BASE + "/jobs/{job_id}/concurrency")
async def set_concurrency(novel_id: ObjectIdString, job_id: ObjectIdString, req: ConcurrencyInput):
    try:
        return await jobs.set_concurrency(novel_id, job_id, req.parallel_agents)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/jobs/{job_id}/stop")
async def stop(novel_id: ObjectIdString, job_id: ObjectIdString):
    try:
        return await jobs.stop(novel_id, job_id)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/jobs/{job_id}/resume")
async def resume(novel_id: ObjectIdString, job_id: ObjectIdString, req: ResumeInput | None = None):
    """继续任务：可附一句新要求；settings 里传了的字段（模型、思考强度、审查方式）替换原设置，没传的沿用。"""
    try:
        settings = req.settings.model_dump(exclude_unset=True) if req and req.settings else None
        return await jobs.resume(novel_id, job_id, req.text if req else "", settings)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/jobs/{job_id}/changes/{change_id}/undo")
async def undo(novel_id: ObjectIdString, job_id: ObjectIdString, change_id: ObjectIdString):
    try:
        return await jobs.undo(novel_id, job_id, change_id)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/jobs/{job_id}/undo")
async def undo_all(novel_id: ObjectIdString, job_id: ObjectIdString):
    try:
        return await jobs.undo_all(novel_id, job_id)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


class LibraryDecision(StrictRequestModel):
    decision: Literal["approve", "reject", "disable", "resolve"]


@router.get(BASE + "/library")
async def library_entries(novel_id: ObjectIdString, status: Literal["pending", "approved", "rejected", "disabled", "monitoring", "flagged", "resolved"] | None = None):
    """工具库：异常提醒、智能体推荐的自造工具和经验，以及作者批准、停用的状态。"""
    try:
        return {"entries": await agent_library.list_entries(novel_id, status)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/library/{entry_id}/diagnose")
async def library_diagnose(novel_id: ObjectIdString, entry_id: ObjectIdString):
    """标红的工具：让诊断智能体查原因并直接处理（自造工具修好后替换，内置工具用法错就收进用法经验）。"""
    from backend.services.novel import agent_doctor
    try:
        return await agent_doctor.diagnose_manual(novel_id, entry_id)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post(BASE + "/library/{entry_id}")
async def library_decide(novel_id: ObjectIdString, entry_id: ObjectIdString, req: LibraryDecision):
    try:
        entry = next((row for row in await agent_library.list_entries(novel_id) if row["id"] == entry_id), None)
        if entry is None:
            raise DomainApiError("AGENT_LIBRARY_NOT_FOUND", "这条工具库记录不存在或不属于本书", status_code=404)
        return await agent_library.decide(entry_id, req.decision)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
