/** 浏览器在拖入期间可能隐藏 files，兼容 types 和 items 两种文件标记。 */
export function isFileDrag(data: DataTransfer | null): boolean {
  return !!data && (
    Array.from(data.types).includes("Files") ||
    Array.from(data.items).some((item) => item.kind === "file") ||
    data.files.length > 0
  );
}
