/** 在普通浏览器和桌面 WebView 中复制文字；Clipboard API 不可用时使用当前页面的复制命令。 */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // WebView 的权限或焦点限制可能阻止异步 Clipboard API。
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;";
  document.body.appendChild(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.filter((range) => range.commonAncestorContainer.isConnected).forEach((range) => selection.addRange(range));
    }
  }
}
