"""Versioned line edits: recovery from stale/verbatim source matching failures."""
from backend.api.error_protocol import DomainApiError


def snapshot(row: dict, start_line: int = 1, max_chars: int = 12000) -> dict:
    lines = row['content'].splitlines(keepends=True)
    if start_line < 1 or start_line > max(1, len(lines)):
        raise DomainApiError('WRITING_AGENT_EDIT_MISMATCH', '行号超出范围，请从第 1 行重新读取。')
    shown, size = [], 0
    for index in range(start_line - 1, len(lines)):
        text = lines[index]
        if shown and size + len(text) > max_chars:
            break
        shown.append({'line': index + 1, 'text': text})
        size += len(text)
    end = start_line - 1 + len(shown)
    return {'outline_id': row['id'], 'expected_version': row['version'], 'title': row['title'],
            'lines': shown, 'total_lines': len(lines), 'has_more': end < len(lines),
            'next_line': end + 1 if end < len(lines) else None}


def apply_lines(row: dict, expected_version: int, edits: list[dict]) -> str:
    if expected_version != row['version']:
        raise DomainApiError('OUTLINE_EDIT_CONFLICT', '章纲已更新，请按最新版本和行号重新编辑。', details=snapshot(row))
    lines = row['content'].splitlines(keepends=True)
    ordered = sorted(edits, key=lambda edit: edit['start_line'])
    previous_end = 0
    for edit in ordered:
        start, end = edit['start_line'], edit['end_line']
        if not 1 <= start <= end <= len(lines) or start <= previous_end:
            raise DomainApiError('WRITING_AGENT_EDIT_MISMATCH', '行号越界或修改范围重叠，请按最新行号重新编辑。', details=snapshot(row))
        previous_end = end
    result = list(lines)
    for edit in reversed(ordered):
        start, end, new = edit['start_line'], edit['end_line'], edit['new']
        # Preserve the boundary before the following, untouched line. Empty new deletes.
        if new and not new.endswith(('\n', '\r')):
            ending = '\r\n' if lines[end - 1].endswith('\r\n') else '\n' if lines[end - 1].endswith('\n') else '\r' if lines[end - 1].endswith('\r') else ''
            new += ending
        result[start - 1:end] = [new]
    content = ''.join(result)
    if content == row['content']:
        raise DomainApiError('BOOK_AGENT_NO_CHANGE', '这些行的内容已经一致，无需重复保存。请核对任务要求后继续其他工作。', details=snapshot(row))
    if not content.strip():
        raise DomainApiError('WRITING_AGENT_EDIT_MISMATCH', '不能通过局部编辑清空整章，请重新选择要修改的行。', details=snapshot(row))
    return content
